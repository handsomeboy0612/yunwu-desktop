import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 横向列表的滚轮 / 拖动支持(1:1 复刻 WorkBuddy
 * `packages/agent-ui/src/modules/expert/pages/center/horizontal-scroll.ts`)。
 *
 * 专家中心里两处横向列表共用这一套:分类 tab 和精选场景横条。两者都藏掉了滚动条,
 * 于是「能横向滚」这件事必须靠滚轮 + 拖动 + 箭头三条一起表达,少一条用户就找不到。
 */

/**
 * 把竖直滚轮换算成横向滚动。
 * 返回 false 表示"这一下我不消费"(已到头 / 无可滚动),调用方据此放行给页面滚动。
 */
function applyHorizontalWheel(element: HTMLElement, deltaX: number, deltaY: number): boolean {
  const maxScrollLeft = element.scrollWidth - element.clientWidth
  if (maxScrollLeft <= 0) return false
  const delta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY
  if (delta === 0) return false
  const isAtStart = element.scrollLeft <= 0
  const isAtEnd = element.scrollLeft >= maxScrollLeft - 1
  if ((delta < 0 && isAtStart) || (delta > 0 && isAtEnd)) return false
  element.scrollLeft += delta
  return true
}

/**
 * 滚轮横向化。
 *
 * 必须用非 passive 的原生监听:React 的 onWheel 是 passive 的,在里面调 preventDefault
 * 无效,页面会跟着一起竖滚。
 *
 * ⚠️ `enabled` 一定要传"目标 DOM 到底渲没渲出来",不要写死 true —— 列表数据是异步到的,
 * 首帧组件往往还返回 null、ref 是空的,此时 effect 跑过一次就因依赖不变再也不重跑,
 * 监听从此永远挂不上(这个坑我踩过一次)。
 */
export function useHorizontalWheel(
  elementRef: React.RefObject<HTMLElement | null>,
  enabled = true
): void {
  useEffect(() => {
    if (!enabled) return
    const element = elementRef.current
    if (!element) return
    const handleWheel = (event: WheelEvent): void => {
      if (applyHorizontalWheel(element, event.deltaX, event.deltaY)) event.preventDefault()
    }
    element.addEventListener('wheel', handleWheel, { passive: false })
    return () => element.removeEventListener('wheel', handleWheel)
  }, [elementRef, enabled])
}

interface DragState {
  pointerId: number
  startX: number
  startScrollLeft: number
  moved: boolean
  captured: boolean
}

export interface HorizontalDragHandlers {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void
  onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void
  onClickCapture: (e: React.MouseEvent<HTMLElement>) => void
}

/**
 * 让隐藏了滚动条的横向列表支持指针拖动,同时避免拖动结束误触内部按钮。
 * 拖过 6px 才算拖;算拖了就在 capture 阶段吃掉那一下 click,否则松手即误选。
 */
export function useHorizontalDrag(): {
  isDragging: boolean
  dragHandlers: HorizontalDragHandlers
} {
  const dragStateRef = useRef<DragState | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  const finishDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const state = dragStateRef.current
    if (!state) return
    if (state.captured) {
      try {
        event.currentTarget.releasePointerCapture(state.pointerId)
      } catch {
        // 指针已被系统释放(切窗口 / 拔设备),忽略即可。
      }
    }
    setIsDragging(false)
  }, [])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !event.isPrimary) return
    const element = event.currentTarget
    if (element.scrollWidth <= element.clientWidth) return
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: element.scrollLeft,
      moved: false,
      captured: false
    }
  }, [])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const state = dragStateRef.current
    if (!state || state.pointerId !== event.pointerId) return
    const deltaX = event.clientX - state.startX
    if (Math.abs(deltaX) > 6) {
      state.moved = true
      if (!state.captured) {
        event.currentTarget.setPointerCapture(event.pointerId)
        state.captured = true
      }
      setIsDragging(true)
    }
    if (state.moved) {
      event.preventDefault()
      event.currentTarget.scrollLeft = state.startScrollLeft - deltaX
    }
  }, [])

  const onClickCapture = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const state = dragStateRef.current
    if (!state) return
    if (state.moved) {
      event.preventDefault()
      event.stopPropagation()
    }
    dragStateRef.current = null
  }, [])

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      finishDrag(event)
    },
    [finishDrag]
  )

  const onPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      finishDrag(event)
      dragStateRef.current = null
    },
    [finishDrag]
  )

  return {
    isDragging,
    dragHandlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture }
  }
}

export interface HorizontalScrollBinding extends HorizontalDragHandlers {
  onScroll: () => void
}

export interface HorizontalScrollControl {
  containerRef: React.RefObject<HTMLDivElement | null>
  canScrollLeft: boolean
  canScrollRight: boolean
  isDragging: boolean
  scrollByStep: (direction: 'left' | 'right') => void
  /** 一次性摊到滚动容器上:拖动 + onScroll 重算箭头显隐。 */
  bind: HorizontalScrollBinding
}

/**
 * 滚轮 + 拖动 + 两端可滚状态三合一(复刻 WorkBuddy `useHorizontalScroll` 的返回形状:
 * `containerRef` / `canScrollLeft` / `canScrollRight` / `scrollByStep` / `bind`)。
 *
 * WorkBuddy 那版靠调用方传一个 deps 数组来触发重算,这里改用 MutationObserver 盯
 * childList:滚动容器多半是 `flex:1`,增删子项并不改变它自身的 border-box 尺寸,
 * 单靠 ResizeObserver 收不到通知,而 deps 数组又会让 exhaustive-deps 报 spread 警告。
 * 宽度变化(侧栏折叠这类不触发 window resize 的)仍由 ResizeObserver 兜。
 *
 * `enabled` 必须传"容器到底渲没渲出来":列表数据是异步到的,首帧 ref 还是空的,
 * 传死 true 会让滚轮监听永远挂不上(见 useHorizontalWheel 的同款告警)。
 */
export function useHorizontalScroll(enabled: boolean, step = 160): HorizontalScrollControl {
  const containerRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const { isDragging, dragHandlers } = useHorizontalDrag()

  useHorizontalWheel(containerRef, enabled)

  const updateAffordance = useCallback(() => {
    const element = containerRef.current
    if (!element) {
      setCanScrollLeft(false)
      setCanScrollRight(false)
      return
    }
    // 留 1px 容差:缩放比非整数时 scrollLeft 是小数,严格比较会让箭头在末端闪烁。
    setCanScrollLeft(element.scrollLeft > 1)
    setCanScrollRight(element.scrollLeft + element.clientWidth < element.scrollWidth - 1)
  }, [])

  useEffect(() => {
    updateAffordance()
    const element = containerRef.current
    if (!enabled || !element) return
    const resizeObserver = new ResizeObserver(updateAffordance)
    resizeObserver.observe(element)
    const mutationObserver = new MutationObserver(updateAffordance)
    mutationObserver.observe(element, { childList: true })
    return () => {
      resizeObserver.disconnect()
      mutationObserver.disconnect()
    }
  }, [enabled, updateAffordance])

  const scrollByStep = useCallback(
    (direction: 'left' | 'right') => {
      containerRef.current?.scrollBy({
        left: direction === 'left' ? -step : step,
        behavior: 'smooth'
      })
    },
    [step]
  )

  return {
    containerRef,
    canScrollLeft,
    canScrollRight,
    isDragging,
    scrollByStep,
    bind: { ...dragHandlers, onScroll: updateAffordance }
  }
}
