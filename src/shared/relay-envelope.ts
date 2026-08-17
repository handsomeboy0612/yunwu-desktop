/**
 * 我们自己投进会话的那几条消息的信封标签。
 *
 * 媒体补投(`main/media-relay.ts`)与成员产出回传(`main/team-relay.ts`)都是拿 `chat.send`
 * 投进去的,所以在内核抄本里它们与用户打的字一样是 `role:'user'` 记录。实时路径压根不给
 * 它们建用户气泡(只补助手那条,见 Workspace.tsx 的"陌生 runId 补气泡"),历史还原要一致
 * —— 判据就是这两个标签。
 *
 * 标签常量放在 shared 而不是各自写死:发的那侧与读历史那侧是同一份协议,改一个必须一起改。
 * 而 `session-history.ts` 要能在纯 node 里跑(`scripts/verify-history.mjs`),不能 import 到
 * media-relay 那条挂着 electron / ws 的链上,所以只能把常量提出来。
 *
 * 形状与内核对自己等价物的做法一致:成员播报那类 inter-session user 记录在展示投影里直接
 * 隐藏(`openclaw/src/gateway/chat-display-projection.ts:1444-1446`),而机器前言是剥掉
 * (同文件 `:1544-1562` 的 `stripInterSessionPromptPrefixFromContent`)。
 */

export const MEDIA_TASK_ENVELOPE_TAG = 'media-task-completed'
export const TEAMMATE_ENVELOPE_TAG = 'teammate-message'

const RELAY_ENVELOPE_TAGS = [MEDIA_TASK_ENVELOPE_TAG, TEAMMATE_ENVELOPE_TAG]

/** 这条 user 记录是不是我们自己投的中继消息(而不是用户说的话)。 */
export function isRelayEnvelopeMessage(text: string): boolean {
  const head = text.trimStart()
  return RELAY_ENVELOPE_TAGS.some(
    (tag) => head.startsWith(`<${tag} `) || head.startsWith(`<${tag}>`)
  )
}
