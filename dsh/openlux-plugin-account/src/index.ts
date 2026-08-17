/**
 * Host half of the OpenLux account plugin.
 *
 * The browser cannot call the account endpoints itself: sign-in, captcha, and
 * balance all answer without CORS headers. Those requests belong here, and the
 * browser reaches them over a logical RPC channel this plugin owns.
 *
 * Why an own channel instead of Typert Remote, which is the kernel's usual way
 * to expose host methods: the browser face of Typert refuses to mount a
 * namespace unless every parameter and result carries a strict codec
 * (`api/gateway/src/client/index.ts:549-564`), and strict codecs come only from
 * the kernel's own typert generator, seeded by the kernel repository's tsconfig
 * (`typert/generator/README.md:19-21`). A package outside that repository
 * cannot join that pipeline. `connection.rpc.handle` is the extension point
 * meant for exactly this — it registers the HTTP route, validates the request
 * envelope, and enforces the authority policy for us
 * (`client/connection/src/rpc-host.ts:90-115`, contract-tested in that
 * package's `tests/node-half.host.spec.ts:227-418`).
 *
 * ## What crosses to the browser, and what does not
 *
 * Neither secret does. The session cookie stays here by construction (see
 * `account/session.ts`), and the `sk-` key is written into the credential
 * store by this file rather than handed back for the browser to store — the
 * browser only needs to know that sign-in succeeded. That the kernel exposes
 * `credentials.set` on the wire does not make it the right caller: the key is
 * already in this process when it is minted.
 */

import type { Context } from '@deepseek-ai/cordis'
// Also merges `ctx.connection` (the Host handle) into this program.
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { signIn } from './account/auth.ts'
import { BalanceReader } from './account/balance.ts'
import { fetchCaptcha, fetchCaptchaConfig, verifyCaptcha, type CaptchaType } from './account/captcha.ts'
import { clearSession, readSession } from './account/session.ts'
import { syncModels } from './models/sync.ts'

/**
 * Logical channel owned by this plugin. The browser addresses it as
 * `/openlux/<method>`; `/api` is reserved for the kernel's own surface.
 */
export const ACCOUNT_CHANNEL = '/openlux'

/**
 * Where the `sk-` key lands.
 *
 * The name is not ours to choose: the kernel's model settings page derives
 * `<ROUTE>_API_KEY` from the provider route id, and our route is `openlux`.
 */
const API_KEY_REF = credentialRef('OPENLUX_API_KEY')

/** Plugin configuration. */
export interface Config {
  /** Console origin the account endpoints live on. */
  readonly baseUrl?: string
}

/** Default console origin, matching the model route in `cordis.patch.yml`. */
const DEFAULT_BASE_URL = 'https://api.openlux.ai'

/** Who is signed in, as far as the browser needs to know. */
export interface AccountStatus {
  readonly signedIn: boolean
  readonly userId?: number
  readonly baseUrl: string
  /** Whether a usable API key is present, from any source including the environment. */
  readonly apiKeyConfigured: boolean
}

/**
 * Host plugin body: own one RPC channel for the account endpoints.
 * @param ctx - loader-provided context for this composition entry.
 * @param config - composition configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const balance = new BalanceReader(ctx)

  // `handle` registers through the calling fiber's own effect, so the route
  // and its disposal already follow this plugin's lifetime.
  ctx.connection.rpc.handle(ACCOUNT_CHANNEL, async (endpoint, payload, signal) => {
    try {
      return await route(ctx, baseUrl, balance, endpoint, payload, signal)
    } catch (error: unknown) {
      // A handler that throws becomes a plain-text 500 upstream
      // (`client/connection/src/rpc-host.ts:183-185`), and the browser sees a
      // transport fault with the console's own wording gone. Anything that
      // reaches here is a genuine fault rather than an account outcome —
      // those ride the success arm below — so the error arm is the right
      // place for it, as long as the text survives the trip.
      return {
        ok: false,
        error: {
          code: 'internal',
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
      }
    }
  }, { authority: 'loopback' })

  // Deferred startup work belongs to this fiber. A detached promise is not a
  // resource cordis tracks, so it goes in an `effect` whose disposer aborts it:
  // a hot reload of this plugin then cannot leave a write racing its successor.
  //
  // Running it at mount costs no network on a machine that already has a list
  // (`models/sync.ts` reaches the console only to seed), so what the first
  // screen waits on is unchanged.
  ctx.effect(() => {
    const stop = new AbortController()
    void syncCatalog(ctx, baseUrl, 'startup', stop.signal)
    return () => stop.abort()
  })
}

/**
 * Dispatch one account endpoint.
 * @param ctx - host context.
 * @param baseUrl - console origin.
 * @param balance - the per-process balance cache.
 * @param endpoint - method name within this plugin's channel.
 * @param payload - request body, shaped per endpoint.
 * @param signal - caller cancellation.
 * @returns the RPC result for this call.
 */
async function route(
  ctx: Context,
  baseUrl: string,
  balance: BalanceReader,
  endpoint: string,
  payload: unknown,
  signal?: AbortSignal,
): ReturnType<ConnectionRpcHandler> {
  switch (endpoint) {
    case 'status':
      return { ok: true, value: await readStatus(ctx, baseUrl) }

    case 'captcha.config':
      return { ok: true, value: await fetchCaptchaConfig(ctx, baseUrl, signal) }

    case 'captcha.challenge':
      return { ok: true, value: await fetchCaptcha(ctx, baseUrl, captchaTypeOf(payload), signal) }

    case 'captcha.verify':
      return { ok: true, value: await runVerifyCaptcha(ctx, baseUrl, payload, signal) }

    case 'sign-in':
      return { ok: true, value: await runSignIn(ctx, baseUrl, payload, signal) }

    case 'sign-out':
      return { ok: true, value: await runSignOut(ctx, balance) }

    case 'balance':
      return { ok: true, value: await balance.read(forceOf(payload), signal) }

    // Hand refresh. Mount and sign-in run their own rounds, so this is for the
    // case where the account gained models after both.
    case 'models.sync':
      return { ok: true, value: await syncModels(ctx, { baseUrl, apiKey: () => apiKey(ctx) }, signal) }

    default:
      // The error-code union belongs to the kernel and cannot grow a row from
      // out here, so an unroutable endpoint reuses the code the kernel's own
      // envelope check uses for the same class of mistake
      // (`client/connection/src/rpc-host.ts:173-177`). Account *outcomes* must
      // not come through here at all: a wrong password or a missed challenge
      // rides the success arm with its own discriminant, the way the kernel's
      // own services do.
      return {
        ok: false,
        error: {
          code: 'bad-request',
          message: `unknown account endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        },
      }
  }
}

/**
 * Report whether this machine is signed in.
 *
 * `apiKeyConfigured` is asked of the credential provider rather than inferred
 * from our own session, because a key supplied through the environment or
 * typed into the kernel's model settings counts just as much: the sign-in step
 * has no business blocking a user who already gave the kernel what it needs.
 */
async function readStatus(ctx: Context, baseUrl: string): Promise<AccountStatus> {
  const [session, key] = await Promise.all([
    readSession(ctx),
    ctx.credentials.describe(API_KEY_REF),
  ])
  return {
    signedIn: session !== undefined,
    ...session === undefined ? {} : { userId: session.userId },
    baseUrl: session?.baseUrl ?? baseUrl,
    apiKeyConfigured: key.configured,
  }
}

/**
 * Judge a challenge answer.
 *
 * A rejected answer is an ordinary outcome, not an error: the console has
 * already discarded that challenge either way, so the caller's next move is
 * the same one it would make after any miss — fetch a fresh challenge.
 */
async function runVerifyCaptcha(
  ctx: Context,
  baseUrl: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<{ readonly passed: boolean; readonly token: string }> {
  const request = payload as { key?: unknown; answer?: unknown } | null
  const token = await verifyCaptcha(
    ctx,
    baseUrl,
    captchaTypeOf(payload),
    typeof request?.key === 'string' ? request.key : '',
    typeof request?.answer === 'string' ? request.answer : '',
    signal,
  )
  return { passed: token !== '', token }
}

/** Browser-visible result of a sign-in attempt; the key itself never appears. */
type SignInReply =
  | { readonly kind: 'ok'; readonly userId: number; readonly username: string }
  | { readonly kind: 'rejected'; readonly message: string; readonly needCaptcha: boolean }
  | { readonly kind: 'failed'; readonly message: string }

/** Sign in, store the key here, and tell the browser only the outcome. */
async function runSignIn(
  ctx: Context,
  baseUrl: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<SignInReply> {
  const request = payload as { username?: unknown; password?: unknown; captchaToken?: unknown } | null
  const outcome = await signIn(ctx, {
    baseUrl,
    username: typeof request?.username === 'string' ? request.username : '',
    password: typeof request?.password === 'string' ? request.password : '',
    ...typeof request?.captchaToken === 'string' ? { captchaToken: request.captchaToken } : {},
  }, signal)
  if (outcome.kind !== 'ok') return outcome

  try {
    await ctx.credentials.set(API_KEY_REF, outcome.apiKey)
  } catch (error: unknown) {
    // The account is fine; this machine just cannot store the key, which
    // almost always means an environment variable is shadowing the slot. It
    // has to read as a failed sign-in, because nothing would work afterwards.
    const detail = error instanceof Error ? error.message : String(error)
    return {
      kind: 'failed',
      message: detail.includes(API_KEY_REF)
        ? `环境变量 ${API_KEY_REF} 正在占用密钥位置，请先取消该变量再登录。`
        : `密钥保存失败：${detail}`,
    }
  }
  // Seeding needs the key that was just stored, so a fresh account gets its
  // list here rather than at the next launch. Detached on purpose: a slow
  // square must not hold the sign-in screen open.
  void syncCatalog(ctx, baseUrl, 'sign-in')
  return { kind: 'ok', userId: outcome.userId, username: outcome.username }
}

/** Read the stored key, treating any credential fault as "not signed in yet". */
async function apiKey(ctx: Context): Promise<string | undefined> {
  return await ctx.credentials.resolve(API_KEY_REF).then(hit => hit?.value).catch(() => undefined)
}

/**
 * Run one catalog sync and say so in the log.
 *
 * Failures stay here: the sync is a background correction, and an installation
 * whose list is a round out of date is in exactly the state it was in before
 * the round started.
 * @param ctx - host context.
 * @param baseUrl - console origin.
 * @param reason - what triggered it, for the log line.
 * @param signal - cancellation, when the caller owns a lifetime.
 */
async function syncCatalog(ctx: Context, baseUrl: string, reason: string, signal?: AbortSignal): Promise<void> {
  try {
    const outcome = await syncModels(ctx, { baseUrl, apiKey: () => apiKey(ctx) }, signal)
    if (outcome.changed) {
      ctx.logger.info(`openlux: model list synced (${reason}): ${outcome.models} models, `
        + `${outcome.described ?? 0} with a thinking declaration`)
    } else {
      ctx.logger.debug(`openlux: model sync (${reason}) changed nothing: ${outcome.skipped}`)
    }
  } catch (error: unknown) {
    if (signal?.aborted === true) return
    ctx.logger.warn(`openlux: model sync (${reason}) failed; leaving the list as it was`)
    ctx.logger.warn(error)
  }
}

/**
 * Sign out: drop the session, the key, and the cached balance.
 *
 * The key goes too. Leaving it would keep the models working for an account
 * the UI shows as signed out, which is the kind of gap that gets discovered as
 * an unexplained charge.
 */
async function runSignOut(ctx: Context, balance: BalanceReader): Promise<{ ok: true }> {
  balance.forget()
  await clearSession(ctx)
  await ctx.credentials.unset(API_KEY_REF)
  return { ok: true }
}

/** Read the requested challenge family, defaulting to the common one. */
function captchaTypeOf(payload: unknown): CaptchaType {
  const type = (payload as { type?: unknown } | null)?.type
  return typeof type === 'string' ? type as CaptchaType : 'slide-basic'
}

/** Whether the caller pressed refresh rather than merely rendering. */
function forceOf(payload: unknown): boolean {
  return (payload as { force?: unknown } | null)?.force === true
}

/**
 * Required services. `webServer` is not named by us directly, but
 * `connection.rpc.handle` registers the route through the *calling* fiber's
 * context, so it has to resolve here.
 */
export const inject = ['connection', 'webServer', 'credentials', 'settings']
