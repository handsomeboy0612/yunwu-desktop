/**
 * Where a file the user attached lands, so that a path can stand for it.
 *
 * ## Why the bytes travel, when the file is already on this machine
 *
 * The obvious route is to send the path instead of the content: the renderer
 * holds a `File`, and Electron can turn one into an absolute path with
 * `webUtils.getPathForFile`. That call needs a preload script, and the DSH
 * windows are created without one (`dsh-plugin-desktop/src/window-options.ts`
 * — `sandbox: true`, no `preload`). That package is upstream
 * (anywhere-labs/deepseek-harness-desktop), so reaching the path would mean
 * forking it. Moving the bytes through the channel this plugin already owns
 * costs one request and forks nothing — and it keeps working in a browser
 * deployment, where no path exists to hand over at all.
 *
 * ## Why a path is worth producing
 *
 * It is the whole point: a path is what the model can act on. `fs-sandbox`
 * fences *mutations* only (its `read-only` mode is defined as "denies every
 * mutation"), so `read_file`, `grep`, and the shell tools can all open a file
 * anywhere on disk. This is the same shape WorkBuddy uses — the file stays a
 * file, and the model reads it with the tools it already has, rather than us
 * parsing documents in-process.
 *
 * ## Why here and not in the workspace
 *
 * The user's workspace is their project. Dropping strangers' pptx files into it
 * would show up in their diffs. The harness home already holds the media this
 * plugin produces, so an attached file lands beside them. Like those, nothing
 * cleans this directory up.
 *
 * @module openlux-plugin-account/files/stage
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { MAX_STAGED_BYTES } from './name.ts'

/** How much of the original file name the staged name keeps, in characters. */
const STEM_MAX = 40

/** How much of the content digest the staged name carries, in hex characters. */
const DIGEST_CHARS = 12

/**
 * What one stage attempt produced.
 *
 * A file that is too large or unreadable is an outcome the user can act on, not
 * a fault, so it rides the success arm with its own discriminant — the same
 * convention every other endpoint on this channel follows.
 */
export type StageOutcome =
  | { kind: 'staged'; path: string }
  | { kind: 'too-large'; limitBytes: number }
  | { kind: 'unreadable' }

/**
 * Write one attached file into the harness home and report its path.
 * @param payload - the request body: `name` (the browser-reported file name)
 * and `base64` (its bytes).
 * @returns the staged path, or the refusal the button explains.
 */
export async function stageFile(payload: unknown): Promise<StageOutcome> {
  const request = payload as { name?: unknown; base64?: unknown } | null
  const name = typeof request?.name === 'string' ? request.name : ''
  const encoded = typeof request?.base64 === 'string' ? request.base64 : ''
  if (encoded === '') return { kind: 'unreadable' }
  // Base64 carries 3 bytes per 4 characters, so the encoded length bounds the
  // decoded size. Checking it first means an oversized file never becomes a
  // Buffer.
  if (encoded.length / 4 * 3 > MAX_STAGED_BYTES) return { kind: 'too-large', limitBytes: MAX_STAGED_BYTES }
  const data = Buffer.from(encoded, 'base64')
  if (data.byteLength === 0) return { kind: 'unreadable' }
  if (data.byteLength > MAX_STAGED_BYTES) return { kind: 'too-large', limitBytes: MAX_STAGED_BYTES }

  const path = join(dshHomePath('media', 'incoming'), stagedName(name, data))
  await mkdir(dshHomePath('media', 'incoming'), { recursive: true })
  await writeFile(path, data)
  return { kind: 'staged', path }
}

/**
 * The staged file's name: recognisable, unique, and safe to put in a path.
 *
 * The digest comes from the content, so attaching the same file twice lands on
 * one file instead of accumulating copies, while two different files that
 * happen to share a name stay apart. Letters keep their own script — a Chinese
 * file name stays Chinese, because the user is the one who has to recognise it.
 * @param name - the browser-reported file name.
 * @param data - the decoded bytes.
 * @returns a file name, extension included.
 */
function stagedName(name: string, data: Uint8Array): string {
  const digest = createHash('sha256').update(data).digest('hex').slice(0, DIGEST_CHARS)
  // The extension decides what the model's tools will make of the file, so it
  // is taken from the name the browser reported rather than sniffed. An
  // extension-less attachment stays extension-less.
  const extension = extname(name).replace(/[^.\d A-Za-z]/gu, '').slice(0, 12)
  const stem = name
    .slice(0, name.length - extname(name).length)
    .replace(/\s+/gu, '-')
    .replace(/[^\p{L}\p{N}\-_]/gu, '')
    .slice(0, STEM_MAX)
  return `${stem === '' ? 'file' : stem}-${digest}${extension}`
}
