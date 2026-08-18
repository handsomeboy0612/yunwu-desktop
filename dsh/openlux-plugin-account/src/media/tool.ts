/**
 * The model-facing image tool.
 *
 * ## Why the picture does not enter the conversation's content
 *
 * A tool result's content is model-facing: it becomes part of the session's
 * derived messages forever. An `ImageBlock` there costs more than it looks. The
 * route's own text models reject image content outright when serializing a
 * request (`llm/llm-deepseek/src/serialize.ts` asserts text-only), and the host
 * refuses the whole turn before dispatch when the session carries an image the
 * resolved model cannot accept (`host/apiproxy/src/api-proxy.ts`, image
 * admission). So one generated picture would quietly convert the session into
 * one that only vision models may continue — a trap that springs later, when the
 * user switches model and an old turn breaks a new conversation.
 *
 * The kernel already separates those two audiences. `output.render` produces the
 * model-facing content, and `presentResult` produces a UI-facing view that is
 * computed per delivery and never persisted. This tool therefore renders text for
 * the model and carries the images in the view — verified on the shipped profile
 * before this file existed: `contentHasImage` is false for the rendered content
 * and true for the view.
 *
 * Because the view is recomputed on every delivery, it cannot close over the
 * execution's own values; `output.presentationMeta` is the one projection the
 * session log keeps, so the attachment references travel through it and
 * `presentResult` narrows them back on live and replay paths alike. That is the
 * same route the kernel's own read tool takes for its line-numbered card.
 *
 * @module openlux-plugin-account/media/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ConsoleAccess } from '../market/console.ts'
import { generateImages, ImageGenerationError, size } from './images.ts'
import { IMAGE_TOOL_NAME } from './name.ts'

export { IMAGE_TOOL_NAME } from './name.ts'

/**
 * The model this tool draws with unless the composition names another.
 *
 * Chosen from what the route actually serves through `/v1/images/generations`,
 * not from what the catalog lists: asking for `gemini-2.5-flash-image-preview`
 * on this endpoint is refused with HTTP 503 and a list of every group that has
 * no channel for it, so the whole `gemini-*-image-*` family is unreachable here
 * however available it looks. Seedream 4.0 answers in about 15 seconds with a
 * ~900 KB JPEG, renders Chinese text legibly, and is the cheapest of the
 * current-generation options on this route.
 *
 * The model never chooses this: availability is a deployment fact it cannot
 * see, and a hallucinated model name is a refused request the user pays for in
 * latency.
 */
export const DEFAULT_IMAGE_MODEL = 'doubao-seedream-4-0-250828'

/**
 * What each servable model accepts.
 *
 * Read off the gateway's own model table (`new-yunwu-api`,
 * `web/src/data/modelParams.js`), the same data its Lab UI offers — the route
 * is what refuses us, so its notion of a valid size outranks the vendor's docs.
 *
 * A size outside the set is not refused, it *hangs*: `size: '123x456'` returned
 * nothing for a full 180-second budget while a listed value answered in ~15s.
 * So the set ships as an `enum` the model cannot step outside, and the tool
 * offers no size at all rather than a free-text field that can cost three
 * minutes. A deployment adopting a newer model adds its row here, because the
 * model and its sizes are one fact and a model without them is that same trap.
 */
const ROUTE_MODELS: Record<string, { readonly sizes: readonly string[]; readonly maxImages: number }> = {
  'doubao-seedream-4-0-250828': {
    sizes: ['1K', '2K', '4K', '2048x2048', '2848x1600', '1600x2848', '2304x1728', '1728x2304'],
    maxImages: 4,
  },
  'doubao-seedream-4-5-251128': {
    sizes: ['2K', '4K', '2048x2048', '2848x1600', '1600x2848', '2304x1728', '1728x2304'],
    maxImages: 4,
  },
  'doubao-seedream-3-0-t2i-250415': {
    sizes: ['2K', '4K', '2048x2048', '2848x1600', '1600x2848', '2304x1728', '1728x2304', '2496x1664', '1664x2496'],
    maxImages: 4,
  },
}

/**
 * Cooperative budget for one call: above the sum of what the request layer can
 * spend on its own (two 90-second generation attempts plus one 60-second
 * transfer), so this cap never fires while that layer still has a deadline of
 * its own to report. It bounds a hung socket, not the endpoint.
 */
const TOOL_TIMEOUT_MS = 250_000

const description = 'Generate one or more images from a text prompt and show them to the user in this conversation. '
  + 'Write the prompt as a single vivid description of the desired result: subject, composition, style, colours, and any text to render. '
  + 'The result you receive is text only — the images themselves are displayed to the user, and you cannot see them, '
  + 'so do not describe their content as if you had. Each image is returned with a durable attachment id you can quote when referring to it later.'

/** What the tool reads out of its own composition. */
export interface ImageToolOptions {
  /** Route origin and token reader, shared with the account face. */
  readonly access: ConsoleAccess
  /** Model to draw with; the default is a route-verified one. */
  readonly model?: string
}

/**
 * Register the image tool, when this composition has what it needs.
 *
 * Both services are read opportunistically rather than injected: the account
 * face must mount in a composition that carries neither (the kernel supports
 * host shapes with no tool runtime), and a missing one costs exactly this tool
 * rather than sign-in, balance, and the market.
 * @param ctx - host context; the registration follows this fiber's lifetime.
 * @param options - route access and the model to draw with.
 */
export function registerImageTool(ctx: Context, options: ImageToolOptions): void {
  const tools = ctx.get('tools')
  const attachments = ctx.get('attachments')
  if (tools === undefined || attachments === undefined) {
    ctx.logger.debug('openlux: no tool runtime or attachment store in this composition; the image tool stays unregistered')
    return
  }
  // A configured model with no row above would ship a size the route cannot
  // serve, so it is declined here rather than half-supported at call time.
  const configured = options.model ?? DEFAULT_IMAGE_MODEL
  const known = ROUTE_MODELS[configured] !== undefined
  if (!known) {
    ctx.logger.warn(`openlux: image model "${configured}" has no known size set; drawing with ${DEFAULT_IMAGE_MODEL} instead`)
  }
  const model = known ? configured : DEFAULT_IMAGE_MODEL
  const route = ROUTE_MODELS[model] ?? ROUTE_MODELS[DEFAULT_IMAGE_MODEL]!

  ctx.effect(() => tools.register(defineTool({
    name: IMAGE_TOOL_NAME,
    description,
    timeoutMs: TOOL_TIMEOUT_MS,
    // Each call writes its own content-addressed objects and mutates nothing a
    // sibling call can observe, so a request for three different pictures may
    // run as one parallel group.
    isConcurrencySafe: () => true,
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'What to draw, as one self-contained description. The image model sees only this text, not the conversation.',
      },
      n: {
        type: 'integer',
        description: `How many images to generate, 1 to ${String(route.maxImages)}. Defaults to 1; each one is billed separately.`,
      },
      size: {
        type: 'string',
        enum: route.sizes,
        description: 'Optional output size. "1K"/"2K"/"4K" keep the square default at that resolution, '
          + 'and a pixel pair picks an aspect ratio (e.g. "2848x1600" for 16:9, "1600x2848" for 9:16). '
          + 'Omit it unless the user asked for a shape or a resolution.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string', required: true },
          images: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                attachmentId: { type: 'string', required: true },
                mediaType: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                revisedPrompt: { type: 'string' },
              },
            },
          },
          failures: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderText(value as ToolValue) }],
      // The canonical value never reaches a later delivery, so the references
      // the card renders have to survive in the log's own copy.
      presentationMeta: (_args, value) => {
        const { images, model: used } = value as ToolValue
        return { model: used, images: images.map(image => ({ ...image })) }
      },
    },
    async execute(args, exec) {
      const count = clamp(args.n, route.maxImages)
      const outcome = await generateImages(ctx, options.access, {
        model,
        prompt: args.prompt,
        n: count,
        ...args.size === undefined ? {} : { size: args.size },
        maxBytes: attachments.imageLimits.maxImageBytes,
      }, exec.signal)

      const saved: ToolImage[] = []
      const failures = [...outcome.failures]
      for (const [index, image] of outcome.images.entries()) {
        try {
          const ref = await attachments.saveImage({
            data: image.data,
            mediaType: image.mediaType,
            name: fileName(args.prompt, index, image.mediaType),
          })
          saved.push({
            attachmentId: String(ref.attachmentId),
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...image.revisedPrompt === undefined ? {} : { revisedPrompt: image.revisedPrompt },
          })
        } catch (error: unknown) {
          // The bytes arrived and were paid for; a store that refuses them is
          // this machine's limit, so it is reported per image instead of
          // discarding the images that did land.
          failures.push(`第 ${String(index + 1)} 张（${size(image.data.byteLength)} ${image.mediaType}）保存失败：`
            + `${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (saved.length === 0) {
        throw new ImageGenerationError(`图片已生成但无法保存到本机附件库。\n${failures.join('\n')}`)
      }
      return { model, images: saved, ...failures.length === 0 ? {} : { failures } }
    },
    presentCall: (args) => {
      const prompt = typeof (args as { prompt?: unknown }).prompt === 'string' ? (args as { prompt: string }).prompt : ''
      return { card: 'generic', title: '生成图片', rawInput: prompt }
    },
    presentResult: (_args, result) => {
      const meta = result.meta as { images?: unknown } | undefined
      const images = Array.isArray(meta?.images) ? meta.images as readonly ToolImage[] : []
      // No metadata means a nested call under a composite transport (the
      // projection is computed for top-level calls only), where the text
      // content is the whole of what a reader gets anyway.
      if (result.isError || images.length === 0) return undefined
      return {
        card: 'generic',
        title: `已生成 ${String(images.length)} 张图片`,
        content: images.map(image => ({ type: 'image', attachment: toRef(image) })),
      }
    },
  })), 'openlux: image tool')
}

/** One saved image, as the canonical value and the log's metadata carry it. */
interface ToolImage {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly revisedPrompt?: string
}

/** The tool's canonical value. */
interface ToolValue {
  readonly model: string
  readonly images: readonly ToolImage[]
  readonly failures?: readonly string[]
}

/**
 * Rebuild a durable reference from the log's own copy of it.
 *
 * The metadata is plain JSON by the time it comes back, so the branded id is
 * re-asserted here rather than carried; the reference is only ever handed to a
 * reader that verifies the bytes it names.
 * @param image - one metadata entry.
 * @returns the attachment reference.
 */
function toRef(image: ToolImage): ImageAttachmentRef {
  return {
    attachmentId: image.attachmentId,
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
  } as ImageAttachmentRef
}

/**
 * The model-facing text for one completed call.
 *
 * It says the images are already visible, because they are: the card carries
 * them and the model cannot. Without that line a model tends to either
 * describe pictures it never saw or offer to send them.
 * @param value - the canonical value.
 * @returns the content text.
 */
function renderText(value: ToolValue): string {
  const lines = value.images.map((image, index) =>
    `${String(index + 1)}. ${String(image.width)}×${String(image.height)} ${image.mediaType}`
    + `，附件 ${image.attachmentId}`
    + `${image.revisedPrompt === undefined ? '' : `（模型改写的提示词：${image.revisedPrompt}）`}`)
  const head = `已用 ${value.model} 生成 ${String(value.images.length)} 张图片，已直接展示在对话中，用户可以看到；`
    + '你自己看不到图片内容，不要描述或评价它。'
  const tail = value.failures === undefined || value.failures.length === 0
    ? []
    : ['未能取回的部分：', ...value.failures]
  return [head, ...lines, ...tail].join('\n')
}

/**
 * Keep the count inside what one call may spend.
 * @param n - what the model asked for, if it asked.
 * @param max - this model's own per-call cap.
 * @returns a count between 1 and the cap.
 */
function clamp(n: number | undefined, max: number): number {
  if (n === undefined || !Number.isFinite(n)) return 1
  return Math.min(Math.max(Math.floor(n), 1), max)
}

/**
 * A display name for one saved image.
 *
 * The store never interprets it as a path, but it is what a download or an
 * export names the file, so it carries a readable slice of the prompt.
 * @param prompt - the request's prompt.
 * @param index - position within this call.
 * @param mediaType - the sniffed type, for the extension.
 * @returns the file name.
 */
function fileName(prompt: string, index: number, mediaType: string): string {
  const stem = prompt.replace(/\s+/gu, '-').replace(/[^\p{L}\p{N}-]/gu, '').slice(0, 24)
  const extension = mediaType.replace('image/', '').replace('jpeg', 'jpg')
  return `${stem === '' ? 'image' : stem}-${String(index + 1)}.${extension}`
}
