/**
 * The market card's hover-revealed action seat.
 *
 * ## Why a stylesheet and not inline styles
 *
 * Two things the card needs cannot be said in a `style` object: the parent's
 * `:hover` / `:focus-within` state, and the gradient pseudo-element that keeps a
 * long name from being cut mid-character where the seat floats over it. Both are
 * exactly what WorkBuddy's expert card does, so both come across as rules.
 *
 * ## What WorkBuddy does (`import-security-risk-<hash>.css`)
 *
 * Its `.ec-card-summon-btn--top` is absolutely placed at the card's top-right
 * with `opacity: 0; pointer-events: none`, and only
 * `.ec-expert-card:hover` / `:focus-within` lifts it to `opacity: 1;
 * pointer-events: auto`. A `::before` on the button paints a 40px
 * transparent-to-card-background gradient over the strip to its left, with the
 * comment «长标题滚到按钮下方时平滑淡出到卡片背景色，避免文字被硬切» — so the
 * title keeps the whole card width and simply fades out under the seat instead
 * of having a column reserved for a control that is not on screen.
 *
 * ## The one deliberate addition
 *
 * A seat marked `always` ignores the hover gate. Two states earn it: a row that
 * is mid-install (our summon installs first, which takes seconds — hiding the
 * «准备中» the moment the pointer leaves would lose the only progress the user
 * has) and a seat that is a statement rather than a control (the quiet tick).
 * This is the same lesson as the sidebar's `menu-open` mirror: a control that
 * only exists on hover has to name every state that must outlive the pointer.
 *
 * Injection follows `footer-row-style.ts`: one `<style>` tagged
 * `data-plugin-css`, skipped when already present.
 *
 * @module openlux-plugin-account/client/market-card-style
 */

/** Marker on the injected tag; also the double-injection guard. */
const TAG_ID = 'openlux-plugin-account/market-card'

/** Attribute the card's action seat carries; the value decides the hover gate. */
export const SEAT_ATTR = 'data-openlux-market-seat'

/**
 * Marker on the install-in-progress ring.
 *
 * WorkBuddy's `.skill-install-loading` is a 14px CSS ring (`0.6s linear
 * infinite`), not a glyph. The kernel's `IconLoadingOutline16` is a static
 * 3/4-arc with no animation of its own — putting it in the seat is why a
 * click looked frozen, then jumped to the tick.
 */
export const SPIN_ATTR = 'data-openlux-market-spin'

/**
 * Marker on a connector card's status dot; the value names the state.
 *
 * WorkBuddy's connector card carries a small dot beside the name — green when
 * connected, a *breathing* yellow while connecting, red when the row did not
 * come up. The breathing is a CSS animation, which is why the dot lives in
 * this sheet rather than in a `style` object.
 */
export const DOT_ATTR = 'data-openlux-market-dot'

/**
 * The rule set.
 *
 * The card is selected through its own test id, the convention this plugin's
 * other sheet already uses — the alternative is depending on a hashed CSS
 * module name that is not ours.
 */
const CSS = `
[${SEAT_ATTR}] {
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
}
[${SEAT_ATTR}]::before {
  content: '';
  position: absolute;
  top: 0;
  right: 100%;
  width: 40px;
  height: 100%;
  background: linear-gradient(to right, transparent, var(--dsw-alias-bg-layer-1));
  pointer-events: none;
}
[data-testid^="openlux-market-card-"]:hover [${SEAT_ATTR}],
[data-testid^="openlux-market-card-"]:focus-within [${SEAT_ATTR}],
[${SEAT_ATTR}="always"] {
  opacity: 1;
  pointer-events: auto;
}
[${SPIN_ATTR}] {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  box-sizing: border-box;
  display: inline-block;
  border: 2px solid var(--dsw-alias-label-tertiary);
  border-top-color: transparent;
  border-radius: 50%;
  animation: openlux-market-spin 0.6s linear infinite;
}
@keyframes openlux-market-spin {
  to { transform: rotate(360deg); }
}
[${DOT_ATTR}] {
  /* Inline inside the name span, WorkBuddy's 「金山文档 ●」 seat. */
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-left: 6px;
  border-radius: 50%;
  vertical-align: 1px;
}
[${DOT_ATTR}="connected"] {
  background: var(--dsw-alias-state-success-primary);
}
[${DOT_ATTR}="connecting"] {
  /* The theme ships no warning-state token; this is WorkBuddy's amber. */
  background: #e6a23c;
  animation: openlux-market-breathe 1.2s ease-in-out infinite;
}
[${DOT_ATTR}="offline"] {
  background: var(--dsw-alias-state-error-primary);
}
@keyframes openlux-market-breathe {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.75); }
}
`

/**
 * Mount the stylesheet.
 * @returns the disposer; wrap the call in `ctx.effect`.
 */
export function installMarketCardStyle(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector(`style[data-plugin-css="${TAG_ID}"]`) !== null) return () => {}
  const tag = document.createElement('style')
  tag.setAttribute('data-plugin-css', TAG_ID)
  tag.textContent = CSS
  document.head.append(tag)
  return () => { tag.remove() }
}
