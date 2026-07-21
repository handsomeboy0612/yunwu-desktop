import type { AgentEvent } from '@shared/types'

/**
 * 主进程侧 per-session 事件旁路缓冲(RingBuffer),用于断线重连后的重放。
 *
 * 设计依据(来自真实抓帧,见 terminals 探针输出):
 *  - 网关帧存在两个 seq 且都不适合作为跨重连去重键:
 *    · frame.seq(信封级)连接内单调,但重连后从头计数;
 *    · payload.seq(流内级)会在同一会话内重复/回退(按 run/尝试重置)。
 *  - 因此重放不依赖 seq,改用天然稳定标识实现幂等:
 *    · tool → 按 itemId 覆盖;delta/final → 携带累计快照,直接替换;lifecycle → 幂等。
 *
 * 缓冲按 runId 分界:检测到新 runId 即重置,使 replay 只返回"当前这一轮运行"的
 * 事件,避免把上一轮的增量错误地重放到新消息上。
 */

/** 每会话最多缓冲的事件数(超出丢弃最旧,防内存无限增长)。 */
const MAX_PER_SESSION = 400

interface SessionBuffer {
  runId?: string
  events: AgentEvent[]
}

const buffers = new Map<string, SessionBuffer>()

/** 记录一条已归一化的事件(在转发给渲染层的同时旁路写入)。 */
export function recordAgentEvent(evt: AgentEvent): void {
  let buf = buffers.get(evt.sessionKey)
  /** 新一轮运行(runId 变化):重置缓冲,只保留当前轮。 */
  if (!buf || (evt.runId !== undefined && buf.runId !== undefined && buf.runId !== evt.runId)) {
    buf = { runId: evt.runId, events: [] }
    buffers.set(evt.sessionKey, buf)
  }
  if (buf.runId === undefined && evt.runId !== undefined) {
    buf.runId = evt.runId
  }
  buf.events.push(evt)
  if (buf.events.length > MAX_PER_SESSION) {
    buf.events.splice(0, buf.events.length - MAX_PER_SESSION)
  }
}

/** 取某会话当前轮的缓冲事件副本(供重连后重放)。 */
export function replayAgentEvents(sessionKey: string): AgentEvent[] {
  return (buffers.get(sessionKey)?.events ?? []).slice()
}

/** 清空某会话缓冲(会话删除时可调用)。 */
export function clearSessionBuffer(sessionKey: string): void {
  buffers.delete(sessionKey)
}
