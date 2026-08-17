/**
 * Account balance for the sidebar line.
 *
 * `GET /api/user/self` is the only route that reports account quota, and it is
 * user-scoped — see `auth.ts` for why that means the session cookie and not
 * the `sk-` key.
 *
 * The four outcomes exist so the line never prints `0`. A zero balance and a
 * failed request look identical once rendered, and of the two readings the
 * user acts on ("my money is gone") is the wrong one. So a failed refresh
 * either falls back to the last value it can label as possibly stale, or says
 * plainly that it could not read one.
 *
 * The cache is in memory only. See `session.ts` for why nothing here is
 * written to disk.
 */

import type { Context } from '@deepseek-ai/cordis'
import { asEnvelope, BALANCE_TIMEOUT_MS, requestJson } from './http.ts'
import { clearSession, readSession } from './session.ts'

/** Refresh throttle: opening a menu and focusing a window both ask. */
const FRESH_TTL_MS = 30_000

/** Site currency settings change about never; re-reading them every time does not. */
const CURRENCY_TTL_MS = 10 * 60_000

/** A balance ready to render. */
export interface Balance {
  readonly quota: number
  /** Formatted for display, symbol included. */
  readonly display: string
  /** Below one currency unit — the sidebar warns rather than just showing it. */
  readonly low: boolean
  readonly usedDisplay: string
  readonly group: string
  readonly username: string
  readonly userId: number
  readonly requestCount: number
  readonly fetchedAt: number
}

/** A read of the balance, and how much to trust it. */
export type BalanceSnapshot =
  /** Fresh from the console. */
  | { readonly status: 'ok'; readonly balance: Balance }
  /** This read failed; the value shown is the previous one. */
  | { readonly status: 'stale'; readonly balance: Balance; readonly message: string }
  /** The session is gone or was never stored; signing in again restores it. */
  | { readonly status: 'expired'; readonly balance?: Balance; readonly message: string }
  /** No value to show, and not because of the session. */
  | { readonly status: 'unavailable'; readonly message: string }

interface SelfData {
  id?: number
  username?: string
  quota?: number
  used_quota?: number
  request_count?: number
  group?: string
}

/** How the site renders quota integers as money. */
interface Currency {
  perUnit: number
  symbol: string
  rate: number
  /** TOKENS sites show the raw quota with no symbol and no conversion. */
  tokens: boolean
}

const DEFAULT_CURRENCY: Currency = { perUnit: 500_000, symbol: '$', rate: 1, tokens: false }

/** Per-process balance state; the sidebar is the only consumer. */
export class BalanceReader {
  private currency: { value: Currency; at: number } | undefined
  private last: Balance | undefined
  private inFlight: Promise<BalanceSnapshot> | undefined

  constructor(private readonly ctx: Context) {}

  /**
   * Read the balance, coalescing concurrent asks and honouring the throttle.
   * @param force - user pressed refresh; skip the throttle but still coalesce.
   * @param signal - caller cancellation.
   * @returns the snapshot and its trust level.
   */
  async read(force = false, signal?: AbortSignal): Promise<BalanceSnapshot> {
    if (!force && this.last !== undefined && Date.now() - this.last.fetchedAt < FRESH_TTL_MS) {
      return { status: 'ok', balance: this.last }
    }
    this.inFlight ??= this.fetch(signal).finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  /** Drop the cached value so the next account does not see the previous one's. */
  forget(): void {
    this.last = undefined
  }

  private async fetch(signal?: AbortSignal): Promise<BalanceSnapshot> {
    const session = await readSession(this.ctx)
    if (session === undefined) {
      return { status: 'expired', ...this.lastIfAny(), message: '登录后即可查看余额' }
    }

    // Started before the account read so a cold currency cache does not add a
    // second round trip; it swallows its own failures, so this cannot fail the
    // balance on its own.
    const currency = this.readCurrency(session.baseUrl, signal)

    let response: Response
    let body: unknown
    try {
      ({ response, body } = await requestJson(
        this.ctx,
        `${session.baseUrl}/api/user/self`,
        { method: 'GET', headers: { Cookie: session.cookie, 'New-Api-User': String(session.userId) } },
        BALANCE_TIMEOUT_MS,
        signal,
      ))
    } catch (error: unknown) {
      return this.staleOr(error instanceof Error ? error.message : String(error))
    }

    // A dead session answers 401. Dropping it here stops every later refresh
    // from replaying a credential the console has already refused.
    if (response.status === 401) {
      await clearSession(this.ctx).catch(() => {})
      return { status: 'expired', ...this.lastIfAny(), message: '登录已过期，重新登录即可查看余额' }
    }

    const envelope = asEnvelope<SelfData>(body)
    if (!response.ok || envelope.success !== true || envelope.data === undefined) {
      const message = envelope.message ?? `获取账户信息失败（HTTP ${response.status}）`
      // A 200 can still mean "not signed in"; the console says so in words.
      if (/无权|未登录|登录已过期|access token|token 无效/i.test(message)) {
        await clearSession(this.ctx).catch(() => {})
        return { status: 'expired', ...this.lastIfAny(), message }
      }
      return this.staleOr(message)
    }

    const self = envelope.data
    const money = await currency
    const quota = Number(self.quota) || 0
    const balance: Balance = {
      quota,
      display: render(quota, money),
      // Below one currency unit counts as low. Deriving the threshold from the
      // site's own `quota_per_unit` keeps it meaningful if the site ever
      // redenominates; TOKENS sites have no unit, so nothing to compare.
      low: !money.tokens && quota < money.perUnit,
      usedDisplay: render(Number(self.used_quota) || 0, money),
      group: self.group ?? '',
      username: self.username ?? '',
      userId: self.id ?? session.userId,
      requestCount: Number(self.request_count) || 0,
      fetchedAt: Date.now(),
    }
    this.last = balance
    return { status: 'ok', balance }
  }

  private lastIfAny(): { balance?: Balance } {
    return this.last === undefined ? {} : { balance: this.last }
  }

  private staleOr(message: string): BalanceSnapshot {
    if (this.last !== undefined) return { status: 'stale', balance: this.last, message }
    return { status: 'unavailable', message }
  }

  /**
   * Read the site's currency settings, falling back to the common shape.
   *
   * `/api/status` is public. When it cannot be read, the default is right for
   * nearly every account, and losing the whole balance line over a setting
   * that hardly ever varies would be the worse trade.
   */
  private async readCurrency(baseUrl: string, signal?: AbortSignal): Promise<Currency> {
    if (this.currency !== undefined && Date.now() - this.currency.at < CURRENCY_TTL_MS) {
      return this.currency.value
    }
    try {
      const { response, body } = await requestJson(
        this.ctx,
        `${baseUrl}/api/status`,
        { method: 'GET' },
        BALANCE_TIMEOUT_MS,
        signal,
      )
      const envelope = asEnvelope<Record<string, unknown>>(body)
      if (!response.ok || envelope.data === undefined) return this.currency?.value ?? DEFAULT_CURRENCY
      const value = parseCurrency(envelope.data)
      this.currency = { value, at: Date.now() }
      return value
    } catch {
      return this.currency?.value ?? DEFAULT_CURRENCY
    }
  }
}

/** Map the site's status fields onto the display rules the console itself uses. */
function parseCurrency(data: Record<string, unknown>): Currency {
  const perUnit = Number(data.quota_per_unit)
  const type = String(data.currency_type ?? 'USD').toUpperCase()
  const currency: Currency = {
    perUnit: Number.isFinite(perUnit) && perUnit > 0 ? perUnit : DEFAULT_CURRENCY.perUnit,
    symbol: '$',
    rate: 1,
    tokens: type === 'TOKENS',
  }
  if (type === 'CNY') {
    currency.symbol = '¥'
    currency.rate = Number(data.usd_exchange_rate) || 1
  } else if (type === 'CUSTOM') {
    currency.symbol = String(data.custom_currency_symbol ?? '¤')
    currency.rate = Number(data.custom_currency_exchange_rate) || 1
  } else if (currency.tokens) {
    currency.symbol = ''
  }
  return currency
}

/** Render a quota integer the way the console's own web UI does. */
function render(quota: number, currency: Currency, digits = 2): string {
  if (currency.tokens) return String(Math.round(quota))
  return currency.symbol + ((quota / currency.perUnit) * currency.rate).toFixed(digits)
}
