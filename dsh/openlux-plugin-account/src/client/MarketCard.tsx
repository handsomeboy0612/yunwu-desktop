/**
 * One catalog card.
 *
 * Shape follows the kernel's own Agent-presets section — a card grid in the
 * settings content column, description clamped so one long entry cannot decide
 * the height of the whole list. Content follows WorkBuddy's expert center, which
 * is what these entries were authored for: avatar, name, profession line, and a
 * single action.
 *
 * ## Why the action is a corner «+»
 *
 * WorkBuddy's own card puts it there and nowhere else (`.skill-add-btn`: 26px
 * square, 6px radius, quiet fill, a 14px stroke glyph, `align-self: flex-start`
 * beside the title). An installed row keeps the same seat as a check that turns
 * into a «use» glyph under the pointer, with «试一试» on the tooltip
 * (`skill-card-installed-check--actionable`, `skills.tryNow`) — so the row that
 * is done still has something to press, without a second control competing with
 * the first. Tags are not on the card there either; they live in the sheet the
 * card opens, which is where a reader who wants the licence goes.
 *
 * Avatars are monograms unless the catalog carries an absolute image URL. The
 * upstream listing stores host-relative paths (`/avatars/Foo.png`) that mean
 * nothing here, and a broken image is worse than a letter.
 */

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  Button, IconCheckOutline14, IconEllipsisOutline16,
  IconCloseFill14, IconPlayOutline16, IconPlusOutline16, Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CatalogItem } from '../market/wire.ts'
import { DOT_ATTR, SEAT_ATTR, SPIN_ATTR } from './market-card-style.ts'
import { marketItemName, marketItemTags } from './market-item-locale.ts'
import type { MarketKey } from './market-locales.ts'

/** How the card presents this row's install state. */
export type CardState =
  /** Not installed, and installable. */
  | { readonly kind: 'ready' }
  /** Being installed right now. */
  | { readonly kind: 'installing' }
  /** Already in the roster. `closed` is a skill that is installed but switched off. */
  | { readonly kind: 'installed'; readonly broken?: string; readonly closed?: boolean }
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
  /**
   * Undo the install, when this partition has an undo.
   *
   * Presets do not: the kernel's own Agent-presets page owns their lifecycle,
   * and a second remover would be a second answer to "what is installed". A
   * skill has no such page — it is a directory the kernel watches — so the only
   * place that can offer removal is the surface that put it there.
   */
  readonly onRemove?: () => void
  readonly removeLabel?: string
  /**
   * Put an unhealthy row back together, when its reason has a fix.
   *
   * Only a dead web sign-in has one today. It is offered instead of the
   * primary action rather than beside it, because an installed row's primary
   * action is already spent — the row is installed — and the one thing left to
   * do with it is the repair.
   */
  readonly onRepair?: () => void
  readonly repairLabel?: string
  /**
   * Use the row that is already installed, when there is a way to.
   *
   * The «试一试» half of WorkBuddy's check button: an installed skill opens a
   * session that names it, an installed expert is summoned into one. A
   * connector has no such act — its tools are simply there — so it passes
   * nothing and the check stays a statement.
   */
  readonly onTry?: () => void
  readonly tryLabel?: string
  /**
   * The glyph the try seat shows under the pointer, when it is not a play.
   *
   * WorkBuddy's connected connector card swaps its tick for a chat bubble whose
   * tooltip reads 「去对话」 — the act is opening a conversation, not running the
   * row — so the connector tab passes the new-chat glyph here.
   */
  readonly tryGlyph?: ReactNode
  /**
   * A live status dot beside the name, for the partitions that have one.
   *
   * WorkBuddy's connector card breathes yellow while connecting, holds green
   * once connected, and goes red for a row that did not come up. The card only
   * draws what it is told; deciding the state stays with the section.
   */
  readonly dot?: 'connected' | 'connecting' | 'offline'
  /**
   * Withdraw the flow a busy row is waiting on, when it can be withdrawn.
   *
   * Only the browser sign-in wait passes this (a config write cannot be
   * un-asked mid-flight). The seat stays the spinner; the pointer turns it
   * into a ✕ — WorkBuddy's cancellable connecting state, same seat, same swap.
   */
  readonly onCancel?: () => void
  readonly cancelLabel?: string
  /**
   * Installed-skill overflow, WorkBuddy's ⋯ on a done row.
   *
   * The three acts live here rather than as a footer 「移除」: 启用/关闭, 编辑,
   * 卸载. Passing this also suppresses the footer undo, because the same act
   * would then appear twice.
   */
  readonly menu?: {
    readonly items: readonly MenuEntry[]
    readonly onSelect: (id: string) => void
  }
  /**
   * What the four states are called, when this partition does not call them
   * install / installing / installed / broken.
   *
   * A connector is connected, not installed, and its unhealthy state is "did not
   * connect on this launch" rather than "the kernel cannot load it". Passing the
   * words in keeps one card shape for all three partitions without the card
   * having to know which one it is drawing.
   */
  readonly words?: {
    readonly primary: string
    readonly busy: string
    readonly done: string
    readonly unhealthy: string
  }
  /**
   * Whether this row's action is a word or a glyph.
   *
   * An expert is summoned, not installed, and WorkBuddy's expert card says so in
   * words: `ec-card-summon-btn` is a solid 24px pill reading «召唤»
   * (`summonShort`), and there is no plus anywhere on that card — the plus
   * belongs to the skill shelf (`.skill-add-btn`), where «add to my machine» is
   * the whole act. Carrying the skill glyph onto the expert tab, which is what
   * unifying the three tabs did, renamed the act on screen.
   *
   * Where it sits follows theirs too: floated over the card's top-right corner
   * and revealed on hover (`market-card-style.ts` carries the two rules a style
   * object cannot say). An earlier revision of this comment argued the opposite
   * — that a hover reveal would leave a hole or make the title jump — which is
   * what happens when the seat keeps a column in the flex row. Theirs takes no
   * column at all: the title owns the full width and fades under the seat
   * through a gradient, so there is nothing to jump and no hole to leave. The
   * glyph seat stays where it is, in the row: its own reference
   * (`.skill-add-btn`) is on screen at all times, because adding a skill to
   * this machine is what that shelf is for.
   */
  readonly primaryLook?: 'glyph' | 'text'
  /** Load the first visible row immediately; defer the rest until it nears the scroller. */
  readonly priorityAvatarLoad?: boolean
}

const styles = {
  card: {
    // `relative` is what the floated word seat is positioned against.
    position: 'relative',
    display: 'flex', flexDirection: 'column', gap: '8px',
    padding: '12px', borderRadius: '10px', textAlign: 'left',
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-1)', cursor: 'pointer',
  },
  head: { display: 'flex', alignItems: 'flex-start', gap: '8px' },
  avatar: {
    position: 'relative',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '32px', height: '32px', flex: '0 0 32px',
    borderRadius: '50%', color: '#fff', fontSize: '14px', fontWeight: 600,
    overflow: 'hidden',
  },
  avatarImage: {
    position: 'absolute', inset: 0, width: '32px', height: '32px',
    display: 'block', objectFit: 'cover',
  },
  name: {
    flex: 1, minWidth: 0, paddingTop: '6px', color: 'var(--dsw-alias-label-primary)',
    fontSize: '13px', fontWeight: 600,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  teamBadge: {
    flex: '0 0 auto', marginTop: '6px', padding: '1px 5px', borderRadius: '4px', fontSize: '11px',
    background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-secondary)',
  },
  description: {
    // Three lines: the same clamp WorkBuddy's card uses, one more than its two
    // because our catalog descriptions are longer and a two-line cut lands
    // mid-sentence on most of the shelf.
    display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3,
    overflow: 'hidden',
    color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: 1.5,
  },
  // Copied off `.skill-add-btn`, including the 2px nudge that lines the glyph
  // up with the first line of the title rather than with the avatar's middle.
  corner: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '26px', height: '26px', flex: '0 0 26px',
    marginTop: '2px', padding: 0, border: 'none', borderRadius: '6px',
    background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-primary)', cursor: 'pointer',
  },
  cornerQuiet: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '26px', height: '26px', flex: '0 0 26px',
    marginTop: '2px', padding: 0, border: 'none', borderRadius: '6px',
    background: 'transparent', color: 'var(--dsw-alias-label-tertiary)',
    cursor: 'default',
  },
  cornerQuietPress: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '26px', height: '26px', flex: '0 0 26px',
    marginTop: '2px', padding: 0, border: 'none', borderRadius: '6px',
    background: 'transparent', color: 'var(--dsw-alias-label-tertiary)',
    cursor: 'pointer',
  },
  actions: {
    display: 'flex', alignItems: 'center', gap: '2px', flex: '0 0 auto',
  },
  // Only a wrapper: a disabled button gets `pointer-events: none`, so the
  // tooltip carrying the reason has to sit on something that still gets them.
  cornerReason: { display: 'flex', flex: '0 0 auto', marginTop: '2px' },
  // The word seat's own box, floated where `.ec-card-summon-btn--top` floats.
  // Its visibility lives in the sheet, so a card whose stylesheet never landed
  // shows the seat rather than hiding it forever.
  seat: { position: 'absolute', top: '12px', right: '12px', zIndex: 2 },
  // One row, at most three tags, the way WorkBuddy's card carries them
  // (`.ec-card-tags` / `.ec-card-tag`). It keeps only the tags that fit by
  // measuring each one against the row (hidden twin row + ResizeObserver, per
  // card); this shelf draws four hundred cards at once, so the row wraps instead
  // and is only one row tall — whatever does not fit lands on a second line that
  // the height clips away whole. Same outcome, no measuring: a tag is either
  // fully there or not there at all, never a pill cut down the middle.
  //
  // `text-overflow` was the first attempt and does nothing here: the pill is an
  // inline-flex box, and ellipsis does not apply to a flex container's own text
  // — the real app showed 「知识管」 for 「知识管理」.
  tags: {
    display: 'flex', flexWrap: 'wrap', gap: '4px', minWidth: 0,
    height: '20px', overflow: 'hidden',
  },
  tag: {
    display: 'inline-flex', alignItems: 'center', flexShrink: 0,
    height: '20px', padding: '0 8px', boxSizing: 'border-box',
    borderRadius: '4px', border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)',
    fontSize: '11px', lineHeight: '18px', whiteSpace: 'nowrap',
  },
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
 * WorkBuddy does not mount every expert image at once. Its first four cards are
 * eager and the rest get an image only within 240px of the viewport.
 */
function useDeferredImageLoad(priority: boolean): {
  readonly imageContainerRef: (node: HTMLSpanElement | null) => void
  readonly shouldLoadImage: boolean
} {
  const [target, setTarget] = useState<HTMLSpanElement | null>(null)
  const [shouldLoadImage, setShouldLoadImage] = useState(priority)
  useEffect(() => {
    if (priority) setShouldLoadImage(true)
  }, [priority])
  useEffect(() => {
    if (shouldLoadImage || target === null) return
    if (typeof IntersectionObserver === 'undefined') {
      setShouldLoadImage(true)
      return
    }
    const observer = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting !== true) return
      setShouldLoadImage(true)
      observer.disconnect()
    }, { rootMargin: '240px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [shouldLoadImage, target])
  return {
    imageContainerRef: useCallback((node: HTMLSpanElement | null) => setTarget(node), []),
    shouldLoadImage,
  }
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
  {
    item, state, language, t, onOpen, onPrimary, summonable,
    onRemove, removeLabel, onRepair, repairLabel, onTry, tryLabel, tryGlyph, menu, words,
    dot, onCancel, cancelLabel, primaryLook = 'glyph', priorityAvatarLoad = false,
  }: MarketCardProps,
): ReactNode {
  const [imageFailed, setImageFailed] = useState(false)
  const [hovering, setHovering] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const displayName = marketItemName(item, language)
  const displayTags = marketItemTags(item, language)
  const remote = item.icon.startsWith('http://') || item.icon.startsWith('https://')
  const { imageContainerRef, shouldLoadImage } = useDeferredImageLoad(priorityAvatarLoad)
  // One label for both halves of the flow: with a conversation to land in, an
  // uninstalled row installs on the way to the session, so saying "install"
  // would name the step instead of the outcome.
  const label = words?.primary ?? (summonable ? t('summon') : t('install'))
  const closed = state.kind === 'installed' && state.closed === true
  const healthy = state.kind === 'installed' && state.broken === undefined
  const busy = state.kind === 'installing'
  // A healthy row says 「已装」once, in the corner. Repeating it on the footer line
  // next to the tick is the kind of duplication that makes a dense grid look noisy,
  // so the footer only earns its line when it carries something else: an install
  // count, an undo that is not already in the ⋯ menu, or a failure to repair.
  const footer = item.downloads > 0
    || (state.kind === 'installed' && (
      state.broken !== undefined
      || (onRemove !== undefined && menu === undefined)
    ))

  /** The corner seat: one control, whichever state the row is in. */
  const corner = ((): ReactNode => {
    if (primaryLook === 'text') {
      // A row that is done and has nothing left to do still shows the quiet
      // check: the word would be a button that does nothing. It is a statement,
      // so it does not wait for the pointer.
      if (healthy && onTry === undefined) {
        return (
          <span style={styles.seat} {...{ [SEAT_ATTR]: 'always' }}>
            <Tooltip label={words?.done ?? t('installed')} side="top">
              <span style={styles.cornerQuiet} aria-label={words?.done ?? t('installed')}>
                <IconCheckOutline14 />
              </span>
            </Tooltip>
          </span>
        )
      }
      const blockedText = state.kind === 'blocked' ? state.reason : undefined
      const word = busy
        ? (words?.busy ?? t('preparing'))
        : healthy ? (tryLabel ?? t('tryNow')) : label
      const press = healthy && onTry !== undefined ? onTry : onPrimary
      const button = (
        <Button
          variant="primary"
          size="sm"
          disabled={busy || blockedText !== undefined}
          data-testid={healthy ? `openlux-market-try-${item.slug}` : `openlux-market-action-${item.slug}`}
          onClick={event => {
            // The whole card opens the detail sheet; this is the one place
            // inside it that means something else.
            event.stopPropagation()
            press()
          }}
        >
          {word}
        </Button>
      )
      // A disabled button swallows pointer events, so its tooltip would never
      // open — the reason has to hang on something that still receives them.
      return (
        <span style={styles.seat} {...{ [SEAT_ATTR]: busy ? 'always' : 'hover' }}>
          {blockedText === undefined
            ? button
            : (
              <Tooltip label={blockedText} side="top">
                <span style={styles.cornerReason}>{button}</span>
              </Tooltip>
            )}
        </span>
      )
    }
    if (busy) {
      // A wait that can be withdrawn keeps the spinner as its resting face and
      // turns into a ✕ under the pointer — WorkBuddy's cancellable connecting
      // seat. The plain wait stays a statement.
      if (onCancel !== undefined) {
        return (
          <Tooltip label={cancelLabel ?? t('connectorCancelAuth')} side="top">
            <button
              type="button"
              style={styles.cornerQuietPress}
              aria-label={cancelLabel ?? t('connectorCancelAuth')}
              data-testid={`openlux-market-cancel-${item.slug}`}
              onPointerEnter={() => setHovering(true)}
              onPointerLeave={() => setHovering(false)}
              onClick={(event) => {
                event.stopPropagation()
                onCancel()
              }}
            >
              {hovering ? <IconCloseFill14 /> : <span {...{ [SPIN_ATTR]: '' }} />}
            </button>
          </Tooltip>
        )
      }
      // WorkBuddy swaps the plus for `.skill-install-loading` (a 14px ring that
      // actually rotates). The kernel loading glyph is a still picture.
      return (
        <Tooltip label={words?.busy ?? t('preparing')} side="top">
          <span style={styles.cornerQuiet} aria-label={words?.busy ?? t('preparing')}>
            <span {...{ [SPIN_ATTR]: '' }} />
          </span>
        </Tooltip>
      )
    }
    if (healthy) {
      // WorkBuddy's installed market card: ⋯ then ✓. Hover on the tick swaps
      // it for a play glyph and the tooltip 「试一试」; the menu holds 启用/关闭,
      // 编辑, 卸载. A closed skill keeps the tick as a statement — trying a
      // skill the model cannot see would send the user into a dead end.
      const check = onTry === undefined || closed
        ? (
          <Tooltip label={words?.done ?? t('installed')} side="top">
            <span
              style={styles.cornerQuiet}
              aria-label={words?.done ?? t('installed')}
              data-testid={`openlux-market-installed-${item.slug}`}
            >
              <IconCheckOutline14 />
            </span>
          </Tooltip>
        )
        : (
          <Tooltip label={tryLabel ?? t('tryNow')} side="top">
            <button
              type="button"
              style={styles.cornerQuietPress}
              aria-label={tryLabel ?? t('tryNow')}
              data-testid={`openlux-market-try-${item.slug}`}
              onPointerEnter={() => setHovering(true)}
              onPointerLeave={() => setHovering(false)}
              onClick={event => {
                event.stopPropagation()
                onTry()
              }}
            >
              {hovering ? (tryGlyph ?? <IconPlayOutline16 />) : <IconCheckOutline14 />}
            </button>
          </Tooltip>
        )
      if (menu === undefined) return check
      return (
        <span
          style={styles.actions}
          onClick={event => event.stopPropagation()}
        >
          <Menu
            open={menuOpen}
            align="end"
            portal
            items={menu.items}
            onClose={() => setMenuOpen(false)}
            onSelect={id => {
              setMenuOpen(false)
              menu.onSelect(id)
            }}
            anchor={(
              <button
                type="button"
                style={styles.cornerQuietPress}
                aria-label={t('skillMore')}
                aria-expanded={menuOpen}
                data-testid={`openlux-market-skill-menu-${item.slug}`}
                onClick={event => {
                  event.stopPropagation()
                  setMenuOpen(open => !open)
                }}
              >
                <IconEllipsisOutline16 />
              </button>
            )}
          />
          {check}
        </span>
      )
    }
    const blocked = state.kind === 'blocked' ? state.reason : undefined
    return (
      <Tooltip label={blocked ?? label} side="top">
        <button
          type="button"
          style={blocked === undefined ? styles.corner : styles.cornerQuiet}
          disabled={blocked !== undefined}
          aria-label={label}
          data-testid={`openlux-market-action-${item.slug}`}
          onClick={event => {
            // The whole card opens the detail sheet; this is the one place
            // inside it that means something else.
            event.stopPropagation()
            onPrimary()
          }}
        >
          <IconPlusOutline16 />
        </button>
      </Tooltip>
    )
  })()

  return (
    <div
      style={{ ...styles.card, ...(closed ? { opacity: 0.55 } : {}) }}
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
      {primaryLook === 'text' && corner}

      <div style={styles.head}>
        <span
          ref={imageContainerRef}
          style={{ ...styles.avatar, background: hue(item.slug) }}
          aria-hidden="true"
        >
          {[...displayName][0] ?? '?'}
          {remote && !imageFailed && shouldLoadImage && (
            <img
              src={item.icon}
              alt=""
              width={32}
              height={32}
              loading={priorityAvatarLoad ? 'eager' : 'lazy'}
              decoding="async"
              onError={() => setImageFailed(true)}
              style={styles.avatarImage}
            />
          )}
        </span>
        <span style={styles.name} title={displayName}>
          {displayName}
          {dot !== undefined && (
            <span
              {...{ [DOT_ATTR]: dot }}
              aria-hidden="true"
              data-testid={`openlux-market-dot-${item.slug}`}
            />
          )}
        </span>
        {item.team && <span style={styles.teamBadge}>{t('teamBadge')}</span>}
        {primaryLook === 'glyph' && corner}
      </div>

      <span style={styles.description}>{describe(item, language)}</span>

      {displayTags.length > 0 && (
        <span style={styles.tags}>
          {displayTags.slice(0, 3).map(tag => <span key={tag} style={styles.tag}>{tag}</span>)}
        </span>
      )}

      {footer && (
        <div style={styles.foot}>
          <span style={styles.downloads}>
            {item.downloads > 0 ? t('downloads', { count: item.downloads }) : ''}
          </span>

          {state.kind === 'installed' && state.broken !== undefined && (
            <Tooltip label={state.broken} side="top">
              <span style={styles.broken}>{words?.unhealthy ?? t('brokenInstalled')}</span>
            </Tooltip>
          )}

          {/*
            An unhealthy row keeps its undo. That is the case where undo matters
            most: a connector whose command is gone did not connect this launch,
            and the only way out of the list must not be editing a file.
          */}
          {state.kind === 'installed' && menu === undefined
            && onRemove !== undefined && removeLabel !== undefined && (
            <Button
              variant="ghost"
              size="sm"
              data-testid={`openlux-market-remove-${item.slug}`}
              onClick={event => {
                event.stopPropagation()
                onRemove()
              }}
            >
              {removeLabel}
            </Button>
          )}

          {state.kind === 'installed' && state.broken !== undefined
            && onRepair !== undefined && repairLabel !== undefined && (
            <Button
              variant="primary"
              size="sm"
              data-testid={`openlux-market-repair-${item.slug}`}
              onClick={event => {
                event.stopPropagation()
                onRepair()
              }}
            >
              {repairLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
