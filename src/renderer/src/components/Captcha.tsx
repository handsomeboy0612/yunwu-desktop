import { useCallback, useEffect, useRef, useState } from 'react'
import type { CaptchaChallenge, CaptchaType } from '@shared/types'

interface Props {
  baseUrl: string
  type: CaptchaType
  /** 验证通过,返回一次性 captcha_token。 */
  onSuccess: (token: string) => void
  /** 关闭(用户取消)。 */
  onClose: () => void
  /** 不支持的模式或多次失败:请求改用网页登录。 */
  onFallback: () => void
}

/** 该模式是否由桌面端原生渲染(rotate 交给网页登录)。 */
export function isNativeCaptcha(type: CaptchaType): boolean {
  return type !== 'rotate'
}

interface ClickPoint {
  x: number
  y: number
}

/**
 * 云雾登录人机验证码(go-captcha)原生弹层。
 * 点选(click-text/click-shape):按提示顺序点击主图,提交 "x1,y1;x2,y2"。
 * 滑块(slide-basic/slide-region):拖底部滑条把拼块移入缺口,提交 "x,y"。
 * 取题/校验都经主进程(window.api.captcha*),规避渲染层跨源;图片以 base64 data URI 显示。
 */
export default function Captcha({ baseUrl, type, onSuccess, onClose, onFallback }: Props) {
  const isSlide = type.startsWith('slide')
  const [challenge, setChallenge] = useState<CaptchaChallenge | null>(null)
  const [loading, setLoading] = useState(true)
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState('')
  const [failCount, setFailCount] = useState(0)

  // 点选:已点坐标(图片原始坐标系,展示按 1:1)。
  const [points, setPoints] = useState<ClickPoint[]>([])
  // 滑块:拼块当前 x(图片坐标)。
  const [slideX, setSlideX] = useState(0)
  const draggingRef = useRef(false)
  const imgRef = useRef<HTMLImageElement>(null)

  const dataUri = (b64?: string, mime = 'image/jpeg'): string =>
    b64 ? (b64.startsWith('data:') ? b64 : `data:${mime};base64,${b64}`) : ''

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    setPoints([])
    setSlideX(0)
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

  function onImageClick(e: React.MouseEvent<HTMLImageElement>): void {
    if (!challenge || verifying || isSlide || !imgRef.current) {
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
      if (next >= 4) {
        onFallback()
        return
      }
      setError('验证未通过,请重试')
      void load()
    },
    [baseUrl, type, challenge, verifying, failCount, onSuccess, onFallback, load]
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
            {isSlide ? '拖动拼块完成拼图' : '按提示顺序点击图中内容'}
          </span>
          <button className="captcha-x" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        {!isSlide && challenge?.thumbBase64 && (
          <div className="captcha-hint">
            <span>点击顺序：</span>
            <img src={dataUri(challenge.thumbBase64, 'image/png')} alt="提示" draggable={false} />
          </div>
        )}

        <div className="captcha-stage" style={{ width: displayWidth }}>
          {loading ? (
            <div className="captcha-loading">加载中…</div>
          ) : challenge ? (
            <>
              <img
                ref={imgRef}
                className="captcha-img"
                src={dataUri(challenge.imageBase64)}
                alt="验证码"
                width={displayWidth}
                draggable={false}
                onClick={onImageClick}
                style={{ cursor: isSlide ? 'default' : 'crosshair' }}
              />
              {/* 点选标记 */}
              {!isSlide &&
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

        {error && <div className="captcha-error">{error}</div>}

        <div className="captcha-actions">
          <button className="captcha-btn-ghost" onClick={() => void load()} disabled={verifying}>
            换一张
          </button>
          {!isSlide && (
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
          <button className="captcha-btn-link" onClick={onFallback} disabled={verifying}>
            改用网页登录
          </button>
        </div>
      </div>
    </div>
  )
}
