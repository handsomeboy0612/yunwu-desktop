/**
 * Which models this key may search with, in the order to try them.
 *
 * The list is assembled the same way the image and video defaults are: the
 * route's live catalogue says what is servable, each transport claims the rows
 * it can drive, and **the delivered list decides** among them
 * (`media/image/registry.ts` states the argument at length). What is new here is
 * only that the delivered value is a *priority list* rather than one name,
 * because that is what the console has always promised for search: 「网页搜索先
 * 调用第一项；渠道不可用、限流或响应不合格时，自动尝试下一项」
 * (`admin-cloud/src/pages/desktop-delivered-model/index.tsx:629`).
 *
 * ## Why a delivered name may be dropped
 *
 * The console's picker is a free-text completion over the whole model library
 * and filters by nothing, and the route only checks that a delivered name is
 * callable and on sale (`new-yunwu-api/controller/desktop_delivered_model_client.go:84`).
 * So the list genuinely can contain a model that cannot search at all — this
 * machine's own delivery is `gpt-4o-mini`, tagged 「对话,识图」. Such an entry is
 * skipped rather than spent: it would answer confidently from memory, and this
 * seam cannot tell that apart from a search except by the absent sources.
 *
 * @module openlux-plugin-account/web/search/candidates
 */

import type { Context } from '@deepseek-ai/cordis'
import { normalizeBase, requestJson } from '../../account/http.ts'
import type { ConsoleAccess } from '../../market/console.ts'
import { claudeNativeTransport } from './claude-native.ts'
import { geminiGroundingTransport } from './gemini-grounding.ts'
import { openaiAnnotationsTransport } from './openai-annotations.ts'
import type { SearchCatalogRow, SearchTransport } from './transport.ts'

/**
 * Every way this plugin can retrieve the web.
 *
 * Order here is the ranking for a search nobody configured, and it is a ranking
 * over *citation quality first, latency second*, both measured 2026-08-24:
 * Claude's native tool returns url + title + `page_age` in 2.4s; the OpenAI
 * search family returns url + title in 7.4–8.7s; Gemini grounding returns
 * titleless redirect URLs scraped from prose in 4.6s. A reader can act on the
 * first two and mostly cannot on the third.
 */
export const SEARCH_TRANSPORTS: readonly SearchTransport[] = [
  claudeNativeTransport,
  openaiAnnotationsTransport,
  geminiGroundingTransport,
]

/** How long a catalogue read stays current; the pool changes on the order of hours. */
const CATALOG_TTL_MS = 300_000

/** Budget for reading the catalogue; it is a small JSON list on a warm path. */
const CATALOG_TIMEOUT_MS = 15_000

/** One servable model, with the transport that claimed it. */
export interface SearchCandidate {
  readonly model: string
  readonly transport: SearchTransport
}

/** The claimable models, as of one read. */
interface SearchCatalog {
  readonly candidates: readonly SearchCandidate[]
  /** Every id the read carried, so a dropped delivered name can be explained. */
  readonly present: ReadonlySet<string>
  readonly at: number
}

/** One `/v1/models` element, as far as this module reads it. */
interface RawRow {
  readonly id?: unknown
  readonly supported_endpoint_types?: unknown
  readonly model_type?: unknown
  readonly tags?: unknown
}

const cache = new Map<string, SearchCatalog>()

/**
 * Read the claimable search models, from cache when it is current.
 * @param ctx - host context.
 * @param access - route origin and token reader.
 * @param token - the already-resolved key, so this never resolves it twice.
 * @param signal - caller cancellation.
 * @returns the catalogue, or undefined when it could not be read at all.
 */
async function readCatalog(
  ctx: Context,
  access: ConsoleAccess,
  token: string,
  signal?: AbortSignal,
): Promise<SearchCatalog | undefined> {
  const base = normalizeBase(access.baseUrl)
  const key = `${base}|${token}`
  const cached = cache.get(key)
  if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return cached

  try {
    const reply = await requestJson(ctx, `${base}/v1/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, CATALOG_TIMEOUT_MS, signal)
    if (!reply.response.ok) {
      ctx.logger.warn(`openlux: search catalogue read returned HTTP ${String(reply.response.status)}; falling back to proven names`)
      return cached
    }
    const rows = (reply.body as { readonly data?: unknown } | undefined)?.data
    if (!Array.isArray(rows)) return cached
    const candidates: SearchCandidate[] = []
    const present = new Set<string>()
    for (const raw of rows as readonly RawRow[]) {
      const row = read(raw)
      if (row === undefined) continue
      present.add(row.id)
      const transport = SEARCH_TRANSPORTS.find(candidate => candidate.claims(row))
      if (transport === undefined) continue
      candidates.push({ model: row.id, transport })
    }
    // An empty result is a shape we do not understand rather than a route with
    // no search-capable model, so the previous read outranks it.
    if (candidates.length === 0) return cached
    const fresh: SearchCatalog = { candidates, present, at: Date.now() }
    cache.set(key, fresh)
    return fresh
  } catch (error: unknown) {
    ctx.logger.warn(`openlux: search catalogue unreadable (${error instanceof Error ? error.message : String(error)}); falling back to proven names`)
    return cached
  }
}

/** Narrow one catalogue element to the fields a claim may read. */
function read(raw: RawRow): SearchCatalogRow | undefined {
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id === '') return undefined
  const types = Array.isArray(raw.supported_endpoint_types)
    ? (raw.supported_endpoint_types as readonly unknown[]).filter((type): type is string => typeof type === 'string')
    : []
  // `tags` is one comma-separated string on this route, e.g. `对话,联网`.
  const tags = typeof raw.tags === 'string'
    ? raw.tags.split(',').map(tag => tag.trim()).filter(tag => tag !== '')
    : []
  return { id, types, tags, modelType: typeof raw.model_type === 'string' ? raw.model_type : '' }
}

/** What one plan says about the models it left out. */
export interface SearchPlan {
  /** Models to try, best first. */
  readonly candidates: readonly SearchCandidate[]
  /** Delivered names nothing here can search with, for one log line. */
  readonly unusable: readonly string[]
  /** True when the catalogue could not be read and proven names are standing in. */
  readonly blind: boolean
}

/**
 * Decide what to try, in order.
 *
 * @param ctx - host context.
 * @param access - route origin and token reader.
 * @param token - the resolved key for this search.
 * @param delivered - the console's priority list, in its own order.
 * @param signal - caller cancellation.
 * @returns the ordered candidates plus what was dropped and why.
 */
export async function planSearch(
  ctx: Context,
  access: ConsoleAccess,
  token: string,
  delivered: readonly string[],
  signal?: AbortSignal,
): Promise<SearchPlan> {
  const catalog = await readCatalog(ctx, access, token, signal)
  if (catalog === undefined) {
    // Blind: the catalogue is unreadable, so neither the delivered names nor the
    // proven ones can be checked. Both are tried anyway rather than refusing —
    // one flaky read must not take down a capability that was working, and the
    // route's own refusal is legible. This mirrors `readImageCatalog`'s
    // fail-open, and the ordering still honours the console's list first.
    const guesses = [...delivered, ...SEARCH_TRANSPORTS.flatMap(transport => transport.provenModels)]
    const seen = new Set<string>()
    const candidates: SearchCandidate[] = []
    for (const model of guesses) {
      if (model === '' || seen.has(model)) continue
      seen.add(model)
      const transport = SEARCH_TRANSPORTS.find(candidate => candidate.provenModels.includes(model))
      // A delivered name with no known transport cannot be driven blind: there
      // is no wire format to guess. Proven names always resolve.
      if (transport !== undefined) candidates.push({ model, transport })
    }
    return { candidates, unusable: [], blind: true }
  }

  const byModel = new Map(catalog.candidates.map(candidate => [candidate.model, candidate]))
  const ordered: SearchCandidate[] = []
  const unusable: string[] = []
  const taken = new Set<string>()
  for (const model of delivered) {
    if (model === '' || taken.has(model)) continue
    const claimed = byModel.get(model)
    if (claimed === undefined) {
      unusable.push(model)
      continue
    }
    taken.add(model)
    ordered.push(claimed)
  }

  const rank = (candidate: SearchCandidate): number => SEARCH_TRANSPORTS.indexOf(candidate.transport)
  const proven = (candidate: SearchCandidate): number => {
    const index = candidate.transport.provenModels.indexOf(candidate.model)
    return index === -1 ? candidate.transport.provenModels.length : index
  }
  const rest = catalog.candidates
    .filter(candidate => !taken.has(candidate.model))
    .sort((left, right) => rank(left) - rank(right)
      || proven(left) - proven(right)
      // Arbitrary but stable: three reads of this catalogue seconds apart
      // returned the same 476 rows in three different orders (Go map
      // iteration), so ranking by the route's order would search with a
      // different model on every call.
      || left.model.localeCompare(right.model))
  return { candidates: [...ordered, ...rest], unusable, blind: false }
}
