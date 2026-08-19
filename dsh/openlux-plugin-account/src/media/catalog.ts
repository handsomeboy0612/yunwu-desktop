/**
 * Which models this key can actually drive on `/v1/images/generations`.
 *
 * ## Why a live catalogue instead of a list in the source
 *
 * The set of servable models is a property of the route's channel pool at this
 * moment, not of this build. Two reads of the live catalogue with the same key,
 * six days apart, on the four endpoint types below: 12/4/4/1 = 21 models on
 * 2026-08-13 (recorded by the openclaw-era plugin), 14/4/4/1 = 23 on 2026-08-19.
 * Over the same period the video family's `Unified video format` type left the
 * catalogue entirely and `OpenAI video format` took over. A name list compiled
 * into the plugin is therefore wrong shortly after it is written, in both
 * directions — it refuses models the user is paying for, and offers ones the
 * pool no longer carries.
 *
 * So the judgement is the **endpoint type**, which is stable, and the model
 * names come from `/v1/models` at call time. A model the route adds later
 * appears here with no release of ours, which is the whole point.
 *
 * ## Why this only knows the OpenAI-compatible path
 *
 * Three of the catalogue's endpoint types name the same URL —
 * `image-generation`, `images-generations` and `dall-e-3` all resolve to
 * `/v1/images/generations` (verified per model against
 * `GET /api/model_preset?model=…` on 2026-08-19) — and that URL is the only one
 * `media/images.ts` speaks. Image models on other paths exist and are
 * deliberately absent: the Gemini family draws on `/v1/chat/completions`, and
 * MJ and Kling draw through submit-then-poll interfaces of their own. Each is a
 * separate transport, so each would be a separate module rather than another
 * name in a list. Until then a request for one is refused with a reason, which
 * is the honest answer and costs no round trip.
 *
 * ## Failing open, on purpose
 *
 * When the catalogue cannot be read this module returns nothing and the caller
 * proceeds unchecked. Refusing instead would convert one flaky request into an
 * outage of a capability that was working, and the route's own refusals are
 * legible — a model with no channel answers HTTP 503 naming every group that
 * lacks one, and a saturated group answers 429 in words. That is the same rule
 * the desktop side applies to the square snapshot: a snapshot that did not
 * arrive filters nothing rather than emptying the pool.
 *
 * @module openlux-plugin-account/media/catalog
 */

import type { Context } from '@deepseek-ai/cordis'
import { normalizeBase, requestJson } from '../account/http.ts'
import type { ConsoleAccess } from '../market/console.ts'

/**
 * Endpoint types served by OpenAI-compatible `/v1/images/generations`.
 *
 * These four strings are the judgement; model ids are not. The same set backs
 * the desktop picker in `src/shared/media-endpoints.ts` and the openclaw-era
 * plugin — three copies that must agree, because a name missing here makes a
 * model the picker offers unusable at call time. They are not imported from one
 * place because this plugin is loaded by the kernel as an independent extension:
 * reaching into the host's source would either be rewritten by the bundler or
 * force the judgement into a shared package that both must resolve at runtime,
 * and both failure modes are silent where a stale copy is at least a legible
 * refusal naming what is available.
 */
const IMAGE_ENDPOINT_TYPES = ['image-generation', 'images-generations', 'dall-e-3', 'openai-绘图']

/**
 * Endpoint types that accept a reference image on `/v1/images/edits`.
 *
 * `image-edit` is the same URL under a fourth name the platform introduced for
 * the Grok image models, so it belongs here rather than looking like a path of
 * its own.
 *
 * `images-edits` matched nothing in the 2026-08-19 read (the other three matched
 * 4 / 1 / 2, for 7 editable models). It stays because these names are the
 * platform's, not ours: the same URL already answers to four of them, so the
 * cost of carrying one that is currently unused is nil and the cost of having
 * dropped it the day a channel is registered under that spelling is a model the
 * user pays for being refused.
 */
const IMAGE_EDIT_ENDPOINT_TYPES = ['OpenAI image edit', 'images-edits', 'openai-编辑', 'image-edit']

/**
 * How long a read stays current.
 *
 * The pool changes on the order of hours, so this only has to stop a burst of
 * calls in one turn from each paying for a round trip. A stale entry is kept
 * past this and used when a refresh fails, because an old answer about which
 * models exist is far better than no answer.
 */
const CATALOG_TTL_MS = 300_000

/** Budget for reading the catalogue; it is a small JSON list on a warm path. */
const CATALOG_TIMEOUT_MS = 15_000

/** One servable image model. */
export interface ImageCatalogEntry {
  /** The id to send as `model`. */
  readonly id: string
  /** Whether this model also serves `/v1/images/edits`. */
  readonly canEdit: boolean
}

/** The servable image models, as of one read. */
export interface ImageCatalog {
  readonly models: ReadonlyMap<string, ImageCatalogEntry>
  /** When this was read, for the TTL. */
  readonly at: number
}

/** One `/v1/models` element, as far as this module reads it. */
interface CatalogRow {
  readonly id?: unknown
  readonly supported_endpoint_types?: unknown
}

const cache = new Map<string, ImageCatalog>()

/**
 * Read the servable image models, from cache when it is current.
 *
 * @param ctx - host context.
 * @param access - route origin and token reader.
 * @param signal - caller cancellation.
 * @returns the catalogue, or undefined when it could not be read at all.
 */
export async function readImageCatalog(
  ctx: Context,
  access: ConsoleAccess,
  signal?: AbortSignal,
): Promise<ImageCatalog | undefined> {
  const token = await access.apiKey()
  if (token === undefined || token === '') return undefined
  const base = normalizeBase(access.baseUrl)
  const key = `${base}|${token}`
  const cached = cache.get(key)
  if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return cached

  try {
    const reply = await requestJson(ctx, `${base}/v1/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, CATALOG_TIMEOUT_MS, signal)
    if (!reply.response.ok) {
      ctx.logger.warn(`openlux: image catalogue read returned HTTP ${String(reply.response.status)}; leaving the model unchecked`)
      return cached
    }
    const rows = (reply.body as { readonly data?: unknown } | undefined)?.data
    if (!Array.isArray(rows)) return cached
    const models = new Map<string, ImageCatalogEntry>()
    for (const row of rows as readonly CatalogRow[]) {
      const id = typeof row.id === 'string' ? row.id.trim() : ''
      if (id === '') continue
      const types = Array.isArray(row.supported_endpoint_types)
        ? (row.supported_endpoint_types as readonly unknown[]).filter((t): t is string => typeof t === 'string')
        : []
      if (!types.some(t => IMAGE_ENDPOINT_TYPES.includes(t))) continue
      models.set(id, { id, canEdit: types.some(t => IMAGE_EDIT_ENDPOINT_TYPES.includes(t)) })
    }
    // An empty result is a shape we do not understand rather than a route with
    // no image models, so the previous read outranks it.
    if (models.size === 0) return cached
    const fresh: ImageCatalog = { models, at: Date.now() }
    cache.set(key, fresh)
    return fresh
  } catch (error: unknown) {
    ctx.logger.warn(`openlux: image catalogue unreadable (${error instanceof Error ? error.message : String(error)}); leaving the model unchecked`)
    return cached
  }
}

/**
 * Refuse a model this route cannot draw with, before spending a request on it.
 *
 * The refusal names what is available, because the model that picked the name
 * has no other way to find out and the user who asked for it deserves to know
 * their choice was not silently swapped.
 *
 * @param catalog - a read of the servable models, or undefined to skip the check.
 * @param model - the requested model id.
 * @returns nothing; the model is servable, or was not checked.
 * @throws {Error} when the catalogue was read and does not carry this model.
 */
export function assertImageModel(catalog: ImageCatalog | undefined, model: string): void {
  if (catalog === undefined || catalog.models.has(model)) return
  const usable = [...catalog.models.keys()].sort()
  throw new Error(`这个账号的出图接口上没有「${model}」。`
    + '（可能已下架、这把密钥的分组没有它的渠道，或者它走的是厂商专属出图接口，本工具只走 OpenAI 兼容那条。）'
    + (usable.length === 0
      ? '当前这个账号一个可用的出图模型都没有。'
      : `当前可用的是：${usable.join('、')}。`))
}
