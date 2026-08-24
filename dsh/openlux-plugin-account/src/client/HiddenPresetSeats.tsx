/**
 * The two settings seats that used to expose Agent presets, taken and left blank.
 *
 * The kernel ships a settings page listing every preset and a General row that
 * picks the deployment default. Both are load-bearing for a harness whose
 * presets *are* its modes, and both are noise for us: our presets are experts
 * the market installs, our modes are three built-ins users should not be
 * choosing between, and the reference product has no installed-experts list at
 * all (`references/experts-and-teams.md`: WorkBuddy summons an expert onto the
 * live session and drops it, nothing lands anywhere a user can see).
 *
 * So neither surface gets replaced by ours — they get occupied. The slot
 * catalog says a list slot keys its cells by id, so registering the shipped id
 * at a lower priority makes this the cell's occupant; painting `null` leaves the
 * cell empty. Publishing no `label` then keeps the page out of the settings nav
 * (the shell's nav skips label-less cells — our `settings-general` patch, whose
 * projection this pairs with).
 *
 * Removing an installed expert therefore has no button. That is deliberate: the
 * old shell reconciled against the market snapshot at startup instead of asking
 * (delisted and not in use ⇒ drop the local copy), which is the same job with no
 * page attached.
 *
 * @module openlux-plugin-account/client/HiddenPresetSeats
 */

import type { ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

/** The kernel's own id for the Agent presets page — reusing it takes the cell. */
export const PRESET_SECTION_ID = 'agent-presets'
export const PRESET_SECTION_ORDER = 20
export const PRESET_SECTION_PRIORITY = -1

/** The kernel's own id for the General row that picked the default preset. */
export const PRESET_ROW_ID = 'agent-preset'
export const PRESET_ROW_ORDER = -25
export const PRESET_ROW_PRIORITY = -1

export function HiddenPresetSection(): ReactNode {
  return null
}

export function HiddenPresetRow(): ReactNode {
  return null
}
