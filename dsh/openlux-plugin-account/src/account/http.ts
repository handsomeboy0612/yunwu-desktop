/**
 * Shared request plumbing for the OpenLux account endpoints.
 *
 * The kernel ships no HTTP wrapper — its own adapters call global `fetch`
 * directly (`llm/llm-pi-ai/src/discovery.ts:242-258`) — so the only things
 * worth centralising here are the two disciplines that file also follows: every
 * request carries a deadline, and a failure says whether it timed out or the
 * caller cancelled.
 *
 * Deadlines matter more here than usual: nothing in the kernel's RPC path sets
 * one. The browser's `rpc.call` forwards only the caller's signal
 * (`client/connection/src/client/rpc.ts:30-38`), and the host handler receives
 * the HTTP request's own signal. A hung account endpoint would otherwise hold
 * the sign-in screen open indefinitely.
 */

import type { Context } from '@deepseek-ai/cordis'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { LOCALE_SETTINGS_NAMESPACE, type LocaleSettings } from '@deepseek-ai/dsh-client-locale'
import { causeChain } from '../error-cause.ts'

/**
 * Per-request budget. The sign-in screen blocks the whole application, so a
 * stalled endpoint has to surface as a readable failure quickly rather than
 * look like a frozen window.
 */
export const ACCOUNT_TIMEOUT_MS = 15_000

/** Shorter: the balance line is a background refresh nobody is waiting on. */
export const BALANCE_TIMEOUT_MS = 8_000

/** Envelope shared by every `/api/*` route on the OpenLux console. */
export interface ApiEnvelope<T> {
  readonly success?: boolean
  readonly message?: string
  readonly data?: T
}

/** A request that reached the server, whatever it answered. */
export interface HttpReply {
  readonly response: Response
  readonly body: unknown
}

/** Why a request never produced a reply. */
export class AccountRequestError extends Error {
  /**
   * @param message - human-readable Chinese text, shown as-is in the UI.
   * @param kind - which of the three no-reply outcomes happened.
   */
  constructor(message: string, readonly kind: 'timeout' | 'cancelled' | 'unreachable') {
    super(message)
    this.name = 'AccountRequestError'
  }
}

/** Strip trailing slashes so callers can concatenate paths without doubling them. */
export function normalizeBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed === '') throw new AccountRequestError('账号服务地址为空', 'unreachable')
  return trimmed
}

/**
 * Language to ask the console to answer in.
 *
 * The console picks per request from `Accept-Language`
 * (`middleware/i18n.go:23-39`), and a signed-in user's own console preference
 * outranks it. Sending nothing lands on the site default, which is how a
 * Chinese UI ends up quoting "Please complete the CAPTCHA verification first"
 * — observed, not hypothesised.
 *
 * The preference is the kernel's to own: `client-locale` registers the
 * `locale` settings namespace host-side, so the same choice the user makes in
 * Settings drives what the console says. An unregistered or unset preference
 * means "follow the browser", which we cannot see from here, so it falls back
 * to the language this product ships in.
 */
function acceptLanguage(ctx: Context): string {
  const settings = ctx.get('settings')
  // The plain string the locale package exports is not the branded namespace
  // `settings.get` takes; the kernel's own callers brand it at the call site
  // (`client/locale/src/index.ts:19`).
  const locale = settings?.get(settingsNamespace(LOCALE_SETTINGS_NAMESPACE)) as LocaleSettings | undefined
  return locale?.preference === 'en' ? 'en-US' : 'zh-CN'
}

/**
 * Perform one request under a deadline and decode its JSON body.
 *
 * A non-2xx status is *not* an error here: these endpoints answer business
 * failures with a 200 and `success: false`, and some with a 401, so the caller
 * needs both the status and the body to decide.
 * @param ctx - host context, read for the language to request.
 * @param url - absolute request URL.
 * @param init - fetch options; a `signal` here is fused with the deadline.
 * @param timeoutMs - budget for this request.
 * @param upstream - caller cancellation, fused in.
 * @returns the response and its parsed body (undefined when not JSON).
 * @throws {AccountRequestError} when no reply arrived.
 */
export async function requestJson(
  ctx: Context,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  upstream?: AbortSignal,
): Promise<HttpReply> {
  using budget = deadline(upstream, timeoutMs, 'openlux-account')
  let response: Response
  try {
    // Set here rather than at each call site so no endpoint can quietly skip
    // it and answer in a language the user did not choose.
    const headers = new Headers(init.headers)
    headers.set('Accept-Language', acceptLanguage(ctx))
    response = await fetch(url, { ...init, headers, signal: budget.signal })
  } catch (error: unknown) {
    // `timeoutOf` reads the reason only when the timer won the race, so an
    // upstream cancellation stays distinguishable from a slow endpoint.
    const timedOut = timeoutOf(budget.signal)
    if (timedOut !== undefined) {
      throw new AccountRequestError(`账号服务超时（${Math.round(timeoutMs / 1000)} 秒未响应）`, 'timeout')
    }
    if (upstream?.aborted === true) throw new AccountRequestError('请求已取消', 'cancelled')
    throw new AccountRequestError(`无法连接账号服务：${causeChain(error)}`, 'unreachable')
  }
  // A body that is not JSON is a server-side surprise, not a caller error; the
  // status alone still lets the caller produce a useful message.
  const body: unknown = await response.json().catch(() => undefined)
  return { response, body }
}

/**
 * Fetch bytes under a deadline, refusing a body that outgrows a cap.
 *
 * `arrayBuffer()` would take the server's word on how much is coming: a body
 * that keeps arriving fills this process before anyone gets to look at it. So
 * the cap is what decides, `content-length` is only the polite case's early
 * refusal, and the reader is cancelled the moment the cap is passed rather than
 * after the transfer finishes.
 *
 * Unlike {@link requestJson}, a non-2xx status *is* a failure here: an artifact
 * route answers with the bytes or with nothing, and a signed link that has
 * expired must not reach the caller as a zero-length archive.
 * @param ctx - host context, read for the language to request.
 * @param url - absolute request URL.
 * @param timeoutMs - budget for this request.
 * @param maxBytes - hard cap; the transfer is cancelled once it is exceeded.
 * @param upstream - caller cancellation, fused in.
 * @param what - what is being downloaded, for the refusal text a user reads.
 * @returns the body bytes.
 * @throws {AccountRequestError} when no usable body arrived.
 */
export async function requestBytes(
  ctx: Context,
  url: string,
  timeoutMs: number,
  maxBytes: number,
  upstream?: AbortSignal,
  what = '制品',
): Promise<Uint8Array> {
  using budget = deadline(upstream, timeoutMs, 'openlux-market')
  let response: Response
  try {
    const headers = new Headers({ 'Accept-Language': acceptLanguage(ctx) })
    response = await fetch(url, { headers, signal: budget.signal })
  } catch (error: unknown) {
    if (timeoutOf(budget.signal) !== undefined) {
      throw new AccountRequestError(`下载超时（${Math.round(timeoutMs / 1000)} 秒未完成）`, 'timeout')
    }
    if (upstream?.aborted === true) throw new AccountRequestError('下载已取消', 'cancelled')
    throw new AccountRequestError(`无法下载${what}：${causeChain(error)}`, 'unreachable')
  }
  if (!response.ok) {
    throw new AccountRequestError(`下载失败（HTTP ${response.status}）`, 'unreachable')
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AccountRequestError(`${what}声明的大小超过上限（${declared} > ${maxBytes} 字节）`, 'unreachable')
  }
  if (response.body === null) throw new AccountRequestError(`${what}响应没有内容`, 'unreachable')

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new AccountRequestError(`${what}超过大小上限（>${maxBytes} 字节）`, 'unreachable')
      }
      chunks.push(value)
    }
  } finally {
    // Releasing a cancelled reader is allowed; guarding it keeps a release
    // fault from replacing the refusal that caused it.
    try { reader.releaseLock() } catch { /* the stream is already gone */ }
  }
  return Buffer.concat(chunks)
}

/**
 * Read the console's envelope, tolerating routes that answer bare objects.
 * @param body - parsed response body.
 * @returns the envelope view, never undefined.
 */
export function asEnvelope<T>(body: unknown): ApiEnvelope<T> {
  return (body ?? {}) as ApiEnvelope<T>
}
