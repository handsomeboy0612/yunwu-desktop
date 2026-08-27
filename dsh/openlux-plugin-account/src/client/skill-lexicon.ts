/**
 * A supplementary `/` lexicon so skills installed *this run* decorate as chips.
 *
 * ## The gap being closed
 *
 * The chip on a plain-text `/name` token is driven by the trigger lexicon —
 * the union of every registered source's `lexicon()` roll for that trigger
 * char (`ui-input-trigger`'s `refreshLexicon` concatenates rolls per trigger).
 * The kernel's own skill source answers from a per-session catalog cache that
 * is invalidated only by `agent-preset/selected` and `connection/reset`
 * (`ui-skill/lib/client.js`: `invalidate` has exactly those two wires) —
 * installing a skill clears nothing. So a session whose catalog was warmed
 * before the install keeps a roll without the new name, and 「试一试」's
 * prefilled `/name ` sits undecorated until a restart. Measured 2026-08-28:
 * a freshly installed `canvas-design` stayed plain text while the
 * boot-time-installed `docx` drew its chip.
 *
 * ## Why a second source and not a kernel patch
 *
 * `inputTriggers.registerSource` is the published registry; the controller
 * folds a late source's roll into the live lexicon (`controller.d.ts`: "warm
 * it and fold its roll") and re-polls on `subscribeLexicon` notifications; a
 * source whose `candidates` answers empty renders no menu group at all. That
 * is the same "registered only to own one concern" shape as
 * `file-reference.ts`'s serialization source — the kernel stays untouched and
 * the slash menu stays the kernel's alone.
 *
 * ## Scope of the roll
 *
 * The roll mirrors the market's latest `market.skills` read (enabled skills'
 * front-matter names) and is `undefined` before one lands. That gap is
 * harmless by construction: before the market has been touched this run, the
 * only skills on disk are boot-time ones, which the kernel's own catalog
 * already rolls. Uninstalls republish too, but the kernel's stale roll may
 * keep decorating a removed name until its own invalidation — acceptable,
 * because the chip is presentation; the invocation contract is the host-side
 * pre-step either way (`ui-skill` README's model-visibility note).
 *
 * @module openlux-plugin-account/client/skill-lexicon
 */

import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'

/** The latest published roll; `undefined` = no `market.skills` read yet. */
let roll: readonly string[] | undefined

/** Controllers to re-poll when the roll moves (one per mounted session). */
const listeners = new Set<() => void>()

/**
 * Publish the enabled skills' names as the supplementary roll.
 *
 * Called from the market's single `market.skills` landing point, which every
 * path that changes the skill root already funnels through (install, local
 * import, enable/disable — each re-reads the roster afterwards).
 * @param names - enabled skills' front-matter names, the `/name` literals.
 */
export function publishSkillLexicon(names: readonly string[]): void {
  roll = names
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // One session's dead controller must not starve the others.
    }
  }
}

/**
 * The registry entry. Contributes no candidates and claims no picks — it
 * exists so the decoration lexicon sees skills the kernel's cached catalog
 * does not know about yet.
 */
export const skillLexiconSource: InputTriggerSource = {
  trigger: '/',
  name: 'openlux-skill-lexicon',
  showGroupTitle: false,
  candidates: () => Promise.resolve([]),
  // Unreachable (nothing can be picked from an empty group); `undefined`
  // means "not mine", the honest answer either way.
  onPick: () => undefined,
  lexicon: () => roll,
  subscribeLexicon: (_session, listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}
