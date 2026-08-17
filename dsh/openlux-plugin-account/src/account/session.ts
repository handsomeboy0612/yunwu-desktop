/**
 * Where the console session cookie lives.
 *
 * The cookie outranks the `sk-` key by a lot — it can mint tokens, redeem
 * top-ups, transfer funds, delete the account — so the previous shell kept it
 * in its own `safeStorage`-encrypted file and took care that it never crossed
 * into the renderer. Both properties survive here without that machinery,
 * because the kernel's credential seam already provides them:
 *
 *  - it never leaves the host. `resolve` is deliberately absent from the
 *    browser-facing credentials API (`host/apiproxy/src/api/credentials.ts`
 *    exposes only `describe`/`set`/`unset`), so there is no wire path that
 *    could carry the value out, by mistake or otherwise.
 *  - it is stored owner-only. `credentials-local` creates its directory `0700`
 *    and atomically replaces the document `0600`, and refuses to read a
 *    document any other user can (`credentials-local/src/index.ts:116,383,394`).
 *
 * Nothing in this repository uses Electron `safeStorage`, and the kernel made
 * that choice on purpose: the OS keychain the previous shell relied on is
 * user-scoped on Windows too, so it guards a copied file rather than anything
 * running as the signed-in user, which is exactly what `0600` already covers.
 *
 * The value is a JSON blob rather than the bare cookie because the cookie is
 * only usable together with the account and site it was issued for; keeping
 * them in one slot is what makes a leftover session from another account
 * impossible to hand to the wrong request.
 *
 * The kernel's other durable facility, `ctx.storageDomain` (mounted by the
 * web-app bundle over `storage-json`), is deliberately *not* used here. It is
 * the right home for structured non-session records, but this package has
 * exactly one durable item and it is a secret, and its `domain/changed` event
 * is in-process only — a reconnecting GUI observes nothing — so it would buy
 * no browser-side freshness either. The balance is not stored at all: a number
 * read from disk at startup looks live but can be a day old, and a stale
 * balance is the one figure users act on without checking.
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

/**
 * Credential slot for the session blob. Named like the API key so both are
 * recognisable in `.credentials.yaml` as belonging to this product.
 */
const SESSION_REF = credentialRef('OPENLUX_SESSION')

/** A session, with the account and site it is only valid for. */
export interface StoredSession {
  /** Console user id the session was issued to. */
  readonly userId: number
  /** Console origin, normalized (no trailing slash). */
  readonly baseUrl: string
  /** The `Cookie` header value, e.g. `session=...`. */
  readonly cookie: string
  /** When it was stored, for diagnosing a session that quietly aged out. */
  readonly savedAt: number
}

/**
 * Store the session, replacing any previous one.
 * @param ctx - plugin context (needs the credentials service).
 * @param session - the session to persist, minus its timestamp.
 * @throws {Error} when an environment variable shadows the slot, with text a
 * user can act on rather than the kernel's shell-oriented wording.
 */
export async function saveSession(
  ctx: Context,
  session: Omit<StoredSession, 'savedAt'>,
): Promise<void> {
  const stored: StoredSession = { ...session, savedAt: Date.now() }
  try {
    await ctx.credentials.set(SESSION_REF, JSON.stringify(stored))
  } catch (error: unknown) {
    throw new Error(shadowHint(error))
  }
}

/**
 * Read the session for one account on one site.
 *
 * A session belonging to a different account or site reads as absent rather
 * than being deleted: clearing is reserved for an explicit sign-out, so two
 * accounts alternating on one machine do not evict each other.
 * @param ctx - plugin context (needs the credentials service).
 * @param userId - console user id the caller intends to act as.
 * @param baseUrl - console origin, already normalized.
 * @returns the cookie header value, or an empty string when there is none.
 */
export async function loadSessionCookie(ctx: Context, userId: number, baseUrl: string): Promise<string> {
  const stored = await readSession(ctx)
  if (stored === undefined) return ''
  if (stored.userId !== userId || stored.baseUrl !== baseUrl) return ''
  return stored.cookie
}

/**
 * Read the whole stored session, whoever it belongs to.
 *
 * Used at startup, where the point is to find out *which* account is signed in
 * rather than to check one we already know.
 * @param ctx - plugin context (needs the credentials service).
 * @returns the session, or undefined when none is stored or it is unreadable.
 */
export async function readSession(ctx: Context): Promise<StoredSession | undefined> {
  const resolved = await ctx.credentials.resolve(SESSION_REF)
  if (resolved === undefined) return undefined
  try {
    const parsed = JSON.parse(resolved.value) as Partial<StoredSession>
    if (typeof parsed.userId !== 'number' || typeof parsed.baseUrl !== 'string') return undefined
    if (typeof parsed.cookie !== 'string' || parsed.cookie === '') return undefined
    return {
      userId: parsed.userId,
      baseUrl: parsed.baseUrl,
      cookie: parsed.cookie,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
    }
  } catch {
    // Hand-edited or half-written: treat as signed out rather than failing the
    // launch, since the repair is one sign-in away.
    return undefined
  }
}

/**
 * Drop the stored session (explicit sign-out, or the console rejecting it).
 * @param ctx - plugin context (needs the credentials service).
 */
export async function clearSession(ctx: Context): Promise<void> {
  try {
    await ctx.credentials.unset(SESSION_REF)
  } catch (error: unknown) {
    throw new Error(shadowHint(error))
  }
}

/**
 * Rewrite the kernel's shadowing rejection into something a user can act on.
 *
 * `credentials-local` refuses to write while an environment variable supplies
 * the same reference, because the write would silently lose to it. Its message
 * names the variable but reads like a shell diagnostic.
 */
function shadowHint(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (text.includes('OPENLUX_SESSION')) {
    return '环境变量 OPENLUX_SESSION 正在占用登录状态的存放位置，请先取消该变量再登录。'
  }
  return `保存登录状态失败：${text}`
}
