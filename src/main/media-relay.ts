import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gatewayClient } from './gateway-client'
import { MEDIA_TASK_ENVELOPE_TAG } from '@shared/relay-envelope'

/**
 * 媒体后台任务的完成投递中继（出图 / 出视频 / 出音乐）。
 *
 * # 要复现的结果
 *
 * 用户在界面里说「帮我画一张图」，图出来之后要出现在这条对话里 —— 就这一件事。
 *
 * # 为什么必须我们自己接
 *
 * 会话里的媒体一律走后台任务（`shouldDetachMediaGenerationTask` 只要有 sessionKey 就 detach，
 * `openclaw/src/agents/tools/media-generate-background-shared.ts:83-86`，**没有同步旋钮**），
 * 完成后由内核投递回请求方会话。而那条投递走的是 `deliverSubagentAnnouncement`（同文件 586 行）,
 * 与成员播报同一条路，在我们的 `acp:` 会话上必然失败：
 *  - direct 走网关 `agent` RPC，要过 ACP 解析，而我们的会话是 `sessions.create` 造的、
 *    没有 ACP metadata，被判 stale 直接抛（`agents/agent-command.ts` 那句 `acpResolution?.kind === "stale"`）；
 *  - steer 要求这一轮还活着，而模型调完工具就 yield 了；
 *  - 内核自带的 `tryDeliverMediaGenerationDirect` 兜底救不了我们：它第一行就要求有可投递的
 *    **消息频道**（同文件 671 行的 `origin.channel` + `to`），桌面端没有频道。
 *
 * 2026-08-13 真机复现两次（出图、出视频各一次）：产物真出了（1.5 MB PNG / 1.05 MB MP4 落在
 * `~/.openclaw/media/tool-*-generation/`），任务终态却是
 * `Required completion delivery failed before reaching the requester`，对话里五分钟后仍然空白，
 * 用户只看到一句「本轮回复已中断」。**升级不解**：最新 tag（v2026.7.1-2）上这三处
 * —— 媒体投递、`acp stale → throw`、`supportsSpawnLineage` 只认 `subagent:*`/`acp:*` ——
 * 与我们这版逐字相同，`config` 里也没有新增旋钮。
 *
 * # 形状照 team-relay，不是自己发明的路
 *
 * `chat.send` 与内核 direct 走的不是同一条：它是用户平时说话那条，不碰 ACP，对早已 yield 的
 * 会话照样能唤醒（`team-relay.ts` 里那条成员产出回传 2026-08-11 已端到端验过）。
 * 所以这里也是「拿 `chat.send` 补一条内核想做而做不成的投递」。
 *
 * # 关联从哪来
 *
 * 出片的 provider 是我们自己的插件，但它的请求里**没有 taskId、没有 sessionKey**
 * （`openclaw/src/video-generation/types.ts:62-83`），自己对不上人。所以映射由 persona 插件的
 * `after_tool_call` 钩子在**提交那一刻**记下（那个钩子的 ctx 里有 sessionKey、事件里有
 * `details.taskId`），一任务一个 JSON 文件落在 `~/.openclaw/yunwu-media-tasks/`。
 * 这里 `fs.watch` 那个目录（push）+ 启动时全量扫一遍（兜住应用没开着时完成的任务）——
 * 就是产业那套「push 通知 + 拉取状态」：通知只说「有事发生」，状态一律回 `tasks.get` 拉。
 */

/** 插件写记账文件的目录（写它的是内核进程，所以在 `~/.openclaw` 下，不是应用 userData）。 */
const TASK_DIR = join(homedir(), '.openclaw', 'yunwu-media-tasks')

/** 各媒体工具的产物目录（内核写盘的位置）。 */
const MEDIA_DIRS: Record<string, string> = {
  image_generate: 'tool-image-generation',
  video_generate: 'tool-video-generation',
  music_generate: 'tool-music-generation'
}

/** 中文名，只用于给用户看的文案。 */
const TOOL_LABELS: Record<string, string> = {
  image_generate: '图片',
  video_generate: '视频',
  music_generate: '音乐'
}

/**
 * 轮询间隔。这不是「打上游」的频率 —— `tasks.get` 读的是网关本地的任务台账（SQLite），
 * 一次几毫秒，且只在有活跃任务时轮。产物出现的延迟等于这个间隔，媒体任务本身要 25 秒到 5 分钟，
 * 2 秒是噪声级。（Sora 那种打公网的状态端点官方建议 10~20 秒，判据不同，别照搬。）
 */
const POLL_MS = 2_000

/** 单个任务最长跟多久。视频最慢的一家实测 5.5 分钟，留足余量后放弃，免得永久占着一条轮询。 */
const MAX_TRACK_MS = 20 * 60_000

/** 任务查不到时容忍几次（台账刚落盘可能有短暂空窗）。 */
const MAX_MISSES = 5

/** 产物 mtime 匹配的宽容窗口：任务结束前后各放这么多毫秒。 */
const MTIME_SLACK_MS = 15_000

type MediaTaskRecord = {
  taskId: string
  tool: string
  sessionKey: string
  agentId?: string
  runId?: string
  status?: string
  existingTask?: boolean
  prompt?: string
  model?: string
  recordedAt: number
  /** 我们已经投过了。写在删文件之前，防「投完还没删就崩」导致重投。 */
  handledAt?: number
}

type TaskSnapshot = {
  status?: string
  terminalSummary?: string
  progressSummary?: string
  startedAt?: number
  endedAt?: number
  createdAt?: number
}

/**
 * 内核标记「产物出了但投递没成」的那句话（`tasks/task-completion-contract.ts:91-92`）。
 *
 * **判据只能取这句文本,不能取 `terminalOutcome`** —— 台账里确实有那个字段(`blocked`),
 * 但网关的 `mapTaskSummary` 一个都不往外发(`gateway/server-methods/tasks.ts:72-94` 的白名单里
 * 没有它)。2026-08-13 第一版就是照 `terminalOutcome === 'blocked'` 判的,真机上它永远是
 * undefined,于是每次都判成「内核已投成」直接放过 —— 进度卡照常出、补投一次没发生,
 * 而且这条静默分支不打日志,查了一轮才看出来。
 */
const DELIVERY_FAILED_RE = /delivery failed before reaching the requester/i

/** 产物已生成但没送到请求方。 */
function deliveryFailed(task: TaskSnapshot): boolean {
  return DELIVERY_FAILED_RE.test(String(task.terminalSummary ?? ''))
}

/** 给渲染层的进度态。一条会话同时最多一个媒体任务（duplicateGuard 是按工具+provider 锁的）。 */
export type MediaTaskProgress = {
  sessionKey: string
  taskId: string
  tool: string
  /** 用户可读的中文名：图片 / 视频 / 音乐。 */
  label: string
  phase: 'running' | 'delivering' | 'done' | 'failed'
  startedAt: number
  /** 失败原因（phase=failed 时给），已是可以直接显示的中文。 */
  error?: string
}

const ACTIVE_STATUSES = new Set(['running', 'queued', 'pending', 'started'])

/** 只修「内核投不到」的那一档。`agent:main:main` 这类键内核自己投得成，插手就会投两遍。 */
function needsRelay(sessionKey: string): boolean {
  return sessionKey.includes(':acp:')
}

function readRecord(file: string): MediaTaskRecord | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as MediaTaskRecord
    return raw && typeof raw.taskId === 'string' && typeof raw.sessionKey === 'string' ? raw : null
  } catch {
    return null
  }
}

function markHandled(file: string, record: MediaTaskRecord): void {
  try {
    writeFileSync(file, JSON.stringify({ ...record, handledAt: Date.now() }), 'utf-8')
  } catch {
    /* 标记失败就退回「可能重投一次」，比丢投递好 */
  }
}

function dropRecord(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch {
    /* 下一轮扫描还会碰到它，无所谓 */
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 找这一轮的产物。
 *
 * 台账里那句 `terminalSummary` 带着完整路径，但网关把它**截到 120 字符**才发出来
 * （`gateway/server-methods/tasks.ts` 的 `TASK_STATUS_DETAIL_MAX_CHARS`），路径正好被砍在中间，
 * 所以只能自己在产物目录里按时间窗认。
 *
 * 这样认是安全的：媒体工具的 duplicateGuard 按「工具 + provider」锁（2026-08-13 实测：
 * 我拿不同 model 连提四家，后三发都被并进了前一发的任务），所以同一时刻同一目录里
 * 不会有第二个任务在写文件。
 */
function findArtifacts(tool: string, task: TaskSnapshot): string[] {
  const sub = MEDIA_DIRS[tool]
  if (!sub) {
    return []
  }
  const dir = join(homedir(), '.openclaw', 'media', sub)
  if (!existsSync(dir)) {
    return []
  }
  const from = (task.startedAt ?? task.createdAt ?? 0) - MTIME_SLACK_MS
  const to = (task.endedAt ?? Date.now()) + MTIME_SLACK_MS
  try {
    return readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((path) => {
        try {
          const at = statSync(path).mtimeMs
          return at >= from && at <= to
        } catch {
          return false
        }
      })
      .sort()
  } catch {
    return []
  }
}

/**
 * 唤醒会话的那条消息。
 *
 * 形状照内核自己那条投递的意图：它给模型的 `replyInstruction` 就是「按当前可见回复约定把产物
 * 交给用户、用结构化媒体字段附上」（`media-generate-background-shared.ts` 的
 * `buildMediaGenerationReplyInstruction`），所以这里把同样的要求写清楚，并明确禁止再调一次工具
 * —— 不写这句，模型看到「任务完成」很容易再提交一单（额度是真花出去的）。
 */
function completionMessage(params: {
  label: string
  tool: string
  paths: string[]
  prompt?: string
}): string {
  const list = params.paths.length
    ? params.paths.map((p) => `- ${p}`).join('\n')
    : '（产物路径未能确认，请如实告知用户生成已完成但文件定位失败）'
  return [
    `<${MEDIA_TASK_ENVELOPE_TAG} tool="${params.tool}" status="ok">`,
    `${params.label}已生成完毕，文件在本机：`,
    list,
    '',
    `请立刻把它交给用户：按当前可见回复约定作答，并用结构化媒体字段把上面的文件附上。`,
    `不要再调用 ${params.tool}（那会重新生成一份并再次计费）。`,
    `</${MEDIA_TASK_ENVELOPE_TAG}>`
  ].join('\n')
}

function failureMessage(params: { label: string; tool: string; reason: string }): string {
  return [
    `<${MEDIA_TASK_ENVELOPE_TAG} tool="${params.tool}" status="error">`,
    `${params.label}生成失败：${params.reason}`,
    '',
    '请如实告知用户失败原因并给出下一步建议（换模型 / 改描述 / 稍后重试）。',
    `不要立刻重复调用 ${params.tool}。`,
    `</${MEDIA_TASK_ENVELOPE_TAG}>`
  ].join('\n')
}

/** 把内核那句英文终态整理成能直接给用户看的一句话。 */
function humanizeFailure(task: TaskSnapshot): string {
  const raw = (task.terminalSummary ?? task.progressSummary ?? '').trim()
  if (/no available channel/i.test(raw)) {
    return '当前令牌分组里没有这个模型的可用渠道'
  }
  if (/timeout|timed out/i.test(raw)) {
    return '上游超时'
  }
  if (/price/i.test(raw)) {
    return '平台侧缺少该模型的价格配置'
  }
  return raw || `任务状态 ${task.status ?? 'unknown'}`
}

class MediaRelay extends EventEmitter {
  private started = false
  /** 正在跟的 taskId，防同一个任务被 watch 事件重复拉起。 */
  private tracking = new Set<string>()

  /** 渲染层要用的当前进度（按会话）。窗口重建后可以整份重放。 */
  private progress = new Map<string, MediaTaskProgress>()

  snapshot(): MediaTaskProgress[] {
    return [...this.progress.values()]
  }

  start(): void {
    if (this.started) {
      return
    }
    this.started = true
    try {
      mkdirSync(TASK_DIR, { recursive: true })
    } catch {
      /* 目录建不出来时下面的 scan 会安静地什么都不做 */
    }
    // 启动先全量扫一遍：应用没开着的时候完成的任务、以及上次没投完的，都在这里补。
    this.scan()
    try {
      // push 通道：插件一写文件就动。watch 在 Windows 上偶尔会漏事件，所以下面还有一条慢清扫。
      watch(TASK_DIR, () => this.scan())
    } catch (err) {
      console.warn('[media] 记账目录监听失败，退回定时清扫:', String(err))
    }
    // 慢清扫兜底（漏事件、以及 watch 建不起来的情况）。
    const sweep = setInterval(() => this.scan(), 30_000)
    sweep.unref?.()
  }

  private scan(): void {
    let files: string[] = []
    try {
      files = readdirSync(TASK_DIR).filter((n) => n.endsWith('.json'))
    } catch {
      return
    }
    for (const name of files) {
      const file = join(TASK_DIR, name)
      const record = readRecord(file)
      if (!record) {
        dropRecord(file)
        continue
      }
      if (record.handledAt) {
        // 上一轮投完了，只是没来得及删。
        dropRecord(file)
        continue
      }
      if (!needsRelay(record.sessionKey)) {
        // 内核自己投得成的会话（如 agent:main:main），不插手。
        dropRecord(file)
        continue
      }
      if (this.tracking.has(record.taskId)) {
        continue
      }
      this.tracking.add(record.taskId)
      void this.track(file, record).finally(() => this.tracking.delete(record.taskId))
    }
  }

  private emitProgress(next: MediaTaskProgress): void {
    if (next.phase === 'done' || next.phase === 'failed') {
      this.progress.delete(next.sessionKey)
    } else {
      this.progress.set(next.sessionKey, next)
    }
    this.emit('progress', next)
  }

  private async track(file: string, record: MediaTaskRecord): Promise<void> {
    const label = TOOL_LABELS[record.tool] ?? '媒体'
    const startedAt = record.recordedAt || Date.now()
    const deadline = startedAt + MAX_TRACK_MS
    let misses = 0

    this.emitProgress({
      sessionKey: record.sessionKey,
      taskId: record.taskId,
      tool: record.tool,
      label,
      phase: 'running',
      startedAt
    })

    while (Date.now() < deadline) {
      let task: TaskSnapshot | null = null
      try {
        const res = await gatewayClient.request<{ task?: TaskSnapshot }>('tasks.get', {
          taskId: record.taskId
        })
        task = res?.task ?? null
      } catch (err) {
        // 网关正在重启之类的瞬时故障：不算 miss，下一轮再问。
        console.warn(`[media] tasks.get 失败 task=${record.taskId}: ${String(err)}`)
        await sleep(POLL_MS)
        continue
      }
      if (!task) {
        misses += 1
        if (misses >= MAX_MISSES) {
          console.warn(`[media] 台账里查不到任务，放弃跟踪 task=${record.taskId}`)
          this.emitProgress({
            sessionKey: record.sessionKey,
            taskId: record.taskId,
            tool: record.tool,
            label,
            phase: 'failed',
            startedAt,
            error: '任务记录已丢失'
          })
          dropRecord(file)
          return
        }
        await sleep(POLL_MS)
        continue
      }
      misses = 0
      const status = String(task.status ?? '')
      if (ACTIVE_STATUSES.has(status)) {
        this.emitProgress({
          sessionKey: record.sessionKey,
          taskId: record.taskId,
          tool: record.tool,
          label,
          // 内核在投递阶段会把进度改成 delivering，那时产物已经出来了。
          phase: /deliver/i.test(String(task.progressSummary ?? '')) ? 'delivering' : 'running',
          startedAt
        })
        await sleep(POLL_MS)
        continue
      }

      // ---- 终态 ----
      const succeeded = status === 'completed' || status === 'succeeded'
      if (succeeded && !deliveryFailed(task)) {
        // 内核自己投成了（我们只补它投不到的那一档），不再插手。
        console.log(`[media] ${record.tool} task=${record.taskId} 内核已自行投递,不插手`)
        this.emitProgress({
          sessionKey: record.sessionKey,
          taskId: record.taskId,
          tool: record.tool,
          label,
          phase: 'done',
          startedAt
        })
        dropRecord(file)
        return
      }

      markHandled(file, record)
      try {
        if (succeeded) {
          const paths = findArtifacts(record.tool, task)
          // 用 chatSendConfirmed 而不是 chatSend:ack 不等于送到,派发阶段失败时调用方
          // 一无所知(实测丢过一条,详见该方法的注释)。产物已在磁盘上,这一步丢了
          // 用户就只看到「本轮回复已中断」。
          const sent = await gatewayClient.chatSendConfirmed(
            record.sessionKey,
            completionMessage({ label, tool: record.tool, paths, prompt: record.prompt }),
            { label: `${label}补投` }
          )
          console.log(
            `[media] 已补投 ${record.tool} task=${record.taskId} 产物=${paths.length} 个 -> ${record.sessionKey}` +
              (sent.attempts > 1 ? `(重投 ${sent.attempts - 1} 次)` : '')
          )
          this.emitProgress({
            sessionKey: record.sessionKey,
            taskId: record.taskId,
            tool: record.tool,
            label,
            phase: sent.error ? 'failed' : 'done',
            startedAt,
            ...(sent.error ? { error: '产物已生成,但结果没能送进对话,请点重试' } : {})
          })
        } else {
          const reason = humanizeFailure(task)
          await gatewayClient.chatSendConfirmed(
            record.sessionKey,
            failureMessage({ label, tool: record.tool, reason }),
            { label: `${label}失败通知` }
          )
          console.log(`[media] 已补投失败通知 ${record.tool} task=${record.taskId}: ${reason}`)
          this.emitProgress({
            sessionKey: record.sessionKey,
            taskId: record.taskId,
            tool: record.tool,
            label,
            phase: 'failed',
            startedAt,
            error: reason
          })
        }
      } catch (err) {
        // 这里剩下的是 `chat.send` 本身抛错(网关不可用、会话/agent 不存在这类内核已明确答复
        // 的失败)。这种不重投:内核给的是同一个答复,重投只会拿到第二遍。
        // 「ack 了但那一轮没起来」那类由 chatSendConfirmed 在里面重投过一次。
        console.error(`[media] 补投失败 task=${record.taskId}: ${String(err)}`)
        this.emitProgress({
          sessionKey: record.sessionKey,
          taskId: record.taskId,
          tool: record.tool,
          label,
          phase: 'failed',
          startedAt,
          error: '结果投递失败，产物已在本机媒体目录'
        })
      }
      dropRecord(file)
      return
    }

    console.warn(`[media] 跟踪超时放弃 task=${record.taskId}`)
    this.emitProgress({
      sessionKey: record.sessionKey,
      taskId: record.taskId,
      tool: record.tool,
      label,
      phase: 'failed',
      startedAt,
      error: '等待超时'
    })
    dropRecord(file)
  }
}

export const mediaRelay = new MediaRelay()
