/**
 * «我的专家» shows what this person wrote, which is one filter over a roster the
 * kernel owns.
 *
 * Pinned because the mistake is silent: a missed `itemId` turns the page into a
 * list of downloads and a missed `trust` fills it with the shipped modes —
 * neither throws, both just quietly stop being the page WorkBuddy ships.
 */

import { describe, expect, it } from 'vitest'
import { createdExperts } from '../../openlux-plugin-account/src/client/expert-rows.ts'
import type { InstalledPreset } from '../../openlux-plugin-account/src/market/wire.ts'

/**
 * One roster row as the host describes it.
 * @param id - preset id.
 * @param trust - who put it there, in the kernel's words.
 * @param itemId - the catalog item it was installed from, when it was.
 * @returns the row.
 */
function preset(id: string, trust: 'system' | 'user', itemId?: string): InstalledPreset {
  return { id, trust, name: id, ...itemId === undefined ? {} : { itemId } }
}

describe('我创建的', () => {
  it('keeps what was authored here and drops what the market installed', () => {
    const rows = createdExperts([
      preset('standard', 'system'),
      preset('cordis', 'system'),
      preset('my-editor', 'user'),
      preset('growth-team', 'user', 'growth-team'),
    ])
    expect(rows.map(row => row.id)).toEqual(['my-editor'])
  })

  it('says nothing rather than something when nobody has authored one', () => {
    expect(createdExperts([preset('standard', 'system'), preset('writer', 'user', 'writer')]))
      .toEqual([])
  })
})
