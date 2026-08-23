/**
 * The sidebar's bottom row: who is signed in, what is left, and the way into
 * settings — one row, not two.
 *
 * ## Why this took the Settings seat instead of sitting beside it
 *
 * The foot has exactly two seats. `sidebar.footer.action` is a list rendered
 * into a single flex row (`ui-sidebar` SidebarRoot.module.css:
 * `.footerActions{display:flex}`), so every entry there splits one line with
 * the others — which is why the account row and the market launcher looked
 * cramped side by side. The other seat is the Settings row, and its content is
 * the single slot `settings.trigger`.
 *
 * WorkBuddy's desktop foot carries one identity row too, with preferences
 * behind it rather than beside it, so that shape is settled product ground. The
 * account therefore moves into the Settings seat: this file shadows the
 * kernel's own trigger content by registering at a lower priority, which the
 * kernel offers as its override knob ("register at a different priority to
 * shadow it (lowest renders)", `ui-slots` SlotCore.register).
 *
 * ## Why it looks like nothing in particular
 *
 * The shell around it is the kernel's, so this row is drawn in the kernel's own
 * sidebar language and nothing else: the icon, the 14px label, and the ghost
 * hover are the ones the Settings row already had, and the only thing added is
 * a muted value on the right — the same label-left/value-right rhythm the
 * settings pages use. No avatar disc, no accent fill, no rule above it: this is
 * the quietest row in the window and it should stay that way, because what the
 * user is here to read is one number.
 *
 * What stays the kernel's: the button, its geometry, and the click — pressing
 * this row opens the settings panel. The balance detail and sign-out the old
 * popover held now live in the Account section that panel opens on, so the row
 * itself is a display, not a second menu.
 *
 * @module openlux-plugin-account/client/AccountTrigger
 */

import { useEffect } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the settings shell's slot rows, including
// 'settings.trigger', into the SlotMap this file is typed against.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { AccountKey } from './locales.ts'
import type { AccountStore } from './store.ts'

/** DOM marker the live checks look for; also the old row's id. */
export const ACCOUNT_TRIGGER_ID = 'openlux-account'

/**
 * One below the kernel's own trigger content (priority 0), which is what makes
 * this the rendered one. Registering at 0 throws instead: the kernel names the
 * incumbent and points at this exact knob.
 */
export const ACCOUNT_TRIGGER_PRIORITY = -1

/** What the row needs from the plugin body. */
export interface AccountTriggerInjected {
  readonly t: (key: AccountKey) => string
  readonly store: AccountStore
  readonly hooks: {
    /** Account snapshot source; the renderer binds it as useAccount. */
    readonly account: AccountStore
  }
}

const styles = {
  // The kernel's button is the row (34px, gap 8px, 14px text, `overflow:
  // hidden`), so these styles only say which part shrinks and how loud each
  // part is.
  icon: { flex: 'none', display: 'flex', color: 'var(--dsw-alias-label-secondary)' },
  name: {
    flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    color: 'var(--dsw-alias-label-primary)', textAlign: 'left',
  },
  // One step quieter and one step smaller than the label, like a settings row's
  // current value. It never shrinks — the name does the eliding, because a
  // clipped balance is worse than a clipped account name.
  value: {
    flex: 'none', color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px',
    fontVariantNumeric: 'tabular-nums',
  },
  low: { color: 'var(--dsw-alias-state-warn-primary)' },
  failed: { color: 'var(--dsw-alias-state-error-primary)' },
  // The rail is a 36px circle with no room for text, and the button belongs to
  // the kernel, so this row's accessible name has to come from inside it.
  offscreen: {
    position: 'absolute', width: '1px', height: '1px', margin: '-1px', padding: 0,
    overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
  },
} satisfies Record<string, CSSProperties>

/**
 * Render the bottom row's content.
 * @param props - the settings seat's owner share plus this package's face.
 * @returns the row content, inside the kernel's own button.
 */
export function AccountTrigger(
  props: PropsRuntime<'settings.trigger'> & InjectFace<AccountTriggerInjected>,
): ReactNode {
  const { wide, t, store, useAccount } = props
  const view = useAccount(snapshot => snapshot)

  // This row is mounted for the whole session, so it is where the first read
  // belongs; the Account section refreshes again when it is opened.
  useEffect(() => { void store.refresh() }, [store])

  /** Who the row belongs to — the account name once there is one. */
  const who = (): string => {
    const name = view.balance?.username
    if (name !== undefined && name !== '') return name
    if (!view.read) return t('balanceLoading')
    return view.signedIn ? t('signedIn') : t('signedOut')
  }

  /** What is left, or why that could not be said. Empty while unknown. */
  const worth = (): string => {
    if (view.balanceStatus === 'expired') return t('sessionExpired')
    if (view.balance !== undefined) return view.balance.display
    if (view.read && view.balanceStatus === 'unavailable') return t('balanceFailed')
    return ''
  }

  const tone = view.balanceStatus === 'unavailable' || view.balanceStatus === 'expired'
    ? styles.failed
    : view.balance?.low === true ? styles.low : {}
  const spoken = `${who()}${worth() === '' ? '' : ` — ${worth()}`} — ${t('triggerAria')}`

  if (!wide) {
    return (
      <span style={styles.icon} title={spoken} data-testid={ACCOUNT_TRIGGER_ID}>
        <IconUserOutline16 size={18} />
        <span style={styles.offscreen}>{spoken}</span>
      </span>
    )
  }

  return (
    <>
      <span style={styles.icon} aria-hidden="true"><IconUserOutline16 size={16} /></span>
      <span style={styles.name} data-testid={ACCOUNT_TRIGGER_ID}>{who()}</span>
      <span style={{ ...styles.value, ...tone }}>{worth()}</span>
      <span style={styles.offscreen}>{t('triggerAria')}</span>
    </>
  )
}
