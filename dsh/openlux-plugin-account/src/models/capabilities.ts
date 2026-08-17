/**
 * Borrowing the kernel's own model capability data for our route.
 *
 * `llm-pi-ai` ships a catalog — 37 providers, 776 distinct model ids, 556 of
 * them with per-model thinking declarations — and a route whose key matches one
 * of those providers inherits it for free: a bare `{ id }` entry defaults every
 * unset field from the installed model of the same id
 * (`llm-pi-ai/src/config.ts:79-83`). Our route key is `openlux`, which pi-ai
 * does not ship, so nothing is inherited and every field has to be spelled out.
 *
 * That is what this module does: look a model up in the same installed catalog
 * and hand back the fields a `models[]` entry may carry. The data is therefore
 * the kernel's, measured per model upstream, rather than a family table of our
 * own guessing — the table that got `glm-4.5` a 400 for taking
 * `reasoning_effort` its sibling `glm-5` accepts.
 *
 * Not borrowed: `cost`. It prices the vendor's own endpoint, while our calls
 * bill through the relay's multipliers. The harness never reads pi-ai's cost
 * metadata anyway (`llm-pi-ai/src/catalog.ts:28-30`), so leaving it out costs
 * nothing and stating it would be a lie.
 *
 * @module openlux-plugin-account/models/capabilities
 */

import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all'

/** Thinking levels the settings schema accepts, in the kernel's own order. */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

type ThinkingLevel = typeof THINKING_LEVELS[number]

/** Request modalities a `models[]` entry may declare. */
type Modality = 'text' | 'image'

/**
 * The subset of a `models[]` entry this module can answer for.
 *
 * `id` is the caller's; everything here is what the catalog knows about it.
 * A field the catalog does not describe stays absent rather than guessed —
 * absent is a shape the kernel already understands (route defaults apply, and
 * a model with no `reasoningEfforts` simply does not reason).
 */
export interface CatalogFacts {
  readonly name?: string
  readonly contextWindow?: number
  readonly maxTokens?: number
  readonly input?: readonly Modality[]
  /** Offered levels and the wire spelling each sends; absent means no reasoning. */
  readonly reasoningEfforts?: Readonly<Partial<Record<ThinkingLevel, string | null>>>
  readonly compat?: {
    readonly thinkingFormat?: string
    readonly supportsReasoningEffort?: boolean
  }
}

/** Shape of one catalog entry, narrowed to the fields read here. */
interface CatalogModel {
  readonly id: string
  readonly name?: string
  readonly reasoning?: boolean
  readonly input?: readonly string[]
  readonly contextWindow?: number
  readonly maxTokens?: number
  readonly thinkingLevelMap?: Readonly<Record<string, string | null | undefined>>
  readonly compat?: Readonly<Record<string, unknown>>
}

/**
 * Aggregator routes carry other vendors' models under prefixed ids and their
 * own wire dialect, so their entry for a shared id describes a different
 * deployment than the one our relay reaches. When both a vendor route and an
 * aggregator describe an id, the vendor's is the one to trust.
 */
const AGGREGATORS: ReadonlySet<string> = new Set([
  'openrouter', 'vercel-ai-gateway', 'cloudflare-ai-gateway', 'opencode', 'opencode-go',
  'github-copilot', 'huggingface', 'together', 'fireworks', 'groq', 'nvidia', 'cerebras',
  'amazon-bedrock', 'azure-openai-responses', 'google-vertex', 'openai-codex',
])

/** Lowercased id to catalog entry; built once, on first ask. */
let index: Map<string, CatalogModel> | undefined

function catalogIndex(): Map<string, CatalogModel> {
  if (index !== undefined) return index
  const built = new Map<string, CatalogModel>()
  const fromAggregator = new Set<string>()
  // Plain route keys, not provider objects.
  const routes = (getBuiltinProviders() as unknown[])
    .filter((route): route is string => typeof route === 'string' && route.length > 0)
  for (const route of routes) {
    let models: CatalogModel[] = []
    try {
      models = (getBuiltinModels(route as never) ?? []) as unknown as CatalogModel[]
    } catch {
      // A route with no listable catalog (OAuth-only families) answers nothing.
      continue
    }
    const aggregator = AGGREGATORS.has(route)
    for (const model of models) {
      const key = model.id.toLowerCase()
      const seen = built.get(key)
      // First writer wins, except that a vendor route displaces an aggregator.
      if (seen !== undefined && !(fromAggregator.has(key) && !aggregator)) continue
      built.set(key, model)
      if (aggregator) fromAggregator.add(key)
      else fromAggregator.delete(key)
    }
  }
  index = built
  return built
}

/**
 * A dated release names the same model as its base id (`gpt-5-mini-2025-08-07`
 * and `gpt-5-mini`), which is the one rewrite that is a fact rather than a
 * guess. Anything looser — trimming `-32b`, matching prefixes — would claim two
 * different models share a thinking protocol, which is precisely the class of
 * assumption that earns a 400 from the endpoint.
 */
function undated(id: string): string | undefined {
  const base = id.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{6}$/, '')
  return base === id ? undefined : base
}

/**
 * Translate pi-ai's `thinkingLevelMap` into the settings schema's dict.
 *
 * The two describe the same thing through opposite defaults. pi-ai reads an
 * absent key asymmetrically — supported for the five base levels, unsupported
 * for `xhigh`/`max` — while the settings dict reads an absent key as
 * unsupported everywhere and pins the rest explicitly on resolution
 * (`llm-pi-ai/src/catalog.ts:298-310`, whose stated intent is that a profile
 * author should not need to know the asymmetry). So each level is decided here:
 *
 * - a wire string is offered with that spelling;
 * - `null` is unsupported and stays out;
 * - an absent `off` becomes `off: null`, the schema's spelling for "offered,
 *   send nothing", which is what pi-ai's absent `off` already means;
 * - an absent base level is dropped rather than offered. The schema refuses a
 *   valueless non-`off` level (`catalog.ts:345-354`), so "offered, send
 *   nothing" has no spelling there, and inventing a wire value would send the
 *   endpoint a word no catalog ever claimed it accepts.
 *
 * @param map - the installed entry's level map.
 * @returns the dict for a `models[]` entry, or undefined when no level is offered.
 */
function effortsOf(
  map: Readonly<Record<string, string | null | undefined>>,
): Partial<Record<ThinkingLevel, string | null>> | undefined {
  const efforts: Partial<Record<ThinkingLevel, string | null>> = {}
  for (const level of THINKING_LEVELS) {
    const wire = map[level]
    if (typeof wire === 'string' && wire.length > 0) efforts[level] = wire
    else if (wire === undefined && level === 'off') efforts[level] = null
  }
  // The schema rejects a dict offering nothing but `off`, and rightly: that
  // describes a model that cannot think, which `reasoningEfforts` absent
  // already says without claiming a level.
  return Object.keys(efforts).some(level => level !== 'off') ? efforts : undefined
}

/**
 * What the installed catalog knows about one model id.
 * @param id - the model id as our relay spells it.
 * @returns the fields to write onto a `models[]` entry, or undefined when the
 *   catalog does not describe this model.
 */
export function catalogFacts(id: string): CatalogFacts | undefined {
  const catalog = catalogIndex()
  const base = undated(id)
  const model = catalog.get(id.toLowerCase()) ?? (base === undefined ? undefined : catalog.get(base.toLowerCase()))
  if (model === undefined) return undefined

  const facts: {
    -readonly [K in keyof CatalogFacts]: CatalogFacts[K]
  } = {}
  if (typeof model.name === 'string' && model.name.length > 0) facts.name = model.name
  if (typeof model.contextWindow === 'number' && model.contextWindow > 0) facts.contextWindow = model.contextWindow
  if (typeof model.maxTokens === 'number' && model.maxTokens > 0) facts.maxTokens = model.maxTokens
  const input = (model.input ?? []).filter((m): m is Modality => m === 'text' || m === 'image')
  if (input.length > 0) facts.input = input

  if (model.reasoning === true && model.thinkingLevelMap !== undefined) {
    const efforts = effortsOf(model.thinkingLevelMap)
    if (efforts !== undefined) facts.reasoningEfforts = efforts
  }

  // Only the two switches the settings schema takes. The rest of pi-ai's compat
  // block (`supportsStore`, developer-role handling) describes the vendor's own
  // endpoint and has no spelling here; the route already carries what our relay
  // needs.
  const thinkingFormat = model.compat?.['thinkingFormat']
  const supportsReasoningEffort = model.compat?.['supportsReasoningEffort']
  const compat: { thinkingFormat?: string; supportsReasoningEffort?: boolean } = {}
  if (typeof thinkingFormat === 'string' && thinkingFormat.length > 0) compat.thinkingFormat = thinkingFormat
  if (typeof supportsReasoningEffort === 'boolean') compat.supportsReasoningEffort = supportsReasoningEffort
  // A compat block is only meaningful beside a thinking capability; on a model
  // that does not reason it would be a switch with nothing to switch.
  if (facts.reasoningEfforts !== undefined && Object.keys(compat).length > 0) facts.compat = compat

  return facts
}

/** How many model ids the installed catalog describes; for diagnostics. */
export function catalogSize(): number {
  return catalogIndex().size
}
