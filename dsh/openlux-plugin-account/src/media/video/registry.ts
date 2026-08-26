/**
 * Which video models this key can drive, and which vendor adapter drives them.
 *
 * ## Why the catalogue decides and a compiled list does not
 *
 * Same reason as the image side (`media/image/registry.ts`): the servable set belongs
 * to the route's channel pool at this moment, not to this build. Measured on
 * 2026-08-21 with one key, the whole video half of `/v1/models` was 30-odd
 * models across nine endpoint types, and the type the veo family used to carry
 * (`Unified video format`) had left the catalogue entirely while
 * `OpenAI video format` took over — with a compiled list that rename is an
 * outage, with this it is nothing.
 *
 * So the stable judgement is the **endpoint type**, declared by each provider,
 * and the model ids come from `/v1/models` at call time. One consequence worth
 * stating because it reads like a bug: a model may sit in the catalogue with a
 * type nobody claims. That is not a gap in the data, it is a vendor we have not
 * written an adapter for, and the refusal says so by listing what does work.
 *
 * ## Failing open, on purpose
 *
 * When the catalogue cannot be read this module falls back to each provider's
 * `fallbackModels` and, failing that, lets the default model through unchecked.
 * Refusing instead would turn one flaky request into an outage of a capability
 * that was working, and the route's own refusals are legible — a model with no
 * channel answers HTTP 503 naming the groups that lack one.
 *
 * @module openlux-plugin-account/media/video/registry
 */

import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { normalizeBase, requestJson } from '../../account/http.ts'
import type { ConsoleAccess } from '../../market/console.ts'
import { registerModelCacheInvalidator } from '../../models/runtime-cache.ts'
import { bailianProvider } from './bailian.ts'
import { doubaoProvider } from './doubao.ts'
import { grokProvider } from './grok.ts'
import { klingProvider, klingTurboProvider } from './kling.ts'
import { minimaxProvider } from './minimax.ts'
import type { VideoProvider } from './provider.ts'
import { unifiedProvider } from './unified.ts'
import { viduProvider } from './vidu.ts'

/**
 * Every vendor this plugin can film with.
 *
 * Order is not a priority: selection is by declared endpoint type, so two
 * providers claiming one type would be a bug rather than a preference. Adding a
 * vendor is one file plus one line here.
 */
export const VIDEO_PROVIDERS: readonly VideoProvider[] = [
  unifiedProvider,
  doubaoProvider,
  minimaxProvider,
  viduProvider,
  bailianProvider,
  klingProvider,
  klingTurboProvider,
  grokProvider,
]

/**
 * Which vendor an unnamed call should prefer, best first.
 *
 * The only place order means anything here — {@link VIDEO_PROVIDERS} above is a
 * claim table whose order is irrelevant, and this is deliberately a ranking over
 * *vendors* rather than model names, because names come and go from the
 * catalogue while a vendor's route does not.
 *
 * Every video route on this relay is asynchronous, so unlike the image side
 * there is no fast-versus-slow to rank by. `unified` leads because it carries
 * the veo family this product has filmed with from the start and which delivery
 * names today (two live runs: 100 s and 118 s, 1280×720, and a Chinese prompt
 * came back as what it described). The rest is list order, not a measured
 * ranking — say so rather than implying one, and if a run ever shows otherwise,
 * move the entry and write down what it showed.
 *
 * Within a vendor, a name the provider lists in its own `fallbackModels` comes
 * first, in that list's order — that list already means "this name has actually
 * produced a clip here". A compiled name may **rank**, never **decide**: it is
 * consulted only among what the route has already said is servable, so a key
 * that lacks it films with the next servable model instead of being refused by
 * name, which is exactly what the compiled default this replaced could not do.
 *
 * Anything left over is ordered by id: arbitrary, but stable. The catalogue's
 * own order is not — three reads with one key seconds apart put the same 476
 * rows in three different orders (2026-08-23), so a default read off it would
 * change by itself between two identical calls.
 */
const VENDOR_PREFERENCE: readonly string[] = [
  'unified',
  'doubao',
  'vidu',
  'kling',
  'kling-turbo',
  'grok',
  'bailian',
  'minimax',
]

/** How long a read stays current; the pool changes on the order of hours. */
const CATALOG_TTL_MS = 300_000

/** Budget for reading the catalogue; it is a small JSON list on a warm path. */
const CATALOG_TIMEOUT_MS = 15_000

/** One servable video model, with the provider that claimed it. */
export interface VideoCatalogEntry {
  readonly id: string
  readonly provider: VideoProvider
  /** The types the catalogue listed, for providers that route by mode. */
  readonly types: readonly string[]
}

/** The servable video models, as of one read. */
export interface VideoCatalog {
  readonly models: ReadonlyMap<string, VideoCatalogEntry>
  readonly at: number
}

/** One `/v1/models` element, as far as this module reads it. */
interface CatalogRow {
  readonly id?: unknown
  readonly supported_endpoint_types?: unknown
}

const cache = new Map<string, VideoCatalog>()
registerModelCacheInvalidator(() => cache.clear())

/**
 * Read the servable video models, from cache when it is current.
 *
 * @param ctx - host context.
 * @param access - route origin and token reader.
 * @param signal - caller cancellation.
 * @returns the catalogue, or undefined when it could not be read at all.
 */
export async function readVideoCatalog(
  ctx: Context,
  access: ConsoleAccess,
  signal?: AbortSignal,
): Promise<VideoCatalog | undefined> {
  const token = await access.apiKey()
  if (token === undefined || token === '') return undefined
  const base = normalizeBase(access.baseUrl)
  const key = `${base}|${createHash('sha256').update(token).digest('hex').slice(0, 24)}`
  const cached = cache.get(key)
  if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return cached

  try {
    const reply = await requestJson(ctx, `${base}/v1/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, CATALOG_TIMEOUT_MS, signal)
    if (!reply.response.ok) {
      ctx.logger.warn(`openlux: video catalogue read returned HTTP ${String(reply.response.status)}; leaving the model unchecked`)
      return cached
    }
    const rows = (reply.body as { readonly data?: unknown } | undefined)?.data
    if (!Array.isArray(rows)) return cached
    const models = new Map<string, VideoCatalogEntry>()
    for (const row of rows as readonly CatalogRow[]) {
      const id = typeof row.id === 'string' ? row.id.trim() : ''
      if (id === '') continue
      const types = Array.isArray(row.supported_endpoint_types)
        ? (row.supported_endpoint_types as readonly unknown[]).filter((t): t is string => typeof t === 'string')
        : []
      const provider = VIDEO_PROVIDERS.find(candidate =>
        types.some(type => candidate.endpointTypes.includes(type))
        && (candidate.claims === undefined || candidate.claims(id)))
      if (provider === undefined) continue
      models.set(id, { id, provider, types: types.filter(type => provider.endpointTypes.includes(type)) })
    }
    // An empty result is a shape we do not understand rather than a route with
    // no video models, so the previous read outranks it.
    if (models.size === 0) return cached
    const fresh: VideoCatalog = { models, at: Date.now() }
    cache.set(key, fresh)
    while (cache.size > 8) {
      const oldest = cache.keys().next().value as string | undefined
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    return fresh
  } catch (error: unknown) {
    ctx.logger.warn(`openlux: video catalogue unreadable (${error instanceof Error ? error.message : String(error)}); leaving the model unchecked`)
    return cached
  }
}

/** What a resolution produced. */
export interface ResolvedVideoModel {
  readonly provider: VideoProvider
  /** True when the catalogue was read and carried this model. */
  readonly confirmed: boolean
  /** The catalogue's types for it, for providers that route by mode. */
  readonly types: readonly string[]
}

/**
 * Find the vendor for one model name.
 *
 * @param catalog - a read of the servable models, or undefined to skip the check.
 * @param model - the requested model id.
 * @returns the provider, or undefined when nothing here can film with that name.
 */
export function resolveVideoModel(catalog: VideoCatalog | undefined, model: string): ResolvedVideoModel | undefined {
  const listed = catalog?.models.get(model)
  if (listed !== undefined) return { provider: listed.provider, confirmed: true, types: listed.types }
  if (catalog !== undefined) return undefined
  const assumed = VIDEO_PROVIDERS.find(provider => provider.fallbackModels.includes(model))
  return assumed === undefined ? undefined : { provider: assumed, confirmed: false, types: [] }
}

/**
 * Which model films when nobody named one.
 *
 * No compiled-in name to fall back on, for the reason the image side gives at
 * length: a default written into this build is a claim about a channel pool we
 * do not control, and when it turns out to have no channel on this key the user
 * gets a refusal by name while the catalogue is full of models that would have
 * worked. Delivery decides; a servable model is the substitute when it has not.
 *
 * The mode matters as much as the name. Vendors ship one name per direction —
 * `wan2.6-i2v` films only from a picture, and several text-only names cannot
 * take a first frame — so a default picked without knowing which way this call
 * runs is a refusal issued from inside a background job minutes later.
 * @param catalog - the catalogue read, or undefined when it is unreadable.
 * @param delivered - the server-delivered default, when there is one.
 * @param animating - whether this call films from a picture.
 * @returns the model to film with, or undefined when nothing here can.
 */
export function defaultVideoModel(
  catalog: VideoCatalog | undefined,
  delivered: string | undefined,
  animating: boolean,
): string | undefined {
  const fit = (entry: VideoCatalogEntry | undefined): boolean => {
    if (entry === undefined) return false
    const spec = entry.provider.spec(entry.id, entry.types)
    return animating ? spec.firstFrame : spec.requiresFirstFrame !== true
  }
  if (delivered !== undefined && delivered !== '') {
    if (catalog === undefined) return delivered
    if (fit(catalog.models.get(delivered))) return delivered
  }
  if (catalog === undefined) return undefined
  const usable = [...catalog.models.values()].filter(entry => fit(entry))
  const vendor = (entry: VideoCatalogEntry): number => {
    const index = VENDOR_PREFERENCE.indexOf(entry.provider.id)
    return index === -1 ? VENDOR_PREFERENCE.length : index
  }
  const proven = (entry: VideoCatalogEntry): number => {
    const index = entry.provider.fallbackModels.indexOf(entry.id)
    return index === -1 ? entry.provider.fallbackModels.length : index
  }
  return usable.sort((left, right) => vendor(left) - vendor(right)
    || proven(left) - proven(right)
    || left.id.localeCompare(right.id))[0]?.id
}

/**
 * The refusal for having no model to film with at all.
 * @param catalog - the catalogue read, or undefined when it is unreadable.
 * @param animating - whether the call was asking to animate a picture.
 * @returns the model-facing message.
 */
export function videoDefaultRefusal(catalog: VideoCatalog | undefined, animating: boolean): string {
  if (catalog === undefined) {
    return '现在查不到这个账号能用哪些视频模型（可能还没登录，或者接口暂时不通），所以没有可用的视频模型。稍后再试。'
  }
  return animating
    ? '这个账号现在一个能做图生视频的模型都没有，这张图动不了。'
    : '这个账号现在一个能出视频的模型都没有。请让管理员在后台配一个默认视频模型，或者确认这把密钥的分组里有视频渠道。'
}

/**
 * The refusal for a name this key cannot film with.
 *
 * It names what is available because the model that picked the name has no
 * other way to find out, and the user who asked for it deserves to know their
 * choice was not silently swapped for the default.
 *
 * @param catalog - the read that failed to carry the name.
 * @param model - the requested model id.
 * @returns the model-facing message.
 */
export function videoModelRefusal(catalog: VideoCatalog | undefined, model: string): string {
  const usable = catalog === undefined ? [] : [...catalog.models.keys()].sort()
  return `这个账号的出片接口上没有「${model}」。`
    + '（可能已下架、这把密钥的分组没有它的渠道，或者它走的是本工具还没接的厂商专属接口。）'
    + (usable.length === 0
      ? '现在一个可用的视频模型都查不到，请稍后再试。'
      : `当前可用的是：${usable.join('、')}。`)
}
