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
  buildConfig, customPath, readConnectorTarget, recordPath, restoreConnectors,
  syncCustomConnectors, uninstallConnector,
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
    // The kernel ran the whole OAuth flow; the bridge takes static values only,
    // so connecting would produce a server that 401s on every call.
    expect(buildConfig(manifest({ url: 'https://example.test/mcp' }, { mode: 'oauth' }), 'x'))
      .toMatchObject({ kind: 'refused', reason: 'unsupported-auth' })
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
