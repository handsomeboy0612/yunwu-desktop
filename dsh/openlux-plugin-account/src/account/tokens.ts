/**
 * User-token management stays host-side.
 *
 * The console returns complete token keys to its own web UI. The desktop
 * browser must not receive them: this service compares and stores keys behind
 * `ctx.credentials`, then exposes only ids and masked tails over RPC.
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  ManagedToken,
  RoutingPriority,
  TokenDraft,
  TokenGroup,
  TokenListSnapshot,
  TokenUpdateDraft,
} from '../token-wire.ts'
import type { BalanceReader } from './balance.ts'
import { ACCOUNT_TIMEOUT_MS, asEnvelope, requestJson } from './http.ts'
import { readSession, type StoredSession } from './session.ts'
import { invalidateRuntimeModelCaches } from '../models/runtime-cache.ts'
import type { ModelSyncCoordinator } from '../models/coordinator.ts'

const API_KEY_REF = credentialRef('OPENLUX_API_KEY')
const ROUTING_PRIORITIES: readonly RoutingPriority[] = ['', 'auto', 'price', 'speed', 'success_rate']

interface ApiToken {
  id?: unknown
  key?: unknown
  status?: unknown
  name?: unknown
  created_time?: unknown
  accessed_time?: unknown
  expired_time?: unknown
  remain_quota?: unknown
  unlimited_quota?: unknown
  used_quota?: unknown
  group?: unknown
  group_ids?: unknown
  routing_priority?: unknown
}

interface PageData {
  items?: unknown
  total?: unknown
}

interface GroupData {
  data?: unknown
  ratios?: unknown
  descriptions?: unknown
  group_ids?: unknown
  availability?: unknown
}

/** Host implementation behind `tokens.*` account RPC methods. */
export class TokenManager {
  constructor(
    private readonly ctx: Context,
    private readonly balance: BalanceReader,
    private readonly modelSync: Pick<ModelSyncCoordinator, 'preflight' | 'refresh'>,
  ) {}

  /** List account tokens without ever crossing a full key into the browser. */
  async list(signal?: AbortSignal): Promise<TokenListSnapshot> {
    const session = await this.requireSession()
    const [rows, credential, resolved, currency] = await Promise.all([
      this.readAll(session, signal),
      this.ctx.credentials.describe(API_KEY_REF),
      this.ctx.credentials.resolve(API_KEY_REF),
      this.balance.currencyFor(session.baseUrl, signal),
    ])
    const currentKey = resolved === undefined ? undefined : normalizeKey(resolved.value)
    const current = currentKey === undefined
      ? undefined
      : rows.find(row => normalizeKey(String(row.key ?? '')) === currentKey)
    return {
      tokens: rows.map(publicToken),
      ...(current === undefined ? {} : { currentId: integer(current.id) }),
      credentialWritable: credential.writable,
      ...(credential.source === undefined ? {} : { credentialSource: credential.source }),
      quotaUnit: currency,
    }
  }

  /** Groups available to this account, including ratios and descriptions. */
  async groups(signal?: AbortSignal): Promise<readonly TokenGroup[]> {
    const session = await this.requireSession()
    const data = await this.call<GroupData>(session, '/api/user/self/groups', { method: 'GET' }, signal)
    const names = record(data.data)
    const ids = record(data.group_ids)
    const ratios = record(data.ratios)
    const descriptions = record(data.descriptions)
    const availability = record(data.availability)
    const groups = Object.entries(names).flatMap(([name, rawLabel]): TokenGroup[] => {
      const id = integer(ids[name])
      if (id <= 0) return []
      const health = record(availability[name])
      return [{
        id,
        name,
        label: text(rawLabel) || name,
        description: text(descriptions[name]),
        ratio: finite(ratios[name], 1),
        availability: healthStatus(health.status),
      }]
    })
    return groups.sort((a, b) => a.ratio - b.ratio || a.label.localeCompare(b.label, 'zh-CN'))
  }

  /** Create one token; the generated key remains on the host. */
  async create(payload: unknown, signal?: AbortSignal): Promise<void> {
    const session = await this.requireSession()
    const draft = parseDraft(payload)
    await this.call(session, '/api/token/', {
      method: 'POST',
      headers: jsonHeaders(session),
      body: JSON.stringify(toApiDraft(draft)),
    }, signal)
  }

  /** Update only fields owned by this UI through the safe batch endpoint. */
  async update(payload: unknown, signal?: AbortSignal): Promise<void> {
    const session = await this.requireSession()
    const update = parseUpdateDraft(payload)
    const merged = isCompleteDraft(update.changes)
      ? validateDraft(update.changes)
      : validateDraft({ ...draftFromApi(await this.readOne(update.id, session, signal)), ...update.changes })
    const updateFields = Object.keys(update.changes) as (keyof TokenDraft)[]
    if (updateFields.length === 0) return
    await this.call(session, '/api/token/batch', {
      method: 'PUT',
      headers: jsonHeaders(session),
      body: JSON.stringify({
        ids: [update.id],
        update_fields: updateFields.map(apiFieldName),
        ...toApiChanges(merged, updateFields),
      }),
    }, signal)
    if (await this.isCurrent(update.id, session, signal)) {
      const current = await this.ctx.credentials.resolve(API_KEY_REF)
      if (current !== undefined) invalidateRuntimeModelCaches()
      await this.modelSync.refresh('token-routing-update', signal)
    }
  }

  /** Make an enabled account token the key resolved by every OpenLux request. */
  async use(payload: unknown, signal?: AbortSignal): Promise<void> {
    const id = positiveId(payload)
    const session = await this.requireSession()
    const info = await this.ctx.credentials.describe(API_KEY_REF)
    if (!info.writable) {
      throw new Error(`当前 API 密钥由只读来源 ${info.source ?? 'environment'} 提供，无法在客户端切换`)
    }
    const token = await this.readOne(id, session, signal)
    if (integer(token.status) !== 1) throw new Error('该令牌已停用，不能设为当前令牌')
    if (isExpired(token.expired_time)) throw new Error('该令牌已过期，不能设为当前令牌')
    const key = normalizeKey(text(token.key))
    if (key === '') throw new Error('中转站没有返回该令牌的密钥')
    const fullKey = `sk-${key}`
    await this.modelSync.preflight(fullKey, signal)
    await this.ctx.credentials.set(API_KEY_REF, fullKey)
    try {
      await this.modelSync.refresh('token-change', signal, fullKey)
    } catch (error: unknown) {
      throw new Error(`令牌已切换，模型目录刷新失败，可重试同步：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Delete a non-current token after the client-side confirmation. */
  async remove(payload: unknown, signal?: AbortSignal): Promise<void> {
    const id = positiveId(payload)
    const session = await this.requireSession()
    if (await this.isCurrent(id, session, signal)) {
      throw new Error('当前正在使用的令牌不能删除，请先切换到另一把令牌')
    }
    await this.call(session, `/api/token/${id}`, {
      method: 'DELETE',
      headers: authHeaders(session),
    }, signal)
  }

  private async requireSession(): Promise<StoredSession> {
    const session = await readSession(this.ctx)
    if (session === undefined) throw new Error('登录后才能管理令牌')
    return session
  }

  private async readAll(session: StoredSession, signal?: AbortSignal): Promise<ApiToken[]> {
    const first = await this.call<PageData>(session, '/api/token/?page=1&page_size=100', { method: 'GET' }, signal)
    const rows = apiTokens(first.items)
    const total = Math.max(rows.length, integer(first.total))
    for (let page = 2; rows.length < total; page += 1) {
      const next = await this.call<PageData>(
        session,
        `/api/token/?page=${page}&page_size=100`,
        { method: 'GET' },
        signal,
      )
      const items = apiTokens(next.items)
      if (items.length === 0) break
      rows.push(...items)
    }
    return rows
  }

  private async readOne(id: number, session: StoredSession, signal?: AbortSignal): Promise<ApiToken> {
    return this.call<ApiToken>(session, `/api/token/${id}`, { method: 'GET' }, signal)
  }

  private async isCurrent(id: number, session: StoredSession, signal?: AbortSignal): Promise<boolean> {
    const resolved = await this.ctx.credentials.resolve(API_KEY_REF)
    if (resolved === undefined) return false
    const token = await this.readOne(id, session, signal)
    return normalizeKey(text(token.key)) === normalizeKey(resolved.value)
  }

  private async call<T>(
    session: StoredSession,
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<T> {
    const { response, body } = await requestJson(
      this.ctx,
      `${session.baseUrl}${path}`,
      { ...init, headers: mergeHeaders(init.headers, authHeaders(session)) },
      ACCOUNT_TIMEOUT_MS,
      signal,
    )
    const envelope = asEnvelope<T>(body)
    if (!response.ok || envelope.success !== true || envelope.data === undefined) {
      throw new Error(envelope.message ?? `令牌请求失败（HTTP ${response.status}）`)
    }
    return envelope.data
  }
}

function authHeaders(session: StoredSession): HeadersInit {
  return { Cookie: session.cookie, 'New-Api-User': String(session.userId) }
}

function jsonHeaders(session: StoredSession): HeadersInit {
  return { ...authHeaders(session), 'Content-Type': 'application/json' }
}

function mergeHeaders(...parts: (HeadersInit | undefined)[]): Headers {
  const merged = new Headers()
  for (const part of parts) {
    if (part === undefined) continue
    new Headers(part).forEach((value, key) => { merged.set(key, value) })
  }
  return merged
}

function publicToken(source: ApiToken): ManagedToken {
  const key = normalizeKey(text(source.key))
  const routing = text(source.routing_priority)
  return {
    id: integer(source.id),
    name: text(source.name) || '未命名令牌',
    maskedKey: key === '' ? 'sk-••••' : `sk-••••${key.slice(-4)}`,
    status: integer(source.status),
    routingPriority: isRoutingPriority(routing) ? routing : '',
    groupIds: integers(source.group_ids),
    groupNames: text(source.group).split(',').map(value => value.trim()).filter(Boolean),
    unlimitedQuota: source.unlimited_quota === true,
    remainQuota: integer(source.remain_quota),
    usedQuota: integer(source.used_quota),
    createdTime: integer(source.created_time),
    accessedTime: integer(source.accessed_time),
    expiredTime: integer(source.expired_time, -1),
  }
}

function parseDraft(payload: unknown): TokenDraft {
  const data = record(payload)
  return validateDraft({
    name: text(data.name).trim(),
    routingPriority: text(data.routingPriority) as RoutingPriority,
    groupIds: uniquePositiveIds(data.groupIds),
    unlimitedQuota: data.unlimitedQuota === true,
    remainQuota: integer(data.remainQuota),
    expiredTime: integer(data.expiredTime, -1),
  })
}

function validateDraft(draft: TokenDraft): TokenDraft {
  const name = draft.name.trim()
  if (name === '') throw new Error('令牌名称不能为空')
  if ([...name].length > 30) throw new Error('令牌名称不能超过 30 个字符')
  const routingPriority = draft.routingPriority
  if (!isRoutingPriority(routingPriority)) throw new Error('智能路由选项无效')
  const groupIds = uniquePositiveIds(draft.groupIds)
  if (routingPriority === '' && groupIds.length === 0) throw new Error('关闭智能路由后至少选择一个渠道分组')
  const unlimitedQuota = draft.unlimitedQuota
  const remainQuota = integer(draft.remainQuota)
  if (!unlimitedQuota && remainQuota < 0) throw new Error('剩余额度不能小于 0')
  const expiredTime = integer(draft.expiredTime, -1)
  if (expiredTime !== -1 && expiredTime <= 0) throw new Error('有效期无效')
  return { name, routingPriority, groupIds, unlimitedQuota, remainQuota, expiredTime }
}

function parseUpdateDraft(payload: unknown): TokenUpdateDraft {
  const root = record(payload)
  // Accept the pre-partial RPC shape during rolling desktop upgrades.
  const data = 'changes' in root ? record(root.changes) : root
  const changes: Partial<TokenDraft> = {
    ...'name' in data ? { name: text(data.name).trim() } : {},
    ...'routingPriority' in data ? { routingPriority: text(data.routingPriority) as RoutingPriority } : {},
    ...'groupIds' in data ? { groupIds: uniquePositiveIds(data.groupIds) } : {},
    ...'unlimitedQuota' in data ? { unlimitedQuota: data.unlimitedQuota === true } : {},
    ...'remainQuota' in data ? { remainQuota: integer(data.remainQuota) } : {},
    ...'expiredTime' in data ? { expiredTime: integer(data.expiredTime, -1) } : {},
  }
  return { id: positiveId(payload), changes }
}

function isCompleteDraft(changes: Partial<TokenDraft>): changes is TokenDraft {
  return changes.name !== undefined
    && changes.routingPriority !== undefined
    && changes.groupIds !== undefined
    && changes.unlimitedQuota !== undefined
    && changes.remainQuota !== undefined
    && changes.expiredTime !== undefined
}

function toApiDraft(draft: TokenDraft): Record<string, unknown> {
  return {
    name: draft.name,
    routing_priority: draft.routingPriority,
    group_ids: [...draft.groupIds],
    unlimited_quota: draft.unlimitedQuota,
    remain_quota: draft.remainQuota,
    expired_time: draft.expiredTime,
  }
}

function draftFromApi(source: ApiToken): TokenDraft {
  const routing = text(source.routing_priority)
  return {
    name: text(source.name),
    routingPriority: isRoutingPriority(routing) ? routing : '',
    groupIds: uniquePositiveIds(source.group_ids),
    unlimitedQuota: source.unlimited_quota === true,
    remainQuota: integer(source.remain_quota),
    expiredTime: integer(source.expired_time, -1),
  }
}

function apiFieldName(field: keyof TokenDraft): string {
  switch (field) {
    case 'name': return 'name'
    case 'routingPriority': return 'routing_priority'
    case 'groupIds': return 'group_ids'
    case 'unlimitedQuota': return 'unlimited_quota'
    case 'remainQuota': return 'remain_quota'
    case 'expiredTime': return 'expired_time'
  }
}

function toApiChanges(draft: TokenDraft, fields: readonly (keyof TokenDraft)[]): Record<string, unknown> {
  const full = toApiDraft(draft)
  return Object.fromEntries(fields.map(field => {
    const name = apiFieldName(field)
    return [name, full[name]]
  }))
}

function positiveId(payload: unknown): number {
  const id = integer(record(payload).id)
  if (id <= 0) throw new Error('令牌 ID 无效')
  return id
}

function isRoutingPriority(value: string): value is RoutingPriority {
  return ROUTING_PRIORITIES.includes(value as RoutingPriority)
}

function normalizeKey(value: string): string {
  return value.trim().replace(/^sk-/, '')
}

function isExpired(value: unknown, now = Math.floor(Date.now() / 1000)): boolean {
  const expiry = integer(value, -1)
  return expiry !== -1 && expiry <= now
}

function apiTokens(value: unknown): ApiToken[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'object' && item !== null) as ApiToken[] : []
}

function uniquePositiveIds(value: unknown): number[] {
  return [...new Set(integers(value).filter(id => id > 0))]
}

function integers(value: unknown): number[] {
  return Array.isArray(value) ? value.map(item => integer(item)).filter(Number.isFinite) : []
}

function integer(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

function finite(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function healthStatus(value: unknown): TokenGroup['availability'] {
  switch (value) {
    case 'healthy':
    case 'degraded':
    case 'unhealthy':
    case 'unavailable':
      return value
    default:
      return 'unknown'
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
