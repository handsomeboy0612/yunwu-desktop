import { useEffect, useMemo, useState } from 'react'
import { AudioLines, Check, Image as ImageIcon, Search, Video, X } from 'lucide-react'
import type { MediaModelKind, MediaModelOption, MediaSelection } from '@shared/types'
import { vendorOf, vendorRank } from '../lib/model-vendor'
import LoadingLottie from './LoadingLottie'
import FloatingMask from './FloatingMask'

interface Props {
  /** 弹窗标题。 */
  title: string
  /** 一句话说明,解释这些模型花的是谁的钱。 */
  hint: string
  confirmText: string
  /** 能不能关掉。首启那一步不能关,但给「先跳过」的退路。 */
  dismissible: boolean
  /** 内联形态(首启的一步),与 ModelPicker 同一套判据,见那边 `inline` 的注释。 */
  inline?: boolean
  onCancel?: () => void
  /** 保存成功与否由外层决定(它拿着错误位);这里只负责把三档的选择交出去。 */
  onConfirm: (selection: MediaSelection) => void | Promise<void>
  /** 池子拉不下来、或者用户就是不想现在选时的退路。 */
  onSkip?: () => void
}

/**
 * 三档媒体能力对应的内核工具与选择语义。
 *
 * **「能选几个」不是界面偏好,是内核那侧的形状决定的**:
 *  - 出图 / 出视频落在 `agents.defaults.imageGenerationModel` / `videoGenerationModel`,
 *    类型是 `ToolModelConfig`(`primary` + `fallbacks[]`),所以可以多选,第一个是主用;
 *  - 语音落在 `messages.tts.providers.openai.model`,**只有一个 model 字段**,
 *    所以是单选。给它做成多选等于让用户以为有兜底,而配置里根本放不下第二个。
 */
const KINDS: {
  id: MediaModelKind
  label: string
  /** 顶部已选那几行的行首标签,要能在 46px 里排下 —— 所以不复用上面那个带「模型」的全称。 */
  short: string
  tool: string
  icon: typeof ImageIcon
  multi: boolean
  hint: string
  /** 一个都不选的后果,写在小节里 —— 用户有权知道「不选」等于关掉这个能力。 */
  emptyNote: string
}[] = [
  {
    id: 'image',
    label: '出图模型',
    short: '出图',
    tool: 'image_generate',
    icon: ImageIcon,
    multi: true,
    hint: '第一个是主用,其余作为兜底依次重试。带「可改图」的还能按你的要求改已有图片。',
    emptyNote: '不选就不给专家配出图工具'
  },
  {
    id: 'video',
    label: '视频模型',
    short: '视频',
    tool: 'video_generate',
    icon: Video,
    multi: true,
    hint: '一段 5 秒的视频通常要 1~3 分钟,费用按厂商各自的计价走。',
    emptyNote: '不选就不给专家配出视频工具'
  },
  {
    id: 'audio',
    label: '语音模型',
    short: '语音',
    tool: 'tts',
    icon: AudioLines,
    multi: false,
    hint: '朗读文字用的语音合成,只能选一个。',
    emptyNote: '不选则朗读功能不可用'
  }
]

/**
 * 媒体模型选择器:出图 / 视频 / 语音三档,从**这把 key 此刻真能调的**里面挑。
 *
 * 与对话模型分开做成两个组件,是因为这三档的可选池、勾选语义(见 KINDS 的注释)、
 * 以及落配置的路径都不一样;共用的那部分——厂商分组、行的样子、sticky 分组头——
 * 走同一份 `lib/model-vendor.ts` 与同一套 `mp-*` 样式,所以两边看起来是一家的。
 *
 * **但「分成两个组件」只解释了数据层,不构成交互层也要少一半的理由。** 搜索、已选 chips
 * 这两样在 ModelPicker 里有、这边一直没有,是我们自己欠的(用户 2026-08-17 报的:
 * 「怎么不能像对话那样能搜索、顶部显示已选」)。补的时候照 ModelPicker 的形状与样式类,
 * 位置也照它:工具条 → chips → 列表。**三档并不构成把 chips 拆到各档小节里的理由** ——
 * 那样滚到视频档时出图档那排就滚出视口,「已选始终可见」正好落空。三档的结构改在这一块
 * **内部**表达:一档独占一行,行首挂「出图 / 视频 / 语音」标签(见下面 md-chips 那段)。
 *
 * **候选池按端点类型筛,不按 tag 筛**(判据与理由见 `shared/media-endpoints.ts`):
 * tag 说的是「产出什么」,端点类型说的是「怎么调」,而能不能驱动它取决于后者。
 * 铺一个我们还没接的厂商专属路径给用户,选中即必然失败。
 *
 * 首启那一步与设置→模型页复用同一个组件,分工照 WorkBuddy:必须做完才能往下走的是内联
 * 一步(`ob-inline`,不可关闭但带 `onSkip`),之后再改偏好才是真弹窗(`SettingsModal`)。
 */
export default function MediaPicker({
  title,
  hint,
  confirmText,
  dismissible,
  inline,
  onCancel,
  onConfirm,
  onSkip
}: Props) {
  const [pool, setPool] = useState<Record<MediaModelKind, MediaModelOption[]> | null>(null)
  /** 三档当前的选择;顺序即 primary → fallbacks,语音只取第 0 个。 */
  const [picked, setPicked] = useState<Record<MediaModelKind, string[]>>({
    image: [],
    video: [],
    audio: []
  })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  /**
   * 只有「全部 / 只看已选」两档。
   *
   * ModelPicker 那边还有推理 / 识图 / 联网,这边**刻意不做对应的能力筛选**:媒体的能力标记
   * 是逐档的(`canEdit` 只出图有、`imageToVideo` 只视频有、语音一个都没有),做成跨三档的
   * chip 会在两档里恒真或恒假 —— 与那边不给「工具调用」筛选是同一条判据。
   */
  const [onlyPicked, setOnlyPicked] = useState(false)

  useEffect(() => {
    void (async () => {
      const res = await window.api.availableMediaModels()
      if (!res.ok || !res.data) {
        setError(res.error ?? '拉取媒体模型清单失败')
        setFailed(true)
        setLoading(false)
        return
      }
      const { pool: p, selected, chosen, preset } = res.data
      // 没选过就用预勾选,选过就照他的选择回显。已选但这会儿拉不到的照样留着显示 ——
      // 否则用户打开看一眼、点个保存,就把它们静默删了(与 ModelPicker 同一处理)。
      const base = chosen ? selected : preset
      setPool(p)
      setPicked({
        image: [...base.image],
        video: [...base.video],
        audio: base.audio ? [base.audio] : []
      })
      setLoading(false)
    })()
  }, [])

  /**
   * 每档的完整清单,**过滤之前**:池子 + 「已选但这次拉不到」的占位项。
   *
   * 与过滤分成两步是为了区分两种空:整档池子本来就空(该说「这把 key 调不到」)和被搜索词
   * 滤空(该说「没有匹配」)。合在一步里算的话只剩一个 0,文案必然有一种是骗人的。
   */
  const merged = useMemo(() => {
    const out: Record<MediaModelKind, MediaModelOption[]> = { image: [], video: [], audio: [] }
    for (const k of KINDS) {
      const list = [...(pool?.[k.id] ?? [])]
      const seen = new Set(list.map((m) => m.id))
      for (const id of picked[k.id]) {
        if (!seen.has(id)) list.push({ id })
      }
      out[k.id] = list
    }
    return out
  }, [pool, picked])

  /** 过滤后按厂商分组,组内按 id 排。 */
  const groups = useMemo(() => {
    const out: Record<MediaModelKind, { vendor: string; label: string; items: MediaModelOption[] }[]> =
      { image: [], video: [], audio: [] }
    const q = query.trim().toLowerCase()
    for (const k of KINDS) {
      const chosen = picked[k.id]
      const list = merged[k.id].filter((m) => {
        if (onlyPicked && !chosen.includes(m.id)) {
          return false
        }
        // 与 ModelPicker 一致:模型名与厂商名都匹配,所以输入「谷歌」「通义」也找得到。
        if (!q) {
          return true
        }
        return (
          m.id.toLowerCase().includes(q) || vendorOf(m.id).label.toLowerCase().includes(q)
        )
      })
      const bucket = new Map<string, { vendor: string; label: string; items: MediaModelOption[] }>()
      for (const m of list) {
        const v = vendorOf(m.id)
        let slot = bucket.get(v.id)
        if (!slot) {
          slot = { vendor: v.id, label: v.label, items: [] }
          bucket.set(v.id, slot)
        }
        slot.items.push(m)
      }
      out[k.id] = [...bucket.values()]
        .map((g) => ({ ...g, items: g.items.sort((a, b) => a.id.localeCompare(b.id)) }))
        .sort((a, b) => vendorRank(a.vendor) - vendorRank(b.vendor))
    }
    return out
  }, [merged, picked, query, onlyPicked])

  /** 多选档:点一下切换,顺序保留(先选的在前 = 主用)。单选档:点一下换成它,点已选的取消。 */
  function toggle(kind: MediaModelKind, id: string, multi: boolean): void {
    setPicked((prev) => {
      const cur = prev[kind]
      if (!multi) {
        return { ...prev, [kind]: cur[0] === id ? [] : [id] }
      }
      return {
        ...prev,
        [kind]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
      }
    })
    if (error) setError('')
  }

  async function confirm(): Promise<void> {
    setError('')
    setBusy(true)
    try {
      await onConfirm({
        image: picked.image,
        video: picked.video,
        audio: picked.audio[0] ?? ''
      })
    } finally {
      setBusy(false)
    }
  }

  const total = picked.image.length + picked.video.length + picked.audio.length

  const body = (
    <div className={`mp-modal md-modal${inline ? ' mp-inline' : ''}`} onClick={(e) => e.stopPropagation()}>
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

      {/* 工具条在加载完之后才出现:池子还没到手时搜索框点得动却筛不了东西。 */}
      {!loading && !failed && (
        <div className="mp-tools">
          <div className="mp-search">
            <Search size={14} strokeWidth={2} />
            <input
              autoFocus
              value={query}
              placeholder="搜索模型或厂商,比如 gemini、通义"
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="mp-search-x" title="清空" onClick={() => setQuery('')}>
                <X size={13} strokeWidth={2} />
              </button>
            )}
          </div>
          <div className="mp-filters">
            <button className={`mp-filter${onlyPicked ? '' : ' on'}`} onClick={() => setOnlyPicked(false)}>
              全部
            </button>
            <button className={`mp-filter${onlyPicked ? ' on' : ''}`} onClick={() => setOnlyPicked(true)}>
              只看已选
              {total > 0 && <em>{total}</em>}
            </button>
          </div>
        </div>
      )}

      {/*
        已选项始终可见,在顶部而不是各档小节头下面(理由见组件注释)。这一块**不受搜索与筛选
        影响** —— 被滤掉就失去意义了。
        **一档独占一行,行首挂档位标签。** 拍平成一排靠 chip 里的小图标区分归属是不够的:
        三档只选了 3~5 个时会挤成「出图出图出图 / 视频语音」,后一行两个 12px 图标要凑近才
        认得出谁是谁。一档一行之后行首标签管整行,溢出换行也还在标签右边(flex 两列,不是
        整块 wrap),所以 chip 内不再重复图标。
      */}
      {total > 0 && (
        <div className="mp-chips md-chips">
          {KINDS.map((k) => {
            const chosen = picked[k.id]
            if (chosen.length === 0) return null
            return (
              <div className="md-chip-row" key={k.id}>
                <span className="md-chip-kind">
                  <k.icon size={13} strokeWidth={1.9} />
                  {k.short}
                </span>
                <div className="md-chip-line">
                  {chosen.map((id, at) => (
                    <span key={id} className="mp-chip" title={`${k.label}:${id}`}>
                      {k.multi && (
                        <b className={`mp-chip-default${at === 0 ? '' : ' ord'}`}>
                          {at === 0 ? '主用' : `兜底 ${at}`}
                        </b>
                      )}
                      {id}
                      <button title="移除" onClick={() => toggle(k.id, id, k.multi)}>
                        <X size={11} strokeWidth={2.5} />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="mp-list md-list">
        {loading ? (
          <div className="mp-state">
            <LoadingLottie size="sm" label="正在加载" />
            正在读取你的账号可用媒体模型…
          </div>
        ) : failed ? (
          <div className="mp-state">没能拉到可用的媒体模型</div>
        ) : (
          KINDS.map((k) => {
            const chosen = picked[k.id]
            const poolCount = merged[k.id].length
            const count = groups[k.id].reduce((n, g) => n + g.items.length, 0)
            return (
              <section className="md-sect" key={k.id}>
                <div className="md-sect-head">
                  <span className="md-sect-icon">
                    <k.icon size={14} strokeWidth={1.9} />
                  </span>
                  <b>{k.label}</b>
                  <code>{k.tool}</code>
                  {/*
                    计数报的是**池子总数**,搜着的时候才多报一个命中数 —— 只报过滤后的数会让
                    人以为可选池变小了。「主用是哪个」交给顶部那排 chips,不在这里重复一遍。
                  */}
                  <span className="md-sect-count">
                    {chosen.length === 0 && `${k.emptyNote} · `}
                    {count === poolCount ? `共 ${poolCount} 个` : `命中 ${count} / 共 ${poolCount} 个`}
                  </span>
                </div>
                <p className="md-sect-hint">{k.hint}</p>
                {poolCount === 0 ? (
                  <div className="md-sect-empty">这把 key 现在一个都调不到,跳过这档即可。</div>
                ) : count === 0 ? (
                  <div className="md-sect-empty">
                    没有匹配的模型{onlyPicked && chosen.length === 0 ? '(这档还没选)' : ''}。
                  </div>
                ) : (
                  groups[k.id].map((g) => (
                    <div className="mp-group" key={g.vendor}>
                      <div className="mp-group-head">
                        {g.label}
                        <em>{g.items.length}</em>
                      </div>
                      {g.items.map((m) => {
                        const at = chosen.indexOf(m.id)
                        return (
                          <div
                            key={m.id}
                            role="option"
                            aria-selected={at >= 0}
                            className={`mp-row${at >= 0 ? ' on' : ''}`}
                            onClick={() => toggle(k.id, m.id, k.multi)}
                          >
                            <span
                              className="mp-mark"
                              style={{ background: vendorOf(m.id).color }}
                            >
                              {vendorOf(m.id).mark}
                            </span>
                            <span className="mp-name">{m.id}</span>
                            {k.multi && at === 0 && <span className="mp-badge think">主用</span>}
                            {k.multi && at > 0 && <span className="mp-badge">兜底 {at}</span>}
                            {m.canEdit && <span className="mp-badge">可改图</span>}
                            {/* 只能图生的模型必须标出来:它不接受「凭一句话出片」,
                                用户不知道的话会以为选了个坏模型。出图那侧的 mj_blend 同理
                                (上游 blend 只收图不收 prompt),所以两个标记共用这一个徽标。 */}
                            {(m.imageToVideo || m.editOnly) && (
                              <span className="mp-badge">需参考图</span>
                            )}
                            <span className="mp-check">
                              {at >= 0 && <Check size={14} strokeWidth={2.5} />}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  ))
                )}
              </section>
            )
          })
        )}
      </div>

      <footer className="mp-foot">
        <span className="mp-count">
          {error ? <b className="mp-count-err">{error}</b> : `共选了 ${total} 个媒体模型`}
        </span>
        {dismissible && (
          <button className="btn-ghost" disabled={busy} onClick={onCancel}>
            取消
          </button>
        )}
        {onSkip && (
          <button className="btn-ghost" disabled={busy} onClick={onSkip}>
            先跳过
          </button>
        )}
        <button className="btn-primary" disabled={busy || loading || failed} onClick={confirm}>
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
