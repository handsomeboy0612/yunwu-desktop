/**
 * The model-facing "have somebody read this document" tool.
 *
 * Without it, a chat model handed a PDF path does what was measured here on
 * 2026-08-23: 13 tool calls, three minutes and 162k tokens spent hunting for a
 * parser that is not installed, a scratch script left in the user's working
 * directory, and no answer. The path is not the problem — the document is simply
 * not something a shell can turn into text on a machine with no PDF tooling.
 *
 * Why a path rather than a conversation attachment: the kernel has no document
 * intake at all. Its attachment store admits four image types, and `read`
 * handles UTF-8 text only, with PDF explicitly deferred. A path is therefore the
 * only form a document ever has here, which is also why the composer's file
 * button hands paths over (`client/AttachFileButton.tsx`).
 *
 * Everything about choosing the model, the wire shape, and which formats travel
 * lives in {@link ./documents.ts}.
 *
 * @module openlux-plugin-account/media/doc-tool
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ConsoleAccess } from '../market/console.ts'
import {
  askAboutDocument,
  contentMismatch,
  DOCUMENT_EXTENSIONS,
  DocumentError,
  mediaTypeFor,
} from './documents.ts'
import { DOCUMENT_ASK_TOOL_NAME } from './name.ts'

export { DOCUMENT_ASK_TOOL_NAME } from './name.ts'

/**
 * Ceiling for one document, in bytes.
 *
 * Not a round number picked for looks. The strictest upstream on this route
 * enforces a 32MB *total request*, base64 inflates the body by a third on the
 * way, and the conversation still has to fit beside the file — which is the same
 * arithmetic Claude Code writes down for its own PDF cap. 20MB of raw document
 * leaves that room, and refusing here with the real size beats a gateway's 413.
 */
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024

/** Above `documents.ts`'s own per-attempt budget, so that deadline reports first. */
const TOOL_TIMEOUT_MS = 200_000

/** What to ask when the caller does not say. */
const DEFAULT_QUESTION = '通读这份文档，说明它是什么、讲了什么，并列出其中的关键信息（数字、日期、结论、条款）。'

const description = 'Read a local document (PDF, Word, Excel, PowerPoint) by handing it to a model that accepts files, '
  + 'and get a text answer back. Use this whenever the user gives you a document path — do not try to parse it with a '
  + 'shell, python, pypdf, pdftotext or any other local tool, and do not ask the user to paste the contents. '
  + 'Ask a specific question when you have one (what is the total on page 3, what does clause 7 say, which quarter fell); '
  + 'the default is a summary with the key facts. Call it again for follow-up questions rather than guessing. '
  + 'The document is not added to this conversation and you still cannot open it: what you receive is the other model\'s '
  + 'words. Answer from them, and say plainly when they do not cover something — but never claim to have read the '
  + 'document yourself, and keep this machinery out of your reply: no file path, no mention of this tool or of which '
  + 'model read it. For plain text, source code, CSV or Markdown use the ordinary file read tool instead; '
  + 'for images use the image tool.'

/** What the tool reads out of its own composition. */
export interface DocumentAskOptions {
  /** Route origin and token reader, shared with the account face. */
  readonly access: ConsoleAccess
}

/** What one call returns to the model. */
interface ToolValue {
  readonly answer: string
  readonly model: string
}

/**
 * Register the document tool, when this composition has a tool runtime.
 * @param ctx - host context; the registration follows this fiber's lifetime.
 * @param options - route access.
 */
export function registerDocumentAskTool(ctx: Context, options: DocumentAskOptions): void {
  const tools = ctx.get('tools')
  if (tools === undefined) {
    ctx.logger.debug('openlux: no tool runtime in this composition; the document ask tool stays unregistered')
    return
  }

  ctx.effect(() => tools.register(defineTool({
    name: DOCUMENT_ASK_TOOL_NAME,
    description,
    timeoutMs: TOOL_TIMEOUT_MS,
    // One read of one file plus one request; nothing a sibling call observes.
    isConcurrencySafe: () => true,
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute path of the document. A relative path is resolved against this session\'s working '
          + `directory. Accepted formats: ${DOCUMENT_EXTENSIONS.join(', ')}.`,
      },
      question: {
        type: 'string',
        description: 'What you want to know about the document. Defaults to a summary with the key facts.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: { type: 'string', required: true },
          model: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const { answer, model } = value as ToolValue
        return [{ type: 'text', text: `${model} 读过这份文档后说：\n\n${answer}` }]
      },
    },
    async execute(args, exec) {
      const given = args.path.trim()
      if (given === '') throw new DocumentError('没有给出文档路径。')
      const cwd = exec.agent?.session.header.cwd
      if (!isAbsolute(given) && cwd === undefined) {
        throw new DocumentError(`${given}：这是相对路径，而这次调用不属于任何工作目录，请给绝对路径。`)
      }
      const path = isAbsolute(given) ? given : resolve(cwd ?? '', given)

      // Format first: it is free to check, and it is the one refusal that tells
      // the caller to use a different tool rather than to give up.
      const mediaType = mediaTypeFor(path)
      if (mediaType === undefined) {
        throw new DocumentError(`${path} 不是这条路支持的文档格式（只认 ${DOCUMENT_EXTENSIONS.join(' / ')}）。`
          + '纯文本、代码、CSV、Markdown 直接用普通的读文件工具，图片用读图工具。')
      }

      const info = await stat(path).catch((error: unknown) => {
        throw new DocumentError(`打不开 ${path}：${error instanceof Error ? error.message : String(error)}`)
      })
      if (!info.isFile()) throw new DocumentError(`${path} 不是一个文件。`)
      if (info.size === 0) throw new DocumentError(`${path} 是空文件。`)
      if (info.size > MAX_DOCUMENT_BYTES) {
        throw new DocumentError(`${path} 有 ${megabytes(info.size)}，超过一次读文档的上限 ${megabytes(MAX_DOCUMENT_BYTES)}。`
          + '请让用户拆分文件，或者指明只需要看哪一部分。')
      }

      const data = await readFile(path)
      const mismatch = contentMismatch(data, mediaType)
      if (mismatch !== undefined) throw new DocumentError(`${path}：${mismatch}`)

      const asked = args.question?.trim()
      const outcome = await askAboutDocument(ctx, options.access, {
        data,
        mediaType,
        filename: basename(path),
        question: asked === undefined || asked === '' ? DEFAULT_QUESTION : asked,
      }, exec.signal)
      return { answer: outcome.answer, model: outcome.model }
    },
  })))
}

/** Byte count as user-facing megabytes, matching the composer's copy. */
function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return `${Number.isInteger(mb) ? String(mb) : mb.toFixed(1)}MB`
}
