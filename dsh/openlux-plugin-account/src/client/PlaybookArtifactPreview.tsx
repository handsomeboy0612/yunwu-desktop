/**
 * Interactive preview for playbook artifacts.
 *
 * Design artifacts carry the four-message bridge injected by
 * `admin-server/scripts/inject-playbook-bridge.cjs:32-98`. The outer viewer
 * owns zoom, pan, layers, and annotations; the cross-origin artifact only
 * reports its real canvas geometry and performs page/measurement commands.
 * Ordinary HTML without that bridge remains a plain full-size iframe.
 */

import {
  useCallback, useEffect, useRef, useState, type ReactNode,
} from 'react'
import type { PlaybookArtifact } from '../market/wire.ts'
import type { MarketKey } from './market-locales.ts'

type T = (key: MarketKey, params?: Record<string, unknown>) => string

const ZOOM_STEPS = [0.1, 0.15, 0.25, 0.5, 0.75, 1, 1.5, 2, 3] as const
const STAGE_PAD = 16
const PAN_KEEP = 80

interface CanvasMeta {
  readonly w: number
  readonly h: number
  readonly fit: 'contain' | 'width'
  readonly pages: number
  readonly contentH: number
}

interface ViewState {
  readonly zoom: number
  readonly x: number
  readonly y: number
  readonly hand: boolean
  readonly measure: boolean
}

interface MeasureBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly label: string
}

interface StageSize {
  readonly w: number
  readonly h: number
}

const VIEW_INIT: ViewState = {
  zoom: 0,
  x: 0,
  y: 0,
  hand: false,
  measure: true,
}

function positive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function stageBox(stage: StageSize): StageSize {
  return {
    w: Math.max(0, stage.w - STAGE_PAD * 2),
    h: Math.max(0, stage.h - STAGE_PAD * 2),
  }
}

function fitZoom(meta: CanvasMeta, stage: StageSize): number {
  const available = stageBox(stage)
  if (available.w === 0 || available.h === 0) return 1
  return meta.fit === 'contain'
    ? Math.min(available.w / meta.w, available.h / meta.h)
    : available.w / meta.w
}

function pageZoom(meta: CanvasMeta, stage: StageSize): number {
  const available = stageBox(stage)
  if (available.w === 0 || available.h === 0) return 1
  return Math.min(available.w / meta.w, available.h / (meta.contentH || meta.h))
}

function frameBox(meta: CanvasMeta, zoom: number): StageSize {
  const designHeight = meta.fit === 'contain' ? meta.h : (meta.contentH || meta.h)
  return {
    w: Math.round(meta.w * zoom),
    h: Math.round(designHeight * zoom),
  }
}

/**
 * Position a canvas on one axis: centered when it fits, top/left aligned when
 * it does not. Long designs therefore open on their first screen.
 */
function canvasBase(box: number, stage: number): number {
  return box <= stage - STAGE_PAD * 2 ? (stage - box) / 2 : STAGE_PAD
}

/**
 * Keep only a recoverable strip on the white desk.
 *
 * Do not disable panning when the canvas fits. That old rule made the hand
 * tool inert at fit zoom; WorkBuddy's design viewer permits the work to move
 * almost entirely off the desk.
 */
function clampPan(
  x: number,
  y: number,
  frame: StageSize,
  stage: StageSize,
): { readonly x: number; readonly y: number } {
  const axis = (value: number, box: number, desk: number): number => {
    const base = canvasBase(box, desk)
    const keep = Math.min(PAN_KEEP, box)
    return Math.min(desk - keep - base, Math.max(keep - box - base, value))
  }
  return {
    x: axis(x, frame.w, stage.w),
    y: axis(y, frame.h, stage.h),
  }
}

/** Artifact viewer props shared by expert details and the future home scenes page. */
export interface PlaybookArtifactPreviewProps {
  readonly artifact: PlaybookArtifact
  readonly title: string
  readonly expanded: boolean
  readonly t: T
}

/** Render videos/images directly and HTML-like artifacts through the bridge-aware viewer. */
export function PlaybookArtifactPreview(
  { artifact, title, expanded, t }: PlaybookArtifactPreviewProps,
): ReactNode {
  if (artifact.artifactType === 'video') {
    return (
      <video
        src={artifact.url}
        controls
        autoPlay
        preload="metadata"
        className="openlux-artifact-media"
      />
    )
  }
  if (artifact.artifactType === 'image') {
    return <img src={artifact.url} alt={title} className="openlux-artifact-media" />
  }
  return (
    <BridgeArtifactPreview
      artifact={artifact}
      title={title}
      expanded={expanded}
      t={t}
    />
  )
}

function BridgeArtifactPreview(
  { artifact, title, expanded, t }: PlaybookArtifactPreviewProps,
): ReactNode {
  const stageRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const dragRef = useRef<{
    readonly pointerId: number
    readonly px: number
    readonly py: number
    readonly x: number
    readonly y: number
    readonly frame: StageSize
    readonly stage: StageSize
  }>()
  const [stage, setStage] = useState<StageSize>({ w: 0, h: 0 })
  const [meta, setMeta] = useState<CanvasMeta>()
  const [view, setView] = useState<ViewState>(VIEW_INIT)
  const [page, setPage] = useState(1)
  const [measure, setMeasure] = useState<MeasureBox>()
  const [zoomMenu, setZoomMenu] = useState(false)

  const zoom = meta === undefined ? 1 : (view.zoom || fitZoom(meta, stage))
  const frame = meta === undefined ? stage : frameBox(meta, zoom)
  const base = meta === undefined
    ? { x: 0, y: 0 }
    : { x: canvasBase(frame.w, stage.w), y: canvasBase(frame.h, stage.h) }
  const frameLeft = Math.round(base.x + view.x)
  const frameTop = Math.round(base.y + view.y)

  const send = useCallback((message: Record<string, unknown>): void => {
    frameRef.current?.contentWindow?.postMessage({ wb: 1, ...message }, '*')
  }, [])

  const zoomTo = useCallback((next: number): void => {
    if (meta === undefined) return
    const target = Math.min(3, Math.max(0.05, next))
    setView(current => {
      const currentZoom = current.zoom || fitZoom(meta, stage)
      const ratio = target / currentZoom
      const targetFrame = frameBox(meta, target)
      return {
        ...current,
        zoom: target,
        ...clampPan(current.x * ratio, current.y * ratio, targetFrame, stage),
      }
    })
  }, [meta, stage])

  useEffect(() => {
    setMeta(undefined)
    setPage(1)
    setMeasure(undefined)
    setView(VIEW_INIT)
    setZoomMenu(false)
  }, [artifact.url])

  // A resized modal is a new desk. Refit rather than carrying a stale pixel
  // offset from the smaller frame.
  useEffect(() => {
    setView(VIEW_INIT)
    setMeasure(undefined)
    setZoomMenu(false)
  }, [expanded])

  useEffect(() => {
    const element = stageRef.current
    if (element === null) return
    const sync = (): void => setStage({ w: element.clientWidth, h: element.clientHeight })
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(element)
    return () => observer.disconnect()
  }, [expanded, meta?.pages])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      // Thumbnails run the same bridge. Source matching is mandatory or their
      // 130px geometry overwrites the main canvas
      // (`yunwu-desktop/src/renderer/src/pages/Workspace.tsx:3307-3362`).
      if (event.source !== frameRef.current?.contentWindow) return
      const data = event.data as Record<string, unknown> | null
      if (data === null || data['wb'] !== 1) return
      const type = data['type']
      if (type === 'ready') {
        const w = positive(data['w'])
        const h = positive(data['h'])
        const contentH = positive(data['contentH']) || h
        const fit = data['fit'] === 'width' ? 'width' : 'contain'
        if (w === 0 || (fit === 'contain' ? h === 0 : contentH === 0)) return
        setMeta({
          w,
          h: h || contentH,
          fit,
          pages: Math.max(1, Math.round(positive(data['pages']) || 1)),
          contentH,
        })
        setPage(Math.max(1, Math.round(positive(data['page']) || 1)))
      } else if (type === 'page') {
        setPage(Math.max(1, Math.round(positive(data['page']) || 1)))
      } else if (type === 'scale') {
        const contentH = positive(data['contentH'])
        if (contentH > 0) setMeta(current => current === undefined ? current : { ...current, contentH })
      } else if (type === 'measure') {
        if (data['hit'] !== true) {
          setMeasure(undefined)
          return
        }
        setMeasure({
          x: typeof data['x'] === 'number' ? data['x'] : 0,
          y: typeof data['y'] === 'number' ? data['y'] : 0,
          w: positive(data['w']),
          h: positive(data['h']),
          label: typeof data['label'] === 'string' ? data['label'] : '',
        })
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // The bridge starts with measuring disabled. Sync once ready and again when
  // zoom/resizing invalidates the last reported viewport rectangle.
  useEffect(() => {
    if (meta === undefined) return
    setMeasure(undefined)
    send({ type: 'measure', on: view.measure })
  }, [expanded, meta !== undefined, send, view.measure, view.zoom])

  useEffect(() => {
    if (meta === undefined) return
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || (target instanceof HTMLElement && target.isContentEditable)
      ) return
      if (zoomMenu) {
        if (event.key === 'Escape') {
          event.stopPropagation()
          setZoomMenu(false)
        }
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key === 'h' || event.key === 'H') {
        setView(current => ({ ...current, hand: true, measure: false }))
      } else if (event.key === '+' || event.key === '=') {
        zoomTo(ZOOM_STEPS.find(step => step > zoom + 1e-4) ?? ZOOM_STEPS.at(-1) ?? 3)
      } else if (event.key === '-' || event.key === '_') {
        zoomTo([...ZOOM_STEPS].reverse().find(step => step < zoom - 1e-4) ?? ZOOM_STEPS[0])
      } else if (event.key === '0') {
        zoomTo(1)
      } else if (event.key === 'ArrowRight' && meta.pages > 1) {
        send({ type: 'goto', page: Math.min(meta.pages, page + 1) })
      } else if (event.key === 'ArrowLeft' && meta.pages > 1) {
        send({ type: 'goto', page: Math.max(1, page - 1) })
      } else {
        return
      }
      event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [meta, page, send, zoom, zoomMenu, zoomTo])

  const setMoveMode = (): void => {
    setView(current => ({ ...current, hand: true, measure: false }))
  }
  const setMeasureMode = (): void => {
    setView(current => ({ ...current, hand: false, measure: true }))
  }
  const smaller = [...ZOOM_STEPS].reverse().find(step => step < zoom - 1e-4) ?? ZOOM_STEPS[0]
  const larger = ZOOM_STEPS.find(step => step > zoom + 1e-4) ?? ZOOM_STEPS.at(-1) ?? 3

  return (
    <div className="openlux-artifact-stage">
      {expanded && meta !== undefined && meta.pages > 1 && (
        <aside className="openlux-artifact-layers">
          <span className="openlux-artifact-layers-title">{t('previewLayers')}</span>
          <div className="openlux-artifact-layers-list">
            {Array.from({ length: meta.pages }, (_, index) => {
              const pageNumber = index + 1
              return (
                <button
                  key={pageNumber}
                  type="button"
                  className={`openlux-artifact-layer${page === pageNumber ? ' is-active' : ''}`}
                  title={t('previewPage', { page: pageNumber })}
                  onClick={() => send({ type: 'goto', page: pageNumber })}
                >
                  <span className="openlux-artifact-layer-number">{pageNumber}</span>
                  <iframe
                    src={artifact.url}
                    title={t('previewPage', { page: pageNumber })}
                    tabIndex={-1}
                    sandbox="allow-scripts allow-same-origin"
                    referrerPolicy="no-referrer"
                    onLoad={event => {
                      const target = event.currentTarget.contentWindow
                      window.setTimeout(() => {
                        target?.postMessage({ wb: 1, type: 'thumb' }, '*')
                        target?.postMessage({ wb: 1, type: 'goto', page: pageNumber }, '*')
                      }, 30)
                    }}
                  />
                </button>
              )
            })}
          </div>
        </aside>
      )}
      <div
        ref={stageRef}
        className={`openlux-artifact-desk${meta === undefined ? '' : ' has-canvas'}`}
      >
        <iframe
          key={artifact.url}
          ref={frameRef}
          src={artifact.url}
          title={title}
          className="openlux-artifact-frame"
          sandbox="allow-scripts allow-forms allow-modals allow-popups allow-same-origin"
          allow="fullscreen"
          referrerPolicy="no-referrer"
          style={meta === undefined
            ? { width: '100%', height: '100%', left: 0, top: 0 }
            : {
                width: `${frame.w}px`,
                height: `${frame.h}px`,
                left: `${frameLeft}px`,
                top: `${frameTop}px`,
              }}
          onLoad={() => send({ type: 'ping' })}
        />

        {measure !== undefined && (
          <div className="openlux-artifact-measure" aria-hidden="true">
            <span
              className="openlux-artifact-measure-box"
              style={{
                left: `${frameLeft + measure.x}px`,
                top: `${frameTop + measure.y}px`,
                width: `${measure.w}px`,
                height: `${measure.h}px`,
              }}
            />
            <span
              className="openlux-artifact-measure-tag"
              style={{
                left: `${frameLeft + measure.x + measure.w / 2}px`,
                top: `${frameTop + measure.y + measure.h + 4}px`,
              }}
            >
              {measure.label}
            </span>
          </div>
        )}

        {meta !== undefined && view.hand && (
          <div
            className="openlux-artifact-grab"
            onWheel={event => {
              event.preventDefault()
              if (event.ctrlKey || event.metaKey) {
                zoomTo(zoom * (event.deltaY > 0 ? 0.9 : 1.1))
                return
              }
              setView(current => ({
                ...current,
                ...clampPan(
                  current.x - event.deltaX,
                  current.y - event.deltaY,
                  frame,
                  stage,
                ),
              }))
            }}
            onPointerDown={event => {
              dragRef.current = {
                pointerId: event.pointerId,
                px: event.clientX,
                py: event.clientY,
                x: view.x,
                y: view.y,
                frame,
                stage,
              }
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={event => {
              const drag = dragRef.current
              if (drag === undefined || drag.pointerId !== event.pointerId) return
              setView(current => ({
                ...current,
                ...clampPan(
                  drag.x + event.clientX - drag.px,
                  drag.y + event.clientY - drag.py,
                  drag.frame,
                  drag.stage,
                ),
              }))
            }}
            onPointerUp={event => {
              if (dragRef.current?.pointerId !== event.pointerId) return
              dragRef.current = undefined
              event.currentTarget.releasePointerCapture(event.pointerId)
            }}
            onPointerCancel={() => { dragRef.current = undefined }}
          />
        )}

        {meta !== undefined && (
          <>
            <div className="openlux-artifact-modes">
              <button
                type="button"
                className={`openlux-artifact-mode${view.hand ? ' is-active' : ''}`}
                title={`${t('previewMove')} H`}
                aria-label={t('previewMove')}
                onClick={setMoveMode}
              >
                <HandGlyph />
              </button>
              <button
                type="button"
                className={`openlux-artifact-mode${view.measure ? ' is-active' : ''}`}
                title={t('previewMeasure')}
                aria-label={t('previewMeasure')}
                onClick={setMeasureMode}
              >
                <MeasureGlyph />
              </button>
            </div>
            <div className="openlux-artifact-zoom">
              <button
                type="button"
                className="openlux-artifact-zoom-button"
                disabled={zoom <= ZOOM_STEPS[0]}
                title={t('previewZoomOut')}
                aria-label={t('previewZoomOut')}
                onClick={() => zoomTo(smaller)}
              >
                −
              </button>
              <button
                type="button"
                className={`openlux-artifact-zoom-button openlux-artifact-zoom-value${zoomMenu ? ' is-active' : ''}`}
                title={t('previewZoomMenu')}
                aria-haspopup="menu"
                aria-expanded={zoomMenu}
                onClick={() => setZoomMenu(open => !open)}
              >
                {Math.round(zoom * 100)}% <ChevronGlyph />
              </button>
              <button
                type="button"
                className="openlux-artifact-zoom-button"
                disabled={zoom >= (ZOOM_STEPS.at(-1) ?? 3)}
                title={t('previewZoomIn')}
                aria-label={t('previewZoomIn')}
                onClick={() => zoomTo(larger)}
              >
                +
              </button>
              {zoomMenu && (
                <>
                  <button
                    type="button"
                    className="openlux-artifact-zoom-scrim"
                    aria-label={t('previewZoomMenu')}
                    onClick={() => setZoomMenu(false)}
                  />
                  <div className="openlux-artifact-zoom-menu" role="menu">
                    <input
                      className="openlux-artifact-zoom-input"
                      defaultValue={Math.round(zoom * 100)}
                      aria-label={t('previewZoomMenu')}
                      onKeyDown={event => {
                        if (event.key !== 'Enter') return
                        const percent = Number(event.currentTarget.value.replace(/[^\d.]/gu, ''))
                        if (!Number.isFinite(percent) || percent <= 0) return
                        zoomTo(percent / 100)
                        setZoomMenu(false)
                      }}
                    />
                    <button
                      type="button"
                      className="openlux-artifact-zoom-item"
                      role="menuitem"
                      onClick={() => {
                        setView(current => ({ ...current, zoom: 0, x: 0, y: 0 }))
                        setZoomMenu(false)
                      }}
                    >
                      {t('previewZoomFit')}
                    </button>
                    {meta.fit === 'width' && (
                      <button
                        type="button"
                        className="openlux-artifact-zoom-item"
                        role="menuitem"
                        onClick={() => {
                          setView(current => ({
                            ...current,
                            zoom: pageZoom(meta, stage),
                            x: 0,
                            y: 0,
                          }))
                          setZoomMenu(false)
                        }}
                      >
                        {t('previewZoomPage')}
                      </button>
                    )}
                    {[0.5, 1, 2].map(value => (
                      <button
                        key={value}
                        type="button"
                        className="openlux-artifact-zoom-item"
                        role="menuitem"
                        onClick={() => {
                          zoomTo(value)
                          setZoomMenu(false)
                        }}
                      >
                        <span>{t('previewZoomTo', { percent: value * 100 })}</span>
                        {value === 1 && <span className="openlux-artifact-zoom-key">0</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function HandGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M5.1 7V3.7a1 1 0 0 1 2 0v2.6-3.4a1 1 0 0 1 2 0v3.4-2.8a1 1 0 0 1 2 0v3.2-1.9a1 1 0 0 1 2 0v4.4c0 2.5-1.7 4.3-4.2 4.3H8c-1.7 0-2.7-.7-3.6-2L2.8 9.1a1.1 1.1 0 0 1 1.8-1.3L5.1 8V7Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function MeasureGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 12.8 12.8 3l.2 6.8-3-3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M3 12.8h4.1M3 12.8V8.7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function ChevronGlyph(): ReactNode {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="m2.5 3.8 2.5 2.5 2.5-2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}
