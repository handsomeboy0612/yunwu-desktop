/**
 * Midjourney `imagine`, a submit-then-poll route hanging off the site root.
 *
 * Ported from this product's openclaw-era plugin
 * (`resources/yunwu-video-plugin/index.mjs`, `mjImagineAdapter`) rather than
 * rediscovered, because every judgement in it is sourced to the gateway's own
 * code and one of them cannot be found by reading a response:
 *
 * - **Completion is the status, never the presence of `imageUrl`.** While a task
 *   is still running the gateway *also* returns an `imageUrl`, with a
 *   `?rand=<nanos>` cache-buster on the end (`relay/relay-mj.go:151-155`);
 *   downloading it then yields a half-drawn frame or a 404. So `SUCCESS` /
 *   `FAILURE` decide, matching the platform's own Lab
 *   (`web/src/pages/Lab/capability/pollContracts.js`, `mjContract`), plus a
 *   non-empty `failReason` which the gateway itself treats as failure
 *   (`controller/midjourney.go:370`).
 * - **The submit's success code is 1, and only 1 is ever seen.** The gateway
 *   rewrites 21 (task exists) and 22 (queued) to 1 (`relay/relay-mj.go:1314-1337`),
 *   and `result` is the task id. Other codes are refusals worth passing through:
 *   23 is a full queue, 24 a prompt that tripped the word filter.
 * - **The poll reads the gateway's own database, not Discord.** A background job
 *   refreshes it from upstream every 15 seconds (`controller/midjourney.go:37-41`),
 *   so polling faster than that shortens the discovery lag and nothing else.
 *
 * ## What this route has no field for
 *
 * Neither a size nor a count, and both are reported rather than faked:
 *
 * - MJ's frame shape lives in the prompt as `--ar`, and the gateway does not
 *   parse it (no `--ar` anywhere in `relay-mj.go`; it only appends ` --v 7` when
 *   no `--v` is present, `relay/relay-mj.go:1063-1075`). Writing `--ar` into
 *   someone's prompt is editing their intent, so the requested shape is handed
 *   back as a note instead.
 * - One imagine is one submission, and what it returns is a single 2×2 grid
 *   image. Splitting it means `/mj/submit/action` upscales, which this tool does
 *   not carry. Verified live on 2026-08-21: 65 seconds, one 8.5 MB PNG holding
 *   four variations.
 *
 * @module openlux-plugin-account/media/image/mj
 */

import { AccountRequestError, requestJson, type HttpReply } from '../../account/http.ts'
import {
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
 * `MID_JOURNEY` or `NIJI_JOURNEY` (the anime one); the platform's own Lab
 * defaults to the former. Not a parameter, because this tool's vocabulary has no
 * style dial and a knob with no caller is a liability.
 */
const BOT_TYPE = 'MID_JOURNEY'

/** Budget for the submit; it only creates a task. */
const SUBMIT_TIMEOUT_MS = 60_000

/** Budget for one status read; it is a local database lookup. */
const POLL_TIMEOUT_MS = 30_000

/**
 * How long to wait for the picture.
 *
 * Live runs land around 65 seconds and the openclaw-era booklet recorded
 * 51–74. This leaves room for a queue without outliving the tool's own budget.
 */
const POLL_BUDGET_MS = 220_000

/**
 * Gap between reads.
 *
 * The gateway refreshes its copy from upstream every 15 seconds, so the
 * discovery lag is bounded by that cadence rather than by this. Six seconds
 * keeps the worst-case lag well under one refresh while costing a third of the
 * requests a one-second loop would.
 */
const POLL_INTERVAL_MS = 6000

export const mjImagineProvider: ImageProvider = {
  id: 'mj-imagine',
  endpointTypes: ['MJ imagine'],
  fallbackModels: ['mj_imagine'],
  variesCount: false,
  variesSize: false,

  async generate(wire: ImageWire, request: ImageRequest): Promise<ImageOutcome> {
    const taskId = await submit(wire, request.prompt)
    const url = await settle(wire, taskId)
    const ignored: string[] = []
    if (request.size !== undefined) {
      ignored.push('MJ 这条接口没有尺寸字段（比例只能写在提示词里的 --ar，那是改你的提示词，所以没做），'
        + `这次的 ${request.size} 没有生效。`)
    }
    if (request.count > 1) {
      ignored.push(`MJ 一次提交只出一张四格拼图，无法指定张数，请求的 ${String(request.count)} 张实际是 1 张（含 4 个变体）。`)
    }
    return { carriers: [{ kind: 'url', url }], ignored }
  },
}

/**
 * Create the task.
 * @param wire - route access.
 * @param prompt - what to draw, passed through untouched.
 * @returns the task id.
 * @throws {ImageGenerationError} when the route or MJ refused.
 */
async function submit(wire: ImageWire, prompt: string): Promise<string> {
  let reply: HttpReply
  try {
    reply = await requestJson(wire.ctx, `${wire.root}/mj/submit/imagine`, {
      method: 'POST',
      headers: wire.headers,
      body: JSON.stringify({ botType: BOT_TYPE, prompt }),
    }, SUBMIT_TIMEOUT_MS, wire.signal)
  } catch (error: unknown) {
    throw new ImageGenerationError(error instanceof AccountRequestError
      ? error.message
      : `MJ 出图提交失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const answer = object(reply.body) ?? {}
  const complaint = reason(answer)
  if (!reply.response.ok) {
    throw new ImageGenerationError(`MJ 出图提交失败（HTTP ${String(reply.response.status)}）${complaint ?? ''}`)
  }
  if (answer['code'] !== 1) {
    throw new ImageGenerationError(`MJ 拒绝了这次提交${complaint ?? `（code ${String(answer['code'])}）`}`)
  }
  const taskId = text(answer['result'])
  if (taskId === undefined) throw new ImageGenerationError(`MJ 提交回执里没有任务号${complaint ?? ''}`)
  return taskId
}

/**
 * Wait for the task to finish and answer with the finished picture's URL.
 * @param wire - route access.
 * @param taskId - what {@link submit} returned.
 * @returns the image URL, once the task really is done.
 * @throws {ImageGenerationError} when it failed, or outlived the budget.
 */
async function settle(wire: ImageWire, taskId: string): Promise<string> {
  const started = Date.now()
  let lastStatus = ''
  while (Date.now() - started < POLL_BUDGET_MS) {
    await pause(POLL_INTERVAL_MS, wire.signal)
    let reply: HttpReply
    try {
      reply = await requestJson(wire.ctx, `${wire.root}/mj/task/${encodeURIComponent(taskId)}/fetch`, {
        method: 'GET',
        headers: { Authorization: wire.headers['Authorization'] ?? '' },
      }, POLL_TIMEOUT_MS, wire.signal)
    } catch (error: unknown) {
      // One unreadable status is not a failed task: the picture is being drawn
      // upstream either way, so the loop keeps its budget and reads again.
      wire.ctx.logger.warn(`openlux: MJ status read failed (${error instanceof Error ? error.message : String(error)}); retrying`)
      continue
    }
    if (!reply.response.ok) {
      wire.ctx.logger.warn(`openlux: MJ status read returned HTTP ${String(reply.response.status)}; retrying`)
      continue
    }
    const answer = object(reply.body) ?? {}
    const status = text(answer['status'])?.toUpperCase() ?? ''
    if (status !== lastStatus) {
      wire.ctx.logger.debug(`openlux: MJ task ${taskId} is ${status} ${text(answer['progress']) ?? ''}`)
      lastStatus = status
    }
    const failure = text(answer['failReason'])
    if (status === 'FAILURE' || failure !== undefined) {
      throw new ImageGenerationError(`MJ 出图失败：${failure ?? '上游没有给出原因'}`)
    }
    if (status !== 'SUCCESS') continue
    const url = text(answer['imageUrl'])
    if (url === undefined) throw new ImageGenerationError('MJ 报告出图完成，但回执里没有图片地址。')
    return url
  }
  throw new ImageGenerationError(`MJ 出图超过 ${String(Math.round(POLL_BUDGET_MS / 1000))} 秒还没完成（正常 60~80 秒）。`
    + '任务在上游还在跑，隔一会儿再试一次。')
}

/**
 * The gateway's own words for a refusal, in either shape it uses.
 *
 * `description` is how it reports rejecting a call (`controller/relay.go`), and
 * `failReason` is how a polled task reports having failed (`dto/midjourney.go`).
 * @param answer - the response body.
 * @returns the complaint in brackets, or undefined when it said nothing.
 */
function reason(answer: Record<string, unknown>): string | undefined {
  const detail = text(answer['failReason']) ?? text(answer['description'])
  return detail === undefined ? undefined : `：${detail}`
}
