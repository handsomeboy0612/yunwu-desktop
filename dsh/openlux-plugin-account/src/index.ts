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
import { clearSession, readSession, saveSession, type StoredSession } from './account/session.ts'
import { TokenManager } from './account/tokens.ts'
import { installAutomationRuntime } from './automation.ts'
import { FILE_STAGE_ENDPOINT, FILE_VISION_ENDPOINT } from './files/name.ts'
import { stageFile } from './files/stage.ts'
import { readCatalog, type Catalog, type CatalogType } from './market/catalog.ts'
import { readExpertManifest, type ConsoleAccess } from './market/console.ts'
import {
  readFeaturedScenes, readHomeContent, readPlaybookArtifact, readRelatedPlaybooks,
} from './market/home-content.ts'
import { installPreset, readInstallTarget, type InstallOutcome, type InstallRequest, type InstallTarget } from './market/install.ts'
import { importLocalSkill, installSkill, readSkillTarget, removeSkill } from './market/skill-install.ts'
import {
  authorizeConnector, connectorAuthorizationState, installConnector, openCustomFile,
  readConnectorRequirement, readConnectorTarget, remountConnector, restoreConnectors,
  syncCustomConnectors, uninstallConnector,
} from './market/connector-install.ts'
import { registerConnectorOfferTool } from './market/connector-offer.ts'
import type { ConnectorRequest } from './market/wire.ts'
import { registerImageAskTool } from './media/ask-tool.ts'
import { registerDocumentAskTool } from './media/doc-tool.ts'
import { IMAGE_READ_ENDPOINT } from './media/name.ts'
import { imageRefOf, readImageBytes } from './media/read.ts'
import { registerImageShowTool } from './media/show-tool.ts'
import { registerImageTool } from './media/tool.ts'
import { registerVideoTool } from './media/video-tool.ts'
import { imageCapableModels } from './media/vision.ts'
import { ModelSyncCoordinator, type MutableModelDefaults } from './models/coordinator.ts'
import { ROUTE, type SyncOutcome } from './models/sync.ts'
import { registerToolReality } from './persona/tool-reality.ts'
import { registerSearchProvider } from './web/search/provider.ts'

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
  /**
   * Model the image tool draws with when a call names none. Omit for the
   * route-verified default (see `media/tool.ts`). A call may name another one;
   * a name this account cannot serve is refused rather than substituted, which
   * is what `media/image/registry.ts` is for.
   */
  readonly imageModel?: string
  /**
   * Model the video tool films with when a call names none. Same rule as the
   * image one (see `media/video-tool.ts`).
   */
  readonly videoModel?: string
}

type RuntimeModelDefaults = MutableModelDefaults

/**
 * Default console origin.
 *
 * One station serves the account and every billed model call — sign-in, the
 * model pool, balance, chat, search, image, and video. So that origin has to be
 * stated in more than one place (`cordis.patch.yml` carries it for the
 * `llm-pi-ai` route and for web search), and those places stay in step by
 * reading the same variable. Product configuration and market content may be
 * split in development; their routing is resolved independently below.
 *
 * The env seam is upstream's own idiom for exactly this, values included
 * (`dsh-base/cordis.patch.yml:151-154` reads
 * `process.env.DSH_TELEMETRY_OTLP_URL ?? '<production url>'`).
 *
 * **A local relay must be named `localhost`, not `127.0.0.1`.** The station
 * resolves which site a request belongs to by matching the `Host` header
 * against its own registry, so an origin the registry does not list answers
 * `站点不存在` to *every* route including `/api/status` — a whole-product
 * failure that reads like the service is down (measured 2026-08-20: `Host:
 * localhost:3001` serves 101 models, `Host: 127.0.0.1:3001` serves nothing).
 */
const DEFAULT_BASE_URL = process.env.OPENLUX_BASE_URL ?? 'https://api.openlux.ai'

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
  const modelDefaults: RuntimeModelDefaults = {
    imageModel: config.imageModel,
    videoModel: config.videoModel,
    searchModels: [],
  }
  const modelCoordinator = new ModelSyncCoordinator(
    ctx,
    baseUrl,
    desktopConfigAccess(ctx, baseUrl),
    modelDefaults,
  )
  const tokens = new TokenManager(ctx, balance, modelCoordinator)
  const automations = installAutomationRuntime(ctx)

  // Installs run one at a time. They stage inside the same preset root and
  // verify by re-reading the roster, so two in flight could rename over each
  // other's verification window — serialising is also what the upstream market
  // shell requires of a host (`dsh-community-market/docs/market-shell.zh.md`).
  let queue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task, task)
    queue = result.catch(() => undefined)
    return result
  }

  // Account/session/key mutations use a distinct queue from market installs.
  // A login and a token switch must never interleave their session and key.
  let accountQueue: Promise<unknown> = Promise.resolve()
  const serializeAccount: Serializer = <T>(task: () => Promise<T>): Promise<T> => {
    const result = accountQueue.then(task, task)
    accountQueue = result.catch(() => undefined)
    return result
  }

  // `handle` registers through the calling fiber's own effect, so the route
  // and its disposal already follow this plugin's lifetime.
  ctx.connection.rpc.handle(ACCOUNT_CHANNEL, async (endpoint, payload, signal) => {
    try {
      if (endpoint.startsWith('automations.')) {
        return { ok: true, value: await (await automations.get()).call(endpoint, payload) }
      }
      return await route(
        ctx,
        baseUrl,
        balance,
        tokens,
        modelCoordinator,
        serialize,
        serializeAccount,
        endpoint,
        payload,
        signal,
      )
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
    void safeSyncCatalog(ctx, modelCoordinator, 'startup', stop.signal)
    return () => stop.abort()
  })

  // Credential writes made outside this page (settings UI or external file
  // edits) converge through the same latest-wins coordinator.
  ctx.effect(() => ctx.on('credentials/reference-updated', (ref) => {
    if (ref !== API_KEY_REF) return
    void safeSyncCatalog(ctx, modelCoordinator, 'credential-update')
  }))

  // Connectors the user connected on an earlier launch. They are loader entries
  // rather than files, so nothing else brings them back; and they are mounted
  // through the same call a fresh connect uses, which is the one path measured
  // to work (`market/connector-install.ts`). Serialised with the installs so a
  // restore cannot interleave with a connect arriving from the gallery.
  ctx.effect(() => {
    void serialize(async () => {
      await restoreConnectors(ctx)
      // And the user's own file, which is the whole truth for what is in it —
      // nothing else would bring those back either.
      await syncCustomConnectors(ctx)
    })
    // Nothing to abort: `create` is not cancellable, and a half-mounted entry
    // would be worse than one extra mount. Disposal leaves the entries up —
    // they are siblings of this plugin, not children, and a hot reload adopts
    // them by id instead of duplicating them.
    return () => {}
  })

  // The same origin and the same key serve the model-facing side of the
  // account: drawing and filming are billed to whoever is signed in here.
  const access = { baseUrl, apiKey: () => apiKey(ctx) }
  const captureAccess = async (): Promise<ConsoleAccess> => {
    const captured = await modelCoordinator.captureAccess()
    return { baseUrl: captured.baseUrl, apiKey: async () => captured.apiKey }
  }
  ctx.inject(['tools', 'attachments'], scope => registerImageTool(scope, {
    access,
    captureAccess,
    model: () => modelDefaults.imageModel,
  }))
  ctx.inject(['tools', 'attachments'], scope => registerVideoTool(scope, {
    access,
    captureAccess,
    model: () => modelDefaults.videoModel,
  }))
  // Reaches no route and spends nothing: it shows a picture this machine already
  // has, which is how a delegated member's image gets back to the user at all
  // (`media/show-tool.ts`).
  registerImageShowTool(ctx)
  // The reading half of the same idea: a chat model that cannot see hands the
  // picture to one that can, chosen from what was delivered rather than from a
  // name in this build (`media/vision.ts`). No `model` option for that reason —
  // the pick is per call, off the settings document the sync layer maintains.
  ctx.inject(['tools'], scope => registerImageAskTool(scope, { access, captureAccess }))
  // And the same move for documents, which no model here opens itself and the
  // kernel deliberately does not carry (`media/documents.ts`). Same reason for
  // having no `model` option: the pick is per call, off the delivered list.
  ctx.inject(['tools'], scope => registerDocumentAskTool(scope, { access, captureAccess }))

  // The same shape once more, for capabilities no model can substitute for: when
  // the ask needs somebody else's service, offer to connect one and carry on with
  // the tools that arrive (`market/connector-offer.ts`). It pauses on the kernel's
  // own question seam, so it registers itself only where that seam is mounted.
  //
  registerConnectorOfferTool(ctx, { access })

  // Web search is the fourth model-facing capability that has to pick a model
  // this key can actually use, and the one the console's delivered priority list
  // was written for (`web/search/provider.ts`). Deferred like the system prompt
  // below: a composition may mount no `web` seam at all, and an account face is
  // still useful there.
  ctx.inject(['web'], scope => registerSearchProvider(scope, {
    access,
    captureAccess,
    models: () => modelDefaults.searchModels,
  }))

  // The sentence about those tools belongs next to the tools themselves, and it
  // is stated once at runtime rather than written into each persona — see
  // `persona/tool-reality.ts` for why that is the layer. Deferred rather than
  // declared in `inject`: an account face is still useful in a composition that
  // assembles no system prompt, and this is the only thing here that needs one.
  ctx.inject(['systemPrompt'], scope => registerToolReality(scope))
}

/**
 * Dispatch one account endpoint.
 * @param ctx - host context.
 * @param baseUrl - console origin.
 * @param balance - the per-process balance cache.
 * @param tokens - host-only token and credential operations.
 * @param serialize - runs one task at a time across this channel.
 * @param endpoint - method name within this plugin's channel.
 * @param payload - request body, shaped per endpoint.
 * @param signal - caller cancellation.
 * @returns the RPC result for this call.
 */
async function route(
  ctx: Context,
  baseUrl: string,
  balance: BalanceReader,
  tokens: TokenManager,
  modelCoordinator: ModelSyncCoordinator,
  serialize: Serializer,
  serializeAccount: Serializer,
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
      return {
        ok: true,
        value: await serializeAccount(() => runSignIn(ctx, baseUrl, balance, modelCoordinator, payload, signal)),
      }

    case 'sign-out':
      return {
        ok: true,
        value: await serializeAccount(() => runSignOut(ctx, balance, modelCoordinator)),
      }

    case 'balance':
      return { ok: true, value: await balance.read(forceOf(payload), signal) }

    case 'tokens.list':
      return { ok: true, value: await tokens.list(signal) }

    case 'tokens.groups':
      return { ok: true, value: await tokens.groups(signal) }

    case 'tokens.create':
      return { ok: true, value: await serializeAccount(() => tokens.create(payload, signal)) }

    case 'tokens.update':
      return { ok: true, value: await serializeAccount(() => tokens.update(payload, signal)) }

    case 'tokens.use':
      return { ok: true, value: await serializeAccount(() => tokens.use(payload, signal)) }

    case 'tokens.delete':
      return { ok: true, value: await serializeAccount(() => tokens.remove(payload, signal)) }

    // Hand refresh. Mount and sign-in run their own rounds, so this is for the
    // case where the account gained models after both.
    case 'models.sync': {
      const outcome = await safeSyncCatalog(ctx, modelCoordinator, 'manual', signal)
      if (outcome.skipped === 'no-key' || outcome.skipped === 'no-pool' || outcome.skipped === 'empty-result') {
        throw new Error('模型配置刷新失败，已保留上一次可用目录')
      }
      return {
        ok: true,
        value: {
          outcome,
          ...modelCoordinator.status(),
        },
      }
    }

    // What the console offers this kernel. The browser cannot ask for itself:
    // the route authenticates with our token and answers without CORS headers.
    case 'market.catalog':
      return { ok: true, value: await marketCatalog(ctx, desktopConfigAccess(ctx, baseUrl), payload, signal) }

    case 'market.home':
      return { ok: true, value: await readHomeContent(ctx, desktopConfigAccess(ctx, baseUrl), signal) }

    case 'market.featuredScenes':
      return { ok: true, value: await readFeaturedScenes(ctx, desktopConfigAccess(ctx, baseUrl), signal) }

    case 'market.relatedPlaybooks':
      return {
        ok: true,
        value: await readRelatedPlaybooks(
          ctx,
          desktopConfigAccess(ctx, baseUrl),
          slugOf(payload),
          signal,
        ),
      }

    case 'market.playbookArtifact':
      return {
        ok: true,
        value: await readPlaybookArtifact(
          ctx,
          desktopConfigAccess(ctx, baseUrl),
          positiveIdOf(payload),
          signal,
        ),
      }

    // Where an install would land, and what the roster already holds. The
    // gallery needs both before it can mark a card installed, and the
    // confirmation dialog needs the resolved directory to name its target.
    case 'market.target':
      return { ok: true, value: await marketTarget(ctx) }

    case 'market.install':
      return await marketInstall(ctx, desktopConfigAccess(ctx, baseUrl), serialize, payload, signal)

    // The skill partition's own "what is already there". Not folded into
    // `market.target`: that one answers for the preset roster, which can be
    // unauthorable, while skills land in a plain watched directory that always
    // exists in principle. Two owners, two answers.
    case 'market.skills':
      return { ok: true, value: await readSkillTarget() }

    // A skill directory the user picked on their own disk («从本地添加技能»).
    // The renderer sends a path rather than bytes because the shell's preload
    // resolves one for any dropped or picked file since 0.1.1-rc.2.
    case 'market.skillImport':
      return { ok: true, value: await marketSkillImport(ctx, serialize, payload, signal) }

    case 'market.skillRemove':
      return { ok: true, value: { removed: await removeSkill(slugOf(payload)) } }

    // The connector partition's own "what is already there", plus whether this
    // deployment can mount anything at all.
    case 'market.connectors':
      return { ok: true, value: await readConnectorTarget(ctx) }

    // What one connector will ask for before it can connect. Its own call
    // because the answer is in the manifest, which the snapshot withholds.
    case 'market.connectorRequirement':
      return {
        ok: true,
        value: await readConnectorRequirement(
          ctx, desktopConfigAccess(ctx, baseUrl), slugOf(payload), signal,
        ),
      }

    // Start / stop one MCP server. The kernel has no `mcp set` and no browser
    // half for this, so the entry is ours to mount; see
    // `market/connector-install.ts` for why it is the loader and not a file.
    case 'market.connectorInstall':
      return {
        ok: true,
        value: await serialize(() => installConnector(
          ctx, desktopConfigAccess(ctx, baseUrl), connectorRequestOf(payload), signal,
        )),
      }

    // A web sign-in, in two calls because the browser is the renderer's to
    // open: this one answers with the page as soon as the flow has produced it
    // and leaves the attempt running, and the poll below reports how it ended.
    case 'market.connectorAuthorize':
      return {
        ok: true,
        value: await authorizeConnector(
          ctx, desktopConfigAccess(ctx, baseUrl), slugOf(payload), signal,
        ),
      }

    case 'market.connectorAuthorizeState':
      return { ok: true, value: connectorAuthorizationState(slugOf(payload)) }

    case 'market.connectorUninstall':
      return {
        ok: true,
        value: { removed: await serialize(() => uninstallConnector(ctx, slugOf(payload))) },
      }

    // Bring a connected row back up after its sign-in was repaired. Serialized
    // with the rest because it unmounts and remounts an entry in the same tree
    // the connect and disconnect paths write to.
    case 'market.connectorRemount':
      return {
        ok: true,
        value: await serialize(() => remountConnector(ctx, slugOf(payload))),
      }

    // The user's own servers, which live in a file they edit — WorkBuddy's shape
    // for the same button. Two calls, and neither takes a command from the
    // renderer: open the file, and re-read it.
    case 'market.connectorCustomOpen':
      return { ok: true, value: await openCustomFile(ctx) }

    case 'market.connectorCustomSync':
      return { ok: true, value: await serialize(() => syncCustomConnectors(ctx)) }

    // The opening questions one expert publishes. Separate from the catalog
    // because the manifest is a longtext column the snapshot withholds, and
    // asked only for the item whose detail page is open.
    case 'market.prompts':
      return {
        ok: true,
        value: await marketPrompts(ctx, desktopConfigAccess(ctx, baseUrl), payload, signal),
      }

    // One file the user attached in the composer, on its way to becoming a path
    // the model's own tools can open. See `files/stage.ts` for why the bytes
    // travel rather than the path.
    case FILE_STAGE_ENDPOINT:
      return { ok: true, value: await stageFile(payload) }

    // Which of this account's models can be handed a picture. Read fresh each
    // time rather than cached here: the list changes when a sync round applies
    // the console's capability layer, and this answer is one settings read.
    case FILE_VISION_ENDPOINT:
      // The route travels with the list because the browser has to check that
      // the selected model is one of *ours* before judging it: a provider the
      // user configured themselves is outside what this answer covers.
      return { ok: true, value: { route: ROUTE, models: [...imageCapableModels(ctx)] } }

    // Bytes for one image this plugin generated. See `media/read.ts` for why the
    // kernel's own attachment read cannot serve these, and what authorizes this
    // one instead.
    case IMAGE_READ_ENDPOINT: {
      const ref = imageRefOf(payload)
      if (ref === undefined) {
        return {
          ok: false,
          error: { code: 'bad-request', message: 'image read needs a complete attachment reference', details: { issues: [] } },
        }
      }
      // Same opportunistic read as the tool registration, and for the same
      // reason: a composition with no attachment store still gets an account
      // face. Nothing could have generated an image there either.
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        return {
          ok: false,
          error: { code: 'internal', message: 'this composition has no durable attachment store', details: {} },
        }
      }
      return { ok: true, value: await readImageBytes(attachments, ref, signal) }
    }

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

/** Runs one task at a time, in the order the calls arrived. */
type Serializer = <T>(task: () => Promise<T>) => Promise<T>

/**
 * Report where a market install would land.
 *
 * A deployment that composed no preset roster is not a fault — the kernel
 * supports that shape, with the model-facing rows sitting in the host
 * composition instead — so it answers as a target that cannot accept installs,
 * on the success arm, the way every other outcome here does.
 * @param ctx - host context.
 * @returns the install target.
 */
/**
 * Read one catalog partition.
 *
 * A read that failed rides the success arm like every other outcome here: the
 * gallery renders the reason next to whatever rows it still holds, and a
 * catalog it cannot reach is not a fault of the call.
 * @param ctx - host context.
 * @param access - console origin and token the catalog is read with.
 * @param payload - request body; `type` selects the partition.
 * @param signal - caller cancellation.
 * @returns the catalog.
 */
async function marketCatalog(
  ctx: Context,
  access: ConsoleAccess,
  payload: unknown,
  signal?: AbortSignal,
): Promise<Catalog> {
  return await readCatalog(ctx, { ...access, type: catalogTypeOf(payload) }, signal)
}

/**
 * Read which partition the caller asked for.
 * @param payload - request body.
 * @returns the partition, defaulting to experts.
 */
function catalogTypeOf(payload: unknown): CatalogType {
  const type = (payload as { type?: unknown } | null)?.type
  return type === 'skill' || type === 'connector' ? type : 'expert'
}

function positiveIdOf(payload: unknown): number {
  const raw = (payload as { id?: unknown } | null)?.id
  const id = typeof raw === 'number' ? raw : Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : 0
}

/**
 * Read one expert's opening questions.
 *
 * A read failure answers with an empty list rather than an error: suggestions
 * are an addition to a detail page, and a summon without one lands on a clean
 * composer instead of not happening.
 * @param ctx - host context.
 * @param access - console origin and token the manifest is read with.
 * @param payload - request body; `id` names the expert.
 * @param signal - caller cancellation.
 * @returns the questions, best first.
 */
async function marketPrompts(
  ctx: Context,
  access: ConsoleAccess,
  payload: unknown,
  signal?: AbortSignal,
): Promise<{ prompts: readonly string[] }> {
  const id = (payload as { id?: unknown } | null)?.id
  if (typeof id !== 'string' || id.trim() === '') return { prompts: [] }
  const manifest = await readExpertManifest(ctx, access, id.trim(), signal)
  return { prompts: manifest.prompts }
}

async function marketTarget(ctx: Context): Promise<InstallTarget> {
  // `ctx.get` rather than `ctx.agentPresets`: the roster is consumed
  // opportunistically, and an undeclared property read fails the reflect proxy
  // outright ("cannot get property without inject") — the kernel's own gateway
  // notes the same distinction (`host/apiproxy/src/api-proxy.ts:3172-3176`).
  const presets = ctx.get('agentPresets')
  if (presets === undefined) return { authorable: false, installed: [] }
  return await readInstallTarget(presets)
}

/**
 * Install one preset from the catalog.
 * @param ctx - host context.
 * @param serialize - the channel's install queue.
 * @param payload - the request as the browser sent it.
 * @param signal - caller cancellation.
 * @returns the RPC result; install refusals ride the success arm as values.
 */
async function marketInstall(
  ctx: Context,
  access: ConsoleAccess,
  serialize: Serializer,
  payload: unknown,
  signal?: AbortSignal,
): ReturnType<ConnectionRpcHandler> {
  const skillRequest = installRequestOf(payload)
  // Skills do not go through the roster at all: they land in the kernel's user
  // skill root, which is a watched directory rather than a service, so a
  // deployment without `agentPresets` can still install one.
  if (skillRequest?.type === 'skill') {
    return {
      ok: true,
      value: await serialize(() => installSkill(ctx, access, skillRequest, signal)),
    }
  }
  const presets = ctx.get('agentPresets')
  if (presets === undefined) {
    const refused: InstallOutcome = {
      kind: 'refused',
      reason: 'not-authorable',
      message: '当前部署没有组合 agent 预设，无法安装专家。',
    }
    return { ok: true, value: refused }
  }
  const request = installRequestOf(payload)
  if (request === undefined) {
    // A malformed request IS the caller's mistake, so this one is an error
    // rather than an outcome: no user action fixes a missing digest.
    return {
      ok: false,
      error: {
        code: 'bad-request',
        message: '安装请求缺少必要字段（id / format / itemId）',
        details: { issues: [] },
      },
    }
  }
  return { ok: true, value: await serialize(() => installPreset(ctx, presets, access, request, signal)) }
}

/**
 * Import a skill directory the user picked, off the wire.
 *
 * Serialized with the installs for the reason they are serialized with each
 * other: both write into a skill root the kernel is watching, and two writers
 * racing there is how a half-written directory becomes a live skill.
 * @param ctx - host context.
 * @param serialize - the channel's install queue.
 * @param payload - the request body; `path` is the chosen directory.
 * @param signal - caller cancellation.
 * @returns the outcome; a bad pick is a refusal, not an error.
 */
async function marketSkillImport(
  ctx: Context,
  serialize: Serializer,
  payload: unknown,
  signal?: AbortSignal,
): Promise<InstallOutcome> {
  const path = (payload as { path?: unknown } | null)?.path
  if (typeof path !== 'string' || path.trim() === '') {
    return { kind: 'refused', reason: 'invalid-id', message: '没有拿到要导入的技能目录。' }
  }
  return await serialize(() => importLocalSkill(ctx, path.trim(), signal))
}

/**
 * Read a connect request off the wire.
 *
 * The renderer names a catalog slug and, when the connector asks for one, a
 * secret. It never names a command: what gets spawned is read from the console's
 * manifest host-side, for the same reason the download URL is
 * (`market/console.ts` — a main process that spawns what a renderer named is
 * the same sink as one that fetches what a renderer named).
 */
function connectorRequestOf(payload: unknown): ConnectorRequest {
  const row = (payload as Partial<ConnectorRequest> | null) ?? {}
  return {
    slug: typeof row.slug === 'string' ? row.slug.trim() : '',
    ...typeof row.name === 'string' ? { name: row.name } : {},
    ...typeof row.version === 'string' ? { version: row.version } : {},
    ...typeof row.token === 'string' ? { token: row.token } : {},
  }
}

/** Read a skill or connector slug off the wire, empty when the payload has none. */
function slugOf(payload: unknown): string {
  const value = (payload as { slug?: unknown } | null)?.slug
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Read an install request off the wire.
 *
 * Every field is required and every field is a string: the catalog is what
 * supplies them, so a missing one means the gallery sent a half-built request
 * rather than that the user typed something wrong.
 * @param payload - the request body.
 * @returns the request, or undefined when it is not one.
 */
function installRequestOf(payload: unknown): InstallRequest | undefined {
  const raw = payload as Record<string, unknown> | null
  const text = (key: string): string | undefined => {
    const value = raw?.[key]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  }
  const [id, itemId] = [text('id'), text('itemId')]
  if (id === undefined || itemId === undefined) return undefined
  // The format decides which unpacker runs, so a request without one is not
  // installable by guessing: the installer refuses an unknown format by value,
  // and an empty string is exactly that.
  const format = text('format') ?? ''
  // No URL is read off the wire at all. The host signs its own link from the
  // item named here, so a renderer cannot choose where this process connects.
  const type = catalogTypeOf(raw)
  const sha256 = text('sha256') ?? ''
  const [version, kernelApi, name, description] = [
    text('version'), text('kernelApi'), text('name'), text('description'),
  ]
  return {
    type,
    id,
    format,
    sha256,
    itemId,
    ...name === undefined ? {} : { name },
    ...description === undefined ? {} : { description },
    ...version === undefined ? {} : { version },
    ...kernelApi === undefined ? {} : { kernelApi },
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
  balance: BalanceReader,
  modelCoordinator: ModelSyncCoordinator,
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
    await modelCoordinator.preflight(outcome.apiKey, signal)
  } catch (error: unknown) {
    return {
      kind: 'failed',
      message: `账号登录成功，但令牌模型目录校验失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const previousSession = await readSession(ctx)
  try {
    await saveSession(ctx, outcome.session)
  } catch (error: unknown) {
    return {
      kind: 'failed',
      message: error instanceof Error ? error.message : String(error),
    }
  }
  try {
    await ctx.credentials.set(API_KEY_REF, outcome.apiKey)
  } catch (error: unknown) {
    await restoreSession(ctx, previousSession).catch(() => {})
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
  balance.forget()
  try {
    await modelCoordinator.refresh('sign-in', signal, outcome.apiKey)
  } catch (error: unknown) {
    return {
      kind: 'failed',
      message: `登录和令牌保存成功，但模型目录刷新失败，可在设置中重试：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return { kind: 'ok', userId: outcome.userId, username: outcome.username }
}

async function restoreSession(ctx: Context, session: StoredSession | undefined): Promise<void> {
  if (session === undefined) {
    await clearSession(ctx)
    return
  }
  await saveSession(ctx, {
    userId: session.userId,
    baseUrl: session.baseUrl,
    cookie: session.cookie,
  })
}

/** Read the stored key, treating any credential fault as "not signed in yet". */
async function apiKey(ctx: Context): Promise<string | undefined> {
  return await ctx.credentials.resolve(API_KEY_REF).then(hit => hit?.value).catch(() => undefined)
}

/**
 * Origin + token for desktop product and market-client reads.
 *
 * Account/model traffic stays on the online station. Product configuration and
 * every desktop-readable market contract live on local new-yunwu-api:
 * `/api/desktop-content/*` is registered in
 * `new-yunwu-api/router/api-router.go:554-570`. Admin-server owns the operator
 * write routes only, so pointing these reads at it returns a real HTTP 404.
 */
function desktopConfigAccess(ctx: Context, accountBaseUrl: string): ConsoleAccess {
  const resolved = resolveDesktopConfigAccess(accountBaseUrl)
  return {
    baseUrl: resolved.baseUrl,
    apiKey: resolved.token === undefined ? () => apiKey(ctx) : async () => resolved.token,
  }
}

/**
 * Resolve product-config routing without exposing or persisting either token.
 *
 * Production remains same-origin when no local token is configured. During
 * integration, `YUNWU_MARKET_TOKEN` is the local-station credential already
 * used by the market, while the config read defaults to new-yunwu-api on 3001.
 * `YUNWU_CONFIG_BASE_URL` exists for private deployments and non-default ports.
 */
export function resolveDesktopConfigAccess(
  accountBaseUrl: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): { readonly baseUrl: string; readonly token?: string } {
  const token = environment.YUNWU_MARKET_TOKEN?.trim()
  const configuredBaseUrl = environment.YUNWU_CONFIG_BASE_URL?.trim()
  const baseUrl = (
    configuredBaseUrl
    || (token === undefined || token === '' ? accountBaseUrl : 'http://localhost:3001')
  ).replace(/\/+$/, '')
  return { baseUrl, ...(token === undefined || token === '' ? {} : { token }) }
}

/** Resolve the account/market split without exposing or persisting either credential. */
export function resolveMarketAccess(
  consoleBaseUrl: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): { readonly baseUrl: string; readonly token?: string } {
  const token = environment.YUNWU_MARKET_TOKEN?.trim()
  const configuredBaseUrl = environment.YUNWU_MARKET_BASE_URL?.trim()
  const baseUrl = (
    configuredBaseUrl
    || (token === undefined || token === '' ? consoleBaseUrl : 'http://localhost:3000')
  ).replace(/\/+$/, '')
  return { baseUrl, ...(token === undefined || token === '' ? {} : { token }) }
}

/**
 * Run one catalog sync and say so in the log.
 *
 * Failures stay here: the sync is a background correction, and an installation
 * whose list is a round out of date is in exactly the state it was in before
 * the round started.
 * @param ctx - host context.
 * @param baseUrl - console origin.
 * @param modelDefaults - mutable defaults read by media tools at call time.
 * @param reason - what triggered it, for the log line.
 * @param signal - cancellation, when the caller owns a lifetime.
 */
async function safeSyncCatalog(
  ctx: Context,
  coordinator: ModelSyncCoordinator,
  reason: string,
  signal?: AbortSignal,
): Promise<SyncOutcome> {
  try {
    return await coordinator.refresh(reason, signal)
  } catch (error: unknown) {
    if (signal?.aborted !== true) {
      ctx.logger.warn(`openlux: model sync (${reason}) failed; leaving the list as it was`)
      ctx.logger.warn(error)
    }
    return { changed: false, skipped: 'no-pool' }
  }
}

/**
 * Sign out: drop the session, the key, and the cached balance.
 *
 * The key goes too. Leaving it would keep the models working for an account
 * the UI shows as signed out, which is the kind of gap that gets discovered as
 * an unexplained charge.
 */
async function runSignOut(
  ctx: Context,
  balance: BalanceReader,
  modelCoordinator: ModelSyncCoordinator,
): Promise<{ ok: true }> {
  // Disable paid API access first. If session clearing then fails the UI can
  // safely retry; the inverse order can leave an invisible billable key live.
  await ctx.credentials.unset(API_KEY_REF)
  modelCoordinator.invalidate()
  balance.forget()
  try {
    await clearSession(ctx)
  } catch (error: unknown) {
    throw new Error(`API 密钥已停用，但登录会话清理失败，请重试退出：${error instanceof Error ? error.message : String(error)}`)
  }
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
