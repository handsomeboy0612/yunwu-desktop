import { describe, expect, it } from 'vitest'

import {
  appendFileReference,
  fileReferenceLabel,
  fileReferenceSource,
  fileReferenceText,
  FILE_REFERENCE_SOURCE,
} from '../../openlux-plugin-account/src/client/file-reference.ts'

/**
 * A composer that records what was asked of it.
 * @param draft - the starting draft.
 * @param refusals - how many leading `insertReference` calls answer `false`,
 * the way the real one does when another writer moved the draft first.
 */
function fakeComposer(draft: string, refusals = 0): {
  readonly composer: Parameters<typeof appendFileReference>[0]
  readonly inserts: { ref: string; label: string; appearance: string; clipboardText: string; start: number; rev: number }[]
  draftNow: () => string
} {
  let text = draft
  let rev = 7
  const inserts: { ref: string; label: string; appearance: string; clipboardText: string; start: number; rev: number }[] = []
  const composer = {
    setDraft(next: string) { text = next; rev += 1 },
    notify() {},
    insertReference(reference: { ref: string; label: string; appearance?: string; clipboardText?: string }, span: { start: number; draftRev: number }) {
      inserts.push({
        ref: reference.ref,
        label: reference.label,
        appearance: reference.appearance ?? '',
        clipboardText: reference.clipboardText ?? '',
        start: span.start,
        rev: span.draftRev,
      })
      if (inserts.length <= refusals) return false
      // What the machine does on success, as far as this seam can see it: the
      // label lands in the draft with a separator after it.
      text = `${text.slice(0, span.start)}@${reference.label} `
      rev += 1
      return true
    },
    state: { getSnapshot: () => ({ draft: text, draftRev: rev }) },
  }
  return { composer: composer as unknown as Parameters<typeof appendFileReference>[0], inserts, draftNow: () => text }
}

/**
 * An attached file has to arrive in the draft, and the model has to receive the
 * path — those are two different strings now, which is the whole risk of showing
 * a chip instead of the path itself.
 */
describe('file reference chips', () => {
  it('serializes to the kernel quoted file mention', async () => {
    // The one string the model sees. It is asserted here rather than trusted
    // because the chip hides any change to it: the composer would look
    // perfectly right while the sent bubble stopped re-decorating. Only the
    // `@"path"` shape survives the send — `ui-conversation`'s
    // `projectUserText` re-chips sent text by shape alone, and the backticked
    // path this codec produced before 2026-08-28 degraded to raw text in
    // every sent bubble. Always quoted: the bare-token scan strips trailing
    // punctuation off unquoted tokens, and Windows filenames cannot contain
    // `"`, so one shape covers every path (see `file-reference.ts`).
    expect(fileReferenceText('D:\\work\\deck_342.pptx')).toBe('@"D:\\work\\deck_342.pptx"')
    expect(await fileReferenceSource.codec?.serialize?.('D:\\a\\b.pptx', {} as never))
      .toBe('@"D:\\a\\b.pptx"')
    // The clipboard projection is the *same* string, because it is also the
    // persisted one: the kernel stores a draft with its reference ranges
    // expanded to `clipboardText` (`projectClipboard`), so a restart turns the
    // chips back into this text and the send then ships it verbatim. Bare paths
    // would lose their delimiters here, and two space-separated Windows paths
    // with a space inside one of them cannot be told apart.
    expect(fileReferenceSource.codec?.clipboardText?.('D:\\a\\b.pptx')).toBe('@"D:\\a\\b.pptx"')
  })

  it('contributes no candidates, so the @ menu is upstream\'s alone', async () => {
    // The source exists to own serialization. If it ever answered candidates,
    // it would double every row of upstream's own file group (measured: 70 rows
    // from one cwd), and `@` is the busiest affordance in the composer.
    expect(fileReferenceSource.trigger).toBe('@')
    expect(fileReferenceSource.name).toBe(FILE_REFERENCE_SOURCE)
    expect(await fileReferenceSource.candidates({} as never, {} as never)).toEqual([])
  })

  it('labels the chip with the file name, either separator', () => {
    expect(fileReferenceLabel('D:\\work\\yunwu\\deck_342.pptx')).toBe('deck_342.pptx')
    expect(fileReferenceLabel('/home/me/report.xlsx')).toBe('report.xlsx')
    // A path that ends in a separator has no name part; showing an empty chip
    // would be a chip the user cannot read or aim at.
    expect(fileReferenceLabel('D:\\work\\')).toBe('D:\\work\\')
  })

  it('separates the chip from whatever the user was typing', () => {
    const { composer, inserts, draftNow } = fakeComposer('看看这个')
    expect(appendFileReference(composer, 'D:\\a\\deck.pptx')).toBe(true)
    // The machine appends a gap after a reference and nothing before it, so
    // without this the draft would read `看看这个@deck.pptx`.
    expect(draftNow()).toBe('看看这个 @deck.pptx ')
    expect(inserts).toEqual([{
      ref: 'D:\\a\\deck.pptx',
      label: 'deck.pptx',
      appearance: 'file',
      // The occurrence's own projection, which is what a restart restores from.
      clipboardText: '@"D:\\a\\deck.pptx"',
      start: 5,
      rev: 8,
    }])
  })

  it('re-reads and retries when the draft moved under it', () => {
    // A refusal means another writer got there first (a restoring draft, the
    // user typing) and that nothing was written — so the honest response is to
    // read again, not to give up on the chip. Measured once on 2026-08-24: a
    // batch of two files landed one chip and dropped the other, on a view that
    // was restoring its previous draft.
    const { composer, inserts, draftNow } = fakeComposer('看看这个', 1)
    expect(appendFileReference(composer, 'D:\\a\\deck.pptx')).toBe(true)
    expect(inserts).toHaveLength(2)
    // Second attempt, so the chip is what landed — not the text arm.
    expect(draftNow()).toBe('看看这个 @deck.pptx ')
  })

  it('falls back to text only after the retry is refused too', () => {
    // Still nothing written by either attempt, so the file has to arrive as the
    // text it was before chips existed.
    const { composer, inserts, draftNow } = fakeComposer('已经写了一半', Infinity)
    expect(appendFileReference(composer, 'D:\\a\\deck.pptx')).toBe(true)
    expect(inserts).toHaveLength(2)
    // Including the separator that was added for the chip that did not happen.
    expect(draftNow()).toBe('已经写了一半\n@"D:\\a\\deck.pptx"')
  })

  it('answers false when no composer is mounted, so the caller can write text instead', () => {
    expect(appendFileReference(undefined, 'D:\\a\\deck.pptx')).toBe(false)
  })
})
