/**
 * The Gemini image family, which draws on the **chat** endpoint.
 *
 * ## Why these six models are not on `/v1/images/generations`
 *
 * They are the reason this whole registry exists. On this route the
 * `gemini-*-image*` models carry endpoint types `["gemini","openai"]` — the same
 * pair every text model carries — and a request for one on the image endpoint is
 * refused with HTTP 503 「无可用渠道（distributor）」 in under a second, listing
 * every group that has no channel for it. The gateway does have an
 * images-generations adapter for Gemini (`relay/channel/gemini/adaptor.go` maps
 * `size` to `aspectRatio`), but no channel is registered against that endpoint
 * type for these ids, so the working path is the one the models are actually
 * sold on: `POST /v1/chat/completions`, with the picture arriving inside the
 * assistant's own message as a base64 data URI.
 *
 * Verified live on 2026-08-21 with this key: `gemini-2.5-flash-image` answered in
 * about 10 seconds with a 1.8 MB PNG, and `gemini-3-pro-image` in about 19
 * seconds with a JPEG. Same prompt, different formats — which is why the bytes,
 * not the declaration, decide the media type downstream.
 *
 * ## Why the shape is a knob and the count is not
 *
 * `extra_body.google.image_config.aspectRatio` is forwarded to Gemini's
 * `generationConfig.imageConfig` verbatim (`relay/channel/gemini/relay-gemini.go`
 * reads `extra_body.google.image_config`), and Google's own model pages list
 * `1:1`, `16:9` and `9:16` among the supported ratios for both the 2.5 and 3.x
 * image models — so all three shapes this tool offers map straight through.
 * `imageSize` (1K/2K/4K) is deliberately not sent: only the 3.x pages document it,
 * and nothing in this tool's vocabulary asks for a resolution.
 *
 * There is no count field on this path at all. The model decides how many
 * pictures its one reply carries, so a request for four is answered honestly
 * with however many arrived plus a note, rather than by firing four paid calls
 * the caller did not ask for.
 *
 * @module openlux-plugin-account/media/image/gemini
 */

import { AccountRequestError, requestJson } from '../../account/http.ts'
import { OPENAI_IMAGE_ENDPOINT_TYPES } from './openai.ts'
import {
  aspectOf,
  ImageGenerationError,
  object,
  text,
  type ImageCarrier,
  type ImageCatalogRow,
  type ImageOutcome,
  type ImageProvider,
  type ImageRequest,
  type ImageWire,
} from './provider.ts'

/**
 * Budget for one call.
 *
 * Measured 10 s (2.5 flash) and 19 s (3 pro). A thinking image model on a busy
 * group takes noticeably longer than a plain one, so this is generous; there is
 * no second attempt because unlike the images endpoint, a stall here is not the
 * failure mode that was observed.
 */
const CHAT_TIMEOUT_MS = 150_000

/** How much of a picture-free answer to quote back. */
const EXCERPT_CHARS = 300

/** A base64 picture inside the assistant's markdown. */
const DATA_URI = /data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)/giu

/** A linked picture inside the assistant's markdown. */
const LINKED = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/giu

export const geminiImageProvider: ImageProvider = {
  id: 'gemini-chat',
  // Nothing is claimed by type: `gemini` is every Gemini model's type, text
  // ones included, so the judgement is the whole row (see `claims`).
  endpointTypes: [],
  // Two names that have drawn on this path, for the case where the catalogue
  // cannot be read at all. Not the whole family: an unverified name here would
  // route a paid request on a guess.
  fallbackModels: ['gemini-2.5-flash-image', 'gemini-3-pro-image'],
  variesCount: false,
  variesSize: true,

  /**
   * Three conditions, and each one is load-bearing.
   *
   * `model_type` is the platform's own bucket, so `图像` separates these from
   * the 280-odd chat models that share their endpoint types. The `绘画` tag
   * separates a generator from an image *reader*. And carrying none of the
   * OpenAI-compatible image types is what keeps this from claiming a row that
   * `media/image/openai.ts` serves better — stated here rather than left to the
   * order the registry happens to visit providers in.
   * @param row - one catalogue row.
   * @returns whether this provider draws with it.
   */
  claims(row: ImageCatalogRow): boolean {
    return row.types.includes('gemini')
      && row.modelType === '图像'
      && row.tags.includes('绘画')
      && !row.types.some(type => OPENAI_IMAGE_ENDPOINT_TYPES.includes(type))
  },

  /**
   * The whole family edits, because on this path editing is not a second route.
   *
   * A row that draws here does so by being asked in a chat message, and a chat
   * message can carry a picture. Adding one `image_url` part to the same request
   * is the entire difference — verified 2026-08-21 against
   * `gemini-2.5-flash-image`: 200 in 27.5 s, `prompt_tokens` 277 (a text-only
   * ask on this path is under 40), and the returned picture kept the source's
   * layout, table and framing with only the requested change made.
   *
   * So this answers for every row `claims` took, rather than consulting the
   * endpoint types: those are `["gemini","openai"]` for the whole family and say
   * nothing about editing either way.
   * @returns true, for any row this provider already claimed.
   */
  edits(): boolean {
    return true
  },

  async generate(wire: ImageWire, request: ImageRequest): Promise<ImageOutcome> {
    const aspect = aspectOf(request.size)
    const reference = request.reference
    const content = reference === undefined
      ? request.prompt
      : [
          { type: 'text', text: request.prompt },
          {
            type: 'image_url',
            image_url: { url: `data:${reference.mediaType};base64,${Buffer.from(reference.data).toString('base64')}` },
          },
        ]
    let reply
    try {
      reply = await requestJson(wire.ctx, `${wire.base}/chat/completions`, {
        method: 'POST',
        headers: wire.headers,
        body: JSON.stringify({
          model: request.model,
          messages: [{ role: 'user', content }],
          ...aspect === undefined ? {} : { extra_body: { google: { image_config: { aspectRatio: aspect } } } },
        }),
      }, CHAT_TIMEOUT_MS, wire.signal)
    } catch (error: unknown) {
      throw new ImageGenerationError(error instanceof AccountRequestError
        ? error.message
        : `出图请求失败：${error instanceof Error ? error.message : String(error)}`)
    }

    const answer = object(reply.body) ?? {}
    if (!reply.response.ok) {
      const detail = text(object(answer['error'])?.['message']) ?? text(answer['message']) ?? ''
      throw new ImageGenerationError(detail === ''
        ? `出图接口返回 HTTP ${String(reply.response.status)}。`
        : `出图接口拒绝了请求（HTTP ${String(reply.response.status)}）：${detail}`)
    }

    const message = object(object((answer['choices'] as unknown[] | undefined)?.[0])?.['message'])
    const body = flatten(message?.['content'])
    const carriers = harvest(body, wire.maxBytes)
    if (carriers.length === 0) {
      // This model answering in words is a real outcome, not a parse failure:
      // it is a chat model that happens to draw, so it can decline, ask a
      // question, or describe what it would have drawn. Quoting it back is the
      // only way the caller learns which of those happened.
      throw new ImageGenerationError(body === ''
        ? `${request.model} 这次既没有返回图片也没有返回文字。`
        : `${request.model} 这次只回了文字、没有出图：${body.slice(0, EXCERPT_CHARS)}`)
    }

    const ignored: string[] = []
    if (request.count > 1) {
      ignored.push(`这条链路是对话式出图，一次只出一组，无法指定张数；`
        + `请求的 ${String(request.count)} 张实际拿到 ${String(carriers.length)} 张。`)
    }
    return { carriers, ignored }
  },
}

/**
 * Reduce a chat message's content to one searchable string.
 *
 * Verified live to be a plain string carrying markdown, but the OpenAI-shaped
 * content array is equally legal on this route and costs three lines to accept.
 * @param content - `message.content`, in whatever shape it arrived.
 * @returns the text to scan, possibly empty.
 */
function flatten(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    const entry = object(part)
    if (entry === undefined) continue
    const inline = text(entry['text'])
    if (inline !== undefined) parts.push(inline)
    const link = text(object(entry['image_url'])?.['url']) ?? text(entry['url'])
    if (link !== undefined) parts.push(link)
  }
  return parts.join('\n').trim()
}

/**
 * Pull every picture out of the assistant's own answer.
 * @param body - the message text.
 * @param maxBytes - per-image ceiling, applied before decoding.
 * @returns the pictures found, in the order they appear.
 */
function harvest(body: string, maxBytes: number): ImageCarrier[] {
  const carriers: ImageCarrier[] = []
  for (const match of body.matchAll(DATA_URI)) {
    const encoded = match[1]
    if (encoded === undefined) continue
    // Four base64 characters carry three bytes, so an unstorable picture is
    // refused before it is materialised.
    if (Math.floor(encoded.length / 4) * 3 > maxBytes) continue
    const data = Buffer.from(encoded, 'base64')
    if (data.byteLength > 0) carriers.push({ kind: 'bytes', data })
  }
  if (carriers.length > 0) return carriers
  // Only when no inline picture arrived: the gateway can be configured to hand
  // back a link instead of base64 (`GeminiImageRequest` carries a response-format
  // extension for exactly that), and a link plus a data URI in one answer would
  // otherwise count the same picture twice.
  for (const match of body.matchAll(LINKED)) {
    const url = match[1]
    if (url !== undefined) carriers.push({ kind: 'url', url })
  }
  return carriers
}
