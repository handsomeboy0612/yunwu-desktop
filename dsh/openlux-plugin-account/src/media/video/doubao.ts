/**
 * Doubao Seedance: Volcengine Ark's task protocol, on two paths for two families.
 *
 * The catalogue types these models `Doubao video (Async)` and `Doubao video`,
 * and the paths those two declare are different — `/volc/v1/contents/generations/tasks`
 * for the 1.x family, `/api/v3/contents/generations/tasks` for 2.x — while the
 * body and the polling shape are identical. So this is one adapter that reads
 * the path off the endpoint type the catalogue gave the model, the same way the
 * openclaw-era plugin let Vidu pick between its four.
 *
 * **This vendor is not the unified entry, however much its old list said so.**
 * The openclaw-era plugin filed both Doubao types under `/v1/video/create`;
 * sending a live request there on 2026-08-21 was answered
 * `HTTP 429：未找到该模型的定价配置`, because pricing is per route and a model that
 * arrives at the wrong one is refused before a channel is even picked. The paths
 * above come from `models.endpoints` in the platform's own library and from the
 * relay's routing table and integration fixture
 * (`router/relay-router.go`, `controller/relay_integration_test.go`, whose
 * Seedance case posts exactly `{model, content:[{type:'text',text}]}`).
 *
 * The wire contract agrees across Volcengine's own documentation and three
 * independent gateway docs: submit answers `{id}`, the task walks
 * `queued` → `running` → `succeeded`/`failed`, and the artifact is
 * `content.video_url` — a signed link that expires in 24 hours, which is fine
 * here because this plugin downloads immediately.
 *
 * `resolution` is sent explicitly rather than left to the vendor's default, the
 * same call the openclaw-era plugin made for Bailian after measuring 1080P at
 * 162s / 8.56 MB against 720P at 104s / 4.75 MB. `duration` is a range on this
 * family (4–15 on 2.x), not a discrete set, so it is passed through unchecked —
 * declaring a set would refuse lengths the route serves.
 *
 * @module openlux-plugin-account/media/video/doubao
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

/** The endpoint type that routes through the Ark-v3 mount. */
const V3_TYPE = 'Doubao video'

/** Where each family's tasks live, relative to the site root. */
const PATHS = {
  volc: '/volc/v1/contents/generations/tasks',
  v3: '/api/v3/contents/generations/tasks',
} as const

/**
 * The frame size to ask for.
 *
 * 720p is the one both families accept — the 2.0 *fast* variants refuse
 * `1080p` outright — and it is the cheaper, faster half of a choice the caller
 * has no way to express here.
 */
const RESOLUTION = '720p'

/** Statuses that end the task, from Ark's own documented set. */
const DONE = 'succeeded'
const FAILED = new Set(['failed', 'expired', 'cancelled', 'canceled'])

/** The vendor's replies, as far as this module reads them. */
interface ArkTask {
  readonly id?: unknown
  readonly task_id?: unknown
  readonly status?: unknown
  readonly content?: unknown
  readonly error?: unknown
  readonly output?: unknown
  readonly message?: unknown
}

/**
 * Which mount serves this model.
 *
 * The catalogue's endpoint type decides. Without one — the catalogue was
 * unreadable and a fallback name got us here — the family is read off the name,
 * because `-2-0-` is what the platform's own two rows differ by.
 */
function pathFor(model: string, types: readonly string[] | undefined): string {
  if (types !== undefined && types.length > 0) {
    return types.includes(V3_TYPE) ? PATHS.v3 : PATHS.volc
  }
  return model.includes('-2-0-') ? PATHS.v3 : PATHS.volc
}

export const doubaoProvider: VideoProvider = {
  id: 'doubao',
  endpointTypes: ['Doubao video (Async)', V3_TYPE],
  // Both spellings, one per family, so an unreadable catalogue still routes to
  // the right mount. Only names with a live channel on this route are listed.
  fallbackModels: ['doubao-seedance-1-0-pro-250528', 'doubao-seedance-2-0-260128'],

  spec(): VideoModelSpec {
    return { aspects: ['16:9', '9:16'], firstFrame: true }
  },

  async submit(wire: VideoWire, input: VideoSubmitInput): Promise<VideoSubmitted> {
    const path = pathFor(input.model, input.endpointTypes)
    const reference = input.images?.[0]
    // One content array carries prompt and reference alike. `role: 'first_frame'`
    // goes on both mounts: successful 1.x submissions from other callers on this
    // route carry it, so it is not a 2.x-only field.
    const content: Record<string, unknown>[] = [{ type: 'text', text: input.prompt }]
    if (reference !== undefined) {
      content.push({ type: 'image_url', image_url: { url: reference }, role: 'first_frame' })
    }
    const body: Record<string, unknown> = {
      model: input.model,
      content,
      resolution: RESOLUTION,
      ...input.aspectRatio === undefined ? {} : { ratio: input.aspectRatio },
      ...input.durationSeconds === undefined ? {} : { duration: Math.round(input.durationSeconds) },
    }
    let reply
    try {
      reply = await requestJson(wire.ctx, `${wire.root}${path}`, {
        method: 'POST',
        headers: { ...wire.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, SUBMIT_TIMEOUT_MS, wire.signal)
    } catch (error: unknown) {
      throw new VideoGenerationError(error instanceof AccountRequestError
        ? error.message
        : `豆包视频提交失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const answer = (reply.body ?? {}) as ArkTask
    if (!reply.response.ok) {
      const detail = failureOf(answer)
      throw new VideoGenerationError(detail === undefined
        ? `豆包视频接口返回 HTTP ${String(reply.response.status)}。`
        : `豆包视频接口拒绝了请求（HTTP ${String(reply.response.status)}）：${detail}`)
    }
    const taskId = text(answer.id) ?? text(answer.task_id)
    if (taskId === undefined) {
      throw new VideoGenerationError('豆包视频提交没有返回任务号（id），无法跟踪这次生成。')
    }
    return { taskId, handle: path }
  },

  async poll(wire: VideoWire, task: VideoSubmitted): Promise<VideoTaskState> {
    // The mount the submit used, not one derived from the id. Both mounts answer
    // **HTTP 200** for any id: the one that owns the task returns its status,
    // the other returns the stub `{"id":"…"}`. A finished 2.x task read through
    // the 1.x mount therefore looks like a task that is still running, forever —
    // which is exactly what a live run did before this was carried across.
    const path = task.handle ?? PATHS.volc
    const reply = await requestJson(
      wire.ctx,
      `${wire.root}${path}/${encodeURIComponent(task.taskId)}`,
      { headers: wire.headers },
      POLL_TIMEOUT_MS,
      wire.signal,
    )
    const answer = (reply.body ?? {}) as ArkTask
    if (!reply.response.ok) {
      throw new Error(failureOf(answer) ?? `HTTP ${String(reply.response.status)}`)
    }
    const status = text(answer.status)?.toLowerCase() ?? 'running'
    const url = text(object(answer.content)?.['video_url'])
    return {
      status,
      ...url === undefined ? {} : { url },
      done: status === DONE || url !== undefined,
      failed: FAILED.has(status),
      ...failureOf(answer) === undefined ? {} : { failure: failureOf(answer)! },
    }
  },
}

/**
 * The vendor's own wording, out of whichever field carried it.
 *
 * `error` is documented as an object and arrives as a **string** on this route:
 * a real failed task read
 * `{"status":"failed","error":"[OutputAudioSensitiveDetected]…","output":{"message":"…"}}`.
 * Reading only the object form is why the first failure surfaced to the user as
 * "错误信息没有给出具体原因" — for a content-safety refusal, the reason is the
 * whole answer.
 */
function failureOf(answer: ArkTask): string | undefined {
  if (typeof answer.error === 'string') return text(answer.error)
  const error = object(answer.error)
  const output = object(answer.output)
  return text(error?.['message']) ?? text(error?.['code']) ?? text(output?.['message']) ?? text(answer.message)
}
