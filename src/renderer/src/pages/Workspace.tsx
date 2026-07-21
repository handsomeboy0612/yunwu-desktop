import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  PanelLeft,
  Search,
  SlidersHorizontal,
  Plus,
  Bot,
  FolderKanban,
  GraduationCap,
  Workflow,
  LayoutGrid,
  ChevronDown,
  Bell,
  Compass,
  Share2,
  History,
  PanelRight,
  CircleCheck,
  ChevronRight,
  Copy,
  ThumbsUp,
  ThumbsDown,
  Volume2,
  Ellipsis,
  Pin,
  Archive,
  FolderOpen,
  Pencil,
  Save,
  Trash2,
  Loader2,
  CircleX,
  FileText,
  RefreshCw,
  Circle,
  X,
  Sparkles,
  Gift
} from 'lucide-react'
import type {
  ActivationConfig,
  GatewayStatus,
  PermissionMode,
  ChatMode,
  ChatThinking,
  ChatModelOption,
  AgentEvent,
  PreflightReport,
  PreflightStatus,
  TaskMeta
} from '@shared/types'
import Composer from './Composer'
import Mascot from '../components/Mascot'
import Settings, { type PageId } from './settings/Settings'

interface Props {
  activation: ActivationConfig
  onSignOut: () => void
}

/** 工具步骤(读写文件/执行命令等),用于渲染步骤条。 */
interface ToolStep {
  itemId: string
  title: string
  /** running / completed / failed。 */
  status: string
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  /** 用户消息引用的本地文件绝对路径(用于渲染附件卡片,与正文分离)。 */
  files?: string[]
  /**
   * 助手消息所属的运行轮次 id(与网关事件 runId 对应)。
   * 新建占位时为空(待认领);收到本轮首个事件后绑定,
   * 用于把后续事件精确路由到本轮消息,并隔离网关重放的历史轮次事件。
   */
  runId?: string
  /** 助手消息是否仍在流式输出中。 */
  streaming?: boolean
  /** 本轮运行的工具步骤。 */
  steps?: ToolStep[]
  /** 深度思考内容(reasoning/thinking 流累计快照)。 */
  thinking?: string
  /** 错误信息(发送失败或运行出错)。 */
  error?: string
  /** 本轮是否被中止(用户主动或系统中止,统一表示"未正常完成")。 */
  aborted?: boolean
  /** 中止是否由用户主动点击停止触发(用于区分文案:用户已取消 vs 回复已中断)。 */
  userAborted?: boolean
}

/** 取路径文件名(兼容 Windows/POSIX 分隔符)。 */
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

/** 自检步骤状态图标。 */
function prepIcon(status: PreflightStatus) {
  switch (status) {
    case 'ok':
      return <CircleCheck size={15} strokeWidth={2} className="step-ok" />
    case 'warn':
      return <CircleCheck size={15} strokeWidth={2} className="step-warn" />
    case 'fail':
      return <CircleX size={15} strokeWidth={2} className="step-fail" />
    case 'running':
      return <Loader2 size={15} strokeWidth={2} className="step-spin" />
    default:
      return <Circle size={15} strokeWidth={2} className="step-pending" />
  }
}

interface Task {
  id: string
  title: string
  /** 稳定会话 key:与 OpenClaw 网关一一对应,保证上下文连续。 */
  sessionKey: string
  messages: ChatMessage[]
  pinned?: boolean
  /** 是否已在内核创建 agent 并纳入持久化(首次发消息后置 true;从磁盘恢复的任务为 true)。 */
  persisted?: boolean
  /** 创建时间戳(用于恢复后排序)。 */
  createdAt: number
}

/** 空态场景标签:每个场景一组建议卡,点击标签切换建议(对齐 WorkBuddy 首页)。 */
interface Scenario {
  id: string
  label: string
  suggestions: { icon: string; text: string }[]
}
const SCENARIOS: Scenario[] = [
  {
    id: 'office',
    label: '日常办公',
    suggestions: [
      { icon: '📊', text: '把这份 Excel 里的数据做成图表' },
      { icon: '📝', text: '帮我写一份项目周报（Word）' },
      { icon: '🖼️', text: '把这些图片批量压缩并重命名' },
      { icon: '📑', text: '根据大纲生成一份 PPT' }
    ]
  },
  {
    id: 'code',
    label: '代码开发',
    suggestions: [
      { icon: '🐞', text: '帮我看看这段代码为什么报错' },
      { icon: '🧪', text: '给这个函数补一份单元测试' },
      { icon: '♻️', text: '重构这个文件让它更易读' },
      { icon: '📦', text: '把这个脚本打包成可执行文件' }
    ]
  },
  {
    id: 'creative',
    label: '设计创意',
    suggestions: [
      { icon: '💡', text: '帮我头脑风暴 10 个活动主题' },
      { icon: '✍️', text: '写一段产品发布的宣传文案' },
      { icon: '🎨', text: '给这张海报配一句吸睛标题' },
      { icon: '🏷️', text: '帮我的新产品起几个名字' }
    ]
  }
]

/** 侧边栏导航项(对齐 WorkBuddy;当前为视觉占位,后续里程碑接入)。 */
const NAV_ITEMS = [
  { icon: Bot, label: '助理' },
  { icon: FolderKanban, label: '项目' },
  { icon: GraduationCap, label: '专家', tail: '技能 · 连接器' },
  { icon: Workflow, label: '自动化' },
  { icon: LayoutGrid, label: '更多', tail: '资料库 · 灵感' }
]

function newTask(): Task {
  const id = `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`
  /**
   * 每个任务映射一个 isolated agent(agentId 复用 taskId),会话固定为其主 session。
   * sessionKey 形如 agent:<taskId>:main —— agent 段隔离上下文/workspace,
   * 与 OpenClaw 原生 multi-agent 一一对应。
   */
  return { id, title: '新对话', sessionKey: `agent:${id}:main`, messages: [], createdAt: Date.now() }
}

/**
 * 恢复完成前的空兜底任务(仅用于渲染占位,不进入持久化)。
 * 避免任务列表加载期间 active 为 undefined 导致主区崩溃。
 */
const EMPTY_TASK: Task = {
  id: '__loading__',
  title: '新对话',
  sessionKey: 'agent:__loading__:main',
  messages: [],
  createdAt: 0
}

/** 任务排序:置顶优先,其次按创建时间倒序(新建在前)。 */
function sortTasks(arr: Task[]): Task[] {
  return [...arr].sort(
    (a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.createdAt - a.createdAt
  )
}

/** 把持久化的任务元数据还原为运行时 Task(消息留空,切换时懒加载历史)。 */
function metaToTask(meta: TaskMeta): Task {
  return {
    id: meta.id,
    title: meta.title,
    sessionKey: meta.sessionKey,
    pinned: meta.pinned,
    createdAt: meta.createdAt,
    messages: [],
    persisted: true
  }
}

/** 就地修补任务中最后一条助手消息(流式增量的落点)。 */
function patchLastAssistant(task: Task, patch: (m: ChatMessage) => ChatMessage): Task {
  const messages = [...task.messages]
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      messages[i] = patch(messages[i])
      return { ...task, messages }
    }
  }
  return task
}

/**
 * 定位事件应落到的助手消息下标(在传入的 messages 副本上就地认领 runId)。
 *  1) 优先匹配相同 runId 的助手消息(本轮后续增量的稳定落点);
 *  2) 否则认领"最后一条待认领(尚未绑定 runId 且仍在流式)的占位",并绑定该 runId;
 *  3) 都没有则返回 -1,表示这是网关重放的历史轮次事件或迟到事件,应忽略,
 *     避免污染当前占位——这是"第二轮先显示上一轮内容再重渲染"问题的根因。
 */
function locateTargetIndex(messages: ChatMessage[], runId?: string): number {
  if (runId) {
    const matched = messages.findIndex((m) => m.role === 'assistant' && m.runId === runId)
    if (matched >= 0) {
      return matched
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && !m.runId && m.streaming) {
      if (runId) {
        messages[i] = { ...m, runId }
      }
      return i
    }
  }
  return -1
}

/** 把一个 AgentEvent 应用到任务上(按 runId 精确路由到对应助手消息)。 */
function applyAgentEvent(task: Task, evt: AgentEvent): Task {
  const messages = [...task.messages]
  const idx = locateTargetIndex(messages, evt.runId)
  if (idx < 0) {
    // 无匹配轮次、也无待认领占位:历史重放 / 迟到事件,直接忽略以防污染当前占位。
    return task
  }
  const target = messages[idx]
  switch (evt.kind) {
    case 'delta':
      messages[idx] = {
        ...target,
        streaming: true,
        // 优先用累计快照 text;缺失时回退为增量追加。
        content: evt.text && evt.text.length ? evt.text : target.content + evt.deltaText
      }
      break
    case 'thinking':
      messages[idx] = {
        ...target,
        streaming: true,
        // 优先用累计快照;replace 或缺失时按增量追加。
        thinking:
          evt.thinkingText && evt.thinkingText.length && !evt.replace
            ? evt.thinkingText
            : (target.thinking ?? '') + evt.thinkingDelta
      }
      break
    case 'final':
      messages[idx] = {
        ...target,
        streaming: false,
        content: evt.text && evt.text.length ? evt.text : target.content
      }
      break
    case 'tool': {
      const steps = [...(target.steps ?? [])]
      const sIdx = steps.findIndex((s) => s.itemId === evt.itemId)
      const step: ToolStep = { itemId: evt.itemId, title: evt.title, status: evt.status }
      if (sIdx >= 0) {
        steps[sIdx] = step
      } else {
        steps.push(step)
      }
      messages[idx] = { ...target, streaming: true, steps }
      break
    }
    case 'lifecycle':
      if (evt.phase === 'end') {
        messages[idx] = {
          ...target,
          streaming: false,
          aborted: target.aborted || evt.aborted === true
        }
      }
      // 非 end 阶段不改内容;messages 可能已因认领而更新 runId,一并返回保存。
      break
    default:
      break
  }
  return { ...task, messages }
}

/**
 * 工作台:chat-first 布局(高保真对齐 WorkBuddy)。
 *  - 进入即自动后台启动网关,用户无感;状态收敛到左下角账户区。
 *  - 左侧:品牌 + 导航 + 任务/空间分区 + 底部账户。
 *  - 主区:圆角浮层卡片,顶栏操作图标 + 对话 + 富输入框 + 免责声明。
 */
export default function Workspace({ activation, onSignOut }: Props) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [activeId, setActiveId] = useState<string>('')
  /** 是否处于「新建任务」草稿态(未发送前不在侧栏任务列表中显示)。 */
  const [composingNew, setComposingNew] = useState<boolean>(false)
  /** 草稿任务对象(仅 composingNew 时使用,首条消息发送后写入 tasks)。 */
  const [draftTask, setDraftTask] = useState<Task | null>(null)
  /** 任务列表是否仍在从磁盘/内核恢复(启动首屏用于显示"恢复中"而非占位空任务)。 */
  const [restoring, setRestoring] = useState<boolean>(true)
  const [status, setStatus] = useState<GatewayStatus>({ running: false, port: 18789 })
  const [preflight, setPreflight] = useState<PreflightReport | null>(null)
  const [permission, setPermission] = useState<PermissionMode>('default')
  const [mode, setMode] = useState<ChatMode>('craft')
  // 会话级模型:内核完整键 `<provider>/<model>`;默认取账户默认模型(primary)。
  const [selectedModel, setSelectedModel] = useState<string>(`yunwu/${activation.defaultModel}`)
  // 可选对话模型(来自模型管理配置,含推理标记),驱动 Composer 模型选择器。
  const [chatOptions, setChatOptions] = useState<ChatModelOption[]>([])
  // 设置外壳:非空时打开,值为初始定位的页签(账户/模型/系统…)。
  const [settingsInitial, setSettingsInitial] = useState<PageId | null>(null)
  // Max 模式:关=按模型默认思考强度(Auto),开=本轮把思考强度拉到最高档(max,内核按模型上限限幅)。
  const [maxMode, setMaxMode] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [taskOpen, setTaskOpen] = useState(true)
  const [spaceOpen, setSpaceOpen] = useState(true)
  /** 空态当前选中的场景标签(驱动建议卡内容)。 */
  const [scenario, setScenario] = useState<string>(SCENARIOS[0].id)
  /** 吉祥物活动通知气泡是否展开(用户可关闭)。 */
  const [noticeOpen, setNoticeOpen] = useState(true)
  const [menuTaskId, setMenuTaskId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  /** 最新 tasks 快照(供事件回调读取,避免闭包过期)。 */
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks
  /** 上一次网关运行态,用于识别"断线→重连"的上升沿。 */
  const prevRunningRef = useRef(false)
  /** 已懒加载过历史的任务 id 集合,避免重复拉取。 */
  const loadedHistoryRef = useRef(new Set<string>())
  /** 上次已持久化的任务元数据签名,用于跳过流式期间无意义的重复写盘。 */
  const lastSavedSigRef = useRef('')

  const active =
    composingNew && draftTask
      ? draftTask
      : tasks.find((t) => t.id === activeId) ?? tasks[0] ?? EMPTY_TASK

  // 当前任务是否有正在进行的运行:最后一条助手消息仍在流式中。
  const lastMsg = active.messages[active.messages.length - 1]
  const isRunning = lastMsg?.role === 'assistant' && lastMsg.streaming === true

  // 空态当前场景(未命中时回退首个),决定建议卡展示内容。
  const activeScenario = SCENARIOS.find((s) => s.id === scenario) ?? SCENARIOS[0]

  // 自检/预热态派生:结束且 ok(或网关已在跑)= 就绪;结束且非 ok = 失败;其余为准备中。
  const preflightFailed = preflight !== null && !preflight.running && !preflight.ok
  const ready = (preflight !== null && !preflight.running && preflight.ok) || status.running

  /** 触发一次完整自检(内部会启动网关并预热连接)。 */
  function runPreflight(): void {
    void window.api.runPreflight('full').then((res) => {
      if (res.ok && res.data) setPreflight(res.data)
    })
  }

  // 进入即执行完整自检(定位内核→版本→配置→启动网关→连接→探活),用户无感预热。
  useEffect(() => {
    const offStatus = window.api.onGatewayStatus((s) => setStatus(s))
    const offPre = window.api.onPreflightStep((r) => setPreflight(r))
    runPreflight()
    return () => {
      offStatus()
      offPre()
    }
  }, [])

  // 订阅 agent 运行事件,按 sessionKey 路由到对应任务的最后一条助手消息,增量渲染。
  useEffect(() => {
    const off = window.api.onAgentEvent((evt: AgentEvent) => {
      setTasks((prev) =>
        prev.map((t) => (t.sessionKey === evt.sessionKey ? applyAgentEvent(t, evt) : t))
      )
    })
    return off
  }, [])

  /** 从模型管理配置(providers.json)加载可选对话模型;并保证当前选中模型仍有效。 */
  function refreshChatModels(): void {
    void window.api.listProviders().then((res) => {
      if (!res.ok || !res.data) {
        return
      }
      const opts: ChatModelOption[] = []
      for (const p of res.data) {
        for (const m of p.models) {
          if (m.category === 'chat') {
            opts.push({
              key: `${p.id}/${m.id}`,
              label: m.name || m.id,
              reasoning: m.reasoning,
              providerLabel: p.label,
              onlyReasoning: m.onlyReasoning,
              canDisableThinking: m.canDisableThinking,
              thinkingLevels: m.thinkingLevels,
              defaultThinkingLevel: m.defaultThinkingLevel
            })
          }
        }
      }
      setChatOptions(opts)
      setSelectedModel((cur) => (opts.some((o) => o.key === cur) ? cur : opts[0]?.key ?? cur))
    })
  }

  // 首次挂载加载可选模型。
  useEffect(() => {
    refreshChatModels()
  }, [])

  // 启动时从磁盘恢复任务列表(内核已持久化 agent/session,这里恢复 UI 元数据)。
  // 消息不随元数据存储,切换到具体任务时再从内核 session 懒加载,避免双写不一致。
  useEffect(() => {
    void (async () => {
      // 第一步:读本地元数据(毫秒级),命中即秒开首屏。
      const res = await window.api.loadTasks()
      const local = sortTasks(res.ok && res.data ? res.data.map(metaToTask) : [])
      if (local.length) {
        setTasks(local)
        // 启动默认进入「新建任务」欢迎页,不自动打开第一条历史任务(对齐 WorkBuddy)。
        setActiveId('')
        setComposingNew(true)
        setDraftTask(newTask())
        setRestoring(false)
      }
      // 第二步:后台向内核校正孤儿任务(首次迁移/外部改动),不阻塞首屏。
      const orphanRes = await window.api.discoverTaskOrphans(local.map((t) => t.id))
      const orphans = orphanRes.ok && orphanRes.data ? orphanRes.data.map(metaToTask) : []
      if (local.length) {
        // 已秒开:仅把新发现的孤儿去重追加。
        if (orphans.length) {
          setTasks((prev) => {
            const has = new Set(prev.map((t) => t.id))
            return sortTasks([...prev, ...orphans.filter((o) => !has.has(o.id))])
          })
        }
      } else {
        // 本地为空:用孤儿完成首屏;若仍无任务则进入「新建草稿」态(侧栏不占位)。
        const finalTasks = orphans.length ? sortTasks(orphans) : []
        setTasks(finalTasks)
        setActiveId('')
        setComposingNew(true)
        setDraftTask(newTask())
        setRestoring(false)
      }
    })()
  }, [])

  // 切换到某持久化任务且其消息尚未加载时,从内核 session 懒加载历史消息。
  useEffect(() => {
    const t = tasksRef.current.find((x) => x.id === activeId)
    if (!t || !t.persisted || t.messages.length > 0 || loadedHistoryRef.current.has(t.id)) {
      return
    }
    loadedHistoryRef.current.add(t.id)
    void window.api.getTaskHistory(t.id).then((res) => {
      if (res.ok && res.data && res.data.length) {
        const history = res.data
        setTasks((prev) =>
          prev.map((x) =>
            x.id === t.id && x.messages.length === 0
              ? { ...x, messages: history.map((m) => ({ role: m.role, content: m.content })) }
              : x
          )
        )
      }
    })
  }, [activeId])

  // 任务元数据变更时持久化(仅已建 agent 的任务;消息不写,靠 session jsonl 恢复)。
  useEffect(() => {
    const metas = tasks
      .filter((t) => t.persisted)
      .map((t) => ({
        id: t.id,
        title: t.title,
        sessionKey: t.sessionKey,
        pinned: t.pinned,
        createdAt: t.createdAt
      }))
    // 流式期间消息高频变化但元数据不变:签名相同则跳过,避免无谓写盘。
    const sig = JSON.stringify(metas)
    if (sig === lastSavedSigRef.current) {
      return
    }
    const timer = setTimeout(() => {
      lastSavedSigRef.current = sig
      void window.api.saveTasks(metas)
    }, 400)
    return () => clearTimeout(timer)
  }, [tasks])

  // 断线→重连(网关运行态 false→true)时,对仍在流式中的任务重放当前轮缓冲,
  // 补齐断连窗口内丢失的增量。重放走幂等的 applyAgentEvent(快照替换 / 按 itemId 覆盖),
  // 重复应用不会产生重复文本或重复步骤。
  useEffect(() => {
    const wasRunning = prevRunningRef.current
    prevRunningRef.current = status.running
    if (wasRunning || !status.running) {
      return
    }
    for (const t of tasksRef.current) {
      const lm = t.messages[t.messages.length - 1]
      if (lm?.role === 'assistant' && lm.streaming) {
        void window.api.replayAgent(t.sessionKey).then((res) => {
          if (res.ok && res.data && res.data.length) {
            const events = res.data
            setTasks((prev) =>
              prev.map((x) =>
                x.id === t.id ? events.reduce((acc, e) => applyAgentEvent(acc, e), x) : x
              )
            )
          }
        })
      }
    }
  }, [status.running])

  // 流式输出改的是内容而非消息条数,故用内容长度 + 步骤数作为滚动信号。
  const scrollSignal = active.messages.reduce(
    (n, m) => n + m.content.length + (m.steps?.length ?? 0) + (m.thinking?.length ?? 0),
    0
  )
  // 切换任务或消息变更后瞬间滚到底(useLayoutEffect 在绘制前执行,避免可见的"滑到底"动画)。
  useLayoutEffect(() => {
    const el = logRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [activeId, scrollSignal])

  function updateActive(mutator: (t: Task) => Task): void {
    setTasks((prev) => prev.map((t) => (t.id === activeId ? mutator(t) : t)))
  }

  function handleCreateTask(): void {
    setComposingNew(true)
    setDraftTask(newTask())
    setActiveId('')
  }

  /** 选中侧栏已有任务,退出新建草稿态。 */
  function selectTask(id: string): void {
    setComposingNew(false)
    setDraftTask(null)
    setActiveId(id)
  }

  /** 置顶:标记 pinned 并移动到列表首位。 */
  function handlePin(id: string): void {
    setMenuTaskId(null)
    setTasks((prev) => {
      const target = prev.find((t) => t.id === id)
      if (!target) return prev
      const rest = prev.filter((t) => t.id !== id)
      return [{ ...target, pinned: true }, ...rest]
    })
  }

  /**
   * 从列表移除任务(归档/删除的共同底层实现)。
   *  - 基于当前 tasks 计算,不在 setState 更新函数里做副作用;
   *  - 若删除的是当前激活任务,则激活切换到剩余列表首位;
   *  - 若清空则补建一个新任务并激活,避免空列表。
   */
  function removeTask(id: string): void {
    // persisted(建过 agent)或已有消息的任务:删除时一并回收其 agent/workspace/缓冲。
    // 注意:恢复的持久化任务在未切换查看前 messages 为空,必须靠 persisted 判定,
    // 否则删除后内核 agent 残留,会被下次启动的孤儿发现重新补回(删不掉)。
    const target = tasks.find((t) => t.id === id)
    if (target && (target.persisted || target.messages.length > 0)) {
      void window.api.deleteTaskAgent(id, target.sessionKey)
    }
    const next = tasks.filter((t) => t.id !== id)
    if (next.length === 0) {
      setTasks([])
      setComposingNew(true)
      setDraftTask(newTask())
      setActiveId('')
      return
    }
    setTasks(next)
    if (id === activeId) {
      setComposingNew(false)
      setDraftTask(null)
      setActiveId(next[0].id)
    }
  }

  /** 归档:轻量移除,无需二次确认。 */
  function handleArchive(id: string): void {
    setMenuTaskId(null)
    removeTask(id)
  }

  /** 请求删除:打开二次确认弹窗(防误删)。 */
  function requestDelete(id: string): void {
    setMenuTaskId(null)
    setDeleteId(id)
  }

  /** 确认删除:执行移除并关闭弹窗。 */
  function confirmDelete(): void {
    if (!deleteId) return
    removeTask(deleteId)
    setDeleteId(null)
  }

  /** 开始重命名:进入行内编辑态。 */
  function startRename(id: string, title: string): void {
    setMenuTaskId(null)
    setEditingId(id)
    setEditText(title)
  }

  /** 提交重命名:非空则写回标题。 */
  function commitRename(): void {
    const id = editingId
    if (!id) return
    const title = editText.trim()
    if (title) {
      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)))
    }
    setEditingId(null)
    setEditText('')
  }

  /** 终止当前任务运行:即时把最后一条助手消息标记为已取消,并向网关发送中断。 */
  async function handleAbort(): Promise<void> {
    const sessionKey = active.sessionKey
    updateActive((t) =>
      patchLastAssistant(t, (m) => ({ ...m, streaming: false, aborted: true, userAborted: true }))
    )
    await window.api.abortAgent(sessionKey)
  }

  async function handleSend(text: string, files: string[]): Promise<void> {
    // 发送给 agent 的文本仍需带上文件绝对路径(agent 据此读写);
    // 但 UI 展示时把文件与正文分离,正文只保留用户输入的纯文本。
    const refs = files.length ? `\n\n引用文件:\n${files.map((f) => `· ${f}`).join('\n')}` : ''
    // 按对话模式注入系统指令前缀(仅进入发送内容,不进入 UI 展示)。
    // openclaw 工具白名单为配置级、不支持每轮传参,故此处以 prompt 软约束实现模式差异。
    const modePrompt =
      mode === 'ask'
        ? '【对话模式:仅问答】请只进行只读分析与回答,不要修改任何文件、不要执行有副作用的命令或工具。\n\n'
        : mode === 'plan'
          ? '【对话模式:规划】请先输出一份清晰的分步执行计划,不要直接修改文件或执行命令;等我确认后再执行。\n\n'
          : ''
    const sentContent = modePrompt + text + refs
    // 任务列表尚未就绪(占位任务)时忽略发送,避免为 '__loading__' 创建无效 agent。
    if (active.id === EMPTY_TASK.id) {
      return
    }

    const userMsg: ChatMessage = {
      role: 'user',
      content: text,
      files: files.length ? files : undefined
    }
    const placeholder: ChatMessage = { role: 'assistant', content: '', streaming: true, steps: [] }

    let sessionKey: string
    let agentId: string

    if (composingNew) {
      // 首条消息发送时才把任务写入侧栏列表(对齐 WorkBuddy)。
      const t = draftTask ?? newTask()
      agentId = t.id
      sessionKey = t.sessionKey
      const title = text.slice(0, 20) || t.title
      setTasks((prev) => [
        { ...t, title, messages: [userMsg, placeholder] },
        ...prev
      ])
      setActiveId(agentId)
      setComposingNew(false)
      setDraftTask(null)
    } else {
      sessionKey = active.sessionKey
      agentId = active.id
      updateActive((t) => ({
        ...t,
        title: t.messages.length === 0 ? text.slice(0, 20) || t.title : t.title,
        messages: [...t.messages, userMsg, placeholder]
      }))
    }

    // 惰性创建该任务的 isolated agent(首次发消息时);幂等,已存在则直接返回。
    const ensured = await window.api.ensureTaskAgent(agentId)
    if (!ensured.ok) {
      setTasks((prev) =>
        prev.map((t) =>
          t.sessionKey === sessionKey
            ? patchLastAssistant(t, (m) => ({
                ...m,
                streaming: false,
                error: ensured.error || '任务初始化失败,请稍后重试。'
              }))
            : t
        )
      )
      return
    }
    // agent 已就绪:标记该任务纳入持久化(重启后可恢复,历史从 session 读取)。
    setTasks((prev) => prev.map((t) => (t.id === agentId ? { ...t, persisted: true } : t)))

    // 当前选中模型是否为推理模型:非推理模型不下发思考档位(避免无谓 reasoning_effort)。
    const selOption = chatOptions.find((o) => o.key === selectedModel)
    const selIsReasoning = selOption?.reasoning ?? false
    // 模型默认思考强度(Auto):优先模型声明的默认;否则取可用档位中的最高档。
    const selLevels = selOption?.thinkingLevels?.length
      ? selOption.thinkingLevels
      : (['low', 'medium', 'high'] as Exclude<ChatThinking, 'off'>[])
    const autoLevel: Exclude<ChatThinking, 'off'> =
      selOption?.defaultThinkingLevel && selLevels.includes(selOption.defaultThinkingLevel)
        ? selOption.defaultThinkingLevel
        : selLevels[selLevels.length - 1]
    // Max 开=本轮拉满(max,内核按模型上限限幅);关=Auto(模型默认强度);非推理模型统一 off。
    const effectiveThinking: ChatThinking = !selIsReasoning ? 'off' : maxMode ? 'max' : autoLevel
    const res = await window.api.sendAgent(sessionKey, sentContent, {
      model: selectedModel || undefined,
      thinking: effectiveThinking
    })
    if (!res.ok) {
      // 发送失败:把最后一条助手消息标记为错误态。
      setTasks((prev) =>
        prev.map((t) =>
          t.sessionKey === sessionKey
            ? patchLastAssistant(t, (m) => ({
                ...m,
                streaming: false,
                error: res.error || '发送失败,请确认本地引擎已就绪后重试。'
              }))
            : t
        )
      )
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="brand-sm">
            <div className="brand-text">
              <span className="brand-name">云雾助手</span>
              <span className="brand-ver">v0.1.0</span>
            </div>
          </div>
          <div className="head-icons">
            <button className="icon-btn" title="收起侧栏">
              <PanelLeft size={15} strokeWidth={1.6} />
            </button>
            <button className="icon-btn" title="搜索">
              <Search size={15} strokeWidth={1.6} />
            </button>
            <button className="icon-btn" title="筛选">
              <SlidersHorizontal size={15} strokeWidth={1.6} />
            </button>
          </div>
        </div>

        <nav className="nav">
          <button
            className={`nav-item primary${composingNew ? ' active' : ''}`}
            onClick={handleCreateTask}
            disabled={restoring}
          >
            <Plus size={16} strokeWidth={2} className="nav-ico" />
            <span className="nav-label">新建任务</span>
          </button>
          {NAV_ITEMS.map((n) => (
            <button key={n.label} className="nav-item" title="即将上线">
              <n.icon size={16} strokeWidth={1.8} className="nav-ico" />
              <span className="nav-label">{n.label}</span>
              {n.tail && <span className="nav-tail">{n.tail}</span>}
            </button>
          ))}
        </nav>

        <div className="side-section">
          <button className="side-section-title" onClick={() => setTaskOpen((v) => !v)}>
            <ChevronDown
              size={14}
              strokeWidth={2}
              className={`sec-caret ${taskOpen ? '' : 'collapsed'}`}
            />
            任务 ({restoring && tasks.length === 0 ? '…' : tasks.length})
          </button>
          {taskOpen && restoring && tasks.length === 0 && (
            <ul className="task-list">
              <li className="task-item">
                <Loader2 size={14} strokeWidth={2} className="step-spin" />
                <span className="task-title">正在恢复任务…</span>
              </li>
            </ul>
          )}
          {taskOpen && !(restoring && tasks.length === 0) && (
            <ul className="task-list">
              {tasks.map((t) => (
                <li
                  key={t.id}
                  className={!composingNew && t.id === activeId ? 'task-item active' : 'task-item'}
                  onClick={() => editingId !== t.id && selectTask(t.id)}
                >
                  {t.pinned && <Pin size={12} strokeWidth={2} className="task-pin-mark" />}
                  {editingId === t.id ? (
                    <input
                      className="task-rename"
                      value={editText}
                      autoFocus
                      onChange={(e) => setEditText(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename()
                        if (e.key === 'Escape') {
                          setEditingId(null)
                          setEditText('')
                        }
                      }}
                    />
                  ) : (
                    <span className="task-title">{t.title}</span>
                  )}
                  <div className="task-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="task-act"
                      title="更多"
                      onClick={() => setMenuTaskId((v) => (v === t.id ? null : t.id))}
                    >
                      <Ellipsis size={15} strokeWidth={2} />
                    </button>
                    <button className="task-act" title="归档" onClick={() => handleArchive(t.id)}>
                      <Archive size={14} strokeWidth={1.8} />
                    </button>
                    <button className="task-act" title="置顶" onClick={() => handlePin(t.id)}>
                      <Pin size={14} strokeWidth={1.8} />
                    </button>
                  </div>
                  {menuTaskId === t.id && (
                    <>
                      <div className="menu-mask" onClick={() => setMenuTaskId(null)} />
                      <div className="task-menu">
                        <button
                          className="task-menu-item"
                          onClick={() => {
                            void window.api.openWorkspaceDir()
                            setMenuTaskId(null)
                          }}
                        >
                          <FolderOpen size={15} strokeWidth={1.8} />
                          打开文件夹
                        </button>
                        <button className="task-menu-item" onClick={() => startRename(t.id, t.title)}>
                          <Pencil size={15} strokeWidth={1.8} />
                          重命名
                        </button>
                        <button
                          className="task-menu-item"
                          title="即将支持"
                          onClick={() => setMenuTaskId(null)}
                        >
                          <Save size={15} strokeWidth={1.8} />
                          保存到工作空间
                        </button>
                        <button
                          className="task-menu-item"
                          title="即将支持"
                          onClick={() => setMenuTaskId(null)}
                        >
                          <Share2 size={15} strokeWidth={1.8} />
                          分享任务
                        </button>
                        <div className="task-menu-sep" />
                        <button
                          className="task-menu-item danger"
                          onClick={() => requestDelete(t.id)}
                        >
                          <Trash2 size={15} strokeWidth={1.8} />
                          删除任务
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="side-section">
          <button className="side-section-title" onClick={() => setSpaceOpen((v) => !v)}>
            <ChevronDown
              size={14}
              strokeWidth={2}
              className={`sec-caret ${spaceOpen ? '' : 'collapsed'}`}
            />
            空间 (1)
          </button>
          {spaceOpen && (
            <ul className="task-list">
              <li className="task-item">
                <span className="task-title">项目新手指引</span>
                <ChevronRight size={14} strokeWidth={2} className="task-chevron" />
              </li>
            </ul>
          )}
        </div>

        <div className="sidebar-foot">
          <div className="account">
            <button className="account-trigger" onClick={() => setAccountOpen((v) => !v)}>
              <div className="avatar sm">
                云
                <span className={`avatar-badge ${ready ? 'on' : 'off'}`} />
              </div>
              <div className="account-info">
                <span className="account-name">云雾账户</span>
                <span className="account-sub">
                  {ready ? '就绪' : preflightFailed ? '启动失败' : '准备中…'}
                </span>
              </div>
            </button>
            <button className="icon-btn" title="通知">
              <Bell size={15} strokeWidth={1.6} />
            </button>
            <button className="icon-btn" title="发现">
              <Compass size={15} strokeWidth={1.6} />
            </button>
            {accountOpen && (
              <>
                <div className="menu-mask" onClick={() => setAccountOpen(false)} />
                <div className="account-menu up">
                  <div className="account-row">
                    <span>云雾</span>
                    <b className="mono">{activation.baseUrl}</b>
                  </div>
                  <div className="account-row">
                    <span>默认模型</span>
                    <b className="mono">{activation.defaultModel}</b>
                  </div>
                  <div className="account-row">
                    <span>可用模型</span>
                    <b>{activation.models.length}</b>
                  </div>
                  <div className="account-sep" />
                  <button
                    className="account-action"
                    onClick={() => {
                      setAccountOpen(false)
                      setSettingsInitial('account')
                    }}
                  >
                    设置
                  </button>
                  <button
                    className="account-action"
                    onClick={() => {
                      setAccountOpen(false)
                      setSettingsInitial('models')
                    }}
                  >
                    模型管理
                  </button>
                  <button className="account-action" onClick={() => window.api.openWorkspaceDir()}>
                    打开工作区文件夹
                  </button>
                  <button
                    className="account-action danger"
                    onClick={async () => {
                      await window.api.clearActivation()
                      onSignOut()
                    }}
                  >
                    退出登录
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="main-head">
          <div className="main-title">{active.title}</div>
          <div className="head-actions">
            <button className="growth-pill" title="即将上线">
              <Gift size={14} strokeWidth={1.8} />
              来成长计划赚积分
              <ChevronRight size={13} strokeWidth={2} className="growth-caret" />
            </button>
            <button className="icon-btn" title="搜索">
              <Search size={15} strokeWidth={1.6} />
            </button>
            <button className="icon-btn" title="分享">
              <Share2 size={15} strokeWidth={1.6} />
            </button>
            <button className="icon-btn" title="历史">
              <History size={15} strokeWidth={1.6} />
            </button>
            <button className="icon-btn" title="侧栏">
              <PanelRight size={15} strokeWidth={1.6} />
            </button>
          </div>
        </header>

        <div className="chat-log" ref={logRef}>
          {active.messages.length === 0 ? (
            <div className="empty-state">
              <div className="empty-logo">云</div>
              <h2>今天需要我帮你做点什么?</h2>
              <p className="muted">在本地处理文档、表格、图片,或让我帮你查资料、整理内容。</p>
              {ready ? (
                <>
                  <div className="scenario-tabs">
                    {SCENARIOS.map((s) => (
                      <button
                        key={s.id}
                        className={`scenario-tab${s.id === scenario ? ' active' : ''}`}
                        onClick={() => setScenario(s.id)}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                  <div className="suggestions">
                    {activeScenario.suggestions.map((s) => (
                      <button key={s.text} className="suggestion" onClick={() => void handleSend(s.text, [])}>
                        <span className="suggestion-icon">{s.icon}</span>
                        <span>{s.text}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <div className="prepare-panel">
                  <div className="prepare-head">
                    {preflightFailed ? (
                      <span className="prepare-title fail">启动检查未通过</span>
                    ) : (
                      <span className="prepare-title">
                        <Loader2 size={14} strokeWidth={2} className="step-spin" />
                        正在准备本地引擎…
                      </span>
                    )}
                  </div>
                  <div className="prepare-steps">
                    {(preflight?.steps ?? []).map((s) => (
                      <div key={s.id} className={`prep-step ${s.status}`}>
                        {prepIcon(s.status)}
                        <span className="prep-label">{s.label}</span>
                        {(s.hint || s.error) && (
                          <span className="prep-hint">{s.error || s.hint}</span>
                        )}
                      </div>
                    ))}
                  </div>
                  {preflightFailed && (
                    <button className="prepare-retry" onClick={runPreflight}>
                      <RefreshCw size={14} strokeWidth={2} />
                      重试
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            active.messages.map((m, i) =>
              m.role === 'assistant' ? (
                <div key={i} className="msg assistant">
                  <div className="msg-head">
                    <div className="msg-avatar">云</div>
                    <span className="msg-name">云雾助手</span>
                  </div>
                  {m.steps?.map((s) => (
                    <div key={s.itemId} className="msg-step">
                      {s.status === 'completed' ? (
                        <CircleCheck size={15} strokeWidth={2} className="step-ok" />
                      ) : s.status === 'failed' ? (
                        <CircleX size={15} strokeWidth={2} className="step-fail" />
                      ) : (
                        <Loader2 size={15} strokeWidth={2} className="step-spin" />
                      )}
                      {s.title}
                    </div>
                  ))}
                  {m.thinking &&
                    (m.streaming && !m.content ? (
                      <div className="msg-reasoning live">
                        <div className="reasoning-head">
                          <Loader2 size={14} strokeWidth={2} className="step-spin" />
                          深度思考
                        </div>
                        <div className="reasoning-body">{m.thinking}</div>
                      </div>
                    ) : (
                      <details className="msg-reasoning">
                        <summary className="reasoning-summary">深度思考</summary>
                        <div className="reasoning-body">{m.thinking}</div>
                      </details>
                    ))}
                  {m.content && <div className="msg-content">{m.content}</div>}
                  {m.streaming && !m.content && !m.thinking && (
                    <div className="msg-thinking">
                      <Loader2 size={15} strokeWidth={2} className="step-spin" />
                      思考中…
                    </div>
                  )}
                  {m.error && <div className="msg-error">{m.error}</div>}
                  {m.aborted && (
                    <div className="msg-cancelled">
                      {m.userAborted ? '用户已取消' : '本轮回复已中断,请点击「继续」或重试'}
                    </div>
                  )}
                  {!m.streaming && !m.error && !m.aborted && !m.content && !m.thinking && (
                    <div className="msg-cancelled">本轮未返回文本内容,请点击「继续」或重试</div>
                  )}
                  {!m.streaming && !m.error && (m.content || m.aborted || m.thinking) && (
                    <div className="msg-actions">
                      <button className="msg-act" title="复制" onClick={() => navigator.clipboard?.writeText(m.content)}>
                        <Copy size={15} strokeWidth={1.8} />
                      </button>
                      <button className="msg-act" title="赞">
                        <ThumbsUp size={15} strokeWidth={1.8} />
                      </button>
                      <button className="msg-act" title="踩">
                        <ThumbsDown size={15} strokeWidth={1.8} />
                      </button>
                      <button className="msg-act" title="朗读">
                        <Volume2 size={15} strokeWidth={1.8} />
                      </button>
                      <button className="msg-act" title="更多">
                        <Ellipsis size={15} strokeWidth={1.8} />
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div key={i} className="msg user">
                  {(m.content || (m.files && m.files.length > 0)) && (
                    <div className="msg-content">
                      {m.files?.map((f) => (
                        <span key={f} className="file-chip inline" title={f}>
                          <FileText size={14} strokeWidth={1.8} className="file-chip-icon" />
                          <span className="file-chip-name">{baseName(f)}</span>
                        </span>
                      ))}
                      {m.content}
                    </div>
                  )}
                </div>
              )
            )
          )}
        </div>

        <div className="composer-zone">
          {active.messages.length === 0 && ready && (
            <div className="mascot-dock">
              {noticeOpen && (
                <div className="mascot-notice">
                  <button
                    className="mascot-notice-x"
                    onClick={() => setNoticeOpen(false)}
                    title="关闭"
                    aria-label="关闭通知"
                  >
                    <X size={13} strokeWidth={2.2} />
                  </button>
                  <div className="mascot-notice-title">
                    <Sparkles size={13} strokeWidth={2} />
                    活动通知
                  </div>
                  <div className="mascot-notice-text">
                    云雾助手抢先体验:本地办公 Agent 全能力开放,一次导入令牌,文档 / 表格 / PPT 全在本机搞定。
                  </div>
                  <button className="mascot-notice-cta" onClick={() => setNoticeOpen(false)}>
                    立即体验
                    <ChevronRight size={13} strokeWidth={2.4} />
                  </button>
                </div>
              )}
              <button
                className="mascot"
                onClick={() => setNoticeOpen((v) => !v)}
                title="云雾助手"
                aria-label="云雾助手"
              >
                <Mascot />
              </button>
            </div>
          )}

          <Composer
            permission={permission}
            onPermissionChange={setPermission}
            mode={mode}
            onModeChange={setMode}
            onSend={handleSend}
            running={isRunning}
            onAbort={() => void handleAbort()}
            models={chatOptions}
            model={selectedModel}
            onModelChange={setSelectedModel}
            onOpenModelSettings={() => setSettingsInitial('models')}
            maxMode={maxMode}
            onMaxModeChange={setMaxMode}
          />
        </div>
        <div className="disclaimer">内容由 AI 生成,请核实重要信息</div>
      </main>

      {settingsInitial && (
        <Settings
          activation={activation}
          initial={settingsInitial}
          onClose={() => setSettingsInitial(null)}
          onSignOut={onSignOut}
          onModelsChanged={refreshChatModels}
        />
      )}

      {deleteId && (
        <div className="modal-mask" onClick={() => setDeleteId(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">删除对话</h3>
            <p className="modal-text">
              删除后不可恢复,确定删除「{tasks.find((t) => t.id === deleteId)?.title ?? '该对话'}」吗?
            </p>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setDeleteId(null)}>
                取消
              </button>
              <button className="btn-danger" onClick={confirmDelete}>
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
