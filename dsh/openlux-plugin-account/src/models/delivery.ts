/**
 * Two layers in one model list: what we deliver, and what the user added.
 *
 * The kernel does not help with this. Settings resolution does layer schema
 * defaults, the composition `base`, and the user document — but arrays replace
 * the lower layer wholesale rather than merge into it
 * (`dsh-settings/lib/index.js:228-241`), so a user who adds a single model
 * would shadow an entire delivered list. Both layers therefore live in the
 * same `models[]`, and each entry states which one it belongs to:
 *
 * - **We own the delivered entries.** Marked with {@link MANAGED_FLAG} and
 *   rebuilt from the console's list on every round: one that left the list
 *   disappears, one that joined arrives. The models page renders them
 *   read-only, so the marker is also a promise — nothing else writes them.
 * - **The user owns every other entry.** No marker means they added it by hand
 *   or through the models page's own "fetch models" button, and it passes
 *   through untouched.
 *
 * The marker is what makes deletion safe at all. Without it, telling "we put
 * this here" apart from "the user chose this" needs a remembered snapshot of
 * the last delivery — the problem `kubectl apply` solves with
 * `last-applied-configuration` and server-side apply solves by recording a
 * field manager. Cherry Studio, the closest product to this one, keeps the same
 * fact per row as `presetModelId`. Ours rides on the entry instead of in a
 * second document, because schemastery preserves fields a schema never declared
 * (verified by resolving an entry carrying an extra key through the same
 * object/array/dict shape the settings document uses), so there is no separate
 * file that can drift out of step with the list it describes.
 *
 * This module is the policy alone — no settings, no network, no adapter — so
 * the cases that decide whether a user loses a row can be tested directly.
 *
 * @module openlux-plugin-account/models/delivery
 */

/**
 * Marks an entry as delivered by us rather than chosen by the user.
 *
 * Product-prefixed deliberately: `models[]` belongs to the adapter's schema,
 * and a bare word like `managed` is exactly what upstream could add for its own
 * purposes one day, at which point its validator would start judging our
 * marker. The name has to survive that.
 */
export const MANAGED_FLAG = 'openluxManaged'

/**
 * The console tag that puts a model on the delivered list, when no list exists.
 *
 * Second source now, not the first: `delivered.ts` reads the console's own
 * delivered table and `sync.ts` prefers it. This rule is what a station whose
 * table nobody has filled in still runs on, and what a relay too old to serve
 * that route falls back to — so it stays, and stays as it was.
 *
 * `tags` is free text the console's own model square already reads for
 * operational meaning — it renders `new` / `热门` as NEW / HOT corner badges
 * (`web/src/components/table/model-pricing/view/card/PricingCardView.js:205-222`)
 * — so this is that column's existing habit rather than a new mechanism, and it
 * needs no server change to start using. It is shared, though: the square
 * gathers every distinct tag into its own filter list, so whatever word goes
 * here becomes visible there too.
 */
export const MANAGED_TAG = '桌面推荐'

/**
 * What to deliver while the console tags nothing.
 *
 * Not "factory settings" — it is the answer to "the tag is not in use yet",
 * which is the state every deployment is in before operations gets to it.
 * Keeping it is what lets this ship ahead of the configuration: with no tagged
 * model the delivered list is exactly what this product shipped with, and the
 * moment one model is tagged, the console takes over completely.
 *
 * Every id here is one the installed catalog describes, so these arrive with
 * real thinking declarations rather than as bare names.
 */
export const FALLBACK_MODELS: readonly string[] = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'claude-opus-4-8',
  'gemini-3.1-pro-preview',
  'gpt-5.4',
]

/** One entry of the route's `models` list, as the settings document holds it. */
export interface ModelEntry {
  readonly id: string
  readonly [field: string]: unknown
}

/**
 * The two fields of a pool entry this policy reads.
 *
 * Structural on purpose: taking `PoolModel` would drag the fetch path — and
 * through it the adapter's own type graph — into a module that is pure policy.
 */
export interface Listed {
  readonly id: string
  readonly tags?: string
}

/** Whether one entry is ours to rewrite, rather than the user's to keep. */
export function isManaged(entry: ModelEntry): boolean {
  return entry[MANAGED_FLAG] === true
}

/** Split one console `tags` cell into words, tolerating either comma. */
function tagsOf(model: Listed): readonly string[] {
  return (model.tags ?? '').split(/[,，\s]+/).filter(tag => tag !== '')
}

/**
 * The ids the console currently delivers.
 *
 * Read off the pool rather than through a request of its own: the pool is
 * already both "listed in the square for this account's group" and "callable
 * with this key" (`pool.ts`), and delivering a model that fails either test
 * would put a row in the picker whose first message errors. Square order is
 * kept — it is the console's own ordering, and operations control it there.
 * @param pool - the fetched chat pool, in square order.
 * @returns tagged ids, or the fallback list while nothing is tagged.
 */
export function deliveredIds(pool: readonly Listed[]): readonly string[] {
  const tagged = pool.filter(model => tagsOf(model).includes(MANAGED_TAG)).map(model => model.id)
  if (tagged.length > 0) return tagged
  const available = new Set(pool.map(model => model.id))
  return FALLBACK_MODELS.filter(id => available.has(id))
}

/**
 * Lay the delivered list over the entries the user owns.
 *
 * Delivered entries lead so the picker opens on what the console recommends,
 * and they are rebuilt from the id alone: every other field on a delivered
 * entry is ours, filled from the installed catalog afterwards, so carrying
 * anything over from the previous round would only preserve stale values.
 *
 * A collision resolves toward the delivered entry. That is not a preference —
 * the adapter rejects a route listing one id twice
 * (`dsh-llm-pi-ai/lib/index.js:1113-1115`), and it fails the whole section
 * rather than the offending row, so a user who hand-added a model that later
 * gets delivered would otherwise break their own settings document.
 * @param delivered - ids to deliver, in the order to show them.
 * @param kept - the user's own entries, passed through as they are.
 * @returns the merged list.
 */
export function merge(delivered: readonly string[], kept: readonly ModelEntry[]): readonly ModelEntry[] {
  const managed: ModelEntry[] = delivered.map(id => ({ id, [MANAGED_FLAG]: true }))
  const taken = new Set(delivered)
  return [...managed, ...kept.filter(entry => !taken.has(entry.id))]
}
