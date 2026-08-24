/**
 * Claude's own server-side search, on our route.
 *
 * The mechanism is not ours and is not invented here: upstream's
 * `dsh-web-search-deepseek` searches by sending an Anthropic Messages request
 * carrying the native `web_search_20250305` server tool, and our composition
 * already re-points that provider at this account's route
 * (`dsh-plugin-desktop/cordis.patch.yml`'s `web-search-deepseek` row). This file
 * is the same wire format with one model per attempt, and its reply handling
 * follows that package's three judgements verbatim
 * (`dsh-web-search-deepseek/lib/index.js:42-83`):
 *
 * 1. **A reply with no `web_search_tool_result` block is a failure**, not an
 *    invitation to read links out of the prose. Measured 2026-08-24: the same
 *    request to `deepseek-v4-flash` answers HTTP 200 in 4.7s with a single text
 *    block — a silent non-search at full price.
 * 2. **Snippets come from the `text` blocks' `citations[]`, keyed by url.** The
 *    result items themselves carry url / title / `page_age` and no excerpt, so
 *    an adapter that only walks the result blocks throws the quotes away.
 * 3. **Sources dedupe by url**, because `max_uses > 1` surfaces the same page
 *    from two searches.
 *
 * What is ours is the plumbing that a package built to call exactly one model
 * has no reason to carry: a deadline (upstream calls `fetch` with the caller's
 * signal and nothing else, so a stalled route would hold the tool call open for
 * as long as a model turn), and a refusal classified well enough for the loop
 * above to choose between waiting and trying another vendor. Calling their class
 * instead would have handed both of those up along with a dependency on that
 * plugin package and its own peers — a lot of edge for twenty lines of JSON
 * walking.
 *
 * Measured on this route 2026-08-24: `claude-haiku-4-5-20251001` 200 / 2.4s / 10
 * results, `claude-sonnet-4-5-20250929` 200 / 7.0s / 10, `claude-opus-4-8` 200 /
 * 7.3s / 10 — all carrying url + title + `page_age`.
 *
 * @module openlux-plugin-account/web/search/claude-native
 */

import type { WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import { AccountRequestError, requestJson } from '../../account/http.ts'
import {
  ATTEMPT_MAX_TOKENS,
  ATTEMPT_TIMEOUT_MS,
  readsAsRateLimit,
  SearchAttemptError,
  type SearchAttempt,
  type SearchCatalogRow,
  type SearchTransport,
} from './transport.ts'

/**
 * How many times the model may search within one call.
 *
 * Upstream defaults to 5 and each use is billed. Two is enough for the single
 * question this seam asks — the readings above returned ten results from one use
 * — and the seam truncates to the caller's `maxResults` afterwards anyway.
 */
const MAX_USES = 2

/** `anthropic-version` this route accepts; upstream's default value. */
const API_VERSION = '2023-06-01'

export const claudeNativeTransport: SearchTransport = {
  id: 'claude-native',

  /**
   * Claude rows, judged by endpoint type and by vendor.
   *
   * The type alone is not enough: this route carries non-Claude models that also
   * accept `anthropic` (a reseller channel translating for DeepSeek is exactly
   * how the silent non-search above happened), while the native server tool is
   * Anthropic's own rather than the format's.
   */
  claims(row: SearchCatalogRow): boolean {
    return row.types.includes('anthropic') && row.id.toLowerCase().startsWith('claude')
  },

  // The measured order: haiku returns the same ten results three times quicker
  // than the other two, so an unnamed search should land on it.
  provenModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929', 'claude-opus-4-8'],

  async search(attempt: SearchAttempt): Promise<WebSearchResult> {
    const { ctx, base, token, model, query, signal } = attempt
    let reply
    try {
      reply = await requestJson(ctx, `${base}/v1/messages`, {
        method: 'POST',
        headers: {
          // Both, as upstream sends both: the route accepts the bearer form and
          // an Anthropic-compatible upstream expects `x-api-key`.
          'x-api-key': token,
          'Authorization': `Bearer ${token}`,
          'anthropic-version': API_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: ATTEMPT_MAX_TOKENS,
          messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }] }],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_USES }],
        }),
      }, ATTEMPT_TIMEOUT_MS, signal)
    } catch (error: unknown) {
      // A cancelled search is the caller's decision and must not read as this
      // model failing, or the loop would spend the remaining candidates on a
      // request nobody is waiting for.
      if (error instanceof AccountRequestError && error.kind === 'cancelled') throw error
      throw new SearchAttemptError(`${model} 检索请求失败：${error instanceof Error ? error.message : String(error)}`)
    }

    const body = (reply.body ?? {}) as Record<string, unknown>
    if (!reply.response.ok) {
      const detail = detailOf(body)
      throw new SearchAttemptError(
        `${model} 拒绝了这次检索（HTTP ${String(reply.response.status)}）：${detail === '' ? '无说明' : detail}`,
        readsAsRateLimit(reply.response.status, detail),
      )
    }

    const blocks = Array.isArray(body['content']) ? (body['content'] as readonly unknown[]) : []
    const sources = sourcesIn(blocks)
    if (sources.length === 0) {
      throw new SearchAttemptError(`${model} 没有真的联网检索：这次的回复里没有任何检索结果块。`)
    }
    const content = answerIn(blocks)
    return { ...content === '' ? {} : { content }, sources, truncated: false }
  },
}

/** One content block, as far as this module reads it. */
interface Block {
  readonly type?: unknown
  readonly text?: unknown
  readonly content?: unknown
  readonly citations?: unknown
}

/**
 * The sources of one reply: result blocks joined to their citation excerpts.
 * @param blocks - the reply's content blocks.
 * @returns deduped sources; empty when the reply carried no search at all.
 */
function sourcesIn(blocks: readonly unknown[]): readonly WebSearchSource[] {
  const snippets = snippetsIn(blocks)
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const raw of blocks) {
    const block = raw as Block | null
    if (block?.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue
    for (const item of block.content as readonly unknown[]) {
      const result = item as { readonly type?: unknown; readonly url?: unknown; readonly title?: unknown; readonly page_age?: unknown } | null
      if (result?.type !== 'web_search_result') continue
      const url = text(result.url)
      if (url === '' || seen.has(url)) continue
      seen.add(url)
      const title = text(result.title)
      const snippet = snippets.get(url) ?? ''
      const publishedAt = text(result.page_age)
      sources.push({
        url,
        ...title === '' ? {} : { title },
        ...snippet === '' ? {} : { snippet },
        ...publishedAt === '' ? {} : { publishedAt },
      })
    }
  }
  return sources
}

/**
 * `url → cited_text` from every text block's citations.
 *
 * First occurrence wins, as upstream does: a page quoted twice is one source
 * and the first quote is the one the answer was built on.
 * @param blocks - the reply's content blocks.
 * @returns the excerpt map, empty when the model cited nothing inline.
 */
function snippetsIn(blocks: readonly unknown[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const raw of blocks) {
    const block = raw as Block | null
    if (block?.type !== 'text' || !Array.isArray(block.citations)) continue
    for (const entry of block.citations as readonly unknown[]) {
      const citation = entry as { readonly url?: unknown; readonly cited_text?: unknown } | null
      const url = text(citation?.url)
      const cited = text(citation?.cited_text)
      if (url === '' || cited === '' || map.has(url)) continue
      map.set(url, cited)
    }
  }
  return map
}

/** The prose the model wrote around its search, joined in order. */
function answerIn(blocks: readonly unknown[]): string {
  return blocks
    .map(raw => (raw as Block | null)?.type === 'text' ? text((raw as Block).text) : '')
    .filter(part => part !== '')
    .join('\n')
    .trim()
}

/** A trimmed string, or empty. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** The route's own explanation for a refusal, wherever it put it. */
function detailOf(body: Record<string, unknown>): string {
  const error = body['error']
  if (typeof error === 'string') return error.trim()
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>)['message']
    if (typeof message === 'string') return message.trim()
  }
  return text(body['message'])
}
