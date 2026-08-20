/**
 * Writing the two-layer model list into the adapter's settings section.
 *
 * Which entries belong to which layer is {@link ./delivery.ts}'s subject; this
 * module is the round that applies it — read the console, merge, and fill in
 * the fields only the installed catalog knows. The one thing it owns outright
 * is the thinking declaration (`reasoningEfforts` / `compat`): nothing else in
 * the shell can write those, and without them a hand-declared model simply
 * does not reason, so they are refreshed for the user's own entries too.
 *
 * **A round that cannot read the console changes nothing about membership.** An
 * unreachable console means the delivered list is *unknown*, not empty, and
 * acting on the empty case would delete every delivered entry the first time
 * the network blinks. Same discipline the pool already follows (`pool.ts`): no
 * snapshot, no reconcile.
 *
 * @module openlux-plugin-account/models/sync
 */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { catalogFacts } from './capabilities.ts'
import { deliveredIds, isManaged, merge, type ModelEntry } from './delivery.ts'
import { fetchChatPool } from './pool.ts'

/**
 * The settings namespace that owns provider routes. Not ours — we write into
 * the adapter's section, which is what the kernel's own models page does
 * ("which adapters exist is composition; which providers run is the user's
 * settings document", `bundle/base/cordis.patch.yml`).
 */
const PI_AI_NS = settingsNamespace('llm-pi-ai')

/**
 * Our route key. Fixed rather than configurable: the kernel's models page
 * derives the credential reference `<ROUTE>_API_KEY` from it, so renaming the
 * route renames the credential.
 */
export const ROUTE = 'openlux'

/** The slice of the adapter's section this module reads. */
interface PiAiSection {
  readonly providers?: Record<string, { readonly models?: readonly ModelEntry[] } | undefined>
}

/** What one sync did, for the log and for tests. */
export interface SyncOutcome {
  readonly changed: boolean
  /** Why nothing happened, when nothing did. */
  readonly skipped?: 'no-settings' | 'no-key' | 'no-pool' | 'unchanged'
  readonly models?: number
  /** Of those, the ones the console delivered. */
  readonly managed?: number
  /** Of those, the ones the user added themselves and this round left alone. */
  readonly kept?: number
  /** Models whose thinking declaration the installed catalog supplied. */
  readonly described?: number
}

/** The settings service surface this module uses. */
interface SettingsLike {
  get(ns: typeof PI_AI_NS): unknown
  describe(options?: { redactSecrets?: boolean }): readonly { ns: string; user?: unknown }[]
  mutate(ns: typeof PI_AI_NS, ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[]): Promise<void>
}

function modelsOf(section: unknown): readonly ModelEntry[] | undefined {
  const models = (section as PiAiSection | undefined)?.providers?.[ROUTE]?.models
  if (!Array.isArray(models)) return undefined
  return models.filter(entry => typeof entry?.id === 'string' && entry.id !== '')
}

function currentModels(settings: SettingsLike): readonly ModelEntry[] {
  return modelsOf(settings.get(PI_AI_NS)) ?? []
}

/**
 * The entries this machine's settings document actually holds, as opposed to
 * the resolved value.
 *
 * The difference is who owns what. Factory entries arrive from the composition
 * `base` layer and belong to nobody; reading the resolved value would make
 * them look like the user's own picks and preserve them forever, next to a
 * delivered list that already covers the same ground. The descriptor's `user`
 * layer is the kernel's own answer to "was this written here", and both the
 * models page and this module write into it — so it is exactly the set of
 * entries somebody chose on purpose.
 * @param settings - the settings service.
 * @returns the user layer's entries; empty when nothing was ever written.
 */
function writtenModels(settings: SettingsLike): readonly ModelEntry[] {
  const descriptor = settings.describe().find(entry => entry.ns === PI_AI_NS)
  return modelsOf(descriptor?.user) ?? []
}

/**
 * Overlay the installed catalog's thinking declaration onto one entry.
 *
 * Capacities and modalities are filled only where the entry says nothing, so a
 * context window the user typed survives; the thinking fields are ours and are
 * rewritten from the catalog every time, which is what makes a kernel upgrade
 * carrying new model data reach an existing installation.
 * @param entry - the entry as stored.
 * @returns the entry with catalog-derived fields applied.
 */
function described(entry: ModelEntry): ModelEntry {
  const facts = catalogFacts(entry.id)
  if (facts === undefined) return entry
  const next: Record<string, unknown> = { ...entry }
  if (next['name'] === undefined && facts.name !== undefined) next['name'] = facts.name
  if (next['contextWindow'] === undefined && facts.contextWindow !== undefined) {
    next['contextWindow'] = facts.contextWindow
  }
  if (next['maxTokens'] === undefined && facts.maxTokens !== undefined) next['maxTokens'] = facts.maxTokens
  // The schema materializes `[]` for an absent array, and resolution reads that
  // as "no answer here" — so an empty list is a gap to fill, not a choice.
  const input = next['input']
  if ((input === undefined || (Array.isArray(input) && input.length === 0)) && facts.input !== undefined) {
    next['input'] = [...facts.input]
  }
  if (facts.reasoningEfforts === undefined) {
    delete next['reasoningEfforts']
    delete next['compat']
  } else {
    next['reasoningEfforts'] = { ...facts.reasoningEfforts }
    if (facts.compat === undefined) delete next['compat']
    else next['compat'] = { ...facts.compat }
  }
  return next as ModelEntry
}

/** Stable comparison of two lists, so an unchanged sync writes nothing. */
function same(a: readonly ModelEntry[], b: readonly ModelEntry[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Reconcile the route's model list: deliver what the console lists, keep what
 * the user added, refresh what the installed catalog owns.
 *
 * Every round wants the network now — the delivered list is the console's to
 * state, and nothing local mirrors it beyond the fallback. A round that cannot
 * reach it still refreshes the thinking declarations of whatever is already
 * written, so launching offline lands correct capabilities on an existing list;
 * only a machine with nothing written yet comes away untouched, which is the
 * one case where guessing would put rows in the picker nobody asked for.
 * @param ctx - host context.
 * @param options - console origin and how to read the key.
 * @param signal - caller cancellation.
 * @returns what the sync did.
 */
export async function syncModels(
  ctx: Context,
  options: {
    readonly baseUrl: string
    readonly apiKey: () => Promise<string | undefined>
  },
  signal?: AbortSignal,
): Promise<SyncOutcome> {
  const settings = ctx.get('settings') as SettingsLike | undefined
  if (settings === undefined) return { changed: false, skipped: 'no-settings' }

  const current = currentModels(settings)
  const written = writtenModels(settings)

  const apiKey = await options.apiKey()
  const pool = apiKey === undefined || apiKey === ''
    ? undefined
    : await fetchChatPool(ctx, options.baseUrl, apiKey, signal)

  if (pool === undefined && written.length === 0) {
    return { changed: false, skipped: apiKey === undefined || apiKey === '' ? 'no-key' : 'no-pool' }
  }

  const membership = pool === undefined
    ? current
    : merge(deliveredIds(pool), written.filter(entry => !isManaged(entry)))

  const next = membership.map(described)
  if (same(current, next)) return { changed: false, skipped: 'unchanged', models: next.length }
  await settings.mutate(PI_AI_NS, [{ op: 'set', path: ['providers', ROUTE, 'models'], value: next }])
  return {
    changed: true,
    models: next.length,
    managed: next.filter(isManaged).length,
    kept: next.filter(entry => !isManaged(entry)).length,
    described: next.filter(entry => entry['reasoningEfforts'] !== undefined).length,
  }
}
