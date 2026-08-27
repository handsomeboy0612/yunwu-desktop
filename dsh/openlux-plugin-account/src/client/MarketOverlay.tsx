/**
 * Frame-wide market overlay: mask + panel, catalog inside.
 *
 * Sits in `shell.overlay` (ui-layout's click-through floating layer). The
 * root therefore opts back into pointer events — without that the mask
 * would not receive clicks. Escape closes unless a nested dialog (detail /
 * confirm) is already up, same guard the community-market overlay uses.
 *
 * @module openlux-plugin-account/client/MarketOverlay
 */

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { Button, IconCloseOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { MarketSection, type MarketSectionInjected } from './MarketSection.tsx'
import { watchMarketOpen } from './market-open-request.ts'
import type { MarketViewStore } from './market-view-store.ts'

/** Overlay slot id; shares the launcher's product name on purpose. */
export const MARKET_OVERLAY_ID = 'openlux-market'

/** Same order as the launcher so the two faces stay a pair. */
export const MARKET_OVERLAY_ORDER = 10

/**
 * Catalog + summon wiring, supplied by the plugin body.
 *
 * `summon` is always there and always safe to hold: this face is built once per
 * registration and cached for the entry's life (ui-renderer's
 * `cachedRootInject`), so a conditional member would freeze whichever moment
 * the overlay first rendered — for a shell-mounted overlay, boot, before the
 * conversation scope exists. Whether pressing it can land anywhere is the
 * separate live fact below, read the way ui-workspace reads its own flow
 * occupancy (`DirectoryPickingInjected.hooks.directoryFlow`).
 */
export type MarketOverlayInjected = Omit<MarketSectionInjected, 'summon'> & {
  readonly summon: NonNullable<MarketSectionInjected['summon']>
  readonly hooks: {
    /** Whether a conversation flow is live; the renderer binds it as useSummonReady. */
    readonly summonReady: HostObservable<boolean>
  }
}

const styles = {
  root: {
    position: 'fixed',
    inset: 0,
    zIndex: 1000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    pointerEvents: 'auto',
  },
  mask: {
    position: 'absolute',
    inset: 0,
    border: 0,
    background: 'var(--dsw-alias-bg-mask-1)',
    backdropFilter: 'var(--dsw-mask-blur)',
    cursor: 'pointer',
  },
  panel: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    flexDirection: 'column',
    width: 'min(800px, 100%)',
    height: 'min(700px, 100%)',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
    border: '1px solid var(--dsw-alias-border-inverted)',
    borderRadius: '24px',
    background: 'var(--dsw-alias-bg-layer-2)',
    boxShadow: 'var(--dsw-shadow-lv3)',
  },
  header: {
    flex: 'none',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '20px 18px 14px 24px',
    borderBottom: '1px solid var(--dsw-alias-border-l1)',
  },
  heading: { margin: 0, color: 'var(--dsw-alias-label-primary)', fontSize: '18px', fontWeight: 600 },
  intro: {
    margin: '6px 0 0',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: '12px',
    lineHeight: 1.6,
  },
  body: {
    width: '100%',
    maxWidth: '100%',
    boxSizing: 'border-box',
    minWidth: 0,
    minHeight: 0,
    flex: 1,
    overflow: 'auto',
    padding: '20px 24px 24px',
  },
} satisfies Record<string, CSSProperties>

/**
 * Render the overlay, or nothing while closed.
 * @param props - overlay store, catalog wiring, and market copy.
 * @returns the overlay, or null.
 */
export function MarketOverlay(
  props: PropsRuntime<'shell.overlay'>
    & PropsLocale<'openlux.market'>
    & PropsStore<MarketViewStore>
    & InjectFace<MarketOverlayInjected>,
): ReactNode {
  const { useStore, actions, t, callHost, language, summon, useSummonReady } = props
  const open = useStore(state => state.open)
  const summonable = useSummonReady(ready => ready)
  const panel = useRef<HTMLElement>(null)

  // Session-scoped seats (the composer's connector capsule) cannot hold this
  // store's handle — the kernel allows one scope per handle — so they ask
  // through the request module and the store's owner opens on their behalf.
  useEffect(() => watchMarketOpen(() => actions.open()), [actions])

  useEffect(() => {
    if (!open) return
    panel.current?.querySelector('button')?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (document.querySelectorAll('[role="dialog"]').length > 1) return
      actions.close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [actions, open])

  if (!open) return null

  return (
    <div
      style={styles.root}
      role="dialog"
      aria-modal="true"
      aria-label={t('title')}
      data-testid="openlux-market-overlay"
    >
      <button
        type="button"
        style={styles.mask}
        aria-label={t('closeMarket')}
        onClick={() => actions.close()}
      />
      <section ref={panel} style={styles.panel}>
        <header style={styles.header}>
          <div>
            <h1 style={styles.heading}>{t('title')}</h1>
            <p style={styles.intro}>{t('intro')}</p>
          </div>
          <Tooltip label={t('closeMarket')}>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('closeMarket')}
              icon={<IconCloseOutline16 />}
              onClick={() => actions.close()}
            />
          </Tooltip>
        </header>
        <div style={styles.body}>
          <MarketSection
            t={t}
            callHost={callHost}
            language={language}
            showChrome={false}
            onDismiss={() => actions.close()}
            {...summonable ? { summon } : {}}
          />
        </div>
      </section>
    </div>
  )
}
