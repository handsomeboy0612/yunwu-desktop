/**
 * The OpenAI-compatible route: `POST /v1/images/generations`.
 *
 * The oldest of the three transports here and the one that serves most of the
 * catalogue. Four of its behaviours are ours to absorb rather than assume away,
 * all read off the gateway's own source rather than its documentation:
 *
 * - **Both carriers arrive.** `response_format` normalization is best-effort:
 *   the gateway converts a returned URL to base64 (or the reverse) only for a
 *   short whitelist, and a conversion that fails passes the *other* carrier
 *   through with a warning rather than failing the call
 *   (`service/image_normalize.go`, "任何一条加工失败都降级为原样透传"). So a
 *   caller that asks for base64 can still be handed a URL. This module sends no
 *   `response_format` at all and reads whichever arrived — for a model outside
 *   that whitelist the field is forwarded upstream verbatim, where an unknown
 *   parameter is a rejected request.
 * - **The endpoint is not universal.** A catalogued image model can still be
 *   unroutable here: the `gemini-*-image-*` family answers HTTP 503 with
 *   "无可用渠道（distributor）" in under a second, because on this route those
 *   models are served through the chat endpoint instead (`media/image/gemini.ts`).
 * - **A size it does not recognise is not refused, it hangs.** `size:
 *   '123x456'` returned nothing for a full 180-second budget while a standard
 *   value answered in about 15 seconds; `relay/valid_request.go` validates only
 *   `n` and reads `size` straight through with no enum. So the guard is the
 *   tool's own enum, not this route's.
 * - **It stalls sometimes, and that is the channel pool.** Two calls minutes
 *   apart each returned nothing for 200 seconds and the next was fast again,
 *   with no consumption row for the stalled ones while the same window was full
 *   of other tokens' rows reading 「当前分组上游负载已饱和」 with `use_time` up
 *   to 1287 seconds. Hence two short attempts rather than one long wait: each
 *   attempt is routed afresh, so attempting again buys everything that waiting
 *   longer does not.
 *
 * @module openlux-plugin-account/media/image/openai
 */

import { AccountRequestError, requestJson, type HttpReply } from '../../account/http.ts'
import {
  ImageGenerationError,
  text,
  type ImageCarrier,
  type ImageOutcome,
  type ImageProvider,
  type ImageRequest,
  type ImageWire,
} from './provider.ts'

/**
 * Budget for one attempt, and why there are two of them.
 *
 * Successes on the default model land between 9 and 15 seconds, and a stalled
 * attempt does not recover inside any budget worth holding a turn for. Two
 * 90-second attempts beat one 180-second wait at both ends: the common stall
 * recovers in about 100 seconds instead of failing at 180, and the hopeless case
 * gives up no later than it did.
 */
const GENERATE_TIMEOUT_MS = 90_000

/**
 * Endpoint types that resolve to `/v1/images/generations`.
 *
 * These four strings are the judgement; model ids are not. Verified per model
 * against `GET /api/model_preset?model=…` on 2026-08-19: `image-generation`,
 * `images-generations` and `dall-e-3` all name the same URL, and `openai-绘图`
 * is a fourth name for it.
 *
 * `media/image/gemini.ts` imports this list to state its own second condition
 * ("carries none of these"), so the two providers cannot both claim a row
 * regardless of what order the registry happens to visit them in.
 */
export const OPENAI_IMAGE_ENDPOINT_TYPES = ['image-generation', 'images-generations', 'dall-e-3', 'openai-绘图']

/**
 * Endpoint types that resolve to `/v1/images/edits`, the sibling path.
 *
 * Four names for one URL again, and the fourth is the reason this is a list:
 * `grok-imagine-image-2.0` and `-quality` declare `image-edit` pointing at
 * `/v1/images/edits`, which is the same path the other three name. Dropping it
 * would leave two models that demonstrably edit unable to.
 *
 * Editing is a separate declaration from drawing, not an implication of it: the
 * seedream and qwen rows sit on `image-generation` and carry none of these.
 */
export const OPENAI_EDIT_ENDPOINT_TYPES = ['OpenAI image edit', 'images-edits', 'openai-编辑', 'image-edit']

/**
 * Budget for one edit attempt.
 *
 * Higher than the drawing one because editing measurably is: a live
 * `gpt-image-1` edit of a 404 KB source answered in 53.8 seconds on
 * 2026-08-21, where drawing on the same route lands in 10 to 15. The upload is
 * part of it — the request carries the whole source picture.
 */
const EDIT_TIMEOUT_MS = 120_000

/**
 * Budget for an edit that goes through the *drawing* path (see below).
 *
 * Measured 2026-08-21 with a 2.79 MB source posted as a data URI:
 * `qwen-image-3.0` answered in 84 s and `doubao-seedream-5-0-260128` in 97 s.
 * The edits-endpoint budget would have left the second one nine seconds of
 * headroom, which is not a budget, it is a coin toss.
 */
const GENERATIONS_EDIT_TIMEOUT_MS = 180_000

/**
 * Models that edit by carrying the source in a **drawing** request.
 *
 * There are two ways to change a picture on this gateway and only one of them
 * is declared in the catalogue. The other is this: post to
 * `/v1/images/generations` as usual and add the source picture to the body,
 * whereupon the same model that draws from a prompt instead edits what it was
 * given. The console does exactly this (`web/src/pages/Lab/capability/
 * buildImageRequest.js:329` for the general case, `:249` for flux, `:292` for
 * doubao), keyed off a `supportsImageInput` flag in its own table
 * (`web/src/data/modelParams.js`).
 *
 * None of that reaches `/v1/models`, where every one of these rows says only
 * `image-generation`. So a rule written against endpoint types alone concludes
 * that seedream, qwen and kontext cannot edit and tells the user so — which is
 * false, and was what this table was added to stop saying.
 *
 * **The field name is per family and is not guessable**, which is the other
 * reason ids appear here at all: seedream 5.0 takes an array under `images`
 * while its own `-pro` sibling takes a string under `image`. First match wins,
 * so the narrower rules are written first.
 *
 * Membership is evidence, not documentation. Six of these edited a live picture
 * on 2026-08-21 — seedream 4.0, 4.5, 5.0 and 5.0-pro, `qwen-image-3.0` and its
 * `-pro` — and the test was built so that success could not be faked: the
 * instruction was 「把这张图改成黑白的，其他都不要变」, which names no subject at
 * all. Every one of them came back with the source's lantern, corridor, railing
 * and paving in black and white, and a model that had ignored the picture would
 * have had nothing to draw. Timings ran 13 s to 97 s.
 *
 * Kontext is the one entry still owed a live edit: the console declares its
 * `image` field and in-context editing is the whole point of the family, but
 * every attempt that day answered 429, latterly with `model_not_found` — there
 * is no channel behind it right now. A wrong guess there fails loudly rather
 * than quietly, which is why it is allowed to wait here rather than in a list
 * of things to try later.
 *
 * Deliberately absent, and this is a reading rather than an omission:
 * `qwen-image-max` and `z-image-turbo` take the same mapping in the relay
 * (`relay/channel/ali/image.go:32-51`) but the upstream refuses the result —
 * `content parameter's length invalid` and `Field 'text' is required in content
 * item` respectively, identically for a 2.79 MB source and a 32 KB one, so it
 * is the shape they object to and not the payload.
 */
const GENERATIONS_EDIT_FAMILIES: readonly { readonly matches: (model: string) => boolean, readonly field: 'image' | 'images' }[] = [
  // The array is this one model's alone; its own `-pro` sibling takes a string.
  { matches: model => /^doubao-seedream-5-0-(?!pro)/.test(model), field: 'images' },
  { matches: model => /^doubao-seed(ream|edit)-/.test(model), field: 'image' },
  { matches: model => /^qwen-image-3\.0/.test(model), field: 'image' },
  // Both spellings the platform uses: `flux.1-kontext-pro`, `flux-kontext-max`.
  { matches: model => model.includes('kontext'), field: 'image' },
]

/**
 * The body field this model wants its source picture in, if any.
 * @param model - the requested model id.
 * @returns the field name, or undefined when this model has no such path.
 */
function generationsEditField(model: string): 'image' | 'images' | undefined {
  return GENERATIONS_EDIT_FAMILIES.find(family => family.matches(model))?.field
}

/**
 * Turn doubao's watermark off, because its default is on.
 *
 * `doubao-seedream-5-0-pro-260628` returned a picture with 「AI生成」 burned into
 * the bottom-right corner; the same request with `watermark: false` returned the
 * same picture clean (2026-08-21, 59 s, both verified by eye). The console sends
 * this field on every doubao request and defaults it off
 * (`web/src/pages/Lab/capability/buildImageRequest.js:330`), so the stamp was
 * never something the platform intended a caller to receive — it is what
 * sending nothing gets you.
 *
 * Scoped to the family that was watched doing it, and not widened to every row
 * the console marks `supportsWatermark`: an unrecognised parameter on this route
 * is forwarded upstream verbatim, where it is a rejected request, so a field
 * added on a guess would trade a watermark nobody has seen for a failure
 * everybody would.
 * @param model - the requested model id.
 * @returns the field to spread into the body, or nothing.
 */
function watermarkOff(model: string): { readonly watermark?: false } {
  return /^doubao-seed(ream|edit)-/.test(model) ? { watermark: false } : {}
}

/** The response body, as far as this module reads it. */
interface ImagesResponse {
  readonly data?: readonly {
    readonly url?: unknown
    readonly b64_json?: unknown
    readonly revised_prompt?: unknown
  }[]
  readonly error?: { readonly message?: unknown }
  readonly message?: unknown
}

export const openaiImageProvider: ImageProvider = {
  id: 'openai-images',
  endpointTypes: OPENAI_IMAGE_ENDPOINT_TYPES,
  // Verified on this route, so it is both the name to assume when the catalogue
  // is unreadable and the one an unnamed call prefers among this transport's
  // servable models. It no longer *decides* anything: a key whose catalogue
  // lacks it draws with the next servable model instead of being refused.
  fallbackModels: ['doubao-seedream-4-0-250828'],
  variesCount: true,
  variesSize: true,

  edits(row): boolean {
    return row.types.some(type => OPENAI_EDIT_ENDPOINT_TYPES.includes(type))
      || generationsEditField(row.id) !== undefined
  },

  async generate(wire: ImageWire, request: ImageRequest): Promise<ImageOutcome> {
    const editing = request.reference !== undefined
    // The in-body path wins where a model declares both, because it is the one
    // this model has been watched editing. `qwen-image-3.0` declares the edits
    // endpoint too, and choosing by declaration rather than by evidence would
    // swap a verified route for an unverified one at the moment it matters.
    const inBody = editing ? generationsEditField(request.model) : undefined
    const budget = !editing
      ? GENERATE_TIMEOUT_MS
      : inBody === undefined ? EDIT_TIMEOUT_MS : GENERATIONS_EDIT_TIMEOUT_MS
    const post = !editing
      ? async (): Promise<HttpReply> => await sendGeneration(wire, request)
      : inBody === undefined
        ? async (): Promise<HttpReply> => await sendEdit(wire, request)
        : async (): Promise<HttpReply> => await sendGenerationEdit(wire, request, inBody)

    let reply: HttpReply
    try {
      reply = await post()
    } catch (error: unknown) {
      // Only a stall is attempted again: a refusal is deterministic, and asking
      // a second time spends the user's latency to be told the same thing.
      if (!(error instanceof AccountRequestError) || error.kind !== 'timeout') throw failure(error)
      wire.ctx.logger.warn(`openlux: image generation stalled past ${String(budget)}ms; attempting once more`)
      try {
        reply = await post()
      } catch (retry: unknown) {
        if (retry instanceof AccountRequestError && retry.kind === 'timeout') {
          const usual = !editing ? ' 10~15 秒' : inBody === undefined ? '改图 40~60 秒' : '改图 80~100 秒'
          throw new ImageGenerationError(
            `出图接口两次都没有在 ${String(Math.round(budget / 1000))} 秒内返回（正常${usual}）。`
            + '这是上游出图分组一时饱和，与提示词无关，隔一会儿再说一次就好。',
          )
        }
        throw failure(retry)
      }
    }

    const answer = (reply.body ?? {}) as ImagesResponse
    if (!reply.response.ok) {
      // The gateway's refusals are the actionable half of this tool: an
      // unsupported size, an `n` above the model's cap and an exhausted balance
      // all arrive here with text a user or a model can act on.
      const detail = text(answer.error?.message) ?? text(answer.message) ?? ''
      throw new ImageGenerationError(detail === ''
        ? `出图接口返回 HTTP ${String(reply.response.status)}。`
        : `出图接口拒绝了请求（HTTP ${String(reply.response.status)}）：${detail}`)
    }

    const entries = Array.isArray(answer.data) ? answer.data : []
    if (entries.length === 0) {
      const detail = text(answer.error?.message) ?? text(answer.message)
      throw new ImageGenerationError(detail === undefined
        ? '出图接口返回了空的图片列表。'
        : `出图接口没有返回图片：${detail}`)
    }

    const carriers: ImageCarrier[] = []
    for (const entry of entries) {
      const revisedPrompt = text(entry.revised_prompt)
      const extra = revisedPrompt === undefined ? {} : { revisedPrompt }
      const encoded = text(entry.b64_json)
      if (encoded !== undefined) {
        carriers.push({ kind: 'bytes', data: decode(encoded, wire.maxBytes), ...extra })
        continue
      }
      const link = text(entry.url)
      if (link === undefined) continue
      carriers.push({ kind: 'url', url: link, ...extra })
    }
    if (carriers.length === 0) {
      throw new ImageGenerationError(`出图接口返回了 ${String(entries.length)} 条结果，`
        + '但没有一条带 b64_json 或 url。')
    }
    return { carriers, ignored: [] }
  },
}

/** Draw from the prompt alone: `POST /v1/images/generations`, JSON. */
async function sendGeneration(wire: ImageWire, request: ImageRequest): Promise<HttpReply> {
  return await requestJson(wire.ctx, `${wire.base}/images/generations`, {
    method: 'POST',
    headers: wire.headers,
    body: JSON.stringify({
      model: request.model,
      prompt: request.prompt,
      n: request.count,
      ...request.size === undefined ? {} : { size: request.size },
      ...watermarkOff(request.model),
    }),
  }, GENERATE_TIMEOUT_MS, wire.signal)
}

/**
 * Change a supplied picture: `POST /v1/images/edits`, **multipart**.
 *
 * The encoding is the whole point of this function existing. The kernel's own
 * litellm provider posts JSON with a data URL to this path
 * (`litellm/image-generation-provider.ts:125-136`, `kind: "json"`), and this
 * route answers that with HTTP 500 `request Content-Type isn't
 * multipart/form-data` — so the kernel's edit path has never worked here. A real
 * multipart body with the source under `image` answered 200 in 53.8 seconds on
 * 2026-08-21 (`gpt-image-1`, 404 KB source), returning the same scene with only
 * the requested change made.
 *
 * `Content-Type` is dropped rather than set: `fetch` derives it from the
 * `FormData` body together with the boundary, and a hand-written one has no
 * boundary for the server to split on.
 * @param wire - route origin, headers and cancellation.
 * @param request - the edit, whose `reference` is present by construction.
 * @returns the reply, for the shared parsing below.
 */
async function sendEdit(wire: ImageWire, request: ImageRequest): Promise<HttpReply> {
  const reference = request.reference
  if (reference === undefined) throw new ImageGenerationError('改图请求没有带上要改的图片。')
  const form = new FormData()
  form.set('model', request.model)
  form.set('prompt', request.prompt)
  form.set('n', String(request.count))
  if (request.size !== undefined) form.set('size', request.size)
  const copy = new Uint8Array(reference.data)
  form.set('image', new Blob([copy], { type: reference.mediaType }), `source.${extensionFor(reference.mediaType)}`)
  const headers = { ...wire.headers }
  delete headers['Content-Type']
  return await requestJson(wire.ctx, `${wire.base}/images/edits`, {
    method: 'POST',
    headers,
    body: form,
  }, EDIT_TIMEOUT_MS, wire.signal)
}

/**
 * Change a supplied picture on the **drawing** path, as JSON.
 *
 * Same URL and same body as `sendGeneration`, plus one field carrying the
 * source. Verified 2026-08-21 by asking for a portrait lantern to be made black
 * and white and reading the answer back: `qwen-image-3.0` returned the same
 * scene in 84 s keeping the portrait shape, `doubao-seedream-5-0-260128` in
 * 97 s reframed to a square. Both kept the lantern, the corridor and the
 * composition, which is the difference between an edit and a redraw.
 *
 * The source goes in as a `data:` URI. The console's own table calls this field
 * a URL (`imageInputFormat: 'url'`) and we have no image host to make one with,
 * so this was the open question; a 2.79 MB data URI was accepted by both. Size
 * is not the constraint it was on the video routes — the same two models were
 * equally happy with 32 KB and with 2.79 MB, and the models that refused
 * refused both identically.
 * @param wire - route origin, headers and cancellation.
 * @param request - the edit, whose `reference` is present by construction.
 * @param field - the body field this family carries its source in.
 * @returns the reply, for the shared parsing above.
 */
async function sendGenerationEdit(wire: ImageWire, request: ImageRequest, field: 'image' | 'images'): Promise<HttpReply> {
  const reference = request.reference
  if (reference === undefined) throw new ImageGenerationError('改图请求没有带上要改的图片。')
  const source = `data:${reference.mediaType};base64,${Buffer.from(reference.data).toString('base64')}`
  return await requestJson(wire.ctx, `${wire.base}/images/generations`, {
    method: 'POST',
    headers: wire.headers,
    body: JSON.stringify({
      model: request.model,
      prompt: request.prompt,
      n: request.count,
      ...request.size === undefined ? {} : { size: request.size },
      ...watermarkOff(request.model),
      [field]: field === 'images' ? [source] : source,
    }),
  }, GENERATIONS_EDIT_TIMEOUT_MS, wire.signal)
}

/** The filename suffix the multipart part carries, derived from the type. */
function extensionFor(mediaType: string): string {
  const subtype = mediaType.split('/')[1] ?? 'png'
  return subtype === 'jpeg' ? 'jpg' : subtype
}

/**
 * Turn a base64 payload into bytes, refusing one that cannot be stored.
 *
 * Four base64 characters carry three bytes, so the encoded length answers the
 * question before a body nobody can keep is materialised.
 * @param encoded - the `b64_json` payload.
 * @param maxBytes - per-image ceiling.
 * @returns the decoded image.
 * @throws {ImageGenerationError} when it is too large, or decodes to nothing.
 */
function decode(encoded: string, maxBytes: number): Uint8Array {
  const approximate = Math.floor(encoded.length / 4) * 3
  if (approximate > maxBytes) {
    throw new ImageGenerationError(`返回的图片超过本机附件上限（约 ${String(Math.round(approximate / 1024))} KB `
      + `> ${String(Math.round(maxBytes / 1024))} KB），请用更小的 size 重试。`)
  }
  const data = Buffer.from(encoded, 'base64')
  if (data.byteLength === 0) throw new ImageGenerationError('返回的 base64 图片解不出内容。')
  return data
}

/** Turn a transport failure into the model-facing error. */
function failure(error: unknown): ImageGenerationError {
  return new ImageGenerationError(error instanceof AccountRequestError
    ? error.message
    : `出图请求失败：${error instanceof Error ? error.message : String(error)}`)
}
