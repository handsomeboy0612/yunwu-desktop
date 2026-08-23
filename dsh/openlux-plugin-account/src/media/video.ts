/**
 * Turning one prompt into video bytes: the part every vendor shares.
 *
 * Video is asynchronous where images are not, and that single difference is
 * what this module absorbs — submit returns a task id in seconds, the work then
 * runs for one to six minutes, and the bytes live behind a URL that only
 * appears at the end. The vendor-specific half (which path, which body, which
 * completion literal, where the URL hides) lives one directory down in
 * `video/`, one file per vendor; see `video/provider.ts` for why it is shaped
 * that way.
 *
 * Two behaviours here are deliberate and were paid for:
 *
 * - **A single unreadable status is a hiccup, not a verdict.** The task keeps
 *   running upstream either way, so reads are retried and only a run of five
 *   consecutive failures ends the wait.
 * - **A non-mp4 body is reported, not renamed.** The artifact path is announced
 *   before the work starts (see `video-tool.ts`), so its extension is a promise
 *   this module has to keep. Every observed response on this route is mp4.
 *
 * @module openlux-plugin-account/media/video
 */

import type { Context } from '@deepseek-ai/cordis'
import { AccountRequestError, normalizeBase, requestBytes } from '../account/http.ts'
import type { ConsoleAccess } from '../market/console.ts'
import type { VideoProvider, VideoSubmitInput } from './video/provider.ts'
import { VideoGenerationError } from './video/provider.ts'

export { VideoGenerationError } from './video/provider.ts'

/** Gap between status reads: fast enough to look live, cheap enough to ignore. */
const POLL_INTERVAL_MS = 5_000

/** How many status reads may fail in a row before the wait is abandoned. */
const MAX_CONSECUTIVE_FAULTS = 5

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

/**
 * What one generation asks for.
 *
 * The same shape the adapters take, because this module adds nothing to a
 * request — it decides when to ask, not what to ask for.
 */
export type VideoRequest = VideoSubmitInput

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

/**
 * Generate one video and return its bytes.
 *
 * @param ctx - host context.
 * @param access - route origin and token reader.
 * @param provider - the vendor adapter chosen for this model.
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
  provider: VideoProvider,
  request: VideoRequest,
  onProgress: VideoProgress,
  signal?: AbortSignal,
): Promise<GeneratedVideo> {
  const token = await access.apiKey()
  if (token === undefined || token === '') {
    throw new VideoGenerationError('当前没有可用的 OpenLux 密钥，请先在侧栏登录账号。')
  }
  const root = normalizeBase(access.baseUrl)
  const wire = {
    ctx,
    root,
    base: `${root}/v1`,
    headers: { Authorization: `Bearer ${token}` },
    ...signal === undefined ? {} : { signal },
  }

  const submitted = await provider.submit(wire, request)
  onProgress('queued')

  const until = Date.now() + GENERATION_DEADLINE_MS
  let lastSeen = ''
  let faults = 0
  let lastFault = ''
  let url: string | undefined
  let size = submitted.size
  let seconds = submitted.seconds

  while (Date.now() < until) {
    await sleep(POLL_INTERVAL_MS, signal)
    let state
    try {
      state = await provider.poll(wire, submitted)
    } catch (error: unknown) {
      if (error instanceof AccountRequestError && error.kind === 'cancelled') throw error
      lastFault = error instanceof Error ? error.message : String(error)
      if ((faults += 1) >= MAX_CONSECUTIVE_FAULTS) {
        throw new VideoGenerationError(
          `连续 ${String(MAX_CONSECUTIVE_FAULTS)} 次查不到任务 ${submitted.taskId} 的状态：${lastFault}`,
        )
      }
      continue
    }
    faults = 0

    const seen = `${state.status}:${state.percent === undefined ? '' : String(state.percent)}`
    if (seen !== lastSeen) {
      lastSeen = seen
      onProgress(state.status, state.percent)
    }
    size = state.size ?? size
    seconds = state.seconds ?? seconds
    if (state.failed) {
      throw new VideoGenerationError(`任务 ${submitted.taskId} 失败${state.failure === undefined ? '。' : `：${state.failure}`}`)
    }
    if (state.done) {
      url = state.url
      break
    }
  }

  if (url === undefined) {
    throw new VideoGenerationError(lastSeen === ''
      ? `任务 ${submitted.taskId} 在 ${String(Math.round(GENERATION_DEADLINE_MS / 60_000))} 分钟内没有完成。这一般是上游分组一时饱和，隔一会儿再说一次就好。`
      : `任务 ${submitted.taskId} 报告已完成（${lastSeen}），但回执里没有视频地址。`)
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

  return {
    data,
    mediaType: 'video/mp4',
    taskId: submitted.taskId,
    ...size === undefined ? {} : { size },
    ...seconds === undefined ? {} : { seconds },
  }
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

/** The first twelve bytes, for a message about bytes nobody can identify. */
function hex(data: Uint8Array): string {
  return [...data.subarray(0, 12)].map(byte => byte.toString(16).padStart(2, '0')).join(' ')
}
