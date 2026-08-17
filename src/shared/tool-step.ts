import type { DiffStats, ExecOutcome } from './types'

/**
 * 工具步骤的展示语义(文案 / diff 行数 / 内容预览)。
 *
 * 实时路径(gateway-client 归一化事件)与历史路径(session-history 解析 jsonl)
 * 共用本模块,否则同一次运行在"运行时"和"重开后"会显示成两种说法。
 */

/**
 * 工具名 → 面向用户的中文动作。文案照抄 WorkBuddy 实测:
 * 写入类用现在体(创建 / 修改),读取检索类用「已」前缀的完成体(已读取文件 / 已搜索文件)。
 * 单一形态,不带状态词——状态由行首图标表达。
 */
const TOOL_LABELS: { test: RegExp; label: string }[] = [
  { test: /ask_user/, label: '向用户提问' },
  // 媒体生成三件套。不列在这里的话整行会退回内核原始标题,直接把 `image_generate`
  // 摊在用户眼前(2026-08-17 真机撞见)。文案取 WorkBuddy 的 `progress.phase.*.ImageGen`
  // 「正在生成图片」去掉状态词——状态由行首图标表达。
  { test: /image_generate/, label: '生成图片' },
  { test: /video_generate/, label: '生成视频' },
  { test: /music_generate/, label: '生成音乐' },
  { test: /^tts$|text_to_speech/, label: '朗读' },
  { test: /show_widget/, label: '展示详情' },
  { test: /present_files/, label: '展示产物文件' },
  { test: /^(write|create_file|write_file)$|write_file/, label: '创建' },
  { test: /edit|patch|str_replace|replace/, label: '修改' },
  { test: /glob|grep|find/, label: '已搜索文件' },
  { test: /web_search|websearch/, label: '检索网页' },
  { test: /web_fetch|webfetch|fetch/, label: '读取网页' },
  { test: /^(ls|list|dir)$|list_dir/, label: '列目录' },
  { test: /read/, label: '已读取文件' },
  { test: /bash|shell|^exec$|command|powershell/, label: '执行命令' },
  { test: /update_plan|todo|task_list/, label: '更新任务清单' },
  { test: /sessions_/, label: '查阅历史会话' },
  { test: /agents_/, label: '查看可用专家' },
  { test: /task|agent/, label: '委派子任务' }
]

/**
 * 步骤行首图标的语义分类。
 *
 * 对齐 WorkBuddy:行首不是"成功/失败"标记,而是**动作图标**(铅笔=创建/修改、
 * 放大镜=已搜索文件、圆点=平台自定义工具),统一淡灰色;只有失败才换成红色 ✗。
 * 分类放在这里而不是渲染层,是为了和上面的文案表用同一套正则,避免两处漂移。
 */
export type ToolIconKind =
  | 'edit'
  | 'search'
  | 'read'
  | 'exec'
  | 'web'
  | 'plan'
  | 'agent'
  | 'custom'

export function toolIconKind(name: string): ToolIconKind {
  const n = name.toLowerCase()
  if (/ask_user|show_widget|present_files/.test(n)) {
    return 'custom'
  }
  if (/^(write|create_file|write_file)$|write_file|edit|patch|str_replace|replace/.test(n)) {
    return 'edit'
  }
  if (/glob|grep|find/.test(n)) {
    return 'search'
  }
  if (/web_search|websearch|fetch/.test(n)) {
    return 'web'
  }
  if (/update_plan|todo|task_list/.test(n)) {
    return 'plan'
  }
  if (/bash|shell|^exec$|command|powershell/.test(n)) {
    return 'exec'
  }
  if (/^(ls|list|dir)$|list_dir|read/.test(n)) {
    return 'read'
  }
  if (/sessions_|agents_|task|agent/.test(n)) {
    return 'agent'
  }
  return 'custom'
}

/**
 * 展开预览块的配色:写入类内容整块算"新增"用绿底,平台工具的入参转储用中性灰底。
 * (WorkBuddy 实测:创建/修改的内容块是薄荷绿,展示产物文件的 JSON 块是浅灰。)
 */
export function previewTone(name: string): 'add' | 'neutral' {
  // 命令执行的 stdout 与平台工具入参一样用中性灰底(它不是"新增内容")。
  return /present_files|show_widget|bash|shell|^exec$|command|powershell/.test(name.toLowerCase())
    ? 'neutral'
    : 'add'
}

/** 从工具名取中文动作;认不出返回空串(调用方保留内核原始标题)。 */
export function toolLabel(name: string): string {
  const n = name.toLowerCase()
  for (const { test, label } of TOOL_LABELS) {
    if (test.test(n)) {
      return label
    }
  }
  return ''
}

function asObject(args: unknown): Record<string, unknown> | null {
  const o = typeof args === 'string' ? safeParse(args) : args
  return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function str(o: Record<string, unknown> | null, ...keys: string[]): string {
  if (!o) {
    return ''
  }
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.length) {
      return v
    }
  }
  return ''
}

/**
 * 步骤的操作目标(展示在动作之后)。
 * 对齐 WorkBuddy:文件类工具显示**完整路径**,搜索类显示 pattern,命令类显示命令本身。
 */
export function toolTarget(name: string, args: unknown): string {
  const o = asObject(args)
  const n = name.toLowerCase()
  if (/glob|grep|find/.test(n)) {
    const pattern = str(o, 'pattern', 'glob', 'query')
    const dir = str(o, 'path', 'dir', 'cwd')
    return [dir, pattern].filter(Boolean).join('\\') || pattern
  }
  if (/bash|shell|^exec$|command|powershell/.test(n)) {
    return str(o, 'command', 'cmd', 'script')
  }
  if (/web_search|websearch/.test(n)) {
    return str(o, 'query', 'q')
  }
  if (/fetch/.test(n)) {
    return str(o, 'url')
  }
  // present_files 不带目标:WorkBuddy 这行就是「展示产物文件 ›」,文件清单在展开的入参里。
  if (/present_files/.test(n)) {
    return ''
  }
  return str(o, 'path', 'file', 'filename', 'filePath', 'file_path', 'target')
}

/** 完整步骤文案(动作 + 目标);认不出的工具回退到内核原始标题。 */
export function toolStepTitle(name: string, args: unknown, fallbackTitle = ''): string {
  const label = toolLabel(name)
  if (!label) {
    return fallbackTitle || name
  }
  const target = toolTarget(name, args)
  return target ? `${label} ${target}` : label
}

/** 行数(空内容记 0;末尾换行不额外计一行)。 */
function lineCount(text: string): number {
  if (!text) {
    return 0
  }
  const t = text.endsWith('\n') ? text.slice(0, -1) : text
  return t.split('\n').length
}

/** diff 里的一行:加 / 减 / 上下文 / 省略号。 */
export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'skip'
  /** 行号(省略号那行为空)。 */
  num: string
  text: string
}

/** diff 最多渲染多少行;`edit` 一次改上千行时不能把整份塞进气泡。 */
const DIFF_LINE_LIMIT = 400

/**
 * 从内核 `toolResult.details` 里取 edit 的展示用 diff。
 *
 * 契约见 `openclaw/src/agents/sessions/tools/edit-diff.ts:287` 的 `generateDiffString`:
 * `details.diff` 每行是 `<符号><右对齐行号> <正文>`,符号 `+` 增 / `-` 减 / 空格上下文,
 * 上下文超过 4 行时中间插一行 ` ...`。另有 `details.patch`(标准 unified diff)与
 * `details.firstChangedLine`,我们只用前者——它自带行号,不用再算。
 */
export function editDiffFromDetails(details: unknown): string | undefined {
  const o = asObject(details)
  if (!o) {
    return undefined
  }
  const diff = o.diff
  return typeof diff === 'string' && diff.trim() ? diff : undefined
}

/** 把内核那份 diff 文本切成可着色的行;超长只留前 DIFF_LINE_LIMIT 行。 */
export function parseDiffLines(diff: string): DiffLine[] {
  const raw = diff.split('\n')
  const lines: DiffLine[] = []
  for (const line of raw.slice(0, DIFF_LINE_LIMIT)) {
    const m = /^([+\- ])(\s*\d*)\s?(.*)$/.exec(line)
    if (!m) {
      lines.push({ kind: 'ctx', num: '', text: line })
      continue
    }
    const [, sign, num, text] = m
    const trimmedNum = num.trim()
    if (!trimmedNum && text === '...') {
      lines.push({ kind: 'skip', num: '', text: '⋯' })
      continue
    }
    lines.push({
      kind: sign === '+' ? 'add' : sign === '-' ? 'del' : 'ctx',
      num: trimmedNum,
      text
    })
  }
  if (raw.length > DIFF_LINE_LIMIT) {
    lines.push({ kind: 'skip', num: '', text: `⋯ 另有 ${raw.length - DIFF_LINE_LIMIT} 行未显示` })
  }
  return lines
}

/** 按内核那份 diff 精确数增删行数;它是执行后的读数,比从入参推算准。 */
export function diffStatsFromDiff(diff: string): DiffStats | undefined {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+')) {
      added += 1
    } else if (line.startsWith('-')) {
      removed += 1
    }
  }
  return added || removed ? { added, removed } : undefined
}

/**
 * 文件改动的行数增删,用于步骤行右侧的 `+33 -0`(对齐 WorkBuddy)。
 *
 * 优先信任工具结果里自带的统计;拿不到则按入参推算:
 *  - write:全文即新增;
 *  - edit:若 new 以 old 开头视为纯追加(removed 记 0,与 WB 观感一致),否则按两段行数对比;
 *  - apply_patch:直接数 patch 里的 +/- 行。
 */
export function diffStatsFromResult(
  name: string,
  args: unknown,
  resultText: string
): DiffStats | undefined {
  const n = name.toLowerCase()
  const fromResult = resultText.match(/\+(\d+)\s*[/,-]?\s*-(\d+)/)
  if (fromResult) {
    return { added: Number(fromResult[1]), removed: Number(fromResult[2]) }
  }
  const o = asObject(args)
  if (/apply_patch|^patch$/.test(n)) {
    const patch = str(o, 'patch', 'diff', 'content')
    if (!patch) {
      return undefined
    }
    let added = 0
    let removed = 0
    for (const line of patch.split('\n')) {
      if (/^\+(?!\+\+)/.test(line)) {
        added++
      } else if (/^-(?!--)/.test(line)) {
        removed++
      }
    }
    return { added, removed }
  }
  if (/edit|str_replace|replace/.test(n)) {
    const oldText = str(o, 'old_string', 'oldString', 'old', 'search')
    const newText = str(o, 'new_string', 'newString', 'new', 'replacement')
    if (!oldText && !newText) {
      return undefined
    }
    if (oldText && newText.startsWith(oldText)) {
      return { added: lineCount(newText) - lineCount(oldText), removed: 0 }
    }
    return { added: lineCount(newText), removed: lineCount(oldText) }
  }
  if (/^(write|create_file|write_file)$/.test(n)) {
    const content = str(o, 'content', 'text', 'data')
    return content ? { added: lineCount(content), removed: 0 } : undefined
  }
  return undefined
}

/** 预览内容的上限(字符);历史里每步都带内容,过大会拖垮 IPC 与渲染。 */
const PREVIEW_LIMIT = 4000

/**
 * 步骤可展开查看的内容:写入/编辑的正文、patch、或交付清单的原始入参。
 * 只对"产生了内容"的工具返回,读取/命令类不返回(结果文本不在我们的还原范围内)。
 */
export function stepPreview(name: string, args: unknown): string {
  const n = name.toLowerCase()
  const o = asObject(args)
  let text = ''
  if (/^(write|create_file|write_file)$/.test(n)) {
    text = str(o, 'content', 'text', 'data')
  } else if (/apply_patch|^patch$/.test(n)) {
    text = str(o, 'patch', 'diff', 'content')
  } else if (/edit|str_replace|replace/.test(n)) {
    text = str(o, 'new_string', 'newString', 'new', 'replacement')
  } else if (/present_files/.test(n)) {
    // 与 WorkBuddy 一致:交付类工具展开看到的是原始入参 JSON(哪些文件、什么说明)。
    text = o ? JSON.stringify(o, null, 2) : ''
  }
  if (!text) {
    return ''
  }
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}\n…(已截断)` : text
}

/**
 * 结果型工具(命令执行)可展开查看的**输出文本**。
 *
 * 与 stepPreview 的分工:write/edit 的可展开内容来自入参(要写什么),
 * 而命令的价值在 **stdout**——它只存在于工具"结果"里,不在入参。对齐 WorkBuddy:
 * bash 步骤展开能看到命令输出。读取类结果通常很大且价值低,这里不纳入,避免刷屏。
 */
export function resultPreview(name: string, resultText: string): string {
  if (!resultText) {
    return ''
  }
  if (isCommandTool(name)) {
    return truncateOutputTail(stripExecNoise(resultText))
  }
  return ''
}

/**
 * 内核给命令输出补的两句「非 stdout」文字,显示前去掉。
 *
 * - 退出码注记:`bash-tools.exec-runtime.ts` 在 `aggregated` 末尾拼
 *   `\n\n(Command exited with code N)`。退出码我们单独有一行状态,正文再写一遍就成了
 *   「(Command exited with code 1)」压着「退出码 1」——真机撞见过(2026-08-17)。
 * - 空输出占位:`bash-tools.exec-output.ts` 用 `(no output)` 顶替空串。它是给模型看的,
 *   界面上"空"应该走「运行成功」那条状态,而不是画一个内容为占位符的输出块。
 */
function stripExecNoise(text: string): string {
  return text
    .replace(/\n*\(Command exited with code -?\d+\)\s*$/, '')
    .replace(/(^|\n)\(no output\)\s*$/, '')
    .trim()
}

/** 命令类工具(内核里叫 exec;别的内核/CLI 叫 bash / shell / powershell)。 */
export function isCommandTool(name: string): boolean {
  return /bash|shell|^exec$|^process$|command|powershell/.test(name.toLowerCase())
}

/** 命令输出保留的行数上限(与 WorkBuddy 的 `truncateByLines(stdout, 500, 'tail')` 同口径)。 */
const OUTPUT_TAIL_LINES = 500

/**
 * 命令输出超长时**留尾去头**,并在顶上标一行省略了多少。
 *
 * 方向很关键:写入类内容截前面(用户要看写了什么),命令输出截后面是错的——
 * 报错、退出提示、最终结果全在末尾,砍掉尾巴等于把答案砍了。
 * WorkBuddy 同样取尾(`truncateByLines(..., 'tail')`),提示文案对应它的
 * `tool.outputTruncatedHead`「⋯ 已省略前 {count} 行输出」。
 */
function truncateOutputTail(text: string): string {
  if (!text) {
    return ''
  }
  let out = text
  const lines = out.split('\n')
  if (lines.length > OUTPUT_TAIL_LINES) {
    out = `⋯ 已省略前 ${lines.length - OUTPUT_TAIL_LINES} 行输出\n${lines.slice(-OUTPUT_TAIL_LINES).join('\n')}`
  }
  if (out.length > PREVIEW_LIMIT) {
    out = `⋯ 已省略前面较长的输出\n${out.slice(-PREVIEW_LIMIT)}`
  }
  return out
}

/**
 * 从内核工具结果的 `details` 里取命令执行读数(退出码 / 耗时 / 后台进程)。
 *
 * 判据是真机抄本:`{status:"completed", exitCode, durationMs, aggregated}`,
 * 后台没结束时 `{status:"running", sessionId, pid, tail}`,出错时 `{status:"error", error}`。
 * **退出码只在这里**,结果正文里没有,所以不要试图从文本认字。
 */
export function execOutcomeFromDetails(details: unknown): ExecOutcome | undefined {
  const d = asObject(details)
  if (!d || typeof d.status !== 'string') {
    return undefined
  }
  return {
    status: d.status,
    ...(typeof d.exitCode === 'number' ? { exitCode: d.exitCode } : {}),
    ...(typeof d.durationMs === 'number' ? { durationMs: d.durationMs } : {}),
    ...(typeof d.sessionId === 'string' ? { sessionId: d.sessionId } : {}),
    ...(typeof d.pid === 'number' ? { pid: d.pid } : {})
  }
}

/**
 * 命令的完整输出:结束了在 `aggregated`,还在后台跑时是 `tail`。
 *
 * 返回 undefined 表示「这不是命令类结果,别用我」;**空串是有意义的读数**——
 * 一条什么都没打印的命令,内核给的是 `aggregated:""` 而结果正文写着 `(no output)`。
 * 两者混用的话,用户看到的是一个内容为「(no output)」的输出块,而不是一句「运行成功」。
 */
export function execOutputFromDetails(details: unknown): string | undefined {
  const d = asObject(details)
  if (!d) {
    return undefined
  }
  if (typeof d.aggregated === 'string') {
    return d.aggregated
  }
  return typeof d.tail === 'string' ? d.tail : undefined
}

/**
 * 步骤行里那条命令执行状态:成功且没有输出说「运行成功」,还在后台跑说「运行中」,
 * 非零退出码要显式写出来。文案取 WorkBuddy 的 `tool.executeCommand.*`
 * (运行成功 / 运行中 / 退出码),口径一致才好对照。
 */
export function execStatusText(
  exec: ExecOutcome | undefined,
  opts: { hasOutput: boolean; failed: boolean; running?: boolean }
): { text: string; tone: 'ok' | 'muted' | 'error' } | undefined {
  // 还在跑就只说「运行中」。少了这一条,命令刚开跑、输出还没回来的那几秒会被判成
  // 「没有输出的成功」,步骤行上先蹦出一句「运行成功」——真机撞见过(2026-08-17)。
  if (opts.running && !exec) {
    return { text: '运行中', tone: 'muted' }
  }
  if (exec?.status === 'running') {
    const where = exec.pid ? `(后台 pid ${exec.pid})` : ''
    return { text: `运行中${where}`, tone: 'muted' }
  }
  const code = exec?.exitCode
  if (typeof code === 'number' && code !== 0) {
    return { text: `退出码 ${code}`, tone: 'error' }
  }
  if (opts.failed) {
    return { text: '执行失败', tone: 'error' }
  }
  if (!opts.hasOutput) {
    return { text: '运行成功', tone: 'ok' }
  }
  return undefined
}
