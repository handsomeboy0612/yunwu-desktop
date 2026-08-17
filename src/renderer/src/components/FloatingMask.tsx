import type { MouseEvent, ReactNode } from 'react'
import { useBodyClassRefCount } from '../hooks/body-class-ref-count'

/** 有浮层打开时挂到 <body> 上,styles.css 据此让所有拖拽区让位。 */
export const FLOATING_LAYER_OPEN_CLASS = 'floating-layer-open'

type Props = {
  /** 原来写在 div 上的遮罩类名(menu-mask / modal-mask / cm-modal-mask / ...)。 */
  className: string
  onClick?: (e: MouseEvent<HTMLDivElement>) => void
  children?: ReactNode
}

/**
 * 浮层遮罩。除了原来那个 div,还负责向 body 登记「有浮层打开」。
 *
 * 登记这件事不能省。我们的遮罩清一色 `position: fixed; inset: 0`,整片盖在
 * .titlebar / .sidebar-head / .main-head 这三块拖拽区上;而 Windows 的原生窗口
 * 拖拽是按几何位置判定的,不认谁盖在谁前面 —— 落进拖拽区那几条里的遮罩和浮层
 * 控件会被直接吞掉鼠标事件,表现是点不动、也关不掉,热区只剩贴边 1px。
 * 这正是 WorkBuddy 的 issue #56837(Windows 独有,macOS 的 native drag region
 * 事件派发机制不同,不复现),它的结论是「浮层打开时让拖拽区整体让位」,
 * 登记点是 `packages/agent-ui/src/hooks/use-body-class-ref-count.ts`。
 *
 * 它那边是各个浮层组件自己调 hook;我们把登记点放在遮罩上,是因为我们的浮层都是
 * 写在页面里的内联 JSX,没有能挂 hook 的组件边界,而每个浮层恰好都有一个遮罩。
 *
 * 别改回 `body:has(.xxx-mask)` 那种全页面反查 —— WorkBuddy 就是从那个写法退回
 * 引用计数的,理由是 Selector stats 判它高成本。
 */
export default function FloatingMask({ className, onClick, children }: Props) {
  useBodyClassRefCount(FLOATING_LAYER_OPEN_CLASS)
  return (
    <div className={className} onClick={onClick}>
      {children}
    </div>
  )
}
