/**
 * Signing in to one remote MCP connector, for the servers that will not take a
 * pasted token.
 *
 * ## Why this exists at all
 *
 * 60 of the 82 remote servers in the catalog answer an unauthenticated
 * handshake with `WWW-Authenticate: Bearer resource_metadata=…` rather than
 * with a 401 a token would fix (measured 2026-08-25 over the whole shelf). Up
 * to now every one of them was refused at `buildConfig`, because the old shell
 * ran the flow through `openclaw mcp login` and the bridge we mount takes
 * static headers only (`dsh-mcp-client` Config table, `lib/index.js:752`).
 *
 * ## Three seams, none of them ours
 *
 * **The conversation with the human is the kernel's.** `ctx.authorization`
 * exists for exactly this — credentials that cannot be configured, only
 * obtained — and carries the one-attempt-per-key exclusion, the cancel, the
 * `inFlight` flag a button reads, and the settled event. It is mounted by this
 * product's own composition row (`dsh-plugin-desktop/cordis.patch.yml`); the
 * base bundle leaves it out, which is why nothing here could have worked
 * before. Registration is deliberately lazy: a flow per catalog slug would
 * mean reading 82 manifests at boot to find the 60 that need one.
 *
 * **The protocol is the MCP SDK's.** The authorization seam says it owns the
 * lifecycle "and never the protocol", so the discovery chain, dynamic client
 * registration, PKCE, and the token exchange are `auth()` from
 * `@modelcontextprotocol/sdk/client/auth.js` — the same implementation the
 * bridge's own transport would use if the bridge exposed an `authProvider`
 * (it does not: `requestInit.headers` is the entire surface).
 *
 * **The storage is the credential seam's.** Tokens land as a `grant` record
 * under this plugin's scope, which is what "the flow owns the write" means:
 * `run()` resolving is a promise that `ctx.credentials` already holds the
 * result, and the seam refuses a flow that resolved without one.
 *
 * ## Loopback rather than a pasted code
 *
 * The redirect target is `http://127.0.0.1:<ephemeral>/callback`, RFC 8252's
 * shape for a native app. It is worth the local listener because the
 * alternative — asking the human to copy a code out of a browser — is a
 * question this product would have to ask 60 times. Both endpoints probed on
 * 2026-08-25 (Moka, QQ Mail) advertise `registration_endpoint`,
 * `code_challenge_methods_supported: ["S256"]`, and
 * `token_endpoint_auth_methods_supported: ["none"]`, so the flow needs no
 * pre-registered `client_id` and no client secret: a public client registering
 * itself per install is the whole ceremony.
 *
 * @module openlux-plugin-account/market/connector-oauth
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  auth, discoverAuthorizationServerMetadata, discoverOAuthProtectedResourceMetadata,
  refreshAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationFull, OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { Context } from '@deepseek-ai/cordis'
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'

/**
 * This plugin's registered name, which is the scope half of every record key
 * it owns. Spelled out rather than read from the manifest because the seam
 * matches it against the plugin's registration, and a mismatch would store a
 * record no other launch could find.
 */
const SCOPE = 'openlux-plugin-account'

/** How long a human gets to finish in the browser before the listener gives up. */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Refresh this far before the token actually expires.
 *
 * A connector is mounted once and then holds its header for the life of the
 * process, so the question is never "is it valid now" but "will it still be
 * valid by the time the model calls a tool". A minute covers a slow mount and
 * a clock that disagrees with the issuer's.
 */
const REFRESH_SKEW_MS = 60_000

/** What the gallery gets back when it asks to start a sign-in. */
export type AuthorizationStart =
  /** Open this in the browser; the attempt is running and will settle on its own. */
  | { readonly kind: 'opened'; readonly url: string }
  /** Nothing was started, and this is why. */
  | { readonly kind: 'refused'; readonly message: string }

/** Where one connector's sign-in has got to. */
export type AuthorizationState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'authorized' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string }

/** What a stored grant holds, in this plugin's own format. */
interface ConnectorGrant {
  readonly tokens: OAuthTokens
  /** What dynamic registration produced, so a re-authorization reuses it. */
  readonly client: OAuthClientInformationFull
  /** The server this grant is for; a changed URL invalidates it. */
  readonly serverUrl: string
  /** Absolute ms, computed at save time from `expires_in`. */
  readonly expiresAt?: number
}

/** One attempt in flight, kept so a second RPC can read how it ended. */
interface Attempt {
  readonly settled: Promise<AuthorizationState>
  state: AuthorizationState
}

/** Attempts by slug, for this process only — an attempt does not outlive it. */
const attempts = new Map<string, Attempt>()

/** Flows registered so far, by slug, so a retry does not register twice. */
const flows = new Map<string, () => void>()

/**
 * The record key one connector's grant lives under.
 * @param slug - the catalog slug, already known to match the record grammar.
 * @returns the branded key.
 */
function keyFor(slug: string): CredentialKey {
  return credentialKey(SCOPE, slug)
}

/**
 * Whether a connector needs a web sign-in, asked of the server rather than of
 * the manifest.
 *
 * The manifest's `auth.mode` is the catalog's claim and this is the endpoint's
 * own answer, which is the one that decides whether a mount will work. Only
 * the header is read: a body would tell us nothing the discovery chain will
 * not re-derive, and this runs while the user waits.
 * @param url - the server endpoint.
 * @param signal - caller cancellation.
 * @returns true when the server points at protected-resource metadata.
 */
export async function serverWantsAuthorization(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'openlux', version: '1' } },
      }),
      ...signal === undefined ? {} : { signal },
    })
    if (response.status !== 401 && response.status !== 403) return false
    return /resource_metadata|authorization_uri/iu.test(response.headers.get('www-authenticate') ?? '')
  } catch {
    // Unreachable is not "needs no sign-in", but it is also not a question this
    // call can answer; the mount attempt reports the connection failure with a
    // sentence the manifest cannot improve on.
    return false
  }
}

/**
 * A loopback listener for the one redirect this attempt expects.
 *
 * Bound to 127.0.0.1 on an ephemeral port: the port cannot be fixed because
 * two of these can be open at once, and the address cannot be `localhost`
 * because that resolves to `::1` on Windows first, which the issuer will not
 * have been told about.
 * @param expectedState - the CSRF value that must come back.
 * @returns the redirect URL to register, the code, and a way to stop early.
 */
function listenForCallback(expectedState: string): Promise<{
  readonly redirectUrl: string
  readonly code: Promise<string>
  readonly close: () => void
}> {
  return new Promise((resolveListener, rejectListener) => {
    const code = Promise.withResolvers<string>()
    const server: Server = createServer((request, response) => {
      const target = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (target.pathname !== '/callback') {
        response.writeHead(404).end()
        return
      }
      const failure = target.searchParams.get('error')
      const returned = target.searchParams.get('code')
      const state = target.searchParams.get('state')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      if (failure !== null) {
        response.end(page('授权没有完成', `授权服务器返回了 ${failure}。回到应用再试一次。`))
        code.reject(new Error(`授权服务器拒绝了这次授权：${failure}`))
      } else if (state !== expectedState) {
        // A redirect carrying someone else's state is the one thing this
        // listener must not act on: it is either a stale tab or a forgery.
        response.end(page('授权没有完成', '这次回调对不上本次授权，已忽略。'))
        code.reject(new Error('授权回调的 state 对不上，已拒绝。'))
      } else if (returned === null) {
        response.end(page('授权没有完成', '回调里没有授权码。'))
        code.reject(new Error('授权回调里没有授权码。'))
      } else {
        response.end(page('授权完成', '可以关掉这个页面，回到应用继续。'))
        code.resolve(returned)
      }
    })
    server.once('error', rejectListener)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | null
      if (address === null) {
        server.close()
        rejectListener(new Error('本地回调端口没能打开。'))
        return
      }
      const timer = setTimeout(() => {
        code.reject(new Error('等待浏览器授权超时（5 分钟）。'))
      }, CALLBACK_TIMEOUT_MS)
      timer.unref()
      const close = (): void => {
        clearTimeout(timer)
        server.close()
      }
      void code.promise.catch(() => {}).finally(close)
      resolveListener({ redirectUrl: `http://127.0.0.1:${String(address.port)}/callback`, code: code.promise, close })
    })
  })
}

/** The page the browser lands on when it comes back. */
function page(title: string, detail: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head>`
    + `<body style="font:16px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh">`
    + `<div style="text-align:center"><h1 style="font-size:20px;margin:0 0 8px">${title}</h1>`
    + `<p style="margin:0;color:#666">${detail}</p></div></body></html>`
}

/**
 * The SDK's client provider, backed by the credential seam.
 *
 * One instance per attempt. The PKCE verifier and the captured authorization
 * URL are per-attempt state and stay in memory; everything durable — the
 * registration and the tokens — goes through `modifyRecord`, whose exclusion
 * holds across processes so two launches cannot rotate one refresh token and
 * lose whichever wrote second.
 */
class ConnectorOAuthProvider implements OAuthClientProvider {
  #verifier: string | undefined
  /** Where `auth()` wanted to send the browser, captured instead of opened. */
  authorizationUrl: URL | undefined

  constructor(
    private readonly ctx: Context,
    private readonly slug: string,
    private readonly serverUrl: string,
    private readonly redirect: string,
    private readonly csrf: string,
    /** The registration read at construction, so `clientInformation` is sync-clean. */
    private client: OAuthClientInformationFull | undefined,
  ) {}

  get redirectUrl(): string { return this.redirect }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'OpenLux Desktop',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // A desktop app cannot keep a secret, so it registers as a public client
      // and proves possession with PKCE instead. Both endpoints probed accept
      // exactly this (`token_endpoint_auth_methods_supported: ["none"]`).
      token_endpoint_auth_method: 'none',
    }
  }

  state(): string { return this.csrf }

  clientInformation(): OAuthClientInformationMixed | undefined { return this.client }

  async saveClientInformation(information: OAuthClientInformationMixed): Promise<void> {
    this.client = information as OAuthClientInformationFull
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await readGrant(this.ctx, this.slug))?.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    if (this.client === undefined) {
      throw new Error('授权完成了，但没有客户端注册信息可以一起存下来。')
    }
    await writeGrant(this.ctx, this.slug, {
      tokens,
      client: this.client,
      serverUrl: this.serverUrl,
      ...tokens.expires_in === undefined ? {} : { expiresAt: Date.now() + tokens.expires_in * 1000 },
    })
  }

  redirectToAuthorization(url: URL): void { this.authorizationUrl = url }

  saveCodeVerifier(verifier: string): void { this.#verifier = verifier }

  codeVerifier(): string {
    if (this.#verifier === undefined) throw new Error('这次授权没有 PKCE 校验串。')
    return this.#verifier
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'verifier') { this.#verifier = undefined; return }
    if (scope === 'discovery') return
    if (scope === 'client') { this.client = undefined; return }
    this.#verifier = undefined
    if (scope === 'all') this.client = undefined
    await forgetConnectorGrant(this.ctx, this.slug)
  }
}

/**
 * Read one connector's stored grant.
 * @param ctx - host context, for the credential seam.
 * @param slug - the connector.
 * @returns the grant, or undefined when nothing is stored.
 */
async function readGrant(ctx: Context, slug: string): Promise<ConnectorGrant | undefined> {
  const record = await ctx.credentials.readRecord(keyFor(slug))
  if (record?.kind !== 'grant') return undefined
  const payload = record.payload as Partial<ConnectorGrant> | undefined
  return payload?.tokens === undefined || payload.client === undefined || payload.serverUrl === undefined
    ? undefined
    : payload as ConnectorGrant
}

/**
 * Commit one connector's grant.
 * @param ctx - host context.
 * @param slug - the connector.
 * @param grant - what to store.
 */
async function writeGrant(ctx: Context, slug: string, grant: ConnectorGrant): Promise<void> {
  await ctx.credentials.modifyRecord(keyFor(slug), async () => ({ kind: 'grant', payload: grant }))
}

/**
 * Forget one connector's grant, which is what signing out is here.
 *
 * Local only: the seam has no revoke, so a server-side session outlives this.
 * @param ctx - host context.
 * @param slug - the connector.
 */
export async function forgetConnectorGrant(ctx: Context, slug: string): Promise<void> {
  await ctx.credentials.deleteRecord(keyFor(slug))
  attempts.delete(slug)
  flows.get(slug)?.()
  flows.delete(slug)
}

/**
 * The bearer token to mount one connector with, refreshed if it is about to
 * expire.
 *
 * Called on the mount path rather than at sign-in time because a header is a
 * snapshot: the bridge holds whatever string it was given for the life of the
 * plugin instance, so the freshest possible value has to be the one handed
 * over. A refresh that fails is not an error here — it means the person has to
 * sign in again, which the caller reports as a connector that needs
 * authorization.
 * @param ctx - host context.
 * @param slug - the connector.
 * @returns the access token, or undefined when there is no usable grant.
 */
export async function readConnectorToken(ctx: Context, slug: string): Promise<string | undefined> {
  const grant = await readGrant(ctx, slug)
  if (grant === undefined) return undefined
  if (grant.expiresAt === undefined || grant.expiresAt - REFRESH_SKEW_MS > Date.now()) {
    return grant.tokens.access_token
  }
  if (grant.tokens.refresh_token === undefined) return undefined

  try {
    return await refreshGrant(ctx, slug, grant)
  } catch (error: unknown) {
    ctx.logger.warn(`openlux: connector ${slug} token refresh failed: ${String(error)}`)
    return undefined
  }
}

/**
 * Exchange a refresh token for a live one and commit the result.
 *
 * The refresh is spelled out rather than run through `auth()`, which since SDK
 * 1.30 answers a code-less call with "either provider.prepareTokenRequest() or
 * authorizationCode is required": its orchestrator now covers grant types that
 * need caller-built parameters, and the refresh leg is a primitive the caller
 * drives. Discovery is repeated rather than cached with the grant, because it
 * is one round trip on a path that is already mounting a server, and a cached
 * token endpoint is exactly the thing that goes stale without telling anyone.
 * @param ctx - host context.
 * @param slug - the connector.
 * @param grant - what is stored, with a refresh token in it.
 * @returns the new access token.
 */
async function refreshGrant(ctx: Context, slug: string, grant: ConnectorGrant): Promise<string> {
  const resource = await discoverOAuthProtectedResourceMetadata(grant.serverUrl).catch(() => undefined)
  const server = resource?.authorization_servers?.[0] ?? grant.serverUrl
  const metadata = await discoverAuthorizationServerMetadata(server)
  const refreshed = await refreshAuthorization(server, {
    ...metadata === undefined ? {} : { metadata },
    clientInformation: grant.client,
    refreshToken: grant.tokens.refresh_token as string,
    ...resource?.resource === undefined ? {} : { resource: new URL(resource.resource) },
  })
  await writeGrant(ctx, slug, {
    // A server that does not rotate its refresh token answers without one, and
    // taking that reply at face value would sign the user out at the next
    // expiry rather than at the refresh token's own.
    tokens: {
      ...refreshed,
      ...refreshed.refresh_token === undefined ? { refresh_token: grant.tokens.refresh_token } : {},
    },
    client: grant.client,
    serverUrl: grant.serverUrl,
    ...refreshed.expires_in === undefined ? {} : { expiresAt: Date.now() + refreshed.expires_in * 1000 },
  })
  return refreshed.access_token
}

/**
 * Whether this connector already holds a grant, for the gallery's row state.
 * @param ctx - host context.
 * @param slug - the connector.
 * @returns true when something is stored.
 */
export async function hasConnectorGrant(ctx: Context, slug: string): Promise<boolean> {
  return await readGrant(ctx, slug) !== undefined
}

/**
 * Register the flow for one connector, once per process.
 *
 * Lazily rather than at mount: a flow per catalog row would mean reading every
 * manifest at boot, and the seam's own `list()` is not what drives this
 * product's UI — the connector row is.
 * @param ctx - host context, carrying the authorization seam.
 * @param slug - the connector.
 * @param name - what to call it in the seam's roster.
 * @param serverUrl - the endpoint being signed in to.
 */
function ensureFlow(ctx: Context, slug: string, name: string, serverUrl: string): void {
  if (flows.has(slug)) return
  const dispose = ctx.authorization.registerFlow({
    key: keyFor(slug),
    label: name,
    methods: [{ id: 'oauth', label: '在浏览器中授权' }],
    async run(session: AuthorizationSession) {
      await runAuthorization(ctx, slug, serverUrl, session)
    },
  })
  flows.set(slug, dispose)
}

/**
 * One sign-in, from discovery to a committed grant.
 *
 * The two `auth()` calls are the SDK's own two-phase shape: the first walks
 * the discovery chain, registers this client if the server allows it, builds
 * the PKCE challenge, and hands back `REDIRECT` with the URL captured by the
 * provider; the second exchanges the code the browser brought back and saves
 * the tokens, which is the commit the seam is waiting to observe.
 * @param ctx - host context.
 * @param slug - the connector.
 * @param serverUrl - the endpoint.
 * @param session - the seam's session, for the notice and the cancel.
 */
async function runAuthorization(
  ctx: Context,
  slug: string,
  serverUrl: string,
  session: AuthorizationSession,
): Promise<void> {
  const state = crypto.randomUUID()
  const listener = await listenForCallback(state)
  try {
    const stored = await readGrant(ctx, slug)
    const provider = new ConnectorOAuthProvider(
      ctx, slug, serverUrl, listener.redirectUrl, state,
      // A previous registration is reused when it was made for this same
      // redirect; a new port means a new redirect_uri, which most servers
      // reject against an old client_id.
      stored?.client.redirect_uris.includes(listener.redirectUrl) === true ? stored.client : undefined,
    )

    const first = await auth(provider, { serverUrl })
    if (first === 'AUTHORIZED') return
    if (provider.authorizationUrl === undefined) {
      throw new Error('授权服务器没有给出可以打开的授权地址。')
    }

    session.notify({
      message: '已在浏览器中打开授权页面，完成后自动回到这里。',
      url: provider.authorizationUrl.href,
    })

    const code = await Promise.race([
      listener.code,
      cancellation(session.signal),
    ])
    const second = await auth(provider, { serverUrl, authorizationCode: code })
    if (second !== 'AUTHORIZED') throw new Error('授权码没能换到令牌。')
  } finally {
    listener.close()
  }
}

/**
 * A promise that only ever rejects, when the attempt is withdrawn.
 * @param signal - the session's signal.
 * @returns a promise racing against the browser.
 */
function cancellation(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new AuthorizationDeclinedError())
      return
    }
    signal.addEventListener('abort', () => { reject(new AuthorizationDeclinedError()) }, { once: true })
  })
}

/**
 * Start a sign-in and answer with the page to open.
 *
 * Returns as soon as the authorization URL exists rather than when the attempt
 * finishes, because the renderer is what opens the browser: the host has no
 * `shell.openExternal` of its own, while a renderer's `window.open` is handed
 * to it by the desktop shell's window-open handler
 * (`dsh-plugin-desktop/src/electron-shell-generation.ts:157`). The attempt
 * keeps running; `readAuthorizationState` is how the gallery learns how it
 * ended.
 * @param ctx - host context.
 * @param slug - the connector.
 * @param name - display name, for the seam's roster.
 * @param serverUrl - the endpoint to sign in to.
 * @returns the URL to open, or why nothing was started.
 */
export async function startConnectorAuthorization(
  ctx: Context,
  slug: string,
  name: string,
  serverUrl: string,
): Promise<AuthorizationStart> {
  if (ctx.get('authorization') === undefined) {
    return { kind: 'refused', message: '当前部署没有挂载授权服务，无法完成网页授权。' }
  }
  if (attempts.get(slug)?.state.kind === 'pending') {
    return { kind: 'refused', message: '这个连接器的授权已经在进行中了。' }
  }
  ensureFlow(ctx, slug, name, serverUrl)

  const opened = Promise.withResolvers<string>()
  const attempt: Attempt = {
    state: { kind: 'pending' },
    settled: (async (): Promise<AuthorizationState> => {
      try {
        const outcome = await ctx.authorization.begin({
          key: keyFor(slug),
          interaction: {
            notify: (notice: { readonly url?: string }) => {
              if (notice.url !== undefined) opened.resolve(notice.url)
            },
            // Every question this flow could ask is answered by the loopback
            // redirect, so a prompt reaching here means the seam wanted
            // something the browser was going to bring back anyway.
            prompt: async () => { throw new AuthorizationDeclinedError() },
          },
        })
        return outcome.status === 'authorized' ? { kind: 'authorized' } : { kind: 'cancelled' }
      } catch (error: unknown) {
        return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
      }
    })(),
  }
  attempts.set(slug, attempt)
  void attempt.settled.then((state) => {
    attempt.state = state
    // A failure before the browser ever opened has to unblock the caller, or
    // the gallery would wait on a URL that is never coming.
    opened.reject(new Error(state.kind === 'failed' ? state.message : '授权没有完成。'))
  })

  try {
    return { kind: 'opened', url: await opened.promise }
  } catch (error: unknown) {
    return { kind: 'refused', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * How the current or last attempt for one connector ended.
 * @param slug - the connector.
 * @returns the state the gallery polls for.
 */
export function readAuthorizationState(slug: string): AuthorizationState {
  return attempts.get(slug)?.state ?? { kind: 'idle' }
}
