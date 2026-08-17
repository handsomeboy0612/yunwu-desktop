import type { ArtifactRef, PlanStep } from './types'
import { parseMediaDirectives } from './media-directives'

/**
 * 工具入参解析(实时事件与历史 jsonl 共用)。
 *
 * 实时路径:AgentEvent.tool.input(网关透传的 data.input)。
 * 历史路径:session jsonl 里 assistant 消息的 `{type:'toolCall', name, arguments}` 块。
 * 两者入参结构一致,故解析逻辑集中在此,避免主/渲染两处重复与漂移。
 */

/** 内核产出文件的工具名(命中则聚合为产出物卡片)。 */
export const ARTIFACT_TOOL_NAMES = new Set([
  'write',
  'edit',
  'apply_patch',
  'create_file',
  'write_file'
])

/** 待办/计划工具名(命中则渲染为可勾选清单)。 */
export const PLAN_TOOL_NAMES = new Set(['update_plan', 'plan', 'todo', 'write_todos', 'task_list'])

/** 取路径末段文件名(兼容 Windows/POSIX 分隔符)。 */
export function baseNameOf(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p
}

/** 归一化单步状态到 pending|in_progress|completed。 */
export function normalizePlanStatus(raw: unknown): PlanStep['status'] {
  const s = String(raw ?? '').toLowerCase()
  if (/(done|complete|completed|finished|success)/.test(s)) {
    return 'completed'
  }
  if (/(in[_\-\s]?progress|running|active|doing|current)/.test(s)) {
    return 'in_progress'
  }
  return 'pending'
}

/**
 * 从 update_plan 工具入参解析出待办清单。容忍多种字段命名:
 * input.plan / input.steps / input.todos / input.items,元素为字符串或
 * { step|content|title|text|name|description, status|state }。解析不出返回空数组。
 */
export function parsePlanSteps(input: unknown): PlanStep[] {
  if (!input) {
    return []
  }
  let obj: Record<string, unknown> | unknown[] = input as Record<string, unknown>
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input)
    } catch {
      return []
    }
  }
  const arr: unknown[] = Array.isArray(obj)
    ? obj
    : ((obj as Record<string, unknown>).plan ??
        (obj as Record<string, unknown>).steps ??
        (obj as Record<string, unknown>).todos ??
        (obj as Record<string, unknown>).items ??
        []) as unknown[]
  if (!Array.isArray(arr)) {
    return []
  }
  const steps: PlanStep[] = []
  for (const el of arr) {
    if (typeof el === 'string') {
      if (el.trim()) {
        steps.push({ text: el.trim(), status: 'pending' })
      }
      continue
    }
    if (el && typeof el === 'object') {
      const o = el as Record<string, unknown>
      const text = String(
        o.step ?? o.content ?? o.title ?? o.text ?? o.name ?? o.description ?? ''
      ).trim()
      if (text) {
        steps.push({ text, status: normalizePlanStatus(o.status ?? o.state) })
      }
    }
  }
  return steps
}

/**
 * 从 write/edit 工具入参解析出产出文件路径。容忍 input.path / input.file /
 * input.filename / input.target / input.filePath / input.file_path;
 * 拿不到再从标题里抽带扩展名的文件名(历史路径无标题时传空)。
 */
export function parseArtifactPath(input: unknown, title = ''): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    const p = o.path ?? o.file ?? o.filename ?? o.filePath ?? o.target ?? o.file_path
    if (typeof p === 'string' && p.trim()) {
      return p.trim()
    }
  }
  if (typeof input === 'string') {
    try {
      return parseArtifactPath(JSON.parse(input), title)
    } catch {
      /* fallthrough to title */
    }
  }
  const m = title.match(/([\w.\-/\\]+\.[A-Za-z0-9]+)/)
  return m ? m[1] : ''
}

/**
 * 从助手回复正文里聚合媒体产出物(`MEDIA:` 指令)。
 *
 * 为什么不能只靠 ARTIFACT_TOOL_NAMES:生成类工具(`image_generate` / `video_generate` /
 * `music_generate`)压根不写文件到工作区,它们由内核存进受管媒体库,再让 agent 把路径
 * 以 `MEDIA:` 行附在回复里。只认 write/edit 的话,一张生成的图既不进产出物清单、
 * 也没有任何入口能点开,用户只能看到一行路径文本。
 *
 * 已在清单里的路径不重复追加,返回值是**要新增**的部分,调用方直接拼接即可。
 */
export function mediaArtifactsFromText(text: string, existing: ArtifactRef[] = []): ArtifactRef[] {
  const { media } = parseMediaDirectives(text)
  if (media.length === 0) {
    return []
  }
  const known = new Set(existing.map((a) => a.path))
  const added: ArtifactRef[] = []
  for (const m of media) {
    if (known.has(m.url)) {
      continue
    }
    known.add(m.url)
    added.push({ path: m.url, name: m.name, kind: m.kind })
  }
  return added
}

/**
 * 从写入类工具的**结果文本**里兜底提取产出文件路径。
 *
 * 存在的意义:OpenClaw 的 write 工具在某些调用里入参**不带 path 键**
 * (模型只给了 content,路径由内核推断),此时 parseArtifactPath 拿不到路径,
 * 步骤行只剩「创建」、产物卡片也拿不到地址。但内核结果文本必然回带绝对路径,
 * 形如 `Successfully wrote 5697 bytes to C:\...\xxx.md`,从这里把它抠出来。
 */
export function parseWrittenPath(result: string): string {
  if (!result) {
    return ''
  }
  // 主形态:Successfully wrote/created N bytes to <path>(路径吃到行尾,含空格/中文)。
  const m = result.match(/(?:wrote|created|saved|updated)\b[^\n]*?\bto\s+(.+?)[\s.]*$/im)
  if (m && m[1].trim()) {
    return m[1].trim()
  }
  // 兜底:任意 "... <像文件的绝对/相对路径>" 结尾。
  const f = result.match(/([A-Za-z]:\\[^\n"]+?\.[A-Za-z0-9]+|\/[^\n"]+?\.[A-Za-z0-9]+)/)
  return f ? f[1].trim() : ''
}
