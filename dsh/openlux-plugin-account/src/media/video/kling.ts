/**
 * Kling: two generations that share a brand, a route prefix, and nothing else.
 *
 * `kling-video` and `kling-3.0-turbo` are two protocols, not two names for one.
 * The first takes flat fields (`model_name` / `mode` / `duration`) and finishes
 * at `succeed`; the second nests them under `settings`, carries its reference
 * picture inside a `contents` array, and finishes at `succeeded`. Sharing a
 * submit body between them produced nothing but 400s in the openclaw-era
 * plugin, so they are two providers here.
 *
 * ## What both get wrong if you read only the HTTP status
 *
 * A rejected request comes back **HTTP 429 carrying `{"code":400,…}`**, and the
 * relay records that upstream 429 as "requests too frequent" — so a caller that
 * trusts the status retries a parameter error forever. The verdict is the body's
 * `code`: zero is accepted, anything else is a refusal whose reason is in
 * `message`. Measured again on 2026-08-21, poisoning one late-validated field
 * per route so nothing was filmed:
 *
 * | route | body sent | answer |
 * |---|---|---|
 * | `/kling/v1/videos/text2video` | `aspect_ratio: '99:1'` | 429 `code:400` `aspect_ratio value '99:1' is invalid` |
 * | `/kling/v1/videos/image2video` | `image: 'not-an-image'` | 429 `code:400` `File is not in a valid base64 format` |
 * | `/kling/text-to-video/kling-3.0-turbo` | `settings.resolution: '4k'` | 429 `code:400` `settings.resolution must be 720p or 1080p` |
 * | `/kling/image-to-video/kling-3.0-turbo` | `contents` with no first frame | 429 `code:400` `contents must include at least one first_frame item` |
 *
 * Those complaints are worded differently from the relay's own
 * (`kling/adaptor.go:1085` says `invalid aspect_ratio value: …`), which is how
 * we know the requests reached Kling itself rather than being stopped locally.
 *
 * ## The catalogue id is not the upstream model name (v1 only)
 *
 * `kling-video` is what `/v1/models` lists and what the relay bills; the body's
 * `model_name` has to be a real version out of the whitelist at
 * `relay/channel/task/kling/adaptor.go:1928`. This module sends `kling-v1`
 * because that is the one that has produced a clip on this key — explicit rather
 * than left to the relay's default, so a change of default upstream cannot
 * quietly change what users get. Offering the newer versions is a separate
 * feature: the catalogue has no entry per version, so there is nothing for a
 * user to name.
 *
 * ## Polling must use the mount that submitted
 *
 * Both generations query at their own submit path plus the task id, and asking
 * the wrong mount does not 404 — it answers a stub, so a poller that guesses
 * waits out the whole budget on a task that finished minutes ago. Hence
 * {@link VideoSubmitted.handle} carries the action across.
 *
 * ## Slow even for this route
 *
 * A std 5-second v1 clip measured ~318s end to end, against ~100s for veo. The
 * facade's ten-minute budget was sized for exactly this and must not be trimmed.
 *
 * @module openlux-plugin-account/media/video/kling
 */

import { AccountRequestError, requestJson } from '../../account/http.ts'
import type {
  VideoModelSpec,
  VideoProvider,
  VideoSubmitInput,
  VideoSubmitted,
  VideoTaskState,
  VideoWire,
} from './provider.ts'
import { object, text, VideoGenerationError } from './provider.ts'

/** Generous because the reference picture rides along in the body. */
const SUBMIT_TIMEOUT_MS = 300_000

const POLL_TIMEOUT_MS = 30_000

/**
 * The version sent as `model_name` on the v1 routes.
 *
 * One name serves both of the paths this module walks (the whitelists for
 * text2video and image2video both contain it). The multi-image path would need
 * `kling-v1-6` instead, and is not walked here — see `endpointTypes`.
 */
const V1_UPSTREAM = 'kling-v1'

/**
 * Kling's two quality tiers are `std` and `pro`; `std` is the relay's default
 * and the one that has been filmed. Nothing in this tool's vocabulary lets a
 * user ask for the other, so it is fixed rather than guessed at per request.
 */
const V1_MODE = 'std'

/** Turbo's `settings.resolution`; the alternative is `1080p`. */
const TURBO_RESOLUTION = '720p'

/**
 * Frame shapes, identical for both generations
 * (`dto/kling.go:21`, `dto/kling_v30_turbo.go:21`).
 */
const ASPECTS = ['16:9', '9:16', '1:1'] as const

/** v1 accepts these two lengths and no others (`dto/kling.go:22`). */
const V1_DURATIONS = [5, 10] as const

/** Turbo checks a range instead of a set (`dto/kling_v30_turbo.go:438-442`). */
const TURBO_DURATIONS = [3, 15] as const

const TURBO_TEXT_TYPE = '3.0turbo-文生视频'
const TURBO_IMAGE_TYPE = '3.0turbo-图生视频'

export const klingProvider: VideoProvider = {
  id: 'kling',
  // `Multi-image reference to video` is deliberately unclaimed: it wants two to
  // four pictures and this tool hands a provider at most one. `kling-video`
  // still matches here through the other two types, which is all it needs.
  endpointTypes: ['Text to video', 'Image to video'],
  fallbackModels: ['kling-video'],

  // Those two type names are the most generic on the whole catalogue and today
  // only Kling carries them. Narrowing by prefix costs nothing and keeps some
  // future vendor's `Text to video` from being submitted to `/kling/…`.
  claims: (model: string): boolean => model.startsWith('kling-'),

  spec(): VideoModelSpec {
    return {
      durations: [...V1_DURATIONS],
      aspects: [...ASPECTS],
      firstFrame: true,
      // `image2video` has no aspect field at all; the first frame decides.
      referenceDecidesShape: true,
    }
  },

  async submit(wire: VideoWire, input: VideoSubmitInput): Promise<VideoSubmitted> {
    const reference = input.images?.[0]
    const action = reference === undefined ? 'text2video' : 'image2video'
    const body: Record<string, unknown> = {
      model_name: V1_UPSTREAM,
      prompt: input.prompt,
      mode: V1_MODE,
      // A number, not a string: the relay has a float branch for this field
      // (`relay/relay_task_kling.go:435-443`). The declared duration set has
      // already narrowed this to 5 or 10; the pick here only covers a caller
      // that skipped the tool.
      duration: input.durationSeconds === 10 ? 10 : 5,
      ...reference === undefined
        ? { aspect_ratio: input.aspectRatio ?? '16:9' }
        : { image: reference },
    }

    const answer = await call(wire, `${wire.root}/kling/v1/videos/${action}`, body, '可灵视频')
    const taskId = text(object(answer['data'])?.['task_id'])
    if (taskId === undefined) {
      throw new VideoGenerationError('可灵视频提交没有返回任务号，无法跟踪这次生成。')
    }
    return { taskId, handle: action }
  },

  async poll(wire: VideoWire, task: VideoSubmitted): Promise<VideoTaskState> {
    const action = task.handle === 'image2video' ? 'image2video' : 'text2video'
    const answer = await read(
      wire,
      `${wire.root}/kling/v1/videos/${action}/${encodeURIComponent(task.taskId)}`,
    )
    const data = object(answer['data']) ?? {}
    const status = text(data['task_status'])?.toLowerCase() ?? 'submitted'
    const videos = object(data['task_result'])?.['videos']
    const url = Array.isArray(videos) ? text(object(videos[0])?.['url']) : undefined
    const failure = complaint(answer)

    return {
      status,
      ...url === undefined ? {} : { url },
      ...failure === undefined ? {} : { failure },
      done: status === 'succeed' || url !== undefined,
      failed: status === 'failed',
    }
  },
}

export const klingTurboProvider: VideoProvider = {
  id: 'kling-turbo',
  endpointTypes: [TURBO_TEXT_TYPE, TURBO_IMAGE_TYPE],
  fallbackModels: ['kling-3.0-turbo'],

  spec(_model: string, types: readonly string[]): VideoModelSpec {
    return {
      // A range, not a set: declaring thirteen integers would read like a
      // measured whitelist and say the same thing.
      durationRange: TURBO_DURATIONS,
      aspects: [...ASPECTS],
      firstFrame: types.length === 0 || types.includes(TURBO_IMAGE_TYPE),
      referenceDecidesShape: true,
    }
  },

  async submit(wire: VideoWire, input: VideoSubmitInput): Promise<VideoSubmitted> {
    const reference = input.images?.[0]
    const types = input.endpointTypes ?? []
    if (reference !== undefined && types.length > 0 && !types.includes(TURBO_IMAGE_TYPE)) {
      throw new VideoGenerationError(`可灵「${input.model}」这条路只做纯文字出片，不收参考图。`)
    }

    const settings: Record<string, unknown> = {
      resolution: TURBO_RESOLUTION,
      duration: typeof input.durationSeconds === 'number' && Number.isFinite(input.durationSeconds)
        ? Math.min(15, Math.max(3, Math.round(input.durationSeconds)))
        : 5,
    }
    // The two paths take different bodies: text reads a top-level `prompt`,
    // picture reads `contents` and wants a `first_frame` item in it
    // (`dto/kling_v30_turbo.go:392-421`). An empty `contents[].text` is a 400,
    // so a promptless request simply omits that item.
    const mode = reference === undefined ? 'text-to-video' : 'image-to-video'
    const body: Record<string, unknown> = reference === undefined
      ? { prompt: input.prompt, settings: { ...settings, aspect_ratio: input.aspectRatio ?? '16:9' } }
      : {
          contents: [
            ...input.prompt.trim() === '' ? [] : [{ type: 'prompt', text: input.prompt }],
            { type: 'first_frame', url: reference },
          ],
          settings,
        }

    const answer = await call(wire, `${wire.root}/kling/${mode}/kling-3.0-turbo`, body, '可灵 3.0')
    const item = first(answer)
    const taskId = text(item?.['id']) ?? text(item?.['task_id'])
    if (taskId === undefined) {
      throw new VideoGenerationError('可灵 3.0 提交没有返回任务号，无法跟踪这次生成。')
    }
    return { taskId, handle: mode }
  },

  async poll(wire: VideoWire, task: VideoSubmitted): Promise<VideoTaskState> {
    const mode = task.handle === 'image-to-video' ? 'image-to-video' : 'text-to-video'
    const answer = await read(
      wire,
      `${wire.root}/kling/${mode}/kling-3.0-turbo/${encodeURIComponent(task.taskId)}`,
    )
    const item = first(answer) ?? {}
    const status = text(item['status'])?.toLowerCase() ?? text(item['task_status'])?.toLowerCase() ?? 'submitted'
    const outputs = item['outputs']
    const url = Array.isArray(outputs) ? text(object(outputs[0])?.['url']) : undefined
    const failure = complaint(answer) ?? text(item['task_status_msg'])

    return {
      status,
      ...url === undefined ? {} : { url },
      ...failure === undefined ? {} : { failure },
      // Both literals are accepted: the wire carries `succeeded` while the
      // relay's own task table normalizes it to `succeed`
      // (`dto/kling_v30_turbo.go:461-468`), and either may surface here.
      done: status === 'succeeded' || status === 'succeed' || url !== undefined,
      failed: status === 'failed' || status === 'error',
    }
  },
}

/**
 * Submit shape shared by both generations: post, then judge by the body's
 * `code` rather than by the HTTP status.
 *
 * @param wire - route origins, headers and cancellation.
 * @param url - the full submit path.
 * @param body - the vendor-shaped request.
 * @param label - which generation, for the message the model will read.
 * @returns the parsed response body.
 * @throws {VideoGenerationError} when the route or Kling refused.
 */
async function call(
  wire: VideoWire,
  url: string,
  body: Record<string, unknown>,
  label: string,
): Promise<Record<string, unknown>> {
  let reply
  try {
    reply = await requestJson(wire.ctx, url, {
      method: 'POST',
      headers: { ...wire.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, SUBMIT_TIMEOUT_MS, wire.signal)
  } catch (error: unknown) {
    throw new VideoGenerationError(error instanceof AccountRequestError
      ? error.message
      : `${label}提交失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const answer = object(reply.body) ?? {}
  const reason = complaint(answer)
  // The status is checked second on purpose. A parameter error arrives as 429,
  // and leading with "HTTP 429" is what makes it look like rate limiting.
  if (answer['code'] !== 0 || !reply.response.ok) {
    throw new VideoGenerationError(reason === undefined
      ? `${label}提交被拒（HTTP ${String(reply.response.status)}），上游没有给出原因。`
      : `${label}提交被拒：${reason}`)
  }
  return answer
}

/**
 * One status read.
 *
 * Throws plainly rather than as a {@link VideoGenerationError}: the facade
 * tolerates a run of failed polls, so a transient read must not read as a
 * verdict on the task.
 *
 * @param wire - route origins, headers and cancellation.
 * @param url - the full query path.
 * @returns the parsed response body.
 */
async function read(wire: VideoWire, url: string): Promise<Record<string, unknown>> {
  const reply = await requestJson(wire.ctx, url, { headers: wire.headers }, POLL_TIMEOUT_MS, wire.signal)
  if (!reply.response.ok) throw new Error(`HTTP ${String(reply.response.status)}`)
  return object(reply.body) ?? {}
}

/**
 * Turbo answers with an object on submit and a one-element array on query
 * (its own dto accepts both, `dto/kling_v30_turbo.go:203-233`).
 *
 * @param answer - the response body.
 * @returns the task item, whichever way it was wrapped.
 */
function first(answer: Record<string, unknown>): Record<string, unknown> | undefined {
  const data = answer['data']
  return Array.isArray(data) ? object(data[0]) : object(data)
}

/**
 * Kling's own words for a refusal or a failure.
 *
 * @param answer - the response body.
 * @returns the complaint, or undefined when it said nothing.
 */
function complaint(answer: Record<string, unknown>): string | undefined {
  return text(object(answer['data'])?.['task_status_msg']) ?? text(answer['message'])
}
