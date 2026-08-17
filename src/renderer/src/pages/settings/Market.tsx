import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Download,
  Trash2,
  RefreshCw,
  Search,
  Sparkles,
  Plug,
  X,
  ChevronRight,
  Plus,
  Check,
  MoreHorizontal,
  MessageCircle
} from 'lucide-react'
import type {
  ConnectorManifest,
  ExpertManifest,
  MarketAssetType,
  MarketInstalledItem,
  MarketItem,
  MarketListTab,
  MarketSortOrder
} from '@shared/types'
import { marketItemDesc } from '@shared/types'
import LoadingLottie from '../../components/LoadingLottie'
import FloatingMask from '../../components/FloatingMask'
import {
  DEFAULT_PRIORITY_AVATAR_COUNT,
  SEARCH_PRIORITY_AVATAR_COUNT,
  useDeferredImageLoad
} from '../../hooks/deferred-image'

/**
 * 本地 Agent 市场页(泛化:技能 / 连接器 共用一套 UI)。
 *
 * 数据流:调 admin-server 拉取已上架条目 → 与本地已安装态比对 → 一键安装/更新/卸载。
 *  - skill     :安装即下载 zip 到 ~/.openclaw/skills/<slug>/,内核 watch 自动加载;
 *  - connector :安装即把 MCP 配置写入内核 mcp.servers 并 reload;token 型鉴权先内联收集令牌。
 */

/** 技能 / 连接器 文案差异集中在这里,组件其余逻辑完全复用。 */
const COPY: Record<MarketAssetType, { noun: string; empty: string; icon: React.JSX.Element }> =
  {
    skill: {
      noun: '技能',
      empty: '市场暂无可用技能',
      icon: <Sparkles size={20} strokeWidth={1.6} />
    },
    connector: {
      noun: '连接器',
      empty: '市场暂无可用连接器',
      icon: <Plug size={20} strokeWidth={1.6} />
    },
    expert: {
      noun: '专家',
      empty: '市场暂无可用专家',
      icon: <Sparkles size={20} strokeWidth={1.6} />
    }
  }

/** 从 tags JSON 串安全解析为数组(后端存的是字符串)。 */
function parseTags(raw?: string): string[] {
  if (!raw) {
    return []
  }
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((t) => typeof t === 'string') : []
  } catch {
    return []
  }
}

/** 安全解析连接器 manifest;失败返回 null。 */
function parseManifest(raw?: string): ConnectorManifest | null {
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as ConnectorManifest
  } catch {
    return null
  }
}

/** 安全解析专家 manifest;失败返回 null。 */
function parseExpertManifest(raw?: string): ExpertManifest | null {
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as ExpertManifest
  } catch {
    return null
  }
}

/**
 * 把专家团的成员名单归一成可渲染的一行行。
 *
 * 两种来源要一起展示:`members` 是人设随团队包下发的成员(带头像与职业,外部导入的团队
 * 都是这种),`memberSlugs` 是引用其它专家条目的(我们自撰的样板团队,只有 slug 可显示)。
 */
function teamRoster(
  m: ExpertManifest
): { id: string; label: string; profession?: string; avatar?: string; isLead?: boolean }[] {
  const rows = (m.members ?? []).map((x) => ({
    id: x.id,
    label: x.displayName || x.profession || x.id,
    profession: x.profession,
    avatar: x.avatar,
    isLead: false
  }))
  // 负责人排在最前并挂徽章 —— 编制里少了主理人这一位,看上去就比上游少一个人。
  // 它来自 manifest.lead 而不是 members,原因见 ExpertManifest.lead 的注释。
  if (m.lead) {
    rows.unshift({
      id: m.lead.id,
      label: m.lead.displayName || m.lead.profession || m.lead.id,
      profession: m.lead.profession,
      avatar: m.lead.avatar,
      isLead: true
    })
  }
  const seen = new Set(rows.map((r) => r.id))
  for (const slug of m.memberSlugs ?? []) {
    if (!seen.has(slug)) {
      rows.push({
        id: slug,
        label: slug,
        profession: undefined,
        avatar: undefined,
        isLead: false
      })
    }
  }
  return rows
}

/**
 * 卡片头像。图标是远端 URL 时才延迟加载 —— 一屏之外的头像不该抢首屏带宽,列表长了
 * 上百个请求会一起挤出去。emoji / 首字母是本地渲染,没有加载这回事,直接出。
 *
 * 未加载完时露的是容器自带的渐变底 + 首字母,和 WorkBuddy 的 `.ec-avatar-sq-fallback`
 * 同一个思路:占位跟成品同尺寸同底色,图到位时只换内容不跳布局。
 * `onError` 也回落到首字母,免得图挂了留一个破图框(以前就是这样)。
 */
function MarketItemIcon({
  item,
  priority
}: {
  item: MarketItem
  priority: boolean
}): React.JSX.Element {
  const { imageContainerRef, shouldLoadImage } = useDeferredImageLoad(priority)
  const [broken, setBroken] = useState(false)
  const remoteIcon = item.icon && /^https?:\/\//.test(item.icon) ? item.icon : null
  const fallback = item.name.slice(0, 1).toUpperCase()
  return (
    <div className="market-item-icon" ref={imageContainerRef}>
      {remoteIcon ? (
        shouldLoadImage && !broken ? (
          <img
            src={remoteIcon}
            alt=""
            loading={priority ? 'eager' : 'lazy'}
            decoding="async"
            fetchPriority={priority ? 'high' : 'auto'}
            onError={() => setBroken(true)}
          />
        ) : (
          fallback
        )
      ) : item.icon ? (
        <span className="market-item-emoji">{item.icon}</span>
      ) : (
        fallback
      )}
    </div>
  )
}

/** token 型连接器的令牌收集态。 */
interface TokenPrompt {
  item: MarketItem
  label: string
}

export default function MarketPage({
  assetType = 'skill',
  onSummonExpert,
  onTrySkill,
  externalKeyword,
  categoryId = 0,
  listTab,
  sortOrder = 'reco',
  hideToolbar = false,
  refreshSignal = 0,
  detailRequest,
  filterSlugs
}: {
  assetType?: MarketAssetType
  /**
   * 画廊「召唤」回调(仅 expert 类型生效):提供时主按钮变为「召唤」——
   * 未安装则先静默安装再回调,已安装直接回调。由上层完成绑定+开会话。
   * opts.prefill:点「试试这样问我」时预填到新建任务输入框。
   */
  onSummonExpert?: (item: MarketItem, opts?: { prefill?: string }) => void | Promise<void>
  /**
   * 技能/连接器「试一试」:已安装后从卡片触发,由上层关画廊并落到新建任务
   * (输入框预填调用该技能的起手提示)。
   */
  onTrySkill?: (item: MarketItem) => void | Promise<void>
  /** 外部受控搜索词(画廊头部搜索);提供时用它过滤并隐藏内部搜索框。 */
  externalKeyword?: string
  /** 分类过滤(0=全部);按条目 category_id 客户端过滤。 */
  categoryId?: number
  /** 专家页二级 tab:'expert' 只看单体专家,'team' 只看专家团;不传则不按此过滤。 */
  listTab?: MarketListTab
  /** 列表排序:综合 / 最热 / 最新。 */
  sortOrder?: MarketSortOrder
  /** 隐藏内部工具条(画廊接管搜索/刷新时)。 */
  hideToolbar?: boolean
  /** 外部刷新信号:数值变化即重新拉取列表(画廊刷新按钮驱动)。 */
  refreshSignal?: number
  /** 外部请求打开某条目详情(精选场景点专家时驱动);seq 变化即打开。 */
  detailRequest?: { item: MarketItem; seq: number }
  /** AI 检索结果:提供(非空)时仅展示这些 slug,并按其顺序排列(相关度)。 */
  filterSlugs?: string[]
}): React.JSX.Element {
  const copy = COPY[assetType]
  /** 召唤模式:专家画廊场景,主动作为「召唤」而非「安装」。 */
  const summonMode = assetType === 'expert' && !!onSummonExpert
  const [items, setItems] = useState<MarketItem[]>([])
  const [installed, setInstalled] = useState<Map<string, MarketInstalledItem>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /** true 表示当前列表来自离线缓存(网络/服务端异常时的兜底)。 */
  const [stale, setStale] = useState(false)
  const [keyword, setKeyword] = useState('')
  /** 正在安装/卸载的 slug 集合,用于按钮 loading 与禁用。 */
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  /** 连接器 token 收集弹窗。 */
  const [tokenPrompt, setTokenPrompt] = useState<TokenPrompt | null>(null)
  const [tokenInput, setTokenInput] = useState('')
  /** 详情弹窗:当前查看的条目(点击卡片打开);含懒加载的 manifest。 */
  const [detail, setDetail] = useState<MarketItem | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  /** 卡片「…」菜单当前打开的 slug。 */
  const [menuSlug, setMenuSlug] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  /** 拉取本地已安装态。 */
  const refreshInstalled = useCallback(async () => {
    const res = await window.api.listInstalledMarket(assetType)
    if (res.ok && res.data) {
      setInstalled(new Map(res.data.map((it) => [it.slug, it])))
    }
  }, [assetType])

  /**
   * 拉取市场快照 + 已安装态。
   *
   * 一次拿全该类型的所有条目(不分页),关键词与分类过滤都在本地做(见下方 filtered),
   * 切 chip 是瞬时的,不必每次点击都回服务端。
   */
  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await window.api.getMarketSnapshot(assetType)
      if (!res.ok || !res.data) {
        setError(res.error ?? '加载失败')
        return
      }
      setItems(res.data.items)
      setStale(!!res.data.stale)
      await refreshInstalled()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [assetType, refreshInstalled])

  useEffect(() => {
    void load()
  }, [load])

  // 外部刷新信号变化(画廊刷新按钮)→ 重新拉取。
  useEffect(() => {
    if (refreshSignal > 0) {
      void load()
    }
  }, [refreshSignal, load])

  // 点击卡片外关闭「…」菜单。
  useEffect(() => {
    if (!menuSlug) return
    const onDoc = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuSlug(null)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menuSlug])

  /**
   * 打开条目详情弹窗:先以列表数据占位秒开,再懒加载 manifest(专家/连接器详情所需),
   * 合并回 detail。失败不阻断展示(仅无 manifest 富信息)。
   */
  const openDetail = useCallback(
    async (item: MarketItem) => {
      setDetail(item)
      if (item.manifest) {
        return
      }
      setDetailLoading(true)
      try {
        const res = await window.api.marketDetail(assetType, item.slug)
        if (res.ok && res.data) {
          setDetail((cur) => (cur && cur.slug === item.slug ? { ...cur, ...res.data } : cur))
        }
      } finally {
        setDetailLoading(false)
      }
    },
    [assetType]
  )

  // 外部请求(精选场景点专家)→ 打开该条目详情弹窗。
  useEffect(() => {
    if (detailRequest && detailRequest.seq > 0) {
      void openDetail(detailRequest.item)
    }
    // 仅在 seq 变化时触发,避免重复打开。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailRequest?.seq])

  /** 标记 slug 忙/闲。 */
  const setBusyFor = useCallback((slug: string, on: boolean) => {
    setBusy((prev) => {
      const next = new Set(prev)
      if (on) {
        next.add(slug)
      } else {
        next.delete(slug)
      }
      return next
    })
  }, [])

  /** 执行安装(可携带 token);item 可能已带 manifest(连接器详情)。 */
  const doInstall = useCallback(
    async (item: MarketItem, token?: string) => {
      setBusyFor(item.slug, true)
      setError('')
      try {
        const res = await window.api.installMarketItem(item, token ? { token } : undefined)
        if (!res.ok) {
          throw new Error(res.error || '安装失败')
        }
        await refreshInstalled()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyFor(item.slug, false)
      }
    },
    [refreshInstalled, setBusyFor]
  )

  /**
   * 点击安装入口:技能直接装;连接器先取详情判定鉴权模式——
   * token 型弹窗收集令牌,其余(none/oauth)直接装(oauth 在内核侧走 mcp login)。
   */
  const startInstall = useCallback(
    async (item: MarketItem) => {
      if (assetType !== 'connector') {
        await doInstall(item)
        return
      }
      setBusyFor(item.slug, true)
      setError('')
      try {
        const detail = await window.api.marketDetail('connector', item.slug)
        const full = detail.ok && detail.data ? detail.data : item
        const manifest = parseManifest(full.manifest)
        if (manifest?.auth?.mode === 'token') {
          setTokenInput('')
          setTokenPrompt({
            item: full,
            label: manifest.auth.label || '访问令牌'
          })
          return
        }
        await doInstall(full)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyFor(item.slug, false)
      }
    },
    [assetType, doInstall, setBusyFor]
  )

  const uninstall = useCallback(
    async (item: MarketItem) => {
      setBusyFor(item.slug, true)
      setError('')
      try {
        const res = await window.api.uninstallMarketItem(assetType, item.slug)
        if (!res.ok) {
          throw new Error(res.error || '卸载失败')
        }
        await refreshInstalled()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyFor(item.slug, false)
      }
    },
    [assetType, refreshInstalled, setBusyFor]
  )

  const confirmToken = useCallback(async () => {
    if (!tokenPrompt) {
      return
    }
    const { item } = tokenPrompt
    const token = tokenInput.trim()
    setTokenPrompt(null)
    await doInstall(item, token)
  }, [tokenPrompt, tokenInput, doInstall])

  /**
   * 召唤专家:交由上层 onSummonExpert 处理(其内部会「重装到最新 persona → 开新会话」,
   * 对齐 WorkBuddy 每次召唤取最新)。此处只负责按钮忙碌态与错误提示,不再自行安装,
   * 避免与上层重复下载。
   * prefill:可选,点「试试这样问我」时带入输入框。
   */
  const summon = useCallback(
    async (item: MarketItem, prefill?: string) => {
      setBusyFor(item.slug, true)
      setError('')
      try {
        await onSummonExpert?.(item, prefill ? { prefill } : undefined)
        await refreshInstalled()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyFor(item.slug, false)
      }
    },
    [refreshInstalled, setBusyFor, onSummonExpert]
  )

  const kw = (externalKeyword ?? keyword).trim().toLowerCase()
  const matched = items.filter((it) => {
    if (listTab && (listTab === 'team') !== (it.is_team === true)) {
      return false
    }
    if (categoryId && it.category_id !== categoryId) {
      return false
    }
    if (!kw) {
      return true
    }
    return it.name.toLowerCase().includes(kw) || marketItemDesc(it).toLowerCase().includes(kw)
  })
  /**
   * 三种排序对齐 WorkBuddy 的 reco / popular / newest:
   *  - 综合:服务端已按 featured desc, sort_order asc, id desc 排好,原样保留(所以不排);
   *  - 最热:按 download_count(等价于 WorkBuddy 的 use_count);
   *  - 最新:按 published_at。
   * 后两者同值时回落到服务端顺序,避免 sort 不稳定导致每次渲染顺序抖动。
   */
  const sorted =
    sortOrder === 'reco'
      ? matched
      : [...matched].sort((a, b) => {
          const key = sortOrder === 'popular' ? 'download_count' : 'published_at'
          return (b[key] ?? 0) - (a[key] ?? 0)
        })
  // AI 检索命中时:仅保留命中 slug,并按相关度顺序排列。
  const visible =
    filterSlugs && filterSlugs.length > 0
      ? sorted
          .filter((it) => filterSlugs.includes(it.slug))
          .sort((a, b) => filterSlugs.indexOf(a.slug) - filterSlugs.indexOf(b.slug))
      : sorted
  // 搜索态放宽到 8:结果少、用户目光就在上面,等观察器那一帧很显眼(同 WorkBuddy 的两档取值)。
  const priorityIconCount = kw ? SEARCH_PRIORITY_AVATAR_COUNT : DEFAULT_PRIORITY_AVATAR_COUNT

  return (
    <>
      {!hideToolbar && (
        <div className="market-toolbar">
          <div className="market-search">
            <Search size={15} strokeWidth={1.8} />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={`搜索${copy.noun}`}
            />
          </div>
          <button className="btn-ghost sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={14} strokeWidth={1.8} className={loading ? 'spin' : undefined} />
            刷新
          </button>
        </div>
      )}

      {error && <div className="market-error">{error}</div>}

      {stale && !loading && (
        <div className="market-stale">
          当前为离线缓存内容,可能不是最新;联网后点「刷新」更新。
        </div>
      )}

      {loading ? (
        <div className="market-list" aria-busy="true" aria-label={`正在加载${copy.noun}市场`}>
          {Array.from({ length: 6 }, (_, i) => (
            <div className="market-skel" key={i}>
              <div className="market-skel-head">
                <span className="market-skel-avatar" />
                <div className="market-skel-identity">
                  <span className="market-skel-bar w-sm" />
                  <span className="market-skel-bar w-md" />
                </div>
              </div>
              <span className="market-skel-bar w-full" />
              <span className="market-skel-bar w-full short" />
              <div className="market-skel-tags">
                <span className="market-skel-pill" />
                <span className="market-skel-pill" />
              </div>
            </div>
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="market-empty">
          {copy.icon}
          <span>{items.length === 0 ? copy.empty : `没有匹配的${copy.noun}`}</span>
        </div>
      ) : (
        <div className="market-list">
          {visible.map((it, index) => {
            const inst = installed.get(it.slug)
            const isBusy = busy.has(it.slug)
            const tags = parseTags(it.tags)
            // WorkBuddy 卡头:主标题(职业) + 副标题(人名);列表无 profession 时按「·」拆 name。
            const nameParts = it.name
              .split(/[·•]/)
              .map((s) => s.trim())
              .filter(Boolean)
            const title = nameParts[0] || it.name
            const subtitle = nameParts.length > 1 ? nameParts.slice(1).join('·') : undefined
            return (
              <div
                className="market-item"
                key={it.slug}
                role="button"
                tabIndex={0}
                onClick={() => void openDetail(it)}
                title={`查看「${it.name}」详情`}
              >
                <div className="market-item-head">
                  <MarketItemIcon item={it} priority={index < priorityIconCount} />
                  <div className="market-item-identity">
                    <div className="market-item-name">{title}</div>
                    {subtitle && <div className="market-item-sub">{subtitle}</div>}
                  </div>
                </div>
                {marketItemDesc(it) && (
                  <div className="market-item-desc">{marketItemDesc(it)}</div>
                )}
                {tags.length > 0 && (
                  <div className="market-item-tags">
                    {tags.slice(0, 3).map((t) => (
                      <span key={t} className="market-tag">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                {/*
                  WorkBuddy 卡片角标:
                  - 专家:悬停出「召唤」
                  - 技能/连接器:未装常显「+」;已装常显勾选+「…」,悬停再出「试一试」
                */}
                {summonMode ? (
                  <div className="market-item-hover" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="market-cta"
                      disabled={isBusy}
                      onClick={() => {
                        const m = parseExpertManifest(it.manifest)
                        void summon(
                          it,
                          m?.defaultInitPrompt?.trim() || m?.quickPrompts?.[0]?.trim()
                        )
                      }}
                      title={inst ? '召唤该专家开新会话' : '安装并召唤'}
                    >
                      {isBusy ? (
                        <LoadingLottie size="xs" />
                      ) : (
                        <Sparkles size={12} strokeWidth={2} />
                      )}
                      召唤
                    </button>
                  </div>
                ) : (
                  <div
                    className={`market-card-actions${inst ? ' installed' : ''}`}
                    onClick={(e) => e.stopPropagation()}
                    ref={menuSlug === it.slug ? menuRef : undefined}
                  >
                    {isBusy ? (
                      <span className="market-icon-btn busy">
                        <LoadingLottie size="xs" />
                      </span>
                    ) : !inst ? (
                      <button
                        className="market-icon-btn"
                        title={`安装${copy.noun}`}
                        aria-label={`安装${copy.noun}`}
                        onClick={() => void startInstall(it)}
                      >
                        <Plus size={16} strokeWidth={2.2} />
                      </button>
                    ) : (
                      <>
                        {onTrySkill && (
                          <button
                            className="market-try-btn"
                            title="试一试"
                            onClick={() => void onTrySkill(it)}
                          >
                            <MessageCircle size={13} strokeWidth={2} />
                            试一试
                          </button>
                        )}
                        <span
                          className="market-icon-btn check"
                          title="已安装"
                          aria-label="已安装"
                        >
                          <Check size={15} strokeWidth={2.4} />
                        </span>
                        <button
                          className="market-icon-btn"
                          title="更多"
                          aria-label="更多"
                          aria-expanded={menuSlug === it.slug}
                          onClick={() => setMenuSlug((s) => (s === it.slug ? null : it.slug))}
                        >
                          <MoreHorizontal size={15} strokeWidth={2} />
                        </button>
                        {menuSlug === it.slug && (
                          <div className="market-card-menu">
                            <button
                              className="market-card-menu-item danger"
                              onClick={() => {
                                setMenuSlug(null)
                                void uninstall(it)
                              }}
                            >
                              <Trash2 size={14} strokeWidth={1.8} />
                              卸载
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {detail &&
        (() => {
          const it = detail
          const inst = installed.get(it.slug)
          const isBusy = busy.has(it.slug)
          const tags = parseTags(it.tags)
          const expert = assetType === 'expert' ? parseExpertManifest(it.manifest) : null
          const connector = assetType === 'connector' ? parseManifest(it.manifest) : null
          const avatar = expert?.avatar || it.icon
          const close = (): void => setDetail(null)
          const primary = async (): Promise<void> => {
            close()
            if (summonMode) {
              // 详情主 CTA:预填专家的开场白(没有则退回「试试这样问我」第一句)。
              await summon(
                it,
                expert?.defaultInitPrompt?.trim() || expert?.quickPrompts?.[0]?.trim()
              )
            } else {
              await startInstall(it)
            }
          }
          // 版本更新已在启动与召唤时自动完成(见 market/auto-update.ts),故不再有「更新」态文案。
          const ctaLabel = summonMode
            ? `召唤 ${expert?.displayName || it.name}`
            : inst
              ? '重新安装'
              : `安装${copy.noun}`
          return (
            <FloatingMask className="cm-modal-mask" onClick={close}>
              <div className="cm-modal market-detail" onClick={(e) => e.stopPropagation()}>
                <button className="cm-modal-x btn-ghost sm md-close" onClick={close}>
                  <X size={16} strokeWidth={1.8} />
                </button>
                <div className="md-head">
                  <div className="md-avatar">
                    {avatar ? (
                      /^https?:\/\//.test(avatar) ? (
                        <img src={avatar} alt="" />
                      ) : (
                        <span className="md-avatar-emoji">{avatar}</span>
                      )
                    ) : (
                      it.name.slice(0, 1).toUpperCase()
                    )}
                  </div>
                  <div className="md-head-main">
                    <div className="md-title">
                      <span className="md-name">
                        {it.name.split(/[·•]/)[0]?.trim() || it.name}
                      </span>
                    </div>
                    <div className="md-head-chips">
                      {(() => {
                        const parts = it.name
                          .split(/[·•]/)
                          .map((s) => s.trim())
                          .filter(Boolean)
                        const nick =
                          parts.length > 1 ? parts.slice(1).join('·') : expert?.displayName
                        return nick ? <span className="md-chip">{nick}</span> : null
                      })()}
                      {expert?.profession && (
                        <span className="md-chip">{expert.profession}</span>
                      )}
                      <span className="md-chip">
                        {expert?.isTeam
                          ? '专家团'
                          : assetType === 'expert'
                            ? '专家'
                            : copy.noun}
                      </span>
                      {tags.slice(0, 1).map((t) => (
                        <span key={t} className="md-chip">
                          {t}
                        </span>
                      ))}
                    </div>
                    <div className="md-meta">
                      {!!it.download_count && <span>{it.download_count} 次使用</span>}
                      {it.version && <span>v{it.version}</span>}
                      {inst && <span>已安装</span>}
                    </div>
                  </div>
                </div>

                <div className="md-body">
                  {detailLoading ? (
                    <div className="md-loading-full">
                      <LoadingLottie size="md" label="正在载入" />
                      <span>正在载入详情…</span>
                    </div>
                  ) : (
                    <>
                      {marketItemDesc(it) && (
                        <section className="md-sec">
                          <h4>能力介绍</h4>
                          <p>{marketItemDesc(it)}</p>
                        </section>
                      )}
                      {tags.length > 0 && (
                        <section className="md-sec">
                          <h4>擅长领域</h4>
                          <div className="market-item-tags md-tags">
                            {tags.map((t) => (
                              <span key={t} className="market-tag md-tag">
                                {t}
                              </span>
                            ))}
                          </div>
                        </section>
                      )}
                      {expert?.isTeam && teamRoster(expert).length > 0 && (
                        <section className="md-sec">
                          <h4>团队成员</h4>
                          <div className="md-members">
                            {teamRoster(expert).map((m) => (
                              <span key={m.id} className="md-member">
                                <span className="md-member-avatar">
                                  {m.avatar ? (
                                    <img src={m.avatar} alt="" />
                                  ) : (
                                    m.label.slice(0, 1).toUpperCase()
                                  )}
                                </span>
                                <span className="md-member-info">
                                  {m.profession && (
                                    <span className="md-member-role">{m.profession}</span>
                                  )}
                                  <span className="md-member-name">{m.label}</span>
                                  {m.isLead && <span className="md-leader-badge">⭐ 主理人</span>}
                                </span>
                              </span>
                            ))}
                          </div>
                        </section>
                      )}
                      {expert?.quickPrompts && expert.quickPrompts.length > 0 && (
                        <section className="md-sec">
                          <h4>试试这样问我</h4>
                          <div className="md-prompts">
                            {expert.quickPrompts.map((p) => (
                              <button
                                key={p}
                                type="button"
                                className="md-prompt"
                                disabled={isBusy || !summonMode}
                                title={summonMode ? '召唤并填入输入框' : undefined}
                                onClick={() => {
                                  close()
                                  void summon(it, p)
                                }}
                              >
                                <span className="md-prompt-text">{p}</span>
                                <ChevronRight
                                  size={15}
                                  strokeWidth={2}
                                  className="md-prompt-caret"
                                />
                              </button>
                            ))}
                          </div>
                        </section>
                      )}
                      {connector && (
                        <section className="md-sec">
                          <h4>连接方式</h4>
                          <p className="md-connector">
                            MCP · {connector.mcpName}
                            {connector.auth?.mode === 'token'
                              ? `(需填写${connector.auth.label || '访问令牌'})`
                              : connector.auth?.mode === 'oauth'
                                ? '(安装后授权登录)'
                                : '(免鉴权)'}
                          </p>
                        </section>
                      )}
                    </>
                  )}
                </div>

                <div className="md-foot">
                  <button className="md-cta" disabled={isBusy} onClick={() => void primary()}>
                    {isBusy ? (
                      <LoadingLottie size="xs" />
                    ) : summonMode ? (
                      <Sparkles size={15} strokeWidth={1.8} />
                    ) : (
                      <Download size={15} strokeWidth={1.8} />
                    )}
                    {ctaLabel}
                  </button>
                  {inst && !summonMode && (
                    <button
                      className="btn-ghost md-uninstall"
                      disabled={isBusy}
                      onClick={() => {
                        close()
                        void uninstall(it)
                      }}
                    >
                      <Trash2 size={15} strokeWidth={1.8} />
                      卸载
                    </button>
                  )}
                </div>
              </div>
            </FloatingMask>
          )
        })()}

      {tokenPrompt && (
        <FloatingMask className="cm-modal-mask" onClick={() => setTokenPrompt(null)}>
          <div className="cm-modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
            <div className="cm-modal-body">
              <div className="market-prompt-head">
                <strong>连接「{tokenPrompt.item.name}」</strong>
                <button
                  className="cm-modal-x btn-ghost sm"
                  onClick={() => setTokenPrompt(null)}
                >
                  <X size={15} strokeWidth={1.8} />
                </button>
              </div>
              <div className="field">
                <label>{tokenPrompt.label}</label>
                <input
                  type="password"
                  autoFocus
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="粘贴该服务的访问令牌"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      void confirmToken()
                    }
                  }}
                />
                <span className="market-prompt-hint">
                  令牌仅写入本机内核配置,用于该连接器发起请求,不会上传。
                </span>
              </div>
              <div className="market-prompt-actions">
                <button className="btn-ghost sm" onClick={() => setTokenPrompt(null)}>
                  取消
                </button>
                <button
                  className="btn-primary sm"
                  disabled={!tokenInput.trim()}
                  onClick={() => void confirmToken()}
                >
                  安装
                </button>
              </div>
            </div>
          </div>
        </FloatingMask>
      )}
    </>
  )
}
