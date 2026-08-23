/**
 * Vidu's reference-to-image route, which draws and edits on one path.
 *
 * ## Why this is here at all, having been excluded before
 *
 * The openclaw-era plugin listed `viduq2` among the models it deliberately did
 * *not* claim, on the grounds that `/ent/v2/reference2image` is not "draw from
 * one sentence". That reading was wrong, and the gateway's own request type says
 * so: `images` takes **0 to 7** for this model, and the field comment spells out
 * that viduq2 with no images draws from the prompt alone
 * (`new-yunwu-api/dto/vidu.go:118-123`). One route, both vocabularies.
 *
 * ## Verified live on 2026-08-21, both halves
 *
 * Unlike Kling — ported blind because its channel has no balance — this one was
 * watched all the way to the bytes:
 *
 * - **Draw**: no `images`, HTTP 200 with `state: created`, done in 38 seconds,
 *   6 credits.
 * - **Edit**: one reference, done in 53 seconds, 8 credits, and the downloaded
 *   object begins `89504e47` — a real PNG, not an error page.
 * - **`aspect_ratio`**: sent `9:16`, echoed back `9:16`.
 *
 * ## The reference is a data URI, prefix included
 *
 * The opposite of Kling and the same as MJ, which is exactly why it was measured
 * rather than assumed: the relay forwards `images` untouched (nothing in
 * `relay/channel/task/vidu/` looks at base64), so the format is upstream's rule.
 * A `data:image/jpeg;base64,…` was accepted and the submit echo came back with
 * it rewritten to `ssupload:?id=…`, which is the platform having uploaded it to
 * Vidu's own storage. That upload is also why the submit is slow — 12 seconds
 * for a 404 KB reference, against 2 for a bare prompt.
 *
 * ## What this route has no field for
 *
 * A count: one submit is one picture. The shape survives as a ratio, the exact
 * pixels do not. Both are reported afterwards rather than faked.
 *
 * @module openlux-plugin-account/media/image/vidu
 */

import { AccountRequestError, requestJson, type HttpReply } from '../../account/http.ts'
import {
  aspectOf,
  ImageGenerationError,
  object,
  pause,
  text,
  type ImageOutcome,
  type ImageProvider,
  type ImageRequest,
  type ImageWire,
} from './provider.ts'

/**
 * Budget for the submit.
 *
 * Generous because this one does real work: the reference travels inside the
 * JSON body and the platform re-uploads it before answering.
 */
const SUBMIT_TIMEOUT_MS = 120_000

/** Budget for one status read. */
const POLL_TIMEOUT_MS = 30_000

/**
 * How long the whole call may take, submit included.
 *
 * Counted end to end rather than per phase because the submit's cost is not
 * fixed: it carries the reference, and measured runs went from 2 seconds for a
 * bare prompt to 12 for a 404 KB reference to 68 for a 2.5 MB one. Two separate
 * budgets would therefore add up to more than the tool's own 250-second limit,
 * whose timeout says nothing useful — this one at least names the vendor and
 * says the task is still running upstream.
 */
const TOTAL_BUDGET_MS = 240_000

/** Gap between reads, matching the cadence used for the other async vendors. */
const POLL_INTERVAL_MS = 5000

/**
 * States that mean the task is still running.
 *
 * A closed set, so an unrecognised state ends the wait and reports rather than
 * polling until the budget runs out with nothing to show for it.
 */
const RUNNING = new Set(['created', 'queueing', 'processing'])

export const viduImageProvider: ImageProvider = {
  id: 'vidu-image',
  endpointTypes: ['Vidu image generation'],
  // Earned: this name produced a picture on this route on 2026-08-21, which is
  // what this list is for.
  fallbackModels: ['viduq2'],
  variesCount: false,
  variesSize: true,

  // The same submit either way — supplying `images` is the whole difference.
  edits: () => true,

  async generate(wire: ImageWire, request: ImageRequest): Promise<ImageOutcome> {
    // `auto` means "the shape of the input picture", which is the only right
    // answer for an edit nobody gave a size for: defaulting to a square turned a
    // 1080×1920 lighthouse into a square one on the first live run — a reshape
    // the user never asked for, in a call whose whole point is to leave
    // everything alone but the thing named. With no size and no reference there
    // is nothing to preserve, so the field is omitted and upstream's own default
    // stands rather than one invented here.
    const aspect = aspectOf(request.size)
      ?? (request.reference === undefined ? undefined : 'auto')
    const body: Record<string, unknown> = {
      model: request.model,
      prompt: request.prompt,
      ...aspect === undefined ? {} : { aspect_ratio: aspect },
    }
    if (request.reference !== undefined) {
      const reference = request.reference
      body['images'] = [`data:${reference.mediaType};base64,${Buffer.from(reference.data).toString('base64')}`]
    }
    const deadline = Date.now() + TOTAL_BUDGET_MS
    const taskId = await submit(wire, body)
    const urls = await settle(wire, taskId, deadline)
    const ignored: string[] = []
    if (request.size !== undefined) {
      ignored.push(`Vidu 这条接口只收比例不收像素，所以 ${request.size} 只按最接近的比例生效，具体像素没有。`)
    }
    if (request.count > 1) {
      ignored.push(`Vidu 这条接口一次只出一张，请求的 ${String(request.count)} 张实际是 1 张。`)
    }
    return { carriers: urls.map(url => ({ kind: 'url' as const, url })), ignored }
  },
}

/**
 * Create the task.
 * @param wire - route access.
 * @param body - the request body this route expects.
 * @returns the task id.
 * @throws {ImageGenerationError} when the route or Vidu refused.
 */
async function submit(wire: ImageWire, body: Record<string, unknown>): Promise<string> {
  let reply: HttpReply
  try {
    reply = await requestJson(wire.ctx, `${wire.root}/ent/v2/reference2image`, {
      method: 'POST',
      headers: wire.headers,
      body: JSON.stringify(body),
    }, SUBMIT_TIMEOUT_MS, wire.signal)
  } catch (error: unknown) {
    throw new ImageGenerationError(error instanceof AccountRequestError
      ? error.message
      : `Vidu 出图提交失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const answer = object(reply.body) ?? {}
  if (!reply.response.ok) {
    throw new ImageGenerationError(`Vidu 拒绝了这次提交（HTTP ${String(reply.response.status)}）：`
      + `${complaint(answer) ?? '上游没有给出原因'}`)
  }
  const taskId = text(answer['task_id']) ?? text(answer['id'])
  if (taskId === undefined) throw new ImageGenerationError('Vidu 提交回执里没有任务号。')
  wire.ctx.logger.debug(`openlux: Vidu task ${taskId} created (${String(answer['credits'] ?? '?')} credits)`)
  return taskId
}

/**
 * Wait for the task and answer with the finished pictures.
 * @param wire - route access.
 * @param taskId - what {@link submit} returned.
 * @param deadline - the epoch millisecond the whole call must be done by.
 * @returns one URL per produced image.
 * @throws {ImageGenerationError} when it failed, or outlived the budget.
 */
async function settle(wire: ImageWire, taskId: string, deadline: number): Promise<string[]> {
  let lastState = ''
  while (Date.now() < deadline) {
    await pause(POLL_INTERVAL_MS, wire.signal)
    let reply: HttpReply
    try {
      reply = await requestJson(wire.ctx, `${wire.root}/ent/v2/tasks/${encodeURIComponent(taskId)}/creations`, {
        method: 'GET',
        headers: { Authorization: wire.headers['Authorization'] ?? '' },
      }, POLL_TIMEOUT_MS, wire.signal)
    } catch (error: unknown) {
      // One unreadable status is not a failed task; the picture is being drawn
      // upstream either way.
      wire.ctx.logger.warn(`openlux: Vidu status read failed (${error instanceof Error ? error.message : String(error)}); retrying`)
      continue
    }
    const answer = object(reply.body)
    if (answer === undefined) {
      wire.ctx.logger.warn(`openlux: Vidu status read returned HTTP ${String(reply.response.status)} with no body; retrying`)
      continue
    }
    const state = text(answer['state'])?.toLowerCase() ?? ''
    if (state !== lastState) {
      wire.ctx.logger.debug(`openlux: Vidu task ${taskId} is ${state}`)
      lastState = state
    }
    if (RUNNING.has(state)) continue
    if (state !== 'success') {
      throw new ImageGenerationError(`Vidu 出图失败：${complaint(answer) ?? `上游只说了状态 ${state || '（空）'}`}`)
    }
    const urls = images(answer)
    if (urls.length === 0) throw new ImageGenerationError('Vidu 报告出图完成，但回执里没有图片地址。')
    return urls
  }
  throw new ImageGenerationError(`Vidu 出图超过 ${String(Math.round(TOTAL_BUDGET_MS / 1000))} 秒还没完成（正常 40~70 秒）。`
    + '任务在上游还在跑，隔一会儿再试一次。')
}

/** The finished pictures' URLs, in the order upstream returned them. */
function images(answer: Record<string, unknown>): string[] {
  const rows = answer['creations']
  if (!Array.isArray(rows)) return []
  return rows.map(row => text(object(row)?.['url'])).filter((url): url is string => url !== undefined)
}

/**
 * Vidu's own words for a failure.
 *
 * `err_msg` on a polled task, `message` on a refused submit. Both are empty
 * strings on success, which `text` already reads as absent.
 * @param answer - the response body.
 * @returns the complaint, or undefined when it said nothing.
 */
function complaint(answer: Record<string, unknown>): string | undefined {
  return text(answer['err_msg']) ?? text(answer['message']) ?? text(answer['error'])
}
