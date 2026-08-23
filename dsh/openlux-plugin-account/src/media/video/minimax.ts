/**
 * MiniMax 海螺: one path for both modes, and a failure signal that is not HTTP.
 *
 * Contract from the relay rather than a vendor page: submit is
 * `POST /minimax/v1/video_generation` and the query is
 * `GET /minimax/v1/query/video_generation?task_id=` (`router/relay-router.go`),
 * both hanging off the **site root** rather than `/v1`. Channel selection reads
 * the body's `model`, which is the catalogue id unchanged
 * (`middleware/distributor.go`).
 *
 * Two properties are specific to this vendor and both cost a debugging session
 * the first time (measured 2026-08-13 on `MiniMax-Hailuo-02`, 96s / 0.35 MB):
 *
 * 1. **The HTTP status is not the failure signal.** A bad parameter comes back
 *    as **HTTP 429** carrying
 *    `{"status":"failed","base_resp":{"status_code":400,"status_msg":"invalid duration: 7"}}`.
 *    Read as a rate limit it sends you off building backoff; the actual verdict
 *    is `base_resp.status_code !== 0`. And the mirror of that trap is worse: a
 *    *successful* reply carries `status_msg: "success"`, so "there is a message,
 *    therefore it failed" marks every submit as failed.
 * 2. **The vendor's own protocol has three steps and the relay does the third.**
 *    Upstream you would submit, poll for a `file_id`, then exchange it for a
 *    URL; `dto/minimax.go`'s `MergeMinimaxTaskData` folds the file detail into
 *    the query response, so `file.download_url` is already there the moment
 *    `status` reads `Success`. If that merge ever stops happening, the
 *    orchestrator's "finished but no URL" refusal surfaces it rather than
 *    hanging.
 *
 * **No aspect ratio exists on this path.** The body has `resolution`
 * (512P/768P/1080P) and no `aspect_ratio` (`dto/minimax.go`), and a live clip
 * came back 1366×768. A portrait request is therefore refused here by name
 * instead of being answered with a landscape clip the user did not ask for.
 *
 * @module openlux-plugin-account/media/video/minimax
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

const SUBMIT_TIMEOUT_MS = 60_000
const POLL_TIMEOUT_MS = 30_000

/**
 * Clip lengths, from the relay's own whitelist (`minimax/models.go`): an
 * unlisted number is answered with the 429-shaped rejection above, so this one
 * is worth enforcing locally.
 */
const DURATIONS: Record<string, readonly number[]> = {
  'MiniMax-Hailuo-02': [6, 10],
  'MiniMax-Hailuo-2.3': [6, 10],
  'MiniMax-Hailuo-2.3-Fast': [6, 10],
}

/**
 * Models the relay refuses without a reference image
 * (`relay/channel/task/minimax/adaptor.go`). Refusing locally saves the round
 * trip and, more importantly, says which model to use instead.
 */
const IMAGE_ONLY = new Set(['MiniMax-Hailuo-2.3-Fast'])

/** The vendor's replies, as far as this module reads them. */
interface HailuoReply {
  readonly task_id?: unknown
  readonly status?: unknown
  readonly file?: unknown
  readonly base_resp?: unknown
}

export const minimaxProvider: VideoProvider = {
  id: 'minimax',
  endpointTypes: ['Hailuo video generation'],
  fallbackModels: ['MiniMax-Hailuo-02', 'MiniMax-Hailuo-2.3'],

  spec(model: string): VideoModelSpec {
    return {
      ...DURATIONS[model] === undefined ? {} : { durations: DURATIONS[model] },
      aspects: ['16:9'],
      firstFrame: true,
      // Declared as well as guarded in `submit` below: declaring it moves the
      // refusal into the turn that asked, and the guard still covers the path
      // where no catalogue could be read.
      ...IMAGE_ONLY.has(model) ? { requiresFirstFrame: true } : {},
    }
  },

  async submit(wire: VideoWire, input: VideoSubmitInput): Promise<VideoSubmitted> {
    const reference = input.images?.[0]
    if (reference === undefined && IMAGE_ONLY.has(input.model)) {
      throw new VideoGenerationError(
        `海螺「${input.model}」只做图生视频，需要一张参考图；纯文字请改用 MiniMax-Hailuo-02 或 MiniMax-Hailuo-2.3。`,
      )
    }
    // Image-to-video is the same path with one more field, not another route
    // (`dto/minimax.go`). `last_frame_image` and `subject_reference` live in the
    // same body and stay unsent until a caller here can supply two images.
    const body: Record<string, unknown> = {
      model: input.model,
      prompt: input.prompt,
      ...reference === undefined ? {} : { first_frame_image: reference },
      ...input.durationSeconds === undefined ? {} : { duration: Math.round(input.durationSeconds) },
    }
    let reply
    try {
      reply = await requestJson(wire.ctx, `${wire.root}/minimax/v1/video_generation`, {
        method: 'POST',
        headers: { ...wire.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, SUBMIT_TIMEOUT_MS, wire.signal)
    } catch (error: unknown) {
      throw new VideoGenerationError(error instanceof AccountRequestError
        ? error.message
        : `海螺视频提交失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const answer = (reply.body ?? {}) as HailuoReply
    const failure = failureOf(answer)
    if (failure !== undefined) throw new VideoGenerationError(`海螺视频提交失败：${failure}`)
    if (!reply.response.ok) {
      throw new VideoGenerationError(`海螺视频提交失败：HTTP ${String(reply.response.status)}。`)
    }
    const taskId = text(answer.task_id)
    if (taskId === undefined) {
      throw new VideoGenerationError('海螺视频提交没有返回 task_id，无法跟踪这次生成。')
    }
    return { taskId }
  },

  async poll(wire: VideoWire, task: VideoSubmitted): Promise<VideoTaskState> {
    const reply = await requestJson(
      wire.ctx,
      `${wire.root}/minimax/v1/query/video_generation?task_id=${encodeURIComponent(task.taskId)}`,
      { headers: wire.headers },
      POLL_TIMEOUT_MS,
      wire.signal,
    )
    const answer = (reply.body ?? {}) as HailuoReply
    const failure = failureOf(answer)
    if (failure !== undefined) throw new Error(failure)
    if (!reply.response.ok) throw new Error(`HTTP ${String(reply.response.status)}`)

    const status = text(answer.status)?.toLowerCase() ?? 'running'
    const file = object(answer.file)
    const url = text(file?.['download_url']) ?? text(file?.['backup_download_url'])
    return {
      status,
      ...url === undefined ? {} : { url },
      done: status === 'success' || url !== undefined,
      failed: status === 'failed' || status === 'fail' || status === 'cancelled',
    }
  },
}

/**
 * The vendor's verdict, which lives in `base_resp` rather than in the HTTP
 * status. Returns undefined when the reply is fine — including the successful
 * case whose `status_msg` is the string `"success"`.
 */
function failureOf(answer: HailuoReply): string | undefined {
  const base = object(answer.base_resp)
  const code = base?.['status_code']
  if (typeof code === 'number' && code !== 0) {
    return text(base?.['status_msg']) ?? `base_resp.status_code=${String(code)}`
  }
  return undefined
}
