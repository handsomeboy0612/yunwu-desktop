/**
 * What one video vendor has to implement, and nothing more.
 *
 * ## Why one adapter per vendor rather than one function with branches
 *
 * Every vendor on this route is a different path, a different body, a different
 * completion literal and a different place to find the finished URL. The
 * openclaw-era plugin absorbed thirteen of them and the shape it settled on —
 * `submit` / `poll` / `extractUrl` / `statusOf` / `isTerminal` per vendor, one
 * skeleton for all — is also what the kernel's own video extensions do
 * (`openclaw/extensions/{runway,minimax,pixverse,fal,vydra}`, each ~450 lines
 * with its own status literals). So this is the mature shape, not our invention.
 *
 * The one thing we cannot copy from those extensions is where the model list
 * comes from. They talk to a vendor directly, so their model set is fixed and
 * compiled in; we talk to a relay where the same name is servable for one key
 * and absent for the next. Hence {@link VideoProvider.endpointTypes}: the
 * catalogue's endpoint type is the stable judgement and model ids are read at
 * call time.
 *
 * ## Why a plain registry instead of a Cordis service
 *
 * `ctx.web` is the kernel's example of one capability with many providers, and
 * it is a `Service` because its providers ship as separate packages
 * (`dsh-web-search-exa`, `-perplexity`, …) that must register without importing
 * each other. Ours all live in this package, so a service would buy
 * cross-package registration we do not need while spending a name in the flat
 * service namespace the harness owns. The contract below deliberately keeps the
 * seam's shape — a stable `id`, declared claims, call-time selection, refusal
 * with the list of what would have worked — so promoting it later is mechanical.
 *
 * @module openlux-plugin-account/media/video/provider
 */

import type { Context } from '@deepseek-ai/cordis'

/** Raised when no usable video came back; the message is model-facing. */
export class VideoGenerationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VideoGenerationError'
  }
}

/** What one model accepts, as far as anyone has verified. */
export interface VideoModelSpec {
  /**
   * Clip lengths this model is known to accept.
   *
   * Absent means "nobody verified a discrete set", and absent is not the same
   * as empty: a declared set is enforced locally, so declaring a guessed one
   * refuses lengths the route in fact serves. Only vendors whose relay code
   * carries a whitelist (sora's `duration_validate.go`, minimax's
   * `models.go`) or whose set was measured get one; the rest pass the number
   * through and let the route answer.
   */
  readonly durations?: readonly number[]
  /**
   * Inclusive `[min, max]` for vendors that check a range instead of a set.
   *
   * Bailian is the case that forced this: 3–15 seconds for happyhorse and 2–15
   * for Wan, refused with HTTP 400
   * (`relay_tasks/ali/bailian/duration/task.go:119-125`). Enumerating thirteen
   * integers as {@link VideoModelSpec.durations} would say the same thing and
   * read like a measured whitelist, which it is not.
   */
  readonly durationRange?: readonly [number, number]
  /** Frame shapes this model accepts. */
  readonly aspects: readonly string[]
  /** Whether a reference image becomes the clip's first frame. */
  readonly firstFrame: boolean
  /**
   * Whether this model films *only* from a picture, so a prompt on its own is
   * not a request it can serve.
   *
   * Several vendors ship one name per direction — `happyhorse-1.0-i2v`,
   * `wan2.6-i2v`, `MiniMax-Hailuo-2.3-Fast` — and the route's own refusal is
   * perfectly clear but arrives from inside a background job, minutes after the
   * turn where the user could have named a different model.
   */
  readonly requiresFirstFrame?: boolean
  /**
   * Whether the reference image's own shape decides the clip's, leaving no
   * shape to choose or to report.
   *
   * True for routes that have no aspect field at all: Vidu's `img2video` takes
   * the picture and films it as it is, so a square source yields a square clip
   * with no bars. Absent — the veo-shaped default — means the clip is filmed in
   * one of {@link VideoModelSpec.aspects} and a source of another shape is
   * letterboxed into it. Getting this wrong is not cosmetic: the tool tells the
   * model which shape it filmed in, and a live run had it announce "16:9, your
   * square source will have bars" for a clip that came back 960×960.
   */
  readonly referenceDecidesShape?: boolean
}

/** One generation request, in this plugin's vocabulary rather than a vendor's. */
export interface VideoSubmitInput {
  readonly model: string
  readonly prompt: string
  readonly aspectRatio?: string
  readonly durationSeconds?: number
  /** Reference images as `https://…` URLs or `data:` URIs, newest role first. */
  readonly images?: readonly string[]
  /**
   * The endpoint types the catalogue listed for this model, when it could be
   * read.
   *
   * Most vendors ignore it. It exists because some encode the *mode* in the
   * type rather than in the model name — Doubao's two families differ only
   * here, and Vidu's `viduq3-pro` (text) and `viduq3` (reference) are
   * indistinguishable by name. A provider that needs it says so; the rest do
   * not have to care.
   */
  readonly endpointTypes?: readonly string[]
}

/** What a submit answered, once the vendor's own shape has been read. */
export interface VideoSubmitted {
  readonly taskId: string
  /**
   * Provider-private note, handed back to {@link VideoProvider.poll} unchanged.
   *
   * For vendors whose submit chose among several paths and whose task id does
   * not say which. Deriving it again in `poll` is not safe: on this route the
   * wrong mount answers **HTTP 200 with a stub body** rather than 404, so a
   * poller that shops around simply waits forever on a task that finished.
   */
  readonly handle?: string
  /** Frame size the vendor reports, when it does. */
  readonly size?: string
  /** Clip length the vendor reports, when it does. */
  readonly seconds?: number
}

/** One status read, normalized. */
export interface VideoTaskState {
  /** The vendor's own word, for the job's output stream. */
  readonly status: string
  readonly percent?: number
  /** The artifact, present only once the vendor says the task is finished. */
  readonly url?: string
  /** Why it failed, in the vendor's words. */
  readonly failure?: string
  readonly done: boolean
  readonly failed: boolean
  readonly size?: string
  readonly seconds?: number
}

/**
 * Everything a provider needs to reach the route.
 *
 * Both origins are handed over because the split is real: the unified entry
 * lives under `/v1` while every vendor-specific route hangs off the site root
 * (`/minimax/…`, `/kling/…`). Deriving one from the other inside each adapter is
 * how the openclaw-era plugin produced a 404 that looked like a missing task id.
 */
export interface VideoWire {
  readonly ctx: Context
  /** Route origin including `/v1`. */
  readonly base: string
  /** Route origin without any path. */
  readonly root: string
  readonly headers: Record<string, string>
  readonly signal?: AbortSignal
}

/** One video vendor. */
export interface VideoProvider {
  /** Stable id, unique across providers; appears in diagnostics only. */
  readonly id: string
  /**
   * Endpoint types this provider serves, spelled exactly as `/v1/models` does.
   *
   * The platform gives one path several names over time (`Unified video format`
   * was renamed `OpenAI video format` on this route), so this is a list rather
   * than a single string and an unfamiliar name costs one line here.
   */
  readonly endpointTypes: readonly string[]
  /**
   * Models to assume are this provider's when the catalogue cannot be read.
   *
   * Only names that have actually produced a clip belong here: this list is
   * consulted exactly when nothing can be checked, so a wrong entry sends the
   * user's request to the wrong transport with no way to notice.
   *
   * **Order matters, best-known first.** It doubles as the preference an
   * unnamed call falls back on among this vendor's servable models
   * (`defaultVideoModel`), so reordering it changes what a call that named no
   * model films with.
   */
  readonly fallbackModels: readonly string[]
  /**
   * Narrow within one endpoint type when the platform puts several modes under
   * it. Absent means the type alone decides.
   */
  claims?(model: string): boolean
  /**
   * What this model accepts.
   *
   * @param model - the model id.
   * @param types - the catalogue's endpoint types for it, empty when the
   *   catalogue could not be read. Only vendors that encode the *mode* there
   *   need it: Vidu's `viduq2` films from text but not from a picture while
   *   `viduq3-turbo` does both, and the names say nothing. Without it such a
   *   provider could only refuse once the background job had started, whereas
   *   this tool answers "that model cannot animate a picture" in the same turn.
   */
  spec(model: string, types: readonly string[]): VideoModelSpec
  /** Hand the work to the vendor and return its task id. */
  submit(wire: VideoWire, input: VideoSubmitInput): Promise<VideoSubmitted>
  /** Read one status, given exactly what {@link VideoProvider.submit} returned. */
  poll(wire: VideoWire, task: VideoSubmitted): Promise<VideoTaskState>
}

/** Read a response field that must be a non-empty string. */
export function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Read a nested object without trusting any of it. */
export function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
