/**
 * Google Search grounding, reached through the OpenAI-compatible endpoint.
 *
 * The route translates a function tool named `googleSearch` into Gemini's own
 * grounding request (`new-yunwu-api/relay/channel/gemini/relay-gemini.go:390-431`),
 * so this is a chat-completions call with one extra tool declaration. Sending
 * that tool to a non-Gemini model is not a no-op — it is the other family's
 * convention — which is why the claim is by endpoint type and not by tag.
 *
 * ## Why it ranks last, and is kept anyway
 *
 * Measured on this route 2026-08-24: `gemini-3.1-flash-lite` 200 / 4.6s with 14
 * links in a 1967-character answer, `gemini-2.5-flash` 200 / 5.9s with 15. Fast
 * and it really retrieves — but the links are Google's redirect shells
 * (`vertexaisearch.cloud.google.com/grounding-api-redirect/...`), there are no
 * titles, and `annotations[]` is empty, so the sources have to be read out of
 * the prose. Since `dsh-tool-web` renders `title ?? hostname(url)`, a reader
 * sees a column of identical `vertexaisearch.cloud.google.com` entries.
 *
 * That is a worse citation than either other transport and better than no
 * search at all, which is the only situation this transport is ever reached in:
 * it runs when the account has no Claude channel and no self-searching OpenAI
 * model. The answer text it produces is genuine retrieved content, and that
 * lands in `content` where it is useful regardless of how the links read.
 *
 * @module openlux-plugin-account/web/search/gemini-grounding
 */

import type { WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import { AccountRequestError, requestJson } from '../../account/http.ts'
import { searchAsk } from './openai-annotations.ts'
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
 * Links in prose, in order of appearance.
 *
 * The terminators include the CJK punctuation this answer arrives wrapped in;
 * a URL followed by 。 or ） would otherwise carry it into the source list.
 */
const LINK = /https?:\/\/[^\s)»"'，。、；）】]+/g

export const geminiGroundingTransport: SearchTransport = {
  id: 'gemini-grounding',

  claims(row: SearchCatalogRow): boolean {
    return row.types.includes('gemini') && row.modelType === '对话'
  },

  // Both measured today. Flash-lite first: same retrieval, 1.3s quicker.
  provenModels: ['gemini-3.1-flash-lite', 'gemini-2.5-flash'],

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
          tools: [{ type: 'function', function: { name: 'googleSearch' } }],
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
    const content = typeof message?.['content'] === 'string' ? (message['content'] as string).trim() : ''
    const sources = linksIn(content)
    if (sources.length === 0) {
      // Without grounding this model answers the same question from memory, in
      // the same shape, and the absence of links is the only thing that tells
      // the two apart.
      throw new SearchAttemptError(`${model} 这次的回答里没有任何来源链接，可能没有触发联网检索。`)
    }
    return { content, sources, truncated: false }
  },
}

/**
 * Sources from the answer text.
 *
 * No title is invented for them: the seam allows a URL-only source precisely so
 * an adapter does not have to lie (`dsh-web/lib/types/types.d.ts:41-44`), and a
 * fabricated title on a redirect URL would be the lie.
 * @param content - the answer text.
 * @returns deduped sources, in the order they appear.
 */
function linksIn(content: string): readonly WebSearchSource[] {
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const url of content.match(LINK) ?? []) {
    const trimmed = url.replace(/[.,;:!?]+$/u, '')
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    sources.push({ url: trimmed })
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
