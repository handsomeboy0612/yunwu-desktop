/**
 * The projection both image tools publish, and the one card that reads it.
 *
 * `image_generate` and `image_show` differ in where the bytes come from and in
 * nothing else a reader of the conversation can tell apart, so they publish the
 * same view shape and the browser registers one component under both names.
 * Keeping that shape here is what makes it literally the same shape: the card
 * reads the view structurally (`resultView.content`, looking for image blocks),
 * so a divergence would not fail a build — it would silently render one of the
 * two tools as a JSON dump of an attachment reference.
 *
 * @module openlux-plugin-account/media/card
 */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/**
 * One image, as a tool's canonical value and the log's metadata both carry it.
 *
 * Every field except `path` is a field the store verifies on read, which is why
 * they are all required: a reference missing its dimensions is not a partial
 * reference, it is one that cannot be checked (`media/read.ts`).
 */
export interface ToolImage {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  /** The prompt the upstream says it actually used, when it rewrote ours. */
  readonly revisedPrompt?: string
  /**
   * Absolute path of this image's file copy, when one was written.
   *
   * Optional because the copy is best-effort: the picture is already committed
   * and shown by the time it is attempted, so a machine that refuses the write
   * loses the path, not the image (`media/artifact.ts`).
   */
  readonly path?: string
}

/**
 * The per-image half of a tool's output schema.
 *
 * Both tools declare `additionalProperties: false`, so this list is the
 * canonical value's whole vocabulary and each tool spells it out by spreading
 * this one — a field added to {@link ToolImage} without a row here would be
 * rejected by the registry's own validation at call time.
 */
export const TOOL_IMAGE_PROPERTIES = {
  attachmentId: { type: 'string', required: true },
  mediaType: { type: 'string', required: true },
  bytes: { type: 'integer', required: true },
  width: { type: 'integer', required: true },
  height: { type: 'integer', required: true },
  revisedPrompt: { type: 'string' },
  path: { type: 'string' },
} as const

/**
 * Rebuild a durable reference from the log's own copy of it.
 *
 * The metadata is plain JSON by the time it comes back, so the branded id is
 * re-asserted here rather than carried; the reference is only ever handed to a
 * reader that verifies the bytes it names.
 * @param image - one metadata entry.
 * @returns the attachment reference.
 */
export function toRef(image: ToolImage): ImageAttachmentRef {
  return {
    attachmentId: image.attachmentId,
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
  } as ImageAttachmentRef
}

/**
 * Read the images out of one settled call's published metadata.
 *
 * The metadata is the only projection the session log keeps, so this is the one
 * source a view has on both the live and the replay path. An absent or
 * unexpected shape yields nothing rather than throwing: a nested call under a
 * composite transport has no projection at all, and its row falls back to the
 * text the model got.
 * @param meta - `presentationMeta` as the result carries it.
 * @returns the images, in the order they were produced.
 */
export function imagesOf(meta: unknown): readonly ToolImage[] {
  const images = (meta as { images?: unknown } | undefined)?.images
  return Array.isArray(images) ? images as readonly ToolImage[] : []
}

/** One image block per image, as the card's gallery reads them. */
export function imageBlocks(images: readonly ToolImage[]): { type: 'image'; attachment: ImageAttachmentRef }[] {
  return images.map(image => ({ type: 'image' as const, attachment: toRef(image) }))
}

/**
 * The line describing one image, shared by both tools' model-facing text.
 * @param image - one saved image.
 * @param index - its position in this call.
 * @returns one line, without a trailing newline.
 */
export function describeImage(image: ToolImage, index: number): string {
  return `${String(index + 1)}. ${String(image.width)}×${String(image.height)} ${image.mediaType}`
    + `，附件 ${image.attachmentId}`
    + `${image.path === undefined ? '' : `，文件 ${image.path}`}`
    + `${image.revisedPrompt === undefined ? '' : `（模型改写的提示词：${image.revisedPrompt}）`}`
}
