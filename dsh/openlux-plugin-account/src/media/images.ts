/**
 * Turning one prompt into image bytes on the OpenLux route.
 *
 * The console's `/v1/images/generations` is OpenAI-shaped, but three of its
 * behaviours are ours to absorb rather than assume away. All three are read off
 * the gateway's own source, not its documentation:
 *
 * - **Both carriers arrive.** `response_format` normalization is best-effort:
 *   the gateway converts a returned URL to base64 (or the reverse) only for a
 *   short whitelist, and a conversion that fails passes the *other* carrier
 *   through with a warning rather than failing the call
 *   (`service/image_normalize.go`, "任何一条加工失败都降级为原样透传"). So a
 *   caller that asks for base64 can still be handed a URL. This module reads
 *   whichever arrived and therefore sends no `response_format` at all — for a
 *   model outside that whitelist the field is forwarded upstream verbatim,
 *   where an unknown parameter is a rejected request.
 * - **The endpoint is not universal.** A catalogued image model can still be
 *   unroutable here: `gemini-2.5-flash-image-preview` answers HTTP 503 with
 *   "无可用渠道（distributor）" and the list of every group that lacks a channel
 *   for it, in under a second. The refusal is legible, but it is the user's
 *   money's worth of round trip either way, so the default model is pinned to
 *   one this route genuinely serves (see `media/tool.ts`) and the model never
 *   gets to choose it.
 * - **The media type must be earned.** The attachment store fully decodes the
 *   bytes and refuses a declaration that disagrees with them
 *   (`attachment-local/src/store.ts`: `IMAGE_TYPE_MISMATCH`), so the type is
 *   sniffed from the bytes instead of taken from a header or a URL suffix.
 * - **It stalls sometimes, and that is the channel pool, not the request.** The
 *   default model answers in 10–15 seconds, until a window arrives where
 *   nothing comes back at all: two calls minutes apart each returned nothing
 *   for 200 seconds, and the next one was fast again. The gateway's own
 *   consumption log has **no row** for the stalled ones — it never finished them
 *   — while the same window is full of other tokens' rows reading
 *   「当前分组上游负载已饱和」 with `use_time` up to 1287 seconds. So a stall is
 *   the upstream group being saturated, and there is nothing here to fix: no
 *   retry of ours beats the gateway's own failover. This product's openclaw-era
 *   plugin waited 300 seconds on this endpoint
 *   (`resources/yunwu-video-plugin/index.mjs` `IMAGE_TIMEOUT_MS`); the budget
 *   below is shorter because a saturated group outlasts any wait worth holding a
 *   conversation turn for, so the useful move is to hand control back and say
 *   that trying again usually works — which it does.
 *
 * @module openlux-plugin-account/media/images
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { HttpReply } from '../account/http.ts'
import { AccountRequestError, normalizeBase, requestBytes, requestJson } from '../account/http.ts'
import type { ConsoleAccess } from '../market/console.ts'

/**
 * Budget for one attempt, and why there are two of them.
 *
 * Successes measured on the default model land between 9 and 15 seconds, and a
 * stalled attempt does not recover inside any budget worth holding a turn for —
 * the gateway's own log carries `use_time` past 1200 seconds for the saturated
 * ones. So waiting longer buys nothing, while attempting again buys everything:
 * a stalled call followed immediately by the byte-identical one answered in 11
 * seconds, because each attempt is routed to a channel afresh.
 *
 * Two 90-second attempts therefore beat one 180-second wait at both ends — the
 * common stall recovers in about 100 seconds instead of failing at 180, and the
 * hopeless case gives up no later than it did.
 */
const GENERATE_TIMEOUT_MS = 90_000

/** Budget for pulling one returned URL; the bytes are already generated. */
const TRANSFER_TIMEOUT_MS = 60_000

/** Raised when no usable image came back; the message is model-facing. */
export class ImageGenerationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageGenerationError'
  }
}

/** One generated image, ready for the attachment store. */
export interface GeneratedImageBytes {
  readonly data: Uint8Array
  /** Sniffed from the bytes, never from what the response claimed. */
  readonly mediaType: ImageMediaType
  /** The prompt the upstream says it actually used, when it rewrote ours. */
  readonly revisedPrompt?: string
}

/** What one generation asks for. */
export interface GenerateImagesRequest {
  readonly model: string
  readonly prompt: string
  readonly n: number
  /** Forwarded only when present: every model family validates it differently. */
  readonly size?: string
  /** Per-image ceiling, taken from the attachment service's own limit. */
  readonly maxBytes: number
}

/** File signatures of the four formats the attachment store accepts. */
const SIGNATURES: readonly { readonly type: ImageMediaType; readonly test: (data: Uint8Array) => boolean }[] = [
  { type: 'image/png', test: data => starts(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { type: 'image/jpeg', test: data => starts(data, [0xff, 0xd8, 0xff]) },
  { type: 'image/gif', test: data => starts(data, [0x47, 0x49, 0x46, 0x38]) },
  // RIFF container with a WEBP form type; the four bytes between are the size.
  { type: 'image/webp', test: data => starts(data, [0x52, 0x49, 0x46, 0x46]) && starts(data.subarray(8), [0x57, 0x45, 0x42, 0x50]) },
]

/** Whether these bytes begin with this signature. */
function starts(data: Uint8Array, signature: readonly number[]): boolean {
  if (data.byteLength < signature.length) return false
  return signature.every((byte, index) => data[index] === byte)
}

/**
 * Identify the format of generated bytes.
 * @param data - the complete encoded image.
 * @returns the media type, or undefined when it is not one of the four.
 */
export function sniffImageType(data: Uint8Array): ImageMediaType | undefined {
  return SIGNATURES.find(entry => entry.test(data))?.type
}

/** The response body, as far as this module reads it. */
interface ImagesResponse {
  readonly data?: readonly {
    readonly url?: unknown
    readonly b64_json?: unknown
    readonly revised_prompt?: unknown
  }[]
  readonly error?: { readonly message?: unknown; readonly code?: unknown; readonly type?: unknown }
  readonly message?: unknown
}

/**
 * Generate images and return their bytes.
 *
 * Partial success is success: a request for four images that yields three
 * usable ones returns those three, and the reasons for the fourth ride the
 * `failures` list so the model can decide whether to ask again. Only an empty
 * result is an error.
 * @param ctx - host context.
 * @param access - route origin and token reader.
 * @param request - what to generate.
 * @param signal - caller cancellation, forwarded to every request.
 * @returns the usable images and one line per image that was not usable.
 * @throws {ImageGenerationError} when the route refused, or nothing usable arrived.
 */
export async function generateImages(
  ctx: Context,
  access: ConsoleAccess,
  request: GenerateImagesRequest,
  signal?: AbortSignal,
): Promise<{ readonly images: readonly GeneratedImageBytes[]; readonly failures: readonly string[] }> {
  const token = await access.apiKey()
  if (token === undefined || token === '') {
    throw new ImageGenerationError('当前没有可用的 OpenLux 密钥，请先在侧栏登录账号。')
  }
  const url = `${normalizeBase(access.baseUrl)}/v1/images/generations`
  const body: Record<string, unknown> = {
    model: request.model,
    prompt: request.prompt,
    n: request.n,
    ...request.size === undefined ? {} : { size: request.size },
  }

  const post = async (): Promise<HttpReply> => await requestJson(ctx, url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, GENERATE_TIMEOUT_MS, signal)

  let reply: HttpReply
  try {
    reply = await post()
  } catch (error: unknown) {
    // Only a stall is attempted again: a refusal is deterministic, and asking a
    // second time would just spend the user's latency to be told the same thing.
    if (!(error instanceof AccountRequestError) || error.kind !== 'timeout') {
      throw new ImageGenerationError(error instanceof AccountRequestError
        ? error.message
        : `出图请求失败：${error instanceof Error ? error.message : String(error)}`)
    }
    ctx.logger.warn(`openlux: image generation stalled past ${String(GENERATE_TIMEOUT_MS)}ms; attempting once more`)
    try {
      reply = await post()
    } catch (retryError: unknown) {
      if (retryError instanceof AccountRequestError && retryError.kind === 'timeout') {
        throw new ImageGenerationError(
          `出图接口两次都没有在 ${String(Math.round(GENERATE_TIMEOUT_MS / 1000))} 秒内返回（正常 10~15 秒）。`
          + '这是上游出图分组一时饱和，与提示词无关，隔一会儿再说一次就好。',
        )
      }
      throw new ImageGenerationError(retryError instanceof AccountRequestError
        ? retryError.message
        : `出图请求失败：${retryError instanceof Error ? retryError.message : String(retryError)}`)
    }
  }

  const answer = (reply.body ?? {}) as ImagesResponse
  if (!reply.response.ok) {
    // The gateway's refusals are the actionable half of this tool: an
    // unsupported size, an `n` above the model's cap, and an exhausted balance
    // all arrive here with text a user or a model can act on, so it is passed
    // through instead of being replaced by a status line.
    const detail = text(answer.error?.message) ?? text(answer.message) ?? ''
    throw new ImageGenerationError(detail === ''
      ? `出图接口返回 HTTP ${reply.response.status}。`
      : `出图接口拒绝了请求（HTTP ${reply.response.status}）：${detail}`)
  }

  const entries = Array.isArray(answer.data) ? answer.data : []
  if (entries.length === 0) {
    const detail = text(answer.error?.message) ?? text(answer.message)
    throw new ImageGenerationError(detail === undefined
      ? '出图接口返回了空的图片列表。'
      : `出图接口没有返回图片：${detail}`)
  }

  const images: GeneratedImageBytes[] = []
  const failures: string[] = []
  for (const [index, entry] of entries.entries()) {
    const label = `第 ${String(index + 1)} 张`
    try {
      const data = await carrierBytes(ctx, entry, request.maxBytes, signal)
      const mediaType = sniffImageType(data)
      if (mediaType === undefined) {
        failures.push(`${label}：返回的不是 PNG / JPEG / WebP / GIF（前 4 字节 ${hex(data)}），无法作为附件保存。`)
        continue
      }
      const revisedPrompt = text(entry.revised_prompt)
      images.push({ data, mediaType, ...revisedPrompt === undefined ? {} : { revisedPrompt } })
    } catch (error: unknown) {
      failures.push(`${label}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (images.length === 0) {
    throw new ImageGenerationError(`出图接口返回了 ${String(entries.length)} 条结果，但没有一条可用。`
      + `\n${failures.join('\n')}`)
  }
  return { images, failures }
}

/**
 * Read one response entry's bytes, from whichever carrier it used.
 * @param ctx - host context.
 * @param entry - one `data[]` element.
 * @param maxBytes - per-image ceiling.
 * @param signal - caller cancellation.
 * @returns the encoded image bytes.
 * @throws {Error} when the entry carries neither usable carrier, or is too large.
 */
async function carrierBytes(
  ctx: Context,
  entry: { readonly url?: unknown; readonly b64_json?: unknown },
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const encoded = text(entry.b64_json)
  if (encoded !== undefined) {
    // Four base64 characters carry three bytes; refusing on the encoded length
    // avoids materialising a body that was never going to be storable.
    if (Math.floor(encoded.length / 4) * 3 > maxBytes) {
      throw new Error(`返回的图片超过本机附件上限（约 ${size(Math.floor(encoded.length / 4) * 3)} > ${size(maxBytes)}），`
        + '请用更小的 size 重试。')
    }
    const data = Buffer.from(encoded, 'base64')
    if (data.byteLength === 0) throw new Error('返回的 base64 图片解不出内容。')
    return data
  }
  const link = text(entry.url)
  if (link === undefined) throw new Error('这条结果既没有 b64_json 也没有 url。')
  try {
    return await requestBytes(ctx, link, TRANSFER_TIMEOUT_MS, maxBytes, signal, '图片')
  } catch (error: unknown) {
    if (error instanceof AccountRequestError) throw new Error(error.message)
    throw error
  }
}

/** Read a response field that must be a non-empty string. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** The first four bytes, for a message about bytes nobody can identify. */
function hex(data: Uint8Array): string {
  return [...data.subarray(0, 4)].map(byte => byte.toString(16).padStart(2, '0')).join(' ')
}

/** Bytes as a short human-readable size. */
export function size(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
