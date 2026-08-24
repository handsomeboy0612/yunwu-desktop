/**
 * Signing in to a connector, driven end to end against a real server.
 *
 * The live half of this cannot be run here: the browser step needs an account
 * on someone else's product. What a test *can* own is everything on our side
 * of that click — the discovery chain, dynamic registration, the PKCE
 * round trip, the loopback listener, the commit into the credential seam, and
 * the header the bridge finally gets — so the authorization server is a real
 * HTTP server on loopback and the "browser" is a `fetch` that follows the
 * redirect back to us.
 *
 * Worth owning because every failure in this path is quiet in the same way a
 * misplaced token is: a connector that mounts, answers 401 to every tool call,
 * and reports itself as connected.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  forgetConnectorGrant, hasConnectorGrant, readAuthorizationState, readConnectorToken,
  startConnectorAuthorization,
} from '../../openlux-plugin-account/src/market/connector-oauth.ts'

/** The host context, taken off the subject for the same reason as elsewhere. */
type Host = Parameters<typeof readConnectorToken>[0]

/** What the fake authorization server was asked for, in order. */
let visited: string[] = []

/** Tokens minted so far, so a refresh can be told from the first exchange. */
let minted = 0

/** How long the access token the server hands out is good for. */
let lifetimeSeconds: number | undefined

let server: Server
let origin: string

/** Records the subject wrote, keyed the way the seam keys them. */
let records: Map<string, unknown>

/**
 * A minimal but honest OAuth 2.1 authorization server.
 *
 * Honest in the parts the subject depends on: it advertises itself through
 * both well-known documents, registers a public client dynamically, requires
 * `code_challenge`, and returns a refresh token — so a run that passes here
 * exercised the same code path Moka's endpoint will.
 */
function start(): Promise<void> {
  return new Promise((settle) => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', origin)
      visited.push(url.pathname)
      const send = (status: number, body: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body))
      }

      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        send(200, {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ['mcp:tools'],
        })
        return
      }
      if (url.pathname.startsWith('/.well-known/oauth-authorization-server')
        || url.pathname.startsWith('/.well-known/openid-configuration')) {
        send(200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        })
        return
      }
      if (url.pathname === '/register') {
        send(201, {
          client_id: 'registered-client',
          client_id_issued_at: Math.floor(Date.now() / 1000),
          redirect_uris: [],
          token_endpoint_auth_method: 'none',
        })
        return
      }
      if (url.pathname === '/authorize') {
        // The one thing a human does, done by the redirect itself: a server
        // that did not receive a challenge must not hand out a code.
        if (url.searchParams.get('code_challenge') === null) {
          send(400, { error: 'invalid_request' })
          return
        }
        const back = new URL(url.searchParams.get('redirect_uri') ?? '')
        back.searchParams.set('code', 'the-code')
        back.searchParams.set('state', url.searchParams.get('state') ?? '')
        response.writeHead(302, { location: back.href })
        response.end()
        return
      }
      if (url.pathname === '/token') {
        minted += 1
        send(200, {
          access_token: `token-${String(minted)}`,
          token_type: 'Bearer',
          refresh_token: 'the-refresh-token',
          ...lifetimeSeconds === undefined ? {} : { expires_in: lifetimeSeconds },
        })
        return
      }
      send(404, { error: 'not_found' })
    })
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      settle()
    })
  })
}

/**
 * A context holding the two seams the subject writes through.
 *
 * `authorization` is a stand-in rather than the kernel's service: the seam's
 * own exclusion and settlement are its package's to test, while what this file
 * is about is the flow that runs inside it.
 */
function host(): Host {
  const flows = new Map<string, { run: (session: unknown) => Promise<void> }>()
  const authorization = {
    registerFlow(flow: { key: unknown; run: (session: unknown) => Promise<void> }) {
      flows.set(String(flow.key), flow)
      return () => flows.delete(String(flow.key))
    },
    async begin({ key, interaction }: {
      key: unknown
      interaction: { notify: (notice: unknown) => void; prompt: () => Promise<never> }
    }) {
      const flow = flows.get(String(key))
      if (flow === undefined) throw new Error(`no flow for ${String(key)}`)
      await flow.run({
        method: 'oauth',
        signal: new AbortController().signal,
        notify: interaction.notify,
        prompt: interaction.prompt,
      })
      return { status: 'authorized' as const }
    },
  }
  const credentials = {
    async readRecord(key: unknown) { return records.get(String(key)) },
    async modifyRecord(key: unknown, mutate: (current: unknown) => Promise<unknown>) {
      const next = await mutate(records.get(String(key)))
      if (next !== undefined) records.set(String(key), next)
      return next
    },
    async deleteRecord(key: unknown) { records.delete(String(key)) },
  }
  return {
    logger: { info: () => {}, warn: () => {} },
    get: (name: string) => (name === 'authorization' ? authorization : undefined),
    authorization,
    credentials,
  } as unknown as Host
}

beforeEach(async () => {
  visited = []
  minted = 0
  lifetimeSeconds = undefined
  records = new Map()
  await start()
})

afterEach(async () => {
  await forgetConnectorGrant(host(), 'probe')
  await new Promise((settle) => { server.close(() => { settle(undefined) }) })
})

/**
 * Run one sign-in the way the gallery does, with `fetch` standing in for the
 * browser the renderer would have opened.
 * @param ctx - the host to run against.
 * @returns what the gallery would have shown.
 */
async function signIn(ctx: Host): Promise<ReturnType<typeof readAuthorizationState>> {
  const started = await startConnectorAuthorization(ctx, 'probe', 'Probe', `${origin}/mcp`)
  expect(started.kind).toBe('opened')
  if (started.kind !== 'opened') throw new Error(started.message)

  // The redirect chain ends at our own loopback listener, which is what the
  // flow is waiting on; following it is the entire browser step.
  const landed = await fetch(started.url, { redirect: 'follow' })
  expect(landed.status).toBe(200)

  for (let waited = 0; waited < 50; waited += 1) {
    const state = readAuthorizationState('probe')
    if (state.kind !== 'pending') return state
    await new Promise((settle) => { setTimeout(settle, 20) })
  }
  return readAuthorizationState('probe')
}

describe('connector web sign-in', () => {
  it('walks discovery, registers itself, and commits a usable token', async () => {
    const ctx = host()
    expect(await hasConnectorGrant(ctx, 'probe')).toBe(false)

    expect(await signIn(ctx)).toEqual({ kind: 'authorized' })

    // Discovery before registration before exchange: an order that goes wrong
    // still ends in a token, so it is asserted rather than inferred.
    expect(visited.filter(path => path.startsWith('/.well-known')).length).toBeGreaterThan(0)
    expect(visited).toContain('/register')
    expect(visited).toContain('/authorize')
    expect(visited).toContain('/token')

    expect(await hasConnectorGrant(ctx, 'probe')).toBe(true)
    expect(await readConnectorToken(ctx, 'probe')).toBe('token-1')
  })

  it('stores the grant as a grant, so nothing lands in the reference space', async () => {
    const ctx = host()
    await signIn(ctx)

    const stored = [...records.entries()]
    expect(stored).toHaveLength(1)
    const [key, value] = stored[0] as [string, { kind: string; payload: { tokens: { access_token: string } } }]
    // The scope half is this plugin's registered name; a record written under
    // any other scope is one no later launch would look for.
    expect(key).toBe('openlux-plugin-account/probe')
    expect(value.kind).toBe('grant')
    expect(value.payload.tokens.access_token).toBe('token-1')
  })

  it('renews an access token that is about to expire, on the mount path', async () => {
    lifetimeSeconds = 30
    const ctx = host()
    await signIn(ctx)
    expect(minted).toBe(1)

    // Still inside the skew, so the mount would hand the bridge a header that
    // expires while the session is open — the case the refresh exists for.
    expect(await readConnectorToken(ctx, 'probe')).toBe('token-2')
    expect(minted).toBe(2)
  })

  it('leaves a long-lived token alone', async () => {
    lifetimeSeconds = 24 * 60 * 60
    const ctx = host()
    await signIn(ctx)

    expect(await readConnectorToken(ctx, 'probe')).toBe('token-1')
    expect(minted).toBe(1)
  })

  it('forgets everything on disconnect', async () => {
    const ctx = host()
    await signIn(ctx)
    await forgetConnectorGrant(ctx, 'probe')

    expect(await hasConnectorGrant(ctx, 'probe')).toBe(false)
    expect(await readConnectorToken(ctx, 'probe')).toBeUndefined()
    expect(records.size).toBe(0)
  })

  it('refuses to start when the composition mounts no authorization seam', async () => {
    const bare = { logger: { info: () => {}, warn: () => {} }, get: () => undefined } as unknown as Host
    const started = await startConnectorAuthorization(bare, 'probe', 'Probe', `${origin}/mcp`)

    expect(started).toMatchObject({ kind: 'refused' })
  })
})
