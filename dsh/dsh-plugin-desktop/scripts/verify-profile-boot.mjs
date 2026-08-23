/** Headless smoke for the complete published DSH Web profile and renderer manifest. */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from '@deepseek-ai/dsh-launch-environment'
import { DESKTOP_SETTINGS_NAMESPACE } from '../lib/index.js'
import { installDesktopPnpmRuntime } from '../lib/desktop-runtime-environment.js'
import { installProfilePackageResolver } from '../lib/module-resolution.js'
import { prepareDesktopProfile } from '../lib/profile.js'
import { DesktopProfileService } from '../lib/profile-service.js'

const BIN_NAME = 'dsh-plugin-desktop-profile-smoke'
const HOST_SERVICE_PLUGIN_NAME = 'dsh-desktop-host-services-smoke-plugin'
const HOST_SERVICE_PROBE_KEY = 'desktopHostServiceProbe'
const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-'))
let ctx
let releasePackageResolver
let pnpmRuntime
let mountedSpec
let nativeThemeSource = 'system'
const trayItems = []

try {
  writeFileSync(join(home, 'settings.yaml'), [
    'dsh-desktop:',
    '  mode: advanced',
    'agent-presets:',
    '  default: minimal',
    '',
  ].join('\n'))
  const prepared = prepareDesktopProfile('1', home, 'win32')
  const hostServicePluginDir = join(
    prepared.profile.dir,
    'node_modules',
    HOST_SERVICE_PLUGIN_NAME,
  )
  mkdirSync(join(prepared.profile.dir, 'node_modules'), { recursive: true })
  cpSync(
    fileURLToPath(new URL('../tests/fixtures/desktop-host-services-smoke-plugin/', import.meta.url)),
    hostServicePluginDir,
    { recursive: true, force: false, errorOnExist: true },
  )
  const patches = [
    // Deliberately compose the consumer before the desktop-pnpm provider row.
    // Its required injection must keep it pending until that service mounts.
    {
      insert: [{
        id: 'desktop-host-services-smoke-plugin',
        name: HOST_SERVICE_PLUGIN_NAME,
      }],
    },
    ...prepared.patches,
  ]
  const packageRoot = new URL('../', import.meta.url)
  const pnpmBinPath = fileURLToPath(new URL('node_modules/pnpm/bin/pnpm.mjs', packageRoot))
  const electronVersion = JSON.parse(
    readFileSync(new URL('node_modules/electron/package.json', packageRoot), 'utf8'),
  ).version
  pnpmRuntime = installDesktopPnpmRuntime({
    platform: process.platform,
    appExecutable: process.execPath,
    pnpmBinPath,
    electronVersion,
    stateDir: join(home, 'runtime-commands'),
    environment: process.env,
  })
  releasePackageResolver = installProfilePackageResolver(prepared.bareModuleBaseUrl)
  const runtime = {
    platform: 'win32',
    locale: 'en',
    updates: {
      isPackaged: false,
      canDownload: true,
      currentVersion: '2.0.0',
      statePath: join(home, 'update-state.json'),
      request: async () => { throw new Error('profile smoke must not perform update requests') },
      confirmDownload: async () => false,
      showManualCheckResult: async () => {},
      downloadAndOpen: async () => {},
      notify: () => {},
    },
    schedule(spec) {
      mountedSpec = spec
      return async () => {}
    },
    async mountScheduled() {
      if (mountedSpec === undefined) throw new Error('desktop shell was not registered')
      runtime.setLocalePreference(mountedSpec.readLocalePreference())
      nativeThemeSource = mountedSpec.readThemeSource()
    },
    show() {},
    registerTrayItem(item) {
      trayItems.push(item)
      return {
        refresh() {},
        dispose() {
          const index = trayItems.indexOf(item)
          if (index >= 0) trayItems.splice(index, 1)
        },
      }
    },
    openTerminal() {},
    setLocalePreference(preference) { runtime.locale = preference ?? 'en' },
    setThemeSource(source) { nativeThemeSource = source },
    async requestRestart() {},
    prepareToQuit() {},
  }
  ctx = await boot(
    BIN_NAME,
    prepared.rootConfig,
    patches,
    async (host) => {
      host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([]))
      host.provide('desktopRuntime', runtime)
      host.provide('desktopPnpmBootstrap', {
        activeProfileName: 'desktop',
        activeProfileDir: prepared.profile.dir,
        homeDir: prepared.homeDir,
        appExecutable: process.execPath,
        pnpmBinPath,
        electronVersion,
        nodeBinDir: pnpmRuntime.nodeBinDir,
        nodeShimPath: pnpmRuntime.nodeShimPath,
        clearEnvironmentPath: pnpmRuntime.clearEnvironmentPath,
        dshBootstrapPath: fileURLToPath(new URL('../lib/desktop-cli.js', import.meta.url)),
        installRecoveryStatePath: join(home, 'plugin-install-recovery', 'state.json'),
        generationId: 'profile-smoke-generation',
        externalMarketInstallEnabled: prepared.market.effective === 'dsh-market',
      })
      await host.plugin(DesktopProfileService, {
        current: {
          name: 'desktop',
          dir: prepared.profile.dir,
        },
        list: () => [{
          name: 'desktop',
          dir: prepared.profile.dir,
          exists: true,
          bundles: prepared.profile.layers.map(layer => layer.packageName),
          webCapable: true,
        }],
        persistSelection: () => {},
        requestRestart: () => {},
      })
      provideCmdline(host, {
        args: ['--host', '127.0.0.1', '--port', '0'],
        exit: () => {},
      })
    },
    prepared.bareModuleBaseUrl,
  )
  await runtime.mountScheduled()

  if (ctx.get('desktopPnpm') === undefined) {
    throw new Error('assembled desktop profile is missing the desktop pnpm Host capability')
  }
  if (ctx.desktopProfiles.current.name !== 'desktop'
    || ctx.desktopProfiles.current.dir !== prepared.profile.dir) {
    throw new Error('assembled desktop profile service has the wrong active identity')
  }
  const agentPresets = ctx.get('agentPresets')
  if (agentPresets === undefined) {
    throw new Error('assembled Windows profile is missing the agent preset roster')
  }
  const presetIds = (await agentPresets.list()).map(preset => preset.id)
  if (presetIds.includes('minimal') || !presetIds.includes('standard')) {
    throw new Error(`assembled Windows profile exposes unexpected presets: ${presetIds.join(', ')}`)
  }
  if (agentPresets.defaultId !== 'standard') {
    throw new Error(`assembled Windows profile selected unsupported default ${agentPresets.defaultId}`)
  }
  const legacyPreset = await agentPresets.resolve('minimal')
  if (legacyPreset.id !== 'minimal') {
    throw new Error(`assembled Windows profile remapped legacy preset to ${legacyPreset.id}`)
  }
  const hostServiceProbe = ctx.get(HOST_SERVICE_PROBE_KEY)
  if (hostServiceProbe?.current?.name !== 'desktop'
    || hostServiceProbe.current.dir !== prepared.profile.dir
    || hostServiceProbe.pnpm?.serviceName !== 'desktopPnpm'
    || hostServiceProbe.pnpm.lookupRun !== 'function'
    || hostServiceProbe.pnpm.run !== 'function'
    || hostServiceProbe.pnpm.runPlugin !== 'function'
    || hostServiceProbe.pnpm.installPlugin !== 'function'
    || hostServiceProbe.pnpm.recoveredInstallReceiptIds !== 'function'
    || hostServiceProbe.pnpm.acknowledgeRecoveredInstall !== 'function'
    || hostServiceProbe.pnpm.rollbackPluginInstall !== 'function') {
    throw new Error(
      `profile-local Host service plugin produced an unexpected probe: ${JSON.stringify(hostServiceProbe)}`,
    )
  }

  // The model-facing tools this product adds live in the global tool layer, so
  // they reach an agent whatever preset it composed from. Each is one config row
  // away from silently vanishing: `web_fetch` needs its host `tool-web` row
  // re-enabled against dsh-web-app's disable, and a patch aimed at a row this
  // composition never mounts is dead config that nothing else reports.
  const toolNames = new Set(ctx.tools.schemas().map(schema => schema.name))
  for (const name of ['image_generate', 'video_generate', 'web_fetch']) {
    if (!toolNames.has(name)) {
      throw new Error(
        `assembled desktop profile offers no ${name} tool (global tools: ${[...toolNames].join(', ')})`,
      )
    }
  }
  // Search stays preset-owned: a second, global registration would add a prompt
  // section that contradicts the preset's own guidance.
  if (toolNames.has('web_search')) {
    throw new Error('assembled desktop profile registers web_search globally instead of per preset')
  }

  // Both halves of the fetch guard, judged by behaviour rather than by reading
  // which provider id got selected: that field is TypeScript-private, and every
  // way the row can go wrong shows up here anyway. This page is HTML and the
  // server is live, so the unguarded provider answers it 200 — a wrong or
  // missing pin fails with the seam's own code, not with WEB_BLOCKED_URL.
  const loopbackPage = `http://127.0.0.1:${String(ctx.webServer.port)}/`
  try {
    await ctx.web.fetch({ url: loopbackPage })
    throw new Error(`guarded fetch retrieved the loopback Web root at ${loopbackPage}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('guarded fetch retrieved')) throw error
    const code = error?.code
    if (code !== 'WEB_BLOCKED_URL') {
      throw new Error(
        `loopback fetch failed with ${String(code)} (${error instanceof Error ? error.message : String(error)}) instead of WEB_BLOCKED_URL`,
      )
    }
  }

  // The other half through the real tool pipeline, which is where a guard that
  // never registered would show up: the registry runs it after pre-execute
  // policy, and the reason has to reach the model as the call's error text.
  // `2130706433` is the same target spelled the way a model probes around a
  // string check; WHATWG parsing folds it before the classifier sees it.
  for (const url of [loopbackPage, 'http://2130706433/']) {
    const outcome = await ctx.tools.execute({
      callId: `profile-smoke-web-fetch-${encodeURIComponent(url)}`,
      name: 'web_fetch',
      arguments: { url },
      signal: AbortSignal.timeout(30_000),
    })
    const text = JSON.stringify(outcome.error ?? outcome.value ?? null)
    if (!outcome.isError || !text.includes('not a public HTTP(S) target')) {
      throw new Error(`web_fetch of ${url} was not refused by the tool guard: ${text}`)
    }
  }

  const picker = ctx.directoryPicker.capability()
  if (picker.kind !== 'browse') {
    throw new Error(`assembled Windows profile selected ${picker.kind} directory picker`)
  }
  const listing = await picker.list(home)
  if (listing.path !== home) {
    throw new Error(`assembled Windows browse picker listed ${listing.path} instead of ${home}`)
  }

  const expectedUrl = `http://127.0.0.1:${String(ctx.webServer.port)}/?dsh-desktop-mode=advanced&dsh-desktop-platform=win32`
  if (mountedSpec?.url !== expectedUrl) {
    throw new Error(`desktop plugin produced an unexpected renderer URL: ${String(mountedSpec?.url)}`)
  }
  if (mountedSpec?.mode !== 'advanced') {
    throw new Error(`desktop plugin produced an unexpected shell mode: ${String(mountedSpec?.mode)}`)
  }
  if (nativeThemeSource !== 'system') {
    throw new Error(`desktop plugin produced an unexpected native theme source: ${nativeThemeSource}`)
  }
  const desktopSettings = ctx.settings.get(DESKTOP_SETTINGS_NAMESPACE)
  if (desktopSettings?.mode !== 'advanced') {
    throw new Error('assembled Host settings are missing the advanced dsh-desktop mode')
  }
  // See cordis.patch.yml: this fork composes no update row, so the endpoints
  // baked into update-checker.ts/update-download.ts stay unreachable and the
  // tray must not offer the command until our own release service exists.
  if (trayItems.some(item => item.label() === 'Check for Updates…')) {
    throw new Error('assembled desktop profile offers the upstream update tray command')
  }
  if (process.platform !== 'linux'
    && !trayItems.some(item => item.label() === 'Open DSH Terminal')) {
    throw new Error('assembled desktop profile is missing the terminal tray command')
  }
  const profileMenu = trayItems.find(item => item.label() === 'Profile: desktop')
  if (profileMenu?.submenu?.()[0]?.label() !== 'desktop') {
    throw new Error('assembled desktop profile is missing the active profile tray submenu')
  }
  const response = await fetch(expectedUrl)
  const html = await response.text()
  if (response.status !== 200) {
    throw new Error(`assembled Web root returned HTTP ${String(response.status)}`)
  }
  // The index tap is the only thing standing between a user and the upstream
  // product name: the compatibility titlebar, the taskbar tooltip, and every
  // per-session title all read whatever the served document says.
  if (!html.includes('<title>OpenLux</title>') || html.includes('DeepSeek Harness')) {
    throw new Error('assembled Web root serves the upstream product identity')
  }
  const mark = await fetch(new URL('/openlux/brand-mark.png', expectedUrl))
  if (mark.status !== 200 || mark.headers.get('content-type') !== 'image/png') {
    throw new Error(`assembled Web root does not serve the brand mark (HTTP ${String(mark.status)})`)
  }
  if ((await mark.bytes()).byteLength === 0) {
    throw new Error('assembled Web root serves an empty brand mark')
  }
  const bootMatch = html.match(/(?:window\.__DSH_BOOT__|globalThis\["__DSH_BOOT__"\]) = (\{.*?\})<\/script>/u)
  if (bootMatch?.[1] === undefined) {
    throw new Error('assembled Web root is missing window.__DSH_BOOT__')
  }
  const graph = JSON.parse(bootMatch[1])
  const ids = new Set(graph.entries.map(entry => entry.id))
  for (const id of [
    'dsh-plugin-desktop',
    // Our sign-in, balance, and market surfaces ride the ordinary Web module
    // graph. Dropping out of it costs the whole account face with no error.
    'openlux-plugin-account',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-directory-picker-browse',
  ]) {
    if (!ids.has(id)) throw new Error(`assembled advanced Web graph is missing ${id}`)
  }
  for (const id of [
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-directory-picker-native',
  ]) {
    if (ids.has(id)) throw new Error(`assembled advanced Web graph unexpectedly includes ${id}`)
  }
} finally {
  await ctx?.fiber.dispose()
  releasePackageResolver?.()
  pnpmRuntime?.dispose()
  rmSync(home, { recursive: true, force: true })
}
