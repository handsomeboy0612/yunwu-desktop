/**
 * Sidebar-foot trigger that opens the market overlay.
 *
 * Occupies `sidebar.footer.action` alone — the whole line, because that list is
 * rendered into one flex row and a second entry would split it (the account row
 * used to, and looked it).
 *
 * The geometry is copied off the Settings row directly below it
 * (`ui-settings-general` chrome.module.css `.trigger`: 34px, radius 12, gap 8,
 * bleeding 4px into the sidebar's 12px inset) for one reason: these two are the
 * only rows in the foot, and rows that sit on top of each other and do the same
 * kind of thing — open a surface — should be the same object twice, not two
 * designs.
 *
 * The mark is the Agent-preset one, not the plugin mark DSH Desktop's community
 * market uses and not a generic browse mark: what this gallery hands out is
 * agent presets (`market.catalog` with `type: 'expert'`), and the settings nav
 * already teaches that icon as the word for them. Two doors onto the same kind
 * of object should carry the same sign — one to manage what is installed, this
 * one to go get more.
 *
 * @module openlux-plugin-account/client/MarketLauncher
 */

import type { CSSProperties, ReactNode } from 'react'
import { Button, IconAgentPresetOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the sidebar's slot rows, including 'sidebar.footer.action',
// into the SlotMap this file is typed against.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MarketViewStore } from './market-view-store.ts'

/** Slot id; also the DOM marker. */
export const MARKET_LAUNCHER_ID = 'openlux-market'

/**
 * Same number the community-market launcher uses, so a composition that loaded
 * both would order them by declaration rather than fight over the line.
 */
export const MARKET_LAUNCHER_ORDER = 10

const styles = {
  wide: {
    boxSizing: 'border-box',
    width: 'calc(100% + 8px)',
    height: '34px',
    margin: '4px -4px',
    padding: '6px 2px 6px 10px',
    borderRadius: '12px',
    justifyContent: 'flex-start',
    gap: '8px',
    fontSize: '14px',
    lineHeight: '22px',
  },
  rail: {
    width: '36px',
    height: '36px',
    margin: '8px 0 10px',
    padding: 0,
    justifyContent: 'center',
    borderRadius: '50%',
  },
} satisfies Record<string, CSSProperties>

/**
 * Render the footer action.
 * @param props - column width, the overlay store, and market copy.
 * @returns the trigger.
 */
export function MarketLauncher(
  props: PropsRuntime<'sidebar.footer.action'>
    & PropsLocale<'openlux.market'>
    & PropsStore<MarketViewStore>,
): ReactNode {
  const { wide, useStore, actions, t } = props
  const open = useStore(state => state.open)

  return (
    <Tooltip label={t('nav')} delayMs={500} disabled={wide}>
      <Button
        variant="ghost"
        style={wide ? styles.wide : styles.rail}
        data-testid={MARKET_LAUNCHER_ID}
        aria-label={t('nav')}
        aria-haspopup="dialog"
        aria-expanded={open}
        icon={<IconAgentPresetOutline16 size={wide ? 16 : 18} />}
        onClick={() => actions.open()}
      >
        {wide ? t('nav') : null}
      </Button>
    </Tooltip>
  )
}
