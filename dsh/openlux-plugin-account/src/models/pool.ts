/**
 * Which chat models this machine's key may actually pick from.
 *
 * Two questions, two endpoints, and both have to answer:
 *
 * - **"can this key call it?"** — `GET /v1/models`, which is the only
 *   authority: it passes the authorization layer (user group to channel group)
 *   and the token's own model limits, and no single table in the console
 *   database reproduces that.
 * - **"is it on sale?"** — unauthenticated `GET /api/pricing`, the global
 *   square metadata. `/v1/models` does not check `show_in_square`, so
 *   it answers ~77 models more than the pricing page lists; offering one of
 *   those is asking someone to spend money at a price we never published.
 *
 * The square is also where a model's category starts. `/v1/models` says
 * nothing usable about it, but the square cannot be treated as complete:
 * the local development station currently leaves `model_type` blank on 81/101
 * rows and marks several generation models as 对话. Use explicit metadata first,
 * then the same conservative non-chat name guard as the previous desktop shell.
 *
 * A round that cannot answer both questions answers neither: the caller skips
 * the sync rather than writing a list built from half the truth. That is the
 * same discipline the expert reconciler follows — no snapshot, no reconcile.
 *
 * @module openlux-plugin-account/models/pool
 */

import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { ACCOUNT_TIMEOUT_MS, normalizeBase, requestJson } from '../account/http.ts'
import { registerModelCacheInvalidator } from './runtime-cache.ts'

const CALLABLE_CACHE_TTL_MS = 2 * 60_000
const SQUARE_CACHE_TTL_MS = 60_000
const MAX_TOKEN_CACHE_ENTRIES = 8

interface CacheEntry<T> {
  readonly at: number
  readonly value: T
}

const callableCache = new Map<string, CacheEntry<Set<string>>>()
const callableFlights = new Map<string, Promise<Set<string> | undefined>>()
const squareCache = new Map<string, CacheEntry<PoolModel[]>>()
const squareFlights = new Map<string, Promise<PoolModel[] | undefined>>()

function tokenDigest(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 24)
}

/** Drop bounded runtime catalog caches on token/account routing changes. */
export function invalidateModelPool(apiKey?: string): void {
  if (apiKey === undefined) {
    callableCache.clear()
    callableFlights.clear()
    return
  }
  const suffix = `|${tokenDigest(apiKey)}`
  for (const key of callableCache.keys()) {
    if (key.endsWith(suffix)) callableCache.delete(key)
  }
  for (const key of callableFlights.keys()) {
    if (key.endsWith(suffix)) callableFlights.delete(key)
  }
}

registerModelCacheInvalidator(() => invalidateModelPool())

/** One model the user may pick, as the two endpoints jointly describe it. */
export interface PoolModel {
  readonly id: string
  /** Console-side tags, kept for display only — never for capability judgement. */
  readonly tags?: string
}

/** `/v1/models` entry, all fields untrusted. */
interface ListingEntry {
  readonly id?: unknown
}

/** `/api/pricing` row, all fields untrusted. */
export interface PricingRow {
  readonly model_name?: unknown
  readonly model_type?: unknown
  readonly tags?: unknown
  readonly supported_endpoint_types?: unknown
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Whether a square row belongs to the category its UI labels as "对话".
 *
 * The square keeps the raw value for filtering but normalizes both `chat` and
 * `text` to the same visible label as `对话`
 * (`new-yunwu-api/web/src/helpers/modelMetaI18n.js`). Keep that exact contract
 * here so fetching the square does not silently drop one of its visible
 * conversation buckets. Blank metadata remains unknown rather than guessed.
 */
export function isChatModelType(value: unknown): boolean {
  const modelType = textOf(value)
  if (modelType.includes('对话')) return true
  const normalized = modelType.toLowerCase()
  return normalized === 'chat' || normalized === 'text'
}

function includesAny(value: string, needles: readonly string[]): boolean {
  const normalized = value.toLowerCase()
  return needles.some(needle => normalized.includes(needle))
}

function hasWord(value: string, words: readonly string[]): boolean {
  const normalized = value.toLowerCase()
  return words.some(word => new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`, 'u').test(normalized))
}

/**
 * Reject names that unambiguously identify a non-chat operation.
 *
 * This guard intentionally runs before `model_type`: the station has rows such
 * as `aigc-video-hailuo` and `gemini-2.5-flash-image` labelled 对话. Ambiguous
 * capability words such as "multimodal" are absent here, so a chat model that
 * can *read* media is not mistaken for a model that *produces* it.
 */
function nonChatByName(id: string): boolean {
  const value = id.toLowerCase()
  if (
    hasWord(value, ['image', 'images', 'imagen'])
    || includesAny(value, ['dall-e', 'dalle', 'midjourney', 'mj_', 'stable-diffusion', 'flux', 'ideogram', 'recraft', 'kolors', 'seedream'])
  ) return true
  if (
    hasWord(value, ['video', 'sora', 'veo', 'kling', 'hailuo', 'vidu', 'luma', 'runway', 'pixverse'])
    || includesAny(value, ['seedance', 'wanx'])
  ) return true
  if (hasWord(value, ['tts', 'stt', 'whisper', 'audio', 'speech', 'voice', 'suno', 'realtime', 'music'])) {
    return true
  }
  if (
    includesAny(value, ['embed', 'text2vec', 'moderation', 'rerank'])
    || hasWord(value, ['bge', 'm3e', 'ada', 'curie', 'babbage', 'davinci'])
  ) return true
  return false
}

/**
 * Whether one pricing row is safe to expose through the chat adapter.
 *
 * Missing metadata falls back to chat only after unambiguous non-chat ids,
 * endpoint declarations, and output tags have been excluded. This is not an
 * optimistic capability claim: `/v1/models` still has to say the token can call
 * the id, and media capabilities remain owned by their dedicated registries.
 */
export function isChatPricingModel(row: PricingRow): boolean {
  const id = textOf(row.model_name)
  if (id === '' || nonChatByName(id)) return false

  const modelType = textOf(row.model_type)
  if (isChatModelType(modelType)) return true
  if (includesAny(modelType, ['图像', '绘画', 'image', '视频', 'video', '音频', '语音', 'audio', 'tts', 'stt', '音乐', '向量', 'embed', '检索', 'rerank'])) {
    return false
  }

  const endpoints = Array.isArray(row.supported_endpoint_types)
    ? row.supported_endpoint_types.filter((value): value is string => typeof value === 'string').join(',')
    : ''
  if (includesAny(endpoints, ['image-generation', '文生图', '图生图', '生图', '绘画', 'video', '视频', 'tts', 'stt', 'audio', 'speech', '语音', 'embedding', 'rerank'])) {
    return false
  }

  const tags = textOf(row.tags)
  if (includesAny(tags, ['文生图', '图生图', '生图', '绘画', '文生视频', '图生视频', '文本转语音', '转录', '音乐', '向量', '嵌入', '重排'])) {
    return false
  }
  return true
}

/**
 * Ids this key can call right now.
 * @param ctx - host context.
 * @param baseUrl - console origin.
 * @param apiKey - the `sk-` key.
 * @param signal - caller cancellation.
 * @returns the id set, or undefined when the endpoint did not answer usably.
 */
async function callableIds(
  ctx: Context,
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Set<string> | undefined> {
  const key = `${normalizeBase(baseUrl)}|${tokenDigest(apiKey)}`
  const cached = callableCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < CALLABLE_CACHE_TTL_MS) {
    callableCache.delete(key)
    callableCache.set(key, cached)
    return new Set(cached.value)
  }
  const existing = callableFlights.get(key)
  if (existing !== undefined) return existing
  const flight = (async (): Promise<Set<string> | undefined> => {
    const { response, body } = await requestJson(
      ctx,
      `${normalizeBase(baseUrl)}/v1/models`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
      ACCOUNT_TIMEOUT_MS,
      signal,
    )
    if (!response.ok) return undefined
    const rows = (body as { data?: unknown } | undefined)?.data
    if (!Array.isArray(rows)) return undefined
    const ids = new Set<string>()
    for (const row of rows as ListingEntry[]) {
      const id = textOf(row?.id)
      if (id !== '') ids.add(id)
    }
    if (ids.size === 0) return undefined
    callableCache.set(key, { at: Date.now(), value: ids })
    while (callableCache.size > MAX_TOKEN_CACHE_ENTRIES) {
      const oldest = callableCache.keys().next().value as string | undefined
      if (oldest === undefined) break
      callableCache.delete(oldest)
    }
    return new Set(ids)
  })().finally(() => callableFlights.delete(key))
  callableFlights.set(key, flight)
  return flight
}

/**
 * Chat models in the global square metadata.
 *
 * The square's metadata is the reason this call is not optional. Explicit
 * Chinese and legacy English types are used where trustworthy; incomplete or
 * contradictory rows pass through {@link isChatPricingModel}'s conservative
 * fallback.
 * @param ctx - host context.
 * @param baseUrl - console origin.
 * @param signal - caller cancellation.
 * @returns listed chat models in square order, or undefined when unusable.
 */
async function listedChatModels(
  ctx: Context,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<PoolModel[] | undefined> {
  const key = normalizeBase(baseUrl)
  const cached = squareCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < SQUARE_CACHE_TTL_MS) {
    return cached.value.map(model => ({ ...model }))
  }
  const existing = squareFlights.get(key)
  if (existing !== undefined) return existing
  const flight = (async (): Promise<PoolModel[] | undefined> => {
    const { response, body } = await requestJson(
      ctx,
      `${key}/api/pricing`,
      { method: 'GET' },
      ACCOUNT_TIMEOUT_MS,
      signal,
    )
    if (!response.ok) return undefined
    const rows = (body as { data?: unknown } | undefined)?.data
    if (!Array.isArray(rows)) return undefined
    const models: PoolModel[] = []
    for (const row of rows as PricingRow[]) {
      const id = textOf(row?.model_name)
      if (id === '' || !isChatPricingModel(row)) continue
      const tags = textOf(row?.tags)
      models.push({ id, ...tags === '' ? {} : { tags } })
    }
    if (models.length === 0) return undefined
    squareCache.set(key, { at: Date.now(), value: models })
    return models.map(model => ({ ...model }))
  })().finally(() => squareFlights.delete(key))
  squareFlights.set(key, flight)
  return flight
}

/**
 * The pickable chat pool: on sale, and callable with this key.
 * @param ctx - host context.
 * @param baseUrl - console origin.
 * @param apiKey - the `sk-` key.
 * @param signal - caller cancellation.
 * @returns the pool, or undefined when either endpoint failed to answer.
 */
export async function fetchChatPool(
  ctx: Context,
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<PoolModel[] | undefined> {
  const [callable, listed] = await Promise.all([
    callableIds(ctx, baseUrl, apiKey, signal),
    listedChatModels(ctx, baseUrl, signal),
  ])
  if (callable === undefined || listed === undefined) return undefined
  const pool = listed.filter(model => callable.has(model.id))
  return pool.length > 0 ? pool : undefined
}
