/**
 * Models that search on their own and cite what they read.
 *
 * OpenAI's search models answer an ordinary chat-completions request and attach
 * their sources as `message.annotations[].url_citation`, each carrying a real
 * site URL and its page title. That is the same shape the seam wants
 * (`dsh-web/lib/types/types.d.ts:46`), so no scraping is involved and nothing
 * about the answer text has to be trusted to find the links.
 *
 * Measured on this route 2026-08-24: `gpt-5-search-api` 200 / 8.7s / 6
 * annotations, `gpt-5-search-api-2025-10-14` 200 / 7.4s / 11 — first citation
 * `https://openai.com/index/gpt-5-6/` with its title. Slower than Claude's
 * native tool and just as citeable, which is exactly why it ranks second.
 *
 * ## Why the claim is the route's tag here, and only here
 *
 * The other two transports claim by endpoint type, because a vendor's wire
 * format is a property of the vendor. This family is different: it is
 * OpenAI-format like half the catalogue, and what separates it is whether the
 * *model* retrieves by itself — which is precisely what the route's 「联网」/
 * 「搜索」tag asserts. So the tag is read as a claim of self-retrieval rather
 * than as a ranking, and it is allowed to be wrong: 4 of the 6 tagged rows are
 * the retired `*-search-preview` family, answering *「has been deprecated」*
 * today. They are claimed, tried after the proven names, and degraded past —
 * which costs one fast refusal and needs no compiled list of dead models in
 * here to go stale.
 *
 * @module openlux-plugin-account/web/search/openai-annotations
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
 * How the question is put.
 *
 * Two constraints, both measured by the retired shell and both still respected
 * here: never offer the model a way out ("say so if you find nothing" was taken
 * as an exit while the retrieved context was already in the prompt), and ask for
 * sources in the *user* message — the same request with that sentence in a
 * system message returned zero links from the Gemini family.
 * @param query - what the caller wants searched.
 * @returns the user message text.
 */
export function searchAsk(query: string): string {
  return `${query}\n\n请基于检索到的网页内容回答，并在每条结论后面附上来源网页的标题与可点击链接。`
}

export const openaiAnnotationsTransport: SearchTransport = {
  id: 'openai-annotations',

  claims(row: SearchCatalogRow): boolean {
    return row.types.includes('openai')
      && row.modelType === '对话'
      && row.tags.some(tag => tag === '联网' || tag === '搜索')
  },

  provenModels: ['gpt-5-search-api', 'gpt-5-search-api-2025-10-14'],

  async search(attempt: SearchAttempt): Promise<WebSearchResult> {
    const { ctx, base, token, model, query, signal } = attempt
    let reply
    try {
      reply = await requestJson(ctx, `${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: ATTEMPT_MAX_TOKENS,
          messages: [{ role: 'user', content: searchAsk(query) }],
        }),
      }, ATTEMPT_TIMEOUT_MS, signal)
    } catch (error: unknown) {
      if (error instanceof AccountRequestError && error.kind === 'cancelled') throw error
      throw new SearchAttemptError(`${model} 检索请求失败：${error instanceof Error ? error.message : String(error)}`)
    }

    const body = (reply.body ?? {}) as Record<string, unknown>
    if (!reply.response.ok) {
      const detail = messageOf(body)
      throw new SearchAttemptError(
        `${model} 拒绝了这次检索（HTTP ${String(reply.response.status)}）：${detail === '' ? '无说明' : detail}`,
        readsAsRateLimit(reply.response.status, detail),
      )
    }

    const message = ((body['choices'] as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined)?.['message'] as
      Record<string, unknown> | undefined
    const sources = citationsOf(message?.['annotations'])
    if (sources.length === 0) {
      // The model answered from memory. Prose with no citation is the outcome a
      // caller cannot tell from a real search, so it is a failure here.
      throw new SearchAttemptError(`${model} 这次没有给出任何来源，可能没有真的联网。`)
    }
    const content = typeof message?.['content'] === 'string' ? (message['content'] as string).trim() : ''
    return { ...content === '' ? {} : { content }, sources, truncated: false }
  },
}

/**
 * Read `annotations[]` into the seam's source shape.
 *
 * Only `url_citation` entries carry a source; other annotation types exist on
 * this wire and are skipped rather than guessed at. Deduped by url because one
 * page cited twice is one source.
 * @param value - `message.annotations`, in whatever shape it arrived.
 * @returns the citeable sources, in the order the model cited them.
 */
function citationsOf(value: unknown): readonly WebSearchSource[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const entry of value as readonly unknown[]) {
    const citation = (entry as Record<string, unknown> | null)?.['url_citation'] as Record<string, unknown> | undefined
    const url = typeof citation?.['url'] === 'string' ? (citation['url'] as string).trim() : ''
    if (url === '' || seen.has(url)) continue
    seen.add(url)
    const title = typeof citation?.['title'] === 'string' ? (citation['title'] as string).trim() : ''
    sources.push({ url, ...title === '' ? {} : { title } })
  }
  return sources
}

/** `error.message` from an OpenAI-shaped failure body. */
function messageOf(body: Record<string, unknown>): string {
  const error = body['error']
  if (typeof error === 'string') return error.trim()
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>)['message']
    if (typeof message === 'string') return message.trim()
  }
  return typeof body['message'] === 'string' ? (body['message'] as string).trim() : ''
}
