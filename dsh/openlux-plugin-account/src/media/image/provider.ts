/**
 * What one image vendor has to implement, and nothing more.
 *
 * ## Why one adapter per vendor
 *
 * Same reason the video side has one (`media/video/provider.ts`), arrived at the
 * same way: the models a user names sit on three transports that share nothing
 * but the word "image". `/v1/images/generations` is OpenAI-shaped and
 * synchronous; the Gemini family draws on `/v1/chat/completions` and hands the
 * picture back inside the assistant's own text; MJ and Tencent's AIGC route are
 * submit-then-poll with their own status vocabularies. A single function with
 * branches for all of that is the shape the openclaw-era plugin grew and then
 * regretted, and the kernel's own media extensions are one file per vendor.
 *
 * ## What is deliberately not a provider's business
 *
 * Providers answer *where the picture is*, never *what the bytes are*. Every one
 * of them ends up either holding base64 or holding a URL, so downloading,
 * capping the size against the attachment store's own limit, and sniffing the
 * real media type from the bytes all stay in one place (`media/images.ts`). Two
 * reasons, both from live readings: the cap has to be enforced identically or a
 * vendor that returns huge files becomes a way to defeat it (MJ's four-up grid
 * came back at 8.5 MB), and the format varies within one family — the same
 * prompt got PNG from `gemini-2.5-flash-image` and JPEG from
 * `gemini-3-pro-image`, so the type has to come from the bytes. The attachment
 * store fully decodes them and refuses a declaration that disagrees
 * (`attachment-local/src/store.ts`: `IMAGE_TYPE_MISMATCH`), which makes a guess
 * here a rejected save rather than a wrong label.
 *
 * @module openlux-plugin-account/media/image/provider
 */

import type { Context } from '@deepseek-ai/cordis'
import { AccountRequestError } from '../../account/http.ts'

/** Raised when no usable image came back; the message is model-facing. */
export class ImageGenerationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageGenerationError'
  }
}

/** One `/v1/models` row, in the only four fields any judgement here reads. */
export interface ImageCatalogRow {
  readonly id: string
  /** `supported_endpoint_types`, verbatim. */
  readonly types: readonly string[]
  /** `model_type`; the platform's own bucket, e.g. `图像` or `音视频`. */
  readonly modelType: string
  /** `tags`, split on commas. */
  readonly tags: readonly string[]
}

/** The picture an edit starts from. */
export interface ImageReference {
  readonly data: Uint8Array
  /** The stored declaration, which the attachment store already verified. */
  readonly mediaType: string
}

/** What one generation asks for, in this plugin's vocabulary. */
export interface ImageRequest {
  readonly model: string
  readonly prompt: string
  /** How many pictures were asked for; vendors that cannot vary it say so. */
  readonly count: number
  /** `WIDTHxHEIGHT`, when the caller named a shape. */
  readonly size?: string
  /**
   * The picture to change, when this call edits rather than draws.
   *
   * Present only for a model whose row answered `edits`, because the two are one
   * decision: a transport with no way to carry the reference would otherwise
   * draw something new from the prompt alone and return it as though the edit
   * had happened, which is the failure this whole field exists to prevent.
   */
  readonly reference?: ImageReference
}

/** Where one produced picture is, before anyone reads its bytes. */
export type ImageCarrier =
  | { readonly kind: 'bytes'; readonly data: Uint8Array; readonly revisedPrompt?: string }
  | { readonly kind: 'url'; readonly url: string; readonly revisedPrompt?: string }

/** What one provider produced. */
export interface ImageOutcome {
  readonly carriers: readonly ImageCarrier[]
  /**
   * Requested values this transport has no field for, in words for the model.
   *
   * Stated afterwards rather than refused beforehand, and never folded into the
   * prompt. A caller who asked MJ for a 9:16 picture gets told MJ's own route
   * carries no size field, which is true and actionable; writing `--ar 9:16`
   * into their prompt instead would put words in their mouth, and refusing the
   * call would lose a picture over a shape nobody promised.
   */
  readonly ignored: readonly string[]
}

/** Everything a provider needs to reach the route. */
export interface ImageWire {
  readonly ctx: Context
  /** Route origin including `/v1`, for the OpenAI-compatible paths. */
  readonly base: string
  /**
   * Route origin with no path, for the vendor-specific ones.
   *
   * Both are handed over because the split is real: `/mj/…`,
   * `/tencent-vod/…` and `/kling/…` hang off the site root while
   * `/v1/images/generations` does not. An adapter deriving one from the other is
   * how the openclaw-era plugin produced a request that answered **HTTP 200 with
   * the front-end's own web page** — this route does not 404 a path it cannot
   * match, so the mistake surfaces as a parse failure somewhere else entirely.
   */
  readonly root: string
  readonly headers: Record<string, string>
  /** Per-image ceiling, from the attachment service's own limit. */
  readonly maxBytes: number
  readonly signal?: AbortSignal
}

/** One image vendor. */
export interface ImageProvider {
  /** Stable id, unique across providers; appears in diagnostics only. */
  readonly id: string
  /**
   * Endpoint types this provider serves, spelled exactly as `/v1/models` does.
   *
   * A list rather than one string because the platform renames a path without
   * moving it: `/v1/images/generations` answers to four names already, and the
   * cost of carrying one that is currently unused is nil next to the cost of
   * having dropped it the day a channel appears under that spelling.
   */
  readonly endpointTypes: readonly string[]
  /**
   * Models to assume are this provider's when the catalogue cannot be read.
   *
   * Only names that have actually produced a picture belong here: the list is
   * consulted exactly when nothing can be checked, so a wrong entry routes a
   * paid request to the wrong transport with no way to notice.
   *
   * **Order matters, best-known first.** It is also the preference an unnamed
   * call falls back on among this transport's servable models
   * (`defaultImageModel`), which is the only evidence anything here has about
   * one id versus another. Reordering it changes what a call that named no
   * model draws with.
   */
  readonly fallbackModels: readonly string[]
  /**
   * Claim by the whole row, for a family whose endpoint type says nothing.
   *
   * Exists for one real case: this route serves the Gemini image models on the
   * chat endpoint, so their types are `["gemini","openai"]` — the same two every
   * text model carries. Type alone would either miss them or claim all 280 chat
   * models, so that provider reads `model_type` and `tags` as well. Absent means
   * the type alone decides.
   */
  claims?(row: ImageCatalogRow): boolean
  /**
   * Whether this row can change a supplied picture, not just draw a new one.
   *
   * Per row rather than per provider because the OpenAI-compatible pool is split
   * down the middle: `gpt-image-*` and the two `grok-imagine` rows declare an
   * edit path, the seedream and qwen rows on the same transport do not. The
   * answer comes from the row's endpoint types for the same reason model choice
   * does — the platform renames paths and adds channels without telling us, and
   * a name is not evidence. `qwen-image-edit-2509` is the case that proves it:
   * the word is in its id and its row declares no edit endpoint at all.
   *
   * Absent means this vendor edits nothing.
   */
  edits?(row: ImageCatalogRow): boolean
  /** Whether this transport has a field for the picture count. */
  readonly variesCount: boolean
  /** Whether this transport has a field for the frame shape. */
  readonly variesSize: boolean
  /** Draw, and answer where the pictures are. */
  generate(wire: ImageWire, request: ImageRequest): Promise<ImageOutcome>
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

/**
 * The three shapes this tool offers, as an aspect ratio.
 *
 * Vendors that take a ratio rather than a pixel size need the same mapping, and
 * a caller only ever distinguishes square, landscape and portrait — so this
 * folds the offered sizes into those three instead of each adapter re-deriving
 * it from a `WIDTHxHEIGHT` string.
 * @param size - the requested `WIDTHxHEIGHT`, or undefined.
 * @returns the ratio, or undefined when no shape was asked for.
 */
export function aspectOf(size: string | undefined): '1:1' | '16:9' | '9:16' | undefined {
  if (size === undefined) return undefined
  const parts = /^(\d+)x(\d+)$/u.exec(size.trim())
  if (parts === null) return undefined
  const width = Number(parts[1])
  const height = Number(parts[2])
  if (width === height) return '1:1'
  return width > height ? '16:9' : '9:16'
}

/**
 * Sleep between polls, giving up early when the caller cancels.
 *
 * The rejection is an `AccountRequestError` of kind `cancelled` rather than an
 * `ImageGenerationError`, so a cancelled call is distinguishable from a failed
 * one all the way up — the same contract the video side's wait uses.
 * @param ms - how long to wait.
 * @param signal - caller cancellation.
 * @returns nothing, once the time has passed.
 * @throws {AccountRequestError} when the caller cancelled.
 */
export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
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
