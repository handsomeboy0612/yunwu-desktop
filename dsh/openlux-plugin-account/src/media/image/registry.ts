/**
 * Which image models this key can draw with, and which vendor adapter drives them.
 *
 * ## Why the catalogue decides and a compiled list does not
 *
 * The servable set belongs to the route's channel pool at this moment, not to
 * this build. Two reads with the same key six days apart went 21 → 23 models on
 * the OpenAI-compatible types alone, and over the same period the video half of
 * the catalogue renamed an endpoint type out from under a working family. A name
 * list compiled in here is wrong shortly after it is written in both directions:
 * it refuses models the user is paying for and offers ones the pool no longer
 * carries.
 *
 * So the stable judgement is the **endpoint type**, declared by each provider,
 * and the model ids come from `/v1/models` at call time. A model the route adds
 * later becomes usable with no release of ours, which is the point.
 *
 * One consequence reads like a bug and is not: a model can sit in the catalogue
 * with a type nobody claims. That is a vendor we have no adapter for, and the
 * refusal says so by listing what does work. On 2026-08-21 the unclaimed ones
 * were the MJ actions (upscale, pan, zoom…, which operate on an existing task
 * rather than drawing), `mj_blend` and the edit-only types (they need a
 * reference image, which this tool has no parameter for), and the direct Kling
 * image routes, which answer 「Account balance not enough」 on this key.
 *
 * ## Failing open, on purpose
 *
 * When the catalogue cannot be read this module falls back to each provider's
 * `fallbackModels` and, failing that, lets the request through unchecked.
 * Refusing instead would turn one flaky read into an outage of a capability that
 * was working, and the route's own refusals are legible — a model with no
 * channel answers HTTP 503 naming every group that lacks one.
 *
 * @module openlux-plugin-account/media/image/registry
 */

import type { Context } from '@deepseek-ai/cordis'
import { normalizeBase, requestJson } from '../../account/http.ts'
import type { ConsoleAccess } from '../../market/console.ts'
import { geminiImageProvider } from './gemini.ts'
import { klingImageProvider, klingOmniImageProvider } from './kling.ts'
import { mjImagineProvider } from './mj.ts'
import { openaiImageProvider } from './openai.ts'
import type { ImageCatalogRow, ImageProvider } from './provider.ts'
import { viduImageProvider } from './vidu.ts'
import { vodImageProvider } from './vod.ts'

/**
 * Every vendor this plugin can draw with.
 *
 * Order is not a priority. Each provider's claim is self-contained — the one
 * that could overlap says so in its own `claims` — so two providers taking the
 * same row would be a bug to fix rather than a precedence to tune. Adding a
 * vendor is one file plus one entry here.
 */
export const IMAGE_PROVIDERS: readonly ImageProvider[] = [
  openaiImageProvider,
  geminiImageProvider,
  mjImagineProvider,
  klingImageProvider,
  klingOmniImageProvider,
  viduImageProvider,
  vodImageProvider,
]

/**
 * Which transport an unnamed call should prefer, best first.
 *
 * This is the one place in this module where order means anything —
 * {@link IMAGE_PROVIDERS} above is a claim table and its order is irrelevant.
 * It is a preference over *transports* rather than over model names on purpose,
 * and that is the same argument this module makes for everything else: the
 * endpoint type is stable while ids come and go, so a ranking written over names
 * is stale by the next catalogue read and one written over vendors is not.
 *
 * The ranking is response shape, not picture quality (nobody here can judge
 * that): the synchronous `/v1/images/generations` route answers in about 15
 * seconds and takes `n` and `size`, the chat-endpoint one answered a live edit
 * in 27.5 s, and the asynchronous ones are minutes (MJ measured 51–74 s and has
 * no shape field at all) or, for the direct Kling routes on the keys we hold,
 * 「Account balance not enough」. A caller who named nothing is owed the fastest
 * thing that works, and one who named something never reaches this list.
 *
 * Within a transport, a name the provider lists in its own `fallbackModels`
 * comes first, in that list's order. That list already means "this name has
 * actually produced a picture here" (see `ImageProvider.fallbackModels`), which
 * is the only evidence available about one id versus another — and note what it
 * can and cannot do: a compiled name may **rank**, never **decide**. It is
 * consulted after the route has already said what is servable, so deleting the
 * entry costs nothing but a preference, and a key without it draws with the
 * next servable model rather than being refused by name. That is the whole
 * difference from the compiled default this replaced.
 *
 * Anything left over is ordered by id: arbitrary, but stable, and stable is the
 * point. The catalogue's own order looked like the better lever until it was
 * measured — three reads with one key, seconds apart, put the same 476 rows in
 * three different orders (2026-08-23), so ranking by it would draw with a
 * different model on every call. An unnamed default that changes by itself is
 * the one failure nobody can reproduce.
 */
const TRANSPORT_PREFERENCE: readonly string[] = [
  'openai-images',
  'gemini-chat',
  'vidu-image',
  'tencent-vod-image',
  'mj-imagine',
  'kling-image',
  'kling-omni-image',
]

/** How long a read stays current; the pool changes on the order of hours. */
const CATALOG_TTL_MS = 300_000

/** Budget for reading the catalogue; it is a small JSON list on a warm path. */
const CATALOG_TIMEOUT_MS = 15_000

/** One servable image model, with the provider that claimed it. */
export interface ImageCatalogEntry {
  readonly id: string
  readonly provider: ImageProvider
  /** Whether this row can change a supplied picture, not only draw a new one. */
  readonly canEdit: boolean
}

/** The servable image models, as of one read. */
export interface ImageCatalog {
  readonly models: ReadonlyMap<string, ImageCatalogEntry>
  /**
   * Every id the read carried, claimed or not, so a refusal can say which of the
   * two reasons applies. They are different facts to the person who chose the
   * name: a model the route dropped is their problem to work around, and a model
   * the route still sells but this tool has no adapter for is ours. Answering
   * "does this exact id exist" needs no guess about what an unclaimed endpoint
   * type means, which is why the whole id list is kept rather than a filtered one.
   */
  readonly present: ReadonlySet<string>
  readonly at: number
}

/** One `/v1/models` element, as far as this module reads it. */
interface RawRow {
  readonly id?: unknown
  readonly supported_endpoint_types?: unknown
  readonly model_type?: unknown
  readonly tags?: unknown
}

const cache = new Map<string, ImageCatalog>()

/**
 * Read the servable image models, from cache when it is current.
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
    const present = new Set<string>()
    for (const raw of rows as readonly RawRow[]) {
      const row = read(raw)
      if (row === undefined) continue
      present.add(row.id)
      const provider = IMAGE_PROVIDERS.find(candidate => candidate.claims === undefined
        ? row.types.some(type => candidate.endpointTypes.includes(type))
        : candidate.claims(row))
      if (provider === undefined) continue
      models.set(row.id, { id: row.id, provider, canEdit: provider.edits?.(row) === true })
    }
    // An empty result is a shape we do not understand rather than a route with
    // no image models, so the previous read outranks it.
    if (models.size === 0) return cached
    const fresh: ImageCatalog = { models, present, at: Date.now() }
    cache.set(key, fresh)
    return fresh
  } catch (error: unknown) {
    ctx.logger.warn(`openlux: image catalogue unreadable (${error instanceof Error ? error.message : String(error)}); leaving the model unchecked`)
    return cached
  }
}

/**
 * Narrow one catalogue element to the four fields a claim may read.
 * @param raw - the element as it arrived.
 * @returns the row, or undefined when it carries no usable id.
 */
function read(raw: RawRow): ImageCatalogRow | undefined {
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id === '') return undefined
  const types = Array.isArray(raw.supported_endpoint_types)
    ? (raw.supported_endpoint_types as readonly unknown[]).filter((type): type is string => typeof type === 'string')
    : []
  // `tags` is one comma-separated string on this route, e.g. `绘画,异步`.
  const tags = typeof raw.tags === 'string'
    ? raw.tags.split(',').map(tag => tag.trim()).filter(tag => tag !== '')
    : []
  return { id, types, modelType: typeof raw.model_type === 'string' ? raw.model_type : '', tags }
}

/** What a resolution produced. */
export interface ResolvedImageModel {
  readonly provider: ImageProvider
  /** True when the catalogue was read and carried this model. */
  readonly confirmed: boolean
  /**
   * Whether this model can edit a supplied picture.
   *
   * False when the catalogue could not be read at all, which makes an edit
   * request fail with "cannot be checked" rather than proceed on a guess. That
   * asymmetry is deliberate: guessing wrong about drawing costs a redraw, while
   * guessing wrong about editing sends the reference nowhere and hands back a
   * different picture as though it had been edited.
   */
  readonly canEdit: boolean
}

/**
 * Find the vendor for one model name.
 * @param catalog - a read of the servable models, or undefined to skip the check.
 * @param model - the requested model id.
 * @returns the provider, or undefined when nothing here can draw with that name.
 */
export function resolveImageModel(catalog: ImageCatalog | undefined, model: string): ResolvedImageModel | undefined {
  const listed = catalog?.models.get(model)
  if (listed !== undefined) return { provider: listed.provider, confirmed: true, canEdit: listed.canEdit }
  if (catalog !== undefined) return undefined
  const assumed = IMAGE_PROVIDERS.find(provider => provider.fallbackModels.includes(model))
  return assumed === undefined ? undefined : { provider: assumed, confirmed: false, canEdit: false }
}

/**
 * Which model draws when nobody named one.
 *
 * There is no compiled-in answer to fall back on, deliberately. A name written
 * into this build is a claim about a route we do not control: the delivery
 * endpoint is what guarantees quality, and when it has not spoken the honest
 * substitute is *something this key can actually serve right now* — not a name
 * that was servable on the machine where the release was cut. We shipped that
 * bug: an unnamed call whose compiled default had no channel on this key was
 * refused by name, while twenty other image models sat in the same catalogue.
 *
 * The delivered default is honoured whenever it can do the job, and stepping
 * off it is not the silent swap this tool exists to prevent — nobody chose it
 * for this call, and the result reports which model actually drew.
 * @param catalog - the catalogue read, or undefined when it is unreadable.
 * @param delivered - the server-delivered default, when there is one.
 * @param editing - whether this call changes an existing picture.
 * @returns the model to draw with, or undefined when nothing here can.
 */
export function defaultImageModel(
  catalog: ImageCatalog | undefined,
  delivered: string | undefined,
  editing: boolean,
): string | undefined {
  const fit = (entry: ImageCatalogEntry | undefined): boolean =>
    entry !== undefined && (!editing || entry.canEdit)
  if (delivered !== undefined && delivered !== '') {
    if (catalog === undefined) return delivered
    if (fit(catalog.models.get(delivered))) return delivered
  }
  // Unreadable catalogue and nothing delivered: there is no answer to give, and
  // inventing one would spend the user's money on a guess about a pool we just
  // failed to read.
  if (catalog === undefined) return undefined
  const usable = [...catalog.models.values()].filter(entry => fit(entry))
  const transport = (entry: ImageCatalogEntry): number => {
    const index = TRANSPORT_PREFERENCE.indexOf(entry.provider.id)
    // An adapter nobody ranked still works; it just goes last rather than
    // silently outranking the measured ones.
    return index === -1 ? TRANSPORT_PREFERENCE.length : index
  }
  const proven = (entry: ImageCatalogEntry): number => {
    const index = entry.provider.fallbackModels.indexOf(entry.id)
    return index === -1 ? entry.provider.fallbackModels.length : index
  }
  return usable.sort((left, right) => transport(left) - transport(right)
    || proven(left) - proven(right)
    || left.id.localeCompare(right.id))[0]?.id
}

/**
 * The refusal for having no model to draw with at all.
 *
 * Distinct from every other refusal here because nothing was named: the model
 * cannot fix this by picking differently, so the message says whose problem it
 * is rather than listing alternatives that do not exist.
 * @param catalog - the catalogue read, or undefined when it is unreadable.
 * @param editing - whether the call was asking for a change to a picture.
 * @returns the model-facing message.
 */
export function imageDefaultRefusal(catalog: ImageCatalog | undefined, editing: boolean): string {
  if (catalog === undefined) {
    return '现在查不到这个账号能用哪些出图模型（可能还没登录，或者接口暂时不通），所以没有可用的出图模型。稍后再试。'
  }
  return editing
    ? '这个账号现在一个能改图的模型都没有，所以这张图改不了。'
    : '这个账号现在一个能出图的模型都没有。请让管理员在后台配一个默认出图模型，或者确认这把密钥的分组里有出图渠道。'
}

/**
 * The refusal for asking a model to edit when it cannot.
 *
 * Separate from `imageModelRefusal` because the two are different answers: that
 * one means "this name draws nothing here", this one means "this name draws but
 * does not edit". Both list what would work, and neither substitutes — an edit
 * quietly served as a fresh drawing is the exact outcome this path exists to
 * make impossible.
 * @param catalog - the read that carried the model.
 * @param model - the requested model id.
 * @returns the model-facing message.
 */
export function imageEditRefusal(catalog: ImageCatalog | undefined, model: string): string {
  if (catalog === undefined) {
    return `现在查不到这个账号能用哪些出图模型，所以不能确定「${model}」改不改得了图。`
      + '这时候改图会变成照提示词重画一张新的，与你要的不是一回事，所以没有发出去。隔一会儿再试。'
  }
  const editable = [...catalog.models.values()].filter(entry => entry.canEdit).map(entry => entry.id).sort()
  return `「${model}」在这个账号上只能凭提示词出新图，没有改图这条路径。`
    + (editable.length === 0
      ? '这个账号现在一个能改图的模型都没有。'
      : `能改图的是：${editable.join('、')}。`)
}

/**
 * The refusal for a name this key cannot draw with.
 *
 * It names what is available because the model that picked the name has no other
 * way to find out, and the user who asked for it deserves to know their choice
 * was not silently swapped for the default.
 * @param catalog - the read that failed to carry the name.
 * @param model - the requested model id.
 * @returns the model-facing message.
 */
export function imageModelRefusal(catalog: ImageCatalog | undefined, model: string): string {
  const usable = catalog === undefined ? [] : [...catalog.models.keys()].sort()
  const head = catalog?.present.has(model) === true
    ? `「${model}」这个账号有，但本工具还没接它走的那条厂商专属接口，所以出不了图。`
    : `这个账号的出图接口上没有「${model}」。（可能已下架，或者这把密钥的分组没有它的渠道。）`
  return head + (usable.length === 0
    ? '现在一个可用的出图模型都查不到，请稍后再试。'
    : `当前可用的是：${usable.join('、')}。`)
}
