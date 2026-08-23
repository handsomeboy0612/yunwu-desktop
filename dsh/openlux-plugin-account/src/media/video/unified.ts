/**
 * The route's unified async entry: one path, several vendor families behind it.
 *
 * `POST /v1/video/create` with `{model, prompt, aspect_ratio, duration}` answers
 * `{task_id, status:'queued'}`; `GET /v1/video/query?id=…` walks `queued` →
 * `in_progress` → `completed` and only then carries `video_url`. Two live runs
 * on `veo_3_1-fast`: 100s / 2.30 MB and 118s / 3.46 MB, both `video/mp4`.
 *
 * A local image can be the clip's first frame with no image host in between:
 * the relay forwards the body verbatim (`unified_video/adaptor.go`
 * `BuildRequestBody` marshals the dto and nothing on that path touches base64),
 * and a 137 KB JPEG sent as a `data:` URI came back as a clip whose first frame
 * is that photograph. The reply's `detail.input.images` echoes `[""]` — the echo
 * blanks the long string rather than dropping it, which is worth knowing before
 * reading that field as evidence.
 *
 * `enhance_prompt` is offered by the published contract because "veo 只支持英文
 * 提示词", and is deliberately not sent: a bare Chinese prompt came back as
 * exactly what it described, and neither `detail.input` nor `enhanced_prompt`
 * echoes the switch, so there is no channel on which its effect could be
 * checked. Unverifiable and unnecessary.
 *
 * @module openlux-plugin-account/media/video/unified
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

/** Budget for the submit round trip; measured at about 7 seconds. */
const SUBMIT_TIMEOUT_MS = 60_000

/** Budget for one status read. */
const POLL_TIMEOUT_MS = 30_000

/**
 * The shapes this entry accepts, shared by every family behind it.
 *
 * Both are the route's own published contract rather than a per-model
 * measurement, because the entry validates them before it knows which vendor
 * will run the job.
 */
const ASPECTS = ['16:9', '9:16']

/**
 * Clip lengths that are enforced locally, keyed by model.
 *
 * Only two families have a discrete legal set anyone can point at: the veo
 * family answered `4/6/8` and echoes it back in `detail.input`, and sora's set
 * is written down in the relay (`relay_tasks/sora/duration_validate.go`, shared
 * with `/v1/videos`). Everything else behind this entry — the Doubao seedance
 * family in particular — has no whitelist we can cite, so its length is passed
 * through and the route answers. Declaring a guessed set would refuse lengths
 * the route in fact serves, which is the worse failure of the two.
 */
const DURATIONS: Record<string, readonly number[]> = {
  'veo_3_1': [4, 6, 8],
  'veo_3_1-fast': [4, 6, 8],
  'veo_3_1-components': [4, 6, 8],
  'sora-2': [4, 8, 12],
  'sora-2-pro': [4, 8, 12],
}

/**
 * Models whose reference images are a *set* the vendor composes from rather
 * than a clip's opening frame.
 *
 * `veo_3_1-components` takes one to three of them, which is a different
 * promise from "this picture is frame one" and is unmeasured here — offering it
 * under the first-frame argument would be describing a shape nobody verified.
 */
const NOT_FIRST_FRAME = new Set(['veo_3_1-components'])

/**
 * `size` is required for sora on this entry and is refused at the adaptor's
 * first check (`unified_video/adaptor.go`: `size is required for sora-2`), so
 * the aspect the caller asked for is folded into one of the two 720p values the
 * handler accepts (`relay_tasks/sora/handler.go`).
 */
const SORA_SIZE: Record<string, string> = {
  '16:9': '1280x720',
  '9:16': '720x1280',
}

/** Statuses that mean the task will not progress further. */
const FAILED = new Set(['failed', 'error', 'cancelled', 'canceled'])

/** The submit and query bodies, as far as this module reads them. */
interface UnifiedTask {
  readonly id?: unknown
  readonly task_id?: unknown
  readonly status?: unknown
  readonly progress?: unknown
  readonly video_url?: unknown
  readonly size?: unknown
  readonly seconds?: unknown
  readonly error?: unknown
  readonly message?: unknown
}

export const unifiedProvider: VideoProvider = {
  id: 'unified',
  // Three names for one entry. `OpenAI video format` is what this key's veo
  // family carries today; the other two are names the platform has used for the
  // same entry elsewhere and cost one line each to keep working.
  //
  // The Doubao types deliberately are **not** here, and that is worth a note
  // because the openclaw-era plugin did list them: on today's data they declare
  // `/volc/v1/contents/generations/tasks` and `/api/v3/contents/generations/tasks`,
  // which are their own vendor route rather than this entry. Claiming them sent
  // a live request through here and the route answered
  // `HTTP 429：未找到该模型的定价配置` — priced per route, so a model reaching the
  // wrong entry is refused before any channel is picked. Endpoint types are read
  // off `models.endpoints`, not inherited from an older build's list.
  endpointTypes: [
    'OpenAI video format',
    'Unified video format',
    'Grok video',
  ],
  fallbackModels: ['veo_3_1-fast', 'veo_3_1', 'veo_3_1-components'],

  spec(model: string): VideoModelSpec {
    return {
      ...DURATIONS[model] === undefined ? {} : { durations: DURATIONS[model] },
      aspects: ASPECTS,
      firstFrame: !NOT_FIRST_FRAME.has(model),
    }
  },

  async submit(wire: VideoWire, input: VideoSubmitInput): Promise<VideoSubmitted> {
    const aspect = input.aspectRatio ?? '16:9'
    const body: Record<string, unknown> = {
      model: input.model,
      prompt: input.prompt,
      aspect_ratio: aspect,
      ...input.durationSeconds === undefined ? {} : { duration: Math.round(input.durationSeconds) },
      ...input.images === undefined || input.images.length === 0 ? {} : { images: [...input.images] },
      ...input.model.startsWith('sora') ? { size: SORA_SIZE[aspect] ?? SORA_SIZE['16:9'] } : {},
    }
    let reply
    try {
      reply = await requestJson(wire.ctx, `${wire.base}/video/create`, {
        method: 'POST',
        headers: { ...wire.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, SUBMIT_TIMEOUT_MS, wire.signal)
    } catch (error: unknown) {
      throw new VideoGenerationError(error instanceof AccountRequestError
        ? error.message
        : `视频提交失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const answer = (reply.body ?? {}) as UnifiedTask
    if (!reply.response.ok) {
      const detail = messageOf(answer)
      throw new VideoGenerationError(detail === undefined
        ? `视频接口返回 HTTP ${String(reply.response.status)}。`
        : `视频接口拒绝了请求（HTTP ${String(reply.response.status)}）：${detail}`)
    }
    const taskId = text(answer.task_id) ?? text(answer.id)
    if (taskId === undefined) {
      throw new VideoGenerationError('视频接口没有返回任务号（task_id），无法跟踪这次生成。')
    }
    const seconds = Number(answer.seconds)
    return {
      taskId,
      ...text(answer.size) === undefined ? {} : { size: text(answer.size)! },
      ...Number.isFinite(seconds) && seconds > 0 ? { seconds } : {},
    }
  },

  async poll(wire: VideoWire, task: VideoSubmitted): Promise<VideoTaskState> {
    const reply = await requestJson(
      wire.ctx,
      `${wire.base}/video/query?id=${encodeURIComponent(task.taskId)}`,
      { headers: wire.headers },
      POLL_TIMEOUT_MS,
      wire.signal,
    )
    const answer = (reply.body ?? {}) as UnifiedTask
    if (!reply.response.ok) {
      throw new Error(messageOf(answer) ?? `HTTP ${String(reply.response.status)}`)
    }
    const status = text(answer.status) ?? ''
    const percent = Number(answer.progress)
    const url = text(answer.video_url)
    const seconds = Number(answer.seconds)
    return {
      status: status === '' ? 'running' : status,
      ...Number.isFinite(percent) ? { percent } : {},
      ...url === undefined ? {} : { url },
      // The url is the artifact; a status this route has not shown us before is
      // not a reason to discard one that arrived.
      done: status === 'completed' || status === 'succeeded' || url !== undefined,
      failed: FAILED.has(status),
      ...messageOf(answer) === undefined ? {} : { failure: messageOf(answer)! },
      ...text(answer.size) === undefined ? {} : { size: text(answer.size)! },
      ...Number.isFinite(seconds) && seconds > 0 ? { seconds } : {},
    }
  },
}

/** Read the console's own wording out of whichever field carried it. */
function messageOf(answer: UnifiedTask): string | undefined {
  const error = answer.error
  if (typeof error === 'string') return text(error)
  return text(object(error)?.message) ?? text(answer.message)
}
