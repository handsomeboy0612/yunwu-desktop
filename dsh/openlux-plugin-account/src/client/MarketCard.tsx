/**
 * One catalog card.
 *
 * Shape follows the kernel's own Agent-presets section — a card grid in the
 * settings content column, description clamped so one long entry cannot decide
 * the height of the whole list. Content follows WorkBuddy's expert center, which
 * is what these entries were authored for: avatar, name, profession line, tags,
 * and a single primary action.
 *
 * Avatars are monograms unless the catalog carries an absolute image URL. The
 * upstream listing stores host-relative paths (`/avatars/Foo.png`) that mean
 * nothing here, and a broken image is worse than a letter.
 */

import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Button, Pill, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CatalogItem } from '../market/wire.ts'
import type { MarketKey } from './market-locales.ts'

/** How the card presents this row's install state. */
export type CardState =
  /** Not installed, and installable. */
  | { readonly kind: 'ready' }
  /** Being installed right now. */
  | { readonly kind: 'installing' }
  /** Already in the roster. */
  | { readonly kind: 'installed'; readonly broken?: string }
  /** Cannot be installed; the reason is already localized. */
  | { readonly kind: 'blocked'; readonly reason: string }

/** What one card needs. */
export interface MarketCardProps {
  readonly item: CatalogItem
  readonly state: CardState
  readonly language: 'zh' | 'en'
  readonly t: (key: MarketKey, params?: Record<string, unknown>) => string
  readonly onOpen: () => void
  /**
   * The primary action: summon when this window has a conversation to summon
   * into, install otherwise (see {@link MarketCardProps.summonable}).
   */
  readonly onPrimary: () => void
  /**
   * Whether the primary action ends in a session rather than in the roster.
   *
   * It drives both the copy and whether an already-installed row keeps a
   * button at all: with a conversation, "installed" is a fact about this
   * machine and the useful action is still to summon; without one — the
   * kernel's basic desktop composition has no conversation flow — installing is
   * the whole of what this surface can do, and a done row is done.
   */
  readonly summonable: boolean
}

const styles = {
  card: {
    display: 'flex', flexDirection: 'column', gap: '8px',
    padding: '12px', borderRadius: '10px', textAlign: 'left',
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-1)', cursor: 'pointer',
  },
  head: { display: 'flex', alignItems: 'center', gap: '8px' },
  avatar: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '32px', height: '32px', flex: '0 0 32px',
    borderRadius: '50%', color: '#fff', fontSize: '14px', fontWeight: 600,
    overflow: 'hidden',
  },
  name: {
    flex: 1, minWidth: 0, color: 'var(--dsw-alias-label-primary)',
    fontSize: '13px', fontWeight: 600,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  teamBadge: {
    flex: '0 0 auto', padding: '1px 5px', borderRadius: '4px', fontSize: '11px',
    background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-secondary)',
  },
  description: {
    // Four lines is the kernel's own clamp on this grid; the catalog publishes
    // descriptions of any length.
    display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 4,
    overflow: 'hidden',
    color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: 1.5,
  },
  tags: { display: 'flex', flexWrap: 'wrap', gap: '4px' },
  foot: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginTop: 'auto' },
  downloads: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' },
  installed: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' },
  broken: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
} satisfies Record<string, CSSProperties>

/**
 * Pick a stable colour for one monogram.
 * @param seed - the row's slug.
 * @returns an hsl colour.
 */
function hue(seed: string): string {
  let sum = 0
  for (let index = 0; index < seed.length; index += 1) sum = (sum * 31 + seed.charCodeAt(index)) % 360
  return `hsl(${sum}deg 45% 45%)`
}

/**
 * Read the description in the active language, falling back to the other.
 * @param item - the catalog row.
 * @param language - active locale.
 * @returns the description, possibly empty.
 */
export function describe(item: CatalogItem, language: 'zh' | 'en'): string {
  const first = language === 'en' ? item.descriptionEn : item.descriptionZh
  return first === '' ? (language === 'en' ? item.descriptionZh : item.descriptionEn) : first
}

/**
 * Render one card.
 * @param props - the row, its state, and the two callbacks.
 * @returns the card.
 */
export function MarketCard(
  { item, state, language, t, onOpen, onPrimary, summonable }: MarketCardProps,
): ReactNode {
  const [imageFailed, setImageFailed] = useState(false)
  const remote = item.icon.startsWith('http://') || item.icon.startsWith('https://')
  // One label for both halves of the flow: with a conversation to land in, an
  // uninstalled row installs on the way to the session, so saying "install"
  // would name the step instead of the outcome.
  const label = summonable ? t('summon') : t('install')
  const healthy = state.kind === 'installed' && state.broken === undefined
  const busy = state.kind === 'installing'

  return (
    <div
      style={styles.card}
      role="button"
      tabIndex={0}
      data-testid={`openlux-market-card-${item.slug}`}
      onClick={onOpen}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
    >
      <div style={styles.head}>
        <span style={{ ...styles.avatar, background: hue(item.slug) }} aria-hidden="true">
          {remote && !imageFailed
            ? (
              <img
                src={item.icon}
                alt=""
                width={32}
                height={32}
                onError={() => setImageFailed(true)}
                style={{ width: '32px', height: '32px', objectFit: 'cover' }}
              />
            )
            : [...item.name][0] ?? '?'}
        </span>
        <span style={styles.name} title={item.name}>{item.name}</span>
        {item.team && <span style={styles.teamBadge}>{t('teamBadge')}</span>}
      </div>

      <span style={styles.description}>{describe(item, language)}</span>

      {item.tags.length > 0 && (
        <span style={styles.tags}>
          {item.tags.slice(0, 3).map(tag => <Pill key={tag}>{tag}</Pill>)}
        </span>
      )}

      <div style={styles.foot}>
        <span style={styles.downloads}>
          {healthy
            ? t('installed')
            : (item.downloads > 0 ? t('downloads', { count: item.downloads }) : '')}
        </span>

        {state.kind === 'installed' && state.broken !== undefined && (
          <Tooltip label={state.broken} side="top">
            <span style={styles.broken}>{t('brokenInstalled')}</span>
          </Tooltip>
        )}

        {state.kind === 'blocked' && (
          <Tooltip label={state.reason} side="top">
            <span style={styles.installed}>{label}</span>
          </Tooltip>
        )}

        {(state.kind === 'ready' || busy || (healthy && summonable)) && (
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            data-testid={`openlux-market-action-${item.slug}`}
            onClick={event => {
              // The whole card opens the detail sheet; the button is the one
              // place inside it that means something else.
              event.stopPropagation()
              onPrimary()
            }}
          >
            {busy ? t('preparing') : label}
          </Button>
        )}
      </div>
    </div>
  )
}
