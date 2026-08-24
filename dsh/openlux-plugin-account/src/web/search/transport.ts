/**
 * What one way of retrieving the web looks like, and why there is more than one.
 *
 * ## The shape this copies
 *
 * Drawing and filming already answer "which model does this call use" the same
 * way: providers declare what they can claim, the route's own catalogue says
 * what is servable right now, and the delivered default decides when it can do
 * the job (`media/image/registry.ts`, `media/video/registry.ts`). Search is the
 * fourth case of that shape. The one thing it adds is that a *transport* here is
 * a genuinely different wire format per vendor family, so the claim is not a
 * cosmetic grouping — sending the wrong family's request shape is the failure
 * mode this file exists to make impossible.
 *
 * ## Why the platform's own 「联网」tag cannot be the judgement
 *
 * The obvious lever is the catalogue's capability tag, and the old Electron
 * shell used exactly that (`src/main/model-capabilities.ts`, retired with it).
 * Measured on the live route 2026-08-24, that lever is wrong in both directions:
 *
 * - Of the 6 rows tagged 「联网」/「搜索」, 4 are the `*-search-preview` family
 *   and every one of them now answers *「has been deprecated」*. The tag outlived
 *   the models.
 * - The two families that actually retrieve today carry no such tag at all.
 *   `claude-haiku-4-5-20251001` is tagged 「对话,识图,思考,工具」 and returns 10
 *   structured results in 2.4s; `gemini-3.1-flash-lite` is tagged
 *   「对话,工具,识图」 and retrieves in 4.6s.
 *
 * So a tag-driven picker refuses the best transport and prefers four dead
 * models. What survives contact with the route is the **endpoint type** — the
 * same judgement the image and video registries settled on for the same reason.
 *
 * ## Why "answered something" is not success
 *
 * One reading decides this: `deepseek-v4-flash` accepts the Messages request
 * *with* the native search tool, answers HTTP 200 in 4.7s, and returns a single
 * `text` block — no search, no sources, full price. A transport therefore only
 * succeeds when it hands back at least one citeable source; prose alone is a
 * failure to be degraded past, not an answer. Upstream's own provider takes the
 * same position ("absence of those blocks is an error rather than a
 * prose-scraping fallback", `dsh-web-search-deepseek/lib/types/provider.d.ts:3`).
 *
 * @module openlux-plugin-account/web/search/transport
 */

import type { Context } from '@deepseek-ai/cordis'
import type { WebSearchResult } from '@deepseek-ai/dsh-web'

/** One `/v1/models` row, narrowed to the fields a claim may read. */
export interface SearchCatalogRow {
  readonly id: string
  /** `supported_endpoint_types`; the stable part of a row. */
  readonly types: readonly string[]
  /** `tags`, split from the route's comma-separated string. Read for diagnosis, not for claims. */
  readonly tags: readonly string[]
  /** `model_type`, e.g. 对话 / 图像 / 检索. */
  readonly modelType: string
}

/** Everything one attempt needs; the transport owns nothing across calls. */
export interface SearchAttempt {
  readonly ctx: Context
  /** Console origin without a trailing slash or `/v1`. */
  readonly base: string
  readonly token: string
  /** The model this attempt spends a turn on. */
  readonly model: string
  readonly query: string
  /** The seam's own bound; a transport may pass it upstream as a cost control. */
  readonly maxResults?: number
  readonly signal?: AbortSignal
}

/**
 * One attempt failed, with the one bit the loop above needs to decide what next.
 *
 * `rateLimited` is separated from every other failure because the two call for
 * opposite moves: a refused or dead model is answered by trying a different
 * one, while a throttled route is answered by waiting. Both were measured on
 * this route — the deprecated families refuse instantly, and 429 on a live model
 * clears after about three seconds.
 */
export class SearchAttemptError extends Error {
  constructor(message: string, readonly rateLimited = false) {
    super(message)
    this.name = 'SearchAttemptError'
  }
}

/** One vendor family's way of retrieving the web. */
export interface SearchTransport {
  /** Stable id, used in logs and in the ranking below. */
  readonly id: string
  /**
   * Whether this transport can drive that catalogue row.
   *
   * Claims must not overlap: a row two transports want is a bug to fix here
   * rather than a precedence to tune, exactly as on the image side.
   */
  claims(row: SearchCatalogRow): boolean
  /**
   * Names measured to actually retrieve through this transport, best first.
   *
   * Same contract as `ImageProvider.fallbackModels`: a compiled name may
   * **rank**, never **decide**. It is consulted only after the catalogue has
   * said what is servable, so deleting an entry costs a preference and nothing
   * else, and a key without any of these names still searches with whatever the
   * route does carry.
   */
  readonly provenModels: readonly string[]
  /**
   * Run one search on one model.
   * @param attempt - route, credential, model, and query for this one call.
   * @returns the normalized result, carrying at least one source.
   * @throws {SearchAttemptError} when this model did not retrieve.
   */
  search(attempt: SearchAttempt): Promise<WebSearchResult>
}

/**
 * Budget for one attempt.
 *
 * Measured today: 2.4s (claude haiku), 4.6s (gemini flash-lite), 7.0s (claude
 * sonnet), 8.7s (gpt-5-search-api). The ceiling is the retired shell's own 90s,
 * which was set from a 31s worst case — an order of magnitude of headroom over
 * anything seen since, and the loop tries the next candidate rather than
 * spending it twice.
 */
export const ATTEMPT_TIMEOUT_MS = 90_000

/** Room for the answering turn; unused tokens are not billed. */
export const ATTEMPT_MAX_TOKENS = 1_200

/**
 * Whether a failure reads like throttling rather than refusal.
 *
 * Matched on text because the shape is not ours to control: the route wraps an
 * upstream refusal in its own envelope, and this key has seen a *deprecated*
 * model answered under HTTP 429 (2026-08-24). So the status code alone would
 * both over- and under-report, while the sentence the route writes is the thing
 * that actually distinguishes "wait" from "try another model".
 * @param status - HTTP status, when the caller owns the response.
 * @param detail - the route's own message.
 * @returns true when waiting is the right answer.
 */
export function readsAsRateLimit(status: number, detail: string): boolean {
  if (/deprecat/i.test(detail)) return false
  if (/rate.?limit|too many requests|过于频繁|请求频繁|限流|超过.*频率/i.test(detail)) return true
  return status === 429
}
