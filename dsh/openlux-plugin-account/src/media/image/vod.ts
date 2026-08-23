/**
 * Tencent Cloud VOD's AIGC image task: `POST /tencent-vod/v1/aigc-image`.
 *
 * New ground — this product's openclaw-era plugin never carried it — so every
 * shape below was read off the gateway's own source and then confirmed by a live
 * generation on 2026-08-21.
 *
 * ## Why this route is worth having when the direct Kling one is not
 *
 * Both draw with Kling. `POST /kling/v1/images/generations` answers
 * 「Account balance not enough」 on this key, which is an upstream funding
 * matter no code here can fix, so that transport is deliberately not wired. The
 * same picture through Tencent's AIGC task works: the channel behind it is a
 * different account. Whether a model is *reachable* is not a property of the
 * model, which is exactly why the catalogue rather than a name list decides.
 *
 * ## The name is split, because the catalogue's and the API's disagree
 *
 * The catalogue sells one id, `aigc-image-kling`, with no version in it. The API
 * requires `model_name` **and** `model_version` separately, and the gateway
 * rebuilds the billing name from the pair as
 * `aigc-image-<short>-<lower(version)>` (`BuildInternalModelName`), validating
 * the result against its own list (`ImageModelList`) — so an invented version is
 * an HTTP 400 before any task exists. The pairs below are copied from that list's
 * companion table (`ModelConfigMap`), not guessed; the *choice* of which version
 * a version-less id means is ours, and it is the one that has produced bytes.
 *
 * @module openlux-plugin-account/media/image/vod
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

/** Budget for the submit; it only creates a task. */
const SUBMIT_TIMEOUT_MS = 60_000

/** Budget for one status read. */
const POLL_TIMEOUT_MS = 30_000

/**
 * How long to wait for the picture. The live run finished in about 30 seconds;
 * this leaves room for a queue without outliving the tool's own budget.
 */
const POLL_BUDGET_MS = 220_000

/** Gap between status reads. */
const POLL_INTERVAL_MS = 5000

/**
 * Catalogue id to the API's `model_name` / `model_version` pair.
 *
 * Keyed by the id the catalogue sells. Today it sells exactly one of these; the
 * rest are here because they are the same mount with a different pair of strings
 * in the body, so the day one appears it works rather than being refused by a
 * table nobody remembered to extend. `3.0` is the version this route has
 * actually drawn with.
 */
const MODELS: Readonly<Record<string, { readonly name: string; readonly version: string }>> = {
  'aigc-image-kling': { name: 'Kling', version: '3.0' },
  'aigc-image-gem': { name: 'GEM', version: '3.0' },
  'aigc-image-qwen': { name: 'Qwen', version: '0925' },
  'aigc-image-hunyuan': { name: 'Hunyuan', version: '3.0' },
}

export const vodImageProvider: ImageProvider = {
  id: 'tencent-vod-image',
  endpointTypes: ['aigc-image'],
  fallbackModels: ['aigc-image-kling'],
  variesCount: false,
  variesSize: true,

  async generate(wire: ImageWire, request: ImageRequest): Promise<ImageOutcome> {
    const pair = MODELS[request.model]
    if (pair === undefined) {
      throw new ImageGenerationError(`「${request.model}」走的是腾讯云点播的生图任务，`
        + `但本工具还没有它的 model_name / model_version 对应关系，没法提交。`
        + `这条链路目前接了：${Object.keys(MODELS).join('、')}。`)
    }
    const aspect = aspectOf(request.size)
    const taskId = await submit(wire, {
      model_name: pair.name,
      model_version: pair.version,
      prompt: request.prompt,
      output_config: {
        // The picture is downloaded within seconds of finishing, so a temporary
        // object is all that is needed; `Persistent` would leave a copy parked
        // in the channel owner's own VOD library for nobody.
        storage_mode: 'Temporary',
        ...aspect === undefined ? {} : { aspect_ratio: aspect },
      },
    })
    const url = await settle(wire, taskId)
    const ignored: string[] = []
    if (request.count > 1) {
      ignored.push(`腾讯云点播的生图任务一次只出一张，无法指定张数，请求的 ${String(request.count)} 张实际是 1 张。`)
    }
    return { carriers: [{ kind: 'url', url }], ignored }
  },
}

/**
 * Create the task.
 * @param wire - route access.
 * @param body - the request, already in the gateway's snake-case shape.
 * @returns the task id.
 * @throws {ImageGenerationError} when the route refused.
 */
async function submit(wire: ImageWire, body: Record<string, unknown>): Promise<string> {
  let reply: HttpReply
  try {
    reply = await requestJson(wire.ctx, `${wire.root}/tencent-vod/v1/aigc-image`, {
      method: 'POST',
      headers: wire.headers,
      body: JSON.stringify(body),
    }, SUBMIT_TIMEOUT_MS, wire.signal)
  } catch (error: unknown) {
    throw new ImageGenerationError(error instanceof AccountRequestError
      ? error.message
      : `腾讯云生图提交失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const answer = object(reply.body) ?? {}
  const complaint = text(object(answer['error'])?.['message'])
    ?? text(answer['message'])
    ?? text(object(answer['Response'])?.['Error'])
  if (!reply.response.ok) {
    throw new ImageGenerationError(`腾讯云生图提交失败（HTTP ${String(reply.response.status)}）`
      + `${complaint === undefined ? '' : `：${complaint}`}`)
  }
  const taskId = text(object(answer['Response'])?.['TaskId']) ?? text(answer['task_id'])
  if (taskId === undefined) {
    throw new ImageGenerationError(`腾讯云生图提交回执里没有任务号${complaint === undefined ? '' : `：${complaint}`}`)
  }
  return taskId
}

/**
 * Wait for the task and answer with the finished picture's URL.
 *
 * The gateway normalises every task platform onto one status vocabulary
 * (`model.TaskStatus`: NOT_START / SUBMITTED / QUEUED / IN_PROGRESS / SUCCESS /
 * FAILURE), so the states are read from its envelope while the URL is dug out of
 * the upstream body it keeps alongside — `Output.FileInfos[0].FileUrl` is what
 * arrived live, and `ImageInfoSet[0].ImageUrl` is the shape the gateway's own
 * `ParseResultUrl` expects, so both are read.
 * @param wire - route access.
 * @param taskId - what {@link submit} returned.
 * @returns the image URL.
 * @throws {ImageGenerationError} when it failed, or outlived the budget.
 */
async function settle(wire: ImageWire, taskId: string): Promise<string> {
  const started = Date.now()
  let lastStatus = ''
  while (Date.now() - started < POLL_BUDGET_MS) {
    await pause(POLL_INTERVAL_MS, wire.signal)
    let reply: HttpReply
    try {
      reply = await requestJson(wire.ctx, `${wire.root}/tencent-vod/v1/query/${encodeURIComponent(taskId)}`, {
        method: 'GET',
        headers: { Authorization: wire.headers['Authorization'] ?? '' },
      }, POLL_TIMEOUT_MS, wire.signal)
    } catch (error: unknown) {
      wire.ctx.logger.warn(`openlux: VOD status read failed (${error instanceof Error ? error.message : String(error)}); retrying`)
      continue
    }
    if (!reply.response.ok) {
      wire.ctx.logger.warn(`openlux: VOD status read returned HTTP ${String(reply.response.status)}; retrying`)
      continue
    }
    const task = object(object(reply.body)?.['data']) ?? {}
    const status = text(task['status'])?.toUpperCase() ?? ''
    if (status !== lastStatus) {
      wire.ctx.logger.debug(`openlux: VOD task ${taskId} is ${status} ${text(task['progress']) ?? ''}`)
      lastStatus = status
    }
    if (status === 'FAILURE') {
      throw new ImageGenerationError(`腾讯云生图失败：${text(task['fail_reason']) ?? '上游没有给出原因'}`)
    }
    if (status !== 'SUCCESS') continue
    const url = pictureUrl(task['data'])
    if (url === undefined) throw new ImageGenerationError('腾讯云报告生图完成，但回执里没有图片地址。')
    return url
  }
  throw new ImageGenerationError(`腾讯云生图超过 ${String(Math.round(POLL_BUDGET_MS / 1000))} 秒还没完成（正常 30 秒上下）。`
    + '任务在上游还在跑，隔一会儿再试一次。')
}

/**
 * Dig the picture's URL out of the upstream body the gateway kept.
 * @param raw - the `data.data` payload, as the upstream sent it.
 * @returns the URL, or undefined when the finished task carries none.
 */
function pictureUrl(raw: unknown): string | undefined {
  const output = object(object(object(raw)?.['Response'])?.['AigcImageTask'])?.['Output']
  const files = object(output)?.['FileInfos']
  if (Array.isArray(files)) {
    const url = text(object(files[0])?.['FileUrl'])
    if (url !== undefined) return url
  }
  const images = object(output)?.['ImageInfoSet']
  if (Array.isArray(images)) return text(object(images[0])?.['ImageUrl'])
  return undefined
}
