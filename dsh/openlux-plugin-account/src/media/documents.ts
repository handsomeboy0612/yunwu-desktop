/**
 * Letting a model that cannot open a document hand one to a model that can.
 *
 * ## What the references do, and which one this follows
 *
 * The kernel does not do this at all, on purpose: `read` handles UTF-8 text
 * only, images go through `read_image`, and "PDF, audio, and video remain
 * deferred" (`dsh-tool-fs/README.md`, Known Limitations). So the gap is ours to
 * close, and two shipped products close it in different ways.
 *
 * WorkBuddy installs Anthropic's `pdf` skill: prose telling the model to solve
 * it locally with `pypdf` / `pdfplumber` / `pdftotext`. That assumes a Python
 * toolchain on the user's machine, which a desktop chat user does not have — and
 * the failure mode was measured here rather than guessed: a PDF dropped on a
 * text-only model with no such tools burned 3 minutes, 13 steps and 162k tokens
 * and still never read the file.
 *
 * Claude Code does it in code (`claude-code-cli/utils/pdf.ts`): send the whole
 * document to the model when the route accepts documents, and only fall back to
 * rasterising pages with poppler when it does not. That is the shape this module
 * takes — minus the rasteriser, which needs a binary we cannot assume on
 * Windows, and which the second tier replaces: another *model* that does accept
 * documents is both cheaper and lossless compared with pictures of pages.
 *
 * ## The wire shape is the vendor's, not ours
 *
 * A document travels as OpenAI's `file` content part carrying `filename` and a
 * `file_data` data URI — the documented form for Chat Completions, where
 * `detail` is deliberately absent (it exists only on Responses). What the far
 * side then does is also documented and worth knowing, because it explains the
 * ranking below: a PDF is parsed into *both* extracted text and page images and
 * so needs a vision-capable model, while `.docx` / `.pptx` / `.txt` yield text
 * only and need nothing of the sort.
 *
 * ## Which model gets asked
 *
 * The operator's rule, in two tiers. First the delivered list, in delivered
 * order, because that is the quality the console signed off on. Only if every
 * delivered candidate refuses does this fall through to models the token can
 * actually call, capped at a few attempts — the same two-tier rule the drawing
 * and filming tools already follow.
 *
 * Nothing in the catalogue says "reads documents": the route's rows carry
 * endpoint types, a model type and tags, and no file-input flag. So the fact is
 * discovered by asking, and remembered per process so the same refusal is not
 * paid for twice in one session.
 *
 * @module openlux-plugin-account/media/documents
 */

import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import {
  AccountRequestError,
  isTokenCredentialFailure,
  normalizeBase,
  requestJson,
} from '../account/http.ts'
import type { ConsoleAccess } from '../market/console.ts'
import { listedModels } from '../models/listed.ts'
import { fetchChatPool } from '../models/pool.ts'
import { registerModelCacheInvalidator } from '../models/runtime-cache.ts'
import { diagnosticUsageText } from './usage.ts'

/**
 * Budget for one document question.
 *
 * Longer than a look at a picture: the far side extracts text, renders page
 * images for a PDF, and only then starts generating.
 */
const READ_TIMEOUT_MS = 55_000
const TOTAL_TIMEOUT_MS = 175_000
const MAX_ATTEMPTS = 3
const MAX_TOTAL_UPLOAD_BYTES = 60 * 1024 * 1024

/** Room for the answer; unused tokens are not billed, an empty reply costs a retry. */
const ANSWER_MAX_TOKENS = 4096

/**
 * How many models beyond the delivered list one call may try.
 *
 * Every attempt is a full upload of the document, so this is a cost ceiling, not
 * a thoroughness dial: three failures already mean the route is wrong for this
 * file rather than that the fourth name is the lucky one.
 */
const NEGATIVE_TTL_MS = 10 * 60_000

/** Raised when no model could read the document; text is model-facing. */
export class DocumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocumentError'
  }
}

/**
 * The document formats this route will carry, keyed by extension.
 *
 * Taken from the vendor's published table rather than invented, and trimmed to
 * what a desktop user actually attaches. Plain text and source code are absent
 * on purpose: the kernel's own `read` already returns those, for free and
 * without a second model in the loop.
 */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  rtf: 'application/rtf',
  odt: 'application/vnd.oasis.opendocument.text',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odp: 'application/vnd.oasis.opendocument.presentation',
}

/** The extensions {@link mediaTypeFor} accepts, for refusal text and tool docs. */
export const DOCUMENT_EXTENSIONS: readonly string[] = Object.keys(MEDIA_TYPES)

/**
 * The media type for a file name, when this route carries that format.
 * @param path - file path or name; only the extension is read.
 * @returns the media type, or undefined when the format is not carried.
 */
export function mediaTypeFor(path: string): string | undefined {
  const dot = path.lastIndexOf('.')
  if (dot <= 0) return undefined
  return MEDIA_TYPES[path.slice(dot + 1).toLowerCase()]
}

/**
 * Whether the bytes match what the extension claimed.
 *
 * This is not defensive tidiness. A document block the far side cannot parse
 * poisons the conversation rather than failing once — Claude Code documents an
 * invalid PDF making *every* later request in the session fail 400 until the
 * history is cleared, and the kernel's own attachment store takes the same line
 * for images: magic bytes decide, a wrong extension is refused with the rename
 * remedy rather than sniffed around.
 * @param data - the file's leading bytes.
 * @param mediaType - what {@link mediaTypeFor} derived from the name.
 * @returns undefined when they agree, else a model-facing reason.
 */
export function contentMismatch(data: Uint8Array, mediaType: string): string | undefined {
  const head = Buffer.from(data.subarray(0, 8))
  if (mediaType === 'application/pdf') {
    return head.subarray(0, 5).toString('ascii') === '%PDF-'
      ? undefined
      : '这个文件的扩展名是 .pdf，但内容不是 PDF（开头没有 %PDF- 标记）。请让用户确认文件，或改成正确的扩展名。'
  }
  if (mediaType === 'application/rtf') {
    return head.subarray(0, 5).toString('ascii') === '{\\rtf'
      ? undefined
      : '这个文件的扩展名是 .rtf，但内容不是 RTF。请让用户确认文件。'
  }
  // The Office and OpenDocument formats are zip containers; their legacy
  // siblings are OLE2 compound files. Both signatures are worth checking
  // because renaming .doc to .docx is a common way to "convert" a file.
  const zip = head[0] === 0x50 && head[1] === 0x4B
  const ole2 = head.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1'
  if (mediaType.includes('openxmlformats') || mediaType.includes('opendocument')) {
    return zip ? undefined : '这个文件的扩展名是新版 Office / OpenDocument 格式，但内容不是（不是 zip 容器）。'
      + '如果它其实是旧版 .doc / .xls / .ppt，请按真实格式改名后再试。'
  }
  if (mediaType === 'application/msword' || mediaType === 'application/vnd.ms-excel'
    || mediaType === 'application/vnd.ms-powerpoint') {
    return ole2 ? undefined : '这个文件的扩展名是旧版 Office 格式，但内容不是。'
      + '如果它其实是 .docx / .xlsx / .pptx，请按真实格式改名后再试。'
  }
  return undefined
}

/** What one document question asks for. */
export interface DocumentRequest {
  /** The document's bytes. */
  readonly data: Uint8Array
  /** Its media type, derived from the extension and checked against the bytes. */
  readonly mediaType: string
  /** The name the far side is told; vendors use it as a parsing hint. */
  readonly filename: string
  /** What the caller wants known about the document. */
  readonly question: string
}

/** What one document question produced. */
export interface DocumentOutcome {
  /** The answer, as the model wrote it. */
  readonly answer: string
  /** Which model answered — the caller did not choose it, so it is told. */
  readonly model: string
}

/**
 * Models known to have refused a given media type, for this process only.
 *
 * Per model *and* type, because the two refusals seen so far are different
 * facts: one route rejects file parts outright, another accepts PDF and rejects
 * a `.docx` mime. Remembering the pair keeps a working combination usable after
 * a broken one, and forgetting it all on restart is intended — a relay fix
 * should not need a client release to take effect.
 */
const refused = new Map<string, number>()
registerModelCacheInvalidator(() => refused.clear())

/** Whether this pair already failed in this process. */
function alreadyRefused(scope: string, model: string, mediaType: string): boolean {
  const key = `${scope}|${model}|${mediaType}`
  const until = refused.get(key)
  if (until === undefined) return false
  if (until > Date.now()) return true
  refused.delete(key)
  return false
}

/** Remember that this pair failed. */
function remember(scope: string, model: string, mediaType: string): void {
  refused.set(`${scope}|${model}|${mediaType}`, Date.now() + NEGATIVE_TTL_MS)
  while (refused.size > 128) {
    const oldest = refused.keys().next().value as string | undefined
    if (oldest === undefined) break
    refused.delete(oldest)
  }
}

/**
 * The models to try for one document, best first.
 *
 * Tier one is the delivered list in delivered order, with one reordering:
 * models that declare image input go first. The documentation supports that for
 * PDFs specifically — a PDF is parsed into text *and page images*, so vision is
 * needed — and this route's own behaviour extends it to every format. Measured
 * on 2026-08-23 against the five models delivered to this machine: both
 * vision-capable rows that reached their vendor read the file, and both
 * text-only rows failed, one honestly (`Invalid value: file`) and one by
 * answering "I cannot see any document" with the part dropped.
 *
 * The text-only rows stay on the list rather than being filtered out. Their
 * declared modality is about images, not attachments, and a route that starts
 * accepting files should not need a client release to be tried again.
 * @param ctx - host context.
 * @param mediaType - the document's media type.
 * @returns delivered candidates, already filtered of known refusals.
 */
function deliveredCandidates(ctx: Context, scope: string, mediaType: string): readonly string[] {
  const listed = listedModels(ctx).filter(entry => !alreadyRefused(scope, entry.id, mediaType))
  const sees = listed.filter(entry => entry.input?.includes('image') === true)
  const rest = listed.filter(entry => entry.input?.includes('image') !== true)
  return [...sees, ...rest].map(entry => entry.id)
}

/**
 * Patterns of a model saying the document never reached it.
 *
 * This is the one failure that cannot be read off the transport: the request
 * succeeds, the model writes a fluent paragraph, and the paragraph is about not
 * having the file. Measured on `deepseek-v4-pro`, which answered "I cannot see
 * any document. Please upload the document containing the verification code."
 * with HTTP 200 — a reply that would otherwise have been handed back as the
 * answer, and which is worse than a refusal because it looks like one.
 *
 * The patterns deliberately require the *document itself* to be what is missing.
 * "The document does not contain a verification code" is a real answer from a
 * model that did read it, and must not be caught here.
 */
const DENIALS: readonly RegExp[] = [
  /\b(?:cannot|can't|can not|unable to|couldn't|could not)\s+(?:see|open|read|access|view|find)\s+(?:any\s+|the\s+|this\s+)?(?:document|file|pdf|attachment|content)/i,
  /\b(?:no|didn't receive|did not receive|haven't received|have not received|don't have|do not have)\s+(?:any\s+)?(?:document|file|attachment)\s+(?:was\s+)?(?:provided|attached|received|uploaded|here)?/i,
  /\b(?:please|kindly)\s+(?:upload|provide|attach|share|paste)\s+(?:the\s+|a\s+)?(?:document|file|pdf|content|text)/i,
  // 名词前留出「你上传的任何」这类插入语，后面的排除项是要害：跟着「里/中/内/的」时
  // 说的是「文档里没有那个东西」——那是读到了以后的结论，误判会把正确答案扔掉。
  /(?:没有|未|无法|不能)(?:看到|收到|读取|打开|访问|获取|见到)[^。！？\n]{0,12}?(?:文档|文件|附件|图片|图像|内容)(?![里中内上的])/,
  /请(?:先)?(?:上传|提供|粘贴|附上)(?:一下)?(?:相关)?(?:文档|文件|内容|文字)/,
]

/**
 * Two halves of "I got something and it was unreadable", which must both appear.
 *
 * A second failure mode, and a nastier one than the denial above: some channels
 * on this route extract the document's text themselves instead of passing the
 * file on, and a PDF with subsetted fonts comes out as mojibake. Measured on
 * three Claude channels, which answered in 4 seconds with 2–6 reported input
 * tokens: "I cannot extract a verification code from this text. The PDF appears
 * to contain encoded or shifted text." That is not a denial — it names the file
 * — so it slips past {@link DENIALS} and would be handed to the user as the
 * answer, which is worse than the HTTP 500 this route used to return.
 *
 * Both halves are required because either alone is a real answer: "I cannot find
 * a verification code in this document" is a finding, and "the contract contains
 * encoded fields" is content. Only the pair means the transport failed.
 */
const UNREADABLE_VERBS: readonly RegExp[] = [
  /\b(?:cannot|can't|can not|unable to|couldn't|could not)\s+(?:reliably\s+|clearly\s+)?(?:extract|read|make out|decipher|parse|interpret)\b/i,
  /(?:无法|不能|没法)(?:可靠地)?(?:提取|读取|识别|解析|辨认)/,
]
const UNREADABLE_CAUSES: readonly RegExp[] = [
  /\b(?:encoded|corrupted|garbled|scrambled|shifted text|unreadable|gibberish|mojibake|binary data)\b/i,
  /(?:乱码|编码错误|错位|损坏|无法辨识)/,
]

/**
 * Whether an answer means the document did not usefully arrive.
 * @param answer - what the model wrote.
 * @returns true when it denies receiving the document, or received garbage.
 */
export function deniesReading(answer: string): boolean {
  if (DENIALS.some(pattern => pattern.test(answer))) return true
  return UNREADABLE_VERBS.some(pattern => pattern.test(answer))
    && UNREADABLE_CAUSES.some(pattern => pattern.test(answer))
}

/**
 * Ask about one document, trying candidates until one reads it.
 *
 * The request carries exactly one `user` message, for the reason `vision.ts`
 * documents: a second adjacent `user` message makes at least one channel on this
 * route drop the attached part and answer anyway.
 * @param ctx - host context.
 * @param access - route origin and token reader.
 * @param request - the document and the question.
 * @param signal - caller cancellation.
 * @returns the answer and the model that gave it.
 * @throws {DocumentError} when every candidate refused, or there were none.
 */
export async function askAboutDocument(
  ctx: Context,
  access: ConsoleAccess,
  request: DocumentRequest,
  signal?: AbortSignal,
): Promise<DocumentOutcome> {
  const token = await access.apiKey()
  if (token === undefined || token === '') {
    throw new DocumentError('当前没有可用的 OpenLux 密钥，请先在侧栏登录账号。')
  }

  const startedAt = Date.now()
  const scope = `${normalizeBase(access.baseUrl)}|${tokenDigest(token)}`
  const delivered = deliveredCandidates(ctx, scope, request.mediaType)
  const dynamic = await fetchChatPool(ctx, access.baseUrl, token, signal)
    .then(pool => pool?.map(model => model.id) ?? [])
  const candidates = [...new Set([...delivered, ...dynamic])]
    .filter(model => !alreadyRefused(scope, model, request.mediaType))
    .slice(0, MAX_ATTEMPTS)
  const failures: string[] = []
  let uploaded = 0
  for (const [index, model] of candidates.entries()) {
    if (Date.now() - startedAt >= TOTAL_TIMEOUT_MS) {
      failures.push('整次文档读取已到时间上限')
      break
    }
    if (uploaded + request.data.byteLength > MAX_TOTAL_UPLOAD_BYTES) {
      failures.push('整次文档读取已到上传字节上限')
      break
    }
    uploaded += request.data.byteLength
    const outcome = await attempt(ctx, access, token, scope, request, model, signal)
    if (typeof outcome !== 'string') {
      ctx.logger.info(`openlux: document_ask succeeded after ${String(index + 1)} attempt(s)`)
      return outcome
    }
    failures.push(`${model}：${outcome}`)
  }

  if (failures.length === 0) {
    throw new DocumentError('当前账号下没有可用的对话模型，读不了这份文档。请先在侧栏登录，或让管理端下发一个对话模型。')
  }
  throw new DocumentError(`试过的模型都没能读这份文档（最多 ${String(MAX_ATTEMPTS)} 次）：\n${failures.join('\n')}\n`
    + '这不是文件的问题，是这条线路上没有模型接收这种附件。'
    + '可以让管理端下发一个能读文档的模型，或者请用户把内容贴成文字。')
}

/**
 * One attempt against one model.
 * @param ctx - host context.
 * @param access - route origin.
 * @param token - the route key, already read once by the caller.
 * @param request - the document and the question.
 * @param model - which model to ask.
 * @param signal - caller cancellation.
 * @returns the outcome, or a one-line reason this model did not answer.
 */
async function attempt(
  ctx: Context,
  access: ConsoleAccess,
  token: string,
  scope: string,
  request: DocumentRequest,
  model: string,
  signal?: AbortSignal,
): Promise<DocumentOutcome | string> {
  const base = `${normalizeBase(access.baseUrl)}/v1`
  const fileData = `data:${request.mediaType};base64,${Buffer.from(request.data).toString('base64')}`
  let reply
  try {
    reply = await requestJson(ctx, `${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: ANSWER_MAX_TOKENS,
        messages: [{
          role: 'user',
          content: [
            { type: 'file', file: { filename: request.filename, file_data: fileData } },
            { type: 'text', text: request.question },
          ],
        }],
      }),
    }, READ_TIMEOUT_MS, signal)
  } catch (error: unknown) {
    if (error instanceof AccountRequestError && error.message.includes('取消')) throw error
    // A transport failure is not evidence about the model, so it is not
    // remembered — only the route's own refusals are.
    return error instanceof Error ? error.message : String(error)
  }

  const body = (reply.body ?? {}) as Record<string, unknown>
  if (!reply.response.ok) {
    const detail = messageOf(body['error']) ?? textOf(body['message']) ?? ''
    if (isTokenCredentialFailure(reply.response.status, detail)) {
      throw new DocumentError(`当前令牌无权读取文档（HTTP ${String(reply.response.status)}）：${detail || '请重新登录或切换令牌'}`)
    }
    if (isExplicitDocumentRefusal(reply.response.status, detail)) {
      remember(scope, model, request.mediaType)
    }
    return `HTTP ${String(reply.response.status)}${detail === '' ? '' : ` ${detail}`}`
  }
  const choice = (body['choices'] as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined
  const answer = flatten((choice?.['message'] as Record<string, unknown> | undefined)?.['content'])
  if (answer === '') {
    return '接受了请求但没有给出任何文字'
  }
  if (deniesReading(answer)) {
    // A 200 that says "no document here" means the part was dropped upstream,
    // not that this document is unreadable. Handing it back would answer the
    // user's question with the plumbing's excuse.
    remember(scope, model, request.mediaType)
    return `收下了请求但没拿到文件（原话：${answer.slice(0, 60)}）`
  }
  const usage = diagnosticUsageText(body['usage'])
  ctx.logger.info(`openlux: document_ask used ${model} (${String(request.data.byteLength)} bytes`
    + `${usage === '' ? '' : `, ${usage}`})`)
  return { answer, model }
}

/** `error.message` from an OpenAI-shaped failure body. */
function messageOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  return textOf((error as Record<string, unknown>)['message'])
}

/** A non-empty trimmed string, or undefined. */
function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Reduce a chat message's content to the text it carries.
 * @param content - `message.content`, in whatever shape it arrived.
 * @returns the answer text, trimmed; empty when there is none.
 */
function flatten(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map(block => typeof block === 'object' && block !== null
      ? textOf((block as Record<string, unknown>)['text']) ?? ''
      : '')
    .join('')
    .trim()
}

export function isExplicitDocumentRefusal(status: number, detail: string): boolean {
  if (status === 415 || status === 422) return true
  if (status < 400 || status >= 500 || status === 401 || status === 403 || status === 429) return false
  return /(?:file|document|attachment|pdf|mime).*(?:unsupported|invalid|not support|不支持|无效|不能接收)|不支持.*(?:文件|文档|附件)/i
    .test(detail)
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 24)
}
