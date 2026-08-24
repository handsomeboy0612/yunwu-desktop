/**
 * The hero seat says nothing about the three shipped modes and everything about
 * a summoned expert. These are the rules that line stays on.
 *
 * Worth pinning because the failure is silent in both directions: too eager and
 * `标准模式` is back in the user's face, too shy and a session runs an expert
 * with nothing on screen saying so and no way off it.
 */

import { describe, expect, it } from 'vitest'
import { chipName, type RosterView } from '../../openlux-plugin-account/src/client/preset-roster.ts'

/**
 * A roster as the chip holds it.
 * @param defaultId - the deployment default, or undefined for none.
 * @param rows - id to display name.
 * @returns the snapshot shape `chipName` reads.
 */
function roster(defaultId: string | undefined, rows: Record<string, string> = {}): RosterView {
  return {
    read: true,
    defaultId,
    rows: Object.fromEntries(
      Object.entries(rows).map(([id, name]) => [id, { name, trust: 'user' as const }]),
    ),
  }
}

describe('hero preset chip', () => {
  it('says nothing before the first roster read: an id flashing into a name looks like a bug', () => {
    const cold: RosterView = { read: false, defaultId: undefined, rows: {} }
    expect(chipName(cold, 'super-director')).toBeUndefined()
  })

  it('says nothing about the default: the shipped modes are plumbing, not a question', () => {
    expect(chipName(roster('standard', { standard: '标准模式' }), 'standard')).toBeUndefined()
  })

  it('names a summoned expert by the name its own metadata published', () => {
    const view = roster('standard', { standard: '标准模式', 'super-director': '超级独董会' })
    expect(chipName(view, 'super-director')).toBe('超级独董会')
  })

  it('names any other shipped composition too, so a creator-mode session is not silent', () => {
    const view = roster('standard', { standard: '标准模式', cordis: '创造模式' })
    expect(chipName(view, 'cordis')).toBe('创造模式')
  })

  it('falls back to the id for a preset installed since the last read', () => {
    expect(chipName(roster('standard', { standard: '标准模式' }), 'just-installed'))
      .toBe('just-installed')
  })

  it('says nothing for a session composed from no preset', () => {
    expect(chipName(roster('standard'), undefined)).toBeUndefined()
    expect(chipName(roster('standard'), '')).toBeUndefined()
  })

  it('still names a preset in a deployment that declares no default', () => {
    expect(chipName(roster(undefined, { writer: '文爆爆' }), 'writer')).toBe('文爆爆')
  })
})
