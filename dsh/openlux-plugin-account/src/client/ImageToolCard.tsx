/**
 * The image tool's own row in a turn.
 *
 * The kernel dispatches tool rows through a keyed slot (`tool.call.toolview`,
 * keyed by the wire tool name), and an unclaimed key falls back to the generic
 * row — which flattens every non-text content block to pretty JSON
 * (`ui-tool/src/client/tool/models/tool-call-model.ts`). So a generated picture
 * needs this registration to be a picture rather than a JSON dump: the row is
 * ours, and everything it renders comes from what the turn already carries.
 *
 * The thumbnails, their loading and retry states, and the original-image
 * lightbox are the kernel's own attachment atoms, shared into the browser's
 * frozen module table as a platform module (`client/web/src/platform.ts`). That
 * is deliberate: a picture the model drew and a picture the user pasted then
 * behave identically, down to the tooltip and the Escape key, and neither this
 * package nor a future kernel upgrade has to keep two implementations agreeing.
 * Those atoms read no application state, so every string arrives as a prop from
 * our own dictionary.
 */

import { useMemo } from 'react'
import type { CSSProperties } from 'react'
import { IconSparkle16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { ImageGallery, type ImageLoader, type MessageImageLabels } from '@deepseek-ai/dsh-client-ui-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallBlock, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { MediaKey } from './media-locales.ts'

/** What the registration hands this row beyond the slot's own payload. */
export interface ImageCardInjected {
  /**
   * Session-authorized loader for one durable image.
   *
   * Bound per session at registration rather than per render: the atoms reload
   * whenever this function's identity changes, so a fresh closure on every
   * render would refetch the same bytes forever.
   */
  readonly load: ImageLoader
  /**
   * Which of the two tools this registration draws.
   *
   * The row is the same row — the same gallery over the same projection — so the
   * two differ only in their titles and in where a summary comes from. Passed in
   * rather than read off the block, because the slot key already decided it.
   */
  readonly kind: 'generate' | 'show'
}

/** Full props of the image row. */
export type ImageToolCardProps = ToolCallViewProps & PropsLocale<'openlux.media'> & ImageCardInjected

/**
 * The four titles each thing this row can be uses, keyed by which it is.
 *
 * A table rather than a ternary per state: the row has three vocabularies over
 * four states, and spelling that out inline reads as a puzzle at the one place
 * a reader goes to answer "why does the card say that".
 */
const COPY = {
  show: { idle: 'show.title', pending: 'show.pending', done: 'show.result', failed: 'show.failed' },
  draw: { idle: 'call.title', pending: 'call.pending', done: 'result.title', failed: 'result.failed' },
  edit: { idle: 'edit.title', pending: 'edit.pending', done: 'edit.result', failed: 'edit.failed' },
} as const satisfies Record<string, Record<'idle' | 'pending' | 'done' | 'failed', MediaKey>>

const styles = {
  card: { display: 'flex', flexDirection: 'column', gap: '6px' },
  head: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
  icon: { display: 'flex', flex: '0 0 16px', color: 'var(--dsw-alias-label-tertiary)' },
  title: { flex: '0 0 auto', color: 'var(--dsw-alias-label-primary)', fontSize: '13px' },
  separator: {
    flex: '0 0 auto', width: '1px', height: '10px',
    background: 'var(--dsw-alias-border-l1)',
  },
  summary: {
    flex: 1, minWidth: 0,
    color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  errorSummary: {
    flex: 1, minWidth: 0,
    color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  detail: {
    color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
  },
} satisfies Record<string, CSSProperties>

/**
 * Render one image-generation call.
 * @param props - the slot payload, the bound loader, and this card's copy.
 * @returns the row.
 */
export function ImageToolCard({ block, load, kind, t }: ImageToolCardProps) {
  const settled = settledOf(block)
  const { summary: prompt, editing } = argsOf(block)
  const images = useMemo(() => imagesOf(settled), [settled])
  const labels = useMemo<MessageImageLabels>(() => ({
    image: t('image.label'),
    open: t('image.open'),
    openNamed: label => t('image.openNamed', { label }),
    loading: t('image.loading'),
    loadFailed: t('image.loadFailed'),
    lightbox: { dialog: t('image.preview'), close: t('image.closePreview') },
  }), [t])

  const failed = settled?.isError === true
  const resultText = settled === undefined ? '' : flatten(settled)
  // A settled call with neither images nor a failure is a nested one: the
  // presentation projection is computed for top-level calls only, so the row
  // shows the text the model got instead of an empty card.
  const bare = settled !== undefined && !failed && images.length === 0
  // Which of the three vocabularies this row speaks. Changing a picture is not
  // drawing one, and a row that says it drew when it was asked to change is the
  // same comfortable lie the tool refuses to tell the model. Mid-stream the
  // arguments are still arriving, so an edit reads as a drawing until the flag
  // lands — the same window in which the summary is still empty.
  const copy = COPY[kind === 'show' ? 'show' : editing ? 'edit' : 'draw']
  const idle = t(copy.idle)
  const title = settled === undefined
    ? idle
    : failed
      ? t(copy.failed)
      : bare ? idle : t(copy.done, { count: images.length })
  const summary = settled === undefined
    ? (prompt === '' ? t(copy.pending) : prompt)
    : failed ? firstLine(resultText) : prompt

  return (
    <div style={styles.card} data-openlux="image-card" data-state={settled === undefined ? 'running' : failed ? 'error' : 'ok'}>
      <div style={styles.head}>
        <span style={styles.icon}><IconSparkle16 size={14} /></span>
        <span style={styles.title}>{title}</span>
        <span style={styles.separator} aria-hidden />
        <span style={failed ? styles.errorSummary : styles.summary} title={failed ? resultText : prompt}>
          {summary}
        </span>
      </div>
      {images.length > 0 && (
        <ImageGallery images={images} load={load} align="start" labels={labels} />
      )}
      {bare && resultText !== '' && <div style={styles.detail}>{resultText}</div>}
    </div>
  )
}

/** The settled half of one call, or undefined while it is still running. */
function settledOf(block: ToolCallBlock): ToolResultNode | undefined {
  return 'kind' in block ? block : undefined
}

/**
 * Read the images the completed call's view carries.
 *
 * The view is the host's own projection of this result (`presentResult`), so
 * this reads what that projection published rather than re-deriving anything:
 * an absent or unexpected view simply yields no images.
 * @param settled - the settled node, when there is one.
 * @returns the durable references, in the order they were generated.
 */
function imagesOf(settled: ToolResultNode | undefined): readonly { attachment: ImageAttachmentRef }[] {
  const view = settled?.resultView
  if (view === undefined || view === null || view.card !== 'generic') return []
  const content: readonly unknown[] = view.content ?? []
  const images: { attachment: ImageAttachmentRef }[] = []
  for (const block of content) {
    const candidate = block as { type?: unknown; attachment?: unknown }
    if (candidate.type !== 'image' || candidate.attachment === undefined) continue
    images.push({ attachment: candidate.attachment as ImageAttachmentRef })
  }
  return images
}

/**
 * What this call is about, in one line — the prompt it draws, or the files it
 * shows — and whether it changes an existing picture rather than drawing one.
 *
 * Both are read from the same place because both tools put their subject in
 * their arguments, and the row does not need to know which tool it is to find
 * it. The edit flag rides along on the same parse rather than a second one: the
 * row's whole vocabulary turns on it, and two parses of one JSON string is two
 * places for the answer to differ.
 * @param block - the running or settled call.
 * @returns the summary (empty when the arguments are unreadable) and whether
 *   this call edits.
 */
function argsOf(block: ToolCallBlock): { summary: string; editing: boolean } {
  const raw = 'kind' in block ? block.call?.argsRaw : block.argsRaw
  if (raw === undefined || raw === null || raw === '') return { summary: '', editing: false }
  try {
    const args = JSON.parse(raw) as { prompt?: unknown; paths?: unknown; edit_last_image?: unknown }
    const editing = args.edit_last_image === true
    if (typeof args.prompt === 'string') return { summary: args.prompt, editing }
    if (Array.isArray(args.paths)) {
      return { summary: args.paths.filter(path => typeof path === 'string').join(' · '), editing }
    }
    return { summary: '', editing }
  } catch {
    // A truncated argument stream is normal mid-call; the row simply has no
    // summary to show yet.
    return { summary: '', editing: false }
  }
}

/** The result's text blocks, as one string. */
function flatten(settled: ToolResultNode): string {
  const parts: string[] = []
  for (const block of settled.content) {
    if (block.type === 'text') parts.push(block.text)
  }
  if (parts.length === 0 && settled.error !== undefined) parts.push(`${settled.error.name}: ${settled.error.code}`)
  return parts.join('\n')
}

/** The first non-empty line, for a collapsed failure summary. */
function firstLine(text: string): string {
  return text.split('\n').find(line => line.trim() !== '') ?? ''
}
