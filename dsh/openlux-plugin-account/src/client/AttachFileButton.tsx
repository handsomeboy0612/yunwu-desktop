/**
 * The composer's file button: any file in, a path into the draft.
 *
 * ## Why the composer needed one at all
 *
 * At this kernel version the composer has no attach control — the `+` is the
 * command menu, and images arrive only by drop or paste, through a route that
 * admits PNG/JPG/WebP/GIF and rejects everything else
 * (`ui-attachment/ComposerAttachments.tsx` hands every dropped file to
 * `onAddImages`). So a user with a pptx had nowhere to put it, while the agent
 * sitting behind that composer has `read_file`, `grep`, and a shell.
 *
 * ## Why a path rather than an upload
 *
 * The file goes to the host, which writes it under the harness home and answers
 * with its absolute path (`files/stage.ts`); the path is what lands in the
 * draft. That is WorkBuddy's shape — the file stays a file and the model opens
 * it with its own tools — and it is the only shape that works for a pptx, a
 * csv, or an mp4 without us parsing documents in-process.
 *
 * The path goes in as inline code because that is how a path reads in prose,
 * and because the persona already tells the model that a path in the user's
 * message is a local file it may open (`persona/tool-reality.ts`).
 *
 * ## Why the button owns the whole gesture
 *
 * `inputActions.setDraft` is the kernel's single public draft-write path, and
 * `useInput`/`inputActions` ride the session standard kit — so a plugin can
 * write the draft without touching the textarea or the kernel. Nothing here
 * reaches into DOM the kernel owns.
 *
 * ## Why dropping lands here too
 *
 * Dropping is how the user tried it first, and the kernel's own drop target
 * answers "PNG/JPG/WebP/GIF only" for everything else — the complaint this
 * module exists to answer. So the same staging path is also reachable by drop:
 * a document listener in the capture phase claims any drop carrying a
 * non-image, ahead of the kernel's bubble-phase listener. Image-only drops are
 * left alone, because the kernel's route gives them a rail, a preview, and the
 * multimodal channel.
 *
 * ## Why an image sometimes comes here anyway
 *
 * That last sentence holds only while the session's model can be handed a
 * picture. When it cannot, the kernel's route is a dead end that only announces
 * itself at send time: the image is admitted into the rail, and pressing Enter
 * answers "the current model does not support images"
 * (`host/apiproxy`'s `MODEL_DOES_NOT_SUPPORT_IMAGES`, raised in `prompt`). The
 * picture is then simply lost, and the user is told to change models rather
 * than being helped.
 *
 * So an image-only drop is routed by whether the selected model declares image
 * input: yes leaves it to the kernel, no brings it here as a path, which the
 * model can then hand to `image_ask` (`media/ask-tool.ts`). Pasting is the same
 * intake by another door — the textarea's `onPaste` hands clipboard files to
 * the same `intakeImages` (`ui-conversation/lib/client.js:3542-3546`) — so it
 * is routed by the same rule. Two facts force that split to live in two
 * places — the browser knows the *selection*
 * (`ctx.modelDirectories`, the same store the picker renders from) and only the
 * host knows the *capability*, because the kernel's wire catalog carries no
 * modalities at all (`ModelCatalogModel` is id/name/description/reasoning, rc.8
 * included). Hence the capability list is fetched from our own host endpoint and
 * kept warm; when either half is unknown the drop is left to the kernel, whose
 * refusal is at least loud.
 *
 * That routing decides at intake, which leaves the other order — picture first,
 * model switched after — still ending at the send-time refusal, since the rail
 * survives the switch. So the rail and the selection are both watched, and a
 * rail that stops being a route is emptied onto the path route in place
 * (`rerouteRail`). The kernel has the seams for it: the input state carries ids,
 * `conversation.draftImages` resolves them back to files, and `removeImage` plus
 * `releaseDraftImage` retire one.
 *
 * The kernel's drag overlay still appears during such a drag, still worded for
 * images. Correcting that means owning `dragenter`/`dragover` as well and
 * rendering a second overlay; that trade (a wrong word during the drag versus a
 * parallel overlay to maintain) is left as it is until the copy actually
 * confuses someone.
 *
 * @module openlux-plugin-account/client/AttachFileButton
 */

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Button, IconPaperclipOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the composer's input-region slots, including
// 'conversation.input.left', into the SlotMap this file is typed against, and
// carries the rail's own two types. The rail ids are branded, so re-declaring
// them structurally would only buy a cast at the one call that matters.
import type { ComposerAttachment, DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { FILE_STAGE_ENDPOINT, FILE_VISION_ENDPOINT, MAX_STAGED_BYTES } from '../files/name.ts'
import type { AccountHostCaller } from './types.ts'

/** Slot id; also the DOM marker. */
export const ATTACH_FILE_ID = 'openlux-attach-file'

/** Ahead of anything else a plugin adds to that row: it is the row's own subject. */
export const ATTACH_FILE_ORDER = 0

/**
 * What the kernel's image intake accepts, so a drop can be routed to whichever
 * half handles it.
 *
 * These are `attachment-local`'s default `mediaTypes`, which
 * `dsh-plugin-desktop/cordis.patch.yml` does not override (it only raises
 * `maxImageBytes`). Widening that config without touching this list would send
 * the new type down our path instead — a worse route for an image, not a broken
 * one, since the model can still open it with `read_image`.
 */
const KERNEL_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** What the host answers; mirrors `files/stage.ts`'s `StageOutcome`. */
type StageOutcome =
  | { kind: 'staged'; path: string }
  | { kind: 'too-large'; limitBytes: number }
  | { kind: 'unreadable' }

/** What the vision endpoint answers; mirrors this plugin's `files.vision` case. */
interface VisionModels {
  /** Our provider route id, so a foreign selection can be recognised as such. */
  route: string
  /** Ids under that route whose settings entry declares image input. */
  models: readonly string[]
}

/** The model a session will run its next turn on. */
export interface ModelChoice {
  provider: string
  model: string
}


/** The business face this entry needs. */
export interface AttachFileInjected {
  /** Calls this plugin's host channel. */
  callHost: AccountHostCaller
  /**
   * Put a message on this session's composer notice strip.
   *
   * The button's own label carries refusals too, which is enough when the user
   * just clicked it — their pointer is right there. A drop is the case that
   * needs this: the user's attention is where the file landed, and a tooltip
   * they have to go hunting for is indistinguishable from silence.
   */
  notify: (level: 'info' | 'error', text: string) => void
  /**
   * This session's current model selection, or undefined when nothing has
   * loaded it yet.
   *
   * Read at drop time, synchronously, because the routing decision has to be
   * made before `preventDefault` — hence a getter rather than a subscription.
   */
  selection: () => ModelChoice | undefined
  /**
   * Call back whenever that selection changes.
   *
   * The routing above decides at intake, which leaves the other order — picture
   * first, model switched after — arriving at send time as the kernel's refusal.
   * Watching the selection is what closes that gap.
   */
  watchSelection: (listener: () => void) => () => void
  /**
   * Resolve the rail's ordered ids to the pictures behind them.
   *
   * Only the runtime holds those bytes: the input state carries ids, and the
   * `File` lives in the conversation service's draft registry.
   */
  railImages: (ids: readonly DraftAttachmentId[]) => readonly ComposerAttachment[]
  /** Drop one rail picture's preview URL, after its id leaves the input state. */
  releaseRailImage: (id: DraftAttachmentId) => void
}

const styles = {
  // The composer's own chrome buttons are 28px squares with a 14px glyph
  // (`InputBar.module.css` `.add`), and this sits directly beside them.
  button: {
    width: '28px',
    height: '28px',
    padding: 0,
    justifyContent: 'center',
    borderRadius: '8px',
  },
} satisfies Record<string, CSSProperties>

/**
 * One file's bytes as base64, without the data-URL prefix.
 *
 * `FileReader` rather than `arrayBuffer()` + `btoa`: the latter needs manual
 * chunking to avoid blowing the argument limit on a large file, and the browser
 * already has an encoder that does not.
 * @param file - the picked file.
 * @returns the base64 payload, or `undefined` when the file could not be read.
 */
async function base64Of(file: File): Promise<string | undefined> {
  const encoded = await new Promise<string | undefined>((resolve) => {
    const reader = new FileReader()
    reader.onerror = () => { resolve(undefined) }
    reader.onload = () => { resolve(typeof reader.result === 'string' ? reader.result : undefined) }
    reader.readAsDataURL(file)
  })
  if (encoded === undefined) return undefined
  const comma = encoded.indexOf(',')
  return comma === -1 ? undefined : encoded.slice(comma + 1)
}

/** Byte count as user-facing megabytes, matching the kernel's image copy. */
function sizeText(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return `${Number.isInteger(mb) ? String(mb) : mb.toFixed(1)}MB`
}

/**
 * Append one path to a draft.
 *
 * A path is its own line: the user's question and a file reference are two
 * different thoughts, and a path that wraps into prose stops looking like a
 * path.
 * @param draft - the current draft.
 * @param path - the staged file's absolute path.
 * @returns the next draft.
 */
function withPath(draft: string, path: string): string {
  const reference = `\`${path}\``
  if (draft === '') return reference
  return draft.endsWith('\n') ? `${draft}${reference}` : `${draft}\n${reference}`
}

/**
 * Render the file button.
 * @param props - the composer zone, the session input kit, and this plugin's host caller.
 * @returns the button, with its hidden file input.
 */
export function AttachFileButton(
  props: PropsRuntime<'conversation.input.left'>
    & PropsLocale<'openlux.files'>
    & InjectFace<AttachFileInjected>,
): ReactNode {
  const { input, inputActions, callHost, notify, selection, watchSelection, railImages, releaseRailImage, t } = props
  const picker = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // The drop listener outlives the render that installed it, so the draft it
  // appends to is read through a ref rather than captured.
  const draftAt = useRef(input.draft)
  draftAt.current = input.draft
  // Same, for the rail: the selection watcher fires from outside React.
  const railAt = useRef<readonly DraftAttachmentId[]>(input.imageIds)
  railAt.current = input.imageIds
  // Which models can be handed a picture, kept warm because the drop decision
  // is synchronous. `undefined` means "not answered yet", which routes to the
  // kernel rather than guessing.
  const vision = useRef<VisionModels | undefined>(undefined)

  const stage = async (files: readonly File[]): Promise<readonly File[]> => {
    try {
      return await attach(files)
    } finally {
      // Anything thrown in there would otherwise leave the button reading
      // "attaching…" for the rest of the session, with no way back.
      setBusy(false)
    }
  }

  /**
   * Stage each file and append its path to the draft.
   * @param files - what the user handed over, by any of the three doors.
   * @returns the ones that reached the harness home; a refusal keeps its file out.
   */
  const attach = async (files: readonly File[]): Promise<readonly File[]> => {
    setBusy(true)
    setProblem(null)
    // Both places, every time: the label is for the user who is at the button,
    // the notice strip for the one who just dropped something across the window.
    const refuse = (text: string): void => {
      setProblem(text)
      notify('error', text)
    }
    // The draft is a point-in-time snapshot off the owner share, so the running
    // value is threaded through this loop rather than re-read per file.
    let draft = draftAt.current
    const staged: File[] = []
    for (const file of files) {
      if (file.size > MAX_STAGED_BYTES) {
        refuse(t('tooLarge', { size: sizeText(MAX_STAGED_BYTES) }))
        continue
      }
      const base64 = await base64Of(file)
      if (base64 === undefined) {
        refuse(t('unreadable'))
        continue
      }
      const result = await callHost<StageOutcome>(FILE_STAGE_ENDPOINT, { name: file.name, base64 })
      if (!result.ok) {
        refuse(t('failed', { reason: result.error.message }))
        continue
      }
      if (result.value.kind === 'too-large') {
        refuse(t('tooLarge', { size: sizeText(result.value.limitBytes) }))
        continue
      }
      if (result.value.kind === 'unreadable') {
        refuse(t('unreadable'))
        continue
      }
      draft = withPath(draft, result.value.path)
      inputActions.setDraft(draft)
      staged.push(file)
    }
    return staged
  }

  // Same reason as `draftAt`: registered once, so the listener must reach the
  // current closure rather than the first one.
  const stageNow = useRef(stage)
  stageNow.current = stage

  /**
   * Whether the kernel's image route is a working route right now.
   *
   * Every unknown answers yes: an unloaded selection, a provider that is not
   * ours, a capability list that has not arrived. Being wrong that way costs
   * the kernel's own refusal, which the user can act on; being wrong the other
   * way silently turns a picture into a path on a model that could have looked
   * at it directly.
   */
  const kernelTakesImages = (): boolean => {
    const chosen = selection()
    const known = vision.current
    if (chosen === undefined || known === undefined) return true
    if (chosen.provider !== known.route) return true
    return known.models.includes(chosen.model)
  }

  /**
   * Move whatever is in the rail onto the path route, when the rail has stopped
   * being a route.
   *
   * The intake rules above route a picture by the model selected *then*. The
   * user is free to switch after, and the kernel keeps the rail across that
   * switch — so the same picture that was correctly admitted a moment ago is now
   * headed for a send-time refusal. This runs on both halves of that state (the
   * rail and the selection) and re-routes rather than waiting for Enter.
   *
   * Silent for the same reason a re-routed drop is: the path appearing in the
   * draft is the feedback, and the pictures visibly leave the rail as it does.
   * Failures still speak, through `attach`'s own refusals.
   */
  const rerouteRail = async (): Promise<void> => {
    const ids = railAt.current
    if (ids.length === 0 || kernelTakesImages()) return
    const images = railImages(ids)
    if (images.length === 0) return
    const staged = new Set(await stageNow.current(images.map(image => image.file)))
    for (const image of images) {
      if (!staged.has(image.file)) continue
      // Order matters: the id leaves the input state first, so nothing renders a
      // preview whose object URL has already been revoked.
      inputActions.removeImage(image.id)
      releaseRailImage(image.id)
    }
  }
  const rerouteNow = useRef(rerouteRail)
  rerouteNow.current = rerouteRail

  const warm = async (): Promise<void> => {
    // Reading the selection is also what loads it: in a session whose picker
    // was never opened, the kernel's directory holds `null` until somebody
    // asks (`client/selection.ts`). Discarding the value is the point.
    selection()
    const result = await callHost<VisionModels>(FILE_VISION_ENDPOINT, {})
    if (result.ok) vision.current = result.value
    // The answer that just arrived can turn a rail that looked fine into one
    // that is not: before it, an unknown capability routes to the kernel.
    await rerouteNow.current()
  }
  const warmNow = useRef(warm)
  warmNow.current = warm

  useEffect(() => {
    // Once at mount, and again whenever a drag enters the window: the capability
    // list changes when a sync round applies the console's capability layer, and
    // a drag is both the only moment the answer matters and a moment that
    // reliably precedes the drop.
    void warmNow.current()
    const onDragEnter = (): void => { void warmNow.current() }
    // Focus covers the other intake: a paste gives no warning at all, and
    // Ctrl+V's keydown lands a few milliseconds ahead of it — not enough for a
    // round trip — whereas clicking into the composer precedes it by seconds.
    const onFocusIn = (event: FocusEvent): void => {
      if (event.target instanceof HTMLTextAreaElement) void warmNow.current()
    }
    document.addEventListener('dragenter', onDragEnter, { capture: true })
    document.addEventListener('focusin', onFocusIn, { capture: true })
    return () => {
      document.removeEventListener('dragenter', onDragEnter, { capture: true })
      document.removeEventListener('focusin', onFocusIn, { capture: true })
    }
  }, [])

  useEffect(() => {
    // Switching models is the gesture this watches for; the picker writes the
    // same store the routing reads, so the two halves stay one decision.
    const stop = watchSelection(() => { void rerouteNow.current() })
    return () => { stop() }
  }, [])

  // The other half: a picture entering the rail while the model already cannot
  // take one. That happens when the capability list was still unknown at intake,
  // which is exactly when the drop is deliberately left to the kernel. Keyed on
  // the ids themselves, since the array identity changes with unrelated edits.
  useEffect(() => {
    void rerouteNow.current()
  }, [input.imageIds.join(',')])

  useEffect(() => {
    const onDrop = (event: DragEvent): void => {
      const files = [...event.dataTransfer?.files ?? []]
      if (files.length === 0) return
      // An image-only drop is the kernel's business — while its route works.
      // When the session's model cannot be handed a picture, that route ends in
      // a send-time refusal and the picture is lost, so it comes here instead
      // and the model reads it through `image_ask`.
      // Silent on purpose (decided 2026-08-23): the path landing in the draft is
      // itself the feedback, and a notice explaining the routing turned into a
      // line of chrome the user had to read on every picture. Failures still
      // speak — those go through `refuse`.
      if (files.every(file => KERNEL_IMAGE_TYPES.has(file.type)) && kernelTakesImages()) return
      // A mixed drop comes here whole. Splitting it is not possible — the
      // kernel's handler takes `dataTransfer.files` or nothing — and taking all
      // of it loses less than dropping the strangers on the floor: an image with
      // a path is still openable (`read_image`), whereas the pptx the kernel
      // refuses is simply gone.
      event.preventDefault()
      // Capture phase, so this runs before the kernel's own document listener
      // (`ui-attachment/ComposerAttachments.tsx:70`, bubble phase) can hand the
      // files to `onAddImages` and answer "PNG/JPG/WebP/GIF only".
      event.stopPropagation()
      // Its `onDrop` is also where its drag overlay is dismissed (`reset()` on
      // the line above `onAddImages`), so stopping the event there leaves
      // "drop images here" pinned to the screen for the rest of the session —
      // `dragend` never fires in the page for a drag that came from the OS.
      // `dragend` is the kernel's own other reset entry (same effect, on
      // `window`), so telling it the drag ended is the documented way to say
      // "this one is over" without touching its state.
      window.dispatchEvent(new DragEvent('dragend'))
      void stageNow.current(files)
    }
    document.addEventListener('drop', onDrop, { capture: true })
    return () => { document.removeEventListener('drop', onDrop, { capture: true }) }
  }, [])

  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const clipboard = event.clipboardData
      if (clipboard === null) return
      const files = [...clipboard.items]
        .filter(item => item.kind === 'file')
        .map(item => item.getAsFile())
        .filter((file): file is File => file !== null)
      if (files.length === 0) return
      // Text alongside the picture is left to the kernel whole: its paste path
      // is a transaction over the draft (`pasteBegin`, undo, reference chips),
      // and claiming half of that would break the text half to fix the picture.
      // A pasted screenshot — the case this exists for — carries no text.
      if (clipboard.getData('text/plain') !== '') return
      if (kernelTakesImages()) return
      // Same route as a drop, for the same reason, and the kernel's own intake
      // is on the textarea's React `onPaste` (`client.js:3542`), so capture at
      // the document beats it.
      event.preventDefault()
      event.stopPropagation()
      void stageNow.current(files)
    }
    document.addEventListener('paste', onPaste, { capture: true })
    return () => { document.removeEventListener('paste', onPaste, { capture: true }) }
  }, [])

  const label = busy ? t('attaching') : problem ?? t('attach')
  return (
    <>
      <input
        ref={picker}
        type="file"
        multiple
        // Named so a CDP probe can hand it real files; the button itself cannot
        // be driven that way, since a native picker has no DOM.
        data-testid={`${ATTACH_FILE_ID}-input`}
        // The kernel's image route keeps its own drop target; this one is for
        // everything else, so it filters nothing.
        style={{ display: 'none' }}
        onChange={(event) => {
          const files = [...event.target.files ?? []]
          // Clearing lets the same file be picked twice in a row (the input
          // fires no change event for an unchanged value).
          event.target.value = ''
          if (files.length > 0) void stage(files)
        }}
      />
      <Tooltip label={label} side="top" delayMs={500}>
        <Button
          variant="ghost"
          style={styles.button}
          data-testid={ATTACH_FILE_ID}
          aria-label={label}
          disabled={busy}
          icon={<IconPaperclipOutline16 size={14} />}
          // Keeps the textarea's caret where it was, the way the composer's own
          // chrome buttons do (`InputBar.tsx` keepFocus).
          onMouseDown={(event) => { event.preventDefault() }}
          onClick={() => { picker.current?.click() }}
        />
      </Tooltip>
    </>
  )
}
