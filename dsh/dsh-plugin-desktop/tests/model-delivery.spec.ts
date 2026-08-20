/**
 * The delivered model list is the console's to state, and the user's own rows
 * have to survive it.
 *
 * Both halves of that sentence are one-way doors in production. A round that
 * mistakes a user's row for one of ours deletes something they cannot get back;
 * a round that mistakes one of ours for theirs freezes a list operations can no
 * longer change. Neither surfaces as an error — the list just quietly holds the
 * wrong thing — so these cases are about which side of that line an entry falls
 * on, not about merge arithmetic.
 *
 * The tag cases matter for the same reason at the other end: the delivery
 * switch is a free-text column somebody types into, so "beside another tag",
 * "under the other comma" and "inside a longer word" are what it will actually
 * contain.
 */

import { describe, expect, it } from 'vitest'
import {
  deliveredIds,
  FALLBACK_MODELS,
  isManaged,
  type Listed,
  MANAGED_FLAG,
  MANAGED_TAG,
  merge,
  type ModelEntry,
} from '../../openlux-plugin-account/src/models/delivery.ts'

/** One square row, tagged the way the console tags it. */
function row(id: string, tags?: string): Listed {
  return tags === undefined ? { id } : { id, tags }
}

/** The pool as it looks today: real capability tags, none of them the delivery one. */
const UNTAGGED: readonly Listed[] = [
  row('deepseek-v4-flash', '对话,工具'),
  row('deepseek-v4-pro', '对话,思考,工具'),
  row('claude-opus-4-8', '对话,识图,工具'),
  row('gemini-3.1-pro-preview', '对话,识图'),
  row('gpt-5.4', '对话,工具'),
  row('glm-5.3', '对话'),
]

describe('deliveredIds', () => {
  it('falls back to the shipped list while the console tags nothing', () => {
    expect(deliveredIds(UNTAGGED)).toEqual([...FALLBACK_MODELS])
  })

  it('drops a fallback id this key cannot reach', () => {
    const thin = UNTAGGED.filter(model => model.id !== 'claude-opus-4-8')
    expect(deliveredIds(thin)).not.toContain('claude-opus-4-8')
    expect(deliveredIds(thin)).toHaveLength(FALLBACK_MODELS.length - 1)
  })

  it('hands the list over the moment one model carries the tag', () => {
    const tagged = [row('glm-5.3', `对话,${MANAGED_TAG}`), row('deepseek-v4-flash', '对话,工具')]
    expect(deliveredIds(tagged)).toEqual(['glm-5.3'])
  })

  it('keeps square order rather than the fallback order', () => {
    const tagged = [row('gpt-5.4', MANAGED_TAG), row('deepseek-v4-flash', MANAGED_TAG)]
    expect(deliveredIds(tagged)).toEqual(['gpt-5.4', 'deepseek-v4-flash'])
  })

  it('reads the tag beside others and under either comma', () => {
    const cells = [MANAGED_TAG, `对话,${MANAGED_TAG}`, `对话，${MANAGED_TAG}`, `对话 ${MANAGED_TAG} 工具`]
    for (const cell of cells) expect(deliveredIds([row('glm-5.3', cell)])).toEqual(['glm-5.3'])
  })

  it('matches a whole tag, not a prefix of a longer word', () => {
    const pool = [row('glm-5.3', `${MANAGED_TAG}位`), ...UNTAGGED]
    expect(deliveredIds(pool)).toEqual([...FALLBACK_MODELS])
  })
})

describe('merge', () => {
  const mine: readonly ModelEntry[] = [
    { id: 'my-local-model', name: '我自己加的', contextWindow: 128000 },
  ]

  it('leads with what we deliver and keeps the user behind it', () => {
    const merged = merge(['deepseek-v4-flash'], mine)
    expect(merged.map(entry => entry.id)).toEqual(['deepseek-v4-flash', 'my-local-model'])
    expect(merged.filter(isManaged).map(entry => entry.id)).toEqual(['deepseek-v4-flash'])
  })

  it('passes a user row through field for field, unmarked', () => {
    const merged = merge(['deepseek-v4-flash'], mine)
    expect(merged[1]).toEqual(mine[0])
    expect(merged[1]?.[MANAGED_FLAG]).toBeUndefined()
  })

  it('lists a colliding id once, as ours', () => {
    const collides: readonly ModelEntry[] = [{ id: 'deepseek-v4-flash', name: '用户改过的名字' }]
    const merged = merge(['deepseek-v4-flash'], collides)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toEqual({ id: 'deepseek-v4-flash', [MANAGED_FLAG]: true })
  })

  it('drops what we delivered last round and no longer deliver', () => {
    const written: readonly ModelEntry[] = [{ id: 'was-delivered', [MANAGED_FLAG]: true }, ...mine]
    const merged = merge(['deepseek-v4-flash'], written.filter(entry => !isManaged(entry)))
    expect(merged.map(entry => entry.id)).toEqual(['deepseek-v4-flash', 'my-local-model'])
  })

  it('leaves only the user when the delivery is empty, which is why the caller guards on the pool', () => {
    expect(merge([], mine)).toEqual(mine)
  })
})
