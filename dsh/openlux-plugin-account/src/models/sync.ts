/**
 * Writing the two-layer model list into the adapter's settings section.
 *
 * Which entries belong to which layer is {@link ./delivery.ts}'s subject; this
 * module is the round that applies it — read the console, merge, and fill in
 * the fields only the installed catalog knows.
 *
 * The delivered half has two possible sources and this module owns the order:
 * the console's own list ({@link ./delivered.ts}) first, and the square-tag
 * rule ({@link ./delivery.ts}) only when that says nothing. Operations own the
 * first; the second is what a station that has configured nothing still has.
 *
 * The one thing this module owns outright
 * is the thinking declaration (`reasoningEfforts` / `compat`): nothing else in
 * the shell can write those, and without them a hand-declared model simply
 * does not reason, so they are refreshed for the user's own entries too.
 *
 * Those fields come from the installed catalog, and the catalog describes each
 * vendor's own service rather than the channel our relay put behind that name.
 * Where the two disagree the console has the last word
 * ({@link ./profiles.ts}) — the layer this shell was missing, and the reason
 * `deepseek-v4-flash` was written as text-only while it reads images fine.
 *
 * One neighbouring section is written from the same snapshot: the install
 * default ({@link applyDefaultModel} — narrowly, because that one belongs to the
 * user).
 *
 * The search chain used to be written here too, into `web-search-deepseek`'s
 * `models`. That was a dead write: the section's schema carries a singular
 * `model` and nothing in that package ever reads a list
 * (`dsh-web-search-deepseek/lib/index.js:239-247`), so the console's priority
 * list sat in the settings file and every search ran on the composition's pinned
 * model. The list now reaches its consumer directly — the delivered snapshot is
 * handed to our own search provider (`web/search/provider.ts`), which is what
 * finally honours the ordering and the degradation the console page promises. An
 * inert `models` key left in a settings file by an older build is harmless and
 * is not migrated away: the schema ignores unknown keys, and rewriting another
 * plugin's section to tidy up would be a worse trade than the litter.
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
import { fetchDeliveredModelConfig, type DeliveredModelConfig } from './delivered.ts'
import { deliveredIds, isManaged, merge, type ModelEntry } from './delivery.ts'
import { fetchChatPool } from './pool.ts'
import { fetchModelOverrides, type ModelOverrides } from './profiles.ts'

/**
 * The settings namespace that owns provider routes. Not ours — we write into
 * the adapter's section, which is what the kernel's own models page does
 * ("which adapters exist is composition; which providers run is the user's
 * settings document", `bundle/base/cordis.patch.yml`).
 */
const PI_AI_NS = settingsNamespace('llm-pi-ai')
/**
 * The section deciding which model a new session starts on.
 *
 * Not ours either, and unlike the two above it is *the user's own choice*: the
 * client's model picker writes it through the host's
 * `saveDefaultModelSelection` seam (`dsh-host-apiproxy`, which calls
 * `agentDefaultModel.saveSelection`). That is why {@link applyDefaultModel}
 * touches it in two narrow cases rather than mirroring the delivered list onto
 * it every round.
 */
const DEFAULT_NS = settingsNamespace('agent-default-model')

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
  /**
   * Why nothing happened, when nothing did. `no-pool` covers "neither source
   * answered": no console list *and* no square, which is the offline case.
   */
  readonly skipped?: 'no-settings' | 'no-key' | 'no-pool' | 'empty-result' | 'unchanged'
  /**
   * Where the delivered ids came from. Worth logging on its own: the two
   * sources fail in different ways, and "which one answered" is the first
   * thing anybody asks when the picker holds the wrong rows.
   */
  readonly source?: 'console' | 'square'
  readonly models?: number
  /** Of those, the ones the console delivered. */
  readonly managed?: number
  /** Of those, the ones the user added themselves and this round left alone. */
  readonly kept?: number
  /** Models whose thinking declaration the installed catalog supplied. */
  readonly described?: number
  /**
   * Of those, the ones the console overrode. Reported on its own because "did
   * the capability layer reach this machine at all" is the first question when
   * a model still refuses images after operations ticked the box — and an
   * unreachable console and an empty table look identical from the settings
   * file alone.
   */
  readonly overridden?: number
  /** The full server snapshot, also used by the media tools' runtime defaults. */
  readonly delivery?: DeliveredModelConfig
}

/** One path edit, in the service's own vocabulary (`{op:'set'|'unset', path}`). */
type SettingsOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

/** The settings service surface this module uses. */
interface SettingsLike {
  get(ns: typeof PI_AI_NS): unknown
  describe(options?: { redactSecrets?: boolean }): readonly { ns: string; user?: unknown }[]
  mutate(ns: typeof PI_AI_NS, ops: readonly SettingsOp[]): Promise<void>
}

/** The two fields of the default-model section this module reads. */
interface DefaultSelection {
  readonly provider?: string
  readonly model?: string
}

function selectionOf(value: unknown): DefaultSelection {
  const section = value as { provider?: unknown; model?: unknown } | undefined
  return {
    ...typeof section?.provider === 'string' ? { provider: section.provider } : {},
    ...typeof section?.model === 'string' && section.model !== '' ? { model: section.model } : {},
  }
}

/**
 * Point the install default at the delivered list — in two cases and no more.
 *
 * The server states the contract (`admin-server/model/desktop_delivered_model.go`:
 * "ChatModels：客户端模型清单，第一项是新装机默认"), and until now nothing on this
 * side implemented it: the default stayed at whatever the composition shipped,
 * so reordering the delivered list changed nothing and a list that dropped the
 * packaged name left every new session starting on a model the picker no longer
 * offers.
 *
 * Why not simply mirror `chatModels[0]` every round: this section is the user's
 * own choice. Picking a model in the client writes it through the host's
 * `saveDefaultModelSelection`, so a round that rewrote it would take the choice
 * away again on the next sync. Hence:
 *
 *  - **nothing written here yet** → seed with the first delivered name. Nobody
 *    has chosen, so operations' order is the only opinion in the room.
 *  - **what is written names one of our models that the list no longer holds**
 *    → move it. That name is gone from the picker, and leaving it would start
 *    every new session on a route entry that does not exist.
 *
 * A default naming another provider, or an entry the user added themselves, is
 * left alone in both cases.
 * @param settings - the settings service.
 * @param delivery - the server snapshot; only a configured one speaks here.
 * @param models - the route's entries as this round leaves them.
 * @returns whether the section was written.
 */
async function applyDefaultModel(
  settings: SettingsLike,
  delivery: DeliveredModelConfig | undefined,
  models: readonly ModelEntry[],
): Promise<boolean> {
  if (delivery?.configured !== true) return false
  // Delivered order, but only names that survived this round's merge: seeding a
  // default the picker does not list would recreate the very problem below.
  const first = delivery.chatModels.find(id => models.some(entry => entry.id === id))
  if (first === undefined) return false

  const written = selectionOf(settings.describe().find(entry => entry.ns === DEFAULT_NS)?.user)
  if (written.model !== undefined) {
    if (written.provider !== ROUTE) return false
    if (models.some(entry => entry.id === written.model)) return false
  }
  const resolved = selectionOf(settings.get(DEFAULT_NS))
  if (resolved.provider === ROUTE && resolved.model === first) return false

  await settings.mutate(DEFAULT_NS, [
    { op: 'set', path: ['provider'], value: ROUTE },
    { op: 'set', path: ['model'], value: first },
    // The effort was chosen for the model being left behind. Levels are
    // declared per model (`reasoningEfforts`), so carrying one across is at
    // best meaningless and at worst a level the next model does not have.
    { op: 'unset', path: ['reasoningEffort'] },
  ])
  return true
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
 * Overlay the installed catalog's thinking declaration onto one entry, then the
 * console's word over the catalog.
 *
 * Capacities and modalities are filled only where the entry says nothing, so a
 * context window the user typed survives; the thinking fields are ours and are
 * rewritten from the catalog every time, which is what makes a kernel upgrade
 * carrying new model data reach an existing installation.
 *
 * The console's statement is applied last and *replaces* rather than fills.
 * That is the whole point of an override layer: the catalog already answered,
 * and the answer is what operations measured to be wrong for our deployment.
 * Nothing in the shell lets a user declare modalities by hand, so there is no
 * choice of theirs being overwritten here (`described` still leaves a value
 * alone when the console says nothing about that model).
 * @param entry - the entry as stored.
 * @param overrides - the console's statements, empty when it said nothing.
 * @returns the entry with catalog-derived and console-derived fields applied.
 */
function described(entry: ModelEntry, overrides: ModelOverrides): ModelEntry {
  const facts = catalogFacts(entry.id)
  const override = overrides.get(entry.id)
  if (facts === undefined) {
    if (override?.input === undefined) return entry
    return { ...entry, input: [...override.input] } as ModelEntry
  }
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
  if (override?.input !== undefined) next['input'] = [...override.input]
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
  const hasKey = apiKey !== undefined && apiKey !== ''

  // The four-purpose snapshot is authoritative when configured. A missing route,
  // old deployment or transient network failure remains "unknown": do not clear
  // any local state, and let the packaged/square paths continue to carry chat.
  let delivery: DeliveredModelConfig | undefined
  if (hasKey) {
    try {
      delivery = await fetchDeliveredModelConfig(options, signal)
    } catch (error: unknown) {
      ctx.logger.warn(`openlux: model delivery unavailable; preserving local defaults (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  // The capability layer, read in the same round and treated the same way: a
  // console this round could not reach states nothing, and nothing is what the
  // entries keep — the catalog's answer, which is what shipped before this
  // layer existed.
  let overrides: ModelOverrides = new Map()
  if (hasKey) {
    try {
      overrides = await fetchModelOverrides(options, signal)
    } catch (error: unknown) {
      ctx.logger.warn(`openlux: model capability overrides unavailable; keeping the installed catalog's answer (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  const reportedDelivery = delivery === undefined ? {} : { delivery }

  let ids: readonly string[] | undefined
  let source: SyncOutcome['source']
  if (delivery?.configured === true && delivery.chatModels.length > 0) {
    ids = delivery.chatModels
    source = 'console'
  } else if (hasKey) {
    // Only now is the square worth two requests: reaching it costs `/v1/models`
    // plus `/api/pricing_new`, and a station that answered the list above has
    // already told us everything this round needs.
    const pool = await fetchChatPool(ctx, options.baseUrl, apiKey as string, signal)
    if (pool !== undefined) {
      ids = deliveredIds(pool)
      source = 'square'
    }
  }

  if (ids === undefined && written.length === 0) {
    return {
      changed: false,
      skipped: hasKey ? 'no-pool' : 'no-key',
      ...reportedDelivery,
    }
  }

  const membership = ids === undefined
    ? current
    : merge(ids, written.filter(entry => !isManaged(entry)))

  // A list that came out empty is a miscalculation upstream of here, never an
  // instruction to empty the picker — nothing a user or the console can do says
  // "leave this account with no models". Reaching the console and computing zero
  // means its answer did not survive our own filters, and the composition floor
  // is a better thing to leave standing than nothing at all.
  //
  // Not hypothetical: against a station whose `models.model_type` is mostly
  // blank, the pool keeps only the handful that say 对话 (`pool.ts` tests for
  // that word), none of which are ids the fallback names — so a machine with
  // nothing written yet computed zero and tried to write `models: []`, and the
  // picker was left showing only the two rows the composition ships. That is
  // the case the console list above answers outright: it names the models and
  // carries their category, so no column has to be guessed from.
  if (membership.length === 0) {
    return { changed: false, skipped: 'empty-result', ...reportedDelivery }
  }

  const next = membership.map(entry => described(entry, overrides))
  // Spread rather than assign: `exactOptionalPropertyTypes` treats an explicit
  // `undefined` as a different thing from an absent key, and a round that read
  // neither source has no source to report.
  const reported = source === undefined ? {} : { source }
  const listChanged = !same(current, next)
  if (listChanged) {
    await settings.mutate(PI_AI_NS, [{ op: 'set', path: ['providers', ROUTE, 'models'], value: next }])
  }
  // After the list is written, so the seed can only name a row that is in it,
  // and caught rather than thrown: another namespace failing must not undo a
  // list this round already applied.
  let defaultChanged = false
  try {
    defaultChanged = await applyDefaultModel(settings, delivery, next)
  } catch (error: unknown) {
    ctx.logger.warn(`openlux: default model could not be aligned with the delivered list (${error instanceof Error ? error.message : String(error)})`)
  }
  if (!listChanged) {
    return {
      changed: defaultChanged,
      skipped: 'unchanged',
      models: next.length,
      ...reported,
      ...reportedDelivery,
    }
  }
  return {
    changed: true,
    ...reported,
    models: next.length,
    managed: next.filter(isManaged).length,
    kept: next.filter(entry => !isManaged(entry)).length,
    described: next.filter(entry => entry['reasoningEfforts'] !== undefined).length,
    overridden: next.filter(entry => overrides.has(entry.id)).length,
    ...reportedDelivery,
  }
}
