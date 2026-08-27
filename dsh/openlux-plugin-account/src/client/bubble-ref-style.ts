/**
 * Sent-bubble reference chips and their surrounding text, on one line.
 *
 * ## What breaks without this
 *
 * The kernel re-decorates references in sent user bubbles by shape alone:
 * `ui-conversation`'s `projectUserText` splits the text around `/name`,
 * `@token` and `@"quoted path"` tokens, draws each token as an inline chip
 * (`<span data-ref-chip>` — `display:inline-flex`,
 * `vertical-align:baseline`, built for in-line flow), and renders every text
 * segment through the primitives' `MessageText`. That component is a `<div>`
 * whose stylesheet sets only `white-space:pre-wrap` and `word-break` — no
 * `display` — so each segment is a block, and one decorated token splits the
 * bubble into stacked lines: `/docx 你能干嘛` renders as a chip line plus a
 * text line. The kernel's own `@file` mentions break identically (measured on
 * the live DOM, 2026-08-28), so this is a stock rendering shape, not
 * something this plugin caused.
 *
 * ## Why a stylesheet and what it hooks
 *
 * `data-ref-chip` is a kernel-authored attribute (sibling of the
 * `data-decoration` seam `file-chip-style.ts` uses) and the only stable name
 * in that DOM — every class around it is a hashed CSS-module name. Divs
 * adjacent to a chip go `display:inline`; `pre-wrap` still honours real
 * newlines inside the text, so multi-line messages keep their breaks.
 *
 * The one non-text div that can neighbour a chip is the "extra block"
 * `JsonBlock` (messages whose content carries non-text blocks), which typed
 * messages never produce; a decorated token directly before one is accepted
 * as the rarest case there is. Without the plugin the kernel renders as
 * stock — this sheet is presentation only and degrades to nothing.
 *
 * @module openlux-plugin-account/client/bubble-ref-style
 */

/** Marker on the injected tag; also the double-injection guard. */
const TAG_ID = 'openlux-plugin-account/bubble-ref'

/** Both directions: the segment after a chip, and the segment before one. */
const CSS = `
[data-ref-chip] + div,
div:has(+ [data-ref-chip]) {
  display: inline;
}
`

/**
 * Mount the stylesheet.
 * @returns the disposer; wrap the call in `ctx.effect`.
 */
export function installBubbleRefStyle(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.querySelector(`style[data-plugin-css="${TAG_ID}"]`)
  if (existing !== null) return () => {}
  const tag = document.createElement('style')
  tag.setAttribute('data-plugin-css', TAG_ID)
  tag.textContent = CSS
  document.head.append(tag)
  return () => { tag.remove() }
}
