import { useCallback, useEffect, useRef, useState } from 'react'
import type { CaptchaChallenge, CaptchaType } from '@shared/types'
import LoadingLottie from './LoadingLottie'

interface Props {
  baseUrl: string
  type: CaptchaType
  /** 验证通过,返回一次性 captcha_token。 */
  onSuccess: (token: string) => void
  /** 关闭(用户取消)。 */
  onClose: () => void
}

/** go-captcha 今天的全部模式,我们五种都原生渲染。 */
const NATIVE_TYPES: string[] = [
  'slide-basic',
  'slide-region',
  'rotate',
  'click-text',
  'click-shape'
]

/**
 * 该模式是否由桌面端原生渲染。
 *
 * 收 `string` 而不是 `CaptchaType`:`/api/status` 的 `captcha_type` 是自由字符串,
 * `fetchCaptchaConfig` 只是强转了一下。判据必须是**白名单**——上游哪天加一种新玩法,
 * 黑名单会把它当成已支持然后渲染出一片空白,白名单则当场说清「这个方式还没支持」。
 */
export function isNativeCaptcha(type: string): boolean {
  return NATIVE_TYPES.includes(type)
}

interface ClickPoint {
  x: number
  y: number
}

/**
 * 云雾登录人机验证码(go-captcha)原生弹层。
 * 点选(click-text/click-shape):按提示顺序点击主图,提交 "x1,y1;x2,y2"。
 * 滑块(slide-basic/slide-region):拖底部滑条把拼块移入缺口,提交 "x,y"。
 * 旋转(rotate):拖滑条把中心圆块转正,提交 "angle"(0-359 整数)。
 * 取题/校验都经主进程(window.api.captcha*),规避渲染层跨源;图片以 base64 data URI 显示。
 *
 * 三种模式的交互都照云雾自己的 web 前端做(`new-yunwu-api/web/src/components/captcha/`)——
 * 那是同一套后端接口的官方渲染,契约以它为准。旋转那档尤其:官方是
 * `RotateCaptcha.js` 的「圆形底图 + 中心圆块 rotate(angle) + range 滑条,松手即提交」。
 */
export default function Captcha({ baseUrl, type, onSuccess, onClose }: Props) {
  const isSlide = type.startsWith('slide')
  const isRotate = type === 'rotate'
  const isClick = type.startsWith('click')
  const [challenge, setChallenge] = useState<CaptchaChallenge | null>(null)
  const [loading, setLoading] = useState(true)
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState('')
  const [failCount, setFailCount] = useState(0)

  // 点选:已点坐标(图片原始坐标系,展示按 1:1)。
  const [points, setPoints] = useState<ClickPoint[]>([])
  // 滑块:拼块当前 x(图片坐标)。
  const [slideX, setSlideX] = useState(0)
  // 旋转:当前角度(0-359)。
  const [angle, setAngle] = useState(0)
  const draggingRef = useRef(false)
  const imgRef = useRef<HTMLImageElement>(null)

  const dataUri = (b64?: string, mime = 'image/jpeg'): string =>
    b64 ? (b64.startsWith('data:') ? b64 : `data:${mime};base64,${b64}`) : ''

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    setPoints([])
    setSlideX(0)
    setAngle(0)
    const res = await window.api.captchaFetch(baseUrl, type)
    if (!res.ok || !res.data) {
      setError(res.error ?? '获取验证码失败')
      setChallenge(null)
    } else {
      setChallenge(res.data)
    }
    setLoading(false)
  }, [baseUrl, type])

  useEffect(() => {
    void load()
  }, [load])

  const displayWidth = challenge?.imageWidth ?? 300
  const tileW = challenge?.tileWidth ?? 48
  const tileH = challenge?.tileHeight ?? 48
  const tileY = challenge?.tileY ?? 0
  const maxSlide = Math.max(0, displayWidth - tileW)
  /**
   * 旋转圆块的直径。题面按 1:1 展示(与点选/滑块同口径),所以直接用后端给的
   * `thumb_size`,不必像官方那样按显示宽度换算。缺省值取实测比例(140/220)。
   */
  const rotateThumb = challenge?.thumbSize ?? Math.round(displayWidth * 0.64)

  function onImageClick(e: React.MouseEvent<HTMLImageElement>): void {
    if (!challenge || verifying || !isClick || !imgRef.current) {
      return
    }
    const rect = imgRef.current.getBoundingClientRect()
    const x = Math.round(e.clientX - rect.left)
    const y = Math.round(e.clientY - rect.top)
    setPoints((prev) => [...prev, { x, y }])
  }

  const submit = useCallback(
    async (answer: string) => {
      if (!challenge || verifying) {
        return
      }
      setVerifying(true)
      setError('')
      const res = await window.api.captchaVerify(baseUrl, type, challenge.key, answer)
      setVerifying(false)
      if (res.ok && res.data?.token) {
        onSuccess(res.data.token)
        return
      }
      const next = failCount + 1
      setFailCount(next)
      // 每道题校验完后端就把 key 删了(controller/captcha.go 的 Check*Captcha),
      // 所以答错必须换一道,不能让用户对着同一张图再点一次。
      setError(next >= 3 ? '还是没过,换一张试试' : '验证未通过,请重试')
      void load()
    },
    [baseUrl, type, challenge, verifying, failCount, onSuccess, load]
  )

  function handleConfirmClick(): void {
    if (points.length === 0) {
      setError('请按提示顺序点击')
      return
    }
    void submit(points.map((p) => `${p.x},${p.y}`).join(';'))
  }

  // 滑块拖动:指针事件驱动 slideX,松开时提交 "x,y"。
  function onSliderPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    if (verifying) {
      return
    }
    draggingRef.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onSliderPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    if (!draggingRef.current) {
      return
    }
    const track = e.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - track.left) / track.width))
    setSlideX(Math.round(ratio * maxSlide))
  }
  function onSliderPointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    if (!draggingRef.current) {
      return
    }
    draggingRef.current = false
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    void submit(`${slideX},${tileY}`)
  }

  return (
    <div className="captcha-overlay" role="dialog" aria-modal="true">
      <div className="captcha-panel">
        <div className="captcha-head">
          <span className="captcha-title">
            {isSlide
              ? '拖动拼块完成拼图'
              : isRotate
                ? '拖动滑条把图片转正'
                : '按提示顺序点击图中内容'}
          </span>
          <button className="captcha-x" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        {isClick && challenge?.thumbBase64 && (
          <div className="captcha-hint">
            <span>点击顺序：</span>
            <img src={dataUri(challenge.thumbBase64, 'image/png')} alt="提示" draggable={false} />
          </div>
        )}

        <div className="captcha-stage" style={{ width: displayWidth }}>
          {loading ? (
            <div className="captcha-loading">
              <LoadingLottie size="md" label="加载中" />
              <span>加载中…</span>
            </div>
          ) : challenge ? (
            <>
              <img
                ref={imgRef}
                className={`captcha-img${isRotate ? ' round' : ''}`}
                src={dataUri(challenge.imageBase64)}
                alt="验证码"
                width={displayWidth}
                draggable={false}
                onClick={onImageClick}
                style={{ cursor: isClick ? 'crosshair' : 'default' }}
              />
              {/* 点选标记 */}
              {isClick &&
                points.map((p, i) => (
                  <span key={i} className="captcha-dot" style={{ left: p.x - 12, top: p.y - 12 }}>
                    {i + 1}
                  </span>
                ))}
              {/* 滑块拼块 */}
              {isSlide && challenge.thumbBase64 && (
                <img
                  className="captcha-tile"
                  src={dataUri(challenge.thumbBase64, 'image/png')}
                  alt="拼块"
                  draggable={false}
                  style={{ left: slideX, top: tileY, width: tileW, height: tileH }}
                />
              )}
              {/* 旋转圆块:钉在底图正中,只转不移 */}
              {isRotate && challenge.thumbBase64 && (
                <img
                  className="captcha-rotate-thumb"
                  src={dataUri(challenge.thumbBase64, 'image/png')}
                  alt="待转正的图块"
                  draggable={false}
                  style={{
                    width: rotateThumb,
                    height: rotateThumb,
                    transform: `translate(-50%, -50%) rotate(${angle}deg)`
                  }}
                />
              )}
            </>
          ) : (
            <div className="captcha-loading">{error || '获取验证码失败'}</div>
          )}
        </div>

        {isSlide && challenge && (
          <div
            className="captcha-slider"
            onPointerDown={onSliderPointerDown}
            onPointerMove={onSliderPointerMove}
            onPointerUp={onSliderPointerUp}
          >
            <div className="captcha-slider-fill" style={{ width: slideX + 24 }} />
            <div className="captcha-slider-handle" style={{ left: (slideX / (maxSlide || 1)) * 100 + '%' }}>
              ⇄
            </div>
            <span className="captcha-slider-text">拖动滑块</span>
          </div>
        )}

        {/*
          旋转用原生 range 而不是自绘轨道:角度只有一个自由度,原生控件天然带键盘可达
          (方向键微调)与触控命中区。松手即提交是官方的交互;键盘用户走下面那个「确认」。
        */}
        {isRotate && challenge && (
          <input
            className="captcha-range"
            type="range"
            min={0}
            max={359}
            step={1}
            value={angle}
            disabled={verifying}
            aria-label="旋转角度"
            onChange={(e) => setAngle(Number(e.target.value))}
            onPointerUp={() => void submit(String(angle))}
          />
        )}

        {error && <div className="captcha-error">{error}</div>}

        <div className="captcha-actions">
          <button className="captcha-btn-ghost" onClick={() => void load()} disabled={verifying}>
            换一张
          </button>
          {isClick && (
            <>
              <button
                className="captcha-btn-ghost"
                onClick={() => setPoints((p) => p.slice(0, -1))}
                disabled={verifying || points.length === 0}
              >
                撤销
              </button>
              <button
                className="captcha-btn-primary"
                onClick={handleConfirmClick}
                disabled={verifying || points.length === 0}
              >
                {verifying ? '验证中…' : '确认'}
              </button>
            </>
          )}
          {isRotate && (
            <button
              className="captcha-btn-primary"
              onClick={() => void submit(String(angle))}
              disabled={verifying}
            >
              {verifying ? '验证中…' : '确认'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
