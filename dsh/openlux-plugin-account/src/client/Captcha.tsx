/**
 * go-captcha challenge panel.
 *
 * The interaction and the answer formats are the console's, verified against
 * its own web front end and carried over from the previous shell's
 * `renderer/src/components/Captcha.tsx`: the image is drawn 1:1 at the size
 * the console reported, so a click is already in the coordinate system the
 * answer is graded in, with no scaling step to get wrong.
 *
 *  - click-text / click-shape: `x1,y1;x2,y2` in click order
 *  - slide-basic / slide-region: `x,y`, y being the gap row the console set
 *  - rotate: `angle`, 0-359
 *
 * Fetching and grading both go through the host half; the console answers
 * without CORS headers, so the browser cannot ask it directly.
 *
 * Styling is inline rather than a CSS module because this package's client
 * bundle is built by tsdown with no CSS transform — the kernel's own hashed
 * class maps come from the bundler pipeline that compiles its `src`, which an
 * out-of-tree package does not join (`ui-primitives/tsdown.config.ts:3-10`).
 * Everything interactive is a kernel primitive, so what is left here is
 * layout.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountKey } from './locales.ts'
import type { AccountHostCaller } from './types.ts'

/** Challenge families the console can be configured to serve. */
export type CaptchaType = 'click-text' | 'click-shape' | 'slide-basic' | 'slide-region' | 'rotate'

/** One challenge, as the host normalized it. */
export interface CaptchaChallenge {
  readonly key: string
  readonly type: CaptchaType
  readonly imageBase64: string
  readonly imageWidth: number
  readonly imageHeight: number
  readonly thumbBase64?: string
  readonly thumbWidth?: number
  readonly thumbHeight?: number
  readonly thumbSize?: number
  readonly tileX?: number
  readonly tileY?: number
  readonly tileWidth?: number
  readonly tileHeight?: number
}

/** What the panel needs from its owner. */
export interface CaptchaProps {
  /** Calls this package's host half. */
  readonly callHost: AccountHostCaller
  /** Challenge family, from the console's own configuration. */
  readonly type: CaptchaType
  /** Bound translate for this package's namespace. */
  readonly t: (key: AccountKey) => string
  /** A passed challenge, carrying the one-shot token sign-in must present. */
  readonly onPassed: (token: string) => void
  /** The user backed out; the owner returns to whatever it was doing. */
  readonly onCancel: () => void
}

interface ClickPoint {
  readonly x: number
  readonly y: number
}

const styles = {
  panel: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' },
  head: { color: 'var(--dsw-alias-label-primary)', fontSize: '14px', fontWeight: 500 },
  hint: {
    display: 'flex', alignItems: 'center', gap: '8px',
    color: 'var(--dsw-alias-label-secondary)', fontSize: '12px',
  },
  stage: {
    position: 'relative', overflow: 'hidden', borderRadius: '8px',
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-2)',
  },
  waiting: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px', padding: '0 16px',
    textAlign: 'center',
  },
  dot: {
    position: 'absolute', width: '24px', height: '24px', borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--dsw-alias-button-primary-fill)',
    color: 'var(--dsw-alias-label-primary-inverted)',
    fontSize: '12px', fontWeight: 600, pointerEvents: 'none',
  },
  track: {
    position: 'relative', height: '40px', borderRadius: '20px',
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-2)',
    touchAction: 'none', userSelect: 'none', cursor: 'grab',
  },
  handle: {
    position: 'absolute', top: '3px', width: '32px', height: '32px', borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--dsw-alias-button-primary-fill)',
    color: 'var(--dsw-alias-label-primary-inverted)',
    fontSize: '14px', pointerEvents: 'none',
  },
  error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', minHeight: '16px' },
  actions: { display: 'flex', gap: '8px' },
} satisfies Record<string, CSSProperties>

/** Wrap raw base64 from the console into something an `<img>` accepts. */
function dataUri(base64: string | undefined, mime: string): string {
  if (base64 === undefined || base64 === '') return ''
  return base64.startsWith('data:') ? base64 : `data:${mime};base64,${base64}`
}

/**
 * Draw one challenge and grade the answer.
 * @param props - the owner's share; see {@link CaptchaProps}.
 * @returns the challenge panel.
 */
export function Captcha({ callHost, type, t, onPassed, onCancel }: CaptchaProps): ReactNode {
  const isClick = type.startsWith('click')
  const isSlide = type.startsWith('slide')
  const isRotate = type === 'rotate'

  const [challenge, setChallenge] = useState<CaptchaChallenge | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState('')
  const [misses, setMisses] = useState(0)
  const [points, setPoints] = useState<readonly ClickPoint[]>([])
  const [slideX, setSlideX] = useState(0)
  const [angle, setAngle] = useState(0)

  const imageRef = useRef<HTMLImageElement>(null)
  const dragging = useRef(false)
  // A challenge in flight when the panel closes must not write state back.
  const live = useRef(true)
  useEffect(() => () => { live.current = false }, [])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setPoints([])
    setSlideX(0)
    setAngle(0)
    const result = await callHost<CaptchaChallenge>('captcha.challenge', { type })
    if (!live.current) return
    if (result.ok) {
      setChallenge(result.value)
    } else {
      setChallenge(undefined)
      setError(result.error.message || t('captchaLoadFailed'))
    }
    setLoading(false)
  }, [callHost, type, t])

  useEffect(() => { void load() }, [load])

  const width = challenge?.imageWidth ?? 300
  const height = challenge?.imageHeight ?? 220
  const tileWidth = challenge?.tileWidth ?? 48
  const tileHeight = challenge?.tileHeight ?? 48
  const tileY = challenge?.tileY ?? 0
  const travel = Math.max(0, width - tileWidth)
  // The stage is 1:1 with the console's own coordinates, so the rotating disc
  // takes the size the console gave rather than a fraction of the render box.
  const discSize = challenge?.thumbSize ?? Math.round(width * 0.64)

  const submit = useCallback(async (answer: string): Promise<void> => {
    if (challenge === undefined || verifying) return
    setVerifying(true)
    setError('')
    const result = await callHost<{ passed: boolean; token: string }>(
      'captcha.verify',
      { type, key: challenge.key, answer },
    )
    if (!live.current) return
    setVerifying(false)
    if (result.ok && result.value.passed) {
      onPassed(result.value.token)
      return
    }
    const missed = misses + 1
    setMisses(missed)
    setError(result.ok
      ? t(missed >= 3 ? 'captchaRetryAgain' : 'captchaRetry')
      : result.error.message)
    // The console discards a challenge the moment it grades it, so a miss has
    // to be followed by a fresh one rather than another try at this image.
    void load()
  }, [callHost, challenge, verifying, misses, type, t, onPassed, load])

  function onImageClick(event: React.MouseEvent<HTMLImageElement>): void {
    if (!isClick || verifying || imageRef.current === null) return
    const box = imageRef.current.getBoundingClientRect()
    setPoints(previous => [...previous, {
      x: Math.round(event.clientX - box.left),
      y: Math.round(event.clientY - box.top),
    }])
  }

  function onTrackDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (verifying || challenge === undefined) return
    dragging.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onTrackMove(event: React.PointerEvent<HTMLDivElement>): void {
    if (!dragging.current) return
    const box = event.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
    setSlideX(Math.round(ratio * travel))
  }

  function onTrackUp(event: React.PointerEvent<HTMLDivElement>): void {
    if (!dragging.current) return
    dragging.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    void submit(`${slideX},${tileY}`)
  }

  function confirmClicks(): void {
    if (points.length === 0) {
      setError(t('captchaNoPoints'))
      return
    }
    void submit(points.map(point => `${point.x},${point.y}`).join(';'))
  }

  const title = isSlide ? 'captchaSlideTitle' : isRotate ? 'captchaRotateTitle' : 'captchaClickTitle'

  return (
    <div style={styles.panel} data-testid="openlux-captcha">
      <div style={styles.head}>{t(title)}</div>

      {isClick && challenge?.thumbBase64 !== undefined && (
        <div style={styles.hint}>
          <span>{t('captchaOrder')}</span>
          <img src={dataUri(challenge.thumbBase64, 'image/png')} alt="" draggable={false} />
        </div>
      )}

      <div style={{ ...styles.stage, width, height, borderRadius: isRotate ? '50%' : '8px' }}>
        {loading || challenge === undefined ? (
          <div style={{ ...styles.waiting, width, height }}>
            {loading ? t('captchaLoading') : error || t('captchaLoadFailed')}
          </div>
        ) : (
          <>
            <img
              ref={imageRef}
              src={dataUri(challenge.imageBase64, 'image/jpeg')}
              alt=""
              width={width}
              height={height}
              draggable={false}
              onClick={onImageClick}
              style={{ display: 'block', cursor: isClick ? 'crosshair' : 'default' }}
            />
            {isClick && points.map((point, index) => (
              <span key={`${point.x},${point.y},${index}`} style={{ ...styles.dot, left: point.x - 12, top: point.y - 12 }}>
                {index + 1}
              </span>
            ))}
            {isSlide && challenge.thumbBase64 !== undefined && (
              <img
                src={dataUri(challenge.thumbBase64, 'image/png')}
                alt=""
                draggable={false}
                style={{
                  position: 'absolute', left: slideX, top: tileY,
                  width: tileWidth, height: tileHeight, pointerEvents: 'none',
                }}
              />
            )}
            {isRotate && challenge.thumbBase64 !== undefined && (
              <img
                src={dataUri(challenge.thumbBase64, 'image/png')}
                alt=""
                draggable={false}
                style={{
                  position: 'absolute', left: '50%', top: '50%',
                  width: discSize, height: discSize, pointerEvents: 'none',
                  transform: `translate(-50%, -50%) rotate(${angle}deg)`,
                }}
              />
            )}
          </>
        )}
      </div>

      {isSlide && challenge !== undefined && (
        <div
          style={{ ...styles.track, width }}
          onPointerDown={onTrackDown}
          onPointerMove={onTrackMove}
          onPointerUp={onTrackUp}
          onPointerCancel={onTrackUp}
        >
          <div style={{ ...styles.handle, left: travel === 0 ? 3 : (slideX / travel) * (width - 38) + 3 }}>⇄</div>
        </div>
      )}

      {/*
        Rotation has a single degree of freedom, and a native range brings
        arrow-key nudging and a touch target that a hand-drawn track would
        have to reimplement. Releasing submits, which is the console's own
        interaction; keyboard users reach the same place through Confirm.
      */}
      {isRotate && challenge !== undefined && (
        <input
          type="range"
          min={0}
          max={359}
          step={1}
          value={angle}
          disabled={verifying}
          aria-label={t('captchaAngle')}
          style={{ width }}
          onChange={event => setAngle(Number(event.target.value))}
          onPointerUp={() => { void submit(String(angle)) }}
        />
      )}

      <div style={styles.error} role="alert">{error}</div>

      <div style={styles.actions}>
        <Button variant="ghost" size="sm" onClick={onCancel}>{t('later')}</Button>
        <Button variant="ghost" size="sm" disabled={verifying || loading} onClick={() => { void load() }}>
          {t('captchaRefresh')}
        </Button>
        {isClick && (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={verifying || points.length === 0}
              onClick={() => setPoints(previous => previous.slice(0, -1))}
            >
              {t('captchaUndo')}
            </Button>
            <Button variant="primary" size="sm" disabled={verifying || points.length === 0} onClick={confirmClicks}>
              {t(verifying ? 'captchaVerifying' : 'captchaConfirm')}
            </Button>
          </>
        )}
        {isRotate && (
          <Button variant="primary" size="sm" disabled={verifying} onClick={() => { void submit(String(angle)) }}>
            {t(verifying ? 'captchaVerifying' : 'captchaConfirm')}
          </Button>
        )}
      </div>
    </div>
  )
}
