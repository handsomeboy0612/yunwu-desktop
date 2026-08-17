/**
 * Keeping our provider route's model list honest, without owning what the user
 * chose.
 *
 * The kernel splits this cleanly, and the split is worth naming because it is
 * what lets an automatic writer coexist with a settings page:
 *
 * - **The user owns membership and labels.** The models page edits exactly
 *   `id`, `name`, `contextWindow` and `maxTokens`
 *   (`ui-settings-models/src/client/ModelListEditor.tsx`), and its save path
 *   spreads the existing entry first so a field it does not edit survives.
 * - **We own the thinking declaration.** `reasoningEfforts` and `compat` have
 *   no editor anywhere in the shell, so nothing else can write them — and
 *   without them a hand-declared model simply does not reason, which is how
 *   every model on this route would behave if we wrote nothing.
 *
 * So this module never removes a model and never renames one. It seeds the
 * list on a machine that is still at the factory two, and it keeps the
 * thinking declaration current for whatever is in the list — including a model
 * the user just adopted through the models page's own "fetch models" button.
 *
 * **It does not prune.** A model that left the square, or that this key can no
 * longer call, stays in the list. Deleting it would be acting on a snapshot
 * taken at exactly the wrong moment — the square hiccups, and a user's curated
 * list is silently gone. A stale entry fails loudly when used and can be
 * removed by hand; silent deletion cannot be undone.
 *
 * @module openlux-plugin-account/models/sync
 */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { catalogFacts } from './capabilities.ts'
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

/**
 * What a machine that has never chosen anything starts with.
 *
 * Every id here is one the installed catalog describes, so the starter set
 * arrives with real thinking declarations rather than as bare names, and each
 * is filtered against the live pool before being written — seeding a model
 * this key cannot call would make the very first message fail.
 *
 * This is a starting point, not a recommendation: changing it moves nothing
 * for anyone who has already curated a list.
 */
const STARTER_MODELS: readonly string[] = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'claude-opus-4-8',
  'gemini-3.1-pro-preview',
  'gpt-5.4',
]

/** One entry of the route's `models` list, as the settings document holds it. */
interface ModelEntry {
  readonly id: string
  readonly [field: string]: unknown
}

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
 * Whether anyone has ever decided this route's membership.
 *
 * Asked of the raw user section rather than compared against a copy of the
 * factory list: the descriptor's `user` layer is the kernel's own answer to
 * "was this overridden", so there is no second copy of the shipped list to
 * drift. Our own seed writes into that layer, which is what freezes membership
 * afterwards — the list stops being ours the moment it exists.
 * @param settings - the settings service.
 */
function membershipDecided(settings: SettingsLike): boolean {
  const descriptor = settings.describe().find(entry => entry.ns === PI_AI_NS)
  return modelsOf(descriptor?.user) !== undefined
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
 * Bring the route's model list up to date.
 *
 * Network is needed only to seed: an installation that already has a list is
 * reconciled from the in-process catalog alone, so a launch with no
 * connectivity still lands correct thinking declarations.
 * @param ctx - host context.
 * @param options - console origin, factory list, and how to read the key.
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
  let membership = current
  if (!membershipDecided(settings)) {
    const apiKey = await options.apiKey()
    if (apiKey === undefined || apiKey === '') return { changed: false, skipped: 'no-key' }
    const pool = await fetchChatPool(ctx, options.baseUrl, apiKey, signal)
    if (pool === undefined) return { changed: false, skipped: 'no-pool' }
    const available = new Set(pool.map(model => model.id))
    const seeded = STARTER_MODELS.filter(id => available.has(id)).map(id => ({ id }))
    // Not one starter is callable with this key: leave the factory list alone
    // rather than empty the picker. The user still has the models page.
    if (seeded.length > 0) membership = seeded
  }

  const next = membership.map(described)
  if (same(current, next)) return { changed: false, skipped: 'unchanged', models: next.length }
  await settings.mutate(PI_AI_NS, [{ op: 'set', path: ['providers', ROUTE, 'models'], value: next }])
  return {
    changed: true,
    models: next.length,
    described: next.filter(entry => entry['reasoningEfforts'] !== undefined).length,
  }
}
