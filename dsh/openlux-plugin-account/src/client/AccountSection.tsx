/**
 * Account page: who you are, what is left, and the two ways out — the web
 * console, and signing out.
 *
 * ## Why the detail moved out of a popover
 *
 * The sidebar foot now carries one row (`AccountTrigger`), and that row is the
 * kernel's Settings button — the click is the kernel's and opens the panel. So
 * the four balance states, the refresh, and sign-out live here instead, and
 * this section registers first in the nav so the panel opens on it: the shell
 * falls back to `rows[0]` while nothing is selected (`ui-settings-general`
 * SettingsPanel: `rows.find(...) ?? rows[0]?.id`). Pressing the account row
 * therefore still shows the balance in one click, the way the popover did.
 *
 * ## Why this is an identity row, a money summary, and one service row
 *
 * WorkBuddy settles the product shape — identity is the entrance to account
 * preferences — but it has no account page worth copying here. The visual
 * language therefore comes from this shell: the settings column's 720px
 * measure, the models page's radius-12 bordered cards, and quiet ghost rows.
 *
 * The first two cuts each failed in the opposite direction. Four General-style
 * rows stranded short numbers at the far edge of a wide page. A narrow
 * 480px vertical card then became an island in the top-left and made a black
 * button louder than the balance. This version uses the real content width:
 * identity anchors the page, available balance gets the broad side of one
 * horizontal summary, and cumulative spend plus request count share the
 * quieter side. The web console is a descriptive service row, not a black CTA;
 * sign-out remains the least prominent action.
 *
 * The console button is the point of the page as much as the number is —
 * topping up, invoices, and the request log all live on the web and none of
 * them are worth rebuilding here. `window.open` is enough to get there: the
 * desktop host answers a renderer's window request by handing http(s) targets
 * to `shell.openExternal` and denying the in-app window
 * (`dsh-plugin-desktop` electron-runtime: setWindowOpenHandler).
 *
 * The four balance states themselves come from the previous shell, which took
 * them from WorkBuddy's credits area: a failed read and a spent account
 * otherwise render the same, and of those two readings the one the user acts on
 * ("my money is gone") is the wrong one.
 *
 * @module openlux-plugin-account/client/AccountSection
 */

import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  Button, IconChevronRightOutline14, IconRefreshOutline14, IconRightUpOutline14,
  IconUserOutline16, IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the settings shell's slot rows, including
// 'settings.section', into the SlotMap this file is typed against.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { SignInForm } from './SignInForm.tsx'
import type { AccountKey } from './locales.ts'
import type { AccountStore, AccountView } from './store.ts'
import type { AccountHostCaller } from './types.ts'

/** Slot id; also the DOM marker the live checks look for. */
export const ACCOUNT_SECTION_ID = 'openlux-account-section'

/**
 * Before the kernel's General page (order 0), which makes this the row the
 * panel opens on — the account row's one click has to land on the balance.
 */
export const ACCOUNT_SECTION_ORDER = -10

/** The console page this app sends people to: their own request log. */
const CONSOLE_PATH = '/console/log'

/** What the section needs from the plugin body. */
export interface AccountSectionInjected {
  readonly callHost: AccountHostCaller
  readonly t: (key: AccountKey) => string
  readonly store: AccountStore
  /** uSES hook bound to {@link AccountStore}. */
  readonly useAccount: SnapshotSelectorHook<AccountView>
}

const styles = {
  root: { display: 'flex', flexDirection: 'column', gap: '18px', width: '100%', maxWidth: '720px' },
  identity: { display: 'flex', alignItems: 'center', gap: '12px', padding: '2px 0 4px' },
  avatar: {
    flex: 'none',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '42px', height: '42px', borderRadius: '12px',
    background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: '16px', fontWeight: 600, lineHeight: 1, textTransform: 'uppercase',
  },
  identityText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  name: {
    minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    color: 'var(--dsw-alias-label-primary)', fontSize: '16px', fontWeight: 600, lineHeight: '22px',
  },
  identityState: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: '18px' },
  balanceCard: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.45fr) minmax(170px, .75fr)',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '12px', overflow: 'hidden',
  },
  balanceMain: {
    display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '4px',
    minHeight: '112px', padding: '18px 20px',
  },
  balanceHead: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
  },
  caption: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: '18px' },
  amount: {
    display: 'flex', alignItems: 'center', gap: '8px',
    color: 'var(--dsw-alias-label-primary)', fontSize: '28px', fontWeight: 600, lineHeight: '36px',
    fontVariantNumeric: 'tabular-nums',
  },
  tag: {
    flex: 'none', padding: '1px 6px', borderRadius: '4px', fontSize: '11px', lineHeight: '16px',
    border: '1px solid var(--dsw-alias-border-l3)', color: 'var(--dsw-alias-label-secondary)',
  },
  balanceStats: {
    display: 'grid', gridTemplateRows: '1fr 1fr',
    borderLeft: '1px solid var(--dsw-alias-border-l2)',
  },
  stat: {
    display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '2px',
    padding: '12px 16px',
  },
  statDivided: { borderBottom: '1px solid var(--dsw-alias-border-l2)' },
  statValue: {
    color: 'var(--dsw-alias-label-primary)', fontSize: '14px', lineHeight: '20px',
    fontVariantNumeric: 'tabular-nums',
  },
  low: { color: 'var(--dsw-alias-state-warn-primary)' },
  waiting: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '15px', lineHeight: '36px' },
  failed: {
    display: 'flex', alignItems: 'center', gap: '6px',
    color: 'var(--dsw-alias-state-error-primary)', fontSize: '14px', lineHeight: '36px',
  },
  iconButton: {
    flex: 'none',
    display: 'flex', alignItems: 'center', padding: '4px', border: 'none', borderRadius: '6px',
    background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer',
  },
  serviceCard: {
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '12px', overflow: 'hidden',
  },
  serviceRow: {
    boxSizing: 'border-box', width: '100%', height: 'auto', padding: '12px 14px',
    borderRadius: 0, justifyContent: 'flex-start', gap: '12px', textAlign: 'left',
  },
  serviceIcon: {
    flex: 'none',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '32px', height: '32px', borderRadius: '9px',
    background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-secondary)',
  },
  serviceText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1px' },
  serviceTitle: {
    color: 'var(--dsw-alias-label-primary)', fontSize: '14px', fontWeight: 500, lineHeight: '20px',
  },
  serviceDescription: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: '18px',
  },
  chevron: { flex: 'none', display: 'flex', color: 'var(--dsw-alias-label-tertiary)' },
  actions: { display: 'flex', justifyContent: 'flex-end' },
} satisfies Record<string, CSSProperties>

/**
 * Render the account page.
 * @param props - the settings shell's owner share plus this package's face.
 * @returns the page content.
 */
export function AccountSection(
  props: PropsRuntime<'settings.section'> & AccountSectionInjected,
): ReactNode {
  const { callHost, close, t, store, useAccount } = props
  const view = useAccount(snapshot => snapshot)
  const [signingIn, setSigningIn] = useState(false)

  // Opening the panel is the user asking for the current number, not the one
  // the row happened to read at startup.
  useEffect(() => { void store.refresh() }, [store])

  const expired = view.balanceStatus === 'expired'
  const signedIn = view.signedIn && !expired
  const name = view.balance?.username
  const consoleUrl = view.baseUrl === undefined
    ? undefined
    : `${view.baseUrl.replace(/\/+$/, '')}${CONSOLE_PATH}`
  const mark = name !== undefined && name.trim() !== ''
    ? name.trim().slice(0, 1)
    : undefined

  return (
    <div style={styles.root} data-testid={ACCOUNT_SECTION_ID}>
      <div style={styles.identity}>
        <span style={styles.avatar} aria-hidden="true">
          {mark ?? <IconUserOutline16 size={18} />}
        </span>
        <span style={styles.identityText}>
          <span style={styles.name}>
            {name !== undefined && name !== ''
              ? name
              : view.read ? t('signedOut') : t('balanceLoading')}
          </span>
          <span style={styles.identityState}>
            {expired ? t('sessionExpired') : signedIn ? t('signedIn') : t('signedOut')}
          </span>
        </span>
      </div>

      <div style={styles.balanceCard}>
        <div style={styles.balanceMain}>
          <span style={styles.balanceHead}>
            <span style={styles.caption}>{t('availableBalance')}</span>
            {!expired && (
              <button
                type="button"
                style={styles.iconButton}
                aria-label={t('refresh')}
                title={t('refresh')}
                disabled={view.fetching}
                onClick={() => { void store.refresh(true) }}
              >
                <IconRefreshOutline14 size={14} />
              </button>
            )}
          </span>

          {view.balance !== undefined && !expired && (
            <span style={{ ...styles.amount, ...view.balance.low ? styles.low : {} }}>
              {view.balance.display}
              {view.balanceStatus === 'stale' && (
                <span style={styles.tag} title={view.message ?? t('balanceStaleTitle')}>
                  {t('balanceStale')}
                </span>
              )}
            </span>
          )}

          {expired && <span style={styles.failed}>{t('sessionExpired')}</span>}

          {view.balance === undefined && !expired && (
            view.read && view.balanceStatus === 'unavailable'
              ? (
                  <span style={styles.failed} title={view.message ?? t('balanceFailed')}>
                    <IconWarningOutline16 size={14} />
                    {t('balanceFailed')}
                  </span>
                )
              : <span style={styles.waiting}>{t('balanceLoading')}</span>
          )}
        </div>

        <div style={styles.balanceStats}>
          <span style={{ ...styles.stat, ...styles.statDivided }}>
            <span style={styles.caption}>{t('used')}</span>
            <span style={styles.statValue}>{view.balance?.usedDisplay ?? '—'}</span>
          </span>
          <span style={styles.stat}>
            <span style={styles.caption}>{t('requestCount')}</span>
            <span style={styles.statValue}>
              {view.balance === undefined ? '—' : view.balance.requestCount.toLocaleString()}
            </span>
          </span>
        </div>
      </div>

      {consoleUrl !== undefined && (
        <div style={styles.serviceCard}>
          <Button
            variant="ghost"
            style={styles.serviceRow}
            data-testid="openlux-console"
            title={t('consoleTitle')}
            // The host turns a renderer window request into
            // `shell.openExternal`, so this lands in the user's own browser
            // where they are already signed in.
            onClick={() => { window.open(consoleUrl, '_blank', 'noopener') }}
          >
            <span style={styles.serviceIcon} aria-hidden="true">
              <IconRightUpOutline14 size={14} />
            </span>
            <span style={styles.serviceText}>
              <span style={styles.serviceTitle}>{t('console')}</span>
              <span style={styles.serviceDescription}>{t('consoleTitle')}</span>
            </span>
            <span style={styles.chevron} aria-hidden="true">
              <IconChevronRightOutline14 size={14} />
            </span>
          </Button>
        </div>
      )}

      <div style={styles.actions}>
        {signedIn
          ? (
              <Button
                variant="outline"
                size="sm"
                data-testid="openlux-sign-out"
                onClick={() => { void store.signOut() }}
              >
                {t('signOut')}
              </Button>
            )
          : (
              <Button variant="outline" size="sm" onClick={() => setSigningIn(true)}>
                {t('signIn')}
              </Button>
            )}
      </div>

      {/*
        Re-entry is the whole login page again, not an inline password box: the
        coordinator only re-arms its queue when the current session stops being
        blank, so a user who signs out while sitting on the empty Hero would
        otherwise have no way back in. The page's own overlay sits above this
        panel (z-index 1100 against the settings overlay's 1000), and a
        successful sign-in leaves settings altogether — which is the one shell
        affordance a section is handed.
      */}
      {signingIn && (
        <SignInForm
          callHost={callHost}
          t={t}
          onSignedIn={() => { setSigningIn(false); void store.signedIn(); close() }}
          onDismiss={() => setSigningIn(false)}
        />
      )}
    </div>
  )
}
