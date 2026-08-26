/**
 * One account view shared by the sign-in step and the sidebar row.
 *
 * Both surfaces read the same facts and each can change them — signing in from
 * the step has to light up the sidebar, signing out from the sidebar has to
 * bring the step back — so the state lives outside React and both bind to it
 * through the kernel's `bindSnapshotSelector`, the way ui-settings-models
 * binds its page store.
 */

import type { AccountHostCaller } from './types.ts'

/** A balance ready to render, as the host formatted it. */
export interface Balance {
  readonly quota: number
  readonly display: string
  /** Below one currency unit; the row warns rather than just printing it. */
  readonly low: boolean
  readonly usedDisplay: string
  readonly group: string
  readonly username: string
  readonly userId: number
  readonly requestCount: number
  readonly fetchedAt: number
}

/**
 * How much to trust the number, straight from the host.
 *
 * Four arms rather than a value-or-nothing pair because a failed read and a
 * spent account render identically once collapsed, and of those two readings
 * the one the user acts on is the wrong one.
 */
export type BalanceStatus = 'ok' | 'stale' | 'expired' | 'unavailable'

interface BalanceSnapshot {
  readonly status: BalanceStatus
  readonly balance?: Balance
  readonly message?: string
}

interface HostAccountStatus {
  readonly signedIn: boolean
  readonly userId?: number
  readonly apiKeyConfigured: boolean
  /** Console origin this machine talks to — the session's, else the configured one. */
  readonly baseUrl: string
}

/** Everything both surfaces need, in one immutable snapshot. */
export interface AccountView {
  /** False until the first read lands; the row draws nothing before that. */
  readonly read: boolean
  readonly signedIn: boolean
  readonly apiKeyConfigured: boolean
  readonly balanceStatus: BalanceStatus | undefined
  readonly balance: Balance | undefined
  readonly message: string | undefined
  /** A read is in flight; any previous value keeps showing under it. */
  readonly fetching: boolean
  /**
   * Where the account lives on the web, so a surface can offer the console
   * itself: topping up, invoices, and the request log are all there and none of
   * them belong in this app. Undefined only before the first read.
   */
  readonly baseUrl: string | undefined
}

const EMPTY: AccountView = {
  read: false,
  signedIn: false,
  apiKeyConfigured: false,
  balanceStatus: undefined,
  balance: undefined,
  message: undefined,
  fetching: false,
  baseUrl: undefined,
}

/** Observable account state; one instance per plugin activation. */
export class AccountStore {
  private view: AccountView = EMPTY
  private readonly listeners = new Set<() => void>()
  private generation = 0

  constructor(private readonly callHost: AccountHostCaller) {}

  /** Current snapshot; stable identity between changes, as uSES requires. */
  getSnapshot = (): AccountView => this.view

  /**
   * Subscribe to changes.
   * @param listener - called after every committed change.
   * @returns the unsubscriber.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Re-read sign-in state and balance.
   * @param force - bypass the host's refresh throttle (an explicit refresh).
   */
  refresh = async (force = false): Promise<void> => {
    const generation = ++this.generation
    this.commit({ fetching: true })
    const [status, balance] = await Promise.all([
      this.callHost<HostAccountStatus>('status', {}),
      this.callHost<BalanceSnapshot>('balance', { force }),
    ])
    if (generation !== this.generation) return
    this.commit({
      read: true,
      fetching: false,
      ...status.ok
        ? {
            signedIn: status.value.signedIn,
            apiKeyConfigured: status.value.apiKeyConfigured,
            baseUrl: status.value.baseUrl,
          }
        : {},
      ...balance.ok
        ? {
            balanceStatus: balance.value.status,
            // A stale read keeps the previous number, which is the whole
            // point of that arm — only overwrite when one arrived.
            balance: balance.value.balance ?? this.view.balance,
            message: balance.value.message,
          }
        : { balanceStatus: 'unavailable' as const, message: balance.error.message },
    })
  }

  /**
   * Drop the session, the key, and the cached balance, then re-read.
   *
   * The re-read is not ceremony: an API key can also come from the
   * environment, and after signing out that is exactly the case worth showing
   * honestly rather than assuming the app is now keyless.
   */
  signOut = async (): Promise<void> => {
    this.generation += 1
    await this.callHost('sign-out', {})
    this.view = { ...EMPTY, read: true }
    this.emit()
    await this.refresh(true)
  }

  /** A sign-in just succeeded somewhere; pull the new facts. */
  signedIn = async (): Promise<void> => {
    this.generation += 1
    this.view = {
      ...this.view,
      balance: undefined,
      balanceStatus: undefined,
      message: undefined,
      fetching: false,
    }
    await this.refresh(true)
  }

  private commit(patch: Partial<AccountView>): void {
    this.view = { ...this.view, ...patch }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
