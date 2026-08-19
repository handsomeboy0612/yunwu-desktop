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
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ConsoleAccess } from '../market/console.ts'
import { imageArtifactPath, writeImageArtifact } from './artifact.ts'
import { describeImage, imageBlocks, imagesOf, TOOL_IMAGE_PROPERTIES, type ToolImage } from './card.ts'
import { assertImageModel, readImageCatalog } from './catalog.ts'
import { generateImages, ImageGenerationError, size } from './images.ts'
import { IMAGE_SHOW_TOOL_NAME, IMAGE_TOOL_NAME } from './name.ts'

export { IMAGE_TOOL_NAME } from './name.ts'

/**
 * The model this tool draws with when nobody named one.
 *
 * Chosen from what the route actually serves through `/v1/images/generations`,
 * not from what the catalog lists: asking for `gemini-2.5-flash-image-preview`
 * on this endpoint is refused with HTTP 503 and a list of every group that has
 * no channel for it, so the whole `gemini-*-image-*` family is unreachable here
 * however available it looks. Seedream 4.0 answers in about 15 seconds with a
 * ~900 KB JPEG, renders Chinese text legibly, and is the cheapest of the
 * current-generation options on this route.
 *
 * A caller may name another one, and the reason it is allowed to is that the
 * alternative turned out to be worse: this key's catalogue carried 22 servable
 * image models on 2026-08-19, and a request for any of the other 21 used to be
 * answered by drawing with this one and logging a warning nobody reads. Naming
 * a model that is not servable is now refused with the list of ones that are
 * (see `media/catalog.ts`), which costs no upstream round trip.
 */
export const DEFAULT_IMAGE_MODEL = 'doubao-seedream-4-0-250828'

/**
 * The sizes this tool offers, for every model.
 *
 * A size the upstream does not recognise is not refused, it *hangs*:
 * `size: '123x456'` returned nothing for a full 180-second budget while a
 * standard value answered in about 15 seconds. The gateway cannot save us from
 * that — `relay/valid_request.go` validates only `n`, and reads `size` straight
 * through with no enum and no binding — so the guard has to be here.
 *
 * These three are the openclaw-era plugin's `IMAGE_SIZE_BY_ORIENTATION`, and
 * they are offered to every model rather than per model because that is what
 * measured true: on 2026-08-19 all three answered HTTP 200 on Seedream 4.0
 * (10.3–10.5s) and on `gpt-image-2` (22.7s), and `1024x1024` also answered on
 * `qwen-image-max` (13.6s, a `dall-e-3`-typed model) and on the newer
 * `doubao-seedream-5-0-260128` (29.9s). Seedream's own parameter table lists
 * `1K`/`2K`/`4K` and 2048-wide pairs instead, so the earlier per-model
 * enumeration read off that table refused values the route in fact serves.
 *
 * Three is also the whole vocabulary worth having: a longer list reads as a
 * promise of precision this tool does not keep, since the shape is all any
 * caller downstream distinguishes.
 */
const IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536'] as const

/**
 * Images per call, matching what the replaced kernel slot allowed.
 *
 * `n` above a model's own cap comes back as a legible refusal from the gateway
 * (it is the one image field that *is* validated, because `n` multiplies the
 * bill), so this bound only keeps an obvious mistake from becoming a request.
 */
const IMAGE_MAX_COUNT = 4

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
  + 'so do not describe their content as if you had. Each image is also saved as a file, and the result gives you its path: '
  + `quote that path when someone else has to reach the picture, because ${IMAGE_SHOW_TOOL_NAME} takes it.`

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
  // What a call that names no model draws with. It is not checked against a
  // table here: which models are servable belongs to the route's channel pool
  // at call time, so that check moved to `media/catalog.ts` where it can be
  // answered with today's answer instead of this build's.
  const fallbackModel = options.model ?? DEFAULT_IMAGE_MODEL

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
        // The cap is a schema constraint rather than a runtime clamp, so the
        // registry's own validation refuses an over-count and tells the model
        // what it may ask for. Numeric specs carry `enum`/`const` and no
        // range keywords, so the allowed counts are listed.
        enum: Array.from({ length: IMAGE_MAX_COUNT }, (_, index) => index + 1),
        description: `How many images to generate, 1 to ${String(IMAGE_MAX_COUNT)}. Defaults to 1; each one is billed separately.`,
      },
      size: {
        type: 'string',
        enum: IMAGE_SIZES,
        description: 'Optional shape: square, landscape, or portrait respectively. '
          + 'Omit it unless the user asked for a shape, in which case pick the matching one.',
      },
      model: {
        type: 'string',
        // Deliberately free text rather than an enum: the servable set belongs
        // to the route and changes without a release here, so an enum would be
        // a list that goes stale in both directions. An unservable name is
        // refused by name at call time with the list of servable ones.
        description: 'Optional. Only set this when the user named a specific image model — pass their name through verbatim. '
          + `Leave it out otherwise and a route-verified default (${DEFAULT_IMAGE_MODEL}) is used; `
          + 'do not guess at model names, because a name this account cannot serve is refused rather than substituted.',
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
              properties: { ...TOOL_IMAGE_PROPERTIES },
            },
          },
          failures: { type: 'array', items: { type: 'string' } },
          // Whether this call ran inside a delegated child. It belongs to the
          // value rather than being read where the text is built, because
          // `render` receives the arguments and the value and nothing else —
          // there is no execution context at that point, and the answer is a
          // fact about the execution.
          delegated: { type: 'boolean' },
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
      const count = args.n ?? 1
      // A named model is checked against the live catalogue before the request:
      // the refusal is immediate and says what this account can draw with,
      // where the previous behaviour — draw with the default and log a warning
      // — spent the user's money on a picture in a style they did not choose
      // and told nobody. The default itself is not re-checked, because the
      // deployment verified it and a catalogue read is a round trip.
      const named = typeof args.model === 'string' ? args.model.trim() : ''
      const model = named === '' ? fallbackModel : named
      if (named !== '' && named !== fallbackModel) {
        assertImageModel(await readImageCatalog(ctx, options.access, exec.signal), named)
      }
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
          const path = imageArtifactPath(args.prompt, String(ref.attachmentId), ref.mediaType)
          // Best-effort, and after the commit rather than instead of it: the
          // card is what shows this picture, so a machine that cannot take the
          // file copy loses the path this result would have quoted, not the
          // image. Reported as a per-image note for the same reason a refused
          // save is — silence would leave the model quoting a path that is not
          // there.
          const written = await writeArtifact(ctx, path, image.data)
          if (!written) failures.push(`第 ${String(index + 1)} 张已展示，但文件副本没写成，这一张没有可转述的路径。`)
          saved.push({
            attachmentId: String(ref.attachmentId),
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...image.revisedPrompt === undefined ? {} : { revisedPrompt: image.revisedPrompt },
            ...written ? { path } : {},
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
      return {
        model,
        images: saved,
        ...failures.length === 0 ? {} : { failures },
        ...exec.agent?.session.header.origin === 'subagent' ? { delegated: true } : {},
      }
    },
    presentCall: (args) => {
      const prompt = typeof (args as { prompt?: unknown }).prompt === 'string' ? (args as { prompt: string }).prompt : ''
      return { card: 'generic', title: '生成图片', rawInput: prompt }
    },
    presentResult: (_args, result) => {
      const images = imagesOf(result.meta)
      // No metadata means a nested call under a composite transport (the
      // projection is computed for top-level calls only), where the text
      // content is the whole of what a reader gets anyway.
      if (result.isError || images.length === 0) return undefined
      return {
        card: 'generic',
        title: `已生成 ${String(images.length)} 张图片`,
        content: imageBlocks(images),
      }
    },
  })), 'openlux: image tool')
}

/** The tool's canonical value. */
interface ToolValue {
  readonly model: string
  readonly images: readonly ToolImage[]
  readonly failures?: readonly string[]
  readonly delegated?: boolean
}

/**
 * Write one image's file copy, reporting rather than raising a failure.
 * @param ctx - host context, for the log line a swallowed error owes.
 * @param path - destination.
 * @param data - the encoded image.
 * @returns whether the file is there.
 */
async function writeArtifact(ctx: Context, path: string, data: Uint8Array): Promise<boolean> {
  try {
    await writeImageArtifact(path, data)
    return true
  } catch (error: unknown) {
    ctx.logger.warn(`openlux: could not write the image file copy at ${path}`)
    ctx.logger.warn(error)
    return false
  }
}

/**
 * The model-facing text for one completed call.
 *
 * Two audiences, decided by where the call ran. In an ordinary conversation the
 * text says the pictures are already visible, because they are — the card
 * carries them and the model cannot; without that line a model tends to either
 * describe pictures it never saw or offer to send them.
 *
 * Inside a delegated child that same line is a lie, and it was one we shipped: a
 * team member drew a picture, was told the user could see it, and reported so to
 * its lead, who repeated it. Nobody saw anything — the card was in the member's
 * own transcript, and only text crosses back (`media/artifact.ts`). So a
 * delegated call is told what is actually true and what to do about it.
 * @param value - the canonical value.
 * @returns the content text.
 */
function renderText(value: ToolValue): string {
  const lines = value.images.map((image, index) => describeImage(image, index))
  const count = String(value.images.length)
  const head = value.delegated === true
    ? `已用 ${value.model} 生成 ${count} 张图片。`
      + '**你是被派活的成员，这些图只出现在你自己这条会话里，用户和主理人都看不到。**'
      + `把上面每一行的文件路径原样写进你的汇报，并请主理人用 ${IMAGE_SHOW_TOOL_NAME} 展示给用户；`
      + '路径写漏了这些图就等于没出。你自己也看不到图片内容，不要描述或评价它。'
    : `已用 ${value.model} 生成 ${count} 张图片，已直接展示在对话中，用户可以看到；`
      + '你自己看不到图片内容，不要描述或评价它。'
  const tail = value.failures === undefined || value.failures.length === 0
    ? []
    : ['未能取回的部分：', ...value.failures]
  return [head, ...lines, ...tail].join('\n')
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
