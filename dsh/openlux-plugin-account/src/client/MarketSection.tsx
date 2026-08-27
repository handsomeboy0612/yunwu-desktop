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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  Button, IconEditOutline16, IconFolderOpenOutline16, IconNewChatOutline16, IconPlusOutline16,
  IconSearchOutline16, IconSkillOutline16, IconTrashOutline16, Input, Menu, Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  Catalog, CatalogFailure, CatalogItem, CatalogType, ConnectorAuthorizationStart,
  ConnectorAuthorizationState, ConnectorRequirement, ConnectorTarget, CustomConnectorFile,
  CustomConnectorSave, CustomConnectorSync,
  CustomOpen, HomePlaybook, HomeShowcase, InstallOutcome, InstallTarget, InstalledConnector,
  InstalledPreset, InstalledSkill, PlaybookArtifact, RemountOutcome, SkillTarget,
} from '../market/wire.ts'
import type { MarketKey } from './market-locales.ts'
import { pickSkillDirectory } from './skill-pick.ts'
import { skillCreationDraft } from './skill-create.ts'
import { connectorRow } from './connector-rows.ts'
import { publishConnectorsLive } from './connector-live.ts'
import { takeMarketTab } from './market-open-request.ts'
import { FeaturedScenes } from './FeaturedScenes.tsx'
import { useHorizontalDrag, useHorizontalWheel } from './horizontal-scroll.ts'
import { MarketCard, describe, type CardState } from './MarketCard.tsx'
import {
  ConnectorToken, CustomConnector, MarketConfirm, MarketDetail, MarketOutcome,
} from './MarketDialogs.tsx'
import { MyExperts } from './MyExperts.tsx'
import { publishSkillLexicon } from './skill-lexicon.ts'
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

/** Market copy passed by the locale-owning overlay. */
type MarketTranslate = (key: MarketKey, params?: Record<string, unknown>) => string

/** The section is rendered directly by the overlay rather than by a slot. */
type MarketSectionProps = MarketSectionInjected & {
  readonly t: MarketTranslate
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

/**
 * How long a finished connector flow keeps the queue before the next one runs.
 *
 * WorkBuddy's connect queue is the model: one flow at a time
 * (`MAX_CONCURRENT_CONNECTS = 1`) with the slot released half a second late,
 * so two presses in a row cannot race two browser windows or two config
 * writes, and the row that queued second visibly waits its turn.
 */
const CONNECT_RELEASE_MS = 500

/** For settling the connect chain without caring how the turn ended. */
const noop = (): void => {}

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

/**
 * WorkBuddy keeps its expert first-page snapshot, featured scenes, and detail
 * projections in module-level Maps. Match that process-lifetime contract:
 * reopening the market reuses this snapshot; restarting the app creates a new
 * module instance and performs one fresh revalidation.
 */
interface MarketProcessSnapshot {
  readonly catalogs: Partial<Record<Tab, Catalog>>
  target?: InstallTarget
  skills?: SkillTarget
  connectors?: ConnectorTarget
  readonly prompts: Record<string, readonly string[]>
  readonly relatedCasesBySlug: Record<string, readonly HomePlaybook[]>
  featuredScenes?: readonly HomeShowcase[]
}

const marketProcessSnapshot: MarketProcessSnapshot = {
  catalogs: {},
  prompts: {},
  relatedCasesBySlug: {},
}

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

/** The custom-connector panel, open with whatever the last read said. */
interface CustomState {
  readonly busy: boolean
  /** What the OS did with the file, absent until the opener was pressed. */
  readonly handoff?: CustomOpen['did']
  /** The file's text for the in-app editor, read as the panel opened. */
  readonly file?: CustomConnectorFile
  readonly sync?: CustomConnectorSync
  /** Why the last save was refused, cleared by the next save or reopen. */
  readonly saveError?: string
}

/** A summon waiting on the install confirmation. */
interface PendingSummon {
  readonly item: CatalogItem
  /** The question the user pressed, else the expert's own opening one. */
  readonly prompt?: string
}

const styles = {
  root: {
    display: 'flex', flexDirection: 'column', gap: '12px',
    width: '100%', minWidth: 0, maxWidth: '100%', overflowX: 'hidden',
  },
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
  filters: {
    display: 'flex', flexDirection: 'column', gap: '8px',
    width: '100%', minWidth: 0, maxWidth: '100%',
  },
  // `contents` so the ref wrapper does not become a box of its own in the
  // column: the Input keeps sitting where it sat.
    searchRow: { display: 'flex', alignItems: 'center', gap: '8px' },
    searchGrow: { display: 'flex', flex: 1, minWidth: 0 },
  chips: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
  categoryWrap: {
    position: 'relative', width: '100%', minWidth: 0, maxWidth: '100%', overflow: 'hidden',
  },
  categoryChips: {
    display: 'flex', flexWrap: 'nowrap', gap: '6px', minWidth: 0,
    overflowX: 'auto', overflowY: 'hidden', paddingRight: '30px',
    scrollbarWidth: 'none', cursor: 'grab', userSelect: 'none', touchAction: 'pan-y',
  },
  categoryItem: { display: 'inline-flex', flex: '0 0 auto' },
  categoryNext: {
    position: 'absolute', zIndex: 2, top: '50%', right: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '26px', height: '26px', padding: 0, border: 0, borderRadius: '50%',
    transform: 'translateY(-50%)',
    background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-2) 94%, transparent)',
    color: 'var(--dsw-alias-label-primary)', boxShadow: 'var(--dsw-shadow-lv1)',
    cursor: 'pointer', fontSize: '20px', lineHeight: 1,
  },
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
function failureText(failure: CatalogFailure, t: MarketTranslate): string {
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
  props: MarketSectionProps,
): ReactNode {
  const { callHost, language, summon, onDismiss, showChrome = true, t } = props
  const active = language()

  // The composer's connector capsule opens this overlay aimed at its own tab;
  // the request is take-once, so a plain open still lands on the experts.
  const [tab, setTab] = useState<Tab>(() => takeMarketTab() ?? 'expert')
  // The «我的专家» subpage takes the whole body when it is open, which is what
  // it does in WorkBuddy (`ec-topbar--subpage`).
  const [mine, setMine] = useState(false)
  // One catalog per partition, kept after a switch: they are separate reads of
  // a console route that answers per type, and re-reading on every tab press
  // would spend a request to redraw what the window already had.
  //
  // `undefined` is "not read yet" and an empty item list is "read, and empty" —
  // the two render differently, so a boolean flag would lose the distinction.
  const [catalogs, setCatalogs] = useState<Partial<Record<Tab, Catalog>>>(
    () => ({ ...marketProcessSnapshot.catalogs }),
  )
  const [target, setTarget] = useState<InstallTarget | null>(
    () => marketProcessSnapshot.target ?? null,
  )
  const [skills, setSkills] = useState<SkillTarget | null>(
    () => marketProcessSnapshot.skills ?? null,
  )
  const [connectors, setConnectors] = useState<ConnectorTarget | null>(
    () => marketProcessSnapshot.connectors ?? null,
  )
  const [reading, setReading] = useState(false)
  const installedReads = useRef(new Set<Tab>())

  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<Kind>('all')
  const [category, setCategory] = useState(0)
  // «我安装的»: a filter over the grid that is already on screen rather than a
  // page of its own. See the copy note on `mineInstalled`.
  const [onlyMine, setOnlyMine] = useState(false)
  const [adding, setAdding] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const categoryRef = useRef<HTMLDivElement>(null)
  const catalog = catalogs[tab] ?? null
  const [canCategoryNext, setCanCategoryNext] = useState(false)
  const {
    dragHandlers: categoryDragHandlers,
    isDragging: categoryDragging,
  } = useHorizontalDrag<HTMLDivElement>()
  useHorizontalWheel(categoryRef, (catalog?.categories.length ?? 0) > 0)

  const updateCategoryArrow = useCallback((): void => {
    const row = categoryRef.current
    if (row === null) return
    setCanCategoryNext(row.scrollLeft + row.clientWidth < row.scrollWidth - 1)
  }, [])

  useEffect(() => {
    updateCategoryArrow()
    const row = categoryRef.current
    if (row === null) return
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateCategoryArrow)
      return () => window.removeEventListener('resize', updateCategoryArrow)
    }
    const observer = new ResizeObserver(updateCategoryArrow)
    observer.observe(row)
    return () => observer.disconnect()
  }, [catalog?.categories.length, updateCategoryArrow])

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
  /**
   * Every row with a flow in flight, not a single slug: two connectors can be
   * mid-connect at once (one on the queue, one waiting for its browser), and a
   * string here made the second press silently stop the first row's spinner —
   * WorkBuddy keeps the same fact as its `connectingIds` set.
   */
  const [installing, setInstalling] = useState<ReadonlySet<string>>(() => new Set())
  /** The rows whose browser sign-in is being waited on; these can be cancelled. */
  const [authWaiting, setAuthWaiting] = useState<ReadonlySet<string>>(() => new Set())
  const [outcome, setOutcome] = useState<{ item: CatalogItem; outcome: InstallOutcome } | undefined>()
  // Opening questions per slug, asked once each: the manifest is a per-item
  // read the catalog snapshot deliberately withholds.
  const [prompts, setPrompts] = useState<Record<string, readonly string[]>>(
    () => ({ ...marketProcessSnapshot.prompts }),
  )
  // WorkBuddy resolves cases from one shared discover cache and renders no case
  // placeholder. Keep the same per-session stability with a cache by expert.
  const [relatedCasesBySlug, setRelatedCasesBySlug] = useState<
    Record<string, readonly HomePlaybook[]>
  >(() => ({ ...marketProcessSnapshot.relatedCasesBySlug }))
  const [caseOpening, setCaseOpening] = useState<number>()
  const [caseError, setCaseError] = useState<string>()
  const [casePreview, setCasePreview] = useState<{
    readonly item: HomePlaybook
    readonly artifact: PlaybookArtifact
  }>()
  // WorkBuddy's expert center owns this strip. It is deliberately independent
  // from the blank-session home, whose product content is not designed yet.
  const [featuredScenes, setFeaturedScenes] = useState<readonly HomeShowcase[] | undefined>(
    () => marketProcessSnapshot.featuredScenes,
  )
  const [featuredScenesReading, setFeaturedScenesReading] = useState(false)
  const featuredScenesRequested = useRef(marketProcessSnapshot.featuredScenes !== undefined)

  /** Turn one row's in-flight flag on or off. */
  const mark = useCallback((slug: string, on: boolean): void => {
    setInstalling((current) => {
      if (current.has(slug) === on) return current
      const next = new Set(current)
      if (on) next.add(slug)
      else next.delete(slug)
      return next
    })
  }, [])

  const connectChain = useRef<Promise<unknown>>(Promise.resolve())

  /**
   * Run one connector flow at a time (see {@link CONNECT_RELEASE_MS}).
   *
   * A promise chain rather than a store: the queue's whole life is inside this
   * component, and a turn that throws must not wedge the chain — the release
   * step runs on both settles.
   */
  const enqueue = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const turn = connectChain.current.then(work, work)
    connectChain.current = turn.then(noop, noop).then(
      () => new Promise((done) => { setTimeout(done, CONNECT_RELEASE_MS) }),
    )
    return turn
  }, [])

  /** Re-read what is installed for one partition; the card state derives from it. */
  const readInstalled = useCallback(async (which: Tab): Promise<void> => {
    installedReads.current.add(which)
    if (which === 'skill') {
      const held = await callHost<SkillTarget>('market.skills', {})
      if (held.ok) {
        marketProcessSnapshot.skills = held.value
        setSkills(held.value)
        // The decoration lexicon's supplementary roll: the kernel's own skill
        // catalog is cached per session and never invalidated by an install,
        // so a skill installed this run would stay an undecorated `/name`
        // without this (`skill-lexicon.ts` traces the cache's two wires).
        publishSkillLexicon(held.value.installed
          .filter((s: InstalledSkill) => s.enabled)
          .map((s: InstalledSkill) => s.name))
      }
      return
    }
    if (which === 'connector') {
      const live = await callHost<ConnectorTarget>('market.connectors', {})
      if (live.ok) {
        marketProcessSnapshot.connectors = live.value
        setConnectors(live.value)
        // The composer capsule draws from the same read (`connector-live.ts`),
        // so a connect done here updates it without waiting for a remount.
        publishConnectorsLive(live.value)
      }
      return
    }
    const where = await callHost<InstallTarget>('market.target', {})
    if (where.ok) {
      marketProcessSnapshot.target = where.value
      setTarget(where.value)
    }
  }, [callHost])

  const read = useCallback(async (which: Tab): Promise<void> => {
    setReading(true)
    const [rows] = await Promise.all([
      callHost<Catalog>('market.catalog', { type: which satisfies CatalogType }),
      readInstalled(which),
    ])
    const next = rows.ok
      ? rows.value
      : {
        kernelApi: '', items: [], categories: [],
        failure: { kind: 'transport' as const, message: rows.error.message },
      }
    if (rows.ok) marketProcessSnapshot.catalogs[which] = rows.value
    setCatalogs(current => ({ ...current, [which]: next }))
    setReading(false)
  }, [callHost, readInstalled])

  // WorkBuddy reads each remote partition once per app process. Reopening this
  // overlay restores the module snapshot synchronously; local install state is
  // likewise reused and is refreshed by the install actions themselves.
  useEffect(() => {
    if (catalogs[tab] === undefined) {
      void read(tab)
      return
    }
    const installedKnown = tab === 'expert'
      ? marketProcessSnapshot.target !== undefined
      : tab === 'skill'
        ? marketProcessSnapshot.skills !== undefined
        : marketProcessSnapshot.connectors !== undefined
    if (!installedKnown && !installedReads.current.has(tab)) void readInstalled(tab)
  }, [tab, catalogs, read, readInstalled])

  useEffect(() => {
    if (tab !== 'expert' || featuredScenesRequested.current) return
    featuredScenesRequested.current = true
    setFeaturedScenesReading(true)
    void callHost<readonly HomeShowcase[]>('market.featuredScenes', {}).then(reply => {
      const next = reply.ok ? reply.value : []
      if (reply.ok && next.length > 0) marketProcessSnapshot.featuredScenes = next
      setFeaturedScenes(next)
      setFeaturedScenesReading(false)
    })
  }, [callHost, tab])

  const installedById = useMemo(() => {
    const map = new Map<string, InstalledPreset>()
    for (const preset of target?.installed ?? []) map.set(preset.id, preset)
    return map
  }, [target])

  const installedSkillBySlug = useMemo(() => {
    const map = new Map<string, InstalledSkill>()
    for (const skill of skills?.installed ?? []) map.set(skill.slug, skill)
    return map
  }, [skills])

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

  /**
   * How many rows of this partition the user holds, when that is a number this
   * surface owns and it is not zero.
   *
   * Absent on the expert tab: the roster it would count includes presets we
   * never installed (the kernel's own, and anything authored by hand), so the
   * count would not be «我安装的». That tab has «我的专家» for this errand.
   * Absent at zero because a chip that filters to nothing is not a filter —
   * which is the same condition WorkBuddy's own count button carries
   * (`totalInstalledCount > 0 &&`).
   */
  const mineCount = useMemo((): number | undefined => {
    const held = tab === 'skill'
      ? skills?.installed.length
      : tab === 'connector' ? connectors?.installed.length : undefined
    return held === undefined || held === 0 ? undefined : held
  }, [tab, skills, connectors])

  // Removing the last installed row takes the chip away with it; without this
  // the filter would stay on with nothing left to turn it off.
  useEffect(() => {
    if (mineCount === undefined && onlyMine) setOnlyMine(false)
  }, [mineCount, onlyMine])

  /** Whether one row of the partition on screen is already in place. */
  const isInstalled = useCallback((slug: string): boolean => {
    if (tab === 'skill') return installedSkillBySlug.has(slug)
    return tab === 'connector' ? connectedBySlug.has(slug) : installedById.has(slug)
  }, [tab, installedSkillBySlug, connectedBySlug, installedById])

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (catalog?.items ?? []).filter(item => {
      // The expert / team split is a fact about experts; the skill partition has
      // no such halves, and its rows all carry `team: false`.
      if (tab === 'expert' && kind === 'team' && !item.team) return false
      if (tab === 'expert' && kind === 'agent' && item.team) return false
      if (onlyMine && !isInstalled(item.slug)) return false
      if (category !== 0 && item.categoryId !== category) return false
      if (needle === '') return true
      const haystack = [item.name, item.slug, describe(item, active), ...item.tags].join(' ').toLowerCase()
      return haystack.includes(needle)
    })
  }, [catalog, query, kind, category, active, tab, onlyMine, isInstalled])

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
      const row = connectorRow(connected, installing.has(item.slug))
      if (row !== undefined) {
        if (row.kind === 'working') return { kind: 'installing' }
        // A connector that did not come up this launch is still connected — the
        // record is what "connected" means — so it keeps the installed state and
        // carries the reason, which is what the card turns into a tooltip.
        return row.kind === 'connected'
          ? { kind: 'installed' }
          : { kind: 'installed', broken: t('connectorOffline', { message: connected?.failure ?? '' }) }
      }
      if (installing.has(item.slug)) return { kind: 'installing' }
      const blocked = blockedReason(item)
      return blocked === undefined ? { kind: 'ready' } : { kind: 'blocked', reason: blocked }
    }
    if (tab === 'skill') {
      const held = installedSkillBySlug.get(item.slug)
      if (held !== undefined) return { kind: 'installed', closed: !held.enabled }
      if (installing.has(item.slug)) return { kind: 'installing' }
      const blocked = blockedReason(item)
      return blocked === undefined ? { kind: 'ready' } : { kind: 'blocked', reason: blocked }
    }
    const installed = installedById.get(item.slug)
    if (installed !== undefined) {
      return installed.broken === undefined
        ? { kind: 'installed' }
        : { kind: 'installed', broken: installed.broken }
    }
    if (installing.has(item.slug)) return { kind: 'installing' }
    const reason = blockedReason(item)
    return reason === undefined ? { kind: 'ready' } : { kind: 'blocked', reason }
  }, [tab, installedById, installedSkillBySlug, connectedBySlug, installing, blockedReason, t])

  const install = useCallback(async (item: CatalogItem): Promise<InstallOutcome | undefined> => {
    if (item.artifact === undefined) return undefined
    mark(item.slug, true)
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
    mark(item.slug, false)
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
  }, [callHost, mark, tab, readInstalled])

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
    marketProcessSnapshot.prompts[slug] = rows
    setPrompts(current => ({ ...current, [slug]: rows }))
    return rows
  }, [callHost, prompts])

  /** Resolve a related case's short-lived artifact without changing the market page. */
  const openRelatedCase = useCallback(async (item: HomePlaybook): Promise<void> => {
    setCaseOpening(item.id)
    setCaseError(undefined)
    const reply = await callHost<PlaybookArtifact>('market.playbookArtifact', { id: item.id })
    setCaseOpening(undefined)
    if (!reply.ok) {
      setCaseError(t('homeOpenFailed', { message: reply.error.message }))
      return
    }
    setCasePreview({ item, artifact: reply.value })
  }, [callHost, t])

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
      ?? item.openingPrompts?.[0]
      ?? (await readPrompts(item.slug))[0]
    setDetail(undefined)
    summon({ preset: item.slug, prompt: opening ?? '' })
    onDismiss?.()
  }, [summon, installedById, readPrompts, onDismiss])

  /**
   * Leave for a new session with one of this connector's example asks prefilled.
   *
   * WorkBuddy's connected card swaps its action for 「去对话」, which navigates
   * home and prefills a random row from the connector's examples
   * (`connector-panel.tsx`'s `handleTryConnector`: `examples[Math.floor(
   * Math.random() * examples.length)]`, then `useConnectorPrompt(prompt)`).
   * Our composer write path is the summon controller's, so this rides it with
   * no preset — the same shape the skill 「试一试」 uses. A row with no
   * published examples still travels: landing on a blank composer beside the
   * capsule beats a button that silently does nothing.
   */
  const tryConnector = useCallback((item: CatalogItem): void => {
    if (summon === undefined) return
    const examples = item.openingPrompts ?? []
    const prompt = examples[Math.floor(Math.random() * examples.length)] ?? ''
    setDetail(undefined)
    summon({ prompt })
    onDismiss?.()
  }, [summon, onDismiss])

  /**
   * Connect one connector, with the secret when it asked for one.
   *
   * The gallery never sends a command: it names the catalog row, and the host
   * reads what to spawn from the console's manifest. That is the same rule the
   * preset installs follow, for the same reason — a renderer choosing what the
   * main process runs is the sink, whether it runs a fetch or a process.
   *
   * Success says nothing: the dot goes green, the corner turns into 「去对话」,
   * and the composer capsule picks the row up — WorkBuddy's connect ends in a
   * toast, not a dialog, and ours ends in the same quiet. Only a refusal earns
   * the dialog, because a refusal is the one outcome with a next move to read.
   * The in-flight flag belongs to the callers (`beginConnect`, `submitToken`),
   * which hold it across the whole flow this call is one step of.
   */
  const connect = useCallback(async (item: CatalogItem, secret?: string): Promise<void> => {
    const result = await callHost<InstallOutcome>('market.connectorInstall', {
      slug: item.slug,
      name: item.name,
      ...item.version === '' ? {} : { version: item.version },
      ...secret === undefined ? {} : { token: secret },
    })
    setToken(undefined)
    await readInstalled('connector')
    if (result.ok && result.value.kind === 'installed') return
    setOutcome({
      item,
      outcome: result.ok
        ? result.value
        : { kind: 'refused', reason: 'not-mountable', message: result.error.message },
    })
  }, [callHost, readInstalled])

  /**
   * Open the custom-connector panel: the file's text for the editor, and a
   * re-read of what is mounted.
   *
   * Both happen on open rather than on a press, so the panel can answer the
   * question that brought the user here — «我上次写的那台起来了吗» — with the
   * text already in front of them to fix.
   */
  const openCustom = useCallback(async (): Promise<void> => {
    setCustom({ busy: true })
    const [text, sync] = await Promise.all([
      callHost<CustomConnectorFile>('market.connectorCustomRead', {}),
      callHost<CustomConnectorSync>('market.connectorCustomSync', {}),
    ])
    setCustom({
      busy: false,
      ...text.ok ? { file: text.value } : {},
      ...sync.ok ? { sync: sync.value } : {},
    })
    await readInstalled('connector')
  }, [callHost, readInstalled])

  /**
   * Save the editor's text; the host validates, writes, and remounts in one
   * move (WorkBuddy's save button, `mcp-config-editor.tsx`). A refusal keeps
   * the draft on screen with the reason under it and the file untouched; a
   * save becomes the editor's new baseline — normalized, when the host had to
   * hoist a nested `mcpServers` out of a paste.
   */
  const saveCustom = useCallback(async (content: string): Promise<void> => {
    setCustom(current => ({
      busy: true,
      ...current?.handoff === undefined ? {} : { handoff: current.handoff },
      ...current?.file === undefined ? {} : { file: current.file },
      ...current?.sync === undefined ? {} : { sync: current.sync },
    }))
    const result = await callHost<CustomConnectorSave>('market.connectorCustomWrite', { content })
    const refusal = !result.ok
      ? result.error.message
      : result.value.kind === 'refused' ? result.value.message : undefined
    setCustom(current => ({
      busy: false,
      ...current?.handoff === undefined ? {} : { handoff: current.handoff },
      ...result.ok && result.value.kind === 'saved'
        ? {
          file: { path: result.value.sync.path, content: result.value.content },
          sync: result.value.sync,
        }
        : {
          ...current?.file === undefined ? {} : { file: current.file },
          ...current?.sync === undefined ? {} : { sync: current.sync },
          ...refusal === undefined ? {} : { saveError: refusal },
        },
    }))
    if (result.ok && result.value.kind === 'saved') await readInstalled('connector')
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
    // The dialog's path display reads from `file` (whose read also creates the
    // file), so the answer here is only which of the three sentences to show.
    setCustom(current => ({
      ...current,
      busy: false,
      handoff: result.ok ? result.value.did : 'nothing',
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

    // While this set holds the slug, the card's spinner is a cancel button.
    setAuthWaiting(current => new Set(current).add(item.slug))
    try {
      for (let waited = 0; waited < AUTHORIZE_TIMEOUT_MS; waited += AUTHORIZE_POLL_MS) {
        await new Promise((tick) => { setTimeout(tick, AUTHORIZE_POLL_MS) })
        const state = await callHost<ConnectorAuthorizationState>('market.connectorAuthorizeState', {
          slug: item.slug,
        })
        if (!state.ok || state.value.kind === 'pending') continue
        if (state.value.kind === 'authorized') {
          // The grant is stored, so whichever path the caller came in on now
          // finds a token: a first connect writes the record, a repair remounts
          // the record that is already there.
          await settle(item)
          return
        }
        if (state.value.kind === 'failed') {
          setOutcome({
            item,
            outcome: { kind: 'refused', reason: 'needs-authorization', message: state.value.message },
          })
        }
        // `cancelled` and `idle` say nothing: the one hand that could have
        // cancelled is the user's own — on our button or on the browser tab —
        // and the row going back to rest is the whole answer.
        return
      }
    } finally {
      setAuthWaiting((current) => {
        const next = new Set(current)
        next.delete(item.slug)
        return next
      })
    }
  }, [callHost])

  /**
   * Withdraw a running web sign-in, from the connecting card's cancel button.
   *
   * One call, no local bookkeeping: the host settles the attempt as
   * `cancelled` (the kernel's own second-call knob,
   * `ctx.authorization.cancel`), and the poll above reads that on its next
   * tick — the same path an abandoned browser tab takes.
   */
  const cancelAuthorization = useCallback(async (item: CatalogItem): Promise<void> => {
    await callHost<{ cancelled: boolean }>('market.connectorAuthorizeCancel', { slug: item.slug })
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
    mark(item.slug, true)
    try {
      await enqueue(() => authorize(item, async (signedIn) => {
        const result = await callHost<RemountOutcome>('market.connectorRemount', {
          slug: signedIn.slug,
        })
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
      }))
    } finally {
      mark(item.slug, false)
    }
  }, [authorize, callHost, enqueue, mark, readInstalled])

  /**
   * Ask the host what this connector needs, then either connect or ask the user.
   *
   * The manifest read happens on the press rather than for the whole shelf: it
   * is one console round trip per item, and most rows answer "nothing".
   */
  const beginConnect = useCallback(async (item: CatalogItem): Promise<void> => {
    setDetail(undefined)
    // Marked before the queue, not inside it: the press must answer on the
    // card at once (WorkBuddy's optimistic `connectingIds`), even when another
    // row's browser sign-in currently holds the one connect slot.
    mark(item.slug, true)
    try {
      await enqueue(async () => {
        const reply = await callHost<ConnectorRequirement>('market.connectorRequirement', {
          slug: item.slug,
        })
        if (!reply.ok) {
          setOutcome({
            item,
            outcome: { kind: 'refused', reason: 'bad-manifest', message: reply.error.message },
          })
          return
        }
        const requirement = reply.value
        if (requirement.refusal !== undefined) {
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
        // A connector already signed in to connects like any other: the token is
        // in the credential seam and the host looks it up by slug.
        if (requirement.mode === 'oauth' && requirement.authorized !== true) {
          // The spinner spans the whole browser round trip; the finally below
          // clears it whichever way the sign-in ends.
          await authorize(item, connect)
          return
        }
        if (requirement.mode === 'token') {
          setToken({ item, requirement, value: '' })
          return
        }
        await connect(item)
      })
    } finally {
      mark(item.slug, false)
    }
  }, [authorize, callHost, connect, enqueue, mark])

  /**
   * Hand the token dialog's secret to the connect, holding the row's flag for
   * the round trip — the dialog stays up with a busy confirm until the host
   * answers, then either closes on success or yields to the refusal dialog.
   */
  const submitToken = useCallback(async (item: CatalogItem, secret: string): Promise<void> => {
    mark(item.slug, true)
    try {
      await enqueue(() => connect(item, secret))
    } finally {
      mark(item.slug, false)
    }
  }, [connect, enqueue, mark])

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
      // WorkBuddy's card stays put: + becomes ⋯/✓. A success sheet would cover
      // that change. Failures still need a sentence; they have nowhere else to go.
      if (result !== undefined && result.kind !== 'installed') {
        setOutcome({ item, outcome: result })
      }
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
   * Close or reopen one installed skill.
   *
   * The directory stays; the kernel's invocation keys are what change, so the
   * next turn no longer lists it. Same result as WorkBuddy's card-menu 关闭.
   */
  const toggleSkill = useCallback(async (slug: string, enabled: boolean): Promise<void> => {
    await callHost<{ updated: boolean }>('market.skillSetEnabled', { slug, enabled })
    await readInstalled('skill')
  }, [callHost, readInstalled])

  /**
   * 「编辑」: land in a session holding WorkBuddy's edit prompt.
   *
   * `skill-creator` is invoked when it is installed, same as 「创建技能」.
   */
  const editSkill = useCallback((item: CatalogItem): void => {
    if (summon === undefined || skills === null) return
    const held = installedSkillBySlug.get(item.slug)
    const prompt = t('skillEditPrompt', { name: held?.name ?? item.name })
    summon(skillCreationDraft(skills, prompt))
    onDismiss?.()
  }, [summon, onDismiss, skills, installedSkillBySlug, t])

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
    mark('local', true)
    const result = await callHost<InstallOutcome>('market.skillImport', { path: pick.path })
    mark('local', false)
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
  }, [callHost, mark, readInstalled, t])

  /**
   * «试一试» on a skill.
   *
   * No preset switch either way: a skill is not a composition, it is a
   * document whichever agent is running may open.
   *
   * WorkBuddy lands a *chip* in the composer, not a sentence — its
   * `handleTrySkill` opens a new task and publishes `newSkillCreated$`, which
   * the composer turns into a `createPhraseBlock('skill://…')` block plus the
   * skill's first localized example sentence (`skills-<hash>.js` /
   * `main-content-core-<hash>.js`; 2026-08-27 unpack). Our equivalent of that
   * chip is DSH's native invocation contract: a literal leading `/name` token,
   * which the host expands into the skill body before the model acts
   * (`dsh-client-ui-skill/README.zh.md:5-7`) and the client decorates once the
   * lexicon is warm — the same route «创建技能» already takes. Our catalog
   * carries no example prompts, so the chip stands alone and the cursor waits
   * for the user's task.
   *
   * The detail page offers «试一试» before installing too, and a token for a
   * skill that is not on disk (or is closed) would be a dead slash command —
   * those land the descriptive sentence instead, the same guard
   * `skillCreationDraft` applies.
   */
  const trySkill = useCallback((item: CatalogItem): void => {
    if (summon === undefined) return
    setDetail(undefined)
    const held = installedSkillBySlug.get(item.slug)
    summon(held !== undefined && held.enabled
      ? { prompt: `/${held.name} `, skillToken: held.name }
      : { prompt: t('skillTryPrompt', { name: item.name }) })
    onDismiss?.()
  }, [summon, onDismiss, installedSkillBySlug, t])

  /**
   * «创建技能»: start writing one in a session.
   *
   * WorkBuddy enters this flow with `skill-creator` active. DSH already has the
   * equivalent literal `/name` invocation pipeline, so the draft builder uses
   * it when that skill is installed and keeps the descriptive prompt as the
   * safe fallback. A skill remains independent of an Agent preset: it is a
   * directory with a `SKILL.md` which the current agent writes.
   */
  const createSkill = useCallback((): void => {
    if (summon === undefined || skills === null) return
    const prompt = t('skillCreatePrompt')
    summon(skillCreationDraft(skills, prompt))
    onDismiss?.()
  }, [summon, onDismiss, skills, t])

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

  const destination = target?.root === undefined || pending === undefined
    ? ''
    : `${target.root}\\${pending.item.slug}`
  const detailBlocked = detail === undefined ? undefined : blockedReason(detail)
  // The catalog carries these exactly as WorkBuddy's expert object does, so a
  // first-open detail does not grow its question section after a network read.
  const detailPrompts = detail === undefined
    ? []
    : detail.openingPrompts
      ?? installedById.get(detail.slug)?.prompts
      ?? prompts[detail.slug]
      ?? []
  const relatedCases = detail === undefined ? undefined : relatedCasesBySlug[detail.slug]

  const openDetail = useCallback((item: CatalogItem): void => {
    setDetail(item)
    setCasePreview(undefined)
    setCaseError(undefined)
  }, [])

  useEffect(() => {
    if (detail === undefined || tab !== 'expert') return
    if (relatedCasesBySlug[detail.slug] !== undefined) return
    let active = true
    void callHost<readonly HomePlaybook[]>('market.relatedPlaybooks', { slug: detail.slug }).then(reply => {
      if (!active) return
      if (reply.ok) {
        marketProcessSnapshot.relatedCasesBySlug[detail.slug] = reply.value
        setRelatedCasesBySlug(current => ({ ...current, [detail.slug]: reply.value }))
        return
      }
      setRelatedCasesBySlug(current => ({ ...current, [detail.slug]: [] }))
      setCaseError(t('caseLoadFailed', { message: reply.error.message }))
    })
    return () => { active = false }
  }, [callHost, detail, relatedCasesBySlug, tab, t])

  // Suggestions are only worth reading where they can be acted on, and only for
  // the one item whose sheet is open — the manifest is a per-item read.
  useEffect(() => {
    if (detail === undefined || summon === undefined) return
    // Opening questions are an expert's; a skill publishes none, and asking for
    // one would spend a per-item console read to be told so.
    if (tab !== 'expert') return
    if (detail.openingPrompts !== undefined) return
    if (detailPrompts.length > 0) return
    void readPrompts(detail.slug)
  }, [tab, detail, summon, detailPrompts, readPrompts])

  /**
   * Draw one row, wired to whichever partition is on screen.
   *
   * A function rather than repeated JSX: the featured strip and the grid below
   * it hold the same kind of row, and two copies of this wiring would drift.
   * @param item - the catalog row.
   * @returns its card.
   */
  const card = (item: CatalogItem, index: number): ReactNode => {
    const held = installedSkillBySlug.get(item.slug)
    return (
    <MarketCard
      key={item.slug}
      item={item}
      state={stateOf(item)}
      language={active}
      t={t}
      // A skill is never summoned into a session: it is loaded by the model when
      // the task matches, so its button says "install" even in a window that
      // has a conversation.
      summonable={tab === 'expert' && summon !== undefined}
      priorityAvatarLoad={index < 4}
      // The expert tab keeps the word, the other two the plus — which is how
      // WorkBuddy draws its two shelves (see `primaryLook`). A plus on an expert
      // card says «add this to my machine», and that is the skill shelf's act,
      // not this one's.
      primaryLook={tab === 'expert' ? 'text' : 'glyph'}
      {...tab === 'connector'
        ? {
          words: {
            primary: t('connect'),
            busy: t('connecting'),
            done: t('connected'),
            unhealthy: t('connectorOfflineBadge'),
          },
          // WorkBuddy's card carries a live dot beside the name: breathing
          // yellow through the whole connect (including the browser sign-in
          // wait), green once up, red for a row that did not come up.
          ...((): { dot?: 'connected' | 'connecting' | 'offline' } => {
            if (installing.has(item.slug)) return { dot: 'connecting' }
            const connected = connectedBySlug.get(item.slug)
            if (connected === undefined) return {}
            return { dot: connected.live ? 'connected' : 'offline' }
          })(),
          // A row waiting on its browser sign-in can be withdrawn from here:
          // the spinner turns into a ✕ under the pointer (WorkBuddy's
          // cancellable connecting state), and the press settles the attempt
          // as cancelled — no dialog, the row just comes back to rest.
          ...authWaiting.has(item.slug)
            ? {
              onCancel: () => { void cancelAuthorization(item) },
              cancelLabel: t('connectorCancelAuth'),
            }
            : {},
        }
        : {}}
      {...tab === 'connector' && summon !== undefined
        && connectedBySlug.get(item.slug)?.live === true && !installing.has(item.slug)
        ? {
          // The connected card's act is 「去对话」, not a re-run: chat glyph
          // under the pointer, and the press lands in a fresh session.
          onTry: () => { tryConnector(item) },
          tryLabel: t('connectorChat'),
          tryGlyph: <IconNewChatOutline16 />,
        }
        : {}}
      {...tab === 'expert' && summon !== undefined && installedById.has(item.slug)
        ? { onTry: () => { void primary(item) }, tryLabel: t('summon') }
        : {}}
      {...tab === 'skill' && summon !== undefined && held !== undefined && held.enabled
        ? { onTry: () => trySkill(item), tryLabel: t('tryNow') }
        : {}}
      {...tab === 'skill' && held !== undefined
        ? {
          menu: {
            items: [
              {
                id: 'toggle',
                label: held.enabled ? t('skillDisable') : t('skillEnable'),
                icon: <SkillPowerIcon />,
              },
              ...summon === undefined
                ? []
                : [{ id: 'edit', label: t('skillEdit'), icon: <IconEditOutline16 /> }],
              {
                id: 'uninstall',
                label: t('skillUninstall'),
                icon: <IconTrashOutline16 />,
                danger: true,
              },
            ],
            onSelect: (id: string): void => {
              if (id === 'toggle') void toggleSkill(item.slug, !held.enabled)
              else if (id === 'edit') editSkill(item)
              else if (id === 'uninstall') void removeSkill(item.slug)
            },
          },
        }
        : {}}
      {...connectorRow(connectedBySlug.get(item.slug), installing.has(item.slug))?.repairable === true
        ? { onRepair: () => { void repair(item) }, repairLabel: t('connectorReauthorize') }
        : {}}
      onOpen={() => openDetail(item)}
      onPrimary={() => { void primary(item) }}
    />
    )
  }

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
              setOnlyMine(false)
              // The sheet belongs to the row that opened it, and that row
              // belongs to the tab being left: an open sheet would keep the
              // skill on screen while the sheet reads it as a connector, since
              // what it is is now taken from the tab rather than guessed.
              setDetail(undefined)
              setCasePreview(undefined)
              setCaseError(undefined)
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
        {/*
          «添加技能» opens the same two-way choice WorkBuddy's does — find one, or
          write one — with «从本地添加» kept as a third row because a directory on
          this machine is a skill the shelf will never carry.
        */}
        {tab === 'skill' && (
          <Menu
            open={adding}
            align="end"
            portal
            items={[
              { id: 'find', label: t('skillFind'), icon: <IconSearchOutline16 /> },
              ...summon === undefined
                ? []
                : [{
                  id: 'create',
                  label: t('skillCreate'),
                  icon: <IconSkillOutline16 />,
                  disabled: skills === null,
                }],
              {
                id: 'local',
                label: t('skillAddLocal'),
                icon: <IconFolderOpenOutline16 />,
                disabled: installing.size > 0,
              },
            ]}
            onClose={() => setAdding(false)}
            onSelect={id => {
              setAdding(false)
              if (id === 'find') {
                searchRef.current?.querySelector('input')?.focus()
                return
              }
              if (id === 'create') {
                createSkill()
                return
              }
              void addLocalSkill()
            }}
            anchor={(
              <Button
                variant="primary"
                size="sm"
                icon={<IconPlusOutline16 />}
                data-testid="openlux-market-add-skill"
                onClick={() => setAdding(open => !open)}
              >
                {t('skillAdd')}
              </Button>
            )}
          />
        )}
        {/*
          Beside the tabs rather than among the cards, which is where WorkBuddy
          puts the same button (`ec-topbar__right`): what it opens is a file,
          and a card for a row this gallery cannot edit would be a lie.
        */}
        {/* Primary, like «添加技能» one tab over: on both tabs this seat is «add
            one the shelf does not have», and two shapes for one act read as two
            different kinds of thing. */}
        {tab === 'connector' && connectors?.mountable === true && (
          <Button
            variant="primary"
            size="sm"
            icon={<IconPlusOutline16 />}
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
        <div style={styles.searchRow}>
          {/* The span carries the ref: this Input is a function component on
              React 18, so a ref passed to it would not reach the field that
              «查找技能» has to focus. */}
          <span ref={searchRef} style={styles.searchGrow}>
            <Input
              value={query}
              icon={<IconSearchOutline16 />}
              placeholder={t(TAB_COPY[tab].search)}
              // The primitive's wrapper is `flex: 0 1 auto` and takes no style of
              // its own, so the field is as wide as its intrinsic size and no
              // wrapper of ours can stretch it. `size` is that intrinsic size —
              // a plain attribute that passes through to the input — and the
              // wrapper still shrinks when the dialog gets narrow.
              size={44}
              data-testid="openlux-market-search"
              onChange={event => setQuery(event.target.value)}
            />
          </span>
          {/* Beside the search field rather than among the categories: it answers
              a different question from them («哪些是我的» against «这一类有什么»),
              and a returning user reaches for it before reading any chip. */}
          {mineCount !== undefined && (
            <Pill
              active={onlyMine}
              data-testid="openlux-market-mine-filter"
              onClick={() => setOnlyMine(current => !current)}
            >
              {t(tab === 'connector' ? 'mineConnected' : 'mineInstalled', { count: mineCount })}
            </Pill>
          )}
        </div>
        {tab === 'expert'
          && query.trim() === ''
          && !onlyMine && (
            <FeaturedScenes
              scenes={featuredScenes ?? []}
              experts={catalog?.items ?? []}
              loading={featuredScenesReading}
              resolvingExperts={catalog === null}
              title={t('featuredExperts')}
              previousLabel={t('scrollPrevious')}
              nextLabel={t('scrollNext')}
              onExpertOpen={openDetail}
            />
          )}
        {tab === 'expert' && (
          <div style={styles.chips}>
            {([['all', 'kindAll'], ['agent', 'kindAgent'], ['team', 'kindTeam']] as const).map(([id, key]) => (
              <Pill key={id} active={kind === id} onClick={() => setKind(id)}>{t(key)}</Pill>
            ))}
          </div>
        )}
        {categories.length > 0 && (
          <div style={styles.categoryWrap}>
            <div
              ref={categoryRef}
              style={{
                ...styles.categoryChips,
                cursor: categoryDragging ? 'grabbing' : 'grab',
              }}
              onScroll={updateCategoryArrow}
              {...categoryDragHandlers}
            >
              <span style={styles.categoryItem}>
                <Pill active={category === 0} onClick={() => setCategory(0)}>{t('categoryAll')}</Pill>
              </span>
              {categories.map(row => (
                <span key={row.id} style={styles.categoryItem}>
                  <Pill active={category === row.id} onClick={() => setCategory(row.id)}>
                    {row.name}
                  </Pill>
                </span>
              ))}
            </div>
            {canCategoryNext && (
              <button
                type="button"
                style={styles.categoryNext}
                aria-label={t('scrollNext')}
                onClick={() => categoryRef.current?.scrollBy({ left: 160, behavior: 'smooth' })}
              >
                ›
              </button>
            )}
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

      {/*
        One flat grid, no featured strip. WorkBuddy's connector panel has no
        such strip (`connector-panel.tsx`: no featured/精选 section at all),
        and ours also made cards jump: the strip excluded connected rows, so
        the moment a connect landed the card fell out of the strip and
        reappeared down in the grid. The console's featured marks still order
        the catalog (featured rows arrive first), which keeps the curation
        without a second shelf.
      */}
      {shown.length > 0 && <div style={styles.grid}>{shown.map(card)}</div>}

      <MarketDetail
        item={detail}
        language={active}
        categoryName={detail === undefined ? '' : categoryName(detail.categoryId)}
        kind={tab}
        t={t}
        summonable={tab === 'expert' && summon !== undefined}
        installed={detail !== undefined && isInstalled(detail.slug)}
        prompts={detail === undefined ? [] : detailPrompts}
        promptLoading={detail !== undefined
          && tab === 'expert'
          && summon !== undefined
          && detail.openingPrompts === undefined
          && installedById.get(detail.slug)?.prompts === undefined
          && prompts[detail.slug] === undefined}
        {...relatedCases === undefined ? {} : { relatedCases }}
        {...caseOpening === undefined ? {} : { caseOpening }}
        {...caseError === undefined ? {} : { caseError }}
        {...casePreview === undefined ? {} : { casePreview }}
        onCaseOpen={item => { void openRelatedCase(item) }}
        onCaseBack={() => {
          setCasePreview(undefined)
          setCaseError(undefined)
        }}
        {...summon === undefined || detail === undefined
          ? {}
          : {
            onCaseUse: (playbook: HomePlaybook): void => {
              setCasePreview(undefined)
              void primary(detail, playbook.initPrompt)
            },
          }}
        {...tab === 'skill' && summon !== undefined && detail !== undefined
          ? { onTry: () => trySkill(detail), tryLabel: t('tryNow') }
          : {}}
        {...tab === 'connector' && detail !== undefined && connectedBySlug.has(detail.slug)
          // 「断开」 lives in the sheet, not on the card: the card's own act is
          // 「去对话」, and the sheet stays open so the row is seen flipping back
          // to connectable.
          ? { onRemove: () => { void disconnect(detail.slug) }, removeLabel: t('disconnect') }
          : {}}
        {...detailBlocked === undefined ? {} : { blocked: detailBlocked }}
        {...detail === undefined || detailBlocked !== undefined
          ? {}
          : { onPrimary: (prompt?: string): void => { void primary(detail, prompt) } }}
        onClose={() => {
          setDetail(undefined)
          setCasePreview(undefined)
          setCaseError(undefined)
        }}
      />

      <MarketConfirm
        item={pending?.item}
        path={destination}
        busy={pending !== undefined && installing.has(pending.item.slug)}
        summonable={summon !== undefined}
        t={t}
        onCancel={() => setPending(undefined)}
        onConfirm={() => { if (pending !== undefined) void confirm(pending) }}
      />

      <ConnectorToken
        item={token?.item}
        {...token?.requirement.label === undefined ? {} : { label: token.requirement.label }}
        value={token?.value ?? ''}
        busy={token !== undefined && installing.has(token.item.slug)}
        t={t}
        onChange={value => setToken(current => (current === undefined ? current : { ...current, value }))}
        onCancel={() => setToken(undefined)}
        onConfirm={() => { if (token !== undefined) void submitToken(token.item, token.value) }}
      />

      <CustomConnector
        open={custom !== undefined}
        {...custom?.file === undefined ? {} : { file: custom.file }}
        {...custom?.sync === undefined ? {} : { sync: custom.sync }}
        busy={custom?.busy === true}
        {...custom?.saveError === undefined ? {} : { saveError: custom.saveError }}
        {...custom?.handoff === undefined ? {} : { handoff: custom.handoff }}
        t={t}
        onOpenFile={() => { void openCustomFile() }}
        onSave={content => { void saveCustom(content) }}
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

/**
 * WorkBuddy's card-menu power glyph (关闭 / 启用). The primitive set has no
 * power icon; this is the same 13×13 stroke they draw inline.
 */
function SkillPowerIcon(): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18.36 6.64A9 9 0 0 1 20.77 15" />
      <path d="M6.16 6.16a9 9 0 1 0 12.68 12.68" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  )
}
