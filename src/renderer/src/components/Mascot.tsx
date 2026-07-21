import { useEffect, useRef, useState } from 'react'
import lottie, { type AnimationItem } from 'lottie-web'
import mascotAnim from '../assets/mascot.lottie.json'

/**
 * 吉祥物渲染:优先播放 Lottie 矢量动画(灵动、体积小、离线内置,契合 Electron CSP),
 * 任意异常(动画数据缺失/损坏/运行时报错)自动降级为纯 emoji 占位,保证始终有形象、不依赖任何位图。
 *
 * 选用 lottie-web 而非 lottie-react:无 React peer 版本限制(项目为 React 19),
 * 用 SVG 渲染器(仅注入内联样式,命中 CSP 的 style-src 'unsafe-inline'),
 * animationData 在打包期 import 为模块、不发任何网络请求。
 *
 * 更换动画:把 LottieFiles 导出的 json 覆盖 src/renderer/src/assets/mascot.lottie.json 即可。
 */

/** 最小化校验:必须是含 layers 数组的对象,否则视为无效并走 PNG 兜底。 */
function isValidLottie(data: unknown): boolean {
  return (
    !!data &&
    typeof data === 'object' &&
    Array.isArray((data as { layers?: unknown }).layers) &&
    (data as { layers: unknown[] }).layers.length > 0
  )
}

export default function Mascot() {
  const boxRef = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(!isValidLottie(mascotAnim))

  useEffect(() => {
    if (failed || !boxRef.current) {
      return
    }
    let anim: AnimationItem | null = null
    try {
      anim = lottie.loadAnimation({
        container: boxRef.current,
        renderer: 'svg',
        loop: true,
        autoplay: true,
        animationData: mascotAnim as unknown as Record<string, unknown>
      })
    } catch {
      /** Lottie 运行时失败:切换到 PNG 兜底。 */
      setFailed(true)
    }
    return () => anim?.destroy()
  }, [failed])

  if (failed) {
    return (
      <div className="mascot-img mascot-fallback" role="img" aria-label="云雾助手">
        ☁️
      </div>
    )
  }
  return <div className="mascot-lottie" ref={boxRef} aria-hidden="true" />
}
