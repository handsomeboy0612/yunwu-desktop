/**
 * An attached file as one inline reference chip, instead of a path in prose.
 *
 * ## The result being reproduced
 *
 * WorkBuddy's composer shows an attached file as a compact tag — a file glyph
 * plus the file's own name — and never the path
 * (`conversation-render/src/chat-input/editor/components/input-context.tsx`,
 * `InputContextTag`, whose `fileTag` variant is what the screenshots show).
 * Ours used to paste the absolute path into the draft as inline code, so three
 * attachments filled three lines with `D:\work\…` and the question the user was
 * writing scrolled out of the box.
 *
 * ## Why this is the kernel's own mechanism and not a widget of ours
 *
 * The composer already has chips: `dsh-client-ui-reference`'s `@` completion
 * mints one per picked file, the input machine keeps them as *occurrences* over
 * draft ranges, and the mirror layer draws each as `icon + label`
 * (`ui-conversation` `deriveDecorations` → `data-decoration="chip"`). Two seams
 * make that reachable from here:
 *
 * - `SessionInput.insertReference(reference, span)` — the same verb the `@`
 *   pipeline dispatches (`slash/input-insert-reference`), reachable through the
 *   composer face we already resolve for notices (`summon.ts`'s `composerFor`).
 *   The span is CAS'd on `draftRev`, so a stale read simply does not apply.
 * - `InputTriggerSource.codec.serialize` — at submit time each occurrence's
 *   range is replaced by its owner source's model form
 *   (`ui-input-trigger`'s `serializeReference`; a source with no codec *blocks
 *   the send* rather than downgrading). That is what lets the draft read
 *   `@deck_342.pptx` while the model receives the absolute path it can open.
 *
 * So the whole change is: mint an occurrence instead of writing text, and
 * register one source to own the serialization. `appearance: 'file'` is a
 * kernel-declared value (`ReferenceInsert.appearance` is
 * `'session' | 'file' | 'folder'`), which is where the glyph comes from.
 *
 * ## The model's form is the kernel's own mention grammar
 *
 * `fileReferenceText` serializes a chip to `@"<absolute path>"` — the quoted
 * file-mention shape of `dsh-client-ui-reference` (`formatFileMention`). Two
 * things hang off that shape and off no other:
 *
 * - **The sent bubble re-decorates it.** `ui-conversation`'s `projectUserText`
 *   scans sent text by shape alone — `(^|\s)` then `/name`, `@token` or
 *   `@"quoted path"` — and draws icon + basename in business colour. The
 *   backticked path this codec produced before 2026-08-28 was invisible to
 *   that scan, so every attachment degraded to a raw path the moment the
 *   message was sent.
 * - **The host attaches nothing to it.** File mentions are a plain text suffix
 *   on the user message (the reference README's KV-cache note; only *session*
 *   mentions are validated at `agent/pre-step`), so the swap is notation-only
 *   for the model — and it is the notation stock DSH already ships when a
 *   file is picked from the `@` menu.
 *
 * Upstream quotes only paths containing whitespace; this codec quotes always.
 * The bubble's bare-token scan strips trailing punctuation (`.,;:!?，。；：！？`)
 * off an unquoted token, which can eat the tail of a filename, and Windows
 * filenames cannot contain `"` (`formatFileMention` refuses such paths for the
 * same reason) — so the quoted form is one shape that is safe for every path.
 *
 * ## The chip does not outlive the view, and that is what decides `clipboardText`
 *
 * Occurrences are not persisted: the draft is stored as its *clipboard
 * projection*, every reference range replaced by that occurrence's
 * `clipboardText` (`ui-conversation`'s `projectClipboard`, used for both the
 * clipboard and the chat store). So a restart — measured 2026-08-24, and the
 * same on any remount — brings the draft back as flat text.
 *
 * That is why `clipboardText` is the *quoted mention* rather than the bare
 * path. The restored text has to be the exact string the send would have
 * produced, because it is now what the send *will* produce, and bare paths
 * joined by spaces stop being parseable the moment one of them has a space in
 * it — `C:\Users\me\My Documents\a.xlsx C:\b.pptx` is unreadable to the model
 * and common on Windows. The cost is that copying a chip yields `@"path"`,
 * which a shell paste would have to strip; that is a human noticing and fixing
 * a visible thing, against an agent silently opening the wrong path.
 *
 * ## What is given up, and why that is the right trade
 *
 * The chip shows the basename, so the path is no longer readable on screen (the
 * native tooltip is the label too — `title: chip.label` is upstream's, not
 * ours). That is WorkBuddy's behaviour, and it is the reason the composer stays
 * readable with several files attached; the path is still one copy away.
 *
 * @module openlux-plugin-account/client/file-reference
 */

import type { ReferenceInsert, InputTriggerSource, TokenSpan } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { SessionComposer } from './summon.ts'

/**
 * Source name owning these chips.
 *
 * It is the occurrence's serializer routing key: the submit attempt looks the
 * name up across every registered source (`roster.all()`, not per trigger) and
 * calls that source's codec. Renaming it retires every chip minted before the
 * rename — they would fail to serialize and block the send — so it is written
 * once and read from here.
 */
export const FILE_REFERENCE_SOURCE = 'openlux-file'

/**
 * The model's form of one attached file: a quoted kernel file mention.
 *
 * See the module note on the mention grammar for why this shape and why the
 * quotes are unconditional. The persona guidance is shape-agnostic — "文件路径
 * 是本机真实存在的文件" keys on the path appearing in the message, not on any
 * delimiter (`persona/tool-reality.ts`) — so nothing model-side kept the old
 * backticks alive.
 * @param path - the file's absolute path.
 * @returns the text that replaces the chip's range at submit time.
 */
export function fileReferenceText(path: string): string {
  return `@"${path}"`
}

/**
 * The chip's label: the file's own name.
 * @param path - the file's absolute path (either separator).
 * @returns the basename, or the whole path when it has no name part.
 */
export function fileReferenceLabel(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const name = cut === -1 ? path : path.slice(cut + 1)
  return name === '' ? path : name
}

/**
 * The registry entry that owns these chips.
 *
 * It contributes no candidates: the `@` menu's file list is upstream's job
 * (`dsh-client-ui-reference`, which lists the session's working directory),
 * whereas this source exists so occurrences minted by the file button have an
 * owner to serialize them. A source whose `candidates` answers empty renders
 * nothing at all — the menu drops ready-and-empty groups
 * (`ui-input-trigger`'s `MenuView`: `items.length === 0 ? null`) and closes
 * when every group is empty.
 *
 * `'@'` rather than `'/'` because that is the reference family; the choice is
 * cosmetic for serialization, which searches every trigger's roster.
 */
export const fileReferenceSource: InputTriggerSource = {
  trigger: '@',
  name: FILE_REFERENCE_SOURCE,
  showGroupTitle: false,
  candidates: () => Promise.resolve([]),
  // Unreachable (nothing can be picked from an empty group), but the contract
  // asks for it: `undefined` means "not mine", which is the honest answer.
  onPick: () => undefined,
  codec: {
    // Both projections are the same string on purpose: see the note above on
    // persistence — the copied form and the restored form are the same form.
    clipboardText: ref => fileReferenceText(ref),
    serialize: ref => Promise.resolve(fileReferenceText(ref)),
  },
}

/** How many times a refused insert is re-read and re-tried before giving up. */
const INSERT_ATTEMPTS = 2

/**
 * Put one attached file on a session's composer.
 *
 * `insertReference` is CAS'd on `draftRev` and answers `false` when the draft
 * moved between the read and the write, having written nothing. Something else
 * writing that draft is normal rather than exceptional — the user typing while a
 * file was staged, the persisted draft being restored into a freshly mounted
 * view, this plugin's own rail re-routing — so a refusal is re-read and retried
 * before the text arm is considered. Measured once on 2026-08-24, a batch of two
 * files landed one chip and dropped the other on a view that was restoring its
 * previous draft; retrying is what closes that, and a refusal wrote nothing, so
 * it cannot double-insert.
 *
 * The text arm is not decoration either: it is what a composition without chips
 * would have done anyway, and it reads the live draft rather than the snapshot
 * that just lost the race, so a chip that already landed is never overwritten.
 *
 * The leading space is ours to add: the machine appends a separator *after* the
 * reference (`replaceSpanWithChip`'s `gap`) and nothing before it, so a chip
 * minted at the end of `写个总结` would read `写个总结@deck_342.pptx`.
 * @param composer - the session's composer facade, when one is mounted.
 * @param path - the staged file's absolute path.
 * @returns whether the path landed in that draft, in either form.
 */
export function appendFileReference(composer: SessionComposer | undefined, path: string): boolean {
  if (composer === undefined) return false
  const reference: ReferenceInsert = {
    source: FILE_REFERENCE_SOURCE,
    ref: path,
    label: fileReferenceLabel(path),
    appearance: 'file',
    // This is the one the draft is persisted through; the codec's is the same.
    clipboardText: fileReferenceText(path),
  }
  for (let attempt = 0; attempt < INSERT_ATTEMPTS; attempt += 1) {
    const before = composer.state.getSnapshot()
    if (before.draft !== '' && !/\s$/u.test(before.draft)) composer.setDraft(`${before.draft} `)
    const at = composer.state.getSnapshot()
    const span: TokenSpan = { start: at.draft.length, end: at.draft.length, draftRev: at.draftRev }
    if (composer.insertReference(reference, span)) return true
  }
  // Same shape the draft carried before chips — its own line. The separator
  // added above comes back off: it was for a chip that is not happening, and a
  // path is easier to read at the start of a line than trailing a sentence.
  const now = composer.state.getSnapshot().draft.replace(/[ \t]+$/u, '')
  composer.setDraft(now === '' || now.endsWith('\n') ? `${now}${fileReferenceText(path)}` : `${now}\n${fileReferenceText(path)}`)
  return true
}
