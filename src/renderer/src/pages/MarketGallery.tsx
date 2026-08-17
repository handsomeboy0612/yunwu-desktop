import { useEffect, useRef, useState } from 'react'
import {
  GraduationCap,
  Sparkles,
  Plug,
  Search,
  ChevronLeft,
  ChevronRight,
  Plus,
  Upload,
  Wand2,
  X,
  Check
} from 'lucide-react'
import type {
  DesktopScenario,
  MarketAssetType,
  MarketCategory,
  MarketItem,
  MarketListTab,
  MarketSortOrder
} from '@shared/types'
import MarketPage from './settings/Market'
import CategoryTabs from '../components/CategoryTabs'
import LoadingLottie from '../components/LoadingLottie'
import FloatingMask from '../components/FloatingMask'
import { useHorizontalDrag, useHorizontalWheel } from '../hooks/horizontal-scroll'
import coverContent from '../assets/collections/content.png'
import coverDev from '../assets/collections/dev.png'
import coverFinance from '../assets/collections/finance.png'
import coverGeneral from '../assets/collections/general.png'

/**
 * 主窗口「专家 · 技能 · 连接器」画廊页(1:1 对齐 WorkBuddy)。
 *
 * 结构:
 *  - 顶部固定头:资产 tab(专家/技能/连接器) + 搜索;
 *  - 下方单一滚动体:
 *      · 精选场景 = 后台「场景」驱动的整卡背景图大卡(标题 + 背景图 + 关联专家),横向滑块;
 *      · 分类 chips;
 *      · 卡片网格(复用 MarketPage)。
 * 精选场景数据来自 admin 后台的 DesktopScenario:cover=整卡背景图、member_slugs=卡内展示的专家。
 * 专家类走「召唤」(未装先装再开会话)。
 */

interface Props {
  /** 召唤专家:未装先装,再由上层绑定并开新会话;可选 prefill 填入输入框。 */
  onSummonExpert: (item: MarketItem, opts?: { prefill?: string }) => void | Promise<void>
  /** 技能/连接器「试一试」:关画廊并落到新建任务,预填调用该技能的起手提示。 */
  onTrySkill?: (item: MarketItem) => void | Promise<void>
  /**
   * 开新任务并预填模板(用于「查找技能 / 创建技能」,对齐 WorkBuddy 的对话内 agentic)。
   * skill:可选,创建技能时携带 skill-creator,渲染为输入框内的已选技能芯片。
   */
  onComposePrefill?: (text: string, skill?: { slug: string; name: string }) => void
}

/** 「查找技能 / 创建技能」预填模板(对齐 WorkBuddy 内置 find-skills / skill-creator 起手语)。 */
const FIND_SKILL_TEMPLATE = '请帮我查找并自动安装能「」的skill'
const CREATE_SKILL_TEMPLATE = '请帮我创建一个可以实现「」的skill'

/** 资产 tab 元信息。 */
const TABS: { id: MarketAssetType; label: string; icon: typeof GraduationCap }[] = [
  { id: 'expert', label: '专家', icon: GraduationCap },
  { id: 'skill', label: '技能', icon: Sparkles },
  { id: 'connector', label: '连接器', icon: Plug }
]

/** 列表排序分段控件(文案与顺序对齐 WorkBuddy 的 sortReco / sortPopular / sortNewest)。 */
const SORTS: { id: MarketSortOrder; label: string }[] = [
  { id: 'reco', label: '综合' },
  { id: 'popular', label: '最热' },
  { id: 'newest', label: '最新' }
]

/** 合集封面背景图池(后台未上传封面时的本地兜底,实拍风)。 */
const COVER_POOL = [coverContent, coverDev, coverFinance, coverGeneral]

/** 稳定哈希(字符串→下标)。 */
function hashIndex(s: string, mod: number): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return Math.abs(h) % mod
}

/** 按名称关键词兜底一张本地背景图(后台未上传封面时用)。 */
function fallbackCoverByName(name: string): string {
  const n = name || ''
  if (/内容|文案|创作|营销|运营|新媒体/.test(n)) return coverContent
  if (/技术|工程|开发|研发|代码|程序/.test(n)) return coverDev
  if (/金融|投资|财|股|理财|证券/.test(n)) return coverFinance
  if (/综合|通用|助理|办公/.test(n)) return coverGeneral
  return COVER_POOL[hashIndex(n, COVER_POOL.length)]
}

/** 场景整卡背景图:优先后台上传的 cover(URL),否则按标题兜底本地图(始终有图)。 */
export function scenarioCover(sc: DesktopScenario): string {
  if (sc.cover && sc.cover.trim()) return sc.cover.trim()
  return fallbackCoverByName(sc.title)
}

/** 解析 member_slugs(JSON 字符串数组);兼容旧单专家 expert_slug 兜底。 */
export function scenarioMemberSlugs(sc: DesktopScenario): string[] {
  let slugs: string[] = []
  if (sc.member_slugs) {
    try {
      const arr = JSON.parse(sc.member_slugs)
      if (Array.isArray(arr)) slugs = arr.filter((s): s is string => typeof s === 'string')
    } catch {
      slugs = []
    }
  }
  if (slugs.length === 0 && sc.expert_slug) slugs = [sc.expert_slug]
  return slugs
}

/**
 * 渲染条目图标:http 图标用 <img>,emoji/文字直接展示,空则用首字母。
 *
 * 这里只用原生 `loading="lazy"`,不套 useDeferredImageLoad —— 照 WorkBuddy 的
 * `.ec-featured-scene-expert` 头像(同样是裸的 `loading="lazy"` + `decoding="async"`)。
 * 精选场景是横向滑块,视口内最多三张卡 × 三个头像,量小到不值得挂观察器;专家网格那边
 * 一屏几十上百张,才需要"不进视口不渲染 <img>"的那套。
 */
function renderIcon(item: MarketItem): React.JSX.Element {
  if (item.icon && /^https?:\/\//.test(item.icon)) {
    return <img src={item.icon} alt="" loading="lazy" decoding="async" />
  }
  if (item.icon) {
    return <span className="collection-expert-emoji">{item.icon}</span>
  }
  return <>{item.name.slice(0, 1).toUpperCase()}</>
}

export default function MarketGallery({
  onSummonExpert,
  onTrySkill,
  onComposePrefill
}: Props): React.JSX.Element {
  const [tab, setTab] = useState<MarketAssetType>('expert')
  const [keyword, setKeyword] = useState('')
  const [categoryId, setCategoryId] = useState(0)
  /** 专家团各记一份选中分类:WorkBuddy 是 selectedCategory / selectedTeamCategory 两个 state,
   *  来回切 tab 各自的分类都留着,不清空。 */
  const [teamCategoryId, setTeamCategoryId] = useState(0)
  const [categories, setCategories] = useState<MarketCategory[]>([])
  /** 专家页二级 tab:单体专家 / 专家团(对齐 WorkBuddy list-tabs-row)。 */
  const [listTab, setListTab] = useState<MarketListTab>('expert')
  /** 列表排序:综合 / 最热 / 最新。专家与专家团各记一份,来回切不会互相顶掉。 */
  const [sortOrder, setSortOrder] = useState<MarketSortOrder>('reco')
  const [teamSortOrder, setTeamSortOrder] = useState<MarketSortOrder>('reco')
  /** 当前 tab 已安装数量(用于「我安装的 N」徽标)。 */
  const [installedCount, setInstalledCount] = useState(0)
  /** 外部刷新信号:上传技能成功后 +1,驱动 MarketPage 重新拉取列表。 */
  const [refreshSignal, setRefreshSignal] = useState(0)
  /** 「添加技能」下拉菜单开合。 */
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const addMenuRef = useRef<HTMLDivElement>(null)
  /** 「上传技能」导入弹窗开合 + 状态。 */
  const [importOpen, setImportOpen] = useState(false)
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadMsg, setUploadMsg] = useState('')
  const [dragOver, setDragOver] = useState(false)
  /**
   * 当前资产 tab 的全量条目。
   * 两个用途:① 把场景的 member_slugs 解析成可召唤的专家卡(仅专家页);② 算分类计数。
   */
  const [snapshotItems, setSnapshotItems] = useState<MarketItem[]>([])
  /** 后台精选场景(驱动整卡背景图大卡)。 */
  const [scenarios, setScenarios] = useState<DesktopScenario[]>([])
  const sliderRef = useRef<HTMLDivElement>(null)
  /** 滑块是否已到最左/最右:到头隐藏左箭头,到尾隐藏右箭头。 */
  const [atStart, setAtStart] = useState(true)
  const [atEnd, setAtEnd] = useState(true)
  /** 精选场景横条与分类 tab 共用同一套滚轮/拖动(对齐 WorkBuddy 的 FeaturedScenes)。 */
  const sliderDrag = useHorizontalDrag()
  /** 精选场景点专家 → 请求 MarketPage 打开该专家详情弹窗(seq 递增触发)。 */
  const [detailReq, setDetailReq] = useState<{ item: MarketItem; seq: number } | null>(null)

  // 切 tab / 刷新:重置分类,拉该类型快照(分类 + 条目一次到手);专家 tab 额外拉后台精选场景。
  useEffect(() => {
    setCategoryId(0)
    setTeamCategoryId(0)
    setListTab('expert')
    void window.api.getMarketSnapshot(tab).then((res) => {
      const snap = res.ok ? res.data : undefined
      setCategories(snap?.categories ?? [])
      // 快照是全量的,不会漏掉排在后面的老专家。
      setSnapshotItems(snap?.items ?? [])
    })
    if (tab === 'expert') {
      // 只要 featured 那一档:这张表里还躺着 117 条挂在首页场景下的实践案例,
      // 它们没有关联专家,套上这里的「背景图 + 专家行」模板只剩一张裁切过的封面。
      void window.api.listScenarios('featured').then((res) => {
        setScenarios(res.ok && res.data ? res.data : [])
      })
    }
  }, [tab])

  // 拉当前 tab 的已安装数量(切 tab / 刷新信号后更新)。
  useEffect(() => {
    let alive = true
    void window.api.listInstalledMarket(tab).then((res) => {
      if (alive) setInstalledCount(res.ok && res.data ? res.data.length : 0)
    })
    return () => {
      alive = false
    }
  }, [tab, refreshSignal])

  // 点击菜单外关闭「添加技能」下拉。
  useEffect(() => {
    if (!addMenuOpen) return
    const onDoc = (e: MouseEvent): void => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [addMenuOpen])

  /** 查找技能:开新任务 + 预填模板,交由内置 find-skills 技能自动匹配。 */
  function openFind(): void {
    setAddMenuOpen(false)
    onComposePrefill?.(FIND_SKILL_TEMPLATE)
  }

  /** 创建技能:开新任务 + 预填模板 + 挂 skill-creator 芯片(对齐 WorkBuddy 图三)。 */
  function openCreate(): void {
    setAddMenuOpen(false)
    onComposePrefill?.(CREATE_SKILL_TEMPLATE, { slug: 'skill-creator', name: 'skill-creator' })
  }

  /** 上传技能:从本地 zip 直装。传入路径(拖拽的 file.path 或选择器返回)。 */
  async function installZip(filePath: string): Promise<void> {
    if (!filePath) return
    setUploadBusy(true)
    setUploadMsg('')
    try {
      const res = await window.api.installLocalSkillZip(filePath)
      if (!res.ok || !res.data) {
        throw new Error(res.error || '安装失败')
      }
      setUploadMsg(`已安装技能「${res.data.name || res.data.slug}」`)
      setRefreshSignal((s) => s + 1)
      setTimeout(() => {
        setImportOpen(false)
        setUploadMsg('')
      }, 900)
    } catch (err) {
      setUploadMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setUploadBusy(false)
    }
  }

  /** 点击选择 zip 文件(经主进程文件选择器)。 */
  async function pickZip(): Promise<void> {
    const res = await window.api.pickFiles()
    const path = res.ok && res.data ? res.data.find((p) => /\.zip$/i.test(p)) : undefined
    if (!path) {
      if (res.ok && res.data && res.data.length > 0) setUploadMsg('请选择 .zip 技能包')
      return
    }
    await installZip(path)
  }

  /** 拖拽释放:取第一个 .zip 的本地路径(Electron 下 File 带 path)。 */
  function onDropZip(e: React.DragEvent): void {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0] as (File & { path?: string }) | undefined
    const path = file?.path
    if (!path || !/\.zip$/i.test(path)) {
      setUploadMsg('请拖入 .zip 技能包')
      return
    }
    void installZip(path)
  }

  // 内容/尺寸变化后重算箭头显隐(下一帧,等布局完成)。
  useEffect(() => {
    const id = requestAnimationFrame(() => updateArrows())
    window.addEventListener('resize', updateArrows)
    return () => {
      cancelAnimationFrame(id)
      window.removeEventListener('resize', updateArrows)
    }
  }, [scenarios, snapshotItems, tab])

  /**
   * 滑块左右滚动。一次一张卡(卡宽 214 + 间距 14),对齐 WorkBuddy 的 ±258
   * (它的卡 250 + 间距 8)——按"一屏 80%"翻会一次跳过好几张,找不回刚才看到哪了。
   */
  function slide(dir: -1 | 1): void {
    sliderRef.current?.scrollBy({ left: dir * 228, behavior: 'smooth' })
  }

  /** 依据滚动位置更新左右箭头显隐(内容未溢出时两侧都隐藏)。 */
  function updateArrows(): void {
    const el = sliderRef.current
    if (!el) return
    const { scrollLeft, scrollWidth, clientWidth } = el
    setAtStart(scrollLeft <= 1)
    setAtEnd(scrollLeft + clientWidth >= scrollWidth - 1)
  }

  // 精选场景大卡:后台每个已上架场景一张卡;成员由 member_slugs 映射到已拉取的专家条目。
  const expertBySlug = new Map(snapshotItems.map((e) => [e.slug, e]))
  const collections = scenarios
    .map((sc) => ({
      sc,
      members: scenarioMemberSlugs(sc)
        .map((slug) => expertBySlug.get(slug))
        .filter((e): e is MarketItem => Boolean(e))
    }))
    // 一个专家都解析不出来就不渲染这张卡 —— 照 WorkBuddy 的 buildVisibleSceneCards
    // (`.filter((card) => card.experts.length > 0)`)。上面的 kind 已经挡掉了案例,这层
    // 兜的是另一件事:场景挂的专家下架了、或快照还没到,此时卡面只剩一张背景图,
    // 看起来跟坏了一样。它那侧数据源本来就是干净的,仍然留着这道过滤,我们更需要。
    .filter((c) => c.members.length > 0)

  const showFeatured = tab === 'expert' && collections.length > 0
  // 同 CategoryTabs:enabled 要跟着"横条到底渲没渲出来"变,否则场景异步到达前 ref 是空的,
  // effect 跑过一次就再也不重跑,滚轮永远挂不上。
  useHorizontalWheel(sliderRef, showFeatured)
  /** 专家页才有二级 tab;技能/连接器没有专家团这回事。 */
  const showListTabs = tab === 'expert'
  const activeSort = listTab === 'team' ? teamSortOrder : sortOrder
  /**
   * 分类计数的口径:先按二级 tab 收窄再计数,和 WorkBuddy 一致
   * (它给 ExpertCategoryTabs 传的是已按 expertType 过滤过的 filteredAllExperts)。
   * 这样切到「专家团」时,没有团的分类直接不出现,不会点进去一片空白。
   */
  const scopedItems = showListTabs
    ? snapshotItems.filter((it) => (listTab === 'team' ? it.is_team === true : !it.is_team))
    : snapshotItems
  const categoryCount = new Map<number, number>()
  for (const it of scopedItems) {
    if (!it.category_id) continue
    categoryCount.set(it.category_id, (categoryCount.get(it.category_id) ?? 0) + 1)
  }
  const onTeamTab = showListTabs && listTab === 'team'
  const activeCategoryId = onTeamTab ? teamCategoryId : categoryId
  const setActiveCategoryId = onTeamTab ? setTeamCategoryId : setCategoryId

  function changeSort(next: MarketSortOrder): void {
    if (listTab === 'team') setTeamSortOrder(next)
    else setSortOrder(next)
  }

  return (
    <div className="gallery">
      <header className="gallery-head">
        <div className="gallery-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`gallery-tab${t.id === tab ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <t.icon
                size={15}
                strokeWidth={1.8}
                fill={t.id === tab ? 'currentColor' : 'none'}
              />
              {t.label}
            </button>
          ))}
        </div>
        <div className="gallery-head-right">
          <div className="market-search gallery-search">
            <Search size={15} strokeWidth={1.8} />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={`搜索${TABS.find((t) => t.id === tab)?.label ?? ''}职称或描述`}
            />
          </div>
          {tab === 'skill' && (
            <>
              <span className="gallery-installed-badge" title="我已安装的技能数量">
                <Check size={13} strokeWidth={2.4} />
                我安装的 {installedCount}
              </span>
              <div className="gallery-add-wrap" ref={addMenuRef}>
                <button
                  className="gallery-add-btn"
                  onClick={() => setAddMenuOpen((v) => !v)}
                  aria-expanded={addMenuOpen}
                >
                  <Plus size={15} strokeWidth={2.2} />
                  添加技能
                </button>
                {addMenuOpen && (
                  <div className="gallery-add-menu">
                    <button className="gallery-add-item" onClick={() => { setAddMenuOpen(false); setImportOpen(true); setUploadMsg('') }}>
                      <Upload size={15} strokeWidth={1.8} />
                      <span>
                        <b>上传技能</b>
                        <em>导入本地 zip 技能包</em>
                      </span>
                    </button>
                    <button className="gallery-add-item" onClick={openFind}>
                      <Search size={15} strokeWidth={1.8} />
                      <span>
                        <b>查找技能</b>
                        <em>描述需求,让助手查找并安装</em>
                      </span>
                    </button>
                    <button className="gallery-add-item" onClick={openCreate}>
                      <Wand2 size={15} strokeWidth={1.8} />
                      <span>
                        <b>创建技能</b>
                        <em>描述需求,让助手现场创建</em>
                      </span>
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </header>

      <div className="gallery-body">
        {showFeatured && (
          <section className="gallery-section">
            <div className="gallery-section-head">
              <div className="gallery-section-title">精选场景</div>
            </div>
            <div className="collection-slider-wrap">
              {!atStart && (
                <button
                  className="slider-arrow left"
                  title="向左"
                  aria-label="向左"
                  onClick={() => slide(-1)}
                >
                  <ChevronLeft size={16} strokeWidth={2.2} />
                </button>
              )}
              {!atEnd && (
                <button
                  className="slider-arrow right"
                  title="向右"
                  aria-label="向右"
                  onClick={() => slide(1)}
                >
                  <ChevronRight size={16} strokeWidth={2.2} />
                </button>
              )}
              <div
                className={`collection-slider${sliderDrag.isDragging ? ' is-dragging' : ''}`}
                ref={sliderRef}
                onScroll={updateArrows}
                {...sliderDrag.dragHandlers}
              >
                {collections.map(({ sc, members }) => (
                <div
                  className="collection-card"
                  key={sc.id}
                  style={{ backgroundImage: `url(${scenarioCover(sc)})` }}
                >
                  <div className="collection-cover">
                    <span className="collection-cover-title">{sc.title}</span>
                  </div>
                  <div className="collection-body">
                    {members.slice(0, 3).map((e) => (
                      <button
                        key={e.slug}
                        className="collection-expert"
                        onClick={() => setDetailReq({ item: e, seq: Date.now() })}
                        title={`查看「${e.name}」详情`}
                      >
                        <span className="collection-expert-avatar">{renderIcon(e)}</span>
                        <span className="collection-expert-name">{e.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/*
          列表区二级 tab 行:左「专家 / 专家团」,右排序分段控件。
          只在专家页出现 —— WorkBuddy 的技能页和连接器页都没有排序控件,别自作主张加。
        */}
        {showListTabs && (
          <div className="list-tabs-row">
            <div className="list-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={listTab === 'expert'}
                className={`list-tab${listTab === 'expert' ? ' is-active' : ''}`}
                onClick={() => setListTab('expert')}
              >
                专家
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={listTab === 'team'}
                className={`list-tab${listTab === 'team' ? ' is-active' : ''}`}
                onClick={() => setListTab('team')}
              >
                专家团
              </button>
            </div>
            <div className="list-actions">
              <div className="sort-group">
                {SORTS.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`sort-btn${activeSort === s.id ? ' is-active' : ''}`}
                    onClick={() => changeSort(s.id)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* 分类 tab 与卡片网格同属一个 section,且在二级 tab 行之下(对齐 ec-expert-section)。 */}
        <section className="gallery-section-list">
          <CategoryTabs
            categories={categories}
            countBy={categoryCount}
            selectedId={activeCategoryId}
            onChange={setActiveCategoryId}
            hidden={keyword.trim().length > 0}
          />
          <div className="gallery-list">
            {/* MarketPage 无外壳:头部接管搜索/刷新;专家类注入召唤回调。 */}
            <MarketPage
              key={tab}
              assetType={tab}
              hideToolbar
              externalKeyword={keyword}
              categoryId={activeCategoryId}
              listTab={showListTabs ? listTab : undefined}
              sortOrder={showListTabs ? activeSort : 'reco'}
              refreshSignal={refreshSignal}
              onSummonExpert={tab === 'expert' ? onSummonExpert : undefined}
              onTrySkill={tab !== 'expert' ? onTrySkill : undefined}
              detailRequest={tab === 'expert' ? (detailReq ?? undefined) : undefined}
            />
          </div>
        </section>
      </div>

      {importOpen && (
        <FloatingMask className="cm-modal-mask" onClick={() => !uploadBusy && setImportOpen(false)}>
          <div className="cm-modal import-modal" onClick={(e) => e.stopPropagation()}>
            <div className="import-head">
              <strong>导入技能</strong>
              <button
                className="cm-modal-x btn-ghost sm"
                onClick={() => !uploadBusy && setImportOpen(false)}
              >
                <X size={16} strokeWidth={1.8} />
              </button>
            </div>
            <div
              className={`import-drop${dragOver ? ' over' : ''}${uploadBusy ? ' busy' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDropZip}
              onClick={() => !uploadBusy && void pickZip()}
              role="button"
              tabIndex={0}
            >
              {uploadBusy ? (
                <LoadingLottie size="md" label="正在安装" />
              ) : (
                <>
                  <Upload size={26} strokeWidth={1.6} />
                  <span>拖拽文件或点击上传</span>
                </>
              )}
            </div>
            {uploadMsg && <div className="import-msg">{uploadMsg}</div>}
            <div className="import-req">
              <div className="import-req-title">文件要求</div>
              <ul>
                <li>文件夹或者 .zip 需要包含 SKILL.md 文件</li>
                <li>.md 文件需包含 YAML 格式的技能名称和描述</li>
              </ul>
              <button className="import-pick" disabled={uploadBusy} onClick={() => void pickZip()}>
                选择 ZIP 文件
              </button>
            </div>
          </div>
        </FloatingMask>
      )}
    </div>
  )
}
