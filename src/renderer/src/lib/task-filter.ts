/**
 * 侧栏任务筛选。形状照 WorkBuddy `TaskFilterMenu`
 * (`packages/agent-ui/src/components/conversation-list`, asar 解包核对):
 * 状态单选 + 时间单选,「全部」用空值表示,点已选项再点一次回到全部。
 *
 * 语言包里还有「已归档 / 昨天 / 自定义范围 / 多选」,但组件没有消费者 ——
 * 判据落到组件,不落到 i18n。
 */

export type TaskFilterStatus =
  | 'working'
  | 'completed'
  | 'failed'
  | 'pending'
  | 'planning'

export type TaskFilterDate = 'Today' | 'Last 7 days' | 'Last 30 days'

export interface TaskFilterValues {
  /** 空数组 = 全部状态。组件是单选,最多一项;结构跟它保持一致。 */
  sessionStatus: TaskFilterStatus[]
  date: TaskFilterDate | null
}

export const EMPTY_TASK_FILTER: TaskFilterValues = {
  sessionStatus: [],
  date: null
}

export function hasActiveTaskFilter(v: TaskFilterValues): boolean {
  return v.sessionStatus.length > 0 || v.date !== null
}

/** 筛选用的最小任务快照,不绑 Workspace 的 Task,方便离线探针。 */
export interface TaskFilterSnapshot {
  createdAt: number
  messages: Array<{
    role: string
    streaming?: boolean
    error?: string
    aborted?: boolean
    yielded?: boolean
    startedAt?: number
    timeline?: Array<{ kind: string; status?: string }>
  }>
  memberRuns?: Record<string, string>
}

const WORKING_FAMILY = new Set(['working', 'planning', 'running', 'connecting'])
const DAY_MS = 24 * 60 * 60 * 1000

function normalizeStatus(status: string): string {
  const value = (status ?? '').trim().toLowerCase()
  if (value === 'terminated' || value === 'error') return 'failed'
  return value
}

function isWorkingFamilyStatus(status: string): boolean {
  return WORKING_FAMILY.has(status)
}

/**
 * 某个会话状态所归属的全部筛选桶。
 *
 * 照 WorkBuddy `statusFilterBuckets` 原文:planning 既属于自身的「规划中」,
 * 也属于「进行中」大类 —— 选「进行中」时,运行中的任务不会因 working/planning
 * 之间跳变而周期性掉出结果;选「规划中」仍只精确匹配 planning。
 */
export function statusFilterBuckets(status: string): Set<string> {
  const value = normalizeStatus(status)
  const buckets = new Set([value])
  if (isWorkingFamilyStatus(value)) buckets.add('working')
  return buckets
}

/**
 * 从任务现场推导 WorkBuddy 那五个状态之一。
 *
 * 我们没有协议层的 sessionStatus,只能从消息现场还原:
 *  - pending: ask_user 正等用户作答(它那边是 pendingInputKind)
 *  - planning: 流式中,最近一条非思考时间线是 update_plan
 *  - working: 流式中 / 主动让出等专家 / 成员还在跑
 *  - failed: 出错或中止(terminated/error 在桶里也归 failed)
 *  - completed: 其余,含空任务 —— 它那边 `conv.status || "completed"`
 */
export function deriveTaskStatus(t: TaskFilterSnapshot): TaskFilterStatus {
  if (t.memberRuns) {
    for (const s of Object.values(t.memberRuns)) {
      if (s === 'running') return 'working'
    }
  }

  const last = t.messages[t.messages.length - 1]
  if (!last || last.role !== 'assistant') return 'completed'

  if (last.streaming) {
    const timeline = last.timeline ?? []
    if (timeline.some((it) => it.kind === 'ask' && it.status === 'waiting')) {
      return 'pending'
    }
    const lastSignificant = [...timeline].reverse().find((it) => it.kind !== 'thinking')
    if (lastSignificant?.kind === 'plan') return 'planning'
    return 'working'
  }

  if (last.yielded) return 'working'
  if (last.error || last.aborted) return 'failed'
  return 'completed'
}

/**
 * 侧栏行尾图标。照 WorkBuddy AgentCard `trailingStatus`:
 *  - working / planning / running → 绿色转圈
 *  - pending → PendingIcon(待确认)
 *  - failed / error / terminated → ErrorCircleIcon
 *  - completed → 不画(`shouldHideStatusIcon = COMPLETED_STATUSES.has(...)`),只留相对时间
 */
export type TaskTrailingKind = 'working' | 'pending' | 'failed'

export function taskTrailingKind(t: TaskFilterSnapshot): TaskTrailingKind | null {
  const s = deriveTaskStatus(t)
  if (s === 'working' || s === 'planning') return 'working'
  if (s === 'pending' || s === 'failed') return s
  return null
}

export const TASK_TRAILING_LABEL: Record<TaskTrailingKind, string> = {
  working: '正在执行',
  pending: '待确认',
  failed: '执行失败'
}

export function getDateStart(date: TaskFilterDate | null, now = Date.now()): number | null {
  if (!date) return null
  if (date === 'Today') {
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    return start.getTime()
  }
  if (date === 'Last 7 days') return now - 7 * DAY_MS
  if (date === 'Last 30 days') return now - 30 * DAY_MS
  return null
}

/**
 * 筛选用的时间戳。它那边是 `conv.timestamp`(按 updatedAt 排),
 * 我们没有单独的 updatedAt,就取 createdAt 与最后一轮 startedAt 的较大值。
 */
export function taskFilterTime(t: TaskFilterSnapshot): number {
  let latest = t.createdAt || 0
  for (const m of t.messages) {
    if (typeof m.startedAt === 'number' && m.startedAt > latest) latest = m.startedAt
  }
  return latest
}

export function matchesTaskFilter(
  t: TaskFilterSnapshot,
  filter: TaskFilterValues,
  now = Date.now()
): boolean {
  if (filter.sessionStatus.length > 0) {
    const buckets = statusFilterBuckets(deriveTaskStatus(t))
    if (!filter.sessionStatus.some((s) => buckets.has(s))) return false
  }
  const dateStart = getDateStart(filter.date, now)
  if (dateStart !== null && taskFilterTime(t) < dateStart) return false
  return true
}
