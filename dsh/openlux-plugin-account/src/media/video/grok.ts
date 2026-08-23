/**
 * Grok Imagine video, on xAI's own route rather than the unified entry.
 *
 * ## Why this is a provider and not one more string in `unified.ts`
 *
 * The unified entry answers grok requests — `POST /v1/video/create` with
 * `{"model":"grok-imagine-video"}` comes back in that entry's own error shape,
 * which reads exactly like membership. It is not: the catalogue's `endpoints`
 * for both grok rows say **`官方格式` → `POST /v1/videos/generations`**, the
 * xAI-native path with its own request body, its own completion literal and its
 * own error envelope. One probe's tolerance is not a routing decision; the
 * catalogue is.
 *
 * ## The one route in this directory that hangs off `/v1`
 *
 * Every other vendor-specific path here is mounted at the site root
 * (`/kling/…`, `/minimax/…`, `/ent/v2/…`). This one is under `/v1`, so it uses
 * {@link VideoWire.base} where its neighbours use `root`. Getting that wrong
 * produces a 404 that reads like a missing task.
 *
 * ## Five required fields, and a model that cannot film from words
 *
 * `model` / `prompt` / `aspect_ratio` / `resolution` / `duration` are all
 * mandatory (`relay/channel/task/xaivideo/adaptor.go:84-96`) — including the two
 * this tool treats as optional, so defaults are chosen here rather than left
 * out. Verified live on 2026-08-21, each case refused locally by the relay,
 * nothing filmed and nothing billed:
 *
 * | sent | answer |
 * |---|---|
 * | `resolution: '1080p'` | `resolution 1080p is not supported yet` |
 * | `grok-imagine-video-1.5-preview`, no image | `only supports image-to-video, image is required` |
 * | same, but with an image | gets past that guard, fails on the poisoned resolution |
 * | `duration: 99` | `duration must be in range [1, 15]` |
 *
 * Those complaints come from the relay's own validator, which runs *after*
 * channel selection — so they are also proof that this key has a channel here.
 *
 * ## Two shapes that differ from every other vendor in this directory
 *
 * 1. **The reference picture is an object**, `image: { url }`, not a bare string
 *    (`xaiMediaRef` accepts `url` / `image_url` / `file_id`, `models.go:124-136`).
 * 2. **A refusal carries a string `code`** (`{"code":"invalid_request"}`), where
 *    Kling's is the number zero on success. Reusing that judgement here would
 *    read every grok answer as a failure, so success is judged by the presence
 *    of `request_id` — which is all a successful submit returns.
 *
 * @module openlux-plugin-account/media/video/grok
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

/** Generous because a reference picture rides along in the body as a data URI. */
const SUBMIT_TIMEOUT_MS = 300_000

const POLL_TIMEOUT_MS = 30_000

/**
 * The catalogue's name for this path. It is generic enough to be worth
 * narrowing — see {@link grokProvider.claims}.
 */
const ENDPOINT_TYPE = '官方格式'

/**
 * `480p` and `720p` are the only two the relay prices, and `1080p` has an
 * explicit "not supported yet" (`adaptor.go:99-104`). Nothing in this tool's
 * vocabulary asks for a resolution, so the better of the two is fixed here.
 */
const RESOLUTION = '720p'

/** From the platform's own picker, which its comment ties to what it sends. */
const ASPECTS = ['16:9', '9:16', '1:1'] as const

/** The relay checks a range, not a set (`constants.go:24-25`). */
const DURATIONS = [1, 15] as const

/**
 * Chosen here because the field is mandatory while this tool's `duration` is
 * not. Five rather than the relay's own default of eight: length is billed per
 * second, and a caller who did not ask for a length did not ask to pay for
 * three more.
 */
const DEFAULT_SECONDS = 5

/**
 * Models that cannot film from words alone (`models.go:33-42`).
 *
 * A set rather than a suffix rule: the relay's list is explicit, and the two
 * names differ by a version tag that says nothing about the capability.
 */
const IMAGE_ONLY = new Set(['grok-imagine-video-1.5-preview'])

export const grokProvider: VideoProvider = {
  id: 'grok',
  endpointTypes: [ENDPOINT_TYPE],
  fallbackModels: ['grok-imagine-video'],

  // `官方格式` means "the vendor's own format" and says nothing about which
  // vendor; today only grok's two video rows carry it, but the name invites
  // company. Narrowing by prefix keeps someone else's native route from being
  // submitted to xAI's.
  claims: (model: string): boolean => model.startsWith('grok-'),

  spec(model: string): VideoModelSpec {
    return {
      durationRange: DURATIONS,
      aspects: [...ASPECTS],
      firstFrame: true,
      ...IMAGE_ONLY.has(model) ? { requiresFirstFrame: true } : {},
      // Deliberately not `referenceDecidesShape`: unlike Kling's and Vidu's
      // image routes, this one still requires `aspect_ratio` when a picture is
      // attached, so the shape is chosen rather than inherited.
    }
  },

  async submit(wire: VideoWire, input: VideoSubmitInput): Promise<VideoSubmitted> {
    const reference = input.images?.[0]
    const body: Record<string, unknown> = {
      model: input.model,
      prompt: input.prompt,
      aspect_ratio: input.aspectRatio ?? '16:9',
      resolution: RESOLUTION,
      duration: input.durationSeconds === undefined
        ? DEFAULT_SECONDS
        : Math.min(15, Math.max(1, Math.round(input.durationSeconds))),
      ...reference === undefined ? {} : { image: { url: reference } },
    }

    let reply
    try {
      reply = await requestJson(wire.ctx, `${wire.base}/videos/generations`, {
        method: 'POST',
        headers: { ...wire.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, SUBMIT_TIMEOUT_MS, wire.signal)
    } catch (error: unknown) {
      throw new VideoGenerationError(error instanceof AccountRequestError
        ? error.message
        : `Grok 视频提交失败：${error instanceof Error ? error.message : String(error)}`)
    }

    const answer = object(reply.body) ?? {}
    // A successful submit answers with a bare `{request_id}` — no status, no
    // wrapper — so its presence is the verdict. The HTTP status is not: a
    // parameter refusal arrives as 429 here, same as on the Kling routes.
    const taskId = text(answer['request_id']) ?? text(answer['id'])
    if (taskId === undefined) {
      const reason = complaint(answer)
      throw new VideoGenerationError(reason === undefined
        ? `Grok 视频提交被拒（HTTP ${String(reply.response.status)}），上游没有给出原因。`
        : `Grok 视频提交被拒：${reason}`)
    }
    return { taskId }
  },

  async poll(wire: VideoWire, task: VideoSubmitted): Promise<VideoTaskState> {
    const reply = await requestJson(
      wire.ctx,
      `${wire.base}/videos/${encodeURIComponent(task.taskId)}`,
      { headers: wire.headers },
      POLL_TIMEOUT_MS,
      wire.signal,
    )
    if (!reply.response.ok) throw new Error(`HTTP ${String(reply.response.status)}`)
    const answer = object(reply.body) ?? {}
    const clip = object(answer['video'])
    const url = text(clip?.['url'])
    const failure = complaint(answer)
    const seconds = clip?.['duration']
    // Early reads have been seen with no `status` field at all, so an absent
    // one means "still filming" rather than an unfamiliar verdict.
    const status = text(answer['status'])?.toLowerCase() ?? 'pending'

    return {
      status,
      ...typeof answer['progress'] === 'number' ? { percent: answer['progress'] } : {},
      ...url === undefined ? {} : { url },
      ...typeof seconds === 'number' && seconds > 0 ? { seconds } : {},
      ...failure === undefined ? {} : { failure },
      done: status === 'done' || url !== undefined,
      // An `error` object is the failure signal here; the status literals are
      // listed too because a task can be cancelled without one.
      failed: failure !== undefined || status === 'failed' || status === 'cancelled',
    }
  },
}

/**
 * xAI's own words for a refusal or a failure.
 *
 * @param answer - the response body.
 * @returns the complaint, or undefined when it said nothing.
 */
function complaint(answer: Record<string, unknown>): string | undefined {
  const error = object(answer['error'])
  return text(error?.['message']) ?? text(error?.['code']) ?? text(answer['message'])
}
