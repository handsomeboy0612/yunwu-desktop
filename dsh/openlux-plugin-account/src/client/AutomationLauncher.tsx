import type { CSSProperties, ReactNode } from 'react'
import { Button, IconRefreshOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { AutomationViewStore } from './automation-view-store.ts'

export const AUTOMATION_LAUNCHER_ID = 'openlux-automation'
export const AUTOMATION_LAUNCHER_ORDER = 5

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
    margin: '8px 0 0',
    padding: 0,
    justifyContent: 'center',
    borderRadius: '50%',
  },
} satisfies Record<string, CSSProperties>

/** Sidebar entry ordered immediately above the market. */
export function AutomationLauncher(
  props: PropsRuntime<'sidebar.footer.action'>
    & PropsLocale<'openlux.automation'>
    & PropsStore<AutomationViewStore>,
): ReactNode {
  const { wide, useStore, actions, t } = props
  const open = useStore(state => state.open)
  return (
    <Tooltip label={t('nav')} delayMs={500} disabled={wide}>
      <Button
        variant="ghost"
        style={wide ? styles.wide : styles.rail}
        data-testid={AUTOMATION_LAUNCHER_ID}
        aria-label={t('nav')}
        aria-haspopup="dialog"
        aria-expanded={open}
        icon={<IconRefreshOutline16 size={wide ? 16 : 18} />}
        onClick={() => actions.open()}
      >
        {wide ? t('nav') : null}
      </Button>
    </Tooltip>
  )
}
