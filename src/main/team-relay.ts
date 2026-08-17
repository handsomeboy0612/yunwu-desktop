import { gatewayClient, type ChatHistoryMessage, type GatewayEventFrame } from './gateway-client'
import { TEAMMATE_ENVELOPE_TAG } from '@shared/relay-envelope'

/**
 * 专家团成员的产出回传负责人(leader)。
 *
 * # 要复现的结果
 *
 * WorkBuddy 里成员干完活,产出会**作为一条 user 消息**出现在负责人会话里,外面包一层
 * `<teammate-message teammate_id=… summary=…>`;负责人被这条消息唤醒,把各家产出汇总成
 * 最终交付。2026-08-11 读它的会话实录逐条确认过(`C:\Users\000\.workbuddy\projects\
 * <项目>\<会话>.jsonl`),四位成员各来一条,完成通知另算一条(`teammate_id="system"` 的
 * `[Framework Auto-Notification]`),两者是分开的两条消息。
 *
 * # 内核为什么送不到
 *
 * 内核自己有这条投递路径,但对我们的会话键必定失败,已在真机上抓到三次重试加放弃:
 *   `Subagent completion direct announce failed … ACP metadata is missing for
 *    agent:main:acp:e-ncre-expert-<taskId>` ×3 → `announce give up (retry-limit)`
 * 根因是任务会话键带 `acp:` 段(为了让 `sessions.patch` 收 `spawnedCwd`,
 * `openclaw/src/gateway/sessions-patch.ts:113` 的 `supportsSpawnLineage` 只认
 * `subagent:*` / `acp:*`),但会话是 `sessions.create` 造的、没有 ACP metadata,于是
 * `AcpSessionManager.resolveSession` 判 `stale` 直接抛(`agents/agent-command.ts:912`)。
 * 投递只有 direct 与 steer 两条(`agents/subagent-announce-dispatch.ts:96`),direct 撞
 * ACP,steer 要求 leader 这一轮还活着——而 leader 派完活就 `sessions_yield` 睡下了,
 * 内核的 spawn 提示词 `SUBAGENT_SPAWN_ACCEPTED_NOTE` 正是这么教它的。两条都落空后内核
 * **没有**补偿(`subagent-registry-lifecycle.ts` 只置 suspended / failed)。
 * 升内核也不解:`git show v2026.7.2-beta.7:src/agents/agent-command.ts` 里那句
 * `if (!isRawModelRun && acpResolution?.kind === "stale") throw` 一字未改。
 *
 * # 所以走 chat.send,这不是自己发明的路
 *
 * `chat.send` 与内核 direct 走的**不是**同一条:direct 走网关 `agent` RPC(要过 ACP 解析),
 * `chat.send` 是用户平时说话那条,不碰 ACP。2026-08-11 拿真会话端到端验过一遍:
 * 对一条 `status: done`、早已 yield 的 leader 会话 `chat.send` 一条包好的
 * `<teammate-message>`,12ms 返回 `{status:'started'}`,leader 醒来吃下成员那 3317 字符
 * 交付物,写出 `NCRE一级备考方案_零基础.md`(3823 字节,落在任务自己的 spawnedCwd),
 * 再 `present_files` 并给出总结——与 WorkBuddy 的结果一致。
 *
 * **那次首发上游 3 分 16 秒才回**(网关 `eventLoopUtilization=1` 被占满,日志里是
 * `active_model_call_without_progress`)。所以这里不设"多久没回就算失败"的判据:
 * 判据是耗时不是超时,投出去就算完成,后续由会话自己的生命周期事件反映。
 *
 * # 同一份产出会进两遍上下文,这是被逼的,别当 bug 修
 *
 * 2026-08-12 查清:内核两条路当场照旧全失败,但它把那次播报挂成 suspended pending delivery
 * (交互类保留 24 小时,`openclaw/src/agents/subagent-registry.ts:231`),**等负责人下一次开跑时
 * 冲进那一轮**——而负责人开跑正是我们这条 `chat.send` 的结果。于是负责人会先收到我们的
 * `<teammate-message>`(实测 8136 字符),过一会儿再收到内核的 `[Internal task completion event]`
 * (9113 字符,整份产出装在 `<prompt-data>` 里)。时间点不可控:实测它 02:54:06 才到,而负责人
 * 02:54:03 已经用我们这份写完交付物了,**所以也不能反过来让它供正文、我们只发短通知**。
 *
 * 四个候选全部堵死,别重复劳动:
 *  - `expectsCompletionMessage: false` 不在暴露给模型的 schema 里(`sessions-spawn-tool.ts:167-240`),
 *    而且它不是播报开关,只把顺序从 direct-先换成 steer-先(`subagent-announce-dispatch.ts:96-110`);
 *    它带来的跳过要 `endedAgo > 5 分钟`(`subagent-registry-helpers.ts:38`),我们一秒内就唤醒。
 *  - 配置层没有开关,`agents.defaults.subagents` 只有 `announceTimeoutMs`(`types.agent-defaults.ts:462-485`)。
 *  - kill 掉成员抑制播报也不行:`killSubagentRun` 第一行 `if (entry.endedAt) return {killed:false}`
 *    (`subagent-control.ts:170-172`),我们在 end 相位触发,已经结束了。
 *  - 让负责人醒着等,与内核自己的 `SUBAGENT_SPAWN_ACCEPTED_NOTE`(明说 push-based、不要轮询)相反。
 *
 * 上游 2026-08-02 的内核已解决,解法是拉取式:`sessions_spawn` 的 swarm `collect: true` 会
 * **强制** `expectsCompletionMessage = false`(即根本不播报),负责人改用 `agents_wait` 自己收。
 * 所以这条差异随内核升级消失,不要在 v2026.6.11 上硬造机制。
 *
 * 对照参考实现:WorkBuddy 不重复(82 份抄本 / 27 次投递 / 重复 0 组),它是「成员正文一次 +
 * 约 120 字符的 `teammate_id="system"` 框架回执(含 Duration)」,回执里零正文。
 *
 * # 成员没产出时要说真话
 *
 * WorkBuddy 在这一步是错的,别照抄:成员被 kill 之后,它的 `TaskOutput` 明明返回
 * `status: killed`,却仍附一句 *You do NOT need to wait for it — the agent will send
 * results back via SendMessage automatically*;紧接着 `SendMessage` 往死信箱投递还回
 * `Delivered`。负责人因此白等了两分钟(2026-08-11 实录)。我们这边终止/失败一律如实
 * 回执,并明说不要再等。
 */

/** 成员产出的包装格式,逐字对齐 WorkBuddy 的 `<teammate-message>`。 */
function wrapTeammateMessage(teammateId: string, summary: string, body: string): string {
  return `<${TEAMMATE_ENVELOPE_TAG} teammate_id="${escapeAttr(teammateId)}" summary="${escapeAttr(summary)}">\n${body}\n</${TEAMMATE_ENVELOPE_TAG}>`
}

/** 属性值里的引号与尖括号会把标签本身撑破,必须转义。 */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** summary 取正文首个非空行,过长截断——它只是给负责人扫一眼用的,不是产出本身。 */
function summarize(body: string, memberKey: string): string {
  const firstLine = body
    .split('\n')
    .map((l) => l.replace(/^[#>\-*\s]+/, '').trim())
    .find((l) => l.length > 0)
  const raw = firstLine || `${memberKey} 的产出`
  return raw.length > 60 ? `${raw.slice(0, 60)}…` : raw
}

/**
 * 从 `chat.history` 的一条消息里取纯文本。
 *
 * `content` 是分块数组,`thinking` 块必须丢掉:那是模型的内心戏,混进产出等于把草稿
 * 当成交付发给负责人。
 */
function textOf(message: ChatHistoryMessage): string {
  const content = message.content
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map((block) => {
      if (typeof block === 'string') {
        return block
      }
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const text = (block as { text?: unknown }).text
        return typeof text === 'string' ? text : ''
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

/** `label` 形如 `<团队>.<成员>`;回传里只用成员那一段,与 WorkBuddy 的 teammate_id 同形。 */
function teammateIdOf(memberKey: string): string {
  const dot = memberKey.indexOf('.')
  return dot >= 0 ? memberKey.slice(dot + 1) : memberKey
}

/** 内核 `sessions.changed` 里表示"这轮没跑成"的几种状态。 */
const FAILED_STATUSES = new Set(['failed', 'error', 'terminated', 'killed', 'aborted'])

interface MemberEnd {
  childSessionKey: string
  parentSessionKey: string
  memberKey: string
  failed: boolean
  status?: string
}

/**
 * 从 `sessions.changed` 帧里认出「某位成员结束了」。
 *
 * 只认**有父会话**且父会话是任务会话(带 `acp:` 段)的那些:
 *  - 没有父会话的是主会话自己,与本模块无关;
 *  - 父会话不带 `acp:` 时内核自己的 direct announce 是通的,我们再投一遍就重复了。
 * 父会话字段两个来源都要收——生命周期广播填 `parentSessionKey`,会话行快照里叫
 * `spawnedBy`,不是同一条路径填的(与 gateway-client 的 normalizeMemberEvent 同源)。
 */
function parseMemberEnd(frame: GatewayEventFrame): MemberEnd | null {
  if (frame.event !== 'sessions.changed') {
    return null
  }
  const payload = (frame.payload ?? {}) as Record<string, unknown>
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined

  if (str(payload.phase) !== 'end') {
    return null
  }
  const parentSessionKey = str(payload.parentSessionKey) ?? str(payload.spawnedBy)
  const childSessionKey = str(payload.sessionKey)
  if (!parentSessionKey || !childSessionKey || !parentSessionKey.includes(':acp:')) {
    return null
  }
  const session = (payload.session ?? {}) as Record<string, unknown>
  const status = str(session.status)
  const memberKey =
    str(payload.label) ??
    str(session.label) ??
    /^agent:([^:]+):/.exec(childSessionKey)?.[1] ??
    'teammate'
  return {
    childSessionKey,
    parentSessionKey,
    memberKey,
    failed:
      payload.abortedLastRun === true ||
      session.abortedLastRun === true ||
      FAILED_STATUSES.has(status ?? ''),
    status
  }
}

let attached = false

/**
 * 成员产出中继。挂在网关事件流上,成员会话一结束就把它的产出投给负责人。
 *
 * 去重靠 `childSessionKey`:`sessions.changed` 的 end 相位可能重复广播(重连后会重放),
 * 投两遍就是让负责人把同一份产出算两次。进程重启后这份记录会丢,但那时负责人的 run
 * 也早已不在,重复投递不会发生。
 */
export function attachTeamRelay(): void {
  // 幂等:窗口可能被重建(如 macOS activate),挂两个监听就是把同一份产出投两遍——
  // 去重集合是每个实例各一份,拦不住这种重复。
  if (attached) {
    return
  }
  attached = true

  const relayed = new Set<string>()

  const relay = async (end: MemberEnd): Promise<void> => {
    const teammateId = teammateIdOf(end.memberKey)

    if (end.failed) {
      // 说真话:不给"它稍后会自己回传"这种假承诺,否则负责人会一直等下去。
      const notice =
        `成员「${teammateId}」已终止(状态:${end.status ?? 'unknown'}),没有产出。` +
        `不要再等它,请根据现有信息继续,或改派其他成员。`
      await gatewayClient.chatSendConfirmed(
        end.parentSessionKey,
        wrapTeammateMessage('system', `${teammateId} 未完成`, notice),
        { label: `${teammateId} 未完成回执` }
      )
      return
    }

    const messages = await gatewayClient.chatHistory(end.childSessionKey)
    const body = messages
      .filter((m) => m.role === 'assistant')
      .map(textOf)
      .filter((t) => t.length > 0)
      .pop()

    if (!body) {
      const notice =
        `成员「${teammateId}」已结束,但没有留下任何文字产出。` +
        `不要再等它,请根据现有信息继续,或改派其他成员。`
      await gatewayClient.chatSendConfirmed(
        end.parentSessionKey,
        wrapTeammateMessage('system', `${teammateId} 无产出`, notice),
        { label: `${teammateId} 无产出回执` }
      )
      return
    }

    // 与媒体补投同一个理由:ack 不等于送到。成员产出丢了,负责人就一直等不到回信。
    await gatewayClient.chatSendConfirmed(
      end.parentSessionKey,
      wrapTeammateMessage(teammateId, summarize(body, teammateId), body),
      { label: `${teammateId} 产出回传` }
    )
  }

  const onFrame = (frame: GatewayEventFrame): void => {
    const end = parseMemberEnd(frame)
    if (!end || relayed.has(end.childSessionKey)) {
      return
    }
    relayed.add(end.childSessionKey)
    void relay(end).catch((err) => {
      // 投递失败只影响这一位成员的产出回传,不能连累别的成员,更不能把主进程带崩。
      // 放行重投:下一次 end 广播(重连重放)还有机会。
      relayed.delete(end.childSessionKey)
      console.error(
        `[team] 成员产出回传失败 child=${end.childSessionKey} -> ${end.parentSessionKey}: ${String(err)}`
      )
    })
  }

  gatewayClient.on('event', onFrame)
}
