import type { TimelineItem } from './types'

/** 时间线里的 ask 项(从联合类型里取出这一支,便于调用方标注)。 */
export type AskTimelineItem = Extract<TimelineItem, { kind: 'ask' }>

/**
 * 本模块只认消息的这两个字段。不引 Workspace 里的 ChatMessage:那是渲染层的本地类型,
 * 为了一个纯扫描函数把它搬进 shared,等于让共享层反过来依赖某个页面。
 */
export interface AskScanMessage {
  role: string
  timeline?: TimelineItem[]
}

/**
 * 从一条会话的消息里推导出「此刻待作答的提问」,没有则为 null。
 *
 * 照 WorkBuddy `packages/agent-ui/src/hooks/use-active-question.ts` 的 `useActiveQuestion(messages)`:
 * 它倒着找最新一条 assistant 消息,在其中找最后一个 AskUserQuestion 工具调用,
 * 只有状态仍是 pending 才算「待答」;**找到那条消息就停,不再往更早的消息里翻**
 * (它源码里那句 `break` 就是这个意思)。我们的 ask 时间线项与它的工具调用一一对应,
 * status:'waiting' 对应它的 pending。
 *
 * 为什么要推导而不是让面板自己存一份:面板自持状态时,那张卡与会话没有任何关系 ——
 * 切到别的任务或首页,选项卡会跟着飘过去;在那边作答,答案被写进错的任务;点 ✕ 中止的
 * 也是错的会话。推导出来之后,离开自然不显示,回来自然还在。
 */
export function findActiveAsk(messages: readonly AskScanMessage[]): AskTimelineItem | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') {
      continue
    }
    const timeline = m.timeline ?? []
    for (let j = timeline.length - 1; j >= 0; j--) {
      const it = timeline[j]
      if (it.kind === 'ask') {
        return it.status === 'waiting' ? it : null
      }
    }
    // 最新的助手消息里根本没有 ask:也到此为止。再往前翻只会翻出上一轮早已答完的提问,
    // 把它重新弹出来要求用户再答一次。
    return null
  }
  return null
}
