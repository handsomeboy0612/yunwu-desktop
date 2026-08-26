import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { Button, IconCloseOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable,
  InjectFace,
  PropsLocale,
  PropsRuntime,
  PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { AutomationPage, type AutomationSourceSession } from './AutomationPage.tsx'
import type { AutomationViewStore } from './automation-view-store.ts'
import type { AccountHostCaller } from './types.ts'

export const AUTOMATION_OVERLAY_ID = 'openlux-automation'
export const AUTOMATION_OVERLAY_ORDER = 5

export interface AutomationOverlayInjected {
  readonly callHost: AccountHostCaller
  readonly openResult: (sessionId: string) => Promise<void>
  /** Records one expert summon into the shared «最近召唤» history. */
  readonly noteExpertSummon: (agentPreset: string) => void
  readonly hooks: {
    readonly automationSource: HostObservable<AutomationSourceSession | undefined>
    /** Preset ids from the persisted summon history, most recent first. */
    readonly recentExperts: HostObservable<readonly string[]>
  }
}

/** Frame-wide automation page reached from the sidebar. */
export function AutomationOverlay(
  props: PropsRuntime<'shell.overlay'>
    & PropsLocale<'openlux.automation'>
    & PropsStore<AutomationViewStore>
    & InjectFace<AutomationOverlayInjected>,
): ReactNode {
  const { useStore, actions, useAutomationSource, useRecentExperts, callHost, openResult, noteExpertSummon, t } = props
  const open = useStore(state => state.open)
  const source = useAutomationSource(value => value)
  const recentExperts = useRecentExperts(value => value)
  const panel = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return
    panel.current?.querySelector('button')?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (document.querySelectorAll('[role="dialog"]').length > 1) return
      if (document.querySelector('[role="menu"]') !== null) return
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
      data-testid="openlux-automation-overlay"
    >
      <button type="button" style={styles.mask} aria-label={t('close')} onClick={() => actions.close()} />
      <section ref={panel} style={styles.panel}>
        <header style={styles.header}>
          <div>
            <h2 style={styles.heading}>{t('title')}</h2>
            <p style={styles.intro}>{t('intro')}</p>
          </div>
          <Tooltip label={t('close')}>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('close')}
              icon={<IconCloseOutline16 size={16} />}
              onClick={() => actions.close()}
            />
          </Tooltip>
        </header>
        <main style={styles.body}>
          <AutomationPage
            callHost={callHost}
            source={source}
            recentExperts={recentExperts}
            noteExpertSummon={noteExpertSummon}
            t={t}
            openResult={async (sessionId) => {
              await openResult(sessionId)
              actions.close()
            }}
          />
        </main>
      </section>
    </div>
  )
}

const styles = {
  root: {
    position: 'fixed', inset: 0, zIndex: 1000, display: 'flex',
    alignItems: 'center', justifyContent: 'center', padding: '24px',
    pointerEvents: 'auto',
  },
  mask: {
    position: 'absolute', inset: 0, border: 0,
    background: 'var(--dsw-alias-bg-mask-1)',
    backdropFilter: 'var(--dsw-mask-blur)', cursor: 'pointer',
  },
  panel: {
    position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column',
    width: 'min(860px, 100%)', height: 'min(720px, 100%)',
    minWidth: 0, minHeight: 0, overflow: 'hidden',
    border: '1px solid var(--dsw-alias-border-inverted)', borderRadius: '24px',
    background: 'var(--dsw-alias-bg-layer-2)', boxShadow: 'var(--dsw-shadow-lv3)',
  },
  header: {
    flex: 'none', display: 'flex', alignItems: 'flex-start',
    justifyContent: 'space-between', gap: '12px',
    padding: '20px 18px 14px 24px',
    borderBottom: '1px solid var(--dsw-alias-border-l1)',
  },
  heading: {
    margin: 0, color: 'var(--dsw-alias-label-primary)',
    fontSize: '18px', fontWeight: 600,
  },
  intro: {
    margin: '6px 0 0', color: 'var(--dsw-alias-label-secondary)',
    fontSize: '12px', lineHeight: 1.6,
  },
  body: {
    width: '100%', maxWidth: '100%', boxSizing: 'border-box',
    minWidth: 0, minHeight: 0, flex: 1, overflow: 'auto',
    padding: '20px 24px 24px',
  },
} satisfies Record<string, CSSProperties>
