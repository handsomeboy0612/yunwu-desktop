/**
 * Turning one prompt into video bytes on the OpenLux route.
 *
 * Video is asynchronous where images are not, and that single difference is
 * what this module exists to absorb: submit returns a task id in about seven
 * seconds, the work then runs for one to six minutes, and the bytes live behind
 * a URL that only appears at the end. Everything below was measured on this
 * route rather than read off a vendor's page:
 *
 * - **The wire contract.** `POST /v1/video/create` with `{model, prompt,
 *   aspect_ratio, duration}` answers `{task_id, status:'queued', size,
 *   seconds}`; `GET /v1/video/query?id=…` walks `queued` → `in_progress`
 *   (with `progress`) → `completed` and only then carries `video_url`. Two live
 *   runs on `veo_3_1-fast`: 100s / 2.30 MB and 118s / 3.46 MB, both
 *   `video/mp4`. The console's own published contract agrees on the entry and
 *   names `prompt` and `model` as the only required fields.
 * - **A local image can be the first frame, with no image host in between.**
 *   The published contract shows `images` as `https://…` URLs and the relay
 *   forwards the body verbatim (`unified_video/adaptor.go` `BuildRequestBody`
 *   marshals the dto; nothing on that path touches base64 or uploads), so only a
 *   live run could answer whether a `data:` URI survives. It does, and upstream
 *   uses it: a 137 KB JPEG of a cat in an alley came back as a clip whose first
 *   frame *is* that photograph. The reply's `detail.input.images` echoes `[""]`
 *   — the echo blanks the long string, it does not strip it, which is worth
 *   knowing before reading that field as evidence of a drop.
 * - **Chinese prompts need no help.** The published contract offers
 *   `enhance_prompt` because "veo 只支持英文提示词", which would make it
 *   mandatory for this product — except a Chinese prompt sent bare came back as
 *   exactly what it described (an orange cat on wet flagstones between
 *   whitewashed Jiangnan walls in morning mist). The switch is also invisible in
 *   the reply: neither `detail.input` nor `enhanced_prompt` echoes it, so there
 *   is no channel on which its effect could be checked. Unverifiable and
 *   unnecessary, so it is not sent.
 * - **A non-mp4 body is refused, not renamed.** The artifact path is announced
 *   before the work starts (see `video-tool.ts`), so its extension is a promise
 *   this module has to keep. Every observed response on this route is mp4; bytes
 *   that are not are reported instead of being written under a name that lies.
 * - **Refusals are legible and are passed through.** An unroutable model
 *   answers HTTP 503 with the groups that have no channel for it, and an
 *   exhausted balance says so. That text is the actionable half of this tool,
 *   for the user and for the model.
 *
 * @module openlux-plugin-account/media/video
 */

import type { Context } from '@deepseek-ai/cordis'
import { AccountRequestError, normalizeBase, requestBytes, requestJson } from '../account/http.ts'
import type { ConsoleAccess } from '../market/console.ts'

/** Budget for the submit round trip; measured at about 7 seconds. */
const SUBMIT_TIMEOUT_MS = 60_000

/** Budget for one status read. */
const POLL_TIMEOUT_MS = 30_000

/** Gap between status reads: fast enough to look live, cheap enough to ignore. */
const POLL_INTERVAL_MS = 5_000

/**
 * How long one generation may run before this module gives up on it.
 *
 * The generous end of what these vendors take: this product's openclaw-era
 * plugin measured 45–380 seconds across thirteen platforms end to end, the slow
 * end being Kling at 318s. Ten minutes leaves that room and still bounds a task
 * the route has forgotten about — and unlike the image tool, waiting costs the
 * user nothing here, because the wait happens inside a background job.
 */
export const GENERATION_DEADLINE_MS = 600_000

/** Budget for pulling the finished file; the bytes already exist. */
const TRANSFER_TIMEOUT_MS = 180_000

/** Ceiling for one artifact. Observed clips are 2–5 MB; 4K would be tens. */
export const MAX_VIDEO_BYTES = 256 * 1024 * 1024

/** Raised when no usable video came back; the message is model-facing. */
export class VideoGenerationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VideoGenerationError'
  }
}

/** What one generation asks for. */
export interface VideoRequest {
  readonly model: string
  readonly prompt: string
  /** `16:9` or `9:16`; the route defaults to landscape when absent. */
  readonly aspectRatio?: string
  readonly durationSeconds?: number
  /**
   * Reference images, newest role first — for this model family, the first
   * frame. Each entry is either an `https://…` URL or a `data:` URI; see
   * {@link generateVideo} for why the local form works.
   */
  readonly images?: readonly string[]
}

/** One finished video, ready to be written to disk. */
export interface GeneratedVideo {
  readonly data: Uint8Array
  readonly mediaType: 'video/mp4'
  readonly taskId: string
  /** Frame size the route reports, e.g. `1280x720`. */
  readonly size?: string
  /** Clip length the route reports, in seconds. */
  readonly seconds?: number
}

/** Progress as the job's own output stream wants it. */
export type VideoProgress = (status: string, percent?: number) => void

/** The submit and query bodies, as far as this module reads them. */
interface VideoTask {
  readonly id?: unknown
  readonly task_id?: unknown
  readonly status?: unknown
  readonly progress?: unknown
  readonly video_url?: unknown
  readonly size?: unknown
  readonly seconds?: unknown
  readonly error?: { readonly message?: unknown } | unknown
  readonly message?: unknown
}

/** Statuses that mean the task will not progress further. */
const FAILED_STATES = new Set(['failed', 'error', 'cancelled', 'canceled'])

/**
 * Generate one video and return its bytes.
 *
 * @param ctx - host context.
 * @param access - route origin and token reader.
 * @param request - what to generate.
 * @param onProgress - called on every status change, for the job's output stream.
 * @param signal - caller cancellation, forwarded to every request.
 * @returns the finished video.
 * @throws {VideoGenerationError} when the route refused, the task failed, or
 * nothing usable arrived inside {@link GENERATION_DEADLINE_MS}.
 */
export async function generateVideo(
  ctx: Context,
  access: ConsoleAccess,
  request: VideoRequest,
  onProgress: VideoProgress,
  signal?: AbortSignal,
): Promise<GeneratedVideo> {
  const token = await access.apiKey()
  if (token === undefined || token === '') {
    throw new VideoGenerationError('当前没有可用的 OpenLux 密钥，请先在侧栏登录账号。')
  }
  const base = `${normalizeBase(access.baseUrl)}/v1`
  const authorization = { 'Authorization': `Bearer ${token}` }

  const submitted = await submit(ctx, base, authorization, request, signal)
  const taskId = text(submitted.task_id) ?? text(submitted.id)
  if (taskId === undefined) {
    throw new VideoGenerationError('视频接口没有返回任务号（task_id），无法跟踪这次生成。')
  }
  onProgress('queued')

  const finished = await poll(ctx, base, authorization, taskId, onProgress, signal)
  const url = text(finished.video_url)
  if (url === undefined) {
    throw new VideoGenerationError(`任务 ${taskId} 报告已完成，但回执里没有视频地址。`)
  }

  onProgress('downloading')
  let data: Uint8Array
  try {
    data = await requestBytes(ctx, url, TRANSFER_TIMEOUT_MS, MAX_VIDEO_BYTES, signal, '视频')
  } catch (error: unknown) {
    throw new VideoGenerationError(error instanceof AccountRequestError
      ? error.message
      : `下载视频失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isMp4(data)) {
    throw new VideoGenerationError(
      `取回的 ${String(data.byteLength)} 字节不是 MP4（前 12 字节 ${hex(data)}），`
      + '这条路线上只见过 MP4，所以没有按 .mp4 存下来。',
    )
  }

  const seconds = Number(finished.seconds ?? submitted.seconds)
  const size = text(finished.size) ?? text(submitted.size)
  return {
    data,
    mediaType: 'video/mp4',
    taskId,
    ...size === undefined ? {} : { size },
    ...Number.isFinite(seconds) && seconds > 0 ? { seconds } : {},
  }
}

/**
 * Hand the request to the route's unified async entry.
 * @param ctx - host context.
 * @param base - route origin including `/v1`.
 * @param authorization - bearer header.
 * @param request - what to generate.
 * @param signal - caller cancellation.
 * @returns the submit reply.
 * @throws {VideoGenerationError} when the route refused the request.
 */
async function submit(
  ctx: Context,
  base: string,
  authorization: Record<string, string>,
  request: VideoRequest,
  signal?: AbortSignal,
): Promise<VideoTask> {
  const body: Record<string, unknown> = {
    model: request.model,
    prompt: request.prompt,
    ...request.aspectRatio === undefined ? {} : { aspect_ratio: request.aspectRatio },
    ...request.durationSeconds === undefined ? {} : { duration: request.durationSeconds },
    ...request.images === undefined || request.images.length === 0 ? {} : { images: [...request.images] },
  }
  let reply
  try {
    reply = await requestJson(ctx, `${base}/video/create`, {
      method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, SUBMIT_TIMEOUT_MS, signal)
  } catch (error: unknown) {
    throw new VideoGenerationError(error instanceof AccountRequestError
      ? error.message
      : `视频提交失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const answer = (reply.body ?? {}) as VideoTask
  if (!reply.response.ok) {
    const detail = messageOf(answer)
    throw new VideoGenerationError(detail === undefined
      ? `视频接口返回 HTTP ${reply.response.status}。`
      : `视频接口拒绝了请求（HTTP ${reply.response.status}）：${detail}`)
  }
  return answer
}

/**
 * Read the task's status until it settles.
 *
 * A single unreadable status is a hiccup, not a verdict — the task keeps running
 * upstream either way — so reads are retried and only a run of them ends the
 * wait. A status that names failure ends it immediately, because nothing else
 * will happen.
 * @param ctx - host context.
 * @param base - route origin including `/v1`.
 * @param authorization - bearer header.
 * @param taskId - the task to watch.
 * @param onProgress - called on every status change.
 * @param signal - caller cancellation.
 * @returns the terminal reply.
 * @throws {VideoGenerationError} when the task failed or never settled.
 */
async function poll(
  ctx: Context,
  base: string,
  authorization: Record<string, string>,
  taskId: string,
  onProgress: VideoProgress,
  signal?: AbortSignal,
): Promise<VideoTask> {
  const until = Date.now() + GENERATION_DEADLINE_MS
  const url = `${base}/video/query?id=${encodeURIComponent(taskId)}`
  let lastSeen = ''
  let consecutiveFaults = 0
  let lastFault = ''

  while (Date.now() < until) {
    await sleep(POLL_INTERVAL_MS, signal)
    let reply
    try {
      reply = await requestJson(ctx, url, { headers: authorization }, POLL_TIMEOUT_MS, signal)
    } catch (error: unknown) {
      if (error instanceof AccountRequestError && error.kind === 'cancelled') throw error
      lastFault = error instanceof Error ? error.message : String(error)
      if ((consecutiveFaults += 1) >= 5) {
        throw new VideoGenerationError(`连续 5 次查不到任务 ${taskId} 的状态：${lastFault}`)
      }
      continue
    }
    const answer = (reply.body ?? {}) as VideoTask
    if (!reply.response.ok) {
      lastFault = messageOf(answer) ?? `HTTP ${reply.response.status}`
      if ((consecutiveFaults += 1) >= 5) {
        throw new VideoGenerationError(`连续 5 次查询任务 ${taskId} 都被拒绝：${lastFault}`)
      }
      continue
    }
    consecutiveFaults = 0

    const status = text(answer.status) ?? ''
    const percent = Number(answer.progress)
    const seen = `${status}:${Number.isFinite(percent) ? String(percent) : ''}`
    if (seen !== lastSeen) {
      lastSeen = seen
      onProgress(status === '' ? 'running' : status, Number.isFinite(percent) ? percent : undefined)
    }
    // The url is the artifact; a status this route has not shown us before is
    // not a reason to discard one that arrived.
    if (status === 'completed' || status === 'succeeded' || text(answer.video_url) !== undefined) return answer
    if (FAILED_STATES.has(status)) {
      const detail = messageOf(answer)
      throw new VideoGenerationError(`任务 ${taskId} ${status === 'cancelled' || status === 'canceled' ? '被取消' : '失败'}`
        + `${detail === undefined ? '。' : `：${detail}`}`)
    }
  }
  throw new VideoGenerationError(
    `任务 ${taskId} 在 ${String(Math.round(GENERATION_DEADLINE_MS / 60_000))} 分钟内没有完成。`
    + '这一般是上游分组一时饱和，隔一会儿再说一次就好。',
  )
}

/** Wait, or give up early when the caller cancels. */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw new AccountRequestError('已取消', 'cancelled')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new AccountRequestError('已取消', 'cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Whether these bytes are an ISO base media file.
 *
 * The `ftyp` box is the format's own self-declaration and sits at offset four;
 * its size prefix makes the first four bytes unusable as a signature.
 * @param data - the complete downloaded body.
 * @returns true when the bytes announce themselves as MP4.
 */
export function isMp4(data: Uint8Array): boolean {
  if (data.byteLength < 12) return false
  return data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70
}

/** Read the console's own wording out of whichever field carried it. */
function messageOf(answer: VideoTask): string | undefined {
  const error = answer.error
  if (typeof error === 'string') return text(error)
  const nested = (error as { message?: unknown } | undefined)?.message
  return text(nested) ?? text(answer.message)
}

/** Read a response field that must be a non-empty string. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** The first twelve bytes, for a message about bytes nobody can identify. */
function hex(data: Uint8Array): string {
  return [...data.subarray(0, 12)].map(byte => byte.toString(16).padStart(2, '0')).join(' ')
}
