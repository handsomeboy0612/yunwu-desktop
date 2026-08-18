/**
 * The two console reads an install needs beyond the catalog snapshot.
 *
 * Both exist because the snapshot deliberately withholds something:
 *
 * - **The download link.** Pre-signed URLs expire; the snapshot is cached under
 *   an ETag and may be days old. The console therefore signs a link at the
 *   moment of installing, and counts the download there — so a count reflects
 *   installs rather than page views (`GetClientDesktopMarketDownloadURL`).
 * - **The manifest.** It is a longtext column and the snapshot omits it to stay
 *   around 80 KB for several hundred rows, so an expert's bundled-skill list is
 *   read per item, only when installing one (`GetClientDesktopMarketItem`).
 *
 * Both are read HOST-side even though the gallery could have asked. Two reasons
 * agree: the routes authenticate with the `sk-` token this plugin holds and
 * answer without CORS headers, and a main process that fetches a URL a renderer
 * handed it is the standard SSRF sink in an Electron app. The gallery names an
 * item; where that turns into a connection is decided here.
 */

import type { Context } from '@deepseek-ai/cordis'
import { asEnvelope, normalizeBase, requestJson } from '../account/http.ts'
import type { CatalogType } from './wire.ts'

/** How the console is reached; the same pair the catalog reader takes. */
export interface ConsoleAccess {
  readonly baseUrl: string
  readonly apiKey: () => Promise<string | undefined>
}

/** Budget for one console read; a transfer gets its own, much longer, budget. */
const CONSOLE_TIMEOUT_MS = 15_000

/** A signed link plus the facts the transfer is checked against. */
export interface SignedArtifact {
  readonly url: string
  readonly sha256: string
  readonly size: number
}

/** Raised when the console declines to answer; the caller turns it into a refusal. */
export class ConsoleError extends Error {}

/**
 * Ask the console to sign a download link for one item's archive.
 *
 * The digest comes back from this same call, and it — not the snapshot's — is
 * what the transfer is verified against: this response is the console's answer
 * *now*, while a cached row can be older than the artifact it describes.
 * @param ctx - host context, for the request.
 * @param access - console origin and token reader.
 * @param type - catalog partition the item lives in.
 * @param slug - the item.
 * @param format - archive format wanted.
 * @param signal - caller cancellation.
 * @returns the signed link and the facts to check the bytes against.
 * @throws ConsoleError when the console has no such artifact, or refuses.
 */
export async function signArtifact(
  ctx: Context,
  access: ConsoleAccess,
  type: CatalogType,
  slug: string,
  format: string,
  signal?: AbortSignal,
): Promise<SignedArtifact> {
  const body = await read<{ url?: unknown; sha256?: unknown; size?: unknown }>(
    ctx,
    access,
    `items/${encodeURIComponent(type)}/${encodeURIComponent(slug)}/download-url`
      + `?format=${encodeURIComponent(format)}`,
    'POST',
    signal,
  )
  const url = typeof body.url === 'string' ? body.url.trim() : ''
  const sha256 = typeof body.sha256 === 'string' ? body.sha256.trim().toLowerCase() : ''
  if (url === '' || sha256 === '') {
    throw new ConsoleError(`控制台没有给出 ${slug} 的下载地址或摘要。`)
  }
  const size = typeof body.size === 'number' && body.size > 0 ? Math.floor(body.size) : 0
  return { url, sha256, size }
}

/** The two things an expert's manifest is read for. */
export interface ExpertManifest {
  /**
   * Skill slugs this expert declares it bundles.
   *
   * Each is its own catalog item — that is what lets one skill's bytes serve
   * every expert that bundles it, instead of a copy per expert.
   */
  readonly bundledSkills: readonly string[]
  /**
   * Opening questions, best first.
   *
   * `defaultInitPrompt` leads when the upstream listing has one (all 406 do),
   * then the quick prompts. That order is WorkBuddy's own: its summon path asks
   * the backend for `defaultInitPrompt` and falls back to `quickPrompts[0]`
   * (`project-expert-mapping.ts`: 「解析专家召唤时预填输入框的默认提示词」).
   * The first entry is what a summon prefills; the rest are the detail page's
   * suggestion chips.
   */
  readonly prompts: readonly string[]
}

/** How many suggestions are carried; the upstream listing publishes at most four. */
const MAX_PROMPTS = 5

/** Nothing readable — an expert with no manifest is still installable. */
const NO_MANIFEST: ExpertManifest = { bundledSkills: [], prompts: [] }

/**
 * Read one expert's manifest.
 *
 * An unreadable manifest yields empty lists rather than a failure: the expert
 * itself installs from its archive, and both of these are additions to it.
 * @param ctx - host context.
 * @param access - console origin and token reader.
 * @param slug - the expert.
 * @param signal - caller cancellation.
 * @returns the bundled skills and the opening questions.
 */
export async function readExpertManifest(
  ctx: Context,
  access: ConsoleAccess,
  slug: string,
  signal?: AbortSignal,
): Promise<ExpertManifest> {
  let manifest: { bundledSkills?: unknown; defaultInitPrompt?: unknown; quickPrompts?: unknown } | null
  try {
    const item = await read<{ manifest?: unknown }>(
      ctx, access, `items/expert/${encodeURIComponent(slug)}`, 'GET', signal,
    )
    manifest = (typeof item.manifest === 'string' ? JSON.parse(item.manifest) : item.manifest) as typeof manifest
  } catch {
    return NO_MANIFEST
  }
  return {
    // Deduplicated because the list is the console's, and a repeat would mean
    // downloading and unpacking the same archive twice into the same directory.
    bundledSkills: texts(manifest?.bundledSkills, Number.MAX_SAFE_INTEGER),
    prompts: texts([manifest?.defaultInitPrompt, manifest?.quickPrompts], MAX_PROMPTS),
  }
}

/**
 * Flatten console-supplied text into a deduplicated list of non-empty strings.
 * @param raw - a string, or a nested array of them (anything else is dropped).
 * @param limit - how many to keep.
 * @returns the values, in the order they appeared.
 */
function texts(raw: unknown, limit: number): readonly string[] {
  const out: string[] = []
  const walk = (value: unknown): void => {
    if (out.length >= limit) return
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry)
      return
    }
    const text = typeof value === 'string' ? value.trim() : ''
    if (text !== '' && !out.includes(text)) out.push(text)
  }
  walk(raw)
  return out
}

/**
 * One authenticated console read, unwrapped from the envelope.
 * @throws ConsoleError for a missing token, a non-2xx, or a refusal in the body.
 */
async function read<T>(
  ctx: Context,
  access: ConsoleAccess,
  path: string,
  method: 'GET' | 'POST',
  signal?: AbortSignal,
): Promise<T> {
  const token = await access.apiKey()
  if (token === undefined) throw new ConsoleError('当前没有登录凭据，无法向控制台取制品。')
  const url = `${normalizeBase(access.baseUrl)}/api/desktop-market/${path}`
  const reply = await requestJson(
    ctx,
    url,
    { method, headers: { Authorization: `Bearer ${token}` } },
    CONSOLE_TIMEOUT_MS,
    signal,
  )
  const envelope = asEnvelope<T>(reply.body)
  if (!reply.response.ok || envelope.success === false) {
    throw new ConsoleError(envelope.message === undefined || envelope.message === ''
      ? `控制台返回 HTTP ${reply.response.status}。`
      : envelope.message)
  }
  if (envelope.data === undefined || envelope.data === null) {
    throw new ConsoleError('控制台返回了空响应体。')
  }
  return envelope.data
}
