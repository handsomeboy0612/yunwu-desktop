import { BRAND_MARK_ROUTE, WORDMARK_TEXT } from '../brand.ts'

/**
 * The upstream wordmark's own aspect box, and the only stable hook onto it.
 *
 * `ui-sidebar` renders the brand row itself — its slot contract declares holes
 * for the workspace browser, the settings seat, and footer actions, and says in
 * so many words that the shell keeps the brand row — so the art arrives as
 * `BrandWordmark` from the platform module layer with no row to occupy. The
 * emitted class names carry a per-build hash (`hHd-Xa_brand`), so they are not
 * something to select on; the svg's viewBox is part of the component's declared
 * contract (`width keeps the 182:24 ratio`) and survives a rebuild.
 *
 * tests/web-brand.spec.ts reads this literal back out and checks the shipped
 * frontend bundle still draws it, so an upstream art change fails the check
 * instead of silently restoring the DeepSeek wordmark.
 */
export const WORDMARK_VIEW_BOX = '0 0 182 24'

/**
 * The upstream `FishLogo`'s aspect box, hooked for the same reason.
 *
 * This one is the standalone glyph rather than the lettered wordmark, and the
 * sidebar reaches for it wherever the wordmark does not fit: the rail state
 * paints it inside the expand button, and the new-session view puts it ahead of
 * the headline. Its ratio is declared the same way ("height keeps the
 * 23.16:17.04 ratio"), so one rule covers every site — including sites this
 * product has not met yet.
 */
export const FISH_VIEW_BOX = '0 0 23.16 17.04'

const WORDMARK_SELECTOR = `button:has(> svg[viewBox="${WORDMARK_VIEW_BOX}"])`
const FISH_SELECTOR = `svg[viewBox="${FISH_VIEW_BOX}"]`

/** Brand row stylesheet, kept as a plain string like the advanced-shell sheet. */
export const BRAND_STYLES = `
${WORDMARK_SELECTOR} > svg[viewBox="${WORDMARK_VIEW_BOX}"] { display: none; }
${WORDMARK_SELECTOR} { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
${WORDMARK_SELECTOR}::before { content: ""; flex: none; width: 24px; height: 24px; background: url("${BRAND_MARK_ROUTE}") center / contain no-repeat; }
${WORDMARK_SELECTOR}::after { content: "${WORDMARK_TEXT}"; font-size: 18px; font-weight: 600; line-height: 24px; letter-spacing: 0.01em; white-space: nowrap; color: var(--dsw-alias-label-primary, currentColor); }
/* Repaint rather than replace: each site sizes the glyph itself, so keeping the
   svg's own box is what makes one rule fit a 24px rail icon and a headline. */
${FISH_SELECTOR} { background: url("${BRAND_MARK_ROUTE}") center / contain no-repeat; }
${FISH_SELECTOR} > path { display: none; }
`

/** Install and remove the brand row art. @returns the style disposer. */
export function installBrandStyles(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-plugin-desktop'
  style.dataset.pluginCss = 'dsh-plugin-desktop/brand'
  style.textContent = BRAND_STYLES
  document.head.appendChild(style)
  return () => { style.remove() }
}
