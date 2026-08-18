/**
 * The one name both halves have to agree on.
 *
 * The host registers the tool under it and the browser registers its card under
 * the same string, because `tool.call.toolview` dispatches on the wire tool
 * name and a key that misses simply never renders — silently, with the generic
 * row in its place. A shared constant is what keeps that agreement checkable;
 * it lives alone in this file so the browser bundle can import it without
 * pulling the host module (and its Node-only dependencies) across.
 *
 * @module openlux-plugin-account/media/name
 */

/** Wire name of the image tool, and therefore its card's slot key. */
export const IMAGE_TOOL_NAME = 'image_generate'

/**
 * Endpoint the card reads a generated image's bytes from.
 *
 * Not the kernel's own `session.readAttachment`, and that is a rule rather than
 * a preference: the host serves that read only for an attachment some event's
 * *model-visible* content references (`imageBlockIn` descends into tool-result
 * content and stops there, `host/apiproxy` around `referencedImage`). Our images
 * are deliberately not model-visible — see `tool.ts` — so that read answers
 * ATTACHMENT_NOT_REFERENCED for every one of them, and the card would show its
 * retry control forever.
 */
export const IMAGE_READ_ENDPOINT = 'media.image'
