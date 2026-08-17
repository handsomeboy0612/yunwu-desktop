import type { ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import LottiePlayer from './LottiePlayer'
import loadingAnim from '../assets/loading.lottie.json'

/**
 * 项目统一加载动画(Lottie)。页面/区块/行内按钮的 loading 一律走此组件,
 * 禁止再用 CSS spinner 或 Loader2 作为主加载态(仅作 Lottie 失败兜底)。
 */
export type LoadingSize = 'xs' | 'sm' | 'md' | 'lg'

const SIZE_PX: Record<LoadingSize, number> = {
  xs: 14,
  sm: 24,
  md: 48,
  lg: 72
}

interface Props {
  size?: LoadingSize
  className?: string
  /** 无障碍标签;装饰性可省略。 */
  label?: string
}

export default function LoadingLottie({
  size = 'md',
  className,
  label
}: Props): ReactNode {
  const px = SIZE_PX[size]
  return (
    <LottiePlayer
      data={loadingAnim}
      className={['loading-lottie', `loading-lottie-${size}`, className].filter(Boolean).join(' ')}
      ariaLabel={label}
      fallback={<Loader2 size={Math.min(px, 20)} strokeWidth={2} className="spin" />}
    />
  )
}
