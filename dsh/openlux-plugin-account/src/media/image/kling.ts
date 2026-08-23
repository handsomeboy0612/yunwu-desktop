/**
 * Kling's two image routes, submit-then-poll off the site root.
 *
 * Ported from this product's openclaw-era plugin
 * (`resources/yunwu-video-plugin/index.mjs`, `klingImageAdapter` and
 * `klingOmniImageAdapter`) rather than rediscovered: every judgement below is
 * sourced to the gateway's own code, and three of them cannot be found by
 * reading a successful response.
 *
 * ## What was re-checked on 2026-08-21, and what could not be
 *
 * The port's readings are from 2026-08-17, and a stale reading is not evidence,
 * so both routes were sent one submit with the body this file builds:
 *
 * - `POST /kling/v1/images/generations` with `model_name: kling-v3` → HTTP 429,
 *   body `{"code":400,"message":"Account balance not enough"}`.
 * - `POST /kling/v1/images/omni-image` with `model_name: kling-image-o1` → the
 *   same.
 * - A control sending the *catalogue id* as the model name → HTTP 429,
 *   `"model_name value 'kling-image' is invalid"`.
 *
 * The control is what makes the first two readings mean something: they are not
 * a blanket refusal, so the paths, the auth and both upstream model names were
 * accepted and only the channel's balance stood in the way.
 *
 * **So the success path here is unverified.** Nothing downstream of a created
 * task — the poll, the status vocabulary, the shape of `task_result` — has been
 * seen on this route with this key. It is ported faithfully rather than
 * improvised, but the first live success should be watched rather than assumed.
 *
 * ## Four traps, none of them visible in a happy-path response
 *
 * - **Business errors ride inside HTTP 429.** All three readings above are 429
 *   carrying `code: 400`. Reading the HTTP status first would report every one
 *   of them as rate limiting, so the body decides and the status is only a
 *   fallback when there is no body.
 * - **A success carries a message too.** The gateway passes upstream's envelope
 *   through verbatim and its `message` on success is the string `"success"`
 *   (`relay/channel/task/kling/adaptor.go:2399-2447`), so "has a message" would
 *   fail every successful submit. Only `code === 0` decides.
 * - **The catalogue id is not the upstream model name.** `kling-image` and
 *   `kling-omni-image` select the route and the price; upstream wants a version
 *   (`kling-v3`, the newest name on both the text-to-image and image-to-image
 *   whitelists, `adaptor.go:1494`/`:1500`) or one of omni's two
 *   (`kling-image-o1`, which is also what the gateway fills in when the field is
 *   omitted, `:2337-2339`).
 * - **The poll must use the submit's own action segment.** `GET
 *   /kling/v1/images/<action>/<task_id>` is one wildcard route
 *   (`router/relay-router.go:285`), so an omni task read back under
 *   `generations` is simply not found.
 *
 * And one more the platform's own Lab already learned: completion is the status,
 * never the presence of a URL. That is the PixVerse lesson — a URL can be
 * published before the object lands in the bucket — and it applies here for
 * free because the status vocabulary is explicit.
 *
 * ## Why the reference image is bare base64
 *
 * Exactly the opposite of MJ, which wants a `data:` prefix. Kling's contract
 * says not to send one, and the gateway does nothing to the value — searching
 * all of `relay/channel/task/kling/` for `data:image` finds nothing — so a
 * prefix would be forwarded upstream as part of the image.
 *
 * @module openlux-plugin-account/media/image/kling
 */

import { AccountRequestError, requestJson, type HttpReply } from '../../account/http.ts'
import {
  aspectOf,
  ImageGenerationError,
  object,
  pause,
  text,
  type ImageOutcome,
  type ImageProvider,
  type ImageRequest,
  type ImageWire,
} from './provider.ts'

/**
 * The version `kling-image` submits as.
 *
 * Text-to-image and image-to-image keep separate whitelists upstream and this is
 * the newest name on both, so one constant serves the draw and the edit.
 */
const UPSTREAM_MODEL = 'kling-v3'

/** The version `kling-omni-image` submits as; omni accepts only two, and this is the gateway's own default. */
const OMNI_UPSTREAM_MODEL = 'kling-image-o1'

/** Upstream's own bound on `n`, validated at the gateway and billed per picture. */
const MAX_COUNT = 9

/** Budget for the submit; it only creates a task. */
const SUBMIT_TIMEOUT_MS = 60_000

/** Budget for one status read. */
const POLL_TIMEOUT_MS = 30_000

/**
 * How long to wait for the pictures.
 *
 * Not a measurement — no task has completed on this route here — but a bound:
 * the tool's own budget is 250 seconds, and a poll loop that outlives it would
 * be replaced by a generic timeout with nothing useful to say. The
 * openclaw-era plugin allowed 300 for the same family.
 */
const POLL_BUDGET_MS = 200_000

/** Gap between reads, matching the cadence the platform's own Lab polls at. */
const POLL_INTERVAL_MS = 5000

export const klingImageProvider: ImageProvider = {
  id: 'kling-image',
  // The catalogue row carries three types today (generation, multi-image,
  // expand) and only the first is wired, so the claim names only that one.
  // Claiming all three would matter the day the platform splits them onto rows
  // of their own: an expand row would then be answered with a generations body,
  // where refusing it as unwired says something true instead.
  endpointTypes: ['Kling image generation'],
  // Empty on purpose. This list is consulted only when the catalogue cannot be
  // read at all, and its contract is names that have actually produced a
  // picture — this one has not, so guessing it here would route a paid request
  // onto an unproven transport at the moment nothing can be checked.
  fallbackModels: [],
  variesCount: true,
  variesSize: true,

  // One route draws and edits both: supplying `image` switches it to
  // image-to-image, including for billing (`relay/relay_task_kling.go:307-315`).
  edits: () => true,

  async generate(wire: ImageWire, request: ImageRequest): Promise<ImageOutcome> {
    // Only when asked for. Kling's legal set is 1:1 / 16:9 / 9:16 with no "keep
    // the input's shape", so an unrequested default would silently reshape an
    // edit — which is exactly what a square default did to a portrait on Vidu
    // before it was caught.
    const aspect = aspectOf(request.size)
    const body: Record<string, unknown> = {
      model_name: UPSTREAM_MODEL,
      prompt: request.prompt,
      n: Math.max(1, Math.min(MAX_COUNT, request.count)),
      ...aspect === undefined ? {} : { aspect_ratio: aspect },
    }
    if (request.reference !== undefined) body['image'] = base64(request.reference.data)
    const taskId = await submit(wire, 'generations', body)
    return { carriers: await settle(wire, 'generations', taskId), ignored: shapeNote(request) }
  },
}

export const klingOmniImageProvider: ImageProvider = {
  id: 'kling-omni-image',
  endpointTypes: ['omni-image'],
  fallbackModels: [],
  variesCount: true,
  variesSize: true,

  edits: () => true,

  async generate(wire: ImageWire, request: ImageRequest): Promise<ImageOutcome> {
    const aspect = aspectOf(request.size)
    const body: Record<string, unknown> = {
      model_name: OMNI_UPSTREAM_MODEL,
      prompt: request.prompt,
      n: Math.max(1, Math.min(MAX_COUNT, request.count)),
      ...aspect === undefined ? {} : { aspect_ratio: aspect },
    }
    // Upstream takes several here; this tool's edit vocabulary is "change the
    // last picture", so it always has exactly one to send.
    if (request.reference !== undefined) body['image_list'] = [{ image: base64(request.reference.data) }]
    const taskId = await submit(wire, 'omni-image', body)
    return { carriers: await settle(wire, 'omni-image', taskId), ignored: shapeNote(request) }
  },
}

/**
 * What this route could not honour, in words for the model.
 *
 * The shape survives as one of three ratios; the exact pixels do not, because
 * the request body has no field for them. Said afterwards rather than refused
 * beforehand, and never by quietly returning a different shape.
 * @param request - what was asked for.
 * @returns the note, or nothing when no shape was named.
 */
function shapeNote(request: ImageRequest): string[] {
  if (request.size === undefined) return []
  return [`可灵这条接口只收 1:1 / 16:9 / 9:16 三档比例，没有像素尺寸字段，`
    + `所以 ${request.size} 只按最接近的比例生效，具体像素没有。`]
}

/** Bare base64, with no data URI prefix — see the module note. */
function base64(data: Uint8Array): string {
  return Buffer.from(data).toString('base64')
}

/**
 * Create the task.
 * @param wire - route access.
 * @param action - the path segment, which the poll has to reuse.
 * @param body - the request body this route expects.
 * @returns the task id.
 * @throws {ImageGenerationError} when the route or Kling refused.
 */
async function submit(wire: ImageWire, action: string, body: Record<string, unknown>): Promise<string> {
  let reply: HttpReply
  try {
    reply = await requestJson(wire.ctx, `${wire.root}/kling/v1/images/${action}`, {
      method: 'POST',
      headers: wire.headers,
      body: JSON.stringify(body),
    }, SUBMIT_TIMEOUT_MS, wire.signal)
  } catch (error: unknown) {
    throw new ImageGenerationError(error instanceof AccountRequestError
      ? error.message
      : `可灵出图提交失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const answer = object(reply.body) ?? {}
  // The body decides, not the status: a refusal for a bad parameter or an empty
  // channel balance arrives as HTTP 429 carrying `code: 400`.
  if (answer['code'] !== 0) {
    throw new ImageGenerationError(`可灵拒绝了这次提交：${complaint(answer)
      ?? `HTTP ${String(reply.response.status)}，上游没有给出原因`}`)
  }
  const taskId = text(object(answer['data'])?.['task_id'])
  if (taskId === undefined) throw new ImageGenerationError('可灵提交回执里没有任务号。')
  return taskId
}

/**
 * Wait for the task and answer with the finished pictures.
 * @param wire - route access.
 * @param action - the same segment {@link submit} used.
 * @param taskId - what {@link submit} returned.
 * @returns one carrier per produced image.
 * @throws {ImageGenerationError} when it failed, or outlived the budget.
 */
async function settle(wire: ImageWire, action: string, taskId: string): Promise<{ kind: 'url'; url: string }[]> {
  const started = Date.now()
  let lastStatus = ''
  while (Date.now() - started < POLL_BUDGET_MS) {
    await pause(POLL_INTERVAL_MS, wire.signal)
    let reply: HttpReply
    try {
      reply = await requestJson(wire.ctx, `${wire.root}/kling/v1/images/${action}/${encodeURIComponent(taskId)}`, {
        method: 'GET',
        headers: { Authorization: wire.headers['Authorization'] ?? '' },
      }, POLL_TIMEOUT_MS, wire.signal)
    } catch (error: unknown) {
      // One unreadable status is not a failed task: it is being drawn upstream
      // either way, so the loop keeps its budget and reads again.
      wire.ctx.logger.warn(`openlux: Kling status read failed (${error instanceof Error ? error.message : String(error)}); retrying`)
      continue
    }
    const answer = object(reply.body)
    if (answer === undefined) {
      wire.ctx.logger.warn(`openlux: Kling status read returned HTTP ${String(reply.response.status)} with no body; retrying`)
      continue
    }
    const status = statusOf(answer)
    if (status !== lastStatus) {
      wire.ctx.logger.debug(`openlux: Kling task ${taskId} is ${status}`)
      lastStatus = status
    }
    if (status === 'failed' || status === 'fail' || status === 'error') {
      throw new ImageGenerationError(`可灵出图失败：${complaint(answer) ?? '上游没有给出原因'}`)
    }
    if (status !== 'succeed' && status !== 'done') continue
    const urls = images(answer)
    if (urls.length === 0) throw new ImageGenerationError('可灵报告出图完成，但回执里没有图片地址。')
    return urls.map(url => ({ kind: 'url' as const, url }))
  }
  throw new ImageGenerationError(`可灵出图超过 ${String(Math.round(POLL_BUDGET_MS / 1000))} 秒还没完成。`
    + '任务在上游还在跑，隔一会儿再试一次。')
}

/**
 * The task's state, in either place it is reported.
 *
 * Normally `data.task_status`; once the gateway has judged a task failed it
 * answers with its unified failure body instead, where the state moves to the
 * top level (`relay/relay_task_fetch_kling.go:51-56`).
 * @param answer - the response body.
 * @returns the state, lowercased, or an empty string when it said neither.
 */
function statusOf(answer: Record<string, unknown>): string {
  const state = text(object(answer['data'])?.['task_status']) ?? text(answer['status'])
  return state?.toLowerCase() ?? ''
}

/** The finished pictures' URLs, in the order upstream returned them. */
function images(answer: Record<string, unknown>): string[] {
  const rows = object(object(answer['data'])?.['task_result'])?.['images']
  if (!Array.isArray(rows)) return []
  return rows.map(row => text(object(row)?.['url'])).filter((url): url is string => url !== undefined)
}

/**
 * Kling's own words for a refusal, in all three places it puts them.
 *
 * Task-level `data.task_status_msg`, request-level `message`, and the `error` of
 * the unified failure body the gateway swaps in for a failed task.
 * @param answer - the response body.
 * @returns the complaint, or undefined when it said nothing.
 */
function complaint(answer: Record<string, unknown>): string | undefined {
  const failure = answer['error']
  return text(object(answer['data'])?.['task_status_msg'])
    ?? text(answer['message'])
    ?? text(typeof failure === 'string' ? failure : object(failure)?.['message'])
}
