/**
 * Original-image preview opened from a thumbnail.
 *
 * Ported from the kernel's attachment atom
 * (`dsh-client-ui-attachment/src/ImageLightbox.tsx`, 0.1.0-rc.6), which stopped
 * being reusable at 0.1.1-rc.2: that package became a presentation plugin that
 * registers into conversation-owned slots and exports no React components, and
 * the client build now rejects cross-plugin value imports outright. The chat's
 * own images render through a child slot only its chat view may fill, so a tool
 * row brings its own presentation. Behaviour and geometry are kept identical to
 * the atom, with its stylesheet translated to this package's inline-style
 * convention (its rules used no pseudo-classes, so nothing is lost).
 */

import { useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'

/** Lightbox strings the owner resolves from its own locale namespace. */
export interface ImageLightboxLabels {
  /** Accessible name of the preview dialog. */
  dialog: string
  /** Accessible label of the close control. */
  close: string
}

const styles = {
  backdrop: {
    position: 'fixed', inset: 0, zIndex: 1000,
    display: 'grid', placeItems: 'center', padding: '40px',
  },
  // A separate layer rather than a background on the backdrop: the blur would
  // otherwise take the previewed image and the close control with the page.
  mask: {
    position: 'absolute', inset: 0,
    background: 'var(--dsw-alias-bg-mask-1)', backdropFilter: 'var(--dsw-mask-blur)',
  },
  image: {
    position: 'relative',
    maxWidth: 'min(100%, 1600px)', maxHeight: 'calc(100vh - 80px)', objectFit: 'contain',
    borderRadius: '12px', background: 'var(--dsw-specific-input-major)',
    boxShadow: 'var(--dsw-shadow-lv3)',
  },
  close: {
    position: 'fixed', top: '20px', right: '20px', zIndex: 1,
    display: 'grid', placeItems: 'center', width: '36px', height: '36px',
    border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)', borderRadius: '999px',
    background: 'var(--dsw-specific-input-major)', color: 'var(--dsw-alias-label-primary)',
    cursor: 'pointer',
  },
} satisfies Record<string, CSSProperties>

/**
 * Document-level original-image preview opened by clicking a thumbnail.
 * Closes on Escape, backdrop press, or the close control, and restores focus
 * to the opener on unmount. Rendered through a body portal: an opener inside
 * a transformed or filtered ancestor would otherwise trap the fixed backdrop
 * in that ancestor's box instead of covering the viewport.
 *
 * @param props.src - the original image URL.
 * @param props.alt - the image's alt text.
 * @param props.labels - dialog and close-control strings.
 * @param props.onClose - dismiss callback owned by the opener.
 * @returns the modal preview dialog.
 */
export function ImageLightbox({ src, alt, labels, onClose }: {
  src: string
  alt: string
  labels: ImageLightboxLabels
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      restoreRef.current?.focus()
    }
  }, [onClose])

  return createPortal(
    <div style={styles.backdrop} role="dialog" aria-modal="true" aria-label={labels.dialog}>
      <div style={styles.mask} aria-hidden="true" onMouseDown={onClose} />
      <img style={styles.image} src={src} alt={alt} />
      <button ref={closeRef} type="button" style={styles.close} aria-label={labels.close} onClick={onClose}>
        <IconCloseOutline16 size={16} />
      </button>
    </div>,
    document.body,
  )
}
