/**
 * The console's say over what a model can do — the layer this shell was missing.
 *
 * Capability facts arrive in three layers, a shape this product already runs
 * (`yunwu-desktop/src/main/model-profiles.ts`, itself copied from WorkBuddy's
 * `getProductConfiguration`): a local table, a server override, then the user.
 * The first layer here is the kernel's installed pi-ai catalog
 * ({@link ./capabilities.ts}), which is a better local table than a
 * hand-written one — it is measured per model upstream. What it cannot know is
 * *our* deployment: the catalog is keyed to each vendor's own service, while
 * every id in this route reaches whichever channel the relay put behind that
 * name. Where the two disagree, only the console can say which is true, and
 * before this module there was no way to say it short of shipping a release.
 *
 * The concrete disagreement that motivated it: the catalog files
 * `deepseek-v4-flash` as text-only, so the shell wrote `input: [text]` and the
 * kernel refused every image the user attached — while the same id, on our key,
 * reads images and describes them correctly (2026-08-22 probe, 685 prompt
 * tokens on the single-user-message shape).
 *
 * Three properties are borrowed from the older implementation rather than
 * reinvented, because each answers a failure this layer can cause:
 *
 * - **Unreachable console changes nothing.** The caller keeps the catalog's
 *   answer; an override that cannot be read is unknown, not empty.
 * - **`rollout.enabled === false` voids the whole layer**, not row by row. That
 *   is the answer to "operations filled a row wrong" that does not need a
 *   release. The server withholds the rows too, so an old client cannot defeat
 *   the rollback.
 * - **An absent field does not state anything.** Only a value present in the
 *   payload overrides; everything else falls through to the catalog.
 *
 * @module openlux-plugin-account/models/profiles
 */

import type { ConsoleAccess } from '../market/console.ts'

/** Request modalities a `models[]` entry may declare, in the kernel's spelling. */
type Modality = 'text' | 'image'

/** What the console states about one model; absent keys state nothing. */
export interface ModelOverride {
  readonly input?: readonly Modality[]
}

/** Model id to the console's statement about it. */
export type ModelOverrides = ReadonlyMap<string, ModelOverride>

/** Rollout state is distinct from an empty override table. */
export interface ModelOverrideSnapshot {
  readonly enabled: boolean
  readonly overrides: ModelOverrides
}

/**
 * The scope naming "the platform's own provider" in the profile table.
 *
 * The column holds a desktop provider id, and the older shell called this route
 * `yunwu` while this one calls it `openlux` (`sync.ts`'s `ROUTE`, fixed because
 * the credential name derives from it). One row therefore describes the model
 * for whichever shell is reading, and the server's own validator only accepts
 * `yunwu` or a user-defined `cm-*` — so matching on this constant is what keeps
 * a single row from having to be duplicated per shell. Rows in a `cm-*` scope
 * describe a model behind somebody else's base URL and are not ours to apply.
 */
const BUILTIN_SCOPE = 'yunwu'

/** Budget for the override read; the same one the delivery snapshot takes. */
const PROFILES_TIMEOUT_MS = 8_000

interface WireProfile {
  readonly model_name?: unknown
  readonly provider_scope?: unknown
  readonly category?: unknown
  readonly input_image?: unknown
}

interface ApiEnvelope {
  readonly success?: boolean
  readonly message?: string
  readonly data?: {
    readonly modelProfiles?: {
      readonly rollout?: { readonly enabled?: unknown }
      readonly items?: unknown
    }
  }
}

/**
 * Read the console's capability overrides for this route.
 *
 * Only the fields this shell can act on are parsed. The payload also carries the
 * thinking declarations the older shell consumes; those are deliberately left
 * alone here, because this shell takes them from the installed catalog, which
 * states not just the levels but the wire spelling each one sends — something
 * the profile table has no column for.
 * @param access - console origin and token reader.
 * @param signal - caller cancellation.
 * @returns the overrides, empty when the rollout switch is off.
 * @throws when the console cannot be reached or answers something unreadable.
 */
export async function fetchModelOverrides(
  access: ConsoleAccess,
  signal?: AbortSignal,
): Promise<ModelOverrideSnapshot> {
  const token = await access.apiKey()
  if (token === undefined || token.trim() === '') throw new Error('no desktop token')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PROFILES_TIMEOUT_MS)
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(`${access.baseUrl.replace(/\/+$/, '')}/api/desktop-config`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`desktop config returned HTTP ${String(response.status)}`)
    }
    const envelope = await response.json() as ApiEnvelope
    if (envelope.success !== true) {
      throw new Error(envelope.message?.trim() || 'desktop config returned an invalid envelope')
    }
    const section = envelope.data?.modelProfiles
    if (section?.rollout?.enabled !== true) return { enabled: false, overrides: new Map() }
    return { enabled: true, overrides: parseItems(section.items) }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

/**
 * Turn the delivered rows into per-model statements.
 *
 * A row that names no model, sits in another provider's scope, or describes a
 * category this route does not write is dropped rather than guessed at. So is
 * one whose only field is absent: an override that states nothing must not
 * shadow the catalog with an empty answer.
 * @param items - the payload's rows.
 * @returns model id to statement.
 */
function parseItems(items: unknown): ModelOverrides {
  const out = new Map<string, ModelOverride>()
  if (!Array.isArray(items)) return out
  for (const item of items as readonly WireProfile[]) {
    const id = typeof item.model_name === 'string' ? item.model_name.trim() : ''
    if (id === '') continue
    const scope = typeof item.provider_scope === 'string' ? item.provider_scope.trim() : BUILTIN_SCOPE
    if (scope !== BUILTIN_SCOPE) continue
    // The category column decides which of the client's model lists a row
    // belongs to; only chat entries land in the route this module writes.
    const category = typeof item.category === 'string' ? item.category.trim() : 'chat'
    if (category !== 'chat') continue
    if (typeof item.input_image !== 'boolean') continue
    out.set(id, { input: item.input_image ? ['text', 'image'] : ['text'] })
  }
  return out
}
