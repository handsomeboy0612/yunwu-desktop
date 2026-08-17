/**
 * Account row at the sidebar foot: balance at a glance, details and sign-out
 * behind a click.
 *
 * Shape follows the kernel's own footer action (`ui-cordis`'s CordisPanel): a
 * badge button that shows an icon plus text when the column is wide and only
 * the icon in the 56px rail, opening a `position: fixed` panel measured
 * against the trigger, because the sidebar clips overflow.
 *
 * The four balance states come from the previous shell, which took them from
 * WorkBuddy's credits area. They exist because a failed read and a spent
 * account collapse to the same rendering, and of those two readings the one
 * the user acts on ("my money is gone") is the wrong one — so a failed refresh
 * either keeps the last value under a "cached" badge or says plainly that it
 * could not read one.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import {
  IconRefreshOutline14, IconUserOutline16, IconWarningOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the sidebar's slot rows, including
// 'sidebar.footer.action', into the SlotMap this file is typed against.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { SignInForm } from './SignInForm.tsx'
import type { AccountKey } from './locales.ts'
import type { AccountStore, AccountView } from './store.ts'
import type { AccountHostCaller } from './types.ts'

/** Slot id; also the DOM marker the live checks look for. */
export const ACCOUNT_ACTION_ID = 'openlux-account'

/** What the row needs from the plugin body. */
export interface AccountActionInjected {
  readonly callHost: AccountHostCaller
  readonly t: (key: AccountKey) => string
  readonly store: AccountStore
  /** uSES hook bound to {@link AccountStore}. */
  readonly useAccount: SnapshotSelectorHook<AccountView>
}

const styles = {
  trigger: {
    display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
    padding: '6px 8px', border: 'none', borderRadius: '8px', background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: '13px',
    cursor: 'pointer', textAlign: 'left',
  },
  railTrigger: { justifyContent: 'center', padding: '8px 0' },
  triggerValue: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  panel: {
    position: 'fixed', zIndex: 1000, width: '248px', padding: '12px',
    display: 'flex', flexDirection: 'column', gap: '8px',
    borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-1)', boxShadow: 'var(--dsw-shadow-lv3)',
  },
  who: {
    color: 'var(--dsw-alias-label-primary)', fontSize: '13px', fontWeight: 600,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  row: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
    color: 'var(--dsw-alias-label-secondary)', fontSize: '12px',
  },
  value: { display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--dsw-alias-label-primary)' },
  amount: { fontSize: '15px', fontWeight: 600 },
  low: { color: 'var(--dsw-alias-state-warn-primary)' },
  failed: { display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
  badge: {
    padding: '1px 5px', borderRadius: '4px', fontSize: '11px',
    background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-tertiary)',
  },
  iconButton: {
    display: 'flex', alignItems: 'center', padding: '2px', border: 'none', borderRadius: '4px',
    background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer',
  },
  link: {
    padding: 0, border: 'none', background: 'transparent', font: 'inherit', fontSize: '12px',
    color: 'var(--dsw-alias-brand-primary)', cursor: 'pointer', textAlign: 'left',
  },
  divider: { height: '1px', margin: '2px 0', background: 'var(--dsw-alias-border-l1)' },
} satisfies Record<string, CSSProperties>

/**
 * Wrap in a hover label, or pass the child through when there is none.
 * @param props.label - the label, or undefined for no tooltip at all.
 * @param props.children - the trigger.
 * @returns the trigger, wrapped or bare.
 */
function MaybeTooltip({ label, children }: {
  label: string | undefined
  children: ReactElement
}): ReactNode {
  if (label === undefined) return children
  return <Tooltip label={label} side="right" delayMs={500}>{children}</Tooltip>
}

/**
 * Render the account row and its panel.
 * @param props - the sidebar's owner share plus this package's inject face.
 * @returns the footer action.
 */
export function AccountAction(
  props: PropsRuntime<'sidebar.footer.action'> & AccountActionInjected,
): ReactNode {
  const { wide, t, store, useAccount, callHost } = props
  const view = useAccount(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number }>()

  // The panel is fixed (the sidebar clips overflow), so it hugs the trigger
  // through a measured offset instead of document flow.
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (rect !== undefined) setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 8 })
    }
    place()
    window.addEventListener('resize', place)
    return () => { window.removeEventListener('resize', place) }
  }, [open])

  // rc.7 ships this as `useDismissOnOutsidePointer`; the version this fork
  // builds against does not export it yet, so the five lines live here rather
  // than pulling the whole dependency set forward for one helper.
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) !== true) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [open])

  useEffect(() => { void store.refresh() }, [store])
  useEffect(() => { if (open) void store.refresh() }, [store, open])

  const startSignIn = (): void => {
    setOpen(false)
    setSigningIn(true)
  }

  /** The one line the collapsed and wide triggers both summarize. */
  const summary = (): string => {
    if (!view.read) return t('balanceLoading')
    if (!view.signedIn) return t('signedOut')
    if (view.balanceStatus === 'expired') return t('sessionExpired')
    if (view.balance !== undefined) return view.balance.display
    if (view.balanceStatus === 'unavailable') return t('balanceFailed')
    return t('balanceLoading')
  }

  return (
    <div ref={rootRef} data-testid={ACCOUNT_ACTION_ID}>
      {open && anchor !== undefined && (
        <section style={{ ...styles.panel, ...anchor }} aria-label={t('panelAria')}>
          <span style={styles.who}>{view.balance?.username ?? (view.signedIn ? t('signedIn') : t('signedOut'))}</span>
          <div style={styles.divider} />

          <div style={styles.row}>
            <span>{t('balance')}</span>
            <span style={styles.value}>
              {!view.read && <span>{t('balanceLoading')}</span>}

              {view.balance !== undefined && (view.balanceStatus === 'ok' || view.balanceStatus === 'stale') && (
                <>
                  <b style={{ ...styles.amount, ...view.balance.low ? styles.low : {} }}>{view.balance.display}</b>
                  {view.balanceStatus === 'stale' && (
                    <span style={styles.badge} title={view.message ?? t('balanceStaleTitle')}>{t('balanceStale')}</span>
                  )}
                </>
              )}

              {view.balanceStatus === 'expired' && (
                <button type="button" style={styles.link} onClick={startSignIn}>
                  {view.signedIn ? t('sessionExpired') : t('signIn')}
                </button>
              )}

              {view.read && view.balanceStatus === 'unavailable' && (
                <span style={styles.failed} title={view.message ?? t('balanceFailed')}>
                  <IconWarningOutline16 size={13} />
                  {t('balanceFailed')}
                </span>
              )}

              {view.balanceStatus !== 'expired' && (
                <button
                  type="button"
                  style={styles.iconButton}
                  aria-label={t('refresh')}
                  title={t('refresh')}
                  disabled={view.fetching}
                  onClick={() => { void store.refresh(true) }}
                >
                  <IconRefreshOutline14 size={12} />
                </button>
              )}
            </span>
          </div>

          {view.balance !== undefined && (
            <>
              <div style={styles.row}>
                <span>{t('used')}</span>
                <b style={{ color: 'var(--dsw-alias-label-primary)' }}>{view.balance.usedDisplay}</b>
              </div>
              {view.balance.group !== '' && (
                <div style={styles.row}>
                  <span>{t('group')}</span>
                  <b style={{ color: 'var(--dsw-alias-label-primary)' }}>{view.balance.group}</b>
                </div>
              )}
            </>
          )}

          <div style={styles.divider} />
          {view.signedIn ? (
            <button
              type="button"
              style={styles.link}
              data-testid="openlux-sign-out"
              onClick={() => { setOpen(false); void store.signOut() }}
            >
              {t('signOut')}
            </button>
          ) : (
            <button type="button" style={styles.link} onClick={startSignIn}>{t('signIn')}</button>
          )}
        </section>
      )}

      {/* Only the rail needs the hover label; in the wide column it would
          just repeat the line already printed beside the icon. */}
      <MaybeTooltip label={wide ? undefined : summary()}>
        <button
          type="button"
          style={{ ...styles.trigger, ...wide ? {} : styles.railTrigger }}
          aria-label={t('triggerAria')}
          aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}
        >
          <IconUserOutline16 size={wide ? 16 : 18} />
          {wide && <span style={styles.triggerValue}>{summary()}</span>}
        </button>
      </MaybeTooltip>

      {/*
        Re-entry is the whole login page again, not an inline password box:
        the coordinator only re-arms its queue when the current session stops
        being blank, so a user who signs out while sitting on the empty Hero
        would otherwise have no way back in.
      */}
      {signingIn && (
        <SignInForm
          callHost={callHost}
          t={t}
          onSignedIn={() => { setSigningIn(false); void store.signedIn() }}
          onDismiss={() => setSigningIn(false)}
        />
      )}
    </div>
  )
}
