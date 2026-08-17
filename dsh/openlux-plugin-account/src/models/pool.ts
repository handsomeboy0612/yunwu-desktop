/**
 * Which chat models this machine's key may actually pick from.
 *
 * Two questions, two endpoints, and both have to answer:
 *
 * - **"can this key call it?"** — `GET /v1/models`, which is the only
 *   authority: it passes the authorization layer (user group to channel group)
 *   and the token's own model limits, and no single table in the console
 *   database reproduces that.
 * - **"is it on sale?"** — `GET /api/pricing_new`, the model square as the
 *   user's own group sees it. `/v1/models` does not check `show_in_square`, so
 *   it answers ~77 models more than the pricing page lists; offering one of
 *   those is asking someone to spend money at a price we never published.
 *
 * The square is also where a model's category comes from. `/v1/models` says
 * nothing usable about it, and guessing from the name is how a vector model
 * once ended up in the chat picker — and, because its tag said 推理, got picked
 * as a default.
 *
 * A round that cannot answer both questions answers neither: the caller skips
 * the sync rather than writing a list built from half the truth. That is the
 * same discipline the expert reconciler follows — no snapshot, no reconcile.
 *
 * @module openlux-plugin-account/models/pool
 */

import type { Context } from '@deepseek-ai/cordis'
import { ACCOUNT_TIMEOUT_MS, normalizeBase, requestJson } from '../account/http.ts'

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

/** `/api/pricing_new` row, all fields untrusted. */
interface PricingRow {
  readonly model_name?: unknown
  readonly model_type?: unknown
  readonly tags?: unknown
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
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
  return ids.size > 0 ? ids : undefined
}

/**
 * Chat models the square lists for this account's group.
 *
 * `model_type` is the console's own classification and the reason this call is
 * not optional. Its wording is Chinese and its values include 音视频, so the
 * test is containment of 对话 rather than equality.
 * @param ctx - host context.
 * @param baseUrl - console origin.
 * @param apiKey - the `sk-` key, so the square is computed for this account's group.
 * @param signal - caller cancellation.
 * @returns listed chat models in square order, or undefined when unusable.
 */
async function listedChatModels(
  ctx: Context,
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<PoolModel[] | undefined> {
  const { response, body } = await requestJson(
    ctx,
    `${normalizeBase(baseUrl)}/api/pricing_new`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    ACCOUNT_TIMEOUT_MS,
    signal,
  )
  if (!response.ok) return undefined
  const rows = (body as { data?: unknown } | undefined)?.data
  if (!Array.isArray(rows)) return undefined
  const models: PoolModel[] = []
  for (const row of rows as PricingRow[]) {
    const id = textOf(row?.model_name)
    if (id === '' || !textOf(row?.model_type).includes('对话')) continue
    const tags = textOf(row?.tags)
    models.push({ id, ...tags === '' ? {} : { tags } })
  }
  return models.length > 0 ? models : undefined
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
    listedChatModels(ctx, baseUrl, apiKey, signal),
  ])
  if (callable === undefined || listed === undefined) return undefined
  const pool = listed.filter(model => callable.has(model.id))
  return pool.length > 0 ? pool : undefined
}
