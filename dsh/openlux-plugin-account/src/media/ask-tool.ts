/**
 * The model-facing "have somebody look at this picture" tool.
 *
 * A text-only chat model handed an image path has, without this, exactly two
 * honest moves: refuse, or open the file with a shell and describe the bytes.
 * Both are what the user did not ask for. This gives it a third: pass the path
 * here, and a model that can see answers in words.
 *
 * Why it takes a *path* rather than a conversation attachment: a picture the
 * kernel admitted into the conversation is already on a route that accepts
 * images, so the caller could see it itself. The case this exists for is the
 * other one — the composer's file button hands over a path precisely because the
 * running model cannot take the picture (`client/AttachFileButton.tsx`), and a
 * path is then the only form the picture has.
 *
 * Everything about choosing the model, and why the answer comes back as text,
 * lives in {@link ./vision.ts}.
 *
 * @module openlux-plugin-account/media/ask-tool
 */

import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ConsoleAccess } from '../market/console.ts'
import { sniffImageType } from './images.ts'
import { IMAGE_ASK_TOOL_NAME } from './name.ts'
import { imageCapableModels, lookAtImage, VisionError } from './vision.ts'

export { IMAGE_ASK_TOOL_NAME } from './name.ts'

/**
 * Ceiling for one picture, in bytes.
 *
 * Two limits sit above this and neither is ours to discover at call time: the
 * relay's request body, and the vendor's own per-image cap (DeepSeek publishes
 * 32 MiB inline, and base64 inflates the body by a third on the way). Refusing
 * here with the real size is more useful than a gateway's 413, and 16 MiB is
 * well above every camera JPEG and screenshot this tool is actually handed.
 */
const MAX_LOOK_BYTES = 16 * 1024 * 1024

/** Above `vision.ts`'s own request budget, so that deadline reports first. */
const TOOL_TIMEOUT_MS = 170_000

/** What to ask when the caller does not say. */
const DEFAULT_QUESTION = '描述这张图：主体、场景、构图，以及画面上出现的所有文字（原样抄写）。'

const description = 'Look at a local image file by having it read by a model that can see, and get a text answer back. '
  + 'Use this whenever the user hands you an image path and you cannot view images yourself — do not open it with a shell, '
  + 'and do not ask the user to describe it. Ask a specific question when you have one (what does the sign say, '
  + 'which row is highlighted, is the chart rising); the default is a full description. '
  + 'The picture is not added to this conversation and you still cannot see it: what you receive is the other model\'s words. '
  + 'Answer from them, and ask again for anything they do not cover — but never claim to have seen the picture yourself, '
  + 'and keep this machinery out of your reply: no file path, no mention of this tool or of which model looked.'

/** What the tool reads out of its own composition. */
export interface ImageAskOptions {
  /** Route origin and token reader, shared with the account face. */
  readonly access: ConsoleAccess
}

/** What one call returns to the model. */
interface ToolValue {
  readonly answer: string
  readonly model: string
}

/**
 * Register the ask tool, when this composition has a tool runtime.
 *
 * Read opportunistically for the reason every other tool here is: the account
 * face must mount in compositions that run no tools, and a missing runtime
 * should cost this tool rather than sign-in and balance.
 * @param ctx - host context; the registration follows this fiber's lifetime.
 * @param options - route access.
 */
export function registerImageAskTool(ctx: Context, options: ImageAskOptions): void {
  const tools = ctx.get('tools')
  if (tools === undefined) {
    ctx.logger.debug('openlux: no tool runtime in this composition; the image ask tool stays unregistered')
    return
  }

  ctx.effect(() => tools.register(defineTool({
    name: IMAGE_ASK_TOOL_NAME,
    description,
    timeoutMs: TOOL_TIMEOUT_MS,
    // One read of one file plus one request; nothing a sibling call observes.
    isConcurrencySafe: () => true,
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute path of the image file. A relative path is resolved against this session\'s '
          + 'working directory. PNG, JPEG, WebP, and GIF.',
      },
      question: {
        type: 'string',
        description: 'What you want to know about the picture. Defaults to a full description including any text in it.',
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
        return [{ type: 'text', text: `${model} 看过这张图后说：\n\n${answer}` }]
      },
    },
    async execute(args, exec) {
      const given = args.path.trim()
      if (given === '') throw new VisionError('没有给出图片路径。')
      const cwd = exec.agent?.session.header.cwd
      if (!isAbsolute(given) && cwd === undefined) {
        throw new VisionError(`${given}：这是相对路径，而这次调用不属于任何工作目录，请给绝对路径。`)
      }
      const path = isAbsolute(given) ? given : resolve(cwd ?? '', given)

      // Size before bytes: a file this cannot send should not be read into
      // memory first, and the refusal names the real number either way.
      const info = await stat(path).catch((error: unknown) => {
        throw new VisionError(`打不开 ${path}：${error instanceof Error ? error.message : String(error)}`)
      })
      if (!info.isFile()) throw new VisionError(`${path} 不是一个文件。`)
      if (info.size > MAX_LOOK_BYTES) {
        throw new VisionError(`${path} 有 ${megabytes(info.size)}，超过一次读图的上限 ${megabytes(MAX_LOOK_BYTES)}。`)
      }
      const data = await readFile(path)
      // The format decides whether this can be sent at all, and a file name is
      // not evidence of it — the same rule the generated-image path follows.
      const mediaType = sniffImageType(data)
      if (mediaType === undefined) {
        throw new VisionError(`${path} 不是 PNG / JPEG / WebP / GIF 图片，读图这条路只认这四种格式。`)
      }

      const capable = imageCapableModels(ctx)
      const model = capable[0]
      if (model === undefined) {
        // Nothing local can fix this, and the operator's console is where it is
        // fixed, so the refusal says that instead of naming a model we wish for.
        throw new VisionError('当前账号下没有能读图的模型可用：模型清单里没有一个标着可以收图。'
          + '请在管理端的模型下发里放一个支持图片输入的对话模型，或改用能读图的模型继续。')
      }
      const outcome = await lookAtImage(ctx, options.access, {
        data,
        mediaType,
        question: args.question?.trim() === undefined || args.question.trim() === ''
          ? DEFAULT_QUESTION
          : args.question.trim(),
        model,
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
