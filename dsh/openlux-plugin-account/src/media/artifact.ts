/**
 * The file copy a generated image also lands as.
 *
 * ## Why a picture needs a path when it already has a card
 *
 * The card only reaches whoever is reading *that* conversation. A delegated
 * member draws inside its own session, and the kernel is explicit about what
 * crosses back: `dsh-tool-subagent` returns "only the child's final text" and
 * "intermediate child steps stay out of the parent", while the alternative
 * return channel — `dsh-tool-subagent-report` — takes one `output` string. So a
 * team member's picture was paid for, committed, and invisible: its attachment
 * reference existed only in a transcript nobody was looking at.
 *
 * A path is a token that survives that boundary, because text is the one thing
 * that does. The member reports where the file is, and the lead hands that path
 * to `image_show` (`media/show-tool.ts`), which puts the picture in front of the
 * user in the conversation the user is actually reading. The file is also worth
 * having on its own: until now a generated image had no user-facing location at
 * all, only a content-addressed blob inside the attachment store.
 *
 * ## Why this name is content-addressed, where the video tool's is argument-pure
 *
 * `media/video-tool.ts` must derive its path from the call's arguments alone,
 * because the produced-file row reads the *call* view and replay recomputes it
 * (`dsh-client-ui-deliverables`: "only root call views enter this Turn
 * accumulator"). That constraint costs it something real — two calls with the
 * same arguments share one slot, and the second overwrites the first.
 *
 * Nothing here pays that price, because these paths travel as text in the
 * result rather than being recomputed from arguments. So the name carries the
 * image's own digest instead: asking for the same prompt twice produces two
 * files, and an older result's path keeps pointing at the picture it described
 * rather than at a newer picture that happens to share a prompt. Two calls that
 * genuinely produced identical bytes land on one file, which is the one case
 * where sharing a slot is a fact rather than a collision.
 *
 * The consequence to know: these files are never cleaned up, exactly like the
 * attachment objects they mirror (`dsh-attachment` defers retention and
 * collection because forked sessions share immutable objects).
 *
 * @module openlux-plugin-account/media/artifact
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** How much of the prompt the file name carries, in characters. */
const STEM_MAX = 24

/** How much of the content digest the file name carries, in hex characters. */
const DIGEST_CHARS = 12

/**
 * Where one generated image's file copy goes.
 * @param prompt - the request's prompt; a readable slice becomes the stem.
 * @param attachmentId - the durable id, whose digest makes the name unique.
 * @param mediaType - the sniffed type, which decides the extension.
 * @returns an absolute path under the harness home.
 */
export function imageArtifactPath(prompt: string, attachmentId: string, mediaType: string): string {
  return join(dshHomePath('media', 'image'), `${stem(prompt)}-${digestOf(attachmentId)}.${extensionOf(mediaType)}`)
}

/**
 * Write one image's file copy.
 * @param path - destination, from {@link imageArtifactPath}.
 * @param data - the encoded image, exactly as the store committed it.
 */
export async function writeImageArtifact(path: string, data: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data)
}

/**
 * A readable leading part of the file name.
 *
 * Only has to help a human recognise the file in a folder listing, hence the
 * length cap and the conservative character set — a path is what this becomes.
 * Letters keep their own script, so a Chinese prompt yields a Chinese name.
 * @param prompt - the request's prompt.
 * @returns a file-name-safe stem, never empty.
 */
function stem(prompt: string): string {
  const cleaned = prompt.replace(/\s+/gu, '-').replace(/[^\p{L}\p{N}-]/gu, '').slice(0, STEM_MAX)
  return cleaned === '' ? 'image' : cleaned
}

/**
 * The identifying part of the file name, taken from the image's own content.
 *
 * The durable id is `sha256:<hex>` (`dsh-attachment`'s `ID_PATTERN`), so the
 * algorithm prefix is dropped and the digest itself is what distinguishes two
 * files. An id shaped otherwise is not worth failing a write over — the picture
 * is already saved — so whatever it carries is sanitised into a name instead.
 * @param attachmentId - the durable reference's id.
 * @returns a short file-name-safe token.
 */
function digestOf(attachmentId: string): string {
  const hex = attachmentId.replace(/^[^:]*:/u, '').replace(/[^\dA-Fa-f]/gu, '')
  return hex === '' ? 'unnamed' : hex.slice(0, DIGEST_CHARS)
}

/**
 * The extension for one media type.
 *
 * The four are the whole vocabulary the attachment store admits, and the type
 * was sniffed from the bytes rather than claimed by a header, so the name this
 * produces cannot disagree with the file's content.
 * @param mediaType - the sniffed type.
 * @returns the extension, without a dot.
 */
function extensionOf(mediaType: string): string {
  return mediaType === 'image/jpeg' ? 'jpg' : mediaType.replace(/^image\//u, '')
}
