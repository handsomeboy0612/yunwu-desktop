/**
 * The hero's agent-preset seat: nothing at all, until a session runs something
 * other than the default — then one chip naming it, with the way back.
 *
 * ## The result being reproduced
 *
 * WorkBuddy's input area carries a family of chips over one `chipBase`, and
 * every one of them is «absent unless chosen, dismissible once shown»: its
 * expert chip opens with `if (!selectedExpert) return null` and hangs a close
 * button off the name (`input.expertChip.clear` = 「取消选中专家 {name}」), and
 * its mode chip is the same shape (`input.modeChip.clear` = 「退出{mode}模式」).
 * Cancelling is a first-class state over there, not an absence of one: its own
 * conversation API documents `expertId: ""` as 「取消专家（回默认 agent）」.
 * The *choice* of mode is nowhere near the composer — it is two cards on the
 * welcome screen (`welcome.mode.coding` / `welcome.mode.working`).
 *
 * What the kernel ships in this seat is the opposite: a dropdown that is always
 * on screen and lists every composition the deployment has, so `标准模式`,
 * `PTC模式` and `创造模式` sit in a menu beside the experts. Those three are how
 * this product is assembled, not a question to ask its user.
 *
 * ## Why this is not a kernel patch
 *
 * Because the kernel offers the seat. `conversation.hero.agentPreset` is a
 * declared slot of `kind: 'single'`, and its own catalog entry names the
 * incumbent and the risk of taking it over (`occupants: ['client-ui-agent-preset
 * AgentPresetSeat']`, `replaceRisk: 'shadows-shipped-ui'`). Registering at a
 * lower priority is the documented way to become the one that renders — the
 * registry says so in the error it throws on a tie: «register at a different
 * priority to shadow it (lowest renders)». Our account row already took the
 * settings trigger this way (`AccountTrigger.tsx`).
 *
 * So nothing is vendored and nothing has to be re-applied on the next kernel
 * bump. The kernel keeps everything else it owns here: the roster RPC, the
 * refusal rules, the `agent-preset/selected` broadcast, the header label that
 * names the composition of a session already under way, and the whole Agent
 * preset settings section where the three modes still live.
 *
 * ## Why the × can only ever work here
 *
 * This seat is the new-session screen. A session's composition is fixed once its
 * first turn runs — the host refuses the switch and the kernel moves the display
 * to a read-only header label — so «take it off» is a question that exists
 * exactly while this chip does.
 *
 * @module openlux-plugin-account/client/PresetChip
 */

import { useEffect } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  IconAgentPresetOutline16,
  IconCloseFill14,
  Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the conversation package's slot rows, including
// 'conversation.hero.agentPreset', into the SlotMap this file is typed against.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { chipName, type PresetRoster } from './preset-roster.ts'

/** DOM marker the live checks look for. */
export const PRESET_CHIP_ID = 'openlux-preset-chip'

/**
 * One below the kernel's own seat (priority 0), which is what makes this the
 * rendered one. Registering at 0 throws instead: the registry names the
 * incumbent and points at this exact knob.
 */
export const PRESET_CHIP_PRIORITY = -1

/** What the chip needs from the plugin body. */
export interface PresetChipInjected {
  readonly hooks: {
    /** Roster snapshot source; the renderer binds it as usePresetRoster. */
    readonly presetRoster: PresetRoster
  }
  /** Read the roster; called on mount and whenever a preset id is unknown. */
  readonly read: () => void
  /**
   * Put this session back on the default, reporting a refusal to its composer.
   * @param sessionId - the session the chip is drawn for.
   */
  readonly clear: (sessionId: SessionId) => void
}

const styles = {
  name: {
    maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    color: 'var(--dsw-alias-label-primary)',
  },
  icon: { flex: 'none', display: 'flex', color: 'var(--dsw-alias-label-secondary)' },
  // Its own button inside the pill: the pill is a display, and the only action
  // here is removal. Sized to the pill's 24px so the hit area is the full height.
  clear: {
    flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '16px', height: '16px', marginRight: '-2px', padding: 0,
    border: 'none', borderRadius: '8px', background: 'none', cursor: 'pointer',
    color: 'var(--dsw-alias-label-tertiary)',
  },
} satisfies Record<string, CSSProperties>

/**
 * Render the seat.
 * @param props - the hero's owner share (nothing) plus this package's face.
 * @returns the chip, or null while the session runs the default.
 */
export function PresetChip(
  props: PropsRuntime<'conversation.hero.agentPreset'>
    & PropsLocale<'openlux.market'>
    & InjectFace<PresetChipInjected>,
): ReactNode {
  const { t, read, clear, useSessions, usePresetRoster } = props
  const roster = usePresetRoster(view => view)
  // Primitives rather than the row object: a selector must return a stable
  // reference between changes, which a projection of the row would not be.
  const sessionId = useSessions(state => state.current)
  const preset = useSessions(state => (
    state.current === undefined ? undefined : state.byId[state.current]?.agentPreset
  ))

  useEffect(() => { read() }, [read])

  // A preset installed after the last read is not on the roster yet, so its name
  // would come out as its id. Same self-heal the kernel's seat does.
  const known = preset === undefined || roster.rows[preset] !== undefined
  useEffect(() => {
    if (roster.read && !known) read()
  }, [roster.read, known, read])

  const name = chipName(roster, preset)
  if (name === undefined || sessionId === undefined) return null

  // Marker and hint ride the name rather than the pill: `Pill`'s static branch
  // (the one without an onClick) drops its rest props, so nothing put on the
  // pill itself reaches the DOM — only its interactive branch spreads them.
  return (
    <Pill>
      <span style={styles.icon} aria-hidden="true"><IconAgentPresetOutline16 size={14} /></span>
      <span style={styles.name} data-testid={PRESET_CHIP_ID} title={t('presetChipHint', { name })}>
        {name}
      </span>
      <button
        type="button"
        style={styles.clear}
        aria-label={t('presetChipClear', { name })}
        title={t('presetChipClear', { name })}
        data-testid={`${PRESET_CHIP_ID}-clear`}
        onClick={() => { clear(sessionId) }}
      >
        <IconCloseFill14 size={12} />
      </button>
    </Pill>
  )
}
