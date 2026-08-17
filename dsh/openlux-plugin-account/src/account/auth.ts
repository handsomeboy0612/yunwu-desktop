/**
 * Password sign-in, and the `sk-` key the kernel actually needs.
 *
 * The kernel's requirement is narrow: `llm-pi-ai` resolves `OPENLUX_API_KEY`
 * per request, so once a usable `sk-` key sits in the credential store, models
 * work and the kernel's own credential onboarding step retires itself. Signing
 * in exists to produce that key from an account and a password.
 *
 * Wire contract, re-read from `new-yunwu-api` rather than inherited:
 *
 *  1. `POST /api/user/login` `{username, password, captcha_token}`
 *     (`controller/user.go:57` `LoginRequest`) → `{success, data:{id, username}}`
 *     plus `Set-Cookie` for the session.
 *  2. `GET|POST /api/token/` under `UserAuthOrApiKey` (`router/api-router.go:506`),
 *     called with the session cookie and a `New-Api-User` header. `AddToken`
 *     answers the finished `sk-<key>` string in `data`.
 *
 * ## Why the session cookie is kept, rather than a user access token
 *
 * Balance is user-scoped data, and `authHelperApply` (`middleware/auth.go:87`)
 * accepts either a session cookie or a user *access token* — so an access
 * token looks like the tidier carrier: no cookie parsing, no 30-day expiry, no
 * invalidation when the user changes their password.
 *
 * It is disqualified by a side effect. A user has exactly one access token:
 * `GenerateAccessToken` (`controller/user.go:1418`) mints a new key and
 * overwrites the column, so a client that asks for one silently revokes
 * whatever the user already had — and our own station sync authenticates with
 * precisely that token (`SystemTokenAuth`, `middleware/auth.go:1181`). Signing
 * in to the desktop client must not break a user's sync.
 *
 * The relay `sk-` key cannot substitute either: `/api/user/self` sits behind
 * `UserAuthOrApiKey`, whose "ApiKey" arm is agent credentials, not `sk-`; and
 * `/api/usage/token` (`TokenAuth`) does answer to `sk-`, but reports the
 * token's own quota, which for the unlimited-quota key created below carries
 * no account balance at all.
 */

import type { Context } from '@deepseek-ai/cordis'
import { ACCOUNT_TIMEOUT_MS, asEnvelope, normalizeBase, requestJson } from './http.ts'
import { saveSession } from './session.ts'

/**
 * Token name created on the user's behalf, visible in their console.
 *
 * Sign-in also accepts the previous shell's name so a migrating user keeps one
 * key instead of accumulating one per product rename.
 */
const TOKEN_NAME = 'OpenLux 桌面客户端'
const LEGACY_TOKEN_NAMES = ['云雾桌面客户端']

/**
 * Smart routing mode stamped on a created token.
 *
 * A token without it can only route within its own bound group (`default` when
 * unbound), and most image/video/audio channels live outside `default` — so an
 * expert calling those models would get "no available channel". Any non-empty
 * mode widens the candidate set, which is why reuse below tests for non-empty
 * rather than equality: a user who switched theirs to `price` in the console
 * should keep that key, not get a second one.
 */
const ROUTING_PRIORITY = 'auto'

/** What sign-in produced, or why it did not. */
export type SignInOutcome =
  | {
    readonly kind: 'ok'
    readonly baseUrl: string
    readonly apiKey: string
    readonly userId: number
    readonly username: string
  }
  /** The console refused: wrong password, banned account, disabled sign-in. */
  | { readonly kind: 'rejected'; readonly message: string; readonly needCaptcha: boolean }
  /** Nothing was decided: timeout, offline, unreadable answer. */
  | { readonly kind: 'failed'; readonly message: string }

/** Credentials and the optional human-check token the console may demand. */
export interface SignInRequest {
  readonly baseUrl: string
  readonly username: string
  readonly password: string
  readonly captchaToken?: string
}

interface LoginData {
  id?: number
  username?: string
}

interface TokenItem {
  name?: string
  key?: string
  status?: number
  routing_priority?: string
}

/**
 * Sign in and leave the account ready to use: a `sk-` key returned for the
 * caller to store, and the session kept host-side for the balance line.
 *
 * Every foreseeable failure rides the return value. The one thing that throws
 * is storing the session, and only because a shadowing environment variable is
 * a setup mistake the user must see rather than a sign-in that half worked.
 * @param ctx - plugin context (needs the credentials service).
 * @param request - account, password, and any human-check token.
 * @param signal - caller cancellation.
 * @returns the outcome, discriminated by `kind`.
 */
export async function signIn(
  ctx: Context,
  request: SignInRequest,
  signal?: AbortSignal,
): Promise<SignInOutcome> {
  const base = normalizeBase(request.baseUrl)
  const username = request.username.trim()
  if (username === '' || request.password === '') {
    return { kind: 'rejected', message: '请输入账号与密码', needCaptcha: false }
  }

  const login = await openSession(ctx, base, username, request.password, request.captchaToken, signal)
  if (login.kind !== 'ok') return login

  const key = await getOrCreateApiKey(ctx, base, login.cookie, login.userId, signal)
  if (key.kind !== 'ok') return key

  // Persisted after the key is in hand: a session stored for a sign-in that
  // then failed to produce a key would leave the balance line authenticated
  // for an account the rest of the app does not consider signed in.
  await saveSession(ctx, { userId: login.userId, baseUrl: base, cookie: login.cookie })

  return {
    kind: 'ok',
    baseUrl: base,
    apiKey: key.apiKey,
    userId: login.userId,
    username: login.username,
  }
}

type SessionOutcome =
  | { kind: 'ok'; cookie: string; userId: number; username: string }
  | Extract<SignInOutcome, { kind: 'rejected' | 'failed' }>

/** Exchange credentials for a session, stopping short of the API key. */
async function openSession(
  ctx: Context,
  base: string,
  username: string,
  password: string,
  captchaToken: string | undefined,
  signal?: AbortSignal,
): Promise<SessionOutcome> {
  const { response, body } = await requestJson(
    ctx,
    `${base}/api/user/login`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, captcha_token: captchaToken ?? '' }),
    },
    ACCOUNT_TIMEOUT_MS,
    signal,
  )

  const envelope = asEnvelope<LoginData>(body)
  const data = envelope.data
  if (!response.ok || envelope.success !== true || data?.id === undefined) {
    const message = envelope.message ?? `登录失败（HTTP ${response.status}）`
    // The console demands a human check but got none, or the one it got had
    // already been spent; the caller can recover by showing the challenge.
    const needCaptcha = /turnstile|验证码|captcha|人机验证/i.test(message)
    return { kind: 'rejected', message, needCaptcha }
  }

  const cookie = cookieHeaderFrom(response)
  if (cookie === '') {
    // Accepted the password but issued no session: the API key below is
    // authenticated by that session, so there is nothing to continue with.
    return { kind: 'failed', message: '登录成功但站点未下发会话，请稍后重试' }
  }
  return { kind: 'ok', cookie, userId: data.id, username: data.username ?? username }
}

type ApiKeyOutcome = { kind: 'ok'; apiKey: string } | Extract<SignInOutcome, { kind: 'rejected' | 'failed' }>

/**
 * Reuse this client's existing key, or create one.
 *
 * A key that predates the smart-routing requirement is left alone rather than
 * updated: `PUT /api/token/` overwrites the whole record, so repairing one
 * field would wipe model limits and IP allowlists the user set in the console.
 * Creating a fresh compliant key instead costs at most one extra key per
 * account, once.
 */
async function getOrCreateApiKey(
  ctx: Context,
  base: string,
  cookie: string,
  userId: number,
  signal?: AbortSignal,
): Promise<ApiKeyOutcome> {
  const existing = await findReusableKey(ctx, base, cookie, userId, signal)
  if (existing !== undefined) return { kind: 'ok', apiKey: existing }

  // Unlimited quota so spending draws on the account balance rather than a
  // per-key allowance; no expiry; no bound group, leaving channel choice to
  // smart routing across everything the account can reach.
  const { response, body } = await requestJson(
    ctx,
    `${base}/api/token/`,
    {
      method: 'POST',
      headers: authHeaders(cookie, userId),
      body: JSON.stringify({
        name: TOKEN_NAME,
        unlimited_quota: true,
        expired_time: -1,
        routing_priority: ROUTING_PRIORITY,
      }),
    },
    ACCOUNT_TIMEOUT_MS,
    signal,
  )
  const envelope = asEnvelope<string>(body)
  if (!response.ok || envelope.success !== true || typeof envelope.data !== 'string') {
    return { kind: 'rejected', message: envelope.message ?? `创建密钥失败（HTTP ${response.status}）`, needCaptcha: false }
  }
  return { kind: 'ok', apiKey: envelope.data }
}

/** Look for a key this client can adopt; any failure just means "create one". */
async function findReusableKey(
  ctx: Context,
  base: string,
  cookie: string,
  userId: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  let body: unknown
  let response: Response
  try {
    ({ response, body } = await requestJson(
      ctx,
      `${base}/api/token/?p=1&page_size=100`,
      { method: 'GET', headers: authHeaders(cookie, userId) },
      ACCOUNT_TIMEOUT_MS,
      signal,
    ))
  } catch {
    return undefined
  }
  const envelope = asEnvelope<unknown>(body)
  if (!response.ok || envelope.success !== true) return undefined

  const names = new Set([TOKEN_NAME, ...LEGACY_TOKEN_NAMES])
  const found = itemsOf(envelope.data).find(item =>
    item.name !== undefined && names.has(item.name)
    && item.status === 1
    && typeof item.key === 'string' && item.key !== ''
    && typeof item.routing_priority === 'string' && item.routing_priority !== '',
  )
  return found?.key === undefined ? undefined : `sk-${found.key}`
}

/** Session-authenticated JSON headers for the console's user routes. */
function authHeaders(cookie: string, userId: number): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Cookie': cookie,
    'New-Api-User': String(userId),
  }
}

/** Read a token list out of whichever pagination shape the route returned. */
function itemsOf(data: unknown): TokenItem[] {
  if (Array.isArray(data)) return data as TokenItem[]
  const record = data as Record<string, unknown> | null
  if (record === null || typeof record !== 'object') return []
  for (const field of ['items', 'records', 'data', 'list']) {
    const value = record[field]
    if (Array.isArray(value)) return value as TokenItem[]
  }
  return []
}

/** Fold `Set-Cookie` into a `Cookie` header, keeping only `name=value` pairs. */
function cookieHeaderFrom(response: Response): string {
  const headers = response.headers as unknown as { getSetCookie?: () => string[] }
  const list = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [response.headers.get('set-cookie') ?? '']
  return list
    .filter(entry => entry !== '')
    .map(entry => entry.split(';')[0])
    .join('; ')
}
