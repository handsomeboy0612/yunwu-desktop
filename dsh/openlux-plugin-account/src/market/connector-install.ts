/**
 * Connectors: one MCP server per loader entry, mounted at runtime.
 *
 * ## Why the loader, and not a config file
 *
 * The kernel's own answer to "add an MCP server" is a plugin entry — one
 * `@deepseek-ai/dsh-mcp-client` instance per server, which is the first example
 * in its README. There is no `mcp set` equivalent, no `mcp reload`, and no
 * browser half; upstream left that out deliberately
 * (`docs/dsh-kernel-migration.md`, «连接器：能力有、界面无»).
 *
 * That section also concluded «装完要重启才生效», and **that is now wrong** — it
 * was measured on the only path tried at the time, writing the profile's patch
 * file, which is not watched. The loader's own runtime API is not that path.
 * Measured on this machine 2026-08-24:
 *
 * | Step | Result |
 * |---|---|
 * | `loader.create` with a local stdio server | server spawned in **264 ms**, `initialize from dsh-mcp-client` + `tools/list` in its log, no restart |
 * | model reach | 20 s later, in an **already-open** session, the model called `mcp__ywprobe__ping` and got the passphrase back |
 * | `loader.remove` | 26 ms, child process exited (`stdin ended`) |
 * | a real `npx` connector (`@upstash/context7-mcp`) | mounted in 12.7 s, process alive — so Windows resolves `npx` through the bridge's spawn |
 *
 * ## Why the durable record is ours and not the patch layer
 *
 * `loader.create` persists too, but into `<profile>/cordis.yml`, which the
 * launcher rewrites to `[]` on every boot
 * (`dsh-plugin-desktop/src/profile.ts:627`) — so it is not durable. The
 * profile's `cordis.patch.yml` **is** read at boot (verified: an `insert` patch
 * there spawned the probe during startup), but writing it means round-tripping a
 * file the user owns, whose header invites hand edits and `!!js` expressions;
 * a YAML dumper would silently eat both, and a connector's secret would land in
 * the file people paste into bug reports.
 *
 * So the record is a file of ours, and there is exactly one mount path — the
 * verified one — used both for a fresh connect and for {@link restoreConnectors}
 * at startup.
 *
 * ## Where the token lives, and why not here
 *
 * The record holds no secret. A connector's token goes into the kernel's
 * credential seam under `OPENLUX_MCP_<SLUG>`, the same store this plugin
 * already keeps the session and the api key in (`account/session.ts`), and the
 * record keeps only the reference name plus which field the value belongs in.
 *
 * The bridge itself takes plain `env` / `headers` strings — it has no
 * `CredentialRef` the way the llm adapters do (`dsh-mcp-client` Config) — so
 * the value is resolved per mount and spliced in, never written down by us. It
 * is not written down by the loader either: `create` persists into
 * `<profile>/cordis.yml`, and after connecting a token-bearing connector on
 * this machine that file was still `[]`, with the secret findable in exactly
 * one place on disk (measured 2026-08-24 by searching the whole home for the
 * token). Moving it to the seam takes that one place down to zero, and puts it
 * where the kernel's own credential surface can see and rotate it.
 *
 * @module openlux-plugin-account/market/connector-install
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { causeChain } from '../error-cause.ts'
import { ConsoleError, readConnectorManifest, type ConsoleAccess } from './console.ts'
import type { ConnectorManifest } from './console.ts'
import {
  forgetConnectorGrant, hasConnectorGrant, readAuthorizationState, readConnectorToken,
  startConnectorAuthorization,
} from './connector-oauth.ts'
import type { ConnectorAuthorizationStart, ConnectorAuthorizationState } from './wire.ts'
import type {
  ConnectorRequest, ConnectorRequirement, ConnectorTarget, CustomOpen, InstallOutcome,
  InstalledConnector, RefusalReason,
} from './wire.ts'

/** The package that bridges one MCP server into the kernel's tool registry. */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** Loader entry id prefix, so our rows are recognizable in a dumped tree. */
export const CONNECTOR_ENTRY_PREFIX = 'openlux-connector-'

/** Server names the bridge accepts; anything else fails the plugin at load. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

/** Catalog slugs we will look up; the same alphabet the other partitions use. */
const CONNECTOR_SLUG = /^[a-z0-9][a-z0-9-]*$/

/**
 * Where connected connectors are remembered.
 *
 * Under the harness home rather than beside the profile: it survives a profile
 * being recomposed, and it is the same home every other thing we own lives in.
 */
const RECORD_FILE = 'openlux-connectors.json'

/** Where in a bridge config one secret belongs. */
interface SecretSite {
  /** `env` for a local process, `headers` for an http endpoint. */
  readonly site: 'env' | 'headers'
  /** The field name inside that map, from the manifest's `auth.key`. */
  readonly key: string
}

/**
 * Where a granted token belongs, and how it is spelled.
 *
 * Carries the prefix a pasted secret's site does not need: a static token is
 * stored with the prefix already on it, while a granted one is re-fetched and
 * re-spelled on every mount, so `Bearer ` has to survive in the record.
 */
interface GrantSite extends SecretSite {
  readonly prefix: string
}

/** What one connected connector needs to be re-mounted next launch. */
interface ConnectorRecord {
  readonly slug: string
  readonly serverName: string
  readonly name: string
  readonly version?: string
  readonly connectedAt: string
  /**
   * The bridge config, resolved but with the secret taken out.
   *
   * Stored resolved rather than as "manifest + secret" so a launch needs no
   * network and no console token: a connector the user connected keeps working
   * while they are signed out, which is what the old shell did by writing the
   * server object into the kernel's own config.
   */
  readonly config: Record<string, unknown>
  /** Where the token was, and what to ask the credential seam for. */
  readonly secret?: SecretSite & { readonly ref: string }
  /**
   * Where the bearer token goes for a connector signed in to over the web.
   *
   * Separate from `secret` because the two differ in who owns the value, not
   * just in where it sits: a pasted token is a string this module wrote to a
   * `CredentialRef` and reads back unchanged, while a grant is written by the
   * authorization flow, expires, and is rotated on the mount path. Only the
   * placement is recorded here; the value is looked up per mount by slug.
   */
  readonly oauth?: GrantSite
}

/** The bridge config for one server, in the shape `dsh-mcp-client` takes. */
type BridgeConfig = Record<string, unknown>

/**
 * The loader's runtime tree, structurally.
 *
 * Typed here rather than imported because this plugin resolves outside the
 * kernel's dependency tree, where `@deepseek-ai/cordis-plugin-loader` is not
 * guaranteed to resolve at runtime. The shape is from its own source
 * (`src/config/tree.ts`: `create`, `remove`, `store`).
 */
interface LoaderLike {
  create?: (options: Record<string, unknown>, parent?: string | null, position?: number) => Promise<string>
  remove?: (id: string) => Promise<void>
  store?: Record<string, unknown>
}

/** Live mount state, keyed by slug, for the current process only. */
const mounted = new Map<string, {
  readonly entryId: string
  readonly failure?: string
  /** Set when the failure is a dead sign-in, which the user can fix in place. */
  readonly needsAuthorization?: boolean
}>()

/**
 * Read what is connected.
 *
 * `live` is per-process state rather than a re-read of the loader, because a
 * connector that failed to mount this launch is still connected as far as the
 * user is concerned — the row must stay visible with its reason, or the only way
 * to get rid of it would be to edit a file.
 * @param ctx - host context, for the loader probe.
 * @returns whether anything can be mounted, and what is connected.
 */
export async function readConnectorTarget(ctx: Context): Promise<ConnectorTarget> {
  const records = await readRecords()
  return {
    mountable: typeof loaderOf(ctx)?.create === 'function',
    // The user's own servers are not rows — they are managed in their file, the
    // way WorkBuddy's are — so all the gallery needs is how many are up.
    custom: [...mounted].filter(([slug, state]) =>
      slug.startsWith(CUSTOM_SLUG_PREFIX) && state.failure === undefined).length,
    installed: records.map(record => {
      const state = mounted.get(record.slug)
      return {
        slug: record.slug,
        serverName: record.serverName,
        name: record.name,
        ...record.version === undefined ? {} : { version: record.version },
        connectedAt: record.connectedAt,
        live: state !== undefined && state.failure === undefined,
        ...state?.failure === undefined ? {} : { failure: state.failure },
        ...state?.needsAuthorization === true ? { needsAuthorization: true } : {},
        // What this actually runs, for the rows the catalog has no entry for:
        // a pasted connector, or a shelf item the console has since dropped.
        // Without it such a row could only say its own name.
        summary: summarize(record.config),
      } satisfies InstalledConnector
    }),
  }
}

/**
 * Read what one connector will ask of the user before it can connect.
 *
 * Its own call because the manifest is per-item and the shelf is not: asking
 * for all of them would be one request per row for a question most rows answer
 * with "nothing".
 * @param ctx - host context.
 * @param access - console origin and token reader.
 * @param slug - the connector.
 * @param signal - caller cancellation.
 * @returns the mode, the field label, or why it cannot be connected.
 */
export async function readConnectorRequirement(
  ctx: Context,
  access: ConsoleAccess,
  slug: string,
  signal?: AbortSignal,
): Promise<ConnectorRequirement> {
  if (!CONNECTOR_SLUG.test(slug)) {
    return { slug, mode: 'none', refusal: `连接器标识 ${JSON.stringify(slug)} 不合法。` }
  }
  let manifest: ConnectorManifest
  try {
    manifest = await readConnectorManifest(ctx, access, slug, signal)
  } catch (error: unknown) {
    return {
      slug,
      mode: 'none',
      refusal: error instanceof ConsoleError ? error.message : String(error),
    }
  }
  const mode = modeOf(manifest)
  const label = text(manifest.auth?.label)
  // Built with a stand-in secret, so "this one needs a token" comes back as the
  // mode rather than as a refusal — the point of this call is to find out what
  // to ask the user, and every other refusal is one asking cannot fix.
  const built = buildConfig(manifest, REQUIREMENT_PROBE_TOKEN)
  return {
    slug,
    mode,
    ...label === undefined ? {} : { label },
    // Only asked for the mode that can be in that state, so a token connector's
    // row does not carry a field that reads as "not signed in".
    ...mode === 'oauth' ? { authorized: await hasConnectorGrant(ctx, slug) } : {},
    ...built.kind === 'refused' ? { refusal: built.message } : {},
  }
}

/** A stand-in secret, so a token connector's config can be built for a dry run. */
const REQUIREMENT_PROBE_TOKEN = 'probe'

/**
 * Start one connector's web sign-in.
 *
 * The endpoint comes from the manifest read here rather than from the request,
 * for the same reason the install path resolves its own download link: a main
 * process that opens a browser at a URL a renderer handed it is one XSS away
 * from being a phishing launcher.
 * @param ctx - host context.
 * @param access - console origin and token reader.
 * @param slug - the connector.
 * @param signal - caller cancellation.
 * @returns the page to open, or why nothing was started.
 */
export async function authorizeConnector(
  ctx: Context,
  access: ConsoleAccess,
  slug: string,
  signal?: AbortSignal,
): Promise<ConnectorAuthorizationStart> {
  if (!CONNECTOR_SLUG.test(slug)) {
    return { kind: 'refused', message: `连接器标识 ${JSON.stringify(slug)} 不合法。` }
  }
  let manifest: ConnectorManifest
  try {
    manifest = await readConnectorManifest(ctx, access, slug, signal)
  } catch (error: unknown) {
    return { kind: 'refused', message: error instanceof ConsoleError ? error.message : String(error) }
  }
  const url = text(manifest.server?.url)
  if (url === undefined) {
    return { kind: 'refused', message: '这个连接器不是远端服务器，没有可以授权的地址。' }
  }
  // The MCP namespace is the label: the seam's roster is keyed by credential,
  // and this is the name the same connector's tools already carry in a session.
  return await startConnectorAuthorization(ctx, slug, text(manifest.mcpName) ?? slug, url)
}

/**
 * How one connector's sign-in ended.
 * @param slug - the connector.
 * @returns the state the gallery polls for.
 */
export function connectorAuthorizationState(slug: string): ConnectorAuthorizationState {
  return readAuthorizationState(slug)
}

/**
 * Connect one connector: read its manifest, mount it, remember it.
 * @param ctx - host context.
 * @param access - console origin and token reader.
 * @param request - what the gallery asked for, token included when it has one.
 * @param signal - caller cancellation.
 * @returns the outcome; every refusal here is an ordinary answer.
 */
export async function installConnector(
  ctx: Context,
  access: ConsoleAccess,
  request: ConnectorRequest,
  signal?: AbortSignal,
): Promise<InstallOutcome> {
  const slug = request.slug.trim()
  if (!CONNECTOR_SLUG.test(slug)) {
    return refuse('invalid-id', `连接器标识 ${JSON.stringify(slug)} 不合法。`)
  }
  const records = await readRecords()
  if (records.some(record => record.slug === slug)) {
    return refuse('already-installed', `已经连上 ${slug} 了。要重连请先断开。`)
  }
  if (typeof loaderOf(ctx)?.create !== 'function') {
    return refuse('not-mountable', '当前部署没有可写的插件树，无法连接连接器。')
  }

  let manifest: ConnectorManifest
  try {
    manifest = await readConnectorManifest(ctx, access, slug, signal)
  } catch (error: unknown) {
    if (error instanceof ConsoleError) return refuse('bad-manifest', error.message)
    throw error
  }

  // A signed-in connector's token is never in the request: the renderer never
  // sees it, because the flow committed it to the credential seam and the slug
  // is the whole address.
  const token = modeOf(manifest) === 'oauth' ? await readConnectorToken(ctx, slug) : request.token
  const built = buildConfig(manifest, token)
  if (built.kind === 'refused') return refuse(built.reason, built.message)
  return await land(ctx, records, slug, built, {
    ...request.name === undefined ? {} : { name: request.name },
    ...request.version === undefined ? {} : { version: request.version },
  })
}

/**
 * Mount one built connector and write it down.
 *
 * The tail both connect paths share, in this order for one reason: a server
 * that cannot come up must leave nothing behind, so nothing is stored until it
 * is live, and anything stored is rolled back if a later step fails.
 * @param ctx - host context.
 * @param records - what was already connected, read once by the caller.
 * @param slug - the row's identity, which also names its credential.
 * @param built - the config to mount.
 * @param meta - display name and version for the row.
 * @returns the outcome.
 */
async function land(
  ctx: Context,
  records: readonly ConnectorRecord[],
  slug: string,
  built: Extract<BuildOutcome, { kind: 'built' }>,
  meta: { readonly name?: string; readonly version?: string },
): Promise<InstallOutcome> {
  // Two servers under one namespace fail the later plugin instance at load
  // (`dsh-mcp-client` README), and the namespace is what the model's tool names
  // are built from — so a collision is refused here rather than surfaced as a
  // plugin that activated with no tools.
  if (records.some(row => row.serverName === built.serverName)) {
    return refuse('already-installed',
      `已经有一个连接器占用了 MCP 名字 ${built.serverName}，两个同名连接器不能同时连上。`)
  }

  const mount = await mountEntry(ctx, built.serverName, built.config)
  if (mount.kind === 'refused') return refuse('not-mountable', mount.message)

  const kept = built.secret === undefined
    ? undefined
    : await keepSecret(ctx, slug, built.config, built.secret)
  if (kept !== undefined && kept.kind === 'refused') {
    await unmountEntry(ctx, mount.entryId)
    return refuse(kept.reason, kept.message)
  }

  // Whichever kind of value was placed comes back out before the config is
  // written down. The grant's owner is the authorization flow, so unlike a
  // pasted secret there is nothing to move — only the placement is recorded.
  const placed = built.secret ?? built.oauth
  const row: ConnectorRecord = {
    slug,
    serverName: built.serverName,
    name: text(meta.name) ?? slug,
    ...text(meta.version) === undefined ? {} : { version: text(meta.version)! },
    connectedAt: new Date().toISOString(),
    config: placed === undefined ? built.config : without(built.config, placed),
    ...built.secret === undefined ? {} : { secret: { ...built.secret, ref: refNameFor(slug) } },
    ...built.oauth === undefined ? {} : { oauth: built.oauth },
  }
  try {
    await writeRecords([...records, row])
  } catch (error: unknown) {
    // The record is what makes a connect outlive this launch and what makes
    // disconnect possible; a live server nobody remembers is worse than none.
    await unmountEntry(ctx, mount.entryId)
    mounted.delete(slug)
    await forgetSecret(ctx, row)
    return refuse('write-failed', error instanceof Error ? error.message : String(error))
  }
  mounted.set(slug, { entryId: mount.entryId })
  ctx.logger.info(`openlux: connector ${slug} connected as ${built.serverName}`)
  return { kind: 'installed', id: built.serverName, path: `mcp__${built.serverName}__*` }
}

/**
 * Disconnect one connector: unmount it and forget it.
 * @param ctx - host context.
 * @param slug - the catalog slug, from the installed list.
 * @returns whether there was something to disconnect.
 */
export async function uninstallConnector(ctx: Context, slug: string): Promise<boolean> {
  const records = await readRecords()
  const found = records.find(record => record.slug === slug)
  if (found === undefined) return false
  const state = mounted.get(slug)
  if (state !== undefined) await unmountEntry(ctx, state.entryId)
  mounted.delete(slug)
  // The record goes even when the unmount failed, the old shell's rule: a row
  // the user cannot get rid of is a worse outcome than a server that lingers
  // until the next launch, and the next launch will not bring it back.
  await writeRecords(records.filter(record => record.slug !== slug))
  // The token goes with it. WorkBuddy keeps it for a re-connect and deletes it
  // on a separate «解绑», but that second button does not exist here — and a
  // secret nothing can show or delete is worse than one retype.
  await forgetSecret(ctx, found)
  // Same reasoning for a grant, with one difference worth knowing: this forgets
  // the local record only. The seam has no revoke, so the session on the
  // provider's side outlives it and a re-connect may not ask again.
  if (found.oauth !== undefined) await forgetConnectorGrant(ctx, slug)
  ctx.logger.info(`openlux: connector ${slug} disconnected`)
  return true
}

/**
 * Where a user's own MCP servers go.
 *
 * ## Why a file the user edits, and not a form
 *
 * WorkBuddy's «自定义连接器» is one button that opens the MCP config file in
 * the editor it is hosted inside (`adapter.openMcpConfig` → a VS Code command),
 * and its own panel shows no card for what is in there. So the shape being
 * matched is «编辑自己的配置文件», not «填一张表».
 *
 * It is also the only shape that keeps a property the shelf path has: the
 * renderer never names a command to spawn. A paste box would hand
 * `{ command, args }` from the browser half to the main process, which is the
 * same sink as a renderer naming a URL for the host to fetch — and this
 * renderer displays model output. Here the browser half can ask for exactly two
 * things, «open my file» and «re-read it», and the bytes come off disk.
 *
 * The format is the one MCP servers publish in their own READMEs, which is also
 * Claude Desktop's and Cursor's, so a config can be pasted in unchanged.
 * Secrets in it are the user's own, in their own file, by their own hand — this
 * module does not copy them anywhere.
 */
const CUSTOM_FILE = 'openlux-connectors.custom.json'

/** The template a first open writes, so the file explains itself. */
const CUSTOM_TEMPLATE = `{
  "mcpServers": {
  }
}
`

/** Where the user's own connector file lives. */
export function customPath(): string {
  return dshHomePath(CUSTOM_FILE)
}

/** What one re-read of the user's file did. */
export interface CustomSync {
  /** How many of the user's servers are live now. */
  readonly live: number
  /** One line per server that would not start, or per parse failure. */
  readonly problems: readonly string[]
  /** The file, so the dialog can show it even when nothing parsed. */
  readonly path: string
}

/**
 * Mount what the user's own file asks for, and drop what it no longer asks for.
 *
 * Idempotent, because it runs both at startup and on demand: a server already
 * mounted under the same namespace is left alone rather than restarted, which
 * is what makes «重新读取» safe to press twice.
 * @param ctx - host context.
 * @returns what is live and what would not start.
 */
export async function syncCustomConnectors(ctx: Context): Promise<CustomSync> {
  const path = customPath()
  const parsed = await readCustomFile(path)
  if (parsed.kind === 'unreadable') return { live: 0, problems: [parsed.message], path }

  const wanted = new Map(parsed.servers.map(row => [row.serverName, row] as const))
  // Gone from the file means gone from the process: the file is the whole truth
  // for these, so leaving one mounted would make deleting a server impossible.
  for (const [slug, state] of [...mounted]) {
    if (!slug.startsWith(CUSTOM_SLUG_PREFIX)) continue
    const serverName = slug.slice(CUSTOM_SLUG_PREFIX.length)
    if (wanted.has(serverName)) continue
    await unmountEntry(ctx, state.entryId)
    mounted.delete(slug)
  }

  const problems: string[] = []
  let live = 0
  for (const row of parsed.servers) {
    const slug = `${CUSTOM_SLUG_PREFIX}${row.serverName}`
    const already = mounted.get(slug)
    if (already !== undefined && already.failure === undefined) {
      live += 1
      continue
    }
    const built = buildConfig({ mcpName: row.serverName, server: row.server })
    if (built.kind === 'refused') {
      problems.push(`${row.serverName}：${built.message}`)
      continue
    }
    const mount = await mountEntry(ctx, built.serverName, built.config)
    if (mount.kind === 'refused') {
      mounted.set(slug, { entryId: entryIdFor(built.serverName), failure: mount.message })
      // The config is a loose record on purpose (the bridge validates it), so
      // the transport is read back rather than carried in the type. The bridge's
      // remote transport is spelled `streamable-http`, so the local one is what
      // gets matched on.
      const transport = built.config.transport === 'stdio' ? 'stdio' : 'http'
      problems.push(`${row.serverName}：${explain(mount.message, transport)}`)
      continue
    }
    mounted.set(slug, { entryId: mount.entryId })
    live += 1
  }
  ctx.logger.info(`openlux: custom connectors, ${live} live, ${problems.length} not`)
  return { live, problems, path }
}

/** Slug prefix for the user's own servers, keeping them out of the shelf's space. */
const CUSTOM_SLUG_PREFIX = 'custom:'

/**
 * Say why a server would not start, to someone who wrote the config by hand.
 *
 * The bridge's own sentence for the common case names our loader entry id and
 * the bridge package — neither of which the person editing a JSON file has any
 * use for — and ends in English. That one case gets our words and a next step,
 * which differs by transport: telling the owner of a `url` entry to run its
 * command in a terminal would send them looking for a command that does not
 * exist. Anything else passes through verbatim, because an unrecognised message
 * is the only clue there is and paraphrasing it would lose the clue.
 * @param message - what the mount refused with.
 * @param transport - how that server was going to be reached.
 * @returns a line for the panel.
 */
function explain(message: string, transport: 'stdio' | 'http'): string {
  if (!/initial connection or tool synchronization failed/.test(message)) return message
  return transport === 'http'
    ? '连不上。确认这个 url 在浏览器里能开，以及它要的令牌是不是得写在 headers 里。'
    : '起不来。先在终端里直接跑一遍它的 command 和 args，确认命令存在、参数对、需要的环境变量都给了。'
}

/** Shape of the electron surface this module needs, so the cast stays honest. */
interface Shell {
  readonly shell?: {
    readonly openPath?: (target: string) => Promise<string>
    readonly showItemInFolder?: (target: string) => void
  }
}

/**
 * Make sure the user's file exists, and hand it to the OS.
 *
 * `electron` is imported here rather than at module scope because this plugin
 * also builds for environments that have none; a deployment without it gets the
 * path back and the dialog shows it to copy.
 *
 * Opening can fail for a reason that is nobody's mistake: plenty of Windows
 * installs have no application associated with `.json` at all — this one does
 * not, which is how the fallback got written — and `openPath` then returns its
 * complaint as a string rather than throwing. Revealing the file in its folder
 * needs no association, so it is tried next; the caller gets which of the three
 * things happened, because «打开» and «已经指给你了» are different sentences.
 * @param ctx - host context, for the log.
 * @returns the path, and what the OS did with it.
 */
export async function openCustomFile(ctx: Context): Promise<CustomOpen> {
  const path = customPath()
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, CUSTOM_TEMPLATE, { encoding: 'utf8', flag: 'wx' })
  } catch {
    // Already there, which is the common case; a real write failure surfaces
    // as the open failing right below.
  }
  try {
    const electron = await import('electron') as Shell
    const failure = await electron.shell?.openPath?.(path)
    if (failure === '') return { path, did: 'opened' }
    ctx.logger.warn(`openlux: the OS would not open ${path}: ${failure ?? 'no electron shell'}`)
    if (electron.shell?.showItemInFolder === undefined) return { path, did: 'nothing' }
    electron.shell.showItemInFolder(path)
    return { path, did: 'revealed' }
  } catch (error: unknown) {
    ctx.logger.warn(`openlux: could not open ${path}: ${
      error instanceof Error ? error.message : String(error)}`)
    return { path, did: 'nothing' }
  }
}

/** What reading the user's file produced. */
type CustomFile =
  | { readonly kind: 'read'; readonly servers: readonly { serverName: string; server: Record<string, unknown> }[] }
  | { readonly kind: 'unreadable'; readonly message: string }

/**
 * Read the user's own connector file.
 *
 * An absent file is an empty one, not a fault: it is created on first open and
 * a user who never opened it has no custom servers. A malformed one is a fault
 * with its parser message intact, because that message is the only thing that
 * makes a typo findable.
 * @param path - the file.
 * @returns the servers, or why they could not be read.
 */
async function readCustomFile(path: string): Promise<CustomFile> {
  let body: string
  try {
    body = await readFile(path, 'utf8')
  } catch {
    return { kind: 'read', servers: [] }
  }
  if (body.trim() === '') return { kind: 'read', servers: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error: unknown) {
    return {
      kind: 'unreadable',
      message: `配置文件不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'unreadable', message: '配置文件的最外层要是一个对象。' }
  }
  // `mcpServers` is what every README, Claude Desktop and Cursor use; `servers`
  // is accepted too because the kernel's own docs spell it that way, and a user
  // copying from either has no reason to know which one we wanted.
  const outer = parsed as Record<string, unknown>
  const wrapper = outer.mcpServers ?? outer.servers
  if (typeof wrapper !== 'object' || wrapper === null || Array.isArray(wrapper)) {
    return { kind: 'unreadable', message: '配置文件里要有一个 mcpServers 对象。' }
  }
  const servers: { serverName: string; server: Record<string, unknown> }[] = []
  for (const [serverName, server] of Object.entries(wrapper as Record<string, unknown>)) {
    if (typeof server !== 'object' || server === null || Array.isArray(server)) continue
    servers.push({ serverName, server: server as Record<string, unknown> })
  }
  return { kind: 'read', servers }
}

/**
 * Mount everything already connected, once, at startup.
 *
 * Failures are recorded rather than thrown: one connector whose command is
 * gone must not stop the others, and the row has to stay visible with its
 * reason so the user can disconnect it.
 * @param ctx - host context.
 * @returns how many mounted and how many did not.
 */
export async function restoreConnectors(ctx: Context): Promise<{ mounted: number; failed: number }> {
  const records = await readRecords()
  if (records.length === 0) return { mounted: 0, failed: 0 }
  let ok = 0
  let failed = 0
  for (const record of records) {
    if (mounted.has(record.slug)) continue
    const outcome = await bring(ctx, record)
    if (outcome.kind === 'mounted') {
      ok += 1
      continue
    }
    failed += 1
    ctx.logger.warn(`openlux: connector ${record.slug} did not come up: ${outcome.message}`)
  }
  ctx.logger.info(`openlux: connectors restored, ${ok} live, ${failed} failed`)
  return { mounted: ok, failed }
}

/**
 * Resolve one record's credentials, mount it, and record how that went.
 *
 * The step startup and the repair button share, so a row repaired by hand ends
 * in exactly the state the next launch would have put it in — including the
 * `needsAuthorization` flag, which is what keeps the button on screen when the
 * sign-in is still dead.
 * @param ctx - host context.
 * @param record - the stored row to bring up.
 * @returns whether it is live, and why not when it is not.
 */
async function bring(
  ctx: Context,
  record: ConnectorRecord,
): Promise<{ kind: 'mounted' } | { kind: 'refused'; message: string }> {
  const config = await hydrate(ctx, record)
  if (config.kind === 'missing') {
    mounted.set(record.slug, {
      entryId: entryIdFor(record.serverName),
      failure: config.message,
      ...config.reauthorize === true ? { needsAuthorization: true } : {},
    })
    return { kind: 'refused', message: config.message }
  }
  const outcome = await mountEntry(ctx, record.serverName, config.config)
  if (outcome.kind === 'mounted') {
    mounted.set(record.slug, { entryId: outcome.entryId })
    return { kind: 'mounted' }
  }
  mounted.set(record.slug, {
    entryId: entryIdFor(record.serverName),
    failure: outcome.message,
    // A grant this side still believes in can already have been revoked on the
    // provider's, and then the refusal arrives here rather than as a missing
    // token. Only asked of a connector that has a sign-in to redo.
    ...record.oauth !== undefined && looksUnauthorized(outcome.message, record.serverName)
      ? { needsAuthorization: true }
      : {},
  })
  return { kind: 'refused', message: outcome.message }
}

/**
 * Whether a mount refusal reads as a rejected sign-in.
 *
 * The same rule the product we are aligned with applies to its own MCP rows —
 * `server.needsAuth || error.includes("401") || error.toLowerCase().includes("auth")`
 * (WorkBuddy `renderer/assets/connector-*.js`) — minus the first term, which is
 * a field its bridge reports and ours does not. Matching on text is coarse by
 * nature, and deliberately biased towards offering the button: the cost of a
 * false positive is one sign-in the user did not need, while a false negative
 * leaves them with a connector and no way to fix it.
 *
 * Give it {@link causeChain}, never a bare `error.message`: on the real path
 * the number reaches this function only because that walker appends `.code`.
 * @param message - the refusal, cause chain included.
 * @param serverName - whose refusal it is, taken out before matching.
 * @returns true when it names an authorization problem.
 */
export function looksUnauthorized(message: string, serverName: string): boolean {
  // The name is inside the sentence being matched — the client's wrapper reads
  // `mcp-client(<serverName>): …` — and identity products are called things
  // like `authing`, so leaving it in would put the button on every failure a
  // connector so named ever has, down to the endpoint being unreachable.
  const named = serverName === '' ? message : message.split(serverName).join(' ')
  const lower = named.toLowerCase()
  return lower.includes('401') || lower.includes('auth')
}

/**
 * Bring one already-connected connector back up, after a repaired sign-in.
 *
 * A separate call from `installConnector`, which refuses a slug it already has
 * a record for (`已经连上 … 了。要重连请先断开。`) — correct for a press on the
 * shelf, wrong for a row that is connected and only needs its token replaced.
 * Disconnecting first would have worked, but a cancelled sign-in would then
 * leave the user with no connector at all rather than the one they started
 * with.
 *
 * The old entry is dropped before the new one is made because `mountEntry`
 * adopts a live entry under the same id, and adopting is exactly wrong here:
 * the entry it would adopt is the one holding the token that just expired.
 * @param ctx - host context.
 * @param slug - the connector to bring back up.
 * @returns whether it is live, and why not when it is not.
 */
export async function remountConnector(
  ctx: Context,
  slug: string,
): Promise<{ kind: 'mounted' } | { kind: 'refused'; message: string }> {
  const records = await readRecords()
  const found = records.find(record => record.slug === slug)
  if (found === undefined) return { kind: 'refused', message: `还没有连上 ${slug}。` }
  const state = mounted.get(slug)
  if (state !== undefined) await unmountEntry(ctx, state.entryId)
  mounted.delete(slug)
  // The store, not the unmount's own answer: a row that never mounted has no
  // entry to remove and reports failure for that reason alone, while an entry
  // that survived a successful-looking removal is the one case that must not
  // continue — `mountEntry` would adopt it and report a repair that changed
  // nothing.
  const entryId = entryIdFor(found.serverName)
  if (loaderOf(ctx)?.store?.[entryId] !== undefined) {
    mounted.set(slug, { entryId, failure: '旧的连接没能撤下来。', needsAuthorization: true })
    return { kind: 'refused', message: '旧的连接没能撤下来，重启应用之后再试一次。' }
  }
  const outcome = await bring(ctx, found)
  if (outcome.kind === 'mounted') ctx.logger.info(`openlux: connector ${slug} remounted`)
  else ctx.logger.warn(`openlux: connector ${slug} did not remount: ${outcome.message}`)
  return outcome
}

/** What building a bridge config from a manifest ended in. */
type BuildOutcome =
  | {
    readonly kind: 'built'
    readonly serverName: string
    readonly config: BridgeConfig
    /** Present when a token was placed, so the caller can lift it back out. */
    readonly secret?: SecretSite
    /** Present when the value placed came from a web sign-in rather than a paste. */
    readonly oauth?: GrantSite
  }
  | { readonly kind: 'refused'; readonly reason: RefusalReason; readonly message: string }

/**
 * Turn one manifest into the bridge's config.
 *
 * The manifest's `server` object was written for `openclaw mcp set`, so the
 * transport is implied by its shape — `url` means http, otherwise stdio — the
 * same inference the old shell made when deciding where to inject a token
 * (`connector-installer.ts:85`). Everything else is copied field by field
 * rather than spread, because the bridge validates its config and an unknown
 * key from a hand-written admin form would fail the whole entry.
 *
 * `failOnStartupError` is ours rather than the manifest's, and it is on. The
 * bridge defaults it to false, which means a server that never connects still
 * activates — with no tools, and no reconnect, because the supervisor only
 * covers connections that were once up (its README's Behavior section). For a
 * background integration that default is defensible; for a button labelled
 * «连接» it is not, because the word would be a lie and nothing would ever say
 * so. With it on, a fresh connect refuses out loud and writes no record, and a
 * restore marks the row as not-connected with the reason on it.
 *
 * @param manifest - the console's row.
 * @param token - the user's secret, when they supplied one.
 * @returns the config, or the reason this connector cannot be built.
 */
export function buildConfig(manifest: ConnectorManifest, token?: string): BuildOutcome {
  const serverName = manifest.mcpName.trim()
  if (!SERVER_NAME.test(serverName)) {
    return {
      kind: 'refused',
      reason: 'bad-manifest',
      message: `MCP 名字 ${JSON.stringify(serverName)} 不符合命名规则（字母、数字、下划线、连字符，1~32 位）。`,
    }
  }
  const server = manifest.server
  const url = text(server.url)
  const command = text(server.command)
  const mode = modeOf(manifest)
  // A web sign-in produces a bearer token for an endpoint, so a manifest that
  // declares one for a local process describes something that cannot exist:
  // there is no request to put the header on.
  if (mode === 'oauth' && url === undefined) {
    return {
      kind: 'refused',
      reason: 'unsupported-auth',
      message: '这个连接器声明了网页授权，但它跑在本地进程上，授权拿到的令牌无处可放。',
    }
  }
  if (mode === 'token' && (token === undefined || token.trim() === '')) {
    return { kind: 'refused', reason: 'needs-token', message: '这个连接器需要一个令牌才能连接。' }
  }
  if (mode === 'oauth' && (token === undefined || token.trim() === '')) {
    return { kind: 'refused', reason: 'needs-authorization', message: '这个连接器要先在浏览器里授权一次。' }
  }

  if (url !== undefined) {
    const declared = text(server.transport)
    // `sse` was a legitimate openclaw transport and is not one here: the bridge
    // takes `stdio` or `streamable-http` only (its Config table). Silently
    // upgrading it would connect to an endpoint that speaks another protocol.
    if (declared !== undefined && declared !== 'streamable-http' && declared !== 'http') {
      return {
        kind: 'refused',
        reason: 'unsupported-transport',
        message: `这个连接器用的是 ${declared} 传输，当前内核只支持 stdio 与 streamable-http。`,
      }
    }
    const headers = { ...record(server.headers) }
    let secret: SecretSite | undefined
    let oauth: GrantSite | undefined
    if (mode === 'token') {
      const placed = inject(headers, manifest, token ?? '')
      if ('kind' in placed) return placed
      secret = { site: 'headers', key: placed.key }
    }
    if (mode === 'oauth') {
      oauth = placeBearer(headers, manifest, token ?? '')
    }
    return {
      kind: 'built',
      serverName,
      config: {
        serverName,
        transport: 'streamable-http',
        url,
        ...Object.keys(headers).length === 0 ? {} : { headers },
        failOnStartupError: true,
      },
      ...secret === undefined ? {} : { secret },
      ...oauth === undefined ? {} : { oauth },
    }
  }

  if (command === undefined) {
    return {
      kind: 'refused',
      reason: 'bad-manifest',
      message: '这个连接器的配置里既没有 command（本地进程）也没有 url（远端服务）。',
    }
  }
  const env = { ...record(server.env) }
  let secret: SecretSite | undefined
  if (mode === 'token') {
    const placed = inject(env, manifest, token ?? '')
    if ('kind' in placed) return placed
    secret = { site: 'env', key: placed.key }
  }
  const args = Array.isArray(server.args)
    ? server.args.filter((value): value is string => typeof value === 'string')
    : []
  const cwd = text(server.cwd)
  return {
    kind: 'built',
    serverName,
    config: {
      serverName,
      transport: 'stdio',
      command,
      ...args.length === 0 ? {} : { args },
      ...Object.keys(env).length === 0 ? {} : { env },
      ...cwd === undefined ? {} : { cwd },
      failOnStartupError: true,
    },
    ...secret === undefined ? {} : { secret },
  }
}

/**
 * Put the user's token where it can actually be read.
 *
 * The manifest's `auth.inject` is not consulted, and that is deliberate. There
 * is exactly one place a secret can live per transport — a header on an http
 * server, an environment variable on a local process — so a declaration that
 * disagrees with the transport names a place that does not exist. The old shell
 * trusted the field and would write `headers` onto a stdio server, where nothing
 * reads it: a connector that connects and then 401s on every call. Inferring
 * from the transport was already its default (`connector-installer.ts:85`);
 * this just drops the case where the two disagree.
 *
 * @param into - headers or env, mutated in place.
 * @param manifest - the row, for `auth.key` and `auth.prefix`.
 * @param token - the secret.
 * @returns the field it wrote, or a refusal when the manifest named no field.
 */
function inject(
  into: Record<string, string>,
  manifest: ConnectorManifest,
  token: string,
): { readonly key: string } | Extract<BuildOutcome, { kind: 'refused' }> {
  const key = text(manifest.auth?.key)
  if (key === undefined) {
    return {
      kind: 'refused',
      reason: 'bad-manifest',
      message: '这个连接器声明了令牌鉴权，却没有说令牌该放在哪个字段（auth.key）。',
    }
  }
  into[key] = `${prefixOf(manifest)}${token.trim()}`
  return { key }
}

/**
 * Put an access token where a signed-in server will read it.
 *
 * Unlike `inject`, a missing `auth.key` is not a broken manifest here: the
 * catalog's OAuth rows were written for a kernel that ran `mcp login` and
 * never had to say where the result goes, so most of them declare nothing.
 * `Authorization: Bearer …` is not a guess in that silence — it is what the
 * token endpoint's own `token_type` says and what RFC 6750 defines — while a
 * manifest that does name a field still wins, because a server that wants its
 * token somewhere unusual is the only one that would bother to say so.
 * @param into - the header map, mutated in place.
 * @param manifest - the row, for an explicit `auth.key` / `auth.prefix`.
 * @param token - the access token from the grant.
 * @returns the header that was written.
 */
function placeBearer(
  into: Record<string, string>,
  manifest: ConnectorManifest,
  token: string,
): GrantSite {
  const key = text(manifest.auth?.key) ?? 'Authorization'
  const prefix = typeof manifest.auth?.prefix === 'string' ? manifest.auth.prefix : 'Bearer '
  into[key] = `${prefix}${token.trim()}`
  return { site: 'headers', key, prefix }
}

/**
 * The manifest's token prefix, whitespace intact.
 *
 * Not trimmed: the conventional value is `"Bearer "`, and trimming it would
 * produce `Bearerabc` — a header that parses and then 401s on every call.
 */
function prefixOf(manifest: ConnectorManifest): string {
  return typeof manifest.auth?.prefix === 'string' ? manifest.auth.prefix : ''
}

/** One line saying what a stored config runs, with no secret in it. */
function summarize(config: BridgeConfig): string {
  const url = text(config.url)
  if (url !== undefined) return url
  const command = text(config.command) ?? ''
  const args = Array.isArray(config.args)
    ? config.args.filter((value): value is string => typeof value === 'string')
    : []
  return [command, ...args].join(' ').trim()
}

/**
 * The credential reference name for one connector.
 *
 * A reference is a POSIX environment-variable name, so the slug is folded to
 * that alphabet. Slugs are already `[a-z0-9-]+` by the time this is called, so
 * the fold is total rather than best-effort, and the result is recognisable in
 * `.credentials.yaml` as belonging to this product — the same courtesy
 * `OPENLUX_SESSION` pays.
 * @param slug - the catalog slug.
 * @returns the reference name.
 */
function refNameFor(slug: string): string {
  return `OPENLUX_MCP_${slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
}

/**
 * Move the token out of a freshly built config and into the credential seam.
 *
 * Mutates `config` — the copy handed to the loader keeps the value, because the
 * bridge has nowhere to read a reference from; what changes is that this
 * function is the only place the value is written down, and it writes it to the
 * kernel's store rather than to ours.
 * @param ctx - host context, for the credential service.
 * @param slug - the catalog slug, which names the reference.
 * @param config - the built config, read for the value at `site`.
 * @param site - where the value is.
 * @returns a refusal when the store would not take it.
 */
async function keepSecret(
  ctx: Context,
  slug: string,
  config: BridgeConfig,
  site: SecretSite,
): Promise<{ kind: 'kept' } | Extract<BuildOutcome, { kind: 'refused' }>> {
  const value = record(config[site.site])[site.key]
  if (value === undefined) return { kind: 'kept' }
  try {
    await ctx.credentials.set(credentialRef(refNameFor(slug)), value)
    return { kind: 'kept' }
  } catch (error: unknown) {
    return {
      kind: 'refused',
      reason: 'write-failed',
      message: `令牌没能存进凭据库：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** Drop one connector's token, tolerating a store that never had it. */
async function forgetSecret(ctx: Context, row: ConnectorRecord): Promise<void> {
  if (row.secret === undefined) return
  try {
    await ctx.credentials.unset(credentialRef(row.secret.ref))
  } catch (error: unknown) {
    ctx.logger.warn(`openlux: connector ${row.slug} token not cleared: ${
      error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Put the token back into a stored config, for mounting.
 *
 * Resolved per mount rather than cached, which is the seam's own rule: a
 * rotated value has to reach the next operation without a restart
 * (`CredentialProvider.resolve`). A reference that resolves to nothing is a
 * refusal with its own wording, because "the server would not start" and "your
 * token is gone" call for different things from the user.
 * @param ctx - host context.
 * @param row - the stored record.
 * @returns the config to mount, or why it cannot be built.
 */
async function hydrate(
  ctx: Context,
  row: ConnectorRecord,
): Promise<
  | { kind: 'ready'; config: BridgeConfig }
  // `reauthorize` is what turns the message into a button: a dead sign-in is
  // the one missing-credential case the user can fix without disconnecting.
  | { kind: 'missing'; message: string; reauthorize?: boolean }
> {
  if (row.oauth !== undefined) {
    // Read through the refresh: the header is a snapshot the bridge keeps for
    // the life of the plugin instance, so an access token that expires in ten
    // minutes has to be renewed here rather than at the first 401 — which the
    // bridge would report as a dead server, not as an expired sign-in.
    const token = await readConnectorToken(ctx, row.slug)
    if (token === undefined) {
      return { kind: 'missing', message: '网页授权已经失效了，重新授权一次就好。', reauthorize: true }
    }
    const site = { ...record(row.config[row.oauth.site]), [row.oauth.key]: `${row.oauth.prefix}${token}` }
    return { kind: 'ready', config: { ...row.config, [row.oauth.site]: site } }
  }
  if (row.secret === undefined) return { kind: 'ready', config: row.config }
  const hit = await ctx.credentials?.resolve(credentialRef(row.secret.ref)).catch(() => undefined)
  if (hit?.value === undefined || hit.value === '') {
    return { kind: 'missing', message: '令牌已经不在凭据库里了，断开后重新连接一次。' }
  }
  const site = { ...record(row.config[row.secret.site]), [row.secret.key]: hit.value }
  return { kind: 'ready', config: { ...row.config, [row.secret.site]: site } }
}

/** One config with the secret field lifted out, for writing down. */
function without(config: BridgeConfig, site: SecretSite): BridgeConfig {
  const rest = { ...config }
  const map = { ...record(config[site.site]) }
  delete map[site.key]
  if (Object.keys(map).length === 0) delete rest[site.site]
  else rest[site.site] = map
  return rest
}

/** Mount one entry in the live tree. */
async function mountEntry(
  ctx: Context,
  serverName: string,
  config: BridgeConfig,
): Promise<{ kind: 'mounted'; entryId: string } | { kind: 'refused'; message: string }> {
  const loader = loaderOf(ctx)
  if (typeof loader?.create !== 'function') {
    return { kind: 'refused', message: '当前部署没有可写的插件树，无法挂载连接器。' }
  }
  const entryId = entryIdFor(serverName)
  // A reload of this plugin re-runs the restore, and the entry it made last
  // time is not a child of ours — so it is still there. Adopting it is the only
  // answer that does not either duplicate the server or kill a live one.
  if (loader.store?.[entryId] !== undefined) return { kind: 'mounted', entryId }
  try {
    const created = await loader.create({ id: entryId, name: MCP_CLIENT_PACKAGE, config })
    return { kind: 'mounted', entryId: created }
  } catch (error: unknown) {
    // The chain, not the message: `dsh-mcp-client` throws one fixed sentence
    // ("initial connection or tool synchronization failed") and puts the HTTP
    // status on `cause`, so the top message cannot tell a rejected sign-in from
    // an endpoint that is simply down — which is the distinction the row needs.
    return { kind: 'refused', message: causeChain(error) }
  }
}

/** Unmount one entry, treating an absent one as already gone. */
async function unmountEntry(ctx: Context, entryId: string): Promise<boolean> {
  const loader = loaderOf(ctx)
  if (typeof loader?.remove !== 'function') return false
  try {
    await loader.remove(entryId)
    return true
  } catch (error: unknown) {
    ctx.logger.warn(`openlux: connector entry ${entryId} could not be removed: ${
      error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/** The loader entry id for one MCP namespace. */
function entryIdFor(serverName: string): string {
  return `${CONNECTOR_ENTRY_PREFIX}${serverName}`
}

/** The loader service, when this deployment has one. */
function loaderOf(ctx: Context): LoaderLike | undefined {
  return ctx.get('loader' as never) as LoaderLike | undefined
}

/** Which auth mode a manifest declares; anything unknown reads as none. */
function modeOf(manifest: ConnectorManifest): 'none' | 'token' | 'oauth' {
  const mode = text(manifest.auth?.mode)
  return mode === 'token' || mode === 'oauth' ? mode : 'none'
}

/** Where the record file lives for this deployment. */
export function recordPath(): string {
  return dshHomePath(RECORD_FILE)
}

/** Read the record file, treating any fault as "nothing connected". */
async function readRecords(): Promise<readonly ConnectorRecord[]> {
  let body: string
  try {
    body = await readFile(recordPath(), 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const rows: ConnectorRecord[] = []
  for (const entry of parsed) {
    const row = entry as Partial<ConnectorRecord> | null
    if (typeof row?.slug !== 'string' || typeof row.serverName !== 'string') continue
    if (typeof row.config !== 'object' || row.config === null) continue
    const secret = secretOf(row.secret)
    const oauth = grantOf(row.oauth)
    rows.push({
      slug: row.slug,
      serverName: row.serverName,
      name: typeof row.name === 'string' && row.name !== '' ? row.name : row.slug,
      ...typeof row.version === 'string' ? { version: row.version } : {},
      connectedAt: typeof row.connectedAt === 'string' ? row.connectedAt : '',
      config: { ...row.config },
      ...secret === undefined ? {} : { secret },
      ...oauth === undefined ? {} : { oauth },
    })
  }
  return rows
}

/**
 * Write the record file.
 *
 * `mode` is owner-only even though no secret is in here any more: the rows name
 * commands, arguments, and endpoints, which is enough to be worth not sharing.
 * A no-op on Windows, where this machine runs, but the same file on a POSIX
 * deployment.
 */
async function writeRecords(records: readonly ConnectorRecord[]): Promise<void> {
  const path = recordPath()
  await mkdir(dirname(path), { recursive: true })
  if (records.length === 0) {
    await rm(path, { force: true })
    return
  }
  await writeFile(path, `${JSON.stringify(records, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

/**
 * One stored secret pointer, or undefined when the row carries no token.
 *
 * A half-written pointer reads as none: without all three fields the value
 * could not be found or put back, and treating it as a token would mount a
 * connector whose auth field is silently absent.
 * @param value - the record's `secret` as it came off disk.
 * @returns the pointer, or undefined.
 */
function secretOf(value: unknown): (SecretSite & { ref: string }) | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Partial<SecretSite & { ref: string }>
  if (row.site !== 'env' && row.site !== 'headers') return undefined
  const ref = text(row.ref)
  const key = text(row.key)
  if (ref === undefined || key === undefined) return undefined
  return { site: row.site, key, ref }
}

/**
 * Read back where a granted bearer token goes.
 *
 * Dropping this on the way in is silent and total: the mount path would find
 * no `oauth`, take the record for one that needs no credential, and put the
 * server up with no `Authorization` header at all — a connector that reads as
 * live while every one of its tools answers 401.
 * @param value - the record's `oauth` as it came off disk.
 * @returns the placement, or undefined.
 */
function grantOf(value: unknown): GrantSite | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Partial<GrantSite>
  if (row.site !== 'env' && row.site !== 'headers') return undefined
  const key = text(row.key)
  if (key === undefined) return undefined
  // An empty prefix is a real answer — a server wanting the bare token — so it
  // is kept, and only a missing one falls back to the standard spelling.
  return { site: row.site, key, prefix: typeof row.prefix === 'string' ? row.prefix : 'Bearer ' }
}

/** A trimmed non-empty string, or undefined. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** A string map, dropping anything that is not one. */
function record(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}

/** Shape a refusal. */
function refuse(reason: RefusalReason, message: string): InstallOutcome {
  return { kind: 'refused', reason, message }
}
