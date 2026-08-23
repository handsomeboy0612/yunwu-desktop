/**
 * Vidu: four routes upstream, two of which this tool's vocabulary can express.
 *
 * ## Which two, and why not the other two
 *
 * Vidu splits by *what you hand it*, one path each: text only, one first frame,
 * two frames (first and last), or a subject reference of up to seven pictures.
 * This tool hands a provider a prompt and **at most one** image
 * (`media/video-tool.ts:350`), so first-and-last-frame is unreachable for want of
 * a second picture and reference-to-video for want of a subject vocabulary. Both
 * are left unclaimed rather than approximated: sending one picture to a route
 * that wants two is a 400, and sending it as a "subject" films something else
 * than the animation that was asked for.
 *
 * Consequently `endpointTypes` lists exactly the two that work. A model carrying
 * only `Vidu reference to video` (`viduq3`, `viduq3-mix`, `viduq2-pro` today)
 * therefore falls to the registry's "no adapter for this one" refusal, which is
 * the truth.
 *
 * ## The mode is in the endpoint type, not in the name
 *
 * `viduq2` films from text but not from a picture; `viduq3-turbo` does both;
 * `viduq3` does neither. Nothing about the names says so, which is why
 * {@link VideoProvider.spec} is given the catalogue's types — without them the
 * refusal for "animate this picture with viduq2" could only happen once the
 * background job had started, six minutes after the turn it belonged to.
 *
 * ## Verified live on 2026-08-21, both routes, one model
 *
 * `viduq3-turbo` at 540p/4s:
 *
 * | | submit | finished | artifact |
 * |---|---|---|---|
 * | text to video | HTTP 200 in 1s | 36s | mp4 |
 * | image to video | HTTP 200 in 12s (it uploads the reference) | 46s, 28 credits | mp4 |
 *
 * Two properties fell out of that run and both would have been guesses:
 *
 * 1. **The two routes are not served by the same upstream.** The text clip came
 *    back from a Tencent VCLM bucket and the image one from Vidu's own S3, and
 *    their submit echoes differ accordingly — the text one answers with three
 *    fields and no `credits`, the image one echoes the whole request. Which
 *    channel serves what is the relay's business, so nothing here may depend on
 *    the richer shape.
 * 2. **The path is `/ent/v2/img2video`.** The request type's own doc comment
 *    says `image2video` (`new-yunwu-api/dto/vidu.go:70`), but the router
 *    registers the short spelling and the adaptor matches on it; the long one
 *    404s.
 *
 * ## What is deliberately not declared here
 *
 * A duration whitelist. The relay does not refuse an unlisted length, it
 * *corrects* it per model (`relay/channel/task/vidu/models.go:481`
 * `CorrectDuration`, likewise `CorrectResolution` and `CorrectAspectRatio`), so
 * a local set — per this module's contract, only for vendors that reject — would
 * refuse lengths the route in fact serves.
 *
 * @module openlux-plugin-account/media/video/vidu
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

/**
 * Generous because this one carries the reference picture in its body, and that
 * leg scales with the picture: a 1.5 MB reference submitted in 12s here, while
 * the same measurement on Bailian's route showed a 9.4 MB one taking up to 173s
 * (see `bailian.ts`). A text submit answers in about a second either way, so the
 * larger budget is only ever spent when there is something to spend it on.
 */
const SUBMIT_TIMEOUT_MS = 300_000

const POLL_TIMEOUT_MS = 30_000

/** The catalogue's name for the text path. */
const TEXT_TYPE = 'Vidu text to video'

/** The catalogue's name for the first-frame path. */
const IMAGE_TYPE = 'Vidu image to video'

/**
 * Frame shapes, from the relay's own table (`models.go:694` `CorrectAspectRatio`).
 *
 * Unlike durations this one is worth carrying: an unsupported ratio is not
 * corrected towards what was asked for, it is replaced by the model's default —
 * so a portrait request would come back landscape without a word. Refusing by
 * name says which shapes exist instead.
 */
const WIDE_ASPECTS = ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9', '2:1', '3:2'] as const
const BASE_ASPECTS = ['16:9', '9:16', '1:1', '3:4', '4:3'] as const

/** States that mean the task is still being filmed. */
const RUNNING = new Set(['created', 'queueing', 'processing'])

export const viduProvider: VideoProvider = {
  id: 'vidu',
  endpointTypes: [TEXT_TYPE, IMAGE_TYPE],
  // Only the name that has actually produced a clip on this key. This list is
  // used when the catalogue cannot be read, which is the worst moment to be
  // sending a paid request down a path nobody has walked.
  fallbackModels: ['viduq3-turbo'],

  spec(model: string, types: readonly string[]): VideoModelSpec {
    return {
      aspects: [...model.startsWith('viduq2') ? WIDE_ASPECTS : BASE_ASPECTS],
      // With no catalogue there is nothing to narrow by, and claiming the
      // capability keeps a readable route working; `submit` still refuses if the
      // model turns out not to have it.
      firstFrame: types.length === 0 || types.includes(IMAGE_TYPE),
      // `img2video` has no aspect field; measured 2026-08-21, a 2048×2048 source
      // came back a 960×960 clip.
      referenceDecidesShape: true,
    }
  },

  async submit(wire: VideoWire, input: VideoSubmitInput): Promise<VideoSubmitted> {
    const reference = input.images?.[0]
    const types = input.endpointTypes ?? []
    const known = types.length > 0

    if (reference !== undefined && known && !types.includes(IMAGE_TYPE)) {
      throw new VideoGenerationError(
        `Vidu「${input.model}」不能用图片当首帧（它只有${types.includes(TEXT_TYPE) ? '文生视频' : '参考生视频'}那条路）。`
        + '图生视频请用 viduq3-turbo、viduq3-pro、viduq2-turbo、viduq1、viduq1-classic 或 vidu2.0。',
      )
    }
    if (reference === undefined && known && !types.includes(TEXT_TYPE)) {
      throw new VideoGenerationError(
        `Vidu「${input.model}」不做纯文字出片。`
        + `${types.includes(IMAGE_TYPE) ? '给它一张图当首帧就能用；' : ''}`
        + '纯文字请用 viduq3-turbo、viduq3-pro、viduq2 或 viduq1。',
      )
    }

    const animating = reference !== undefined
    const body: Record<string, unknown> = {
      model: input.model,
      prompt: input.prompt,
      ...input.durationSeconds === undefined ? {} : { duration: Math.round(input.durationSeconds) },
      ...animating
        // The first frame decides the clip's shape here — this route has no
        // `aspect_ratio` field at all (`dto/vidu.go:72-90`), and the live echo
        // came back with it blank.
        ? { images: [reference] }
        : input.aspectRatio === undefined ? {} : { aspect_ratio: input.aspectRatio },
    }

    let reply
    try {
      reply = await requestJson(wire.ctx, `${wire.root}/ent/v2/${animating ? 'img2video' : 'text2video'}`, {
        method: 'POST',
        headers: { ...wire.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, SUBMIT_TIMEOUT_MS, wire.signal)
    } catch (error: unknown) {
      throw new VideoGenerationError(error instanceof AccountRequestError
        ? error.message
        : `Vidu 视频提交失败：${error instanceof Error ? error.message : String(error)}`)
    }

    const answer = object(reply.body) ?? {}
    if (!reply.response.ok) {
      throw new VideoGenerationError(`Vidu 视频提交失败（HTTP ${String(reply.response.status)}）：`
        + `${complaint(answer) ?? '上游没有给出原因'}`)
    }
    const taskId = text(answer['task_id']) ?? text(answer['id'])
    if (taskId === undefined) {
      throw new VideoGenerationError('Vidu 视频提交没有返回任务号，无法跟踪这次生成。')
    }
    // Only the image route echoes the request back; the text one answers with
    // three fields, so both of these are routinely absent.
    const resolution = text(answer['resolution'])
    const seconds = answer['duration']
    return {
      taskId,
      ...resolution === undefined ? {} : { size: resolution },
      ...typeof seconds === 'number' && seconds > 0 ? { seconds } : {},
    }
  },

  async poll(wire: VideoWire, task: VideoSubmitted): Promise<VideoTaskState> {
    const reply = await requestJson(
      wire.ctx,
      `${wire.root}/ent/v2/tasks/${encodeURIComponent(task.taskId)}/creations`,
      { headers: wire.headers },
      POLL_TIMEOUT_MS,
      wire.signal,
    )
    if (!reply.response.ok) throw new Error(`HTTP ${String(reply.response.status)}`)
    const answer = object(reply.body) ?? {}
    const status = text(answer['state'])?.toLowerCase() ?? 'created'
    const first = object((answer['creations'] as readonly unknown[] | undefined)?.[0])
    const url = text(first?.['url'])
    const clip = object(first?.['video'])
    const seconds = clip?.['duration']
    const failure = complaint(answer)

    return {
      status,
      ...typeof answer['progress'] === 'number' ? { percent: answer['progress'] } : {},
      ...url === undefined ? {} : { url },
      ...typeof seconds === 'number' && seconds > 0 ? { seconds } : {},
      ...failure === undefined ? {} : { failure },
      done: status === 'success',
      // Anything terminal that is not success: naming the states that mean
      // "still filming" and treating the rest as over is what keeps an
      // unfamiliar verdict from being polled until the budget runs out.
      failed: !RUNNING.has(status) && status !== 'success',
    }
  },
}

/**
 * Vidu's own words for a failure.
 *
 * `err_msg` on a polled task, `message` on a refused submit; both are empty
 * strings the rest of the time, which `text` already reads as absent.
 * @param answer - the response body.
 * @returns the complaint, or undefined when it said nothing.
 */
function complaint(answer: Record<string, unknown>): string | undefined {
  return text(answer['err_msg']) ?? text(answer['message']) ?? text(answer['error'])
}
