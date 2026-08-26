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

import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ConsoleAccess } from '../market/console.ts'
import { imageArtifactPath, writeImageArtifact } from './artifact.ts'
import { describeImage, imageBlocks, imagesOf, TOOL_IMAGE_PROPERTIES, type ToolImage } from './card.ts'
import type { ImageCatalog } from './image/registry.ts'
import {
  defaultImageModel,
  imageDefaultRefusal,
  imageEditRefusal,
  imageModelRefusal,
  readImageCatalog,
  resolveImageModel,
} from './image/registry.ts'
import type { ImageReference } from './image/provider.ts'
import { generateImages, ImageGenerationError, size } from './images.ts'
import { IMAGE_SHOW_TOOL_NAME, IMAGE_TOOL_NAME } from './name.ts'
import { findLatestImage, type SessionEventSource } from './session-images.ts'

export { IMAGE_TOOL_NAME } from './name.ts'

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
 * caller downstream distinguishes. It is also what makes these values portable
 * across the other transports, which take a ratio rather than a pixel pair:
 * square / landscape / portrait fold onto `1:1` / `16:9` / `9:16`, which both
 * Gemini and Tencent's AIGC route accept. A transport with no shape field at all
 * (MJ) says so afterwards rather than silently framing it differently.
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
  /** Capture one token for catalogue selection and the paid request. */
  readonly captureAccess?: () => Promise<ConsoleAccess>
  /** Model to draw with, or a runtime reader updated by server delivery. */
  readonly model?: string | (() => string | undefined)
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
  // What the server delivered, if anything. Whether it is servable — and what
  // to draw with when nothing was delivered at all — belongs to the route's
  // channel pool at call time, so both answers come from
  // `media/image/registry.ts` with today's catalogue rather than this build's.
  const deliveredModel = (): string | undefined => {
    const configured = typeof options.model === 'function' ? options.model() : options.model
    const trimmed = configured?.trim()
    return trimmed === undefined || trimmed === '' ? undefined : trimmed
  }

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
        description: `How many images to generate, 1 to ${String(IMAGE_MAX_COUNT)}. Defaults to 1; each one is billed separately. `
          + 'Some models can only produce one per call and will say so in the result rather than refusing.',
      },
      size: {
        type: 'string',
        enum: IMAGE_SIZES,
        description: 'Optional shape: square, landscape, or portrait respectively. '
          + 'Omit it unless the user asked for a shape, in which case pick the matching one. '
          + 'A model with no shape control of its own says so in the result instead of reinterpreting it.',
      },
      model: {
        type: 'string',
        // Deliberately free text rather than an enum: the servable set belongs
        // to the route and changes without a release here, so an enum would be
        // a list that goes stale in both directions. An unservable name is
        // refused by name at call time with the list of servable ones.
        description: 'Set this whenever the user named a specific image model, passing their name through verbatim — '
          + 'passing a name is always safe, because one this account cannot serve is refused by name with the list of '
          + 'servable ones, never substituted. Do not omit it because you are unsure the name exists: you have no list '
          + 'to check against, the check happens here, and omitting it draws with a model the user did not ask for. '
          + 'Leave it out only when the user named none, in which case the server-configured default is used.',
      },
      edit_last_image: {
        type: 'boolean',
        description: 'Set this when the user wants the newest picture in this conversation changed rather than a new one drawn — '
          + '"make the cat black", "remove the text", "same but at night". The prompt then describes the change, not the whole scene. '
          + 'Without it the picture is drawn from scratch and the result only resembles the original by luck, which is not what they asked for. '
          + 'Fails plainly if this conversation has no picture yet, or if the model cannot edit — it is never quietly turned into a fresh drawing.',
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
          // Which picture this call changed. The model cannot see either the
          // source or the result, so without this line it has no way to tell a
          // reader whether its own edit landed on the picture they meant.
          edited: { type: 'string' },
          // What this model's own transport had no field for. Reported after the
          // fact rather than refused up front: losing a picture over a shape
          // nobody promised is worse than drawing it and saying so.
          ignored: { type: 'array', items: { type: 'string' } },
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
      if (exec.parent !== undefined) {
        throw new ImageGenerationError(
          '图片生成必须直接调用 image_generate；Code Mode 的嵌套工具结果不会保存可回放的图片卡片元数据。',
        )
      }
      const count = args.n ?? 1
      // Every resolved model is checked against the live catalogue before the
      // paid request, and the check answers two questions at once: whether this
      // key can draw with the name at all, and which of the four transports it
      // is sold on. The delivery endpoint proves neither — it says the token may
      // call a name, not that the name accepts any particular image route.
      const named = typeof args.model === 'string' ? args.model.trim() : ''
      const access = await options.captureAccess?.() ?? options.access
      const catalog = await readImageCatalog(ctx, access, exec.signal)
      const editing = args.edit_last_image === true
      const model = named === '' ? defaultImageModel(catalog, deliveredModel(), editing) : named
      if (model === undefined) throw new ImageGenerationError(imageDefaultRefusal(catalog, editing))
      const resolved = resolveImageModel(catalog, model)
      if (resolved === undefined) throw new ImageGenerationError(imageModelRefusal(catalog, model))
      // Both checks happen before the paid request, and neither one falls back
      // to drawing. A user who asked for their picture to be changed and got a
      // different picture has been told a comfortable lie; being told plainly
      // that this model only draws is worth more than a result that looks right.
      const reference = editing
        ? await readLastImage(attachments, exec.agent?.session, resolved.canEdit, catalog, model)
        : undefined
      const outcome = await generateImages(ctx, access, resolved.provider, {
        model,
        prompt: args.prompt,
        count,
        ...args.size === undefined ? {} : { size: args.size },
        ...reference === undefined ? {} : { reference: reference.image },
      }, attachments.imageLimits.maxImageBytes, exec.signal)

      const saved: ToolImage[] = []
      const failures = [...outcome.failures]
      for (const [index, image] of outcome.images.entries()) {
        try {
          const ref = await attachments.saveImage({
            data: image.data,
            mediaType: image.mediaType,
            name: fileName(args.prompt, index, image.mediaType),
          })
          const normalized = await attachments.readImage(ref)
          const path = imageArtifactPath(args.prompt, String(ref.attachmentId), ref.mediaType)
          // Best-effort, and after the commit rather than instead of it: the
          // card is what shows this picture, so a machine that cannot take the
          // file copy loses the path this result would have quoted, not the
          // image. Reported as a per-image note for the same reason a refused
          // save is — silence would leave the model quoting a path that is not
          // there.
          const written = await writeArtifact(ctx, path, normalized.data)
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
        ...outcome.ignored.length === 0 ? {} : { ignored: [...outcome.ignored] },
        ...reference === undefined ? {} : { edited: reference.note },
        ...exec.agent?.session.header.origin === 'subagent' ? { delegated: true } : {},
      }
    },
    // These two titles are the fallback for a UI with no card of ours. The
    // desktop has one, and it carries its own copy in its own dictionary
    // (`client/media-locales.ts`), so changing the wording here alone changes
    // nothing a user sees — which is exactly how it was got wrong once.
    presentCall: (args) => {
      const call = args as { prompt?: unknown; edit_last_image?: unknown }
      const prompt = typeof call.prompt === 'string' ? call.prompt : ''
      return { card: 'generic', title: call.edit_last_image === true ? '修改图片' : '生成图片', rawInput: prompt }
    },
    presentResult: (args, result) => {
      const images = imagesOf(result.meta)
      // No metadata means a nested call under a composite transport (the
      // projection is computed for top-level calls only), where the text
      // content is the whole of what a reader gets anyway.
      if (result.isError || images.length === 0) return undefined
      const edited = (args as { edit_last_image?: unknown }).edit_last_image === true
      return {
        card: 'generic',
        title: `${edited ? '已改出' : '已生成'} ${String(images.length)} 张图片`,
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
  readonly ignored?: readonly string[]
  readonly edited?: string
  readonly delegated?: boolean
}

/** The reference picture an edit starts from, with the line the model reads. */
interface EditSource {
  readonly image: ImageReference
  readonly note: string
}

/**
 * Resolve the picture an edit changes, refusing before anything is paid for.
 *
 * The reference is not an argument, and cannot be: generated pictures are kept
 * out of model-visible content on purpose (see this module's header), so nothing
 * ever shows the model an attachment id to quote. It is found the same way the
 * video tool finds a first frame — the newest image in the session log, whether
 * the user attached it or `image_generate` drew it.
 *
 * Both refusals here are deliberate dead ends rather than fallbacks. Drawing
 * something new when the edit cannot happen would return a picture that is not
 * the one the user asked to have changed, and neither they nor the model can see
 * that it is the wrong one.
 * @param attachments - the store holding the bytes.
 * @param session - the calling agent's session; its log is the source of truth.
 * @param canEdit - whether the resolved model has an edit path at all.
 * @param catalog - the catalogue read, for naming the models that do.
 * @param model - the model this call resolved to.
 * @returns the reference bytes and the line describing them.
 * @throws {ImageGenerationError} when there is no picture, or no way to edit it.
 */
async function readLastImage(
  attachments: AttachmentStore,
  session: SessionEventSource | undefined,
  canEdit: boolean,
  catalog: ImageCatalog | undefined,
  model: string,
): Promise<EditSource> {
  if (!canEdit) throw new ImageGenerationError(imageEditRefusal(catalog, model))
  if (session === undefined) {
    throw new ImageGenerationError('这次调用不属于任何会话，取不到会话里的图片，无法改图。')
  }
  const found = findLatestImage(session)
  if (found === undefined) {
    // The last clause is not padding: without it a live run answered this by
    // globbing the filesystem, finding an unrelated PNG on the desktop, and
    // spending a `read_image` call to be told the session's chat model takes no
    // image input. Editing reads the conversation and nothing else, so saying so
    // here is what stops the search.
    throw new ImageGenerationError('这个对话里还没有图片，没有可以改的东西。先画一张，再说要改成什么样。'
      + '（改图只认这段对话里的图，磁盘上的文件找出来也用不上。）')
  }
  const stored = await attachments.readImage(found.ref)
  const origin = found.source === 'attached' ? '用户发的图' : '刚生成的图'
  return {
    image: { data: stored.data, mediaType: found.ref.mediaType },
    note: `改的是${origin}（${String(found.ref.width)}x${String(found.ref.height)} ${found.ref.mediaType}）。`,
  }
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
  const verb = value.edited === undefined ? '生成' : '改出'
  const head = value.delegated === true
    ? `已用 ${value.model} ${verb} ${count} 张图片。`
      + '**你是被派活的成员，这些图只出现在你自己这条会话里，用户和主理人都看不到。**'
      + `把上面每一行的文件路径原样写进你的汇报，并请主理人用 ${IMAGE_SHOW_TOOL_NAME} 展示给用户；`
      + '路径写漏了这些图就等于没出。你自己也看不到图片内容，不要描述或评价它。'
    : `已用 ${value.model} ${verb} ${count} 张图片，已直接展示在对话中，用户可以看到；`
      + '你自己看不到图片内容，不要描述或评价它。'
  const tail = value.failures === undefined || value.failures.length === 0
    ? []
    : ['未能取回的部分：', ...value.failures]
  // Stated plainly and separately from failures, because it is neither an error
  // nor something to retry: the pictures are there, one of the asks was not
  // honoured, and only the user can decide whether that matters.
  const notes = value.ignored === undefined || value.ignored.length === 0
    ? []
    : ['这个模型没能照办的部分（图已经出了，如果这点要紧就换个模型重来）：', ...value.ignored]
  // Which picture was changed, said before the per-image lines: an edit that
  // landed on the wrong source looks exactly like a successful one from here,
  // and this sentence is the only thing that lets anyone notice.
  const source = value.edited === undefined ? [] : [value.edited]
  return [head, ...source, ...lines, ...tail, ...notes].join('\n')
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
