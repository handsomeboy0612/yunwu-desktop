/**
 * The file chip's pill, as far as the composer's mirror layer allows one.
 *
 * ## What is being matched
 *
 * WorkBuddy's attachment tag is a filled pill: `background: #f2f2f2` in light
 * (`rgba(255,255,255,.08)` in dark), `border-radius: 6px`, `padding: 2px 6px`,
 * 13px/500 text, and on hover the icon slot turns into a close button
 * (`chat-input/editor/components/input-context.module.scss`, read out of
 * `renderer/assets/src-0zJL21yZ.css`). Ours arrives as upstream's chip:
 * blue label, no fill.
 *
 * ## Why only the fill and the corners come over
 *
 * Measured in the running app (CDP, 2026-08-24): the composer's `<textarea>`
 * renders its own text fully transparent (`color: rgba(0,0,0,0)`,
 * `-webkit-text-fill-color` the same) and leaves only the caret; every visible
 * glyph is painted by the mirror `div.uV2eYG_backdrop`, which shares the
 * textarea's box, font, padding and `white-space` exactly. Two consequences
 * decide this file:
 *
 * - **Horizontal padding and font-weight are unavailable.** They change glyph
 *   advances in the mirror while the textarea keeps the old metrics, so the
 *   caret and the selection would drift away from the text the user sees. This
 *   is why the pill hugs its label instead of breathing 6px like WorkBuddy's.
 *   Vertical padding paints outside the line box without moving anything, so
 *   that half is taken.
 * - **The pill cannot carry a close button.** The backdrop is
 *   `pointer-events: none` and `aria-hidden`, i.e. it is paint, not UI. A chip
 *   is removed the way upstream's own `@file` chips are: backspace, or undo.
 *
 * The label keeps upstream's business blue rather than WorkBuddy's near-black:
 * every other reference in this composer (`@file`, `@session`, plain-text
 * refs) is that colour, and repainting one family black would say "these two
 * are different kinds of thing" when they are the same kind.
 *
 * ## Why a stylesheet rather than a patch
 *
 * The chip's own class is a hashed CSS-module name, but the same element
 * carries `data-decoration="chip"` and `data-reference-appearance`, which are
 * plain attributes upstream writes on purpose (`InputBar.tsx`) — the intended
 * seam for exactly this. Injection follows the kernel's own convention for
 * plugin CSS: one `<style>` tagged `data-plugin-css`, skipped when already
 * present (`ui-conversation`'s bundles do the same check).
 *
 * @module openlux-plugin-account/client/file-chip-style
 */

/** Marker on the injected tag; also the double-injection guard. */
const TAG_ID = 'openlux-plugin-account/file-chip'

/**
 * The rule set.
 *
 * `:not([data-invalid])` keeps the kernel's own broken-reference styling
 * (error colour plus strike-through) readable: a chip whose owner could not
 * serialize it must not look like a healthy attachment.
 */
const CSS = `
[data-decoration="chip"][data-reference-appearance="file"]:not([data-invalid]) {
  background: var(--dsw-alias-interactive-bg-hover);
  border-radius: 4px;
  padding-block: 2px;
}
`

/**
 * Mount the stylesheet.
 * @returns the disposer; wrap the call in `ctx.effect`.
 */
export function installFileChipStyle(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.querySelector(`style[data-plugin-css="${TAG_ID}"]`)
  if (existing !== null) return () => {}
  const tag = document.createElement('style')
  tag.setAttribute('data-plugin-css', TAG_ID)
  tag.textContent = CSS
  document.head.append(tag)
  return () => { tag.remove() }
}
