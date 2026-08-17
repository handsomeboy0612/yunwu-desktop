import { useEffect, useRef, useState, type ReactNode } from 'react'
import lottie, { type AnimationItem } from 'lottie-web'

/**
 * 通用 Lottie 播放器(项目内动画统一走此组件,契合 Electron CSP:SVG 渲染器仅注入内联样式)。
 *
 * - animationData 在打包期 import 为模块,不发任何网络请求;
 * - 数据无效或运行时异常 → 渲染 fallback(默认无),保证不白屏、不报错。
 *
 * 选用 lottie-web 而非 lottie-react:无 React peer 版本限制(项目为 React 19)。
 */
interface Props {
  /** 打包期 import 进来的 Lottie JSON 数据。 */
  data: unknown
  className?: string
  loop?: boolean
  autoplay?: boolean
  /** 数据无效 / 运行时失败时的兜底渲染。 */
  fallback?: ReactNode
  ariaLabel?: string
}

/** 最小化校验:必须是含非空 layers 数组的对象。 */
function isValidLottie(data: unknown): boolean {
  return (
    !!data &&
    typeof data === 'object' &&
    Array.isArray((data as { layers?: unknown }).layers) &&
    (data as { layers: unknown[] }).layers.length > 0
  )
}

export default function LottiePlayer({
  data,
  className,
  loop = true,
  autoplay = true,
  fallback = null,
  ariaLabel
}: Props): ReactNode {
  const boxRef = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(!isValidLottie(data))

  useEffect(() => {
    if (failed || !boxRef.current) {
      return
    }
    let anim: AnimationItem | null = null
    try {
      anim = lottie.loadAnimation({
        container: boxRef.current,
        renderer: 'svg',
        loop,
        autoplay,
        animationData: data as unknown as Record<string, unknown>
      })
    } catch {
      setFailed(true)
    }
    return () => anim?.destroy()
  }, [failed, data, loop, autoplay])

  if (failed) {
    return <>{fallback}</>
  }
  return (
    <div
      className={className}
      ref={boxRef}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    />
  )
}
