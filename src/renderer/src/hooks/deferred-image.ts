import { useCallback, useEffect, useState } from 'react'

/**
 * 列表里的图片延迟到快进视口时才真正开始下载(照 WorkBuddy
 * `packages/agent-ui/src/modules/expert/pages/center/expert-card.tsx` 的
 * `useDeferredImageLoad`,但修掉了它的 root 漏传,见下)。
 *
 * 为什么不只用原生 `loading="lazy"`:原生属性只推迟请求,`<img>` 节点照样进 DOM、照样占
 * 一次布局与解码槽位;这里是**根本不渲染 `<img>`**,没进视口的卡片停在首字母兜底上。
 * 专家列表一次渲染上百张头像,差别就在这儿。
 *
 * 元素用 `useState` 存而不是 `useRef` —— 必须的:ref 赋值不触发重渲染,effect 不会重跑,
 * observer 就永远挂不上。WorkBuddy 那版也是这么写的,别"优化"成 ref。
 */

/**
 * 提前多远开始加载,取值同 WorkBuddy 的 `IMAGE_OBSERVER_ROOT_MARGIN`,
 * 约两行卡片高,正常滚速下图片在滑进视口前就已就位。
 */
const IMAGE_OBSERVER_ROOT_MARGIN = '240px'

/**
 * 首屏前几张不等观察器,直接加载。WorkBuddy:默认 4(`DEFAULT_PRIORITY_AVATAR_COUNT`),
 * 搜索结果放宽到 8(`SEARCH_PRIORITY_AVATAR_COUNT`)—— 搜索时用户目光就在结果上,
 * 慢一帧都显眼。
 */
export const DEFAULT_PRIORITY_AVATAR_COUNT = 4
export const SEARCH_PRIORITY_AVATAR_COUNT = 8

/**
 * 找最近的可滚动祖先当 observer 的 root。
 *
 * 这是我们比 WorkBuddy 多出来的一步,理由是实测出来的,不要当成多余代码删掉:
 * IntersectionObserver 的 `rootMargin` **只扩张 root 自己的矩形**,中间祖先的 overflow
 * 裁剪是硬的。所以列表装在内部滚动容器里、而 root 又留空(= viewport)时,元素一旦滚出
 * 容器可视区就直接判不相交,240px 那个预载窗口完全不起作用。
 *
 * Chrome 实测(容器高 200 / 目标在容器内 top:400 处 / 目标几何位置仍在 viewport 内):
 *   { rootMargin: '240px' }            → isIntersecting false(rootBounds 确实是 -240~800)
 *   { root: 容器, rootMargin: '240px' } → isIntersecting true,ratio 0.8
 *
 * WorkBuddy 自己的列表就装在 `.ec-main-scroll { overflow-y: auto }` 里,却没传 root,
 * 所以它那 240px 是白写的 —— 图片实际是刚滑进可视区才开始下载,滚快了能看到头像后补。
 * 这条属于参考实现的疏漏,不照抄。
 *
 * 不写死 `.gallery-body`:同一批卡片组件在专家中心和设置页都用,两边滚动容器不是一个。
 */
function findScrollRoot(element: HTMLElement): HTMLElement | null {
  let node = element.parentElement
  while (node && node !== document.body) {
    const overflowY = getComputedStyle(node).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return node
    node = node.parentElement
  }
  // 一个都没找到就是页面级滚动,交给 viewport(此时 rootMargin 本来就有效)。
  return null
}

export interface DeferredImageLoad {
  /** 挂在图片**容器**上(不是 `<img>` 上,图还没渲染时也要有东西可观察)。 */
  imageContainerRef: (node: HTMLElement | null) => void
  shouldLoadImage: boolean
}

export function useDeferredImageLoad(priorityLoad: boolean): DeferredImageLoad {
  const [targetEl, setTargetEl] = useState<HTMLElement | null>(null)
  const [shouldLoadImage, setShouldLoadImage] = useState(priorityLoad)

  // 优先级是算出来的(取决于卡片下标、是否搜索态),可能从 false 翻成 true。
  useEffect(() => {
    if (priorityLoad) setShouldLoadImage(true)
  }, [priorityLoad])

  useEffect(() => {
    if (shouldLoadImage || !targetEl) return
    if (typeof IntersectionObserver === 'undefined') {
      setShouldLoadImage(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          // 加载过就不再管:图片不会因为滚出视口而需要卸载。
          setShouldLoadImage(true)
          observer.disconnect()
        }
      },
      { root: findScrollRoot(targetEl), rootMargin: IMAGE_OBSERVER_ROOT_MARGIN }
    )
    observer.observe(targetEl)
    return () => observer.disconnect()
  }, [shouldLoadImage, targetEl])

  return {
    imageContainerRef: useCallback((node: HTMLElement | null) => {
      setTargetEl(node)
    }, []),
    shouldLoadImage
  }
}
