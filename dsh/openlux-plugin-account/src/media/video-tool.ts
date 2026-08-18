/**
 * The model-facing video tool.
 *
 * ## Why this one is a background job when the image tool is not
 *
 * A picture on this route lands in 10–15 seconds; a clip takes 45 seconds to six
 * minutes (100s and 118s measured today on the default model, 318s on the
 * slowest vendor this product has shipped). Holding a conversation turn open
 * that long is exactly what the kernel's job registry exists to avoid, and it is
 * how the kernel's own long work behaves: `tool-bash` hands a background command
 * to `ctx.jobs` and answers with the id (`dsh-tool-bash`, `run_in_background`).
 *
 * What that buys, all of it already built:
 *
 * - The session header lists the running job (`dsh-client-ui-jobs`), so the user
 *   can see it is alive without asking.
 * - `tool-jobs` delivers the completion: injected into a busy owner's next step,
 *   or opening a turn on an idle one. So the model gets told the clip is ready
 *   without polling, and `job_output` lets it wait on purpose when the user
 *   asked it to.
 * - `job_kill` cancels it. Our hooks abort the in-flight request, so a cancelled
 *   job stops paying for a clip nobody will watch.
 *
 * The registry refuses to start work for an owner no controller serves, which
 * means this tool needs `tool-jobs` in the agent's own composition. Every preset
 * this product ships carries it; a composition without it gets a refusal naming
 * what is missing rather than a silently synchronous five-minute call.
 *
 * ## Why the artifact is a file rather than an attachment
 *
 * The attachment store is images only — its `ImageMediaType` has no video
 * member and its reader decodes what it stores — so video bytes have nowhere to
 * go inside it. The kernel's answer for a produced file is the deliverables row:
 * a successful call whose view declares `kind:'edit'` with a location publishes
 * that path for the turn, and clicking it hands the path to the host's own
 * opener (`host.openPath` → the OS default player). No plugin of ours draws it.
 *
 * That row reads the **call** view, not the result view, and a call view is
 * computed from the arguments alone because replay calls it again
 * (`dsh-tools`, `presentCall`). So the destination path must be derivable from
 * the arguments: {@link videoArtifactPath} is that derivation, and the job
 * writes exactly where the card already said it would.
 *
 * @module openlux-plugin-account/media/video-tool
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { JobHooks, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ConsoleAccess } from '../market/console.ts'
import { size } from './images.ts'
import { VIDEO_TOOL_NAME } from './name.ts'
import { generateVideo, VideoGenerationError } from './video.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    /** One text-to-video generation: submit, wait for the vendor, save the file. */
    video: 'video'
  }
}

/**
 * The model this tool films with unless the composition names another.
 *
 * Picked the way the image default was: from what this route actually serves
 * today, not from what the catalog lists. Two live runs landed in 100 and 118
 * seconds at 1280x720 for 2.3 and 3.5 MB, and a Chinese prompt came back as
 * exactly what it described, which is the one thing this product cannot do
 * without.
 *
 * The model never chooses this. Which vendors have a channel is a deployment
 * fact it cannot see, and a name without one is a refusal the user waits for.
 */
export const DEFAULT_VIDEO_MODEL = 'veo_3_1-fast'

/** What each servable model accepts. */
interface VideoModelSpec {
  /** Clip lengths the route accepts, in seconds. */
  readonly durations: readonly number[]
  /** Frame shapes the route accepts. */
  readonly aspects: readonly string[]
}

/**
 * The models this tool knows how to ask for, and what each one takes.
 *
 * Both fields are enums rather than free numbers for the reason the image tool
 * learned the hard way: an unlisted value is not refused quickly, it is refused
 * after the user has waited, or accepted and quietly reinterpreted. The
 * durations are the set this family has answered on (`4/6/8`, echoed back in
 * `detail.input` on a live submit); the shapes are the two the route's own
 * published contract names ("16:9" 或 "9:16").
 *
 * A deployment adopting another vendor adds its row here, because a model and
 * its accepted values are one fact.
 */
const ROUTE_MODELS: Record<string, VideoModelSpec> = {
  'veo_3_1-fast': { durations: [4, 6, 8], aspects: ['16:9', '9:16'] },
  'veo_3_1': { durations: [4, 6, 8], aspects: ['16:9', '9:16'] },
}

const description = 'Generate a short video from a text prompt. '
  + 'The work runs in the background: this returns a job id immediately, and you are told when the clip is ready — '
  + 'so answer the user that it is running (one to six minutes is normal) instead of waiting in silence. '
  + 'Use job_output with wait only if the user explicitly asked you to wait for it. '
  + 'Write the prompt as one self-contained shot description: subject, action, camera, setting, light, mood. '
  + 'The video model sees only this text, not the conversation, and Chinese prompts work as they are. '
  + 'The finished file is saved locally and shown to the user as a produced file they can open; '
  + 'you never see the video itself, so do not describe or judge what is in it.'

/** What the tool reads out of its own composition. */
export interface VideoToolOptions {
  /** Route origin and token reader, shared with the account face. */
  readonly access: ConsoleAccess
  /** Model to film with; the default is a route-verified one. */
  readonly model?: string
}

/** The arguments this tool's path derivation depends on. */
export interface VideoArgs {
  readonly prompt: string
  readonly aspect_ratio?: string
  readonly duration?: number
}

/**
 * Where one request's clip will be written.
 *
 * Pure in its inputs, because the produced-files row is drawn from the call view
 * and the call view is recomputed on replay. The digest covers everything that
 * changes the output, so asking for the same clip twice reuses one slot (the
 * second run overwrites the first) while any changed argument gets its own file.
 * @param model - the model the composition films with; part of the identity.
 * @param args - the call's arguments.
 * @returns an absolute path under the harness home.
 */
export function videoArtifactPath(model: string, args: VideoArgs): string {
  const identity = JSON.stringify([model, args.prompt, args.aspect_ratio ?? '', args.duration ?? ''])
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 12)
  return join(dshHomePath('media', 'video'), `${stem(args.prompt)}-${digest}.mp4`)
}

/**
 * Register the video tool, when this composition has what it needs.
 *
 * The tool runtime is read opportunistically, like the image tool's: the account
 * face must mount in a composition that carries no tools at all, and a missing
 * one should cost this tool rather than sign-in and balance. The job registry is
 * *not* checked here — a composition can mount the registry per agent, so the
 * question is only answerable at call time.
 * @param ctx - host context; the registration follows this fiber's lifetime.
 * @param options - route access and the model to film with.
 */
export function registerVideoTool(ctx: Context, options: VideoToolOptions): void {
  const tools = ctx.get('tools')
  if (tools === undefined) {
    ctx.logger.debug('openlux: no tool runtime in this composition; the video tool stays unregistered')
    return
  }
  const configured = options.model ?? DEFAULT_VIDEO_MODEL
  if (ROUTE_MODELS[configured] === undefined) {
    ctx.logger.warn(`openlux: video model "${configured}" has no known parameter set; filming with ${DEFAULT_VIDEO_MODEL} instead`)
  }
  const model = ROUTE_MODELS[configured] === undefined ? DEFAULT_VIDEO_MODEL : configured
  const route = ROUTE_MODELS[model] ?? ROUTE_MODELS[DEFAULT_VIDEO_MODEL]!

  ctx.effect(() => tools.register(defineTool({
    name: VIDEO_TOOL_NAME,
    description,
    // Each call starts its own vendor task and writes its own path, so two
    // different clips may be asked for at once.
    isConcurrencySafe: () => true,
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'The shot to film, as one self-contained description. The video model sees only this text.',
      },
      aspect_ratio: {
        type: 'string',
        enum: route.aspects,
        description: 'Frame shape. Defaults to 16:9; use 9:16 for a portrait clip.',
      },
      duration: {
        type: 'integer',
        enum: route.durations,
        description: `Clip length in seconds (${route.durations.join(' / ')}). Defaults to ${String(route.durations[0])}; longer clips cost more and take longer.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: { type: 'string', required: true },
          path: { type: 'string', required: true },
          model: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const { jobId, path, model: used } = value as { jobId: string; path: string; model: string }
        return [{
          type: 'text',
          text: `视频任务已在后台开始（${jobId}，模型 ${used}），一般 1~6 分钟出片，完成后会通知你。\n`
            + `产物会写到：${path}\n`
            + '现在先告诉用户正在生成，不要空等；用户明确要求等结果时才用 job_output 等待。\n'
            + '出片后你自己看不到画面内容，不要描述或评价它。',
        }]
      },
    },
    execute: (args, exec) => {
      const jobs = ctx.get('jobs')
      if (jobs === undefined) {
        throw new VideoGenerationError('这个会话没有后台任务能力（需要 @deepseek-ai/dsh-jobs 与 dsh-tool-jobs），无法生成视频。')
      }
      const path = videoArtifactPath(model, args)
      const jobId = jobs.start({
        kind: 'video',
        label: `${VIDEO_TOOL_NAME}: ${args.prompt.slice(0, 80)}`,
        ...exec.agent === undefined ? {} : { owner: exec.agent },
        run: () => filmInBackground(ctx, options.access, {
          model,
          prompt: args.prompt,
          ...args.aspect_ratio === undefined ? {} : { aspectRatio: args.aspect_ratio },
          ...args.duration === undefined ? {} : { durationSeconds: args.duration },
        }, path),
      })
      return Promise.resolve({ jobId: String(jobId), path, model })
    },
    presentCall: (args) => {
      const call = args as VideoArgs
      return {
        card: 'generic',
        // `edit` is what publishes the location to the turn's produced-file row
        // (`dsh-client-ui-deliverables`: a mutation is recognized by render
        // intent, not by tool name). A clip is a file this call brings into
        // existence, which is exactly what that row is for.
        kind: 'edit',
        title: '生成视频',
        rawInput: call.prompt,
        locations: [{ path: videoArtifactPath(model, call) }],
      }
    },
  })), 'openlux: video tool')
}

/**
 * Start one generation and hand the registry its hooks.
 *
 * Synchronous by contract: the registry calls this once and expects the control
 * surface back immediately, so the work is kicked off and observed through the
 * promise. `done` must never reject — a rejection would be converted to a bare
 * `failed` with the reason lost — so every outcome is caught and turned into a
 * status the model can read.
 * @param ctx - host context.
 * @param access - route origin and token reader.
 * @param request - what to generate.
 * @param path - where the finished clip goes; already announced by the call view.
 * @returns the registry's control hooks.
 */
function filmInBackground(
  ctx: Context,
  access: ConsoleAccess,
  request: Parameters<typeof generateVideo>[2],
  path: string,
): JobHooks {
  const stop = new AbortController()
  const startedAt = Date.now()
  let pending = ''
  const write = (line: string): void => {
    pending += `[${String(Math.round((Date.now() - startedAt) / 1000))}s] ${line}\n`
  }

  const done = (async (): Promise<JobOutcome> => {
    try {
      const video = await generateVideo(ctx, access, request, (status, percent) => {
        write(percent === undefined ? status : `${status} ${String(percent)}%`)
      }, stop.signal)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, video.data)
      const facts = [size(video.data.byteLength), video.size, video.seconds === undefined ? undefined : `${String(video.seconds)}s`]
        .filter(fact => fact !== undefined)
        .join(' · ')
      write(`已保存：${path}（${facts}）`)
      write('用户可以在这一轮的产出文件里点开它；你看不到画面内容，不要描述。')
      return { status: 'completed', detail: facts }
    } catch (error: unknown) {
      if (stop.signal.aborted) {
        write('已取消，未产生文件。')
        return { status: 'killed', detail: '已取消' }
      }
      const message = error instanceof Error ? error.message : String(error)
      write(`失败：${message}`)
      return { status: 'failed', detail: message.slice(0, 160) }
    }
  })()

  return {
    cancel: () => stop.abort(),
    done,
    readOutput: () => {
      const text = pending
      pending = ''
      return text
    },
  }
}

/**
 * A readable leading part of the file name.
 *
 * The digest already makes the name unique, so this only has to help a human
 * recognise the file in a player's recent list — hence the length cap and the
 * conservative character set (a path is what this becomes).
 * @param prompt - the request's prompt.
 * @returns a file-name-safe stem, never empty.
 */
function stem(prompt: string): string {
  const cleaned = prompt.replace(/\s+/gu, '-').replace(/[^\p{L}\p{N}-]/gu, '').slice(0, 24)
  return cleaned === '' ? 'video' : cleaned
}
