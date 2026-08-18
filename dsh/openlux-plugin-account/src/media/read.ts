/**
 * Serving one generated image's bytes to the card that shows it.
 *
 * The kernel ties readability to model visibility: its own attachment read
 * authorizes an id by finding it in a session event's model-visible content, and
 * our images are kept out of that content on purpose (`tool.ts`). So this plugin
 * serves them itself, over the channel it already owns.
 *
 * What makes that safe is the reference, not this module. An `ImageAttachmentRef`
 * is a content-addressed capability: the store locates the object by the digest
 * inside the id and then verifies the digest, media type, byte length, and both
 * dimensions against the reference before returning anything
 * (`attachment-local`'s `readImageFile`). A caller who does not already know an
 * object's digest cannot name it, and a caller who knows it can only read that
 * one object. The complete reference exists in exactly one place — the session
 * log of the conversation the card is rendering — and the channel is
 * loopback-only.
 *
 * Bytes cross as base64 for the same reason the kernel's own read does: the RPC
 * envelope is JSON, and a `Uint8Array` through it arrives as an object with
 * numeric keys.
 *
 * @module openlux-plugin-account/media/read
 */

import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** Media types the durable store admits, and therefore the only ones askable. */
const MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** One image's bytes, as the card receives them. */
export interface ImageBytes {
  readonly data: string
  readonly mediaType: ImageMediaType
}

/**
 * Read a reference out of one request payload.
 *
 * Every field is required, because every field is verified downstream: a
 * reference missing its dimensions is not a partial reference, it is one that
 * cannot be checked.
 * @param payload - request body.
 * @returns the reference, or undefined when the payload is not one.
 */
export function imageRefOf(payload: unknown): ImageAttachmentRef | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { attachmentId, mediaType, bytes, width, height } = payload as Record<string, unknown>
  if (typeof attachmentId !== 'string' || attachmentId === '') return undefined
  if (typeof mediaType !== 'string' || !MEDIA_TYPES.includes(mediaType)) return undefined
  if (!Number.isInteger(bytes) || !Number.isInteger(width) || !Number.isInteger(height)) return undefined
  // The id is branded, and the brand is a compile-time fact about a string the
  // store is about to verify by content — re-asserting it here is the same move
  // the tool's own metadata round-trip makes.
  return { attachmentId, mediaType, bytes, width, height } as unknown as ImageAttachmentRef
}

/**
 * Read one durable image.
 * @param attachments - the durable store, read opportunistically by the caller
 * the same way the tool registration reads it (`ctx.attachments` is not a bare
 * property read: cordis refuses one outside an inject scope, and this channel's
 * handler runs outside every scope).
 * @param ref - the reference the card holds.
 * @param signal - caller cancellation.
 * @returns the verified bytes, base64-encoded.
 * @throws whatever the store throws when verification or the read fails.
 */
export async function readImageBytes(
  attachments: AttachmentStore,
  ref: ImageAttachmentRef,
  signal?: AbortSignal,
): Promise<ImageBytes> {
  const stored = await attachments.readImage(ref, signal)
  return {
    data: Buffer.from(stored.data).toString('base64'),
    mediaType: stored.ref.mediaType,
  }
}
