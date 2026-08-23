/**
 * Aliyun Bailian: two families, three catalogue names, one route.
 *
 * Happyhorse and Wan are the same channel upstream — the relay's model list has
 * them side by side (`relay/channel/task/ali/bailain/models.go`) and they share a
 * path, a body and a set of status literals. The catalogue spells the entry
 * three ways (`Happyhorse video` for the 1.0 family, `happyhorse视频` for 1.1,
 * `Wan video generation` for Wan), so all three are claimed here.
 *
 * ## The mode is in the model name, and the relay decides it by exact match
 *
 * `GetModelAction` (`models.go:21-32`) reads `-t2v` as text, `-r2v` as reference,
 * `happyhorse-1.0-video-edit` as video editing, and **everything else** as
 * image-to-video — which is how the Wan names, none of them listed, end up on
 * the image branch. Reference-to-video and video editing are other capabilities
 * (`Validate` wants a `reference_image` or a public `video` URL,
 * `dto/ali/bailian/bailian.go:188-211`), so they stay unclaimed and fall to the
 * registry's honest "nothing here drives that one".
 *
 * Claims are by exact name rather than by suffix because the relay's switch is:
 * a hypothetical `happyhorse-1.2-t2v` would fall to its default branch and be
 * refused for want of a picture, so guessing from the suffix would produce
 * exactly the confident wrong answer this file is trying to avoid. Wan is the
 * one prefix, because every `wan*` name lands on that same default.
 *
 * ## Body shape, and the three fields worth explaining
 *
 * Three levels — `{model, input:{prompt, img_url}, parameters:{…}}` — where every
 * other vendor on this route is flat.
 *
 * - **`resolution` is sent explicitly as 720P.** Left out, `Normalize` fills in
 *   1080P (`bailian.go:234-235`), which is slower and dearer; the openclaw-era
 *   measurement was 162s/8.56MB against 104s/4.75MB. Only those two values
 *   exist — anything else is refused as `resolution_not_supported`
 *   (`relay_tasks/ali/bailian/duration/task.go:60-69`).
 * - **The shape field is `ratio`, not `aspect_ratio`**, and nothing validates
 *   it; the upstream is the only judge, so this file claims only shapes that
 *   have been measured.
 * - **`img_url` takes a data URI.** The field reads like it wants a public URL
 *   and the openclaw-era note said so, but that half was never exercised — this
 *   tool has bytes, not URLs. Measured 2026-08-21: a 1.5 MB data URI was
 *   accepted and filmed. (`Normalize` moves it into `media[{type:first_frame}]`,
 *   which is what `Validate` then looks for.)
 *
 * ## Verified live on 2026-08-21, 720P, 3 seconds
 *
 * | | submit | finished | artifact |
 * |---|---|---|---|
 * | `happyhorse-1.0-t2v`, `ratio:16:9` | HTTP 200 in 1s | 96s | 1280×720, 1.19 MB |
 * | `happyhorse-1.0-i2v`, square source | HTTP 200 in 12s | 87s | **960×960**, 1.41 MB |
 * | `happyhorse-1.0-i2v`, no picture | HTTP 500 in 1s | — | `必须提供 first_frame 媒体` |
 *
 * The middle row is why {@link VideoModelSpec.referenceDecidesShape} is set: that
 * run asked for `16:9` and got the source's square back. The image route ignores
 * `ratio` entirely, so a tool that reported the requested shape would be telling
 * the user something the artifact contradicts.
 *
 * The last row is the reason the refusals below are worth having locally even
 * though the route also produces them: it arrives before anything is charged,
 * but only after the background job has started, which is minutes after the turn
 * where the user could have done something about it.
 *
 * @module openlux-plugin-account/media/video/bailian
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

/** Enough for a submit that carries nothing but text. */
const SUBMIT_TIMEOUT_MS = 120_000

/**
 * Budget for a submit that carries a picture, which is a different order of
 * wait: the base64 reference is uploaded on this leg, and the wait scales with
 * it. Measured 2026-08-21 with one 2048×2048 PNG (7.03 MB, 9.37 MB once
 * encoded) — happyhorse answered in 51s and Wan in **173s**, both HTTP 200,
 * against 3–4s for the same picture downscaled to 0.16 MB.
 *
 * A live run through the client failed twice before this existed: the tool sent
 * a freshly generated 7 MB first frame, the 120s budget expired mid-upload, and
 * the user was told the account service had timed out — for a request the route
 * was in the middle of accepting.
 *
 * The real fix is to stop sending a 7 MB picture at all, since every vendor here
 * films at 720p or 1080p and none of them needs four megapixels. That needs an
 * encoder: `sharp` is in the app's tree but not resolvable from this package's
 * real path, and adding a second native copy is a packaging change nobody can
 * verify from here. Until then the wait is honest rather than fatal.
 */
const SUBMIT_WITH_IMAGE_TIMEOUT_MS = 300_000

const POLL_TIMEOUT_MS = 30_000

/** The cheaper of the two sizes the relay accepts; see the module note. */
const RESOLUTION = '720P'

/** Models the relay routes to `text_to_video` (`models.go:21-32`). */
const TEXT_MODELS = new Set(['happyhorse-1.0-t2v', 'happyhorse-1.1-t2v'])

/** Happyhorse models on the relay's image branch. Wan is matched by prefix. */
const IMAGE_MODELS = new Set(['happyhorse-1.0-i2v', 'happyhorse-1.1-i2v'])

/**
 * Clip lengths, as ranges rather than sets because that is how the relay checks
 * them: 3–15 for happyhorse and 2–15 for everything else on this channel
 * (`relay_tasks/ali/bailian/duration/task.go:119-125`), refused with HTTP 400.
 */
const HAPPYHORSE_SECONDS = [3, 15] as const
const WAN_SECONDS = [2, 15] as const

/**
 * Frame shapes for the text route.
 *
 * Nothing on the platform side validates this field — the relay carries `Ratio
 * string` and checks only duration and resolution — so an unknown value is not
 * refused, it is answered with the vendor's default shape and no word about the
 * substitution. The set is the one the platform's own API export declares for
 * this operation (docs bundle, `apifoxApiId` 453308090), of which `16:9`
 * (1280×720) and `1:1` (960×960) were filmed on 2026-08-21 and `9:16` on
 * 2026-08-13.
 */
const ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const

/** Terminal states other than success (`dto/ali/bailian/bailian.go:16-21`). */
const FAILED = new Set(['failed', 'canceled', 'unknown'])

/** Whether the relay drives this name from a picture. */
function animates(model: string): boolean {
  return IMAGE_MODELS.has(model) || model.startsWith('wan')
}

export const bailianProvider: VideoProvider = {
  id: 'bailian',
  endpointTypes: ['Happyhorse video', 'happyhorse视频', 'Wan video generation'],
  // The one name that has produced a clip on this key.
  fallbackModels: ['happyhorse-1.0-t2v'],

  claims: model => TEXT_MODELS.has(model) || animates(model),

  spec(model: string): VideoModelSpec {
    const filmsFromPicture = animates(model)
    return {
      durationRange: [...model.startsWith('wan') ? WAN_SECONDS : HAPPYHORSE_SECONDS],
      aspects: [...ASPECTS],
      firstFrame: filmsFromPicture,
      requiresFirstFrame: filmsFromPicture,
      // Only true of the image route, and the text route never consults it.
      referenceDecidesShape: filmsFromPicture,
    }
  },

  async submit(wire: VideoWire, input: VideoSubmitInput): Promise<VideoSubmitted> {
    const reference = input.images?.[0]
    const filmsFromPicture = animates(input.model)
    if (filmsFromPicture && reference === undefined) {
      throw new VideoGenerationError(
        `「${input.model}」只做图生视频，需要一张图当首帧；纯文字出片请用 happyhorse-1.0-t2v 或 happyhorse-1.1-t2v。`,
      )
    }
    if (!filmsFromPicture && reference !== undefined) {
      throw new VideoGenerationError(
        `「${input.model}」只做文生视频，用不了首帧图；想让这张图动起来请用 happyhorse-1.0-i2v、happyhorse-1.1-i2v 或 wan2.6-i2v。`,
      )
    }

    const body = {
      model: input.model,
      input: {
        prompt: input.prompt,
        // `Normalize` moves this into `media[{type:'first_frame'}]` for
        // happyhorse while Wan reads the field directly (`bailian.go:136-154`),
        // so one spelling serves both.
        ...reference === undefined ? {} : { img_url: reference },
      },
      parameters: {
        ...input.durationSeconds === undefined ? {} : { duration: Math.round(input.durationSeconds) },
        resolution: RESOLUTION,
        // Happyhorse burns "Happy Horse" into the bottom right corner unless
        // told not to, and the artifact name says `…_watermark.mp4` either way,
        // so nothing downstream would have noticed. Verified by comparing frames
        // of two clips (2026-08-21). Wan already defaults this off; sending it
        // costs nothing there.
        watermark: false,
        // Absent on the image route by design: it is ignored there, and sending
        // an ignored shape is how a caller ends up believing it was honoured.
        ...filmsFromPicture || input.aspectRatio === undefined ? {} : { ratio: input.aspectRatio },
      },
    }

    let reply
    try {
      reply = await requestJson(
        wire.ctx,
        `${wire.root}/alibailian/api/v1/services/aigc/video-generation/video-synthesis`,
        { method: 'POST', headers: { ...wire.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        reference === undefined ? SUBMIT_TIMEOUT_MS : SUBMIT_WITH_IMAGE_TIMEOUT_MS,
        wire.signal,
      )
    } catch (error: unknown) {
      throw new VideoGenerationError(error instanceof AccountRequestError
        ? error.message
        : `百炼视频提交失败：${error instanceof Error ? error.message : String(error)}`)
    }

    const answer = object(reply.body) ?? {}
    if (!reply.response.ok) {
      throw new VideoGenerationError(`百炼视频提交失败（HTTP ${String(reply.response.status)}）：`
        + `${complaint(answer) ?? '上游没有给出原因'}`)
    }
    const taskId = text(object(answer['output'])?.['task_id'])
    if (taskId === undefined) {
      throw new VideoGenerationError('百炼视频提交没有返回任务号，无法跟踪这次生成。')
    }
    return { taskId }
  },

  async poll(wire: VideoWire, task: VideoSubmitted): Promise<VideoTaskState> {
    // The relay rewrites this to the vendor's `/api/v1/tasks/:id`
    // (`ali/bailain/adaptor.go`); the short spelling is the one it routes.
    const reply = await requestJson(
      wire.ctx,
      `${wire.root}/alibailian/tasks/${encodeURIComponent(task.taskId)}`,
      { headers: wire.headers },
      POLL_TIMEOUT_MS,
      wire.signal,
    )
    const answer = object(reply.body) ?? {}
    if (!reply.response.ok) throw new Error(complaint(answer) ?? `HTTP ${String(reply.response.status)}`)

    const output = object(answer['output']) ?? {}
    // Uppercase here where every other vendor on this route is lower; compared
    // folded rather than trusted either way.
    const status = text(output['task_status'])?.toLowerCase() ?? 'pending'
    const url = text(output['video_url'])
    const failure = complaint(answer)
    return {
      status,
      ...url === undefined ? {} : { url },
      ...failure === undefined ? {} : { failure },
      done: status === 'succeeded' || url !== undefined,
      failed: FAILED.has(status),
    }
  },
}

/**
 * The vendor's words for a failure, which arrive at either of two levels: on the
 * task (`output.code` / `output.message`) or on the request itself, where a
 * malformed body answers `{"code":"build_request_body_failed","message":"…"}`
 * under HTTP 500 (measured 2026-08-21).
 *
 * @param answer - the response body.
 * @returns the complaint, or undefined when the reply carried none.
 */
function complaint(answer: Record<string, unknown>): string | undefined {
  const output = object(answer['output'])
  return text(output?.['message']) ?? text(output?.['code'])
    ?? text(answer['message']) ?? text(answer['code'])
}
