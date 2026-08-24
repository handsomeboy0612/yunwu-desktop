/**
 * This product's brand art, sitting in the seats the shell declares for it.
 *
 * Upstream ships its own occupant for all three (`dsh-client-ui-brand-official`
 * registers `sidebar.brand.mark`, `sidebar.brand.name`, and
 * `conversation.hero.brand.mark` at the default priority), and both host
 * contracts invite the replacement in so many words — "deployments may replace
 * the shell's fish fallback without replacing the surrounding controls". So a
 * rebrand is two components and a lower priority, with the fold state machine,
 * the New Session button, and the hero headline left where they are.
 *
 * This replaces a stylesheet that hid the upstream art and redrew it from
 * `::before`/`::after`, hooked onto the art's declared aspect boxes. That hook
 * broke the moment upstream split mark from name: `BrandWordmark` gained an
 * `includeMark` flag, the name-only variant crops to `viewBox="26 0 156 24"`,
 * and a selector naming `0 0 182 24` silently matched nothing — putting the
 * DeepSeek lettering back in the sidebar. Occupying the seat cannot miss that
 * way: if the seat moves, the registration fails loudly instead.
 *
 * @module dsh-plugin-desktop/client/Brand
 */

import type { ReactNode } from 'react'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { BRAND_MARK_ROUTE, WORDMARK_BADGE, WORDMARK_TEXT } from '../brand.ts'

/**
 * Below the shipped pack's default, which is what claims an occupied seat.
 * Registering at the same priority is a loud failure rather than a silent
 * override, so this number is load-bearing.
 */
export const BRAND_PRIORITY = -1

/** Both mark seats, so one component can take either. */
type BrandMarkProps = SidebarBrandMarkOwnerProps & HeroBrandMarkOwnerProps

/**
 * Metrics read off the art this replaces: the name-only variant declares a
 * 156×24 box, so the row is 24px tall and the tag sits inside that height.
 */
const ROW_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  minWidth: 0,
} as const

const NAME_STYLE = {
  fontSize: '18px',
  fontWeight: 600,
  lineHeight: '24px',
  letterSpacing: '0.01em',
  whiteSpace: 'nowrap',
  color: 'var(--dsw-alias-label-primary, currentColor)',
} as const

/**
 * The edition tag. Upstream draws it as one filled path with the letters
 * knocked out, so the pair of tokens here is the same relationship: the ink
 * fills the tag, the surface colour writes on it, and both follow the theme.
 */
const BADGE_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  height: '16px',
  padding: '0 5px',
  borderRadius: '4px',
  fontSize: '10px',
  fontWeight: 700,
  lineHeight: '16px',
  letterSpacing: '0.06em',
  whiteSpace: 'nowrap',
  background: 'var(--dsw-alias-label-primary, currentColor)',
  color: 'var(--dsw-alias-label-primary-inverted, #fff)',
} as const

/**
 * Draw the product mark at the size its surface asks for.
 * @param props - host-supplied presentation: square edge, optional host class.
 * @returns the mark image.
 */
export function BrandMark({ size, className }: BrandMarkProps): ReactNode {
  // The Host serves this route from `build/`, so the renderer names a path
  // rather than carrying bytes; `web-brand.ts` is the other half.
  return (
    <img
      src={BRAND_MARK_ROUTE}
      width={size}
      height={size}
      alt=""
      draggable={false}
      {...className === undefined ? {} : { className }}
    />
  )
}

/**
 * Spell the product name and its edition tag beside the mark.
 * @returns the wordmark row.
 */
export function BrandName(): ReactNode {
  return (
    <span style={ROW_STYLE}>
      <span style={NAME_STYLE}>{WORDMARK_TEXT}</span>
      <span style={BADGE_STYLE}>{WORDMARK_BADGE}</span>
    </span>
  )
}
