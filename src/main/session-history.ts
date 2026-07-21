import { join, dirname } from 'path'
import { existsSync, readFileSync } from 'fs'
import type { SessionMessage } from '@shared/types'
import { runOpenClaw } from './openclaw-cli'

/**
 * 从内核 session store 恢复某 isolated agent 的历史消息。
 *
 * 数据来源:OpenClaw 把每次对话逐条 append 到 <sessionsDir>/<sessionId>.jsonl。
 * 我们不重复存储消息(遵循"无双写"),切换任务时按需解析该文件还原历史。
 *
 * 只还原 user/assistant 的文本消息;工具步骤等富信息暂不恢复(阶段性取舍)。
 */

/** 从 message.content 提取纯文本(兼容 string 与 [{type:'text',text}] 两种形态)。 */
function extractText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text?: unknown }).text ?? '')
          : ''
      )
      .join('')
  }
  return ''
}

/**
 * 定位某 agent 主会话(agent:<id>:main)的 jsonl 文件路径。
 * 经 `sessions list --agent <id> --json` 取 sessionsDir 与 sessionId;失败返回空串。
 */
async function resolveMainSessionFile(agentId: string): Promise<string> {
  try {
    const out = await runOpenClaw(['sessions', 'list', '--agent', agentId, '--json'])
    const parsed = JSON.parse(out) as {
      path?: string
      sessions?: Array<{ key?: string; sessionId?: string }>
    }
    if (!parsed.path || !parsed.sessions?.length) {
      return ''
    }
    const sessionsDir = dirname(parsed.path)
    const target =
      parsed.sessions.find((s) => s.key === `agent:${agentId}:main`) ?? parsed.sessions[0]
    if (!target?.sessionId) {
      return ''
    }
    return join(sessionsDir, `${target.sessionId}.jsonl`)
  } catch {
    return ''
  }
}

/** 读取并解析某 agent 的历史消息;任何一步失败都优雅降级为空数组。 */
export async function readSessionHistory(agentId: string): Promise<SessionMessage[]> {
  const jsonl = await resolveMainSessionFile(agentId)
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
  for (const line of raw.split(/\r?\n/)) {
    if (!line) {
      continue
    }
    let obj: { type?: string; message?: { role?: string; content?: unknown } }
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (obj?.type !== 'message' || !obj.message) {
      continue
    }
    const role = obj.message.role
    if (role !== 'user' && role !== 'assistant') {
      continue
    }
    const content = extractText(obj.message.content)
    if (content) {
      messages.push({ role, content })
    }
  }
  return messages
}
