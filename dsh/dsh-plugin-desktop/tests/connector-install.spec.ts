/**
 * Connectors, in the cases a real-machine run cannot show.
 *
 * The whole live half was driven through the running app on 2026-08-24 —
 * connect with no auth, connect with a token, restore across a restart,
 * disconnect, and a recorded connector whose command no longer exists — so what
 * is left here is the translation from one console manifest to one bridge
 * config. That step is worth its own test because every mistake in it fails
 * quietly: a token written where the transport cannot read it, an `sse` row
 * silently upgraded, a namespace the bridge would reject at load.
 *
 * The record file is exercised through the same `$DSH_HOME` swap the skill
 * tests use, because the subject reads the kernel's own home resolver.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectorManifest } from '../../openlux-plugin-account/src/market/console.ts'
import {
  buildConfig, customPath, looksUnauthorized, readConnectorTarget, recordPath,
  remountConnector, restoreConnectors, syncCustomConnectors, uninstallConnector,
} from '../../openlux-plugin-account/src/market/connector-install.ts'

/**
 * The host context, as the subject sees it.
 *
 * Taken off the subject rather than imported from `@deepseek-ai/cordis`: this
 * package and the plugin each resolve their own copy of cordis, and two copies
 * of one structural type are two nominal types to the compiler — so importing
 * it here fails to assign for a reason that has nothing to do with the test.
 */
type Host = Parameters<typeof restoreConnectors>[0]

/** A context with the two things the subject reaches for. */
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  get: () => undefined,
} as unknown as Host

const homes: string[] = []
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'openlux-connector-'))
  homes.push(home)
  process.env.DSH_HOME = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** One manifest, in the shape the console stores. */
function manifest(server: Record<string, unknown>, auth?: ConnectorManifest['auth']): ConnectorManifest {
  return { mcpName: 'probe', server, ...auth === undefined ? {} : { auth } }
}

describe('manifest to bridge config', () => {
  it('carries a local server across, and refuses one that names nothing to run', () => {
    const built = buildConfig(manifest({ command: 'npx', args: ['-y', 'thing'], cwd: '/tmp' }))

    expect(built).toEqual({
      kind: 'built',
      serverName: 'probe',
      config: {
        serverName: 'probe',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'thing'],
        cwd: '/tmp',
        // Ours, not the manifest's: without it a server that never connects
        // still "connects", with no tools and no reconnect.
        failOnStartupError: true,
      },
    })
    expect(buildConfig(manifest({ note: 'nothing runnable' })))
      .toMatchObject({ kind: 'refused', reason: 'bad-manifest' })
  })

  it('reads a url as the http transport and refuses a transport the bridge cannot speak', () => {
    expect(buildConfig(manifest({ url: 'https://example.test/mcp' }))).toMatchObject({
      kind: 'built',
      config: { transport: 'streamable-http', url: 'https://example.test/mcp' },
    })
    // `sse` was a legitimate transport for the kernel this catalog was written
    // for. Upgrading it silently would connect to an endpoint speaking another
    // protocol, so it is refused by name.
    expect(buildConfig(manifest({ url: 'https://example.test/mcp', transport: 'sse' })))
      .toMatchObject({ kind: 'refused', reason: 'unsupported-transport' })
  })

  it('puts the token where the transport can read it, prefix and all, and says where', () => {
    const stdio = buildConfig(
      manifest({ command: 'npx', args: ['-y', 'tavily-mcp'] },
        { mode: 'token', inject: 'env', key: 'TAVILY_API_KEY' }),
      'tvly-123',
    )
    expect(stdio).toMatchObject({
      config: { env: { TAVILY_API_KEY: 'tvly-123' } },
      // Reported back so the caller can lift the value into the credential seam
      // and write down a config that carries none.
      secret: { site: 'env', key: 'TAVILY_API_KEY' },
    })

    const http = buildConfig(
      manifest({ url: 'https://example.test/mcp' },
        { mode: 'token', key: 'Authorization', prefix: 'Bearer ' }),
      'abc',
    )
    expect(http).toMatchObject({
      config: { headers: { Authorization: 'Bearer abc' } },
      secret: { site: 'headers', key: 'Authorization' },
    })
    expect(buildConfig(manifest({ command: 'npx' }))).not.toHaveProperty('secret')
  })

  it('ignores an inject site that contradicts the transport rather than writing it nowhere', () => {
    // The old shell trusted this field and would put `headers` on a local
    // process, where nothing reads them: the connector connects and then fails
    // every call. There is one readable place per transport, so that one wins.
    const built = buildConfig(
      manifest({ command: 'npx' }, { mode: 'token', inject: 'header', key: 'API_KEY' }),
      'secret',
    )

    expect(built).toMatchObject({ config: { env: { API_KEY: 'secret' } } })
    expect(built).not.toMatchObject({ config: { headers: expect.anything() } })
  })

  it('refuses the three manifests that cannot become a connection', () => {
    expect(buildConfig(manifest({ command: 'npx' }, { mode: 'token', key: 'K' })))
      .toMatchObject({ kind: 'refused', reason: 'needs-token' })
    // Declared token auth with no field name: nowhere to put the secret.
    expect(buildConfig(manifest({ command: 'npx' }, { mode: 'token' }), 'secret'))
      .toMatchObject({ kind: 'refused', reason: 'bad-manifest' })
    // A web sign-in produces a bearer token, which needs a request to ride on.
    // A spawned process has none, so this manifest describes nothing buildable.
    expect(buildConfig(manifest({ command: 'npx' }, { mode: 'oauth' }), 'x'))
      .toMatchObject({ kind: 'refused', reason: 'unsupported-auth' })
  })

  it('builds a signed-in connector, and says so when no grant has been made yet', () => {
    // The catalog's OAuth rows were written for a kernel that ran `mcp login`
    // and so declare no field; `Authorization: Bearer` is the token endpoint's
    // own `token_type` rather than a guess, and an explicit field still wins.
    const granted = buildConfig(manifest({ url: 'https://example.test/mcp' }, { mode: 'oauth' }), 'tok')
    expect(granted).toMatchObject({
      kind: 'built',
      config: { headers: { Authorization: 'Bearer tok' } },
      oauth: { site: 'headers', key: 'Authorization', prefix: 'Bearer ' },
    })
    // The prefix rides in the record because the value does not: a grant is
    // re-read and re-spelled on every mount.
    expect(granted).not.toHaveProperty('secret')

    expect(buildConfig(manifest({ url: 'https://example.test/mcp' }, { mode: 'oauth' })))
      .toMatchObject({ kind: 'refused', reason: 'needs-authorization' })

    expect(buildConfig(
      manifest({ url: 'https://example.test/mcp' }, { mode: 'oauth', key: 'X-Token', prefix: '' }),
      'tok',
    )).toMatchObject({ config: { headers: { 'X-Token': 'tok' } } })
  })

  it('refuses a namespace the bridge would reject at load', () => {
    const named = (mcpName: string): ReturnType<typeof buildConfig> =>
      buildConfig({ mcpName, server: { command: 'npx' } })

    expect(named('has space')).toMatchObject({ kind: 'refused', reason: 'bad-manifest' })
    expect(named('a'.repeat(33))).toMatchObject({ kind: 'refused', reason: 'bad-manifest' })
    expect(named('fine_name-1')).toMatchObject({ kind: 'built', serverName: 'fine_name-1' })
  })
})

describe('the record', () => {
  it('reads as empty when there is none, and reports a deployment that cannot mount', async () => {
    const target = await readConnectorTarget(ctx)

    expect(target).toEqual({ mountable: false, installed: [], custom: 0 })
  })

  it('lists what was connected, marking as not live anything this launch did not mount', async () => {
    writeFileSync(recordPath(), JSON.stringify([
      {
        slug: 'context7',
        serverName: 'context7',
        name: 'Context7',
        version: '1.0.0',
        connectedAt: '2026-08-24T00:00:00.000Z',
        config: { serverName: 'context7', transport: 'stdio', command: 'npx' },
      },
      // Not a record: no config to mount from, so it cannot be re-connected and
      // has no business claiming a row.
      { slug: 'broken', serverName: 'broken' },
    ]), 'utf8')

    const target = await readConnectorTarget(ctx)

    expect(target.installed).toEqual([{
      slug: 'context7',
      serverName: 'context7',
      name: 'Context7',
      version: '1.0.0',
      connectedAt: '2026-08-24T00:00:00.000Z',
      live: false,
      // What it runs, for a row the catalog may no longer have an entry for.
      summary: 'npx',
    }])
  })

  it('drops the file when the last connector goes, and says nothing was there when it was not', async () => {
    writeFileSync(recordPath(), JSON.stringify([{
      slug: 'context7',
      serverName: 'context7',
      name: 'Context7',
      connectedAt: '2026-08-24T00:00:00.000Z',
      config: { serverName: 'context7', transport: 'stdio', command: 'npx' },
    }]), 'utf8')

    expect(await uninstallConnector(ctx, 'not-connected')).toBe(false)
    expect(await uninstallConnector(ctx, 'context7')).toBe(true)

    expect(() => readFileSync(recordPath(), 'utf8')).toThrow()
    expect((await readConnectorTarget(ctx)).installed).toEqual([])
  })

  it('survives a record file that is not what it expects', async () => {
    writeFileSync(recordPath(), 'not json at all', 'utf8')

    expect((await readConnectorTarget(ctx)).installed).toEqual([])
  })
})

describe('the token', () => {
  it('comes back out of the credential seam at mount time, not off disk', async () => {
    const secrets = new Map([['OPENLUX_MCP_TAVILY_ONE', 'tvly-real']])
    const { ctx: host, mounts } = withRecordingLoader(secrets)
    writeFileSync(recordPath(), pointing('tavily-one'), 'utf8')

    expect(await restoreConnectors(host)).toEqual({ mounted: 1, failed: 0 })

    expect(mounts).toHaveLength(1)
    expect(mounts[0]).toMatchObject({ env: { SEARCH_API_KEY: 'tvly-real' } })
    // And the value is still nowhere in the file the record lives in.
    expect(readFileSync(recordPath(), 'utf8')).not.toContain('tvly-real')
  })

  it('refuses to mount a connector whose token is gone, rather than one that 401s', async () => {
    const { ctx: host, mounts } = withRecordingLoader(new Map())
    writeFileSync(recordPath(), pointing('tavily-two'), 'utf8')

    expect(await restoreConnectors(host)).toEqual({ mounted: 0, failed: 1 })

    expect(mounts).toEqual([])
    // The row stays, carrying its reason, so the user can disconnect it.
    const target = await readConnectorTarget(host)
    expect(target.installed).toMatchObject([{ slug: 'tavily-two', live: false }])
    expect(target.installed[0]?.failure).toContain('凭据库')
  })

  it('is dropped when the connector is disconnected', async () => {
    const secrets = new Map([['OPENLUX_MCP_TAVILY_THREE', 'tvly-real']])
    const { ctx: host } = withRecordingLoader(secrets)
    writeFileSync(recordPath(), pointing('tavily-three'), 'utf8')

    expect(await uninstallConnector(host, 'tavily-three')).toBe(true)

    expect(secrets.size).toBe(0)
  })
})

/**
 * The user's own file.
 *
 * Mounting from it, and dropping what it stops asking for, were both driven
 * through the running app on 2026-08-24. What is here is the reading: a file
 * written by hand is wrong sometimes, and every kind of wrong has to come back
 * as a sentence naming the server, because the panel is the only place that can
 * say so — the servers themselves never start.
 */
describe('the user\'s own file', () => {
  /** Write the custom file with these servers under `mcpServers`. */
  function custom(servers: Record<string, unknown>): void {
    writeFileSync(customPath(), JSON.stringify({ mcpServers: servers }), 'utf8')
  }

  it('reads an absent or empty file as no servers rather than as a fault', async () => {
    const { ctx: host } = withRecordingLoader(new Map())

    expect(await syncCustomConnectors(host)).toMatchObject({ live: 0, problems: [] })

    writeFileSync(customPath(), '   \n', 'utf8')
    expect(await syncCustomConnectors(host)).toMatchObject({ live: 0, problems: [] })
  })

  it('mounts what the file asks for and leaves an already-mounted server alone', async () => {
    const { ctx: host, mounts } = withRecordingLoader(new Map())
    custom({ ownone: { command: 'node', args: ['server.js'] } })

    expect(await syncCustomConnectors(host)).toMatchObject({ live: 1, problems: [] })
    // Pressing «重新读取» twice must not restart a server that is already up:
    // a restart drops the tools mid-conversation for no reason.
    expect(await syncCustomConnectors(host)).toMatchObject({ live: 1, problems: [] })

    expect(mounts).toHaveLength(1)
    expect(mounts[0]).toMatchObject({ serverName: 'ownone', command: 'node', failOnStartupError: true })
    expect((await readConnectorTarget(host)).custom).toBe(1)
  })

  it('unmounts a server the file no longer names', async () => {
    const { ctx: host, removed } = withRecordingLoader(new Map())
    custom({ owntwo: { command: 'node' } })
    expect(await syncCustomConnectors(host)).toMatchObject({ live: 1 })

    custom({})

    expect(await syncCustomConnectors(host)).toMatchObject({ live: 0, problems: [] })
    // By name rather than by count: the live-mount table is process-wide, so
    // this sync also drops whatever an earlier case in this file left up.
    expect(removed).toContain('openlux-connector-owntwo')
    // Deleting a server from the file is the only way to get rid of one, so a
    // sync that left it mounted would make them permanent.
    expect((await readConnectorTarget(host)).custom).toBe(0)
  })

  it('names the server in every kind of wrong, and keeps the parser message', async () => {
    const { ctx: host, mounts } = withRecordingLoader(new Map())

    writeFileSync(customPath(), '{ "mcpServers": { "x": {}, } }', 'utf8')
    const broken = await syncCustomConnectors(host)
    expect(broken.live).toBe(0)
    // The position in the parser's own words is what makes a typo findable.
    expect(broken.problems).toEqual([expect.stringContaining('position')])

    writeFileSync(customPath(), '[]', 'utf8')
    expect(await syncCustomConnectors(host)).toMatchObject({ problems: ['配置文件的最外层要是一个对象。'] })

    writeFileSync(customPath(), '{ "servers": 3 }', 'utf8')
    expect(await syncCustomConnectors(host)).toMatchObject({ problems: ['配置文件里要有一个 mcpServers 对象。'] })

    custom({ ownthree: { args: ['nothing-to-run'] } })
    const shapeless = await syncCustomConnectors(host)
    expect(shapeless.problems).toEqual([expect.stringContaining('ownthree')])
    expect(mounts).toEqual([])
  })

  it('tells the owner of a remote server to check the url, not a command it has none of', async () => {
    const { ctx: host } = withRecordingLoader(new Map(), () => {
      throw new Error('mcp-client(ownfour): initial connection or tool synchronization failed')
    })
    custom({ ownfour: { url: 'https://example.test/mcp' } })

    const synced = await syncCustomConnectors(host)

    expect(synced.live).toBe(0)
    expect(synced.problems).toEqual([expect.stringContaining('url')])
    // The bridge's own sentence names our loader entry id, which is ours to
    // know and not the user's; the advice for a `command` would send the owner
    // of a `url` looking for one that does not exist.
    expect(synced.problems[0]).not.toContain('openlux-connector')
    expect(synced.problems[0]).not.toContain('command')
  })
})

/**
 * A web sign-in that stopped working, and the repair.
 *
 * Both halves are here rather than on the machine because the live half needs
 * a provider willing to expire a grant on cue. What the repair has to get
 * right is not the OAuth — `connector-oauth.spec.ts` drives that against a
 * real server — but the mount: an entry already in the tree is holding the
 * dead token, so remounting has to replace it rather than adopt it.
 *
 * These are also the only cases that mount a signed-in connector from disk,
 * which is how they caught the record parser dropping `oauth` on the way in:
 * the connector came up with no `Authorization` header and reported itself
 * live, so every restart of a working connector broke it silently.
 */
describe('a sign-in that died', () => {
  /** One record whose token comes from a web sign-in rather than a paste. */
  function signedIn(slug: string): string {
    return JSON.stringify([{
      slug,
      serverName: slug,
      name: 'Moka',
      connectedAt: '2026-08-25T00:00:00.000Z',
      config: { serverName: slug, transport: 'streamable-http', url: 'https://example.test/mcp' },
      oauth: { site: 'headers', key: 'Authorization', prefix: 'Bearer ' },
    }])
  }

  /**
   * A context whose loader tracks its own store, and a seam holding one grant.
   *
   * The store matters here and not in the other cases: `mountEntry` adopts an
   * entry that is already there, so a loader that forgets what it mounted
   * cannot tell adoption from a fresh mount.
   * @param grant - what the seam answers with, or nothing for a dead sign-in.
   * @param options - `removalSticks: false` leaves the entry in the store after
   *   a removal that reported success, which is the shape a repair must refuse;
   *   `onCreate` throws in the bridge's place, for the refusals that only the
   *   server can produce.
   * @returns the context, what it mounted, and what it removed.
   */
  function withGrant(
    grant?: Record<string, unknown>,
    options?: { removalSticks?: boolean; onCreate?: () => void },
  ): {
    ctx: Host
    mounts: Record<string, unknown>[]
    removed: string[]
    put: (next: Record<string, unknown>) => void
  } {
    const mounts: Record<string, unknown>[] = []
    const removed: string[] = []
    const store: Record<string, unknown> = {}
    let held = grant
    const loader = {
      store,
      create: async (options_: Record<string, unknown>) => {
        options?.onCreate?.()
        mounts.push(options_.config as Record<string, unknown>)
        store[String(options_.id)] = options_
        return String(options_.id)
      },
      remove: async (id: string) => {
        removed.push(id)
        if (options?.removalSticks !== false) delete store[id]
      },
    }
    return {
      mounts,
      removed,
      put: (next) => { held = next },
      ctx: {
        logger: { info: () => {}, warn: () => {} },
        get: (name: string) => name === 'loader' ? loader : undefined,
        credentials: {
          readRecord: async () => held === undefined ? undefined : { kind: 'grant', payload: held },
          modifyRecord: async () => {},
          deleteRecord: async () => { held = undefined },
        },
      } as unknown as Host,
    }
  }

  /** A grant the mount path will accept, with no expiry to chase. */
  function living(token: string): Record<string, unknown> {
    return {
      tokens: { access_token: token, token_type: 'Bearer' },
      client: { client_id: 'registered' },
      serverUrl: 'https://example.test/mcp',
    }
  }

  it('leaves the row connected, and says the sign-in is what needs fixing', async () => {
    const { ctx: host, mounts } = withGrant()
    writeFileSync(recordPath(), signedIn('moka-dead'), 'utf8')

    expect(await restoreConnectors(host)).toEqual({ mounted: 0, failed: 1 })

    expect(mounts).toEqual([])
    const target = await readConnectorTarget(host)
    // Still connected: the record is what "connected" means, and a row that
    // vanished would take its disconnect button with it.
    expect(target.installed).toMatchObject([{ slug: 'moka-dead', live: false }])
    // The flag, not the sentence, is what the row turns into a button.
    expect(target.installed[0]?.needsAuthorization).toBe(true)
    expect(target.installed[0]?.failure).toContain('授权')
  })

  it('mounts the new token after the repair, instead of adopting the dead one', async () => {
    const { ctx: host, mounts, removed, put } = withGrant(living('first'))
    writeFileSync(recordPath(), signedIn('moka-live'), 'utf8')
    expect(await restoreConnectors(host)).toEqual({ mounted: 1, failed: 0 })
    expect(mounts[0]).toMatchObject({ headers: { Authorization: 'Bearer first' } })

    put(living('second'))
    expect(await remountConnector(host, 'moka-live')).toEqual({ kind: 'mounted' })

    // The entry that held the old token is gone rather than reused, which is
    // the whole point: adopting it would report success and keep serving a
    // token the provider has stopped honouring.
    expect(removed).toEqual(['openlux-connector-moka-live'])
    expect(mounts).toHaveLength(2)
    expect(mounts[1]).toMatchObject({ headers: { Authorization: 'Bearer second' } })
    expect((await readConnectorTarget(host)).installed).toMatchObject([{ live: true }])
  })

  it('keeps the row and the flag when the repair did not take', async () => {
    const { ctx: host } = withGrant(living('first'))
    writeFileSync(recordPath(), signedIn('moka-again'), 'utf8')
    expect(await restoreConnectors(host)).toEqual({ mounted: 1, failed: 0 })

    // Signed out again between the press and the remount.
    await uninstallGrantOnly(host)
    expect(await remountConnector(host, 'moka-again')).toMatchObject({ kind: 'refused' })

    const target = await readConnectorTarget(host)
    expect(target.installed).toMatchObject([{ slug: 'moka-again', live: false }])
    expect(target.installed[0]?.needsAuthorization).toBe(true)
  })

  it('refuses a slug it has no record for', async () => {
    const { ctx: host } = withGrant(living('first'))

    expect(await remountConnector(host, 'never-connected')).toMatchObject({ kind: 'refused' })
  })

  it('offers the repair when the provider rejected a grant this side still believes in', async () => {
    // Nothing expired locally, so the token is handed over and the refusal
    // arrives from the mount instead — the shape a revoke on the provider's
    // side takes. Both layers below are copied from what actually ships, and
    // both matter: `dsh-mcp-client` throws one fixed sentence with the real
    // error on `cause` (`lib/index.js:782`), and the SDK's own 401 carries the
    // status only on `.code` — its message says `Streamable HTTP error: …`
    // and never the number (`client/streamableHttp.js:16-21,369`).
    const revoked = Object.assign(
      new Error('Streamable HTTP error: Error POSTing to endpoint: token revoked'),
      { code: 401 },
    )
    const { ctx: host } = withGrant(living('first'), {
      onCreate: () => {
        throw new Error('mcp-client(moka-revoked): initial connection or tool synchronization failed', {
          cause: revoked,
        })
      },
    })
    writeFileSync(recordPath(), signedIn('moka-revoked'), 'utf8')

    expect(await restoreConnectors(host)).toEqual({ mounted: 0, failed: 1 })

    const target = await readConnectorTarget(host)
    expect(target.installed[0]?.needsAuthorization).toBe(true)
    // The status reached the row rather than being swallowed by the wrapper.
    expect(target.installed[0]?.failure).toContain('401')
  })

  it('leaves an unrelated failure alone, so the button means what it says', () => {
    expect(looksUnauthorized('spawn npx ENOENT (ENOENT)', 'moka')).toBe(false)
    expect(looksUnauthorized('fetch failed ← connect ECONNREFUSED 127.0.0.1:8080', 'moka')).toBe(false)
    expect(looksUnauthorized('… failed ← Streamable HTTP error: … (401)', 'moka')).toBe(true)
    expect(looksUnauthorized('… failed ← Authentication required', 'moka')).toBe(true)
  })

  it('does not read a connector\'s own name as the reason it failed', () => {
    // Identity products are called this, and the name is inside the sentence:
    // the client's wrapper reads `mcp-client(<serverName>): …`. Matching it
    // would pin the button to every failure this connector ever has.
    const down = 'mcp-client(authing): initial connection or tool synchronization failed'
      + ' ← fetch failed ← connect ECONNREFUSED 127.0.0.1:8080'
    expect(looksUnauthorized(down, 'authing')).toBe(false)
    // The real one still lands for the same connector.
    expect(looksUnauthorized(`${down.split(' ← ')[0]} ← Streamable HTTP error: … (401)`, 'authing')).toBe(true)
  })

  it('refuses rather than adopting an entry the unmount could not take down', async () => {
    const { ctx: host, mounts } = withGrant(living('first'), { removalSticks: false })
    writeFileSync(recordPath(), signedIn('moka-stuck'), 'utf8')
    expect(await restoreConnectors(host)).toEqual({ mounted: 1, failed: 0 })

    const outcome = await remountConnector(host, 'moka-stuck')

    // Adopting would have answered `mounted` while the server kept serving the
    // token the user just replaced — a repair that reports success and fixes
    // nothing is worse than one that says it could not run.
    expect(outcome).toMatchObject({ kind: 'refused' })
    expect(mounts).toHaveLength(1)
    // And the row keeps its button, so the user can try again after a restart.
    expect((await readConnectorTarget(host)).installed[0]?.needsAuthorization).toBe(true)
  })

  /** Drop the grant without touching the record, as a revoke would. */
  async function uninstallGrantOnly(host: Host): Promise<void> {
    await (host as unknown as {
      credentials: { deleteRecord: (key: string) => Promise<void> }
    }).credentials.deleteRecord('unused')
  }
})

/**
 * One record whose token is a reference rather than a value.
 *
 * The slug varies per case because the live-mount table is process-wide (one
 * plugin instance per process in production) and a restore skips a slug it
 * already mounted — two cases sharing a slug would make the second a no-op.
 */
function pointing(slug: string): string {
  return JSON.stringify([{
    slug,
    serverName: slug.replace(/-.*/, ''),
    name: 'Search',
    connectedAt: '2026-08-24T00:00:00.000Z',
    config: { serverName: slug.replace(/-.*/, ''), transport: 'stdio', command: 'npx' },
    secret: { site: 'env', key: 'SEARCH_API_KEY', ref: `OPENLUX_MCP_${slug.toUpperCase().replace(/-/g, '_')}` },
  }])
}

/**
 * A context whose loader records what it mounted, and a credential seam.
 * @param secrets - the seam's contents, read and written in place.
 * @param onCreate - called before recording, to make a mount fail.
 * @returns the context, the configs it was asked to mount, and what it removed.
 */
function withRecordingLoader(secrets: Map<string, string>, onCreate?: () => void): {
  ctx: Host
  mounts: Record<string, unknown>[]
  removed: string[]
} {
  const mounts: Record<string, unknown>[] = []
  const removed: string[] = []
  const loader = {
    store: {},
    create: async (options: Record<string, unknown>) => {
      onCreate?.()
      mounts.push(options.config as Record<string, unknown>)
      return String(options.id)
    },
    remove: async (id: string) => { removed.push(id) },
  }
  return {
    mounts,
    removed,
    ctx: {
      logger: { info: () => {}, warn: () => {} },
      get: (name: string) => name === 'loader' ? loader : undefined,
      credentials: {
        set: async (ref: unknown, value: string) => { secrets.set(String(ref), value) },
        unset: async (ref: unknown) => { secrets.delete(String(ref)) },
        resolve: async (ref: unknown) => {
          const value = secrets.get(String(ref))
          return value === undefined ? undefined : { value, source: 'file' }
        },
      },
    } as unknown as Host,
  }
}
