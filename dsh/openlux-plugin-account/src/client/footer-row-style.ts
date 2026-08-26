/**
 * Let the sidebar's foot hold any number of action entries vertically.
 *
 * ## What goes wrong without this
 *
 * `sidebar.footer.action` is a list slot rendered into a single flex row
 * (`SidebarRoot`: `display:flex; flex-direction:row; flex-wrap:nowrap`, 240px
 * wide). Upstream ships exactly one occupant — `ui-cordis`'s plugin dock, which
 * appears only while the current session has a cordis plugin registered — so
 * the row is never contested there. Ours is the second, and the two do not fit:
 * measured in the running app, adding one full-width sibling takes the market
 * trigger from 248px to 50px, which is the sliver of a clipped label the user
 * sees while an authoring session runs its temporary plugins.
 *
 * ## Why one rule on the parent
 *
 * A child cannot turn its nowrap parent into a column, so the rule has to land on the
 * container — but the container's class is a hashed CSS-module name and not
 * ours to depend on. `:has(> …)` selects it through our own marker instead: the
 * only element it can match is whatever holds this launcher, so the rule cannot
 * reach a row we do not occupy. A column is also what the geometry implies,
 * since each product trigger asks for `calc(100% + 8px)` and needs its own
 * line. It is stronger than wrapping here: the
 * temporary Cordis/expert dock can add more than one entry, and every one must
 * remain an independent row instead of sharing whatever width happens to fit.
 *
 * Two depths, because the tooltip wraps the button in a `display: contents`
 * div: today the flex row is the grandparent (that wrapper contributes no box,
 * so changing its direction does nothing), and if the wrapper ever goes away the first
 * selector is already the right one. Anything looser — `:has(…)` without a
 * child combinator — would also match the foot and the sidebar root, and
 * reshape layouts that are none of our business.
 *
 * Injection follows the same convention as `file-chip-style.ts`: one `<style>`
 * tagged `data-plugin-css`, skipped when already present.
 *
 * @module openlux-plugin-account/client/footer-row-style
 */

import { AUTOMATION_LAUNCHER_ID } from './AutomationLauncher.tsx'
import { MARKET_LAUNCHER_ID } from './MarketLauncher.tsx'

/** Marker on the injected tag; also the double-injection guard. */
const TAG_ID = 'openlux-plugin-account/footer-row'

/** The rule set. */
const CSS = `
:has(> [data-testid="${AUTOMATION_LAUNCHER_ID}"]),
:has(> * > [data-testid="${AUTOMATION_LAUNCHER_ID}"]),
:has(> [data-testid="${MARKET_LAUNCHER_ID}"]),
:has(> * > [data-testid="${MARKET_LAUNCHER_ID}"]) {
  flex-direction: column;
  flex-wrap: nowrap;
  align-items: stretch;
}
`

/**
 * Mount the stylesheet.
 * @returns the disposer; wrap the call in `ctx.effect`.
 */
export function installFooterRowStyle(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector(`style[data-plugin-css="${TAG_ID}"]`) !== null) return () => {}
  const tag = document.createElement('style')
  tag.setAttribute('data-plugin-css', TAG_ID)
  tag.textContent = CSS
  document.head.append(tag)
  return () => { tag.remove() }
}
