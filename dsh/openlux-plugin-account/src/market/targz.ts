/**
 * A deliberately narrow tar.gz reader for market artifacts.
 *
 * Why hand-written rather than a dependency: the kernel offers no unpacking of
 * any kind, and Node's only built-in half is `zlib`, so something has to read
 * the tar. Every general-purpose library takes the archive's word on where its
 * members land; the only thing this reader is permitted to produce is a
 * relative path under one directory. A tar header is a fixed 512-byte record,
 * which makes a strict reader short — and writing it ourselves is what makes
 * the refusals explicit rather than dependent on someone else's defaults:
 * absolute paths, `..`, links of either kind, device nodes, oversized members,
 * and too many of them. `adm-zip`, what the previous shell unpacked with, has
 * had path-traversal advisories for exactly the class of check made here.
 *
 * This reader decides nothing about presets. It hands back accepted members;
 * `install.ts` decides whether they form a preset and where they go.
 */

import { gunzipSync } from 'node:zlib'

/** One tar header record, and the unit every offset advances by. */
const BLOCK = 512

/** Caps a well-formed preset archive stays comfortably under. */
export interface ArchiveLimits {
  /** Members, counting directories. */
  readonly maxEntries: number
  /** Bytes in any single member. */
  readonly maxEntryBytes: number
  /** Bytes across all members, unpacked. */
  readonly maxTotalBytes: number
}

/**
 * Defaults sized against what we actually ship: a materialized WorkBuddy team
 * is tens of text files and well under a megabyte, so these leave two orders
 * of magnitude of headroom and still refuse anything resembling a payload.
 */
export const ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 512,
  maxEntryBytes: 4 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
}

/**
 * A refused or malformed archive.
 *
 * The message is user-facing Chinese, because every one of these outcomes is
 * something the operator who uploaded the artifact has to fix, and the person
 * who sees it first is the user who pressed install.
 */
export class ArchiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveError'
  }
}

/** One accepted archive member, with a path safe to join onto a directory. */
export interface ArchiveEntry {
  /** Relative POSIX path, no `.` or `..` segment, no leading separator. */
  readonly path: string
  readonly kind: 'file' | 'directory'
  /** Member contents; empty for a directory. */
  readonly body: Uint8Array
}

/**
 * Read every member of a gzipped tar, refusing anything outside the whitelist.
 * @param archive - the compressed archive bytes.
 * @param limits - caps to enforce.
 * @returns the accepted members, in archive order.
 * @throws {ArchiveError} when the archive is malformed or asks for something
 * the whitelist does not allow.
 */
export function readTarGz(archive: Uint8Array, limits: ArchiveLimits = ARCHIVE_LIMITS): ArchiveEntry[] {
  let tar: Buffer
  try {
    tar = gunzipSync(archive)
  } catch (error: unknown) {
    throw new ArchiveError(`制品不是有效的 gzip 数据：${error instanceof Error ? error.message : String(error)}`)
  }

  const entries: ArchiveEntry[] = []
  let total = 0
  // Set by a pax or GNU pseudo header, and consumed by the member after it.
  let override: string | undefined

  for (let offset = 0; offset + BLOCK <= tar.length;) {
    const header = tar.subarray(offset, offset + BLOCK)
    offset += BLOCK
    // Two zero blocks close an archive; one is enough to stop reading, and
    // stopping is also the right answer for the zero padding some writers add.
    if (header.every(byte => byte === 0)) break
    verifyChecksum(header)

    const size = octal(header, 124, 12)
    if (size > limits.maxEntryBytes) {
      throw new ArchiveError(`制品里有超过 ${limits.maxEntryBytes} 字节的条目`)
    }
    const body = tar.subarray(offset, offset + size)
    if (body.length < size) throw new ArchiveError('制品在某个条目中间就结束了（文件不完整）')
    offset += Math.ceil(size / BLOCK) * BLOCK

    // A NUL type flag means the oldest tar dialect's regular file.
    const flag = String.fromCharCode(header.at(156) === 0 ? 0x30 : header.at(156) ?? 0x30)
    if (flag === 'x' || flag === 'g') {
      // Extended headers carry the real path when it does not fit the fixed
      // fields. A global one ('g') applies to the whole archive and never
      // names a member, so its records are read but its path is ignored.
      const path = paxPath(body)
      if (flag === 'x' && path !== undefined) override = path
      continue
    }
    if (flag === 'L') {
      override = decode(body)
      continue
    }

    const raw = override ?? name(header)
    override = undefined
    if (flag === '1' || flag === '2') {
      throw new ArchiveError(`制品里有链接条目（${safeText(raw)}），出于安全不予解包`)
    }
    if (flag !== '0' && flag !== '5' && flag !== '7') {
      throw new ArchiveError(`制品里有不支持的条目类型 ${JSON.stringify(flag)}（${safeText(raw)}）`)
    }

    // `tar -czf archive -C dir .` names the archive root as a member of its
    // own. It carries no content and no location, so it is skipped rather than
    // refused — refusing it would reject the most ordinary way to pack a
    // directory, and accepting it as a path would mean writing `.`.
    if (isArchiveRoot(raw)) continue

    // A trailing slash is how tar marks a directory in the oldest dialect,
    // where the type flag says "regular file" for both.
    const kind = flag === '5' || raw.endsWith('/') ? 'directory' : 'file'
    const path = safePath(raw)
    if (entries.length >= limits.maxEntries) {
      throw new ArchiveError(`制品的条目数超过 ${limits.maxEntries}`)
    }
    total += body.length
    if (total > limits.maxTotalBytes) {
      throw new ArchiveError(`制品解包后超过 ${limits.maxTotalBytes} 字节`)
    }
    entries.push({ path, kind, body: kind === 'directory' ? new Uint8Array() : body })
  }
  if (entries.length === 0) throw new ArchiveError('制品里没有任何条目')
  return entries
}

/**
 * Verify a header's own checksum.
 *
 * Cheap, and it is what separates "this is a corrupt or truncated download"
 * from "this is a tar dialect we refuse": without it, garbage bytes would be
 * reported as an unsupported entry type and send the operator looking in the
 * wrong place.
 */
function verifyChecksum(header: Uint8Array): void {
  const declared = octal(header, 148, 8)
  let sum = 0
  for (let index = 0; index < BLOCK; index += 1) {
    // The checksum field itself counts as spaces, by definition.
    sum += index >= 148 && index < 156 ? 0x20 : header.at(index) ?? 0
  }
  if (sum !== declared) {
    throw new ArchiveError('制品的 tar 头校验和不符（下载损坏，或者这不是 tar 归档）')
  }
}

/**
 * Read one octal numeric field.
 *
 * GNU's base-256 extension (high bit set) is refused rather than parsed: it
 * only appears for values that do not fit in the field, and every such value
 * is already past the caps this reader enforces.
 */
function octal(header: Uint8Array, at: number, length: number): number {
  const first = header.at(at) ?? 0
  if ((first & 0x80) !== 0) throw new ArchiveError('制品用了 tar 的大数字段扩展，超出允许范围')
  const text = decode(header.subarray(at, at + length)).replace(/\0.*$/, '').trim()
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) throw new ArchiveError('制品的 tar 头有无法解析的数字字段')
  return Number.parseInt(text, 8)
}

/** Assemble a member name from the ustar `prefix` and `name` fields. */
function name(header: Uint8Array): string {
  const base = decode(header.subarray(0, 100)).replace(/\0.*$/, '')
  const prefix = decode(header.subarray(345, 500)).replace(/\0.*$/, '')
  return prefix === '' ? base : `${prefix}/${base}`
}

/** Read the `path` record of a pax extended header, if it carries one. */
function paxPath(body: Uint8Array): string | undefined {
  // Records are `<decimal length> <key>=<value>\n`, and the length counts
  // itself, so the keyword is found by splitting on the first space.
  for (const record of decode(body).split('\n')) {
    const [, keyword, value] = /^\d+ ([^=]+)=(.*)$/.exec(record) ?? []
    if (keyword === 'path' && value !== undefined) return value
  }
  return undefined
}

/** Whether a member name refers to the archive's own root directory. */
function isArchiveRoot(raw: string): boolean {
  return ['', '.', './', '/'].includes(raw)
}

/**
 * Reduce an archive-supplied name to a path we are willing to write.
 *
 * Everything refused here is refused loudly. A reader that silently rewrote a
 * hostile path into a harmless one would leave the artifact that produced it
 * in the catalog, to be tried again on the next client.
 */
function safePath(raw: string): string {
  const trimmed = raw.replace(/\/+$/, '')
  // `tar -czf` from a directory writes members as `./name`; that is the one
  // prefix worth accepting, because it means nothing about location.
  const relative = trimmed.startsWith('./') ? trimmed.slice(2) : trimmed
  if (relative === '') throw new ArchiveError('制品里有一个空路径条目')
  if (relative.length > 255) throw new ArchiveError(`制品里的路径过长：${safeText(relative)}`)
  if (relative.includes('\\')) {
    throw new ArchiveError(`制品里的路径带反斜杠：${safeText(relative)}`)
  }
  if (relative.startsWith('/') || /^[a-zA-Z]:/.test(relative)) {
    throw new ArchiveError(`制品里有绝对路径：${safeText(relative)}`)
  }
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new ArchiveError(`制品里的路径不可用：${safeText(relative)}`)
    }
    // Control characters and the characters Windows reserves; a member that
    // cannot be written on one platform must not install differently there.
    if (/[\u0000-\u001f<>:"|?*]/.test(segment)) {
      throw new ArchiveError(`制品里的路径含非法字符：${safeText(relative)}`)
    }
  }
  return relative
}

/** Decode header or record bytes, which tar defines as UTF-8 in practice. */
function decode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8')
}

/** Quote an archive-supplied string before it reaches a message. */
function safeText(raw: string): string {
  return JSON.stringify(raw.slice(0, 120))
}
