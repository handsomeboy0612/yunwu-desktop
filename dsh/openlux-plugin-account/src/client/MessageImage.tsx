/**
 * Thumbnails and the gallery that lays them out.
 *
 * Ported from the kernel's attachment atoms
 * (`dsh-client-ui-attachment/src/MessageImage.tsx`, 0.1.0-rc.6) for the reason
 * given in `ImageLightbox.tsx`: at 0.1.1-rc.2 those atoms stopped being package
 * values. The sizing rules, the retry path, and the loader contract are kept as
 * they were, so a picture the model drew still behaves like one the user
 * pasted — the difference is that keeping the two agreeing is now our job.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { ImageLightbox, type ImageLightboxLabels } from './ImageLightbox.tsx'

/** Loads a session-authorized durable image URL. */
export type ImageLoader = (attachment: ImageAttachmentRef) => Promise<string>

/** Message-image strings the owner resolves from its own locale namespace. */
export interface MessageImageLabels {
  /** Fallback display name for an unnamed image. */
  image: string
  /** Thumbnail tooltip inviting the original-image preview. */
  open: string
  /** Accessible thumbnail label; receives the image's display name. */
  openNamed: (label: string) => string
  /** Loading placeholder shown until bytes resolve. */
  loading: string
  /** Retry-control label shown when the load fails. */
  loadFailed: string
  /** Lightbox strings forwarded to the opened preview. */
  lightbox: ImageLightboxLabels
}

/** Side of a square tile when several images share a row. */
const TILE = 64

const styles = {
  gallery: { display: 'flex', flexWrap: 'wrap', gap: '10px', maxWidth: '100%' },
  alignStart: { justifyContent: 'flex-start', alignSelf: 'flex-start' },
  alignEnd: { justifyContent: 'flex-end', alignSelf: 'flex-end' },
  frame: {
    display: 'grid', flex: '0 0 auto', placeItems: 'center',
    minWidth: '44px', minHeight: '44px', padding: 0, overflow: 'hidden',
    border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)', borderRadius: '16px',
    background: 'var(--dsw-alias-interactive-bg-hover)', cursor: 'zoom-in',
  },
  tileFrame: { width: TILE, height: TILE, minWidth: TILE, minHeight: TILE },
  picture: { display: 'block', width: '100%', height: '100%', objectFit: 'cover' },
  loading: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: '18px' },
  error: {
    color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: '18px',
    maxWidth: '240px', padding: '10px 12px',
    border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)', borderRadius: '10px',
    background: 'var(--dsw-alias-interactive-bg-hover-danger)', cursor: 'pointer',
  },
  // A failed tile keeps its grid cell instead of growing to its copy.
  tileError: {
    width: TILE, height: TILE, padding: '4px', overflow: 'hidden', borderRadius: '16px',
  },
} satisfies Record<string, CSSProperties>

/**
 * Display box for a lone image (DeepSeek Chat rule): long edge 240px with
 * the rendered aspect ratio clamped to [0.25, 4] — the overflow is cropped by
 * `object-fit: cover` — and never upscaled past the image's natural size. The
 * crop anchor keeps the top of very tall images and the left of very wide
 * ones, where the informative content usually starts.
 * @param attachment - the reference whose natural size decides the box.
 * @returns the rendered size and crop anchor.
 */
function singleFit(attachment: ImageAttachmentRef): { width: number; height: number; objectPosition: string } {
  const natural = attachment.width / attachment.height
  const ratio = Math.min(4, Math.max(0.25, natural))
  const box = ratio >= 1 ? { width: 240, height: 240 / ratio } : { width: 240 * ratio, height: 240 }
  const scale = Math.min(1, attachment.width / box.width, attachment.height / box.height)
  return {
    width: Math.max(1, Math.round(box.width * scale)),
    height: Math.max(1, Math.round(box.height * scale)),
    objectPosition: natural < 0.25 ? 'center top' : natural > 4 ? 'left center' : 'center',
  }
}

/**
 * Compact renderer with retryable loading and click-to-open original preview.
 * A lone image renders at its `singleFit` size; an image among several renders
 * as a fixed 64px square tile.
 *
 * @param props.attachment - the durable image reference to load and bound.
 * @param props.load - session-authorized URL loader.
 * @param props.variant - `single` for a lone image, `tile` otherwise.
 * @param props.labels - resolved strings (tooltip, loading, retry, lightbox).
 * @returns the bounded thumbnail button, or the retry control on failure.
 */
export function MessageImage({ attachment, load, variant, labels }: {
  attachment: ImageAttachmentRef
  load: ImageLoader
  variant: 'single' | 'tile'
  labels: MessageImageLabels
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(false)
  // Retry re-arms the one load effect below, so every attempt — first load or
  // retry — runs under the same liveness guard and the same reset.
  const [attempt, setAttempt] = useState(0)
  const request = useCallback(() => { setAttempt(a => a + 1) }, [])
  const close = useCallback(() => { setOpen(false) }, [])
  const fit = useMemo(
    () => (variant === 'single' ? singleFit(attachment) : undefined),
    [attachment, variant],
  )

  useEffect(() => {
    let live = true
    setError(false)
    setSrc(null)
    void load(attachment).then((url) => { if (live) setSrc(url) }).catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [attachment, load, attempt])

  const label = attachment.name ?? labels.image
  if (error) {
    return (
      <button
        type="button"
        style={variant === 'tile' ? { ...styles.error, ...styles.tileError } : styles.error}
        data-variant={variant}
        onClick={request}
      >
        {labels.loadFailed}
      </button>
    )
  }
  return (
    <>
      <button
        type="button"
        style={{
          ...styles.frame,
          ...variant === 'tile' ? styles.tileFrame : {},
          ...fit === undefined ? {} : { width: fit.width, height: fit.height },
        }}
        data-variant={variant}
        title={labels.open}
        aria-label={labels.openNamed(label)}
        onClick={() => { if (src !== null) setOpen(true) }}
      >
        {src === null
          ? <span style={styles.loading}>{labels.loading}</span>
          : (
              <img
                src={src}
                alt={label}
                style={fit === undefined ? styles.picture : { ...styles.picture, objectPosition: fit.objectPosition }}
              />
            )}
      </button>
      {open && src !== null && <ImageLightbox src={src} alt={label} labels={labels.lightbox} onClose={close} />}
    </>
  )
}

/**
 * Wrapping image group: a lone image renders large, several render as 64px
 * square tiles (DeepSeek Chat rule).
 * @param props.images - the durable references, in the order to show them.
 * @param props.load - session-authorized URL loader shared by every thumbnail.
 * @param props.align - which edge the group hugs.
 * @param props.labels - resolved strings passed to every thumbnail.
 * @returns the group, or nothing when there are no images.
 */
export function ImageGallery({ images, load, align, labels }: {
  images: readonly { attachment: ImageAttachmentRef }[]
  load: ImageLoader
  align: 'start' | 'end'
  labels: MessageImageLabels
}) {
  if (images.length === 0) return null
  const variant = images.length === 1 ? 'single' : 'tile'
  return (
    <div
      style={{ ...styles.gallery, ...align === 'end' ? styles.alignEnd : styles.alignStart }}
      data-align={align}
    >
      {images.map((image, index) => (
        <MessageImage
          key={`${image.attachment.attachmentId}:${index}`}
          {...image}
          load={load}
          variant={variant}
          labels={labels}
        />
      ))}
    </div>
  )
}
