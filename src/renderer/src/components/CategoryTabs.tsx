import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MarketCategory } from '@shared/types'
import { useHorizontalDrag, useHorizontalWheel } from '../hooks/horizontal-scroll'

/**
 * 市场分类横排 tab(1:1 复刻 WorkBuddy 的 `expert/pages/center/expert-category-tabs.tsx`)。
 *
 * 之所以照抄而不是留一个 `overflow-x:auto`:分类有十几个,一屏放不下,而系统横向滚动条
 * 在 Electron 里既难看又难点。WorkBuddy 的做法是把滚动条藏掉,另给三条可发现性:
 *  1. 指针拖动列表本身;
 *  2. 竖直滚轮转成横向滚动;
 *  3. 右侧 32px 渐隐遮罩 + 一个圆形 next 箭头,滚到底自动隐藏。
 * 前两条在 hooks/horizontal-scroll.ts(与精选场景横条共用)。数值(160px 步进、32px
 * 遮罩、28px 按钮)取自 WorkBuddy 实现,不要随手改。
 */
export default function CategoryTabs({
  categories,
  countBy,
  selectedId,
  onChange,
  hidden = false
}: {
  categories: MarketCategory[]
  /** 分类 id → 条目数;为 0 的分类不渲染(对齐 WorkBuddy:空分类直接不出现)。 */
  countBy: Map<number, number>
  /** 0 = 全部。 */
  selectedId: number
  onChange: (id: number) => void
  /** 搜索中时整条隐藏(对齐 WorkBuddy 的 `hidden: hasSearchKeyword`)。 */
  hidden?: boolean
}): React.JSX.Element | null {
  const tabsRef = useRef<HTMLDivElement>(null)
  const [canScrollNext, setCanScrollNext] = useState(false)
  const { dragHandlers, isDragging } = useHorizontalDrag()

  const visibleCategories = useMemo(
    () => categories.filter((c) => (countBy.get(c.id) ?? 0) > 0),
    [categories, countBy]
  )
  const rendered = !hidden && visibleCategories.length > 0
  // enabled 必须跟着"容器到底渲没渲出来"变:分类是异步到的,首帧本组件返回 null、ref 为空,
  // 若 enabled 恒为 true,这个 effect 只在那一帧跑过一次,滚轮监听从此永远挂不上。
  useHorizontalWheel(tabsRef, rendered)

  const totalCount = useMemo(() => {
    let total = 0
    for (const c of visibleCategories) total += countBy.get(c.id) ?? 0
    return total
  }, [visibleCategories, countBy])

  const updateScrollAffordance = useCallback(() => {
    const tabs = tabsRef.current
    if (!tabs) {
      setCanScrollNext(false)
      return
    }
    setCanScrollNext(tabs.scrollLeft + tabs.clientWidth < tabs.scrollWidth - 1)
  }, [])

  // 分类数、条目数、容器宽度任一变化都要重算箭头显隐;ResizeObserver 覆盖侧栏折叠这类
  // 不触发 window resize 的宽度变化。
  useEffect(() => {
    updateScrollAffordance()
    const tabs = tabsRef.current
    if (!tabs) return
    const observer = new ResizeObserver(updateScrollAffordance)
    observer.observe(tabs)
    return () => observer.disconnect()
  }, [rendered, visibleCategories.length, totalCount, updateScrollAffordance])

  const scrollNext = useCallback(() => {
    tabsRef.current?.scrollBy({ left: 160, behavior: 'smooth' })
  }, [])

  if (!rendered) return null

  return (
    <div className="cat-tabs-wrap">
      <div
        ref={tabsRef}
        className={`cat-tabs${isDragging ? ' is-dragging' : ''}`}
        role="tablist"
        aria-label="分类"
        onScroll={updateScrollAffordance}
        {...dragHandlers}
      >
        <button
          type="button"
          role="tab"
          aria-selected={selectedId === 0}
          className={`cat-chip${selectedId === 0 ? ' active' : ''}`}
          onClick={() => onChange(0)}
        >
          全部
        </button>
        {visibleCategories.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={selectedId === c.id}
            className={`cat-chip${selectedId === c.id ? ' active' : ''}`}
            onClick={() => onChange(c.id)}
          >
            {c.name}
          </button>
        ))}
      </div>
      {canScrollNext && (
        <button type="button" className="cat-tabs-next" aria-label="更多分类" onClick={scrollNext}>
          <span className="cat-tabs-next-icon" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
