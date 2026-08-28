/**
 * «我的专家» — the experts this person authored, plus the way to author one.
 *
 * ## The shape being reproduced
 *
 * WorkBuddy puts this behind a button in the market's own top bar and makes it
 * a whole subpage rather than a dialog: pressing it hides the tabs, the search
 * box and the buttons, and replaces the bar with a back button labelled
 * «全部专家» (its stylesheet says so in as many words — «点击「我的专家」按钮后
 * 整页切换：隐藏左侧 slot / 搜索 / 按钮，整个 ec-topbar 替换为返回按钮»).
 *
 * The page has exactly one section, «我创建的» (`CreatedExpertsPanel`), and its
 * empty state is icon + title + hint + a single «+ 创建专家» button. That button
 * leaves the market entirely: `handleCreateExpert` does `goHome()` and pushes
 * `createExpertMode$`, landing in a mode whose job is to write the expert with
 * you, with its opening line already in the box. Ours is the same act through
 * the kernel's own 创造模式 preset («用于创建自定义 Agent preset»), reached by
 * the summon path every other card here already uses.
 *
 * ## Why there is no «最近使用» half, and no «已安装» one
 *
 * This page used to open on recency, on the strength of WorkBuddy's
 * `myExperts.recent.hint` («仅展示最近使用的 3 个专家»). Unpacking its renderer
 * shows that half **never shipped**: `MyExpertsPanel` renders `CreatedExpertsPanel`
 * and nothing else, `RecentExpertsPanel` is not in the bundle at all, and those
 * `myExperts.recent.*` keys appear only inside the language pack with no caller.
 * Text in an i18n file is not a feature; the judgement has to land on whether a
 * component consumes it. WorkBuddy's live recency is a hover submenu *inside*
 * the mode dropdown — a control this product deliberately does not have — so
 * there is no recency surface here at all rather than a louder one than the
 * original ever had.
 *
 * An «已安装» list is absent for a different reason: it would be a list of our
 * plumbing. An expert is never installed in WorkBuddy — picking one switches its
 * CLI host's plugins non-persistently (`references/experts-and-teams.md`) —
 * while ours land on disk because that is how a DSH session gets composed. The
 * reader asked for an expert, not for a directory listing, so the market card
 * saying «已安装» is the whole of what they need to know.
 *
 * @module openlux-plugin-account/client/MyExperts
 */

import { useMemo } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  Button, IconAgentPresetOutline16, IconChevronLeftOutline14, IconPlusOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { CatalogItem, InstalledPreset } from '../market/wire.ts'
import { createdExperts } from './expert-rows.ts'
import { MarketCard } from './MarketCard.tsx'
import type { MarketKey } from './market-locales.ts'

/** What the page needs. */
export interface MyExpertsProps {
  /** Every preset the roster supplies, ours or not. */
  readonly installed: readonly InstalledPreset[]
  readonly language: 'zh' | 'en'
  readonly t: (key: MarketKey, params?: Record<string, unknown>) => string
  /** Whether this window has a conversation to land a summon in. */
  readonly summonable: boolean
  readonly onSummon: (preset: InstalledPreset) => void
  /** Start a session in the kernel's authoring mode. */
  readonly onCreate: () => void
  readonly onBack: () => void
}

const styles = {
  root: { display: 'flex', flexDirection: 'column', gap: '12px' },
  bar: { display: 'flex', alignItems: 'center', gap: '8px' },
  heading: { color: 'var(--dsw-alias-label-primary)', fontSize: '15px', fontWeight: 600 },
  section: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: '12px',
    alignItems: 'stretch',
  },
  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px',
    padding: '48px 0 40px',
  },
  emptyIcon: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '44px', height: '44px', borderRadius: '50%',
    background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-tertiary)',
  },
  emptyTitle: { color: 'var(--dsw-alias-label-primary)', fontSize: '14px', fontWeight: 600 },
  emptyHint: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
  emptyAction: { marginTop: '8px' },
  create: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: '6px', minHeight: '132px', padding: '12px', borderRadius: '10px',
    border: '1px dashed var(--dsw-alias-border-l1)',
    background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
    fontSize: '13px', cursor: 'pointer',
  },
} satisfies Record<string, CSSProperties>

/**
 * Draw one authored preset with the card the rest of the market uses.
 *
 * The card takes a catalog row and this page has a roster row, but every field
 * it draws exists on both, so the adaptation is a rename rather than a second
 * card component. The description is single-language because that is how it
 * sits in `preset.yml`: whoever wrote this expert wrote one description, and a
 * locale switch here cannot reach a file on disk.
 * @param preset - the roster row.
 * @returns the row as the card reads it.
 */
function asCard(preset: InstalledPreset): CatalogItem {
  return {
    slug: preset.id,
    name: preset.name ?? preset.id,
    nameEn: preset.name ?? preset.id,
    descriptionZh: preset.description ?? '',
    descriptionEn: preset.description ?? '',
    version: preset.version ?? '',
    icon: '',
    categoryId: 0,
    tags: [],
    tagsEn: [],
    team: false,
    featured: false,
    downloads: 0,
  }
}

/**
 * Render the subpage.
 * @param props - the roster and the three callbacks.
 * @returns the page.
 */
export function MyExperts(
  { installed, language, t, summonable, onSummon, onCreate, onBack }: MyExpertsProps,
): ReactNode {
  const created = useMemo(() => createdExperts(installed), [installed])

  return (
    <div style={styles.root} data-testid="openlux-market-mine">
      <div style={styles.bar}>
        <Button
          variant="ghost"
          size="sm"
          icon={<IconChevronLeftOutline14 />}
          data-testid="openlux-market-mine-back"
          onClick={onBack}
        >
          {t('mineBack')}
        </Button>
        <span style={styles.heading}>{t('mine')}</span>
      </div>

      {created.length === 0 && (
        <div style={styles.empty} data-testid="openlux-market-mine-empty">
          <span style={styles.emptyIcon}><IconAgentPresetOutline16 /></span>
          <span style={styles.emptyTitle}>{t('mineCreatedEmpty')}</span>
          <span style={styles.emptyHint}>{t('mineCreatedEmptyHint')}</span>
          <span style={styles.emptyAction}>
            <Button
              variant="primary"
              size="sm"
              icon={<IconPlusOutline16 />}
              data-testid="openlux-market-mine-create"
              onClick={onCreate}
            >
              {t('mineCreate')}
            </Button>
          </span>
        </div>
      )}

      {created.length > 0 && (
        <>
          <span style={styles.section}>{t('mineCreated')}</span>
          <div style={styles.grid}>
            {created.map(preset => (
              <MarketCard
                key={preset.id}
                item={asCard(preset)}
                state={preset.broken === undefined
                  ? { kind: 'installed' }
                  : { kind: 'installed', broken: preset.broken }}
                language={language}
                t={t}
                summonable={summonable}
                // Experts speak in words here too, same as the expert tab.
                primaryLook="text"
                words={{
                  primary: t('mineUse'),
                  busy: t('preparing'),
                  // "Installed" is the entry condition for every card here.
                  done: '',
                  unhealthy: t('brokenInstalled'),
                }}
                // Every row here is installed, so the card's corner is the
                // check — pressable, because using it is why this page exists.
                {...summonable ? { onTry: () => onSummon(preset), tryLabel: t('mineUse') } : {}}
                // No detail sheet: an authored expert has no catalog row to
                // open, so the whole card is the one action it can offer.
                onOpen={() => { if (summonable) onSummon(preset) }}
                onPrimary={() => onSummon(preset)}
              />
            ))}
            {/* Last in the grid, which is where WorkBuddy puts it. */}
            <div
              role="button"
              tabIndex={0}
              style={styles.create}
              data-testid="openlux-market-mine-create"
              onClick={onCreate}
              onKeyDown={event => { if (event.key === 'Enter') onCreate() }}
            >
              <IconPlusOutline16 />
              <span>{t('mineCreateCard')}</span>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
