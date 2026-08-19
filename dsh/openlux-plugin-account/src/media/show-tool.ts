/**
 * Putting a picture that already exists in front of the user.
 *
 * ## What this is for
 *
 * One thing, and it is not a convenience: it is the only way a delegated
 * member's picture can reach the person who asked for it. A member draws inside
 * its own session, the card renders in a transcript nobody is looking at, and
 * the kernel hands the lead the child's final *text* and nothing else
 * (`dsh-tool-subagent`: "intermediate child steps stay out of the parent").
 * Since the produced-file row is folded per Turn from that Turn's own call views
 * (`dsh-client-ui-deliverables`), the parent's conversation cannot inherit the
 * child's artifact either. So the picture gets back only if something *in the
 * parent's conversation* presents it — this tool, given the path the member
 * reported (`media/artifact.ts` writes it and says why).
 *
 * It also answers a question the window could not answer before: a local image
 * the user names cannot be dropped into the composer, because attachment
 * admission requires the session's model to declare image input and this
 * product's route ships text-only chat models. Showing it through a card sends
 * nothing to the model, so it works regardless.
 *
 * ## Why the bytes are re-committed rather than referenced
 *
 * The store admits images by content: `saveImage` decodes them, enforces this
 * deployment's limits, and returns a reference the reader verifies field by
 * field. Handing those bytes back through it is therefore both the validation
 * and the authorization — an unreadable, oversized, or non-image file is refused
 * by the same code that refuses one at generation time, and a file that is
 * already in the store re-commits to the object it already has, because the
 * digest is the address. Reconstructing a reference from a path by hand would
 * mean re-implementing that check, which is exactly the fence `media/read.ts`
 * relies on.
 *
 * @module openlux-plugin-account/media/show-tool
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { describeImage, imageBlocks, imagesOf, TOOL_IMAGE_PROPERTIES, type ToolImage } from './card.ts'
import { size, sniffImageType } from './images.ts'
import { IMAGE_SHOW_TOOL_NAME, IMAGE_TOOL_NAME } from './name.ts'

export { IMAGE_SHOW_TOOL_NAME } from './name.ts'

/**
 * Files one call may show.
 *
 * A bound rather than a schema constraint, because array specs carry no item
 * count (`dsh-tools`' value schema has `items` and no `minItems`/`maxItems`), so
 * this is refused at call time with the count that arrived. It is generous on
 * purpose: a member that drew four pictures twice reports eight paths, and
 * splitting that across calls is work with no reader-visible benefit.
 */
const MAX_PATHS = 8

/** Raised when nothing could be shown; the message is model-facing. */
class ImageShowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageShowError'
  }
}

const description = 'Show local image files to the user in this conversation. '
  + 'This displays pictures that already exist; it generates nothing, costs nothing, and takes no prompt. '
  + 'Use it above all for a picture a delegated member produced: a member draws inside its own transcript, '
  + 'which the user is not looking at, and only its text reaches you — so pass the file paths it reported and the pictures appear here. '
  + `It also works for any image file on this machine, and for one ${IMAGE_TOOL_NAME} saved earlier in another conversation. `
  + 'The result you receive is text only: you still cannot see the images, so do not describe their content as if you had.'

/**
 * Register the show tool, when this composition has what it needs.
 *
 * Both services are read opportunistically for the reason the generation tool
 * reads them that way: the account face must mount where neither exists, and a
 * missing one should cost this tool rather than sign-in and balance.
 * @param ctx - host context; the registration follows this fiber's lifetime.
 */
export function registerImageShowTool(ctx: Context): void {
  const tools = ctx.get('tools')
  const attachments = ctx.get('attachments')
  if (tools === undefined || attachments === undefined) {
    ctx.logger.debug('openlux: no tool runtime or attachment store in this composition; the image show tool stays unregistered')
    return
  }

  ctx.effect(() => tools.register(defineTool({
    name: IMAGE_SHOW_TOOL_NAME,
    description,
    // Each call reads files and commits content-addressed objects, mutating
    // nothing a sibling call can observe.
    isConcurrencySafe: () => true,
    parameters: {
      paths: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Absolute paths of the image files to show, in the order they should appear. '
          + 'A relative path is resolved against this session\'s working directory. PNG, JPEG, WebP, and GIF.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
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
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderText(value as ToolValue) }],
      // Same route as the generation tool's, and for the same reason: the card
      // is recomputed per delivery, so the references it renders have to
      // survive in the log's own projection.
      presentationMeta: (_args, value) => ({ images: (value as ToolValue).images.map(image => ({ ...image })) }),
    },
    async execute(args, exec) {
      const paths = args.paths
      if (paths.length === 0) throw new ImageShowError('没有给出任何图片路径。')
      if (paths.length > MAX_PATHS) {
        throw new ImageShowError(`一次最多展示 ${String(MAX_PATHS)} 张，这次给了 ${String(paths.length)} 个路径。`)
      }
      const cwd = exec.agent?.session.header.cwd

      const shown: ToolImage[] = []
      const failures: string[] = []
      for (const raw of paths) {
        const given = raw.trim()
        if (given === '') {
          failures.push('有一个空路径，跳过了。')
          continue
        }
        // Resolved against the session's own directory rather than this
        // process's: the chat view resolves a produced file's relative path the
        // same way, and the process cwd is not a place any model knows about.
        if (!isAbsolute(given) && cwd === undefined) {
          failures.push(`${given}：这是相对路径，而这次调用不属于任何工作目录，请给绝对路径。`)
          continue
        }
        const path = isAbsolute(given) ? given : resolve(cwd ?? '', given)
        try {
          shown.push(await show(attachments, path, exec.signal))
        } catch (error: unknown) {
          failures.push(`${path}：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (shown.length === 0) {
        throw new ImageShowError(`一张也没能展示。\n${failures.join('\n')}`)
      }
      return { images: shown, ...failures.length === 0 ? {} : { failures } }
    },
    presentCall: args => ({
      card: 'generic',
      title: '展示图片',
      rawInput: (args as { paths?: readonly string[] }).paths?.join('\n') ?? '',
    }),
    presentResult: (_args, result) => {
      const images = imagesOf(result.meta)
      if (result.isError || images.length === 0) return undefined
      return {
        card: 'generic',
        title: `已展示 ${String(images.length)} 张图片`,
        content: imageBlocks(images),
      }
    },
  })), 'openlux: image show tool')
}

/** The tool's canonical value. */
interface ToolValue {
  readonly images: readonly ToolImage[]
  readonly failures?: readonly string[]
}

/**
 * Commit one file into the store and describe what a card will show.
 *
 * The size is checked before the store is asked, because this is the one refusal
 * whose reason a reader can act on: the deployment's cap and the file's own size
 * are both worth saying, and the store's own message names neither.
 * @param attachments - the durable store.
 * @param path - absolute path of the image file.
 * @param signal - caller cancellation, honoured around the read.
 * @returns the image, as the value and the card carry it.
 */
async function show(
  attachments: AttachmentStore,
  path: string,
  signal?: AbortSignal,
): Promise<ToolImage> {
  const data = await readFile(path, { signal })
  const limit = attachments.imageLimits.maxImageBytes
  if (data.byteLength > limit) {
    throw new Error(`${size(data.byteLength)}，超过本机上限 ${size(limit)}。`)
  }
  const mediaType = sniffImageType(data)
  if (mediaType === undefined) {
    throw new Error('不是 PNG / JPEG / WebP / GIF 图片文件。')
  }
  const ref = await attachments.saveImage({
    data,
    mediaType,
    name: path.split(/[/\\]/u).pop() ?? 'image',
  })
  return {
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    path,
  }
}

/**
 * The model-facing text for one completed call.
 *
 * It says the pictures are visible, which is the whole point of the call, and it
 * repeats that the model cannot see them — a model handed a path it did not
 * generate is especially prone to describing the contents it imagines.
 * @param value - the canonical value.
 * @returns the content text.
 */
function renderText(value: ToolValue): string {
  const lines = value.images.map((image, index) => describeImage(image, index))
  const head = `已把 ${String(value.images.length)} 张图片展示在对话中，用户可以看到；`
    + '你自己看不到图片内容，不要描述或评价它。'
  const tail = value.failures === undefined || value.failures.length === 0
    ? []
    : ['没能展示的部分：', ...value.failures]
  return [head, ...lines, ...tail].join('\n')
}
