import {
  useCallback, useEffect, useRef, useState,
  type MouseEventHandler, type PointerEventHandler, type RefObject,
} from 'react'

interface DragState {
  readonly pointerId: number
  readonly startX: number
  readonly startScrollLeft: number
  moved: boolean
  captured: boolean
}

interface HorizontalDragHandlers<T extends HTMLElement> {
  readonly onPointerDown: PointerEventHandler<T>
  readonly onPointerMove: PointerEventHandler<T>
  readonly onPointerUp: PointerEventHandler<T>
  readonly onPointerCancel: PointerEventHandler<T>
  readonly onClickCapture: MouseEventHandler<T>
}

/**
 * Convert a wheel gesture only while the row can still move in that direction.
 *
 * This is the same boundary contract as WorkBuddy's horizontal-scroll.ts:
 * returning false at either edge lets the market's vertical scroller take over.
 */
function applyHorizontalWheel(element: HTMLElement, deltaX: number, deltaY: number): boolean {
  const maximum = element.scrollWidth - element.clientWidth
  if (maximum <= 0) return false
  const delta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY
  if (delta === 0) return false
  if ((delta < 0 && element.scrollLeft <= 0)
    || (delta > 0 && element.scrollLeft >= maximum - 1)) return false
  element.scrollLeft += delta
  return true
}

/** Attach a non-passive listener so an ordinary mouse wheel can move a horizontal shelf. */
export function useHorizontalWheel<T extends HTMLElement>(
  elementRef: RefObject<T | null>,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return
    const element = elementRef.current
    if (element === null) return
    const onWheel = (event: WheelEvent): void => {
      if (applyHorizontalWheel(element, event.deltaX, event.deltaY)) event.preventDefault()
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [elementRef, enabled])
}

/**
 * Drag a horizontal shelf without stealing clicks from buttons inside it.
 *
 * WorkBuddy waits until movement exceeds 6px before taking pointer capture,
 * then suppresses only the click following a real drag. Capturing on pointer
 * down retargets an ordinary expert-row click to the shelf itself.
 */
export function useHorizontalDrag<T extends HTMLElement>(): {
  readonly isDragging: boolean
  readonly dragHandlers: HorizontalDragHandlers<T>
} {
  const dragRef = useRef<DragState | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  const finish = useCallback<PointerEventHandler<T>>(event => {
    const state = dragRef.current
    if (state === null) return
    if (state.captured) {
      try {
        event.currentTarget.releasePointerCapture(state.pointerId)
      } catch {
        // The browser may already have released capture after the pointer left.
      }
    }
    setIsDragging(false)
  }, [])

  const onPointerDown = useCallback<PointerEventHandler<T>>(event => {
    if (event.button !== 0 || !event.isPrimary) return
    const element = event.currentTarget
    if (element.scrollWidth <= element.clientWidth) return
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: element.scrollLeft,
      moved: false,
      captured: false,
    }
  }, [])

  const onPointerMove = useCallback<PointerEventHandler<T>>(event => {
    const state = dragRef.current
    if (state === null || state.pointerId !== event.pointerId) return
    const delta = event.clientX - state.startX
    if (Math.abs(delta) > 6) {
      state.moved = true
      if (!state.captured) {
        event.currentTarget.setPointerCapture(event.pointerId)
        state.captured = true
      }
      setIsDragging(true)
    }
    if (!state.moved) return
    event.preventDefault()
    event.currentTarget.scrollLeft = state.startScrollLeft - delta
  }, [])

  const onClickCapture = useCallback<MouseEventHandler<T>>(event => {
    const state = dragRef.current
    if (state === null) return
    if (state.moved) {
      event.preventDefault()
      event.stopPropagation()
    }
    dragRef.current = null
  }, [])

  return {
    isDragging,
    dragHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: event => {
        finish(event)
        dragRef.current = null
      },
      onClickCapture,
    },
  }
}
