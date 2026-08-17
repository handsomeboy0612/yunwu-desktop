import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import {
  allSessionKeys,
  anySessionIdOfAgent,
  ensureSessionTruth,
  sessionIdFor
} from './session-index'
import type {
  SessionMessage,
  PlanStep,
  ArtifactRef,
  TimelineItem,
  AskAnswer,
  AskQuestion
} from '@shared/types'
import {
  PLAN_TOOL_NAMES,
  ARTIFACT_TOOL_NAMES,
  parsePlanSteps,
  parseArtifactPath,
  parseWrittenPath,
  mediaArtifactsFromText,
  baseNameOf
} from '@shared/tool-parse'
import {
  toolStepTitle,
  diffStatsFromResult,
  diffStatsFromDiff,
  editDiffFromDetails,
  stepPreview,
  resultPreview,
  execOutcomeFromDetails,
  execOutputFromDetails
} from '@shared/tool-step'
import { parseTaskSessionKey, stripWorkingDirectory } from '@shared/session-key'
import { isWorkspaceDataPath } from '@shared/workspace-data'
import { isRelayEnvelopeMessage } from '@shared/relay-envelope'
import { parseMediaDirectives } from '@shared/media-directives'
import { TEAM_DELEGATION_NOTE_HEADER } from './team-roster-prompt'

/**
 * 从内核 session store 恢复某 isolated agent 的历史消息。
 *
 * 数据来源:OpenClaw 把每次对话逐条 append 到 <sessionsDir>/<sessionId>.jsonl。
 * 我们不重复存储消息(遵循"无双写"),切换任务时按需解析该文件还原历史。
 *
 * 还原的是**完整执行过程**,不只是正文:分段思考、每一次工具调用及其结果
 * (成功/失败、diff 行数、写入内容预览)、ask_user 的问答卡、show_widget 的图示,
 * 全部按发生顺序进时间线。内核落盘的记录本就足够完整——
 * assistant 消息内含 `thinking` / `text` / `toolCall` 块,工具结果是独立的
 * `role:'toolResult'` 消息,带 `toolCallId` / `toolName` / `isError`,可精确配对。
 *
 * 正文与时间线的关系见 TimelineItem.at 的说明:正文整轮累计,时间线项只记偏移。
 */

/** assistant 消息里的一个内容块(按序遍历,以保住正文与工具的交错关系)。 */
type ContentBlock = {
  type?: string
  text?: unknown
  thinking?: unknown
  name?: unknown
  arguments?: unknown
  toolCallId?: unknown
  id?: unknown
}

/** 工具结果消息(内核以独立 message 记录,role 为 toolResult)。 */
type ToolResultMessage = {
  role?: string
  toolCallId?: unknown
  toolName?: unknown
  content?: unknown
  isError?: unknown
  /** 内核执行后的结构化读数(命令的 exitCode / durationMs / aggregated 输出等)。 */
  details?: unknown
}

/**
 * 内核自己写进抄本的「非模型输出」assistant 行。
 *
 * 判据取内核自己那份:`provider === 'openclaw'` 且 model 是这两个之一
 * (`openclaw/src/shared/transcript-only-openclaw-assistant.ts:4-14`,注释原文
 * *transcript bookkeeping, not provider model output*)。内核重建模型上下文时也正是照它
 * 整条丢掉(`agents/embedded-agent-runner/replay-history.ts:280-285`)。
 */
const KERNEL_AUTHORED_ASSISTANT_MODELS = new Set(['gateway-injected', 'delivery-mirror'])

function isKernelAuthoredAssistant(msg: { provider?: unknown; model?: unknown }): boolean {
  return (
    msg.provider === 'openclaw' &&
    typeof msg.model === 'string' &&
    KERNEL_AUTHORED_ASSISTANT_MODELS.has(msg.model)
  )
}

/** 折叠空白后比对用。两侧的换行/缩进由不同代码路径生成,不能逐字比。 */
function flattenSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 剥掉我们每轮替用户加在正文前面的运行时前言(工作目录 + 专家团派活须知)。
 *
 * 两段都在 `ipc.ts` 的 `agent:send` 里拼(`withWorkingDirectory(teamNote ? … : message, cwd)`),
 * 模型需要它们,用户不需要看:实时气泡里从来没有这两段,历史还原也不该有。
 * 派活须知本身不含空行,所以「首行是须知标题 → 到第一个空行为止」就是准确的边界。
 */
function stripRuntimePreamble(text: string): string {
  const body = stripWorkingDirectory(text)
  if (!body.startsWith(TEAM_DELEGATION_NOTE_HEADER)) {
    return body
  }
  const end = body.indexOf('\n\n')
  return end < 0 ? '' : body.slice(end + 2)
}

function blocksOf(content: unknown): ContentBlock[] {
  return Array.isArray(content) ? (content.filter((b) => b && typeof b === 'object') as ContentBlock[]) : []
}

/** 从 message.content 提取纯文本(兼容 string 与 [{type:'text',text}] 两种形态)。 */
function extractText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  return blocksOf(content)
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('')
}

/** 解析 ask_user 入参里的问题列表(仅取渲染问答卡所需字段)。 */
function parseAskQuestions(args: unknown): AskQuestion[] {
  const obj = typeof args === 'string' ? safeJson(args) : args
  const list = (obj as { questions?: unknown } | null)?.questions
  if (!Array.isArray(list)) {
    return []
  }
  const out: AskQuestion[] = []
  for (const q of list) {
    if (!q || typeof q !== 'object') {
      continue
    }
    const o = q as { question?: unknown; header?: unknown }
    const question = String(o.question ?? '').trim()
    if (question) {
      out.push({ question, ...(o.header ? { header: String(o.header) } : {}) })
    }
  }
  return out
}

/**
 * 解析 ask_user 的工具结果 → 用户作答。
 * 结果文本即我们工具 handler 回给模型的 JSON:[{header,question,selected,custom}]。
 */
function parseAskAnswers(resultText: string): AskAnswer[] {
  const parsed = safeJson(resultText)
  if (!Array.isArray(parsed)) {
    return []
  }
  const out: AskAnswer[] = []
  for (const a of parsed) {
    if (!a || typeof a !== 'object') {
      continue
    }
    const o = a as { header?: unknown; question?: unknown; selected?: unknown; custom?: unknown }
    out.push({
      question: String(o.question ?? ''),
      ...(o.header ? { header: String(o.header) } : {}),
      selected: Array.isArray(o.selected) ? o.selected.map((s) => String(s)) : [],
      ...(o.custom ? { custom: String(o.custom) } : {})
    })
  }
  return out
}

function safeJson(text: string | unknown): unknown {
  if (typeof text !== 'string') {
    return text
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 取入参里的字符串字段(容忍 string 化的 arguments)。 */
function argString(args: unknown, ...keys: string[]): string {
  const obj = typeof args === 'string' ? safeJson(args) : args
  if (!obj || typeof obj !== 'object') {
    return ''
  }
  const o = obj as Record<string, unknown>
  for (const k of keys) {
    if (typeof o[k] === 'string' && (o[k] as string).length) {
      return o[k] as string
    }
  }
  return ''
}

/**
 * 扫出内核里所有「任务会话」的键。
 *
 * 用于启动后台把「内核里有、本地元数据没有」的孤儿任务恢复到侧栏。两种键都收:
 * 新键 `agent:<agentId>:acp:<taskId>`,以及一任务一 agent 时代的 `agent:t…:main`。
 *
 * **每次都先向网关取一次完整清单**(而不是用内存里的增量表):事件增量只加不减,
 * 会话删掉后表里会留残条,而这里的结果会决定"要不要把某条任务恢复到侧栏""某个专家
 * 还有没有人在用",残条会让判断反过来。三个调用方都在启动链上、都能等这一下。
 * 为什么不再直接读那份 JSON:见 `session-index.ts` 顶部(7.2 起它已不是权威口径)。
 */
export async function listTaskSessionKeys(): Promise<string[]> {
  await ensureSessionTruth()
  return allSessionKeys().filter((key) => {
    const parsed = parseTaskSessionKey(key)
    // 只认任务:任务 id 形如 t<13位时间戳><随机>。这道过滤同时挡掉了 `agent:main:main`
    // 这条内核自带的主会话——它不是任务,漏掉会在侧栏冒出一条幽灵。
    return Boolean(parsed && /^t\d{13}/.test(parsed.taskId))
  })
}

/**
 * 定位某条会话的 jsonl 实录路径。
 *
 * 走内存里的会话索引(`session-index.ts`)拿 sessionId,再按内核布局拼
 * `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`。**这条是切任务的同步路径**,
 * 所以只能读内存表:实测 `sessions.list` 每次 1.4~1.6 秒,现调等于把当初从 spawn CLI
 * 换成读盘才修掉的卡顿放回来。实录仍是 `<sessionId>.jsonl`,7.2 上也没变(上游
 * `src/agents/command/attempt-execution.helpers.ts` 那行原样在)。
 *
 * 必须按**完整会话键**取,不能再像一任务一 agent 时代那样「索引里随便挑一条有
 * sessionId 的」:现在十个任务共用 `main`,那个兜底会把别的任务的实录还给你。
 * 只有旧键(agentId 就是 taskId、该 agent 只有一条会话)才保留兜底。
 */
function resolveSessionFile(sessionKey: string): string {
  const parsed = parseTaskSessionKey(sessionKey)
  if (!parsed) {
    return ''
  }
  const sessionId =
    sessionIdFor(sessionKey) || (parsed.legacy ? anySessionIdOfAgent(parsed.agentId) : '')
  if (!sessionId) {
    return ''
  }
  return join(homedir(), '.openclaw', 'agents', parsed.agentId, 'sessions', `${sessionId}.jsonl`)
}

/** 一轮回答的累积状态(正文 + 时间线 + 富卡片)。 */
class Turn {
  content = ''
  timeline: TimelineItem[] = []
  plan: PlanStep[] | null = null
  artifacts: ArtifactRef[] = []
  /** 这一轮被内核重跑了几次(1 = 没重跑)。 */
  attempt = 1
  /** toolCallId → 该工具步骤在 timeline 中的下标,用于工具结果回填。 */
  private stepIndex = new Map<string, number>()
  /** toolCallId → 原始入参,ask_user 的作答需要结合入参与结果。 */
  private stepArgs = new Map<string, unknown>()

  get empty(): boolean {
    return !this.content && !this.timeline.length && !this.plan && !this.artifacts.length
  }

  /**
   * 本轮正文里是否已经有这段文字。
   *
   * 比之前先把 `MEDIA:` 指令行剥掉:重写那条的正文正是「模型原话减去指令行」,
   * 不剥就比不上(指令在正文中间时尤其)。空字符串视为已有——它本来也加不进什么。
   */
  hasSameText(text: string): boolean {
    return flattenSpace(parseMediaDirectives(this.content).text).includes(flattenSpace(text))
  }

  /**
   * 内核又把同一条 prompt 跑了一遍(reasoning-only 重试)。
   *
   * 上一次尝试什么可见东西都没产出时,把它的思考段丢掉:几次尝试的思考几乎逐字相同
   * (内核那句 retry 指令还会被模型抄进思考里),并排堆着就是用户看到的「一段一段」。
   * 上一次要是已经有正文或工具步骤就一律留着——内核只在无副作用时才重试,
   * 但真出现了,保留比丢掉安全。
   */
  markPromptReplay(): void {
    this.attempt += 1
    if (!this.content && !this.plan && this.timeline.every((t) => t.kind === 'thinking')) {
      this.timeline = []
    }
  }

  /** 记录一个时间线项;`at` 取当前正文长度,渲染时据此把正文切片穿插。 */
  push(item: TimelineItem): number {
    this.timeline.push({ ...item, at: this.content.length })
    return this.timeline.length - 1
  }

  addToolCall(id: string, name: string, args: unknown): void {
    const lower = name.toLowerCase()

    // update_plan → 待办清单(同轮内只保留最新一份,与实时运行一致)。
    if (PLAN_TOOL_NAMES.has(lower)) {
      const steps = parsePlanSteps(args)
      if (steps.length) {
        this.plan = steps
        const existing = this.timeline.findIndex((t) => t.kind === 'plan')
        if (existing >= 0) {
          this.timeline[existing] = { kind: 'plan', itemId: id, steps, at: this.timeline[existing].at }
        } else {
          this.push({ kind: 'plan', itemId: id, steps })
        }
        return
      }
    }

    // ask_user → 问答卡(先落 waiting,拿到结果再补作答)。
    if (lower.includes('ask_user')) {
      const idx = this.push({
        kind: 'ask',
        itemId: id,
        status: 'waiting',
        questions: parseAskQuestions(args)
      })
      this.stepIndex.set(id, idx)
      this.stepArgs.set(id, args)
      return
    }

    // show_widget → 图示卡(SVG 就在入参里,历史可完整还原)。
    if (lower.includes('show_widget')) {
      const code = argString(args, 'widget_code', 'widgetCode')
      if (code) {
        this.push({
          kind: 'widget',
          itemId: id,
          title: argString(args, 'title'),
          code
        })
        return
      }
    }

    // 其余工具(含 write/edit/exec/read/present_files)→ 步骤行。
    const path = ARTIFACT_TOOL_NAMES.has(lower) ? parseArtifactPath(args) : ''
    if (path && !isWorkspaceDataPath(path) && !this.artifacts.some((a) => a.path === path)) {
      this.artifacts.push({ path, name: baseNameOf(path) })
    }
    const preview = stepPreview(lower, args)
    const idx = this.push({
      kind: 'tool',
      itemId: id,
      name: lower,
      title: toolStepTitle(lower, args),
      status: 'running',
      ...(path ? { path } : {}),
      ...(preview ? { preview } : {})
    })
    this.stepIndex.set(id, idx)
    this.stepArgs.set(id, args)
  }

  /** 工具结果回填:定状态、算 diff 行数、补 ask_user 的作答、命令的退出码与输出。 */
  addToolResult(id: string, resultText: string, isError: boolean, details?: unknown): void {
    const idx = this.stepIndex.get(id)
    if (idx === undefined) {
      return
    }
    const item = this.timeline[idx]
    if (item.kind === 'ask') {
      const answers = parseAskAnswers(resultText)
      this.timeline[idx] = {
        ...item,
        status: answers.length ? 'answered' : 'cancelled',
        ...(answers.length ? { answers } : {})
      }
      return
    }
    if (item.kind !== 'tool') {
      return
    }
    const stats = diffStatsFromResult(item.name ?? '', this.stepArgs.get(id), resultText)
    // write 有时入参不带 path,路径只在结果文本里(「Successfully wrote N bytes to <path>」);
    // 若步骤此前没解析到路径,这里从结果兜底补上——同时补进产物清单,保证重开历史后
    // 步骤行有地址、产物卡片也认得这份文件。
    let recoveredPath = ''
    if (!item.path && !isError && ARTIFACT_TOOL_NAMES.has((item.name ?? '').toLowerCase())) {
      recoveredPath = parseWrittenPath(resultText)
      if (
        recoveredPath &&
        !isWorkspaceDataPath(recoveredPath) &&
        !this.artifacts.some((a) => a.path === recoveredPath)
      ) {
        this.artifacts.push({ path: recoveredPath, name: baseNameOf(recoveredPath) })
      }
    }
    // 命令执行的 stdout 只在结果里,重开历史时从 resultText 补出可展开预览(对齐 bash 展示)。
    // 命令类工具优先用 details 里的完整输出:结果正文对后台未结束的命令只有一句
    // 「Command still running (…)」,真正的输出在 details.aggregated / details.tail。
    const exec = execOutcomeFromDetails(details)
    const outText = execOutputFromDetails(details) ?? resultText
    const outPreview = item.preview ? '' : resultPreview(item.name ?? '', outText)
    // edit 的改动明细只在 details.diff 里,行数也按它数——入参那份是猜的,
    // 同时有增有删时数不准(见 diffStatsFromResult 的推算分支)。
    const diff = editDiffFromDetails(details)
    const bestStats = (diff ? diffStatsFromDiff(diff) : undefined) ?? stats
    this.timeline[idx] = {
      ...item,
      status: isError ? 'failed' : 'completed',
      ...(bestStats ? { stats: bestStats } : {}),
      ...(recoveredPath ? { path: recoveredPath } : {}),
      ...(outPreview ? { preview: outPreview } : {}),
      ...(exec ? { exec } : {}),
      ...(diff ? { diff } : {})
    }
  }

  toMessage(): SessionMessage {
    const msg: SessionMessage = { role: 'assistant', content: this.content }
    if (this.timeline.length) {
      msg.timeline = this.timeline
    }
    // 只有思考、没有正文也没有任何步骤 → 这一轮其实什么都没交付。内核那句
    // 「⚠️ Agent couldn't generate a response」不落抄本,不补这一条的话重开历史
    // 看到的是「已完成」+ 一块思考,失败痕迹全无。
    if (!this.content && this.timeline.length && this.timeline.every((t) => t.kind === 'thinking')) {
      msg.error =
        this.attempt > 1
          ? `模型只输出了思考、没有给出回答(已自动重跑 ${this.attempt - 1} 次)。可以重发,或换个模型再试。`
          : '模型只输出了思考、没有给出回答。可以重发,或换个模型再试。'
    }
    if (this.plan) {
      msg.plan = this.plan
    }
    // 生成类工具的产出只体现在正文的 `MEDIA:` 行里(不经 write/edit),重开任务时
    // 要和写入类产出物一样回到清单,否则历史里的图会整批消失。
    const media = mediaArtifactsFromText(this.content, this.artifacts)
    const artifacts = media.length ? [...this.artifacts, ...media] : this.artifacts
    if (artifacts.length) {
      msg.artifacts = artifacts
    }
    return msg
  }
}

/**
 * 取某 agent **最近一次** `update_plan` 的完整入参(供运行时补齐任务清单卡片)。
 *
 * 为什么需要它:走网关的 embedded 管线不广播 `stream:"tool"` 子流,`stream:"item"` 帧里
 * 只有一个拍平且被截断的 `meta` 字符串(形如 `explanation …, step 第一步…`),既没有完整
 * 步骤也没有勾选状态 —— 运行时**无法**从帧里还原清单。而内核会把工具调用逐条 append 到
 * 会话 jsonl,里面有完整结构,于是这里回读磁盘补齐(与历史还原同源,不引入第二份真相)。
 *
 * 取值优先 `toolResult.details`(内核执行后的**权威**结果,含每步 status),
 * 回退到 `assistant.content[].toolCall.arguments`(模型入参,工具结果尚未落盘时用)。
 * 返回原始对象交给 `parsePlanSteps` 解析;读不到任何一份时返回 null。
 */
export function readLatestPlanArgs(sessionKey: string): unknown {
  const jsonl = resolveSessionFile(sessionKey)
  if (!jsonl || !existsSync(jsonl)) {
    return null
  }
  let raw: string
  try {
    raw = readFileSync(jsonl, 'utf-8')
  } catch {
    return null
  }
  /** 从后往前扫:最近一次调用即为当前清单状态。 */
  const lines = raw.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (!line || !line.includes('update_plan')) {
      continue
    }
    let obj: { type?: string; message?: { role?: string; content?: unknown; toolName?: string; details?: unknown } }
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const msg = obj?.message
    if (obj?.type !== 'message' || !msg) {
      continue
    }
    if (msg.role === 'toolResult' && msg.toolName === 'update_plan' && msg.details) {
      return msg.details
    }
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block?.type === 'toolCall' && block.name === 'update_plan' && block.arguments) {
          return block.arguments
        }
      }
    }
  }
  return null
}

/** 读取并解析某条会话的历史消息;任何一步失败都优雅降级为空数组。 */
export async function readSessionHistory(sessionKey: string): Promise<SessionMessage[]> {
  const jsonl = resolveSessionFile(sessionKey)
  if (!jsonl || !existsSync(jsonl)) {
    return []
  }
  let raw: string
  try {
    raw = readFileSync(jsonl, 'utf-8')
  } catch {
    return []
  }

  const messages: SessionMessage[] = []
  let turn = new Turn()
  /** 上一条用户记录的幂等键:内核重跑同一条 prompt 时会带着**同一个**键再落一条。 */
  let lastUserKey = ''

  const flushTurn = (): void => {
    if (!turn.empty) {
      messages.push(turn.toMessage())
    }
    turn = new Turn()
  }

  for (const line of raw.split(/\r?\n/)) {
    if (!line) {
      continue
    }
    let obj: {
      type?: string
      message?: {
        role?: string
        content?: unknown
        provider?: unknown
        model?: unknown
        idempotencyKey?: unknown
      }
    }
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (obj?.type !== 'message' || !obj.message) {
      continue
    }
    const role = obj.message.role
    const rawContent = obj.message.content

    if (role === 'user') {
      const content = stripRuntimePreamble(extractText(rawContent))
      // 媒体补投与成员产出回传也是 user 记录,但它们是我们自己投的,不是用户说的话:
      // 实时路径不给它们建用户气泡,历史要一致(否则回看旧任务会多出一段信封原文)。
      //
      // **而且不能在这里收尾上一轮**(2026-08-14 按用户截图改):模型调完 video_generate /
      // image_generate 就 yield 了,产物回来我们把它唤醒,它才接着说「视频生成好了,请查收」。
      // 那是**同一次请求的后半截**,不是新的一轮。收尾会让一次请求裂成两条「已完成」气泡,
      // 第一条只剩一个光秃秃的工具名、没有正文——用户看到的就是那个。
      if (isRelayEnvelopeMessage(content)) {
        continue
      }
      /**
       * 同一个 `idempotencyKey` 再来一次 = **内核在重跑这条 prompt**,不是用户又问了一遍。
       *
       * 判据取真机抄本(2026-08-17 那条出图任务):三条 user 记录的 `idempotencyKey` 与内层
       * `timestamp` 完全相同,中间夹着三条只有 thinking 的 assistant 记录 —— 内核在
       * 「只有思考、没有可见回答」时会原样重跑,上限 2 次
       * (`openclaw/src/agents/embedded-agent-runner/run.ts:3746`,
       * `DEFAULT_REASONING_ONLY_RETRY_LIMIT = 2`)。键是我们 `chat.send` 自己发的
       * randomUUID,所以重复只可能来自重跑。
       *
       * 不去重的后果就是用户看到的:一句问话变三句、三条空的「已完成」气泡。
       */
      const key = typeof obj.message.idempotencyKey === 'string' ? obj.message.idempotencyKey : ''
      if (key && key === lastUserKey) {
        turn.markPromptReplay()
        continue
      }
      lastUserKey = key
      // 用户真说话了才是新一轮:先收尾上一轮,再压入用户消息。
      flushTurn()
      if (content) {
        messages.push({ role: 'user', content })
      }
      continue
    }

    if (role === 'toolResult') {
      const m = obj.message as ToolResultMessage
      const id = typeof m.toolCallId === 'string' ? m.toolCallId : ''
      if (id) {
        // details 是内核执行后的权威读数(命令的退出码 / 耗时 / 完整输出只在这里)。
        turn.addToolResult(id, extractText(m.content), m.isError === true, m.details)
      }
      continue
    }

    if (role !== 'assistant') {
      continue
    }

    /**
     * 记录级去重:媒体那一轮内核会落**两条** assistant 记录。
     *
     * 第一条是模型原话(末尾带 `MEDIA:<绝对路径>` 指令),第二条是网关按展示口径重写的
     * ——正文相同、指令已换成 `image` 附件块,由 `appendWebchatAgentMediaTranscriptIfNeeded`
     * 追加(`openclaw/src/gateway/server-methods/chat.ts:3874-3886`,idempotencyKey 形如
     * `<runId>:assistant-media`)。两条都累进同一轮的后果 2026-08-13 真机现形:正文出两遍,
     * 且第二份正文紧接在 `MEDIA:` 行后面、指令不再独占一行,于是剥不掉(裸路径外露)、
     * 图片卡也生成不出来。
     *
     * **只在正文重复时丢**:同一个标记还用在被中断那一轮的残余正文上
     * (`chat.ts:1959-1996` 的 `persistAbortedPartials`,带 `openclawAbort`),那种是独有正文,
     * 一律丢会让被打断的回答在历史里凭空消失。
     *
     * 附件块刻意不取:它的 url 是网关自己 serve 的相对地址
     * (`/api/chat/media/outgoing/<会话键>/<id>/full`),渲染层拿不到也认不了;图片走模型原话
     * 里的本地绝对路径,与实时那条同源(`toMessage` 的 `mediaArtifactsFromText`)。
     */
    if (isKernelAuthoredAssistant(obj.message) && turn.hasSameText(extractText(rawContent))) {
      continue
    }

    // 按块顺序遍历,保住「思考 → 正文 → 工具 → 正文」的交错关系。
    for (const b of blocksOf(rawContent)) {
      if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
        turn.push({
          kind: 'thinking',
          id: `h-${turn.timeline.length}`,
          text: b.thinking,
          ...(turn.attempt > 1 ? { attempt: turn.attempt } : {})
        })
      } else if (b.type === 'reasoning' && typeof b.text === 'string' && b.text.trim()) {
        turn.push({
          kind: 'thinking',
          id: `h-${turn.timeline.length}`,
          text: b.text,
          ...(turn.attempt > 1 ? { attempt: turn.attempt } : {})
        })
      } else if (b.type === 'text' && typeof b.text === 'string') {
        turn.content += b.text
      } else if (b.type === 'toolCall' && typeof b.name === 'string') {
        const id = String(b.toolCallId ?? b.id ?? `call-${turn.timeline.length}`)
        turn.addToolCall(id, b.name, b.arguments)
      }
    }
  }
  flushTurn()
  return messages
}
