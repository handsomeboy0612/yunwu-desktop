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
  Catalog, CatalogFailure, CatalogItem, InstallOutcome, InstallTarget, InstalledPreset,
} from '../market/wire.ts'
import { MarketCard, describe, type CardState } from './MarketCard.tsx'
import { MarketConfirm, MarketDetail, MarketOutcome } from './MarketDialogs.tsx'
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

/** Which half of the roster the user is looking at. */
type Kind = 'all' | 'agent' | 'team'

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

  // `null` is "not read yet" and `[]` is "read, and empty" — the two render
  // differently, so a boolean flag would lose the distinction.
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [target, setTarget] = useState<InstallTarget | null>(null)
  const [reading, setReading] = useState(false)

  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<Kind>('all')
  const [category, setCategory] = useState(0)

  const [detail, setDetail] = useState<CatalogItem | undefined>()
  // The confirmation carries the question that opened it, not just the row: the
  // user may have pressed one of the detail sheet's suggestions, and consenting
  // to the install must not silently swap it for the expert's default one.
  const [pending, setPending] = useState<PendingSummon | undefined>()
  const [installing, setInstalling] = useState<string | undefined>()
  const [outcome, setOutcome] = useState<{ item: CatalogItem; outcome: InstallOutcome } | undefined>()
  // Opening questions per slug, asked once each: the manifest is a per-item
  // read the catalog snapshot deliberately withholds.
  const [prompts, setPrompts] = useState<Record<string, readonly string[]>>({})

  const read = useCallback(async (): Promise<void> => {
    setReading(true)
    const [rows, where] = await Promise.all([
      callHost<Catalog>('market.catalog', { type: 'expert' }),
      callHost<InstallTarget>('market.target', {}),
    ])
    if (rows.ok) setCatalog(rows.value)
    else {
      setCatalog({
        kernelApi: '', items: [], categories: [],
        failure: { kind: 'transport', message: rows.error.message },
      })
    }
    if (where.ok) setTarget(where.value)
    setReading(false)
  }, [callHost])

  useEffect(() => { void read() }, [read])

  const installedById = useMemo(() => {
    const map = new Map<string, InstalledPreset>()
    for (const preset of target?.installed ?? []) map.set(preset.id, preset)
    return map
  }, [target])

  const categories = catalog?.categories ?? []
  const categoryName = useCallback(
    (id: number) => categories.find(row => row.id === id)?.name ?? '',
    [categories],
  )

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (catalog?.items ?? []).filter(item => {
      if (kind === 'team' && !item.team) return false
      if (kind === 'agent' && item.team) return false
      if (category !== 0 && item.categoryId !== category) return false
      if (needle === '') return true
      const haystack = [item.name, item.slug, describe(item, active), ...item.tags].join(' ').toLowerCase()
      return haystack.includes(needle)
    })
  }, [catalog, query, kind, category, active])

  /** Why one row cannot be installed, or undefined when it can. */
  const blockedReason = useCallback((item: CatalogItem): string | undefined => {
    if (target !== null && !target.authorable) return t('notAuthorable')
    if (item.unavailable === 'bad-id') return t('unavailableBadId')
    if (item.unavailable === 'no-artifact' || item.artifact === undefined) {
      return t('unavailableNoArtifact', { kernelApi: catalog?.kernelApi ?? '' })
    }
    return undefined
  }, [target, catalog, t])

  const stateOf = useCallback((item: CatalogItem): CardState => {
    const installed = installedById.get(item.slug)
    if (installed !== undefined) {
      return installed.broken === undefined
        ? { kind: 'installed' }
        : { kind: 'installed', broken: installed.broken }
    }
    if (installing === item.slug) return { kind: 'installing' }
    const reason = blockedReason(item)
    return reason === undefined ? { kind: 'ready' } : { kind: 'blocked', reason }
  }, [installedById, installing, blockedReason])

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
      // The partition, not the visible filter: this gallery lists experts, and
      // `kind` is which half of them the user is looking at.
      type: 'expert',
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
    // The roster decides what "installed" means, so re-read it rather than
    // assuming this install landed.
    const where = await callHost<InstallTarget>('market.target', {})
    if (where.ok) setTarget(where.value)
    return outcome
  }, [callHost])

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
    if (installedById.has(item.slug)) {
      await enter(item, prompt)
      return
    }
    setPending(prompt === undefined ? { item } : { item, prompt })
  }, [installedById, enter])

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
    if (detailPrompts.length > 0) return
    void readPrompts(detail.slug)
  }, [detail, summon, detailPrompts, readPrompts])

  return (
    <div style={styles.root} data-testid={MARKET_SECTION_ID}>
      {showChrome && (
        <>
          <span style={styles.title}>{t('title')}</span>
          <span style={styles.intro}>{t('intro')}</span>
        </>
      )}

      <div style={styles.filters}>
        <Input
          value={query}
          placeholder={t('searchPlaceholder')}
          data-testid="openlux-market-search"
          onChange={event => setQuery(event.target.value)}
        />
        <div style={styles.chips}>
          {([['all', 'kindAll'], ['agent', 'kindAgent'], ['team', 'kindTeam']] as const).map(([id, key]) => (
            <Pill key={id} active={kind === id} onClick={() => setKind(id)}>{t(key)}</Pill>
          ))}
        </div>
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

      {catalog?.failure !== undefined && catalog.items.length === 0 && (
        <div style={styles.failure} data-testid="openlux-market-failure">
          <span>{failureText(catalog.failure, t)}</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={reading}
            data-testid="openlux-market-retry"
            onClick={() => { void read() }}
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
              summonable={summon !== undefined}
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
        summonable={summon !== undefined}
        installed={detail !== undefined && installedById.has(detail.slug)}
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

      <MarketOutcome
        item={outcome?.item}
        outcome={outcome?.outcome}
        t={t}
        onClose={() => setOutcome(undefined)}
      />
    </div>
  )
}
