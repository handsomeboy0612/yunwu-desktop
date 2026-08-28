import {
  useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type ReactNode,
} from 'react'
import type { CatalogItem, HomeShowcase } from '../market/wire.ts'
import { useHorizontalDrag, useHorizontalWheel } from './horizontal-scroll.ts'
import { marketItemName } from './market-item-locale.ts'

interface FeaturedScenesProps {
  readonly scenes: readonly HomeShowcase[]
  readonly experts: readonly CatalogItem[]
  readonly language: 'zh' | 'en'
  readonly loading: boolean
  readonly resolvingExperts: boolean
  readonly title: string
  readonly previousLabel: string
  readonly nextLabel: string
  readonly onExpertOpen: (expert: CatalogItem) => void
}

interface SceneMember {
  readonly reference: HomeShowcase['experts'][number]
  readonly expert?: CatalogItem
}

interface VisibleScene {
  readonly scene: HomeShowcase
  readonly members: readonly SceneMember[]
}

const styles = {
  section: {
    position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px',
    width: '100%', minWidth: 0, maxWidth: '100%', overflow: 'hidden', paddingBottom: '4px',
  },
  title: {
    color: 'var(--dsw-alias-label-primary)', fontSize: '16px', fontWeight: 600,
    lineHeight: '24px',
  },
  strip: {
    display: 'flex', gap: '12px', width: '100%', minWidth: 0, maxWidth: '100%',
    overflowX: 'auto', overflowY: 'hidden',
    padding: '0 2px 4px', scrollbarWidth: 'none', cursor: 'grab', userSelect: 'none',
    touchAction: 'pan-y',
  },
  card: {
    position: 'relative', flex: '0 0 246px', width: '246px', height: '224px',
    overflow: 'hidden', borderRadius: '16px',
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-1)', boxShadow: 'var(--dsw-shadow-lv1)',
  },
  background: {
    position: 'absolute', inset: 0, width: '100%', height: '100%',
    objectFit: 'cover', display: 'block', pointerEvents: 'none',
  },
  overlay: {
    position: 'absolute', inset: 0, pointerEvents: 'none',
    background: 'linear-gradient(180deg, transparent 18%, var(--dsw-alias-bg-layer-1) 89%)',
  },
  sceneName: {
    position: 'absolute', zIndex: 1, top: '44px', left: '20px', right: '20px',
    color: 'var(--dsw-alias-label-primary)', fontSize: '17px', fontWeight: 600,
    lineHeight: '24px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    textShadow: '0 1px 8px var(--dsw-alias-bg-layer-1)',
  },
  members: {
    position: 'absolute', zIndex: 1, top: '88px', left: '12px', right: '12px',
    display: 'flex', flexDirection: 'column', gap: '6px',
  },
  member: {
    display: 'flex', alignItems: 'center', gap: '10px', width: '100%', height: '34px',
    minWidth: 0, padding: '0 8px', border: 0, borderRadius: '8px',
    background: 'transparent', color: 'var(--dsw-alias-label-primary)',
    cursor: 'pointer', textAlign: 'left',
  },
  loadingMember: {
    display: 'flex', alignItems: 'center', gap: '10px', width: '100%', height: '34px',
    minWidth: 0, padding: '0 8px',
  },
  avatar: {
    position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '24px', height: '24px', flex: '0 0 24px', overflow: 'hidden',
    borderRadius: '50%', color: '#fff', fontSize: '11px', fontWeight: 600,
  },
  avatarImage: {
    position: 'absolute', inset: 0, width: '100%', height: '100%',
    display: 'block', objectFit: 'cover',
  },
  memberName: {
    flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap', fontSize: '13px', fontWeight: 500, lineHeight: '20px',
  },
  skeletonAvatar: {
    width: '24px', height: '24px', flex: '0 0 24px', borderRadius: '50%',
    background: 'var(--dsw-alias-interactive-bg-hover)',
  },
  skeletonName: {
    width: '112px', height: '14px', borderRadius: '7px',
    background: 'var(--dsw-alias-interactive-bg-hover)',
  },
  skeletonCard: {
    flex: '0 0 246px', width: '246px', height: '224px', borderRadius: '16px',
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-interactive-bg-hover)',
  },
  arrow: {
    position: 'absolute', zIndex: 4, top: '148px',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '28px', height: '28px', padding: 0, border: 0, borderRadius: '50%',
    background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-1) 92%, transparent)',
    color: 'var(--dsw-alias-label-primary)', boxShadow: 'var(--dsw-shadow-lv2)',
    cursor: 'pointer', fontSize: '24px', lineHeight: 1,
  },
  previous: { left: '10px' },
  next: { right: '10px' },
  fade: {
    position: 'absolute', zIndex: 3, top: '36px', right: 0,
    width: '32px', height: '224px', pointerEvents: 'none',
    background: 'linear-gradient(90deg, transparent, var(--dsw-alias-bg-layer-2))',
  },
} satisfies Record<string, CSSProperties>

function hue(seed: string): string {
  let value = 0
  for (let index = 0; index < seed.length; index += 1) {
    value = (value * 31 + seed.charCodeAt(index)) % 360
  }
  return `hsl(${value}deg 42% 45%)`
}

function FeaturedAvatar(props: {
  readonly expert: CatalogItem
  readonly language: 'zh' | 'en'
}): ReactNode {
  const { expert, language } = props
  const [failed, setFailed] = useState(false)
  const remote = /^https?:\/\//u.test(expert.icon)
  return (
    <span style={{ ...styles.avatar, background: hue(expert.slug) }} aria-hidden="true">
      {[...marketItemName(expert, language)][0] ?? '?'}
      {remote && !failed && (
        <img
          src={expert.icon}
          alt=""
          loading="lazy"
          decoding="async"
          style={styles.avatarImage}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  )
}

/**
 * WorkBuddy-shaped scene recommendations above the expert catalog.
 *
 * A scene is not itself an install target: its rows are. Keeping only the rows
 * whose expert still exists also prevents stale editorial data from rendering a
 * cover-only card that looks broken.
 */
export function FeaturedScenes(props: FeaturedScenesProps): ReactNode {
  const {
    scenes, experts, language, loading, resolvingExperts,
    title, previousLabel, nextLabel, onExpertOpen,
  } = props
  const stripRef = useRef<HTMLDivElement>(null)
  const { dragHandlers, isDragging } = useHorizontalDrag<HTMLDivElement>()
  const [canPrevious, setCanPrevious] = useState(false)
  const [canNext, setCanNext] = useState(false)

  const visible = useMemo<readonly VisibleScene[]>(() => {
    const bySlug = new Map(experts.map(expert => [expert.slug.toLowerCase(), expert]))
    return scenes.flatMap(scene => {
      const members = scene.experts.flatMap(reference => {
        const expert = bySlug.get(reference.slug.toLowerCase())
        if (expert !== undefined) return [{ reference, expert }]
        return resolvingExperts ? [{ reference }] : []
      }).slice(0, 3)
      return members.length === 0 ? [] : [{ scene, members }]
    })
  }, [experts, resolvingExperts, scenes])
  useHorizontalWheel(stripRef, visible.length > 0)

  const updateArrows = useCallback(() => {
    const strip = stripRef.current
    if (strip === null) return
    setCanPrevious(strip.scrollLeft > 1)
    setCanNext(strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1)
  }, [])

  useEffect(() => {
    updateArrows()
    const strip = stripRef.current
    if (strip === null) return
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateArrows)
      return () => window.removeEventListener('resize', updateArrows)
    }
    const observer = new ResizeObserver(updateArrows)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [updateArrows, visible.length])

  if (loading && scenes.length === 0) {
    return (
      <section style={styles.section} aria-busy="true" data-testid="openlux-market-featured-scenes">
        <span style={styles.title}>{title}</span>
        <div style={styles.strip}>
          {[0, 1, 2].map(index => <span key={index} style={styles.skeletonCard} aria-hidden="true" />)}
        </div>
      </section>
    )
  }
  if (visible.length === 0) return null
  return (
    <section style={styles.section} data-testid="openlux-market-featured-scenes">
      <span style={styles.title}>{title}</span>
      <div
        ref={stripRef}
        style={{ ...styles.strip, cursor: isDragging ? 'grabbing' : 'grab' }}
        onScroll={updateArrows}
        {...dragHandlers}
      >
        {visible.map(({ scene, members }) => (
          <article key={scene.id} style={styles.card}>
            {scene.cover !== '' && (
              <img src={scene.cover} alt="" loading="lazy" decoding="async" style={styles.background} />
            )}
            <span style={styles.overlay} aria-hidden="true" />
            <span style={styles.sceneName} title={scene.title}>{scene.title}</span>
            <span style={styles.members}>
              {members.map(member => member.expert === undefined
                ? (
                    <span key={member.reference.slug} style={styles.loadingMember} aria-hidden="true">
                      <span style={styles.skeletonAvatar} />
                      <span style={styles.skeletonName} />
                    </span>
                  )
                : (
                    <button
                      key={member.expert.slug}
                      type="button"
                      style={styles.member}
                      title={marketItemName(member.expert, language)}
                      onPointerEnter={event => {
                        event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)'
                      }}
                      onPointerLeave={event => {
                        event.currentTarget.style.background = 'transparent'
                      }}
                      onClick={() => onExpertOpen(member.expert as CatalogItem)}
                    >
                      <FeaturedAvatar expert={member.expert} language={language} />
                      <span style={styles.memberName}>{marketItemName(member.expert, language)}</span>
                    </button>
                  ))}
            </span>
          </article>
        ))}
      </div>
      {canNext && <span style={styles.fade} aria-hidden="true" />}
      {canPrevious && (
        <button
          type="button"
          style={{ ...styles.arrow, ...styles.previous }}
          aria-label={previousLabel}
          onClick={() => stripRef.current?.scrollBy({ left: -258, behavior: 'smooth' })}
        >
          ‹
        </button>
      )}
      {canNext && (
        <button
          type="button"
          style={{ ...styles.arrow, ...styles.next }}
          aria-label={nextLabel}
          onClick={() => stripRef.current?.scrollBy({ left: 258, behavior: 'smooth' })}
        >
          ›
        </button>
      )}
    </section>
  )
}
