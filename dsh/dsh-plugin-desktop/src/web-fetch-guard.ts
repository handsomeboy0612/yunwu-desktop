/**
 * `web_fetch` with the private-network reach taken away, as one composition row.
 *
 * Upstream ships the retrieval half and says what it left out: *"Private-network
 * and SSRF protection is not implemented; do not enable this provider where it
 * can reach sensitive internal targets"* (`dsh-web-fetch-http`'s own
 * `provider.d.ts`). A desktop install is exactly that environment — the Host
 * webserver binds loopback, and the LAN has routers, printers, and other dev
 * servers. Verified with the bare provider before writing this: a loopback page
 * came back 200 with its body intact.
 *
 * Two kernel seams, no patched kernel file:
 *
 * - `ctx.tools.guard` is synchronous and sees the argument string, so it refuses
 *   private literals before dispatch and the model reads why.
 * - `ctx.web.registerFetchProvider` is the only place DNS can be inspected
 *   before a connection. This row registers {@link GUARDED_FETCH_PROVIDER_ID}
 *   and uses upstream's provider as its transport, so every retrieval limit,
 *   the same-origin redirect rule, and the content handling stay upstream's.
 *
 * What this is not: an IP pin. The accepted defence against DNS rebinding is to
 * resolve once and dial the validated address (`undici Agent({connect:{lookup}})`,
 * which is what openclaw's `createPinnedLookup` builds). Upstream's transport
 * calls global `fetch` with no dispatcher seam, so re-using it means the name is
 * resolved again at connect time, and each redirect hop resolves again too. A
 * pin would mean owning the transport — redirects, byte caps, charset decoding —
 * instead of the classifier. So this is reach reduction with a stated residual
 * window, not a security boundary; the agent has a shell either way.
 *
 * @module dsh-plugin-desktop/web-fetch-guard
 */

import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import {
  Config as HttpFetchConfig,
  HttpFetchProvider,
  type Config as HttpFetchConfigShape,
  type HttpFetchLimits,
} from '@deepseek-ai/dsh-web-fetch-http'
import type {} from '@deepseek-ai/dsh-tools'
import type { ToolExecution, ToolGuard } from '@deepseek-ai/dsh-tools'
import {
  WebError,
  type WebFetchProvider,
  type WebFetchRequest,
  type WebFetchResult,
} from '@deepseek-ai/dsh-web'
import { blockedMessage, blockedTargetReason, blockedUrlReason, fetchHostname } from './web-fetch-policy.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'openlux-web-fetch-guard'

/** Both seams this row uses. Absent either one, there is nothing to guard. */
export const inject = ['web', 'tools']

/**
 * Registry id the composition pins as `web.fetchProvider`.
 *
 * The unwrapped `http` id is deliberately not mounted anywhere in this product:
 * with one usable provider, selection lands here even with the pin removed.
 */
export const GUARDED_FETCH_PROVIDER_ID = 'openlux-http'

const WEB_FETCH_TOOL = 'web_fetch'

/**
 * Upstream's schema, re-exported rather than restated: the transport caps belong
 * to the transport, and copying them here would mean two places to keep in step
 * and a second set of defaults to drift from.
 */
export const Config = HttpFetchConfig
export type Config = HttpFetchConfigShape

/** Hostname resolver. Injected by tests, so rebinding needs no hosts file. */
export type LookupFn = (hostname: string) => Promise<readonly string[]>

/**
 * Every address the resolver returns, in resolver order.
 * @param hostname - an unbracketed hostname.
 * @returns each resolved address as text.
 */
export async function defaultLookup(hostname: string): Promise<readonly string[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true })
  return results.map(entry => entry.address)
}

/**
 * Deny a `web_fetch` whose URL argument already names a private target. Names
 * that need DNS to classify are left to the provider.
 * @param execution - the pending call, after extensible pre-execute policy.
 * @returns a denial reason, or `undefined` to leave the call allowed.
 */
export const privateFetchGuard: ToolGuard = (execution: Readonly<ToolExecution>): string | undefined => {
  if (execution.name !== WEB_FETCH_TOOL) return undefined
  const url = urlArgument(execution.arguments)
  if (url === undefined) return undefined
  const reason = blockedUrlReason(url)
  return reason === undefined ? undefined : blockedMessage(url, reason)
}

/**
 * Refuse a target that is private as a literal or that resolves to one.
 * Unparseable and non-HTTP(S) URLs are left to the inner provider, which
 * reports them with its own codes.
 * @param input - the request URL.
 * @param lookup - hostname resolver; the default asks the system.
 */
export async function assertPublicFetchTarget(
  input: string,
  lookup: LookupFn = defaultLookup,
): Promise<void> {
  const literal = blockedUrlReason(input)
  if (literal !== undefined) throw blockedError(input, literal)
  const hostname = fetchHostname(input)
  if (hostname === undefined) return
  // An address literal was already classified above; only names need DNS.
  if (isIP(hostname) !== 0) return
  let addresses: readonly string[]
  try {
    addresses = await lookup(hostname)
  } catch {
    // NXDOMAIN and resolver faults are the inner fetch's to report, as a
    // retrieval failure rather than as a policy denial.
    return
  }
  for (const address of addresses) {
    // Answers, not literals: a fake-ip proxy stack resolves every hostname into
    // a placeholder range and routes by name, so those answers cannot be read
    // as "this name points inside the network". See `TargetPolicy`.
    const reason = blockedTargetReason(address, { allowFakeIpPlaceholders: true })
    if (reason !== undefined) {
      throw blockedError(input, `${hostname} resolves to ${address} (${reason})`)
    }
  }
}

/** Classifies the target, then retrieves through upstream's HTTP provider. */
export class GuardedHttpFetchProvider implements WebFetchProvider {
  readonly id = GUARDED_FETCH_PROVIDER_ID
  private readonly inner: HttpFetchProvider
  private readonly lookup: LookupFn

  /**
   * @param limits - transport caps, straight from this row's config.
   * @param lookup - hostname resolver; omit to ask the system.
   */
  constructor(limits: HttpFetchLimits, lookup: LookupFn = defaultLookup) {
    this.lookup = lookup
    this.inner = new HttpFetchProvider(limits)
  }

  /** Usable whenever the transport is: an anonymous fetcher needs no credential. */
  available(): boolean {
    return this.inner.available()
  }

  /**
   * @param request - the URL to retrieve.
   * @param signal - caller cancellation.
   * @returns the inner provider's result, unmodified.
   */
  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    await assertPublicFetchTarget(request.url, this.lookup)
    return this.inner.fetch(request, signal)
  }
}

/**
 * Register the guarded provider and the literal guard.
 * @param ctx - context carrying `web` and `tools`.
 * @param config - transport caps for the inner provider.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(
    // Cordis has already resolved this row against the schema above, so every
    // cap is present — the same assumption upstream's own `apply` makes.
    () => ctx.web.registerFetchProvider(new GuardedHttpFetchProvider(config as HttpFetchLimits)),
    'dsh-plugin-desktop: guarded web fetch provider',
  )
  ctx.effect(
    () => ctx.tools.guard(privateFetchGuard),
    'dsh-plugin-desktop: web_fetch private-target guard',
  )
}

function urlArgument(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const url = (args as { url?: unknown }).url
  return typeof url === 'string' ? url : undefined
}

function blockedError(url: string, reason: string): WebError {
  return new WebError(blockedMessage(url, reason), 'WEB_BLOCKED_URL')
}
