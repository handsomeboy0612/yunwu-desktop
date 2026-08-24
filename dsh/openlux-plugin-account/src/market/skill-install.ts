/**
 * Standalone skills: the catalog's `skill` partition into the kernel's own user
 * skill root.
 *
 * ## Why this root
 *
 * `dsh-skill-filesystem` scans five roots in rank order, and rank 400 is
 * `<dshHome>/skills` — the user's own (its README's Discovery table). It is
 * watched (`watch: true` by default), so a directory appearing there becomes a
 * live skill without a restart and without a page reload. Verified on this
 * machine 2026-08-24: writing `$DSH_HOME/skills/openlux-probe/SKILL.md` made
 * `/openlux-probe` appear in the running app's slash menu, description and all,
 * with nothing restarted.
 *
 * An expert's bundled skills do NOT come here — they are re-rooted under the
 * preset's own `skills/` by `install.ts`, which is the shipped `cordis` preset's
 * idiom. The difference is ownership: a bundled skill belongs to the expert and
 * disappears with it, while one installed here is the user's and outlives every
 * expert. Both end up in the same model-facing catalog, which is also what the
 * product we are aligned with does (its session lists tens of skills, of which
 * the summoned expert's are a handful).
 *
 * ## Landing without a rename
 *
 * See {@link land}: the usual stage-then-rename is unsafe against a watched
 * directory on Windows, so a skill is written in place with `SKILL.md` last.
 *
 * ## What the roster costs
 *
 * `dsh-tool-skill` renders one catalog line per skill on every request and caps
 * only the per-skill description (`catalogDescriptionMaxLength`, default 500).
 * There is no total budget that silently truncates — unlike the old shell, where
 * 135 skills blew an 18000-character cap and the kernel degraded the roster to
 * bare names. So installing many skills does not break; it costs, linearly, on
 * every turn. That is why the gallery shows the resulting count and why there is
 * no bulk install.
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { requestBytes } from '../account/http.ts'
import { ConsoleError, signArtifact, type ConsoleAccess } from './console.ts'
import { ARCHIVE_LIMITS, ArchiveError, readTarGz, type ArchiveEntry } from './targz.ts'
import {
  DOWNLOAD_TIMEOUT_MS, MAX_DOWNLOAD_BYTES, PRESET_ID, writeEntries,
} from './install.ts'
import { SKILL_DIR_FORMAT } from './wire.ts'
import type {
  InstallOutcome, InstallRequest, InstalledSkill, RefusalReason, SkillTarget,
} from './wire.ts'

/** The user skill root's name under the harness home, as the provider spells it. */
const SKILL_ROOT_DIR = 'skills'

/** The one file whose presence makes a directory a skill. */
const SKILL_FILE = 'SKILL.md'

/**
 * Where an installed skill records what it came from.
 *
 * Inside the skill directory rather than in an index of our own: a skill is
 * removed by deleting its directory (by us, by the user, by hand), and an index
 * would then describe skills that are no longer there. A sidecar cannot outlive
 * its subject. It is not `SKILL.md` for the reason the old shell learned the
 * hard way — an update replaces that file, so anything written into it is lost
 * on the next one.
 */
const SKILL_PROVENANCE_FILE = 'openlux-market.json'

/** How many directories one root is read for; a guard, not a product limit. */
const MAX_SCANNED_SKILLS = 512

/** What an installed skill came from, as recorded beside its `SKILL.md`. */
interface SkillProvenance {
  readonly itemId: string
  readonly version?: string
  readonly installedAt: string
}

/**
 * The kernel's user skill root for this deployment.
 *
 * `dshHomePath()` is the kernel's own resolver (configured path, then
 * `$DSH_HOME`, then the default) with the join built in, so this agrees with the
 * provider by construction rather than by copying its precedence. It is also the
 * one spelling that survives both builds of that package present on this
 * machine: the copy under `dsh-plugin-desktop` exports its resolver minified to
 * `n`, so importing `resolveDshHome` would resolve at type-check time and be
 * `undefined` at runtime under that resolution. `files/stage.ts` reached the
 * same conclusion first.
 * @returns the absolute skill root, which may not exist yet.
 */
export function skillRoot(): string {
  return dshHomePath(SKILL_ROOT_DIR)
}

/**
 * Read what the user skill root currently holds.
 *
 * Every directory with a `SKILL.md`, ours or not: the model sees the whole root,
 * so a list that only knew about our installs would be the wrong one to mark
 * cards against. A missing root is valid empty state — the provider treats it
 * the same way.
 *
 * This counts directories rather than asking `ctx.skills`, and that is a
 * measured decision rather than an oversight. The registry is the merged,
 * rank-resolved roster and would be the better number — but it is layered by
 * agent scope, and `ctx.skills.list()` from this plugin's own (unscoped)
 * context answered zero on a machine whose root held seven skills the model was
 * demonstrably carrying (2026-08-24). A number that reads zero when seven are
 * live is worse than a coarse one, so the coarse one ships and the scoped read
 * waits until there is a scope to read it from.
 *
 * @returns the root and the skills sitting in it, sorted by directory name.
 */
export async function readSkillTarget(): Promise<SkillTarget> {
  const root = skillRoot()
  let names: string[]
  try {
    const entries = await readdir(root, { withFileTypes: true })
    names = entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort()
      .slice(0, MAX_SCANNED_SKILLS)
  } catch {
    return { root, installed: [] }
  }
  const installed: InstalledSkill[] = []
  for (const slug of names) {
    const head = await readHead(join(root, slug, SKILL_FILE))
    if (head === undefined) continue
    const provenance = await readProvenance(join(root, slug, SKILL_PROVENANCE_FILE))
    installed.push({
      slug,
      name: frontMatterName(head) ?? slug,
      managed: provenance !== undefined,
      ...provenance?.version === undefined ? {} : { version: provenance.version },
    })
  }
  return { root, installed }
}

/**
 * Install one catalog skill into the user skill root.
 *
 * The same steps as a preset install, for the same reasons: sign now (the cached
 * catalog's digest can be older than the artifact), verify the bytes against
 * what the console just vouched for, write them where they belong, then prove
 * the result is a skill.
 * @param ctx - host context, for the transfer and the log.
 * @param access - console origin and token reader.
 * @param request - the gallery's request, whose `id` is the catalog slug.
 * @param signal - caller cancellation.
 * @returns the outcome; every refusal here is an ordinary answer.
 */
export async function installSkill(
  ctx: Context,
  access: ConsoleAccess,
  request: InstallRequest,
  signal?: AbortSignal,
): Promise<InstallOutcome> {
  if (!PRESET_ID.test(request.id)) {
    return refuse('invalid-id', `技能标识 ${JSON.stringify(request.id)} 不符合目录命名规则（小写字母、数字、连字符）。`)
  }
  if (request.format !== SKILL_DIR_FORMAT) {
    return refuse('unsupported-format', `这个客户端不认得制品格式 ${JSON.stringify(request.format)}，无法安装技能。`)
  }
  const root = skillRoot()
  const destination = join(root, request.id)
  if (await exists(join(destination, SKILL_FILE))) {
    return refuse('already-installed',
      `已经装过技能 ${request.id} 了。要重装请先删除 ${destination}。`)
  }

  let signed
  try {
    signed = await signArtifact(ctx, access, 'skill', request.id, request.format, signal)
  } catch (error: unknown) {
    if (error instanceof ConsoleError) return refuse('no-download-url', error.message)
    throw error
  }
  if (request.sha256.trim() !== '' && signed.sha256 !== request.sha256.trim().toLowerCase()) {
    return refuse('catalog-stale',
      `目录里的摘要与控制台现在给出的不一致（目录 ${request.sha256.trim().toLowerCase()}，`
      + `控制台 ${signed.sha256}），请刷新市场后重试。`)
  }

  let archive: Uint8Array
  try {
    archive = await requestBytes(ctx, signed.url, DOWNLOAD_TIMEOUT_MS, MAX_DOWNLOAD_BYTES, signal)
  } catch (error: unknown) {
    return refuse('download-failed', error instanceof Error ? error.message : String(error))
  }
  const digest = createHash('sha256').update(archive).digest('hex')
  if (digest.toLowerCase() !== signed.sha256) {
    return refuse('digest-mismatch', `制品校验失败：期望 ${signed.sha256}，实际 ${digest}。`)
  }

  let entries: readonly ArchiveEntry[]
  try {
    entries = readTarGz(archive, ARCHIVE_LIMITS)
    assertSkillShape(entries)
  } catch (error: unknown) {
    if (error instanceof ArchiveError) return refuse('bad-archive', error.message)
    throw error
  }

  const provenance: SkillProvenance = {
    itemId: request.itemId,
    ...request.version === undefined ? {} : { version: request.version },
    installedAt: new Date().toISOString(),
  }
  const written = await land(entries, destination, provenance)
  if (written !== undefined) return written

  // Prove it landed as a skill rather than assume the write did what the
  // archive promised — the preset path does the same with the roster's verdict,
  // and here the equivalent evidence is the file the provider looks for.
  if (!await exists(join(destination, SKILL_FILE))) {
    await rm(destination, { recursive: true, force: true })
    return refuse('broken-after-install', `技能 ${request.id} 装完之后没有找到 ${SKILL_FILE}，已回滚。`)
  }
  ctx.logger.info(`openlux: skill ${request.id} installed at ${destination}`)
  return { kind: 'installed', id: request.id, path: destination }
}

/**
 * Import a skill directory the user picked on their own disk.
 *
 * The product we are aligned with calls this «从本地添加技能» and treats it as
 * the same act as installing one from the shelf, which is why it lands in the
 * same root through the same shape check. Copied rather than linked: a link
 * would make the skill disappear when the user tidies their downloads folder,
 * and the roster would then be describing a skill the model cannot load.
 * @param ctx - host context, for the log.
 * @param source - an absolute directory the user chose.
 * @param signal - caller cancellation.
 * @returns the outcome; a directory without a usable `SKILL.md` is refused.
 */
export async function importLocalSkill(
  ctx: Context,
  source: string,
  signal?: AbortSignal,
): Promise<InstallOutcome> {
  const head = await readHead(join(source, SKILL_FILE))
  if (head === undefined) {
    return refuse('bad-archive', `${source} 里没有 ${SKILL_FILE}，这不是一个技能目录。`)
  }
  const declared = frontMatterName(head)
  const slug = slugOf(declared ?? baseName(source))
  if (slug === undefined) {
    return refuse('invalid-id',
      `无法从 ${JSON.stringify(declared ?? baseName(source))} 得到合法的技能标识（小写字母、数字、连字符）。`)
  }
  const root = skillRoot()
  const destination = join(root, slug)
  if (await exists(join(destination, SKILL_FILE))) {
    return refuse('already-installed', `已经装过技能 ${slug} 了。要重装请先删除 ${destination}。`)
  }

  let entries: readonly ArchiveEntry[]
  try {
    entries = await readDirectoryEntries(source, signal)
  } catch (error: unknown) {
    if (error instanceof ArchiveError) return refuse('bad-archive', error.message)
    throw error
  }

  const written = await land(entries, destination)
  if (written !== undefined) return written
  ctx.logger.info(`openlux: local skill ${slug} imported from ${source}`)
  return { kind: 'installed', id: slug, path: destination }
}

/**
 * Remove one skill from the user root.
 *
 * Only what is under the root, and only one directory level down: this takes a
 * slug rather than a path precisely so a renderer cannot name a directory to
 * delete.
 * @param slug - the directory name, from the installed list.
 * @returns whether something was removed.
 */
export async function removeSkill(slug: string): Promise<boolean> {
  if (!PRESET_ID.test(slug)) return false
  const destination = join(skillRoot(), slug)
  if (!await exists(join(destination, SKILL_FILE))) return false
  await rm(destination, { recursive: true, force: true })
  return true
}

/**
 * Write one skill into its final directory, last file first.
 *
 * Staged-then-renamed is the usual way to make a directory appear whole, and it
 * is the wrong way here. The skill root is watched by `dsh-skill-filesystem`,
 * and on Windows a rename into a directory another process has a handle open on
 * fails with `EPERM` — observed on this machine 2026-08-24, where the same
 * install succeeded twice and then failed once, which is what a race looks like.
 *
 * So there is no rename. The files go straight to the destination with
 * `SKILL.md` held back until every other one has landed, because that file is
 * exactly what makes the provider call a directory a skill: until it exists the
 * watcher sees an ordinary folder, and when it appears the skill is already
 * complete. A failure part-way leaves a directory with no `SKILL.md`, which is
 * not a skill either — and it is removed anyway.
 *
 * @param entries - accepted members, one of which is `SKILL.md`.
 * @param destination - the final directory.
 * @param provenance - our sidecar, when this install has one.
 * @returns a refusal when the write failed, else undefined.
 */
async function land(
  entries: readonly ArchiveEntry[],
  destination: string,
  provenance?: SkillProvenance,
): Promise<InstallOutcome | undefined> {
  const head = entries.filter(entry => entry.path !== SKILL_FILE)
  const skill = entries.find(entry => entry.path === SKILL_FILE)
  try {
    await writeEntries(head, destination)
    if (provenance !== undefined) {
      await writeFile(
        join(destination, SKILL_PROVENANCE_FILE),
        `${JSON.stringify(provenance, undefined, 2)}\n`,
        'utf8',
      )
    }
    if (skill !== undefined) await writeFile(join(destination, SKILL_FILE), skill.body)
  } catch (error: unknown) {
    await rm(destination, { recursive: true, force: true })
    return refuse('write-failed', error instanceof Error ? error.message : String(error))
  }
  return undefined
}

/** Refuse an archive that is not one skill directory. */
function assertSkillShape(entries: readonly ArchiveEntry[]): void {
  if (!entries.some(entry => entry.kind === 'file' && entry.path === SKILL_FILE)) {
    const wrapper = entries[0]?.path.split('/')[0]
    throw new ArchiveError(entries.every(entry => entry.path.split('/')[0] === wrapper)
      ? `制品根目录下没有 ${SKILL_FILE}：整个技能目录被多包了一层 ${JSON.stringify(wrapper ?? '')}。`
      : `制品根目录下没有 ${SKILL_FILE}，这不是一个技能目录。`)
  }
  if (entries.some(entry => entry.path === SKILL_PROVENANCE_FILE)) {
    throw new ArchiveError(`制品里自带了 ${SKILL_PROVENANCE_FILE}，不予安装。`)
  }
}

/**
 * Read one local directory into archive members.
 *
 * Same caps as a downloaded archive, because the risk being capped is the same:
 * a user pointing at their whole home directory by mistake should be refused,
 * not obeyed.
 */
async function readDirectoryEntries(
  source: string,
  signal?: AbortSignal,
  prefix = '',
  collected: ArchiveEntry[] = [],
  budget = { bytes: 0, files: 0 },
): Promise<ArchiveEntry[]> {
  const rows = await readdir(source, { withFileTypes: true })
  for (const row of rows) {
    signal?.throwIfAborted()
    // A skill is text and its helper scripts; anything hidden is tooling state
    // (`.git`, `.DS_Store`) that has no business in the roster.
    if (row.name.startsWith('.')) continue
    const path = prefix === '' ? row.name : `${prefix}/${row.name}`
    if (row.isDirectory()) {
      await readDirectoryEntries(join(source, row.name), signal, path, collected, budget)
      continue
    }
    if (!row.isFile()) continue
    budget.files += 1
    if (budget.files > ARCHIVE_LIMITS.maxEntries) {
      throw new ArchiveError(`技能目录里的文件超过 ${ARCHIVE_LIMITS.maxEntries} 个，已中止。`)
    }
    const body = await readFile(join(source, row.name))
    budget.bytes += body.byteLength
    if (budget.bytes > ARCHIVE_LIMITS.maxTotalBytes) {
      throw new ArchiveError(`技能目录总大小超过 ${Math.floor(ARCHIVE_LIMITS.maxTotalBytes / 1024 / 1024)} MB，已中止。`)
    }
    collected.push({ path, kind: 'file', body })
  }
  return collected
}

/** Read the first bytes of a file, or undefined when it is not there. */
async function readHead(path: string, bytes = 4096): Promise<string | undefined> {
  try {
    const body = await readFile(path)
    return body.subarray(0, bytes).toString('utf8')
  } catch {
    return undefined
  }
}

/** Read our sidecar, treating any fault as "not ours". */
async function readProvenance(path: string): Promise<SkillProvenance | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    const row = parsed as Partial<SkillProvenance> | null
    if (typeof row?.itemId !== 'string') return undefined
    return {
      itemId: row.itemId,
      ...typeof row.version === 'string' ? { version: row.version } : {},
      installedAt: typeof row.installedAt === 'string' ? row.installedAt : '',
    }
  } catch {
    return undefined
  }
}

/**
 * Pull `name` out of a skill's front matter.
 *
 * Deliberately shallow: this is display text for a list, and a full YAML parse
 * here would be a second answer to a question `dsh-skill` already answers for
 * the model. A block scalar (`name: >-`) yields nothing rather than the literal
 * `>-`, which the old shell shipped once and had to fix.
 */
function frontMatterName(head: string): string | undefined {
  if (!head.startsWith('---')) return undefined
  const end = head.indexOf('\n---', 3)
  const block = end === -1 ? head : head.slice(0, end)
  const line = /^name:[ \t]*(.+)$/mu.exec(block)?.[1]?.trim()
  if (line === undefined || line === '' || line.startsWith('>') || line.startsWith('|')) return undefined
  return line.replace(/^["']|["']$/gu, '')
}

/** Turn a declared name into a directory-safe slug, or undefined when it cannot be one. */
function slugOf(value: string): string | undefined {
  const slug = value.trim().toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return slug !== '' && PRESET_ID.test(slug) ? slug : undefined
}

/** Last path segment of a directory the user picked, separator-agnostic. */
function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/u, '').split(/[\\/]/u)
  return parts[parts.length - 1] ?? ''
}

/** Whether one path is readable. */
async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

/** Shape a refusal. */
function refuse(reason: RefusalReason, message: string): InstallOutcome {
  return { kind: 'refused', reason, message }
}
