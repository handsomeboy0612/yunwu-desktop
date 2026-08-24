/**
 * Market catalog: browse and install one entry.
 *
 * Lives inside the frame overlay (`MarketOverlay`), not a settings section.
 * The kernel still has no page route — WorkBuddy's expert center is a full
 * window we cannot claim — so the carrying surface is `shell.overlay`, the
 * same seat DSH Desktop's community-market panel uses. This file is the
 * catalog body; the launcher and chrome sit outside it.
 *
 * The overlay panel is 800px, so the grid is three cards rather than the two
 * the old 564px settings column forced. Category filters stay a wrapping chip
 * row.
 *
 * ## What this surface does not do
 *
 * Uninstall, set default, read a composition, deal with a broken row: all of
 * that already exists on the kernel's Agent-presets page, and a second owner
 * would be a second answer. This one browses and installs.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Button, Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  Catalog, CatalogFailure, CatalogItem, CatalogType, ConnectorAuthorizationStart,
  ConnectorAuthorizationState, ConnectorRequirement, ConnectorTarget, CustomConnectorSync,
  CustomOpen, InstallOutcome, InstallTarget, InstalledConnector, InstalledPreset, RemountOutcome,
  SkillTarget,
} from '../market/wire.ts'
import { pickSkillDirectory } from './skill-pick.ts'
import { connectorRow } from './connector-rows.ts'
import { MarketCard, describe, type CardState } from './MarketCard.tsx'
import {
  ConnectorToken, CustomConnector, MarketConfirm, MarketDetail, MarketOutcome,
} from './MarketDialogs.tsx'
import { MyExperts } from './MyExperts.tsx'
import type { SummonRequest } from './summon.ts'
import type { AccountHostCaller } from './types.ts'

/** DOM marker the live checks look for. */
export const MARKET_SECTION_ID = 'openlux-market'

/** What the catalog needs from the plugin body. */
export interface MarketSectionInjected {
  readonly callHost: AccountHostCaller
  /** Active locale, read at render time so a switch needs no refetch. */
  readonly language: () => 'zh' | 'en'
  /**
   * Land an installed preset on a new session with its opening question in the
   * composer.
   *
   * Absent in the basic desktop composition, which has no conversation flow to
   * land in; the gallery then installs and says where the preset went, which is
   * all that surface can act on.
   */
  readonly summon?: (request: SummonRequest) => void
  /**
   * Dismiss the overlay after a summon, so the new session is not sitting
   * behind a dialog. Overlay chrome owns this; the catalog does not close
   * itself on install-only (no session to land in).
   */
  readonly onDismiss?: () => void
  /**
   * When false, the overlay already printed the title and intro, so this
   * body skips them. Default true for any standalone mount.
   */
  readonly showChrome?: boolean
}

/**
 * The kernel preset that writes presets.
 *
 * Shipped, not ours: `@deepseek-ai/dsh/config/agent-presets/cordis/preset.yml`
 * declares 创造模式, and the kernel's own «create a preset» entry (the settings
 * section in `ui-agent-preset`) stages this exact id. Hardcoding it is what
 * that entry does too — there is one authoring mode, and a deployment without
 * it simply has no roster row to select, which the summon reports.
 */
const AUTHORING_PRESET = 'cordis'

/** How often the gallery asks the host whether the browser has come back. */
const AUTHORIZE_POLL_MS = 1500

/** Matches the host listener's own patience, so neither side gives up alone. */
const AUTHORIZE_TIMEOUT_MS = 5 * 60 * 1000

/** Which half of the roster the user is looking at. */
type Kind = 'all' | 'agent' | 'team'

/**
 * Which partition the gallery is showing.
 *
 * The same three the console partitions its catalog into, and the same three
 * tabs the product we are aligned with puts across the top of its market
 * (`unifiedMarket.tab.experts` / `.skills` / `.connectors`). What each install
 * writes differs — a preset directory, a skill directory, a live plugin entry —
 * but what the user is doing does not, so it is one frame.
 */
const TABS = ['expert', 'skill', 'connector'] as const

/** One of {@link TABS}. */
type Tab = typeof TABS[number]

/** Which tab's copy a key belongs to. */
const TAB_COPY = {
  expert: { name: 'tabExperts', intro: 'intro', search: 'searchPlaceholder' },
  skill: { name: 'tabSkills', intro: 'introSkill', search: 'searchSkillPlaceholder' },
  connector: { name: 'tabConnectors', intro: 'introConnector', search: 'searchConnectorPlaceholder' },
} as const

/** A connect waiting on the secret its manifest asks for. */
interface PendingToken {
  readonly item: CatalogItem
  readonly requirement: ConnectorRequirement
  readonly value: string
}

/** The custom-connector panel, open with whatever the last re-read said. */
interface CustomState {
  readonly busy: boolean
  /** What the OS did with the file, absent until the opener was pressed. */
  readonly handoff?: CustomOpen['did']
  readonly sync?: CustomConnectorSync
}

/** A summon waiting on the install confirmation. */
interface PendingSummon {
  readonly item: CatalogItem
  /** The question the user pressed, else the expert's own opening one. */
  readonly prompt?: string
}

const styles = {
  root: { display: 'flex', flexDirection: 'column', gap: '12px' },
  title: { color: 'var(--dsw-alias-label-primary)', fontSize: '15px', fontWeight: 600 },
  intro: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: 1.6 },
  tabs: {
    display: 'flex', alignItems: 'center', gap: '4px',
    borderBottom: '1px solid var(--dsw-alias-border-l1)',
  },
  tab: {
    padding: '6px 10px', border: 'none', background: 'transparent', cursor: 'pointer',
    color: 'var(--dsw-alias-label-secondary)', fontSize: '13px', fontWeight: 500,
    // The underline sits on the row's own bottom border, so the inactive tab
    // reserves the same two pixels and nothing shifts when it becomes active.
    borderBottom: '2px solid transparent', marginBottom: '-1px',
  },
  tabActive: {
    padding: '6px 10px', border: 'none', background: 'transparent', cursor: 'pointer',
    color: 'var(--dsw-alias-label-primary)', fontSize: '13px', fontWeight: 600,
    borderBottom: '2px solid var(--dsw-alias-label-primary)', marginBottom: '-1px',
  },
  tabFill: { flex: 1 },
  filters: { display: 'flex', flexDirection: 'column', gap: '8px' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
  grid: {
    display: 'grid',
    // Three columns in the 800px overlay panel, without hardcoding that width.
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: '12px',
    alignItems: 'stretch',
  },
  status: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
  failure: { display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
  stale: {
    padding: '1px 5px', borderRadius: '4px', fontSize: '11px',
    background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-tertiary)',
  },
  skeleton: {
    height: '148px', borderRadius: '10px',
    border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)',
  },
} satisfies Record<string, CSSProperties>

/**
 * Say why the catalog read failed, in the language the reader picked.
 *
 * The host reports the reason as data and the sentence is written here, because
 * the host has no idea which locale this window is in — the earlier shape had
 * the host write Chinese prose and this side prefix its own, which read as the
 * same words twice and stayed Chinese in an English window.
 * @param failure - the host's structured reason.
 * @param t - this section's copy.
 * @returns one sentence for the failure row.
 */
function failureText(failure: CatalogFailure, t: TranslateNS<'openlux.market'>): string {
  switch (failure.kind) {
    case 'signed-out': return t('failedSignedOut')
    case 'http': return t('failedHttp', { status: failure.status })
    case 'refused': return t('failedRefused', { message: failure.message })
    case 'transport': return t('failedTransport', { message: failure.message })
  }
}

/**
 * Render the market section.
 * @param props - the shell's owner share, the injected face, and `t`.
 * @returns the section content.
 */
export function MarketSection(
  props: PropsLocale<'openlux.market'> & MarketSectionInjected,
): ReactNode {
  const { callHost, language, summon, onDismiss, showChrome = true, t } = props
  const active = language()

  const [tab, setTab] = useState<Tab>('expert')
  // The «我的专家» subpage takes the whole body when it is open, which is what
  // it does in WorkBuddy (`ec-topbar--subpage`).
  const [mine, setMine] = useState(false)
  // One catalog per partition, kept after a switch: they are separate reads of
  // a console route that answers per type, and re-reading on every tab press
  // would spend a request to redraw what the window already had.
  //
  // `undefined` is "not read yet" and an empty item list is "read, and empty" —
  // the two render differently, so a boolean flag would lose the distinction.
  const [catalogs, setCatalogs] = useState<Partial<Record<Tab, Catalog>>>({})
  const [target, setTarget] = useState<InstallTarget | null>(null)
  const [skills, setSkills] = useState<SkillTarget | null>(null)
  const [connectors, setConnectors] = useState<ConnectorTarget | null>(null)
  const [reading, setReading] = useState(false)

  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<Kind>('all')
  const [category, setCategory] = useState(0)
  const catalog = catalogs[tab] ?? null

  const [detail, setDetail] = useState<CatalogItem | undefined>()
  // The confirmation carries the question that opened it, not just the row: the
  // user may have pressed one of the detail sheet's suggestions, and consenting
  // to the install must not silently swap it for the expert's default one.
  const [pending, setPending] = useState<PendingSummon | undefined>()
  // The connector half of the same idea: a secret is asked for once, in a
  // dialog that names which connector is about to receive it.
  const [token, setToken] = useState<PendingToken | undefined>()
  // The user's own servers: one open panel, and the last re-read of their file.
  const [custom, setCustom] = useState<CustomState | undefined>()
  const [installing, setInstalling] = useState<string | undefined>()
  const [outcome, setOutcome] = useState<{ item: CatalogItem; outcome: InstallOutcome } | undefined>()
  // Opening questions per slug, asked once each: the manifest is a per-item
  // read the catalog snapshot deliberately withholds.
  const [prompts, setPrompts] = useState<Record<string, readonly string[]>>({})

  /** Re-read what is installed for one partition; the card state derives from it. */
  const readInstalled = useCallback(async (which: Tab): Promise<void> => {
    if (which === 'skill') {
      const held = await callHost<SkillTarget>('market.skills', {})
      if (held.ok) setSkills(held.value)
      return
    }
    if (which === 'connector') {
      const live = await callHost<ConnectorTarget>('market.connectors', {})
      if (live.ok) setConnectors(live.value)
      return
    }
    const where = await callHost<InstallTarget>('market.target', {})
    if (where.ok) setTarget(where.value)
  }, [callHost])

  const read = useCallback(async (which: Tab): Promise<void> => {
    setReading(true)
    const [rows] = await Promise.all([
      callHost<Catalog>('market.catalog', { type: which satisfies CatalogType }),
      readInstalled(which),
    ])
    setCatalogs(current => ({
      ...current,
      [which]: rows.ok
        ? rows.value
        : {
          kernelApi: '', items: [], categories: [],
          failure: { kind: 'transport', message: rows.error.message },
        },
    }))
    setReading(false)
  }, [callHost, readInstalled])

  // One read per partition, on first sight of it. A tab the user never opens
  // costs no request.
  useEffect(() => {
    if (catalogs[tab] !== undefined) return
    void read(tab)
  }, [tab, catalogs, read])

  const installedById = useMemo(() => {
    const map = new Map<string, InstalledPreset>()
    for (const preset of target?.installed ?? []) map.set(preset.id, preset)
    return map
  }, [target])

  const installedSkills = useMemo(
    () => new Set((skills?.installed ?? []).map(skill => skill.slug)),
    [skills],
  )

  const connectedBySlug = useMemo(() => {
    const map = new Map<string, InstalledConnector>()
    for (const row of connectors?.installed ?? []) map.set(row.slug, row)
    return map
  }, [connectors])

  const categories = catalog?.categories ?? []
  const categoryName = useCallback(
    (id: number) => categories.find(row => row.id === id)?.name ?? '',
    [categories],
  )

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (catalog?.items ?? []).filter(item => {
      // The expert / team split is a fact about experts; the skill partition has
      // no such halves, and its rows all carry `team: false`.
      if (tab === 'expert' && kind === 'team' && !item.team) return false
      if (tab === 'expert' && kind === 'agent' && item.team) return false
      if (category !== 0 && item.categoryId !== category) return false
      if (needle === '') return true
      const haystack = [item.name, item.slug, describe(item, active), ...item.tags].join(' ').toLowerCase()
      return haystack.includes(needle)
    })
  }, [catalog, query, kind, category, active, tab])

  /** Why one row cannot be installed, or undefined when it can. */
  const blockedReason = useCallback((item: CatalogItem): string | undefined => {
    // A connector has no artifact by design — its whole content is the MCP
    // configuration in its manifest, and the console stores those rows with no
    // archive at all (`service/desktop_market/seed.go`). So the artifact checks
    // below do not apply to it; what it needs instead is somewhere to mount.
    if (tab === 'connector') {
      return connectors !== null && !connectors.mountable ? t('connectorNotMountable') : undefined
    }
    // Only presets need a writable roster root. A skill lands in the kernel's
    // watched user skill root, which is a plain directory: a deployment without
    // an authorable preset root can still install one.
    if (tab === 'expert' && target !== null && !target.authorable) return t('notAuthorable')
    if (item.unavailable === 'bad-id') return t('unavailableBadId')
    if (item.unavailable === 'no-artifact' || item.artifact === undefined) {
      return t('unavailableNoArtifact', { kernelApi: catalog?.kernelApi ?? '' })
    }
    return undefined
  }, [tab, target, connectors, catalog, t])

  const stateOf = useCallback((item: CatalogItem): CardState => {
    if (tab === 'connector') {
      const connected = connectedBySlug.get(item.slug)
      const row = connectorRow(connected, installing === item.slug)
      if (row !== undefined) {
        if (row.kind === 'working') return { kind: 'installing' }
        // A connector that did not come up this launch is still connected — the
        // record is what "connected" means — so it keeps the installed state and
        // carries the reason, which is what the card turns into a tooltip.
        return row.kind === 'connected'
          ? { kind: 'installed' }
          : { kind: 'installed', broken: t('connectorOffline', { message: connected?.failure ?? '' }) }
      }
      if (installing === item.slug) return { kind: 'installing' }
      const blocked = blockedReason(item)
      return blocked === undefined ? { kind: 'ready' } : { kind: 'blocked', reason: blocked }
    }
    if (tab === 'skill') {
      if (installedSkills.has(item.slug)) return { kind: 'installed' }
      if (installing === item.slug) return { kind: 'installing' }
      const blocked = blockedReason(item)
      return blocked === undefined ? { kind: 'ready' } : { kind: 'blocked', reason: blocked }
    }
    const installed = installedById.get(item.slug)
    if (installed !== undefined) {
      return installed.broken === undefined
        ? { kind: 'installed' }
        : { kind: 'installed', broken: installed.broken }
    }
    if (installing === item.slug) return { kind: 'installing' }
    const reason = blockedReason(item)
    return reason === undefined ? { kind: 'ready' } : { kind: 'blocked', reason }
  }, [tab, installedById, installedSkills, connectedBySlug, installing, blockedReason, t])

  const install = useCallback(async (item: CatalogItem): Promise<InstallOutcome | undefined> => {
    if (item.artifact === undefined) return undefined
    setInstalling(item.slug)
    const result = await callHost<InstallOutcome>('market.install', {
      id: item.slug,
      name: item.name,
      // The roster shows one line, and the console writes the Chinese one for
      // this audience; the gallery's own locale switch does not reach a file on
      // disk, so the picked language cannot follow the user afterwards.
      description: item.descriptionZh === '' ? item.descriptionEn : item.descriptionZh,
      // The item, not a link: the host signs its own download URL, because a
      // renderer choosing where the main process connects is an SSRF sink.
      // The partition, not the visible filter: `tab` says which catalog this row
      // came from, while `kind` is which half of the experts is on screen.
      type: tab satisfies CatalogType,
      format: item.artifact.format,
      sha256: item.artifact.sha256,
      itemId: item.slug,
      ...item.version === '' ? {} : { version: item.version },
      kernelApi: item.artifact.kernelApi,
    })
    setInstalling(undefined)
    setPending(undefined)
    const outcome: InstallOutcome = result.ok
      ? result.value
      // A transport fault is not one of the host's refusals, but the user's
      // next move is the same, so it arrives in the same dialog rather than
      // as a silent no-op.
      : { kind: 'refused', reason: 'download-failed', message: result.error.message }
    // The roster (or the skill root) decides what "installed" means, so re-read
    // it rather than assuming this install landed.
    await readInstalled(tab)
    return outcome
  }, [callHost, tab, readInstalled])

  /**
   * The opening questions one expert publishes, asked once per slug.
   *
   * An install carries them back with it and the roster keeps them in the
   * sidecar, so this read is for the two cases neither covers: a detail sheet
   * opened before installing, and a preset whose sidecar predates them.
   */
  const readPrompts = useCallback(async (slug: string): Promise<readonly string[]> => {
    const known = prompts[slug]
    if (known !== undefined) return known
    const reply = await callHost<{ prompts: readonly string[] }>('market.prompts', { id: slug })
    const rows = reply.ok ? reply.value.prompts : []
    setPrompts(current => ({ ...current, [slug]: rows }))
    return rows
  }, [callHost, prompts])

  /**
   * Leave the overlay for a new session running this expert.
   *
   * Only ever called for a preset that is already on disk, which is why it asks
   * nothing: no bytes are written, so there is nothing to consent to.
   * @param item - the expert.
   * @param prompt - a specific question, else the expert's own opening one.
   * @param carried - opening questions an install just brought back.
   */
  const enter = useCallback(async (
    item: CatalogItem,
    prompt: string | undefined,
    carried?: readonly string[],
  ): Promise<void> => {
    if (summon === undefined) return
    // Neither the install nor the sidecar had one: ask the console rather than
    // land on a blank composer for the sake of one read.
    const opening = prompt
      ?? carried?.[0]
      ?? installedById.get(item.slug)?.prompts?.[0]
      ?? (await readPrompts(item.slug))[0]
    setDetail(undefined)
    summon({ preset: item.slug, prompt: opening ?? '' })
    onDismiss?.()
  }, [summon, installedById, readPrompts, onDismiss])

  /**
   * Connect one connector, with the secret when it asked for one.
   *
   * The gallery never sends a command: it names the catalog row, and the host
   * reads what to spawn from the console's manifest. That is the same rule the
   * preset installs follow, for the same reason — a renderer choosing what the
   * main process runs is the sink, whether it runs a fetch or a process.
   */
  const connect = useCallback(async (item: CatalogItem, secret?: string): Promise<void> => {
    setInstalling(item.slug)
    const result = await callHost<InstallOutcome>('market.connectorInstall', {
      slug: item.slug,
      name: item.name,
      ...item.version === '' ? {} : { version: item.version },
      ...secret === undefined ? {} : { token: secret },
    })
    setInstalling(undefined)
    setToken(undefined)
    await readInstalled('connector')
    setOutcome({
      item,
      outcome: result.ok
        ? result.value
        : { kind: 'refused', reason: 'not-mountable', message: result.error.message },
    })
  }, [callHost, readInstalled])

  /**
   * Open the custom-connector panel, re-reading the file as it opens.
   *
   * The read happens on open rather than on a press, so the panel can answer
   * the question that brought the user here — «我上次写的那台起来了吗» — without
   * them having to ask for it.
   */
  const openCustom = useCallback(async (): Promise<void> => {
    setCustom({ busy: true })
    const result = await callHost<CustomConnectorSync>('market.connectorCustomSync', {})
    setCustom({ busy: false, ...result.ok ? { sync: result.value } : {} })
    await readInstalled('connector')
  }, [callHost, readInstalled])

  /** Re-read the file after the user edited it, and remount what changed. */
  const reloadCustom = useCallback(async (): Promise<void> => {
    setCustom(current => ({ ...current, busy: true }))
    const result = await callHost<CustomConnectorSync>('market.connectorCustomSync', {})
    setCustom({ busy: false, ...result.ok ? { sync: result.value } : {} })
    await readInstalled('connector')
  }, [callHost, readInstalled])

  /**
   * Hand the file to the OS.
   *
   * Neither of the two ways this can fall short is an error dialog: the panel
   * says which of the three things happened and keeps the path visible, which
   * is the thing the user needed in all three cases.
   */
  const openCustomFile = useCallback(async (): Promise<void> => {
    const result = await callHost<CustomOpen>('market.connectorCustomOpen', {})
    setCustom(current => ({
      ...current,
      busy: false,
      handoff: result.ok ? result.value.did : 'nothing',
      // The open call creates the file, so its path is the freshest one there is.
      ...result.ok ? { sync: { live: current?.sync?.live ?? 0, problems: current?.sync?.problems ?? [], path: result.value.path } } : {},
    }))
  }, [callHost])

  /**
   * Disconnect one connector.
   *
   * No confirmation, like removing a skill: it undoes what one press did, the
   * shelf still offers the row, and the host only accepts a slug it already has
   * a record for. A secret that came with it is dropped with the record.
   */
  const disconnect = useCallback(async (slug: string): Promise<void> => {
    await callHost<{ removed: boolean }>('market.connectorUninstall', { slug })
    await readInstalled('connector')
  }, [callHost, readInstalled])

  /**
   * Sign in to one connector through the browser, then connect it.
   *
   * The host runs the flow and answers with the page to open; opening it is
   * this half's job because a renderer's `window.open` is what the desktop
   * shell hands to `shell.openExternal`, and the host has no browser of its
   * own. The wait afterwards is a poll rather than a pushed event: the person
   * is in another window for as long as they take, and a request left hanging
   * across that is a request that times out.
   */
  const authorize = useCallback(async (
    item: CatalogItem,
    settle: (item: CatalogItem) => Promise<void>,
  ): Promise<void> => {
    const started = await callHost<ConnectorAuthorizationStart>('market.connectorAuthorize', {
      slug: item.slug,
    })
    if (!started.ok || started.value.kind === 'refused') {
      setInstalling(undefined)
      setOutcome({
        item,
        outcome: {
          kind: 'refused',
          reason: 'needs-authorization',
          message: started.ok ? started.value.message : started.error.message,
        },
      })
      return
    }
    window.open(started.value.url, '_blank', 'noopener,noreferrer')

    for (let waited = 0; waited < AUTHORIZE_TIMEOUT_MS; waited += AUTHORIZE_POLL_MS) {
      await new Promise((settle) => { setTimeout(settle, AUTHORIZE_POLL_MS) })
      const state = await callHost<ConnectorAuthorizationState>('market.connectorAuthorizeState', {
        slug: item.slug,
      })
      if (!state.ok || state.value.kind === 'pending') continue
      if (state.value.kind === 'authorized') {
        // The grant is stored, so whichever path the caller came in on now
        // finds a token: a first connect writes the record, a repair remounts
        // the record that is already there.
        setInstalling(undefined)
        await settle(item)
        return
      }
      setInstalling(undefined)
      setOutcome({
        item,
        outcome: {
          kind: 'refused',
          reason: 'needs-authorization',
          message: state.value.kind === 'failed' ? state.value.message : '授权被取消了。',
        },
      })
      return
    }
    setInstalling(undefined)
  }, [callHost])

  /**
   * Sign in again for a connector whose grant died, and put it back up.
   *
   * A repair rather than a reconnect: the record, the config and the MCP name
   * all stay, and only the token is replaced. Disconnecting first would have
   * reached the same place through the ordinary connect path, but a sign-in
   * the user then abandons would leave them with nothing where they used to
   * have a connector.
   */
  const repair = useCallback(async (item: CatalogItem): Promise<void> => {
    setDetail(undefined)
    setInstalling(item.slug)
    await authorize(item, async signedIn => {
      const result = await callHost<RemountOutcome>('market.connectorRemount', {
        slug: signedIn.slug,
      })
      setInstalling(undefined)
      await readInstalled('connector')
      // Only a failure is reported. A repair that worked says so by the row
      // going healthy, and a dialog on top of that would be one more press
      // between the user and the thing they came back to use.
      if (result.ok && result.value.kind === 'mounted') return
      setOutcome({
        item: signedIn,
        outcome: {
          kind: 'refused',
          reason: 'needs-authorization',
          message: result.ok ? result.value.message : result.error.message,
        },
      })
    })
  }, [authorize, callHost, readInstalled])

  /**
   * Ask the host what this connector needs, then either connect or ask the user.
   *
   * The manifest read happens on the press rather than for the whole shelf: it
   * is one console round trip per item, and most rows answer "nothing".
   */
  const beginConnect = useCallback(async (item: CatalogItem): Promise<void> => {
    setDetail(undefined)
    setInstalling(item.slug)
    const reply = await callHost<ConnectorRequirement>('market.connectorRequirement', {
      slug: item.slug,
    })
    if (!reply.ok) {
      setInstalling(undefined)
      setOutcome({
        item,
        outcome: { kind: 'refused', reason: 'bad-manifest', message: reply.error.message },
      })
      return
    }
    const requirement = reply.value
    if (requirement.refusal !== undefined) {
      setInstalling(undefined)
      setOutcome({
        item,
        outcome: {
          kind: 'refused',
          // The mode decides which refusal this is, because that is what the
          // user can act on. `oauth` reaching here is the local-process case
          // only — a sign-in that has nowhere to put its token — since a remote
          // one is now started rather than refused.
          reason: requirement.mode === 'oauth' ? 'unsupported-auth' : 'bad-manifest',
          message: requirement.refusal,
        },
      })
      return
    }
    // A connector already signed in to connects like any other: the token is in
    // the credential seam and the host looks it up by slug.
    if (requirement.mode === 'oauth' && requirement.authorized !== true) {
      // Left spinning on purpose — the browser is about to take over, and the
      // row has to keep saying something is in progress until it comes back.
      await authorize(item, connect)
      return
    }
    setInstalling(undefined)
    if (requirement.mode === 'token') {
      setToken({ item, requirement, value: '' })
      return
    }
    await connect(item)
  }, [authorize, callHost, connect])

  /**
   * The card's primary action.
   *
   * Installed rows summon on the single click WorkBuddy's expert center has —
   * nothing lands on disk, so nothing is asked. A row that is not installed yet
   * keeps the confirmation, and not out of caution of ours: a `user` preset
   * "carries the same trust as shell access" in the kernel's own words
   * (`agent-presets/src/preset.ts`), and our composed compositions carry `!!js`.
   * So the first summon of an expert costs one confirmation, and every summon
   * after it costs none.
   * @param item - the row the user pressed.
   * @param prompt - a specific question (a detail-sheet suggestion).
   */
  const primary = useCallback(async (item: CatalogItem, prompt?: string): Promise<void> => {
    // A skill installs on the press, with no consent step. The dialog exists for
    // presets because a `user` preset "carries the same trust as shell access"
    // in the kernel's own words, and ours carry `!!js`; a skill is instructions
    // the model may read, which is the same trust as any document in the
    // workspace. The product we are aligned with installs skills on one click
    // for the same reason.
    if (tab === 'skill') {
      setDetail(undefined)
      const result = await install(item)
      if (result !== undefined) setOutcome({ item, outcome: result })
      return
    }
    // A connector asks the host what it needs before anything is written; the
    // consent step, when there is one, is the token dialog.
    if (tab === 'connector') {
      await beginConnect(item)
      return
    }
    if (installedById.has(item.slug)) {
      await enter(item, prompt)
      return
    }
    setPending(prompt === undefined ? { item } : { item, prompt })
  }, [tab, install, beginConnect, installedById, enter])

  /**
   * Install the row the confirmation is asking about, then go where the user was
   * headed: into the session when this window has one, or to the outcome dialog
   * when installing was the whole errand.
   */
  const confirm = useCallback(async (request: PendingSummon): Promise<void> => {
    const result = await install(request.item)
    if (result === undefined) return
    if (result.kind !== 'installed' || summon === undefined) {
      setOutcome({ item: request.item, outcome: result })
      return
    }
    await enter(request.item, request.prompt, result.prompts)
  }, [install, summon, enter])

  /**
   * Delete one installed skill.
   *
   * Straight through, with no confirmation: what is undone is exactly what one
   * press did a moment ago, the shelf still holds the row to install again, and
   * the host refuses anything that is not a slug directly under the skill root.
   */
  const removeSkill = useCallback(async (slug: string): Promise<void> => {
    await callHost<{ removed: boolean }>('market.skillRemove', { slug })
    await readInstalled('skill')
  }, [callHost, readInstalled])

  /**
   * Import a skill directory from disk («从本地添加技能»).
   *
   * The refusals are the picker's own, which is why they are shaped here rather
   * than in the host: "you cancelled" and "this window cannot resolve a path"
   * never reach the host at all.
   */
  const addLocalSkill = useCallback(async (): Promise<void> => {
    const pick = await pickSkillDirectory()
    if (pick.kind === 'cancelled') return
    const placeholder: CatalogItem = {
      slug: 'local', name: t('skillLocalTitle'), descriptionZh: '', descriptionEn: '',
      version: '', icon: '', categoryId: 0, tags: [], team: false, featured: false, downloads: 0,
    }
    if (pick.kind === 'unsupported') {
      setOutcome({
        item: placeholder,
        outcome: { kind: 'refused', reason: 'invalid-id', message: t('skillLocalUnsupported') },
      })
      return
    }
    setInstalling('local')
    const result = await callHost<InstallOutcome>('market.skillImport', { path: pick.path })
    setInstalling(undefined)
    await readInstalled('skill')
    const outcome: InstallOutcome = result.ok
      ? result.value
      : { kind: 'refused', reason: 'bad-archive', message: result.error.message }
    setOutcome({
      // The skill names itself: the id in the outcome is what the front matter
      // declared, which is what the model will see it as.
      item: outcome.kind === 'installed' ? { ...placeholder, name: outcome.id } : placeholder,
      outcome,
    })
  }, [callHost, readInstalled, t])

  /**
   * Land on an expert that is already on disk.
   *
   * Straight to the summon: the opening question rides in the sidecar the
   * install wrote, and a preset whose sidecar predates them lands on a clean
   * composer rather than spending a console read on a page that exists to be
   * quick.
   */
  const summonInstalled = useCallback((preset: InstalledPreset): void => {
    if (summon === undefined) return
    summon({ preset: preset.id, prompt: preset.prompts?.[0] ?? '' })
    onDismiss?.()
  }, [summon, onDismiss])

  /**
   * Start writing an expert.
   *
   * The same act as a summon, aimed at the preset whose job is authoring: the
   * kernel ships `cordis` («创造模式 — 用于创建自定义 Agent preset：具备标准
   * 模式的全部能力，并提供运行时检查、插件实验和 preset 创作指导»), so this
   * lands the user in a blank session with that composition, holding the
   * opening line WorkBuddy prefills here. Its button passes no prompt of its
   * own, but the create mode behind it fills the gap
   * (`payload.defaultPrompt ?? getDefaultCreateExpertPrompt(locale)`), so the
   * user always arrives at a fill-in-the-blanks sentence rather than a blank
   * box: naming the trade and the experience is exactly what the authoring
   * agent has to ask for first.
   */
  const createExpert = useCallback((): void => {
    if (summon === undefined) return
    summon({ preset: AUTHORING_PRESET, prompt: t('minePrompt') })
    onDismiss?.()
  }, [summon, onDismiss, t])

  /** Whether one row of the partition on screen is already in place. */
  const isInstalled = useCallback((slug: string): boolean => {
    if (tab === 'skill') return installedSkills.has(slug)
    return tab === 'connector' ? connectedBySlug.has(slug) : installedById.has(slug)
  }, [tab, installedSkills, connectedBySlug, installedById])

  const destination = target?.root === undefined || pending === undefined
    ? ''
    : `${target.root}\\${pending.item.slug}`
  const detailBlocked = detail === undefined ? undefined : blockedReason(detail)
  // The sidecar copy first: an installed expert answers this without a request.
  const detailPrompts = detail === undefined
    ? []
    : installedById.get(detail.slug)?.prompts ?? prompts[detail.slug] ?? []

  // Suggestions are only worth reading where they can be acted on, and only for
  // the one item whose sheet is open — the manifest is a per-item read.
  useEffect(() => {
    if (detail === undefined || summon === undefined) return
    // Opening questions are an expert's; a skill publishes none, and asking for
    // one would spend a per-item console read to be told so.
    if (tab !== 'expert') return
    if (detailPrompts.length > 0) return
    void readPrompts(detail.slug)
  }, [tab, detail, summon, detailPrompts, readPrompts])

  // A whole-body swap rather than a tab: the page has its own bar, and the
  // catalog's filters would say nothing about a roster read from disk. This is
  // the subpage switch WorkBuddy describes in its own stylesheet.
  if (mine) {
    return (
      <div style={styles.root} data-testid={MARKET_SECTION_ID}>
        <MyExperts
          installed={target?.installed ?? []}
          language={active}
          t={t}
          summonable={summon !== undefined}
          onSummon={summonInstalled}
          onCreate={createExpert}
          onBack={() => setMine(false)}
        />
      </div>
    )
  }

  return (
    <div style={styles.root} data-testid={MARKET_SECTION_ID}>
      {showChrome && (
        <>
          <span style={styles.title}>{t('title')}</span>
          <span style={styles.intro}>{t(TAB_COPY[tab].intro)}</span>
        </>
      )}

      <div style={styles.tabs} role="tablist">
        {TABS.map(id => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            data-testid={`openlux-market-tab-${id}`}
            style={tab === id ? styles.tabActive : styles.tab}
            onClick={() => {
              // Filters belong to the partition on screen: a category id from
              // the expert catalog means a different category in the skill one,
              // and carrying it over would show an empty grid for no reason.
              setTab(id)
              setCategory(0)
              setQuery('')
            }}
          >
            {t(TAB_COPY[id].name)}
          </button>
        ))}
        <span style={styles.tabFill} />
        {/*
          Beside the tabs, which is where WorkBuddy keeps it (`ec-topbar__right`,
          next to the search box). Only on the expert tab, because here that
          seat is per-partition — the skill tab keeps «添加技能» in it and the
          connector tab «自定义连接器» — and three buttons would crowd a row
          that is 800px wide at most.
        */}
        {tab === 'expert' && (
          <Button
            variant="ghost"
            size="sm"
            data-testid="openlux-market-mine-open"
            onClick={() => setMine(true)}
          >
            {t('mine')}
          </Button>
        )}
        {tab === 'skill' && (
          <Button
            variant="ghost"
            size="sm"
            disabled={installing !== undefined}
            data-testid="openlux-market-add-skill"
            onClick={() => { void addLocalSkill() }}
          >
            {t('skillAddLocal')}
          </Button>
        )}
        {/*
          Beside the tabs rather than among the cards, which is where WorkBuddy
          puts the same button (`ec-topbar__right`): what it opens is a file,
          and a card for a row this gallery cannot edit would be a lie.
        */}
        {tab === 'connector' && connectors?.mountable === true && (
          <Button
            variant="ghost"
            size="sm"
            data-testid="openlux-market-custom"
            onClick={() => { void openCustom() }}
          >
            {connectors.custom === 0
              ? t('customConnector')
              : t('customConnectorCount', { count: connectors.custom })}
          </Button>
        )}
      </div>

      <div style={styles.filters}>
        <Input
          value={query}
          placeholder={t(TAB_COPY[tab].search)}
          data-testid="openlux-market-search"
          onChange={event => setQuery(event.target.value)}
        />
        {tab === 'expert' && (
          <div style={styles.chips}>
            {([['all', 'kindAll'], ['agent', 'kindAgent'], ['team', 'kindTeam']] as const).map(([id, key]) => (
              <Pill key={id} active={kind === id} onClick={() => setKind(id)}>{t(key)}</Pill>
            ))}
          </div>
        )}
        {categories.length > 0 && (
          <div style={styles.chips}>
            <Pill active={category === 0} onClick={() => setCategory(0)}>{t('categoryAll')}</Pill>
            {categories.map(row => (
              <Pill key={row.id} active={category === row.id} onClick={() => setCategory(row.id)}>
                {row.name}
              </Pill>
            ))}
          </div>
        )}
      </div>

      {catalog?.stale === true && <span style={styles.stale}>{t('stale')}</span>}

      {/*
        What the model actually carries. The kernel renders one catalog line per
        skill on every request and caps only each description, so this number is
        a running cost rather than a curiosity — the person adding one more is
        entitled to see it.
      */}
      {tab === 'skill' && skills !== null && (
        <span style={styles.status} data-testid="openlux-market-skill-count">
          {t('skillActiveCount', { count: skills.installed.length })}
        </span>
      )}

      {/*
        Connector tools are registered globally, so every session — and every
        team member — sees them (`docs/dsh-kernel-migration.md`). Same reasoning
        as the skill count: what is connected is a standing cost, so it is shown
        rather than left to be discovered in a tool list.
      */}
      {tab === 'connector' && connectors !== null && (
        <span style={styles.status} data-testid="openlux-market-connector-count">
          {/* The live ones, not the recorded ones: the sentence is about tools
              being visible to the model, and a connector that did not come up
              contributes none. Its row still says so on the card. */}
          {t('connectorCount', { count: connectors.installed.filter(row => row.live).length })}
        </span>
      )}

      {catalog?.failure !== undefined && catalog.items.length === 0 && (
        <div style={styles.failure} data-testid="openlux-market-failure">
          <span>{failureText(catalog.failure, t)}</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={reading}
            data-testid="openlux-market-retry"
            onClick={() => { void read(tab) }}
          >
            {t('retry')}
          </Button>
        </div>
      )}

      {catalog === null && (
        <div style={styles.grid} aria-busy="true">
          {[0, 1, 2, 3].map(index => <div key={index} style={styles.skeleton} />)}
        </div>
      )}

      {catalog !== null && catalog.items.length > 0 && shown.length === 0 && (
        <span style={styles.status}>{t('empty')}</span>
      )}

      {catalog !== null && catalog.items.length === 0 && catalog.failure === undefined && (
        <span style={styles.status}>{t('emptyCatalog')}</span>
      )}

      {shown.length > 0 && (
        <div style={styles.grid}>
          {shown.map(item => (
            <MarketCard
              key={item.slug}
              item={item}
              state={stateOf(item)}
              language={active}
              t={t}
              // A skill is never summoned into a session: it is loaded by the
              // model when the task matches, so its button says "install" even
              // in a window that has a conversation.
              summonable={tab === 'expert' && summon !== undefined}
              {...tab === 'connector'
                ? {
                  words: {
                    primary: t('connect'),
                    busy: t('connecting'),
                    done: t('connected'),
                    unhealthy: t('connectorOfflineBadge'),
                  },
                }
                : {}}
              {...tab === 'skill' && installedSkills.has(item.slug)
                ? { onRemove: () => { void removeSkill(item.slug) }, removeLabel: t('skillRemove') }
                : {}}
              {...tab === 'connector' && connectedBySlug.has(item.slug)
                ? { onRemove: () => { void disconnect(item.slug) }, removeLabel: t('disconnect') }
                : {}}
              {...connectorRow(connectedBySlug.get(item.slug), installing === item.slug)?.repairable === true
                ? { onRepair: () => { void repair(item) }, repairLabel: t('connectorReauthorize') }
                : {}}
              onOpen={() => setDetail(item)}
              onPrimary={() => { void primary(item) }}
            />
          ))}
        </div>
      )}

      <MarketDetail
        item={detail}
        language={active}
        categoryName={detail === undefined ? '' : categoryName(detail.categoryId)}
        t={t}
        summonable={tab === 'expert' && summon !== undefined}
        installed={detail !== undefined && isInstalled(detail.slug)}
        prompts={detail === undefined ? [] : detailPrompts}
        {...detailBlocked === undefined ? {} : { blocked: detailBlocked }}
        {...detail === undefined || detailBlocked !== undefined
          ? {}
          : { onPrimary: (prompt?: string): void => { void primary(detail, prompt) } }}
        onClose={() => setDetail(undefined)}
      />

      <MarketConfirm
        item={pending?.item}
        path={destination}
        busy={installing !== undefined}
        summonable={summon !== undefined}
        t={t}
        onCancel={() => setPending(undefined)}
        onConfirm={() => { if (pending !== undefined) void confirm(pending) }}
      />

      <ConnectorToken
        item={token?.item}
        {...token?.requirement.label === undefined ? {} : { label: token.requirement.label }}
        value={token?.value ?? ''}
        busy={installing !== undefined}
        t={t}
        onChange={value => setToken(current => (current === undefined ? current : { ...current, value }))}
        onCancel={() => setToken(undefined)}
        onConfirm={() => { if (token !== undefined) void connect(token.item, token.value) }}
      />

      <CustomConnector
        open={custom !== undefined}
        {...custom?.sync === undefined ? {} : { sync: custom.sync }}
        busy={custom?.busy === true}
        {...custom?.handoff === undefined ? {} : { handoff: custom.handoff }}
        t={t}
        onOpenFile={() => { void openCustomFile() }}
        onReload={() => { void reloadCustom() }}
        onClose={() => setCustom(undefined)}
      />

      <MarketOutcome
        item={outcome?.item}
        outcome={outcome?.outcome}
        partition={tab}
        t={t}
        onClose={() => setOutcome(undefined)}
      />
    </div>
  )
}
