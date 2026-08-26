/**
 * Finding the picture a user means by "this one".
 *
 * Image-to-video needs bytes, and the bytes the user has in mind are already in
 * the conversation — either a photo they attached or something `image_generate`
 * just drew. Both live in the session log, but in two different places, and
 * neither of them is the model's to quote:
 *
 * - **An attached photo** is an `ImageBlock` in a `user/message` event, carrying
 *   the durable `ImageAttachmentRef`. A vision model sees the picture; nothing
 *   shows it the reference, so it cannot pass one as an argument. This branch is
 *   ahead of the product: an attachment is refused unless the session's model
 *   declares image input (`dsh-host-apiproxy` checks `inputModalities`), and the
 *   shipped profile carries two text-only models, so nothing on this machine has
 *   produced such an event yet. It is written now because the shape is the
 *   kernel's, and the alternative is silently ignoring the user's photo on the
 *   day a vision model arrives.
 * - **A drawn image** is deliberately kept out of model-visible content (see
 *   `media/tool.ts`: an image block would make the session require a vision
 *   model). Its references survive only in that call's `presentationMeta`, which
 *   rides the `tool/result` event's `meta`.
 *
 * So the tool resolves the reference itself, from the log, and this module is
 * that walk. Two facts shape it:
 *
 * - A `tool/result` message names its call but **not its tool**
 *   (`ToolResultMessage.source` is `{kind:'tool', callId}`), so the tool name has
 *   to come from the matching `tool/call` event. Matching by call id rather than
 *   sniffing the metadata's shape keeps this from claiming another plugin's
 *   lookalike payload.
 * - The log is append-only and frozen, so a forward pass keeping the last match
 *   is both correct and the cheapest way to say "the newest one".
 *
 * @module openlux-plugin-account/media/session-images
 */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { IMAGE_TOOL_NAME } from './name.ts'

/** One image the conversation already contains. */
export interface SessionImage {
  /** The durable reference; the attachment service owns the bytes. */
  readonly ref: ImageAttachmentRef
  /** Where it came from, for the sentence the model reads back. */
  readonly source: 'attached' | 'generated'
  /** Log position, so a caller can say which one it took. */
  readonly seq: number
}

/**
 * The only session surface this walk needs.
 *
 * Events are deliberately `unknown`: two workspace consumers can resolve
 * separate copies of `dsh-session`, whose evolving event unions are not
 * assignable even though both runtime Session objects expose the same JSON log.
 * The walk narrows each relevant event below instead of importing either copy.
 */
export interface SessionEventSource {
  readonly events: readonly unknown[]
}

/** The metadata shape `media/tool.ts` writes for each generated image. */
interface GeneratedImageMeta {
  readonly attachmentId?: unknown
  readonly mediaType?: unknown
  readonly bytes?: unknown
  readonly width?: unknown
  readonly height?: unknown
}

/**
 * The newest image in this session, whether attached or generated.
 *
 * @param session - the agent's live session; its log is the source of truth.
 * @returns the newest image, or undefined when the conversation has none.
 */
export function findLatestImage(session: SessionEventSource): SessionImage | undefined {
  const toolNames = new Map<string, string>()
  let latest: SessionImage | undefined

  for (const rawEvent of session.events) {
    const event = record(rawEvent)
    const data = record(event?.['data'])
    const type = event?.['type']
    const seq = event?.['seq']
    if (event === undefined || data === undefined || typeof seq !== 'number') continue
    if (type === 'tool/call') {
      const name = data['name']
      if (typeof name === 'string') toolNames.set(String(data['callId']), name)
      continue
    }
    if (type === 'user/message') {
      const content = data['content']
      if (!Array.isArray(content)) continue
      for (const rawBlock of content) {
        const block = record(rawBlock)
        if (block?.['type'] !== 'image') continue
        const ref = asRef(record(block['attachment']) ?? {})
        if (ref !== undefined) latest = { ref, source: 'attached', seq }
      }
      continue
    }
    if (type !== 'tool/result') continue
    const message = record(data['message'])
    const source = record(message?.['source'])
    if (toolNames.get(String(source?.['callId'])) !== IMAGE_TOOL_NAME) continue
    // The error branch has no images to offer, and its meta may be absent.
    if (data['error'] !== undefined) continue
    const images = record(data['meta'])?.['images']
    if (!Array.isArray(images)) continue
    for (const image of images) {
      const ref = asRef(record(image) ?? {})
      if (ref !== undefined) latest = { ref, source: 'generated', seq }
    }
  }
  return latest
}

/**
 * Rebuild a reference from the log's plain-JSON copy of it.
 *
 * Every field is checked because a half-formed reference would fail later, at
 * the attachment reader, as a confusing digest mismatch rather than as "the log
 * does not have what I need". The branded id is re-asserted the same way
 * `media/tool.ts` does when it feeds its own card: the reader verifies the bytes
 * against every field anyway.
 * @param image - one metadata entry.
 * @returns the reference, or undefined when the entry is not one.
 */
function asRef(image: GeneratedImageMeta): ImageAttachmentRef | undefined {
  const { attachmentId, mediaType, bytes, width, height } = image
  if (typeof attachmentId !== 'string' || attachmentId === '') return undefined
  if (typeof mediaType !== 'string' || mediaType === '') return undefined
  if (typeof bytes !== 'number' || typeof width !== 'number' || typeof height !== 'number') return undefined
  return { attachmentId, mediaType, bytes, width, height } as ImageAttachmentRef
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}
