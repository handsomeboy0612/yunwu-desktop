/**
 * Letting a model that cannot see hand one picture to a model that can.
 *
 * ## Why this exists at all
 *
 * The kernel's answer to "this model does not take images" is a refusal, in
 * three places (`host/apiproxy`'s admission check, `llm-pi-ai`'s serializer,
 * `tool-fs`'s `read_image`). That is correct for the request being made and
 * useless to the user, who is left holding a picture and a dead end.
 *
 * This product already answered the same question twice for other media: a chat
 * model cannot draw and cannot film either, and neither tool refuses — they pick
 * a model that can, out of what the console delivered and what this key may call
 * (`media/image/registry.ts`, `media/video/registry.ts`). Reading is the third
 * case of that one shape, and the rule it follows is the operator's: *the
 * delivered models, or whatever the token can reach — never a name compiled into
 * this build.*
 *
 * ## Why the answer comes back as text
 *
 * The picture must not enter the conversation's content, and that is a hard
 * constraint rather than a preference: `contentHasImage` descends into
 * tool-result content (`llm/llm/src/content.ts`), and a session that holds an
 * image anywhere may only continue on an image-capable model
 * (`host/apiproxy/src/api-proxy.ts`). Returning the picture would therefore
 * convert the caller's own session into one it can no longer run in — the exact
 * trap `media/tool.ts` documents for generated images. Text costs nothing and
 * closes nothing.
 *
 * ## Where "who can see" comes from
 *
 * The settings document, not another network call. `models/sync.ts` has already
 * merged the three layers into `providers.<route>.models[].input` — the
 * installed pi-ai catalog, then the console's capability overrides, then
 * whatever the user wrote. Reading that back is what makes this tool's pick and
 * the kernel's own gate the same judgement: a model chosen here is by
 * construction one the request layer will accept a picture for.
 *
 * @module openlux-plugin-account/media/vision
 */

import type { Context } from '@deepseek-ai/cordis'
import { AccountRequestError, normalizeBase, requestJson } from '../account/http.ts'
import type { ConsoleAccess } from '../market/console.ts'
import { listedModels } from '../models/listed.ts'

/**
 * Budget for one look.
 *
 * A vision answer is chat-speed, but a reasoning model spends its thinking
 * inside the same call and the picture is uploaded inline, so this is well
 * above the 15-second account default and below the tool's own ceiling.
 */
const LOOK_TIMEOUT_MS = 150_000

/**
 * Room for the answer.
 *
 * DeepSeek's own vision guide warns that a thinking model can spend the whole
 * allowance on reasoning and return an empty message — which this plugin has
 * already measured on the probe side (`max_tokens: 64` produced nothing at all).
 * Generous is cheap here: unused tokens are not billed.
 */
const ANSWER_MAX_TOKENS = 2048

/** Raised when the look could not happen or produced nothing; text is model-facing. */
export class VisionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VisionError'
  }
}

/**
 * The models this installation believes can read a picture, best first.
 *
 * Order is the settings list's own, which is the delivered order: `sync.ts`
 * merges the console's list ahead of anything the user added, so the first
 * capable entry is the one operations put first among those that can see.
 * @param ctx - host context.
 * @returns model ids, possibly empty.
 */
export function imageCapableModels(ctx: Context): readonly string[] {
  return listedModels(ctx)
    .filter(entry => entry.input?.includes('image') === true)
    .map(entry => entry.id)
}

/** What one look asks for. */
export interface LookRequest {
  /** The image's bytes. */
  readonly data: Uint8Array
  /** Its media type, sniffed from those bytes rather than from the file name. */
  readonly mediaType: string
  /** What the caller wants known about the picture. */
  readonly question: string
  /** Which model to ask; one of {@link imageCapableModels}. */
  readonly model: string
}

/** What one look produced. */
export interface LookOutcome {
  /** The answer, as the model wrote it. */
  readonly answer: string
  /** Which model answered — the caller did not choose it, so it is told. */
  readonly model: string
}

/**
 * Ask one image-capable model about one picture.
 *
 * The request carries exactly one `user` message. That is the shape every
 * upstream on this route reads correctly, and it is deliberately not the shape
 * the harness sends for a normal turn: a second adjacent `user` message makes at
 * least one reseller channel drop the picture silently and answer anyway
 * (measured 2026-08-23 — 118 prompt tokens against 685 for the same picture in
 * one message). Nothing here has to work around that, because nothing here
 * appends a second message.
 * @param ctx - host context.
 * @param access - route origin and token reader.
 * @param request - the picture, the question, and the model to ask.
 * @param signal - caller cancellation.
 * @returns the answer and the model that gave it.
 * @throws {VisionError} when the route refused, or answered with nothing.
 */
export async function lookAtImage(
  ctx: Context,
  access: ConsoleAccess,
  request: LookRequest,
  signal?: AbortSignal,
): Promise<LookOutcome> {
  const token = await access.apiKey()
  if (token === undefined || token === '') {
    throw new VisionError('当前没有可用的 OpenLux 密钥，请先在侧栏登录账号。')
  }
  const base = `${normalizeBase(access.baseUrl)}/v1`
  const url = `data:${request.mediaType};base64,${Buffer.from(request.data).toString('base64')}`

  let reply
  try {
    reply = await requestJson(ctx, `${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        max_tokens: ANSWER_MAX_TOKENS,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url } },
            { type: 'text', text: request.question },
          ],
        }],
      }),
    }, LOOK_TIMEOUT_MS, signal)
  } catch (error: unknown) {
    throw new VisionError(error instanceof AccountRequestError
      ? error.message
      : `看图请求失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const body = (reply.body ?? {}) as Record<string, unknown>
  if (!reply.response.ok) {
    const detail = messageOf(body['error']) ?? textOf(body['message']) ?? ''
    throw new VisionError(detail === ''
      ? `${request.model} 读图接口返回 HTTP ${String(reply.response.status)}。`
      : `${request.model} 拒绝了这次读图（HTTP ${String(reply.response.status)}）：${detail}`)
  }

  const choice = (body['choices'] as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined
  const answer = flatten((choice?.['message'] as Record<string, unknown> | undefined)?.['content'])
  if (answer === '') {
    // Not a parse failure: a thinking model that spent its allowance on
    // reasoning returns exactly this, and so does a channel that dropped the
    // picture and had nothing to say. Either way the caller must not treat
    // silence as a description.
    throw new VisionError(`${request.model} 这次没有给出任何文字，图可能没被它读到。`)
  }
  return { answer, model: request.model }
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
 *
 * Both shapes are legal on this route — a plain string is what these models
 * return today, and the block array is what the OpenAI wire allows — so both are
 * accepted rather than assumed.
 * @param content - `message.content`, in whatever shape it arrived.
 * @returns the answer text, trimmed; empty when there is none.
 */
function flatten(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map(block => typeof block === 'object' && block !== null ? textOf((block as Record<string, unknown>)['text']) ?? '' : '')
    .join('')
    .trim()
}
