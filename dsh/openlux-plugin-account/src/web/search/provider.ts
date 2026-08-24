/**
 * One web search, degrading down the delivered list.
 *
 * ## What this restores
 *
 * The retired Electron shell had this: a priority list of retrieval models, and
 * a loop that moved to the next one when a model refused, throttled, or answered
 * without retrieving (`resources/yunwu-video-plugin/index.mjs:3880-3924`). The
 * console page and the route have carried that promise the whole time, and the
 * new client never had a consumer for it — the delivered list was written into a
 * settings key upstream's own provider does not read, so every search ran on the
 * one model pinned in the composition and nothing degraded. This provider is the
 * consumer that was missing.
 *
 * ## What is deliberately different from the retired one
 *
 * - **The candidate list is not built from the platform's 「联网」tag.** That tag
 *   today marks four deprecated models and misses both families that actually
 *   work; the reasoning and the readings are in `transport.ts`.
 * - **A reply without sources is a failure.** The old loop accepted any non-empty
 *   answer, which a model that never searched produces just as readily.
 * - **The 429 wait is one retry of the whole list, not per model.** Rate limits
 *   on this route are per channel, so the cheaper answer is a different vendor
 *   first; sleeping is what is left when every vendor is throttled at once.
 *
 * ## Cost, because each attempt is a model turn
 *
 * Degrading is not free — it is a second and third billed call. So attempts are
 * bounded ({@link MAX_ATTEMPTS}), which also bounds how long the user waits: the
 * measured attempts run 2.4–8.7s, so the worst realistic path is under half a
 * minute rather than the full 476-row catalogue.
 *
 * @module openlux-plugin-account/web/search/provider
 */

import type { Context } from '@deepseek-ai/cordis'
import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult } from '@deepseek-ai/dsh-web'
import { AccountRequestError, normalizeBase } from '../../account/http.ts'
import type { ConsoleAccess } from '../../market/console.ts'
import { planSearch, type SearchCandidate } from './candidates.ts'
import { SearchAttemptError } from './transport.ts'

/** The id this provider registers under; `web.searchProvider` names it. */
export const OPENLUX_SEARCH_PROVIDER_ID = 'openlux-search'

/**
 * How many models one search may spend.
 *
 * Three covers the shape these failures actually have — a dead name, then a
 * throttled channel, then a working one — without turning a bad delivery into a
 * dozen billed turns.
 */
const MAX_ATTEMPTS = 3

/**
 * How long to wait before re-running the list once, when everything was throttled.
 *
 * Three seconds is the retired shell's measured figure: intermittent 429s on
 * this route cleared after one such wait (2026-08-14), and waiting longer inside
 * a tool call the user is watching is worse than reporting the failure.
 */
const RATE_LIMIT_WAIT_MS = 3_000

/** What the provider needs from the plugin around it. */
export interface SearchProviderOptions {
  /** Route origin and token reader; the same pair the media tools use. */
  readonly access: ConsoleAccess
  /** The console's priority list at call time, in its own order. */
  readonly models: () => readonly string[]
}

/** Search through the models this account was given, best first. */
class OpenLuxSearchProvider implements WebSearchProvider {
  readonly id = OPENLUX_SEARCH_PROVIDER_ID

  constructor(private readonly ctx: Context, private readonly options: SearchProviderOptions) {}

  /**
   * Whether this provider is worth selecting at all.
   *
   * Always, on purpose, and for the reason upstream's own provider states: the
   * credential is resolved per search, so a signed-out machine fails one call
   * with a sentence naming the problem. Reporting the capability as unavailable
   * instead would surface as `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` — a
   * misconfiguration message for what is really "please sign in" — and would
   * change the tool schema between sessions.
   * @returns true.
   */
  available(): boolean {
    return true
  }

  /**
   * Run one search, trying the delivered models in order.
   * @param request - the query and the seam's result bound.
   * @param signal - caller cancellation.
   * @returns the first result carrying at least one source.
   * @throws {WebError} when no candidate retrieved anything.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const query = request.query.trim()
    if (query === '') throw new WebError('检索词是空的。', 'WEB_PROVIDER_ERROR')

    const token = await this.options.access.apiKey()
    if (token === undefined || token === '') {
      throw new WebError('当前没有可用的 OpenLux 密钥，请先在侧栏登录账号。', 'WEB_PROVIDER_CREDENTIAL_MISSING')
    }
    const base = normalizeBase(this.options.access.baseUrl)
    const delivered = this.options.models()
    const plan = await planSearch(this.ctx, this.options.access, token, delivered, signal)
    if (plan.unusable.length > 0) {
      // Worth its own line: from the console side the entry looks configured,
      // and this is the only place that says it was skipped and why.
      this.ctx.logger.warn(`openlux: 下发的搜索模型无法用于检索，已跳过：${plan.unusable.join('、')}`)
    }
    if (plan.candidates.length === 0) {
      throw new WebError(
        '这个账号现在一个能联网检索的模型都没有。请让管理员在后台的「搜索」一栏配一个能联网的模型，'
        + '或者确认这把密钥的分组里有 Claude / Gemini / OpenAI 搜索模型的渠道。',
        'WEB_PROVIDER_UNAVAILABLE',
      )
    }

    const attempts = plan.candidates.slice(0, MAX_ATTEMPTS)
    const failures: string[] = []
    for (let round = 0; round < 2; round += 1) {
      let throttled = false
      for (const candidate of attempts) {
        try {
          return await this.attempt(candidate, { base, token, query, request, signal, blind: plan.blind })
        } catch (error: unknown) {
          // The caller went away; the remaining candidates would each cost a
          // billed turn for an answer nobody is waiting for.
          if (error instanceof AccountRequestError && error.kind === 'cancelled') {
            throw new WebError('检索已取消。', 'WEB_ABORTED', { cause: error })
          }
          if (signal?.aborted === true) throw new WebError('检索已取消。', 'WEB_ABORTED', { cause: error })
          const failure = error instanceof Error ? error.message : String(error)
          failures.push(failure)
          // Each step down is its own line. Degrading is invisible otherwise —
          // the search succeeds, nobody asks, and an operator's dead first
          // choice keeps costing a wasted call on every query. This is how that
          // gets noticed (measured: a retired `*-search-preview` entry refuses
          // in ~0.75s before the next candidate answers).
          this.ctx.logger.warn(`openlux: 检索候选 ${candidate.model} 没成，换下一个：${failure}`)
          if (error instanceof SearchAttemptError && error.rateLimited) throttled = true
        }
      }
      if (!throttled || round === 1) break
      // Every candidate was throttled rather than broken, so the list itself is
      // fine and waiting is the move.
      this.ctx.logger.warn(`openlux: 检索候选全部被限流，等 ${String(RATE_LIMIT_WAIT_MS / 1000)} 秒后重试一轮`)
      await wait(RATE_LIMIT_WAIT_MS, signal)
    }

    throw new WebError(
      `联网检索没有成功。试过 ${attempts.map(candidate => candidate.model).join('、')}：${failures.join('；')}`,
      'WEB_PROVIDER_ERROR',
    )
  }

  /** Run one candidate and log what it produced. */
  private async attempt(
    candidate: SearchCandidate,
    input: {
      readonly base: string
      readonly token: string
      readonly query: string
      readonly request: WebSearchRequest
      readonly signal: AbortSignal | undefined
      readonly blind: boolean
    },
  ): Promise<WebSearchResult> {
    const started = Date.now()
    const result = await candidate.transport.search({
      ctx: this.ctx,
      base: input.base,
      token: input.token,
      model: candidate.model,
      query: input.query,
      ...input.request.maxResults === undefined ? {} : { maxResults: input.request.maxResults },
      ...input.signal === undefined ? {} : { signal: input.signal },
    })
    // The one line that answers "which model did this search cost me", which is
    // the first question about any billed background call — and the evidence
    // that the delivered order was honoured.
    this.ctx.logger.info(`openlux: 检索用 ${candidate.model}（${candidate.transport.id}${input.blind ? '，目录读不到' : ''}）`
      + `，${String(result.sources.length)} 条来源，${String(Date.now() - started)}ms`)
    return result
  }
}

/**
 * Wait, but give up the moment the caller does.
 * @param ms - how long to wait.
 * @param signal - caller cancellation.
 */
async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Register this account's search provider with `ctx.web`.
 *
 * The seam resolves the provider per call and rejects duplicate ids, so
 * registering alongside upstream's `deepseek-official` is safe as long as the
 * composition names one — which it does (`cordis.patch.yml`'s `web` entry).
 * Leaving upstream's registered is deliberate: it stays as the escape hatch a
 * user layer can point back to.
 * @param ctx - a context that has `web`.
 * @param options - route access and the delivered priority list.
 */
export function registerSearchProvider(ctx: Context, options: SearchProviderOptions): void {
  ctx.web.registerSearchProvider(new OpenLuxSearchProvider(ctx, options))
}
