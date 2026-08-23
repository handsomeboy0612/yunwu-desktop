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
 * Wire name of the tool that shows a picture already on disk, and its slot key.
 *
 * A second name rather than a mode of the first one: a tool that generates is
 * the wrong place for a call that must be free, instant, and repeatable. It
 * shares the card, because what a reader sees is the same thing either way
 * (`media/card.ts`), and it exists because a delegated member's picture can
 * only cross back to the user as a path (`media/artifact.ts`).
 */
export const IMAGE_SHOW_TOOL_NAME = 'image_show'

/**
 * Wire name of the tool that has a picture read by a model that can see.
 *
 * Deliberately not a mode of {@link IMAGE_SHOW_TOOL_NAME}: showing sends a
 * picture *to the user* and costs nothing, while this sends it to another model
 * and bills for the look. It also has no card — what comes back is a paragraph
 * of text, which the transcript already renders.
 */
export const IMAGE_ASK_TOOL_NAME = 'image_ask'

/**
 * Wire name of the tool that has a document read by a model that accepts files.
 *
 * A separate name from {@link IMAGE_ASK_TOOL_NAME} rather than a format of it,
 * because nothing about the two calls is shared past the sentence describing
 * them: a different wire part (`file`, not `image_url`), a different set of
 * models that accept it, and a different failure to explain when none do. It has
 * no card either — the result is text.
 */
export const DOCUMENT_ASK_TOOL_NAME = 'document_ask'

/**
 * Wire name of the video tool.
 *
 * It has no card of its own on purpose: a finished video reaches the user as a
 * produced file the system player opens, which the shipped deliverables row
 * already draws for any call that declares `kind:'edit'` with a location. So
 * this name is the tool's identity and the job label's prefix, not a slot key.
 */
export const VIDEO_TOOL_NAME = 'video_generate'

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
