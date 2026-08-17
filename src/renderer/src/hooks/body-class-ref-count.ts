import { useEffect } from 'react'

/**
 * 引用计数的 body class(1:1 复刻 WorkBuddy
 * `packages/agent-ui/src/hooks/use-body-class-ref-count.ts`)。
 *
 * 引用计数不是多余的:多个浮层会并存(比如设置弹窗里再开一个确认框),
 * 谁先关就摘 class 的话,还开着的那个会被连累。必须最后一个卸载才摘。
 */
const refCounts = new Map<string, number>()

export function useBodyClassRefCount(className: string, enabled = true): void {
  useEffect(() => {
    if (!enabled) {
      return
    }
    refCounts.set(className, (refCounts.get(className) ?? 0) + 1)
    document.body.classList.add(className)
    return () => {
      const next = Math.max(0, (refCounts.get(className) ?? 0) - 1)
      if (next === 0) {
        refCounts.delete(className)
        document.body.classList.remove(className)
      } else {
        refCounts.set(className, next)
      }
    }
  }, [className, enabled])
}
