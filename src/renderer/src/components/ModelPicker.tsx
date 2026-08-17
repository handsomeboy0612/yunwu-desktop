import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check, Search, X } from 'lucide-react'
import type { ModelInfo } from '@shared/types'
import { vendorOf, vendorRank, type Vendor } from '../lib/model-vendor'
import { moveBefore, togglePicked } from '../lib/model-order'
import LoadingLottie from './LoadingLottie'
import FloatingMask from './FloatingMask'

/**
 * 初值只要求 id,能力标记可缺。
 *
 * 调用方手上常常不是完整的 `ModelInfo`:设置页传的是供货商里那份 `ProviderModel`,
 * 它没有 `search` 这类后加的标记。而能力标记本来就该以**现拉的可选池**为准
 * (那才是这把 key 此刻的真相),初值只在「已选但这次拉不到」时用来占位。
 */
type PickerSeed = { id: string } & Partial<Omit<ModelInfo, 'id'>>

/** 占位项补成完整形状:拉不到的模型只有 id 可靠,能力标记缺省即当作没有。 */
function toModelInfo(seed: PickerSeed): ModelInfo {
  return {
    id: seed.id,
    reasoning: seed.reasoning ?? false,
    vision: seed.vision ?? false,
    // 与 `deriveModelInfo` 在 tags 为空时的兜底同口径:工具调用按有算。
    tools: seed.tools ?? true,
    search: seed.search ?? false,
    category: seed.category ?? 'chat'
  }
}

interface Props {
  /** 初始勾选的模型。传空则由可选池的 preset 决定(首启用)。 */
  initial?: PickerSeed[]
  /** 弹窗标题。 */
  title: string
  /** 一句话说明,解释这些模型花的是谁的钱。 */
  hint: string
  /** 确认按钮文案。 */
  confirmText: string
  /** 能不能关掉。首启那次不能——不选模型进主界面就是个空壳。 */
  dismissible: boolean
  /**
   * 内联形态:不套遮罩、不画边框,由外层容器决定尺寸。
   *
   * 首次登录用内联,设置页用弹窗 —— 这是照 WorkBuddy 分的。它的引导组件虽然叫
   * `OnboardingModal`,根类名却是 `ob-inline`(`inspiration-<hash>.js`),CSS 里它自己的注释
   * 写着 *Onboarding — 2-step inline flow matching design mockups*;而「之后再改偏好」走的是
   * 另一个真弹窗 `SettingsModal`(`inspiration-modal-overlay` + 关闭 X)。
   * 首次配置是流程的一步,不该长成一个盖在别的东西上、随时能被关掉的框。
   */
  inline?: boolean
  onCancel?: () => void
  onConfirm: (models: ModelInfo[]) => void | Promise<void>
  /**
   * 可选池拉不下来时的退路(只有拉失败才会露出来)。
   *
   * 不可关闭的弹窗必须留这一条:令牌没有模型权限、或接口这会儿抽风时,池子是空的、
   * 又勾不了任何东西,没有退路就是把人锁死在一个关不掉的框里。走这条路不写选择,
   * 下次登录还会再问一次。
   */
  onSkip?: () => void
}

/** 超过这个数只是提醒一句,不拦。上限没有真实成本(见 P5:预热成本与模型数无关)。 */
const SOFT_LIMIT = 10

type Filter = 'all' | 'reasoning' | 'vision' | 'search' | 'picked'

/**
 * 筛选。**刻意没有「工具调用」这一档**:云雾 `/v1/models` 只有一半条目带 tags,
 * 而 `deriveModelInfo` 在 tags 为空时把 `tools` 兜底成 true,于是它对绝大多数模型恒真
 * ——做成筛选项等于给一个筛不掉任何东西的按钮,做成行内图标等于每行挂一个不带信息的扳手。
 *
 * 「联网」这一档反过来满足上面那条判据(真机 481 条里只有 20 条命中),而且它有个别处没有的
 * 作用:专家查资料用的 `web_search` 后端就是从**已选清单里带这个标记的**挑
 * (`config-writer.ts:accountSearchModels`),所以用户需要一个入口看清「我选的这些谁能联网」。
 */
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'reasoning', label: '推理' },
  { id: 'vision', label: '识图' },
  { id: 'search', label: '联网' },
  { id: 'picked', label: '只看已选' }
]

/**
 * 对话模型选择器:从**这把 key 此刻真能调的**模型里勾。
 *
 * 首次登录弹一次(`dismissible=false`),之后设置→模型页复用同一个组件。两处共用是刻意的:
 * 「预勾哪些、怎么排、能力标记怎么显示」只有一份实现,不会两处走样。
 *
 * 可选池每次打开都现拉,不缓存 —— 能不能调到取决于渠道分组与令牌路由,是会变的,
 * 缓存住会骗人(用户看着有、点下去 404)。
 *
 * 交互形状的两个来源:WorkBuddy 的 `model-select` 给了单条与分组的样子(见 `lib/model-vendor.ts`);
 * 「多选」这一半它没有(它是单选短列表),参考 Cherry Studio 的 `ModelSelectorV2`
 * (同形状:Electron + React 的 LLM 桌面端,PR CherryHQ/cherry-studio#14490)——
 * 搜索 + 分组 sticky 头 + 筛选 chips + 键盘导航,再加已选 chips 让选中项始终可见。
 * **它那个 PR 记的 I2 缺陷正好是这里要避开的**:多选模式下每次勾选都把焦点重置回第一行。
 * 所以下面的 `cursor` 只随方向键与搜索变化,勾选一律不动它。
 *
 * 刻意不做虚拟滚动:海外站可选池 263 条、本机 56 条,离需要虚拟化的量级(>500)还很远,
 * 而虚拟化会把 sticky 分组头和「滚到光标处」都变复杂。量到那一步再说。
 *
 * 已选 chips 可拖动排序,这一条**没有现成参考**,是补我们自己欠的:WorkBuddy 的默认模型是
 * 显式单选(`zh-cn-<hash>.js` 的 `colleagues.createDialog.configIntro`「为助理选择一款默认模型」
 * + `model.headerTitle`/`recommended` 一个列表),因为它的清单固定、不由用户增删;ClawX 里也
 * 搜不到任何排序库(`dnd-kit`/`useSortable`/`arrayMove` 命中 0)。而内核只认一个
 * `agents.defaults.model.primary`(`config-writer.ts:274` 取清单第一条)——是我们自己把
 * 「顺序」赋予了含义,那就得让顺序可操作,否则想换默认模型只能把前面几条全取消再按序重勾。
 */
export default function ModelPicker({
  initial,
  title,
  hint,
  confirmText,
  dismissible,
  inline,
  onCancel,
  onConfirm,
  onSkip
}: Props) {
  const [pool, setPool] = useState<ModelInfo[]>(() => (initial ?? []).map(toModelInfo))
  /** 可选池是不是拉失败了(与"拉到了但一个都没勾"要分开:只有前者才给退路)。 */
  const [poolFailed, setPoolFailed] = useState(false)
  /**
   * 已选清单的顺序,**唯一真源**:勾选、取消、拖动排序全改这一个数组,回传的就是它。
   *
   * 原来这里是「打开那刻的顺序 + 一个 picked 集合」两份状态,回传时现算
   * (`orderPicked`)。加拖动排序后那个形状站不住:拖动改的是顺序,而顺序又是从
   * 「打开那刻」推出来的,两份状态必然打架。改成单一数组后勾选=追加、取消=摘掉、
   * 拖动=换位,三件事都只是数组操作。
   */
  const [order, setOrder] = useState<string[]>((initial ?? []).map((m) => m.id))
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  /** 键盘光标所在行(在 flat 里的下标);-1 表示还没用过键盘。 */
  const [cursor, setCursor] = useState(-1)
  /**
   * 正在拖的那个 chip。**ref 是判据,state 只用来画样式**。
   *
   * 不能只用 state:`dragstart` 之后紧跟的 `dragenter` 里,闭包读到的还是这一帧的旧值
   * (null),换位就整个不发生。真实鼠标拖动因为两个事件之间隔了帧,多半碰对,但这属于
   * 「靠时序侥幸」——2026-08-17 用合成事件一试就现形。
   */
  const dragIdRef = useRef<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  /** 勾没勾中,从顺序数组派生 —— 不再单独存一份,免得两份状态对不上。 */
  const picked = useMemo(() => new Set(order), [order])

  useEffect(() => {
    void (async () => {
      const res = await window.api.availableModels()
      if (!res.ok || !res.data) {
        setError(res.error ?? '拉取模型清单失败')
        setPoolFailed(true)
        setLoading(false)
        return
      }
      // 用户已选、但这把 key 现在拉不到的模型仍要留在池子里 —— 否则确认一次就把它们
      // 静默删了,而用户只是打开看看。合并时以拉到的那份为准(能力标记更新)。
      const seen = new Set(res.data.models.map((m) => m.id))
      const kept = (initial ?? []).filter((m) => !seen.has(m.id)).map(toModelInfo)
      setPool([...res.data.models, ...kept])
      // 没给初值时才用 preset:设置页是「改现有清单」,不该被预勾覆盖。
      if (!initial || initial.length === 0) {
        setOrder(res.data.preset)
      }
      setLoading(false)
    })()
  }, [])

  /** 过滤后按厂商分好组;组内按名字排,组间按 VENDORS 的顺序,「其他」垫底。 */
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const hit = pool.filter((m) => {
      const s = m.id.toLowerCase()
      // 搜索同时匹配模型名与厂商名,这样输入「谷歌」「通义」也找得到。
      if (q && !s.includes(q) && !vendorOf(m.id).label.toLowerCase().includes(q)) {
        return false
      }
      if (filter === 'reasoning') return m.reasoning
      if (filter === 'vision') return m.vision
      if (filter === 'search') return m.search
      if (filter === 'picked') return picked.has(m.id)
      return true
    })
    const bucket = new Map<string, { vendor: Vendor; models: ModelInfo[] }>()
    for (const m of hit) {
      const v = vendorOf(m.id)
      let slot = bucket.get(v.id)
      if (!slot) {
        slot = { vendor: v, models: [] }
        bucket.set(v.id, slot)
      }
      slot.models.push(m)
    }
    return [...bucket.values()]
      .map((g) => ({
        ...g,
        models: g.models.sort((a, b) => a.id.localeCompare(b.id))
      }))
      .sort((a, b) => vendorRank(a.vendor.id) - vendorRank(b.vendor.id))
  }, [pool, query, filter, picked])

  /** 分组拍平成一维,给键盘导航当索引用。 */
  const flat = useMemo(() => groups.flatMap((g) => g.models.map((m) => m.id)), [groups])

  /**
   * 已选的模型对象,顺序即 `order`,也就是**回传与展示是同一份顺序**。
   *
   * 池子里查不到的 id 直接丢掉:那是「已选但这把 key 现在拉不到」之外的脏数据
   * (池子已经把拉不到的那批补进去了,见上面的 `kept`)。
   */
  const pickedModels = useMemo(() => {
    const byId = new Map(pool.map((m) => [m.id, m]))
    return order.map((id) => byId.get(id)).filter((m): m is ModelInfo => !!m)
  }, [order, pool])

  /** 只有一个 chip 时排序没有意义,连抓握光标都不该给(不然是个骗人的手势)。 */
  const sortable = pickedModels.length > 1

  // 换了搜索词/筛选,原来的光标位置已无意义,收回去。
  useEffect(() => setCursor(-1), [query, filter])

  useEffect(() => {
    if (cursor < 0 || !listRef.current) return
    const node = listRef.current.querySelector(`[data-row="${cursor}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  /**
   * 勾选/取消。顺序运算在 `lib/model-order.ts`(那份有离线判据)。
   *
   * 这里用函数式更新而不是读闭包里那份:后者同一个 tick 内连发两次切换只会生效一次
   * (CDP 里连点两行复原选择时抓到过,第二下丢了)。
   */
  function toggle(id: string): void {
    setOrder((prev) => togglePicked(prev, id))
    if (error) setError('')
  }

  /** 拖动换位:**在 dragenter 就换**(不是等松手),拖的过程里就能看见新次序。 */
  function reorder(dragged: string, target: string): void {
    setOrder((prev) => moveBefore(prev, dragged, target))
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (flat.length === 0) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setCursor((c) => {
        const next = c < 0 ? (step > 0 ? 0 : flat.length - 1) : c + step
        return Math.max(0, Math.min(flat.length - 1, next))
      })
      return
    }
    // Enter 在搜索框里也生效(勾当前光标行);空格要留给输入,只在光标已经在用时才拦。
    const isSpace = e.key === ' '
    if ((e.key === 'Enter' || isSpace) && cursor >= 0) {
      if (isSpace && (e.target as HTMLElement).tagName === 'INPUT' && query) return
      e.preventDefault()
      toggle(flat[cursor])
    }
  }

  async function confirm(): Promise<void> {
    if (pickedModels.length === 0) {
      setError('至少选一个对话模型')
      return
    }
    setError('')
    setBusy(true)
    try {
      await onConfirm(pickedModels)
    } finally {
      setBusy(false)
    }
  }

  function renderRow(m: ModelInfo, row: number): ReactNode {
    const on = picked.has(m.id)
    const v = vendorOf(m.id)
    return (
      <div
        key={m.id}
        data-row={row}
        role="option"
        aria-selected={on}
        className={`mp-row${on ? ' on' : ''}${row === cursor ? ' cursor' : ''}`}
        onClick={() => toggle(m.id)}
        onMouseMove={() => cursor >= 0 && cursor !== row && setCursor(row)}
      >
        <span className="mp-mark" style={{ background: v.color }}>
          {v.mark}
        </span>
        <span className="mp-name">{m.id}</span>
        {m.reasoning && <span className="mp-badge think">推理</span>}
        {m.vision && <span className="mp-badge">识图</span>}
        {/* 这个标记不只是信息:勾了带「联网」的,专家查资料就用它当 web_search 后端。 */}
        {m.search && <span className="mp-badge">联网</span>}
        <span className="mp-check">{on && <Check size={14} strokeWidth={2.5} />}</span>
      </div>
    )
  }

  let row = -1

  const body = (
    <div
      className={`mp-modal${inline ? ' mp-inline' : ''}`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <header className="mp-head">
        <div className="mp-head-text">
          <h2 className="mp-title">{title}</h2>
          <p className="mp-hint">{hint}</p>
        </div>
        {dismissible && (
          <button className="icon-btn" title="关闭" onClick={onCancel}>
            <X size={16} strokeWidth={1.8} />
          </button>
        )}
      </header>

      <div className="mp-tools">
        <div className="mp-search">
          <Search size={14} strokeWidth={2} />
          <input
            autoFocus
            value={query}
            placeholder="搜索模型或厂商,比如 claude、通义"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="mp-search-x" title="清空" onClick={() => setQuery('')}>
              <X size={13} strokeWidth={2} />
            </button>
          )}
        </div>
        <div className="mp-filters">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={`mp-filter${filter === f.id ? ' on' : ''}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              {f.id === 'picked' && pickedModels.length > 0 && <em>{pickedModels.length}</em>}
            </button>
          ))}
        </div>
      </div>

      {/*
        已选项始终可见:多选清单最容易丢的就是「我到底选了哪几个」。
        这一排还兼着「换默认模型」的入口 —— 拖到第一位就是默认,见 sortable。
      */}
      {pickedModels.length > 0 && (
        <div className={`mp-chips${dragId ? ' dragging' : ''}`}>
          {pickedModels.map((m, i) => (
            <span
              key={m.id}
              className={`mp-chip${sortable ? ' sortable' : ''}${dragId === m.id ? ' dragging' : ''}`}
              title={
                i === 0
                  ? `${m.id}（默认模型${sortable ? ',拖动其他标签到最前面可换' : ''}）`
                  : sortable
                    ? `${m.id}（拖到最前面设为默认模型）`
                    : m.id
              }
              draggable={sortable}
              onDragStart={(e) => {
                dragIdRef.current = m.id
                setDragId(m.id)
                e.dataTransfer.effectAllowed = 'move'
                // Chromium 不给 setData 也拖得动,但空 dataTransfer 会被 App.tsx 那个
                // window 级兜底(它拦所有没人处理的 dragover/drop)当成外部拖入。
                e.dataTransfer.setData('text/plain', m.id)
              }}
              onDragEnter={() => {
                const from = dragIdRef.current
                if (from) reorder(from, m.id)
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                dragIdRef.current = null
                setDragId(null)
              }}
              // 拖到容器外面松手也要收尾:dragend 一定会来,drop 不一定。
              onDragEnd={() => {
                dragIdRef.current = null
                setDragId(null)
              }}
            >
              {i === 0 && <b className="mp-chip-default">默认</b>}
              {m.id}
              <button title="移除" onClick={() => toggle(m.id)}>
                <X size={11} strokeWidth={2.5} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="mp-list" ref={listRef} role="listbox" aria-multiselectable>
        {loading ? (
          <div className="mp-state">
            <LoadingLottie size="sm" label="正在加载" />
            正在读取你的账号可用模型…
          </div>
        ) : groups.length === 0 ? (
          <div className="mp-state">{poolFailed ? '没能拉到可用模型' : '没有匹配的模型'}</div>
        ) : (
          groups.map((g) => (
            <div className="mp-group" key={g.vendor.id}>
              <div className="mp-group-head">
                {g.vendor.label}
                <em>{g.models.length}</em>
              </div>
              {g.models.map((m) => renderRow(m, ++row))}
            </div>
          ))
        )}
      </div>

      <footer className="mp-foot">
        <span className="mp-count">
          {error ? (
            <b className="mp-count-err">{error}</b>
          ) : (
            <>
              已选 {pickedModels.length} 个
              {sortable && ' · 拖动上面的标签可换默认模型'}
              {pickedModels.length > SOFT_LIMIT && ' · 选得有点多,对话下拉框会很长'}
            </>
          )}
        </span>
        {dismissible && (
          <button className="btn-ghost" disabled={busy} onClick={onCancel}>
            取消
          </button>
        )}
        {poolFailed && onSkip && (
          <button className="btn-ghost" disabled={busy} onClick={onSkip}>
            先跳过,之后在设置里选
          </button>
        )}
        <button className="btn-primary" disabled={busy || loading || poolFailed} onClick={confirm}>
          {busy ? (
            <>
              <LoadingLottie size="xs" />
              保存中…
            </>
          ) : (
            confirmText
          )}
        </button>
      </footer>
    </div>
  )

  if (inline) return body
  return (
    <FloatingMask className="mp-mask" onClick={dismissible ? onCancel : undefined}>
      {body}
    </FloatingMask>
  )
}
