/**
 * The market's three dialogs: what an entry is, whether to install it, and what
 * happened.
 *
 * The middle one is not decoration. A host that installs on a single click is
 * the shape the upstream market shell rules out: the confirmation names the
 * locked destination directory it is asking about, and says the thing that is
 * true of any preset — it runs locally with the user's permissions. It also
 * never renders a command string from the catalog, because nothing here executes
 * one.
 *
 * The outcome dialog exists because every refusal from the host is an ordinary
 * answer with a reason, and a reason the user cannot read is a bug report we
 * would receive instead.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  Button, IconFullscreenOutline16, IconRightUpOutline14, IconSettingsOutline14,
  Input, Modal, Pill, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CatalogItem, CustomConnectorFile, CustomConnectorSync, CustomOpen, HomePlaybook,
  InstallOutcome, PlaybookArtifact,
} from '../market/wire.ts'
import { describe } from './MarketCard.tsx'
import type { MarketKey } from './market-locales.ts'
import { PlaybookArtifactPreview } from './PlaybookArtifactPreview.tsx'

/** Copy reader for this section. */
type T = (key: MarketKey, params?: Record<string, unknown>) => string

const styles = {
  body: { display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px' },
  description: { color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6, whiteSpace: 'pre-wrap' },
  rows: { display: 'flex', flexDirection: 'column', gap: '6px' },
  row: { display: 'flex', alignItems: 'baseline', gap: '10px', fontSize: '12px' },
  label: { flex: '0 0 72px', color: 'var(--dsw-alias-label-tertiary)' },
  value: { flex: 1, minWidth: 0, color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-all' },
  path: {
    padding: '8px', borderRadius: '6px', fontFamily: 'monospace', fontSize: '12px',
    // Not `bg-layer-2`: in the light theme it resolves to the same white as
    // layer-1, so the destination would sit on the card with no separation
    // (measured, not assumed). This is the tint the kernel's own inline
    // markers use.
    background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-primary)',
    wordBreak: 'break-all',
  },
  tags: { display: 'flex', flexWrap: 'wrap', gap: '4px' },
  // The custom-connector dialog, WorkBuddy's «MCP 服务管理» frame: a headed
  // card whose body swaps between a server list and a full-bleed editor.
  customRoot: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
  customHeader: {
    display: 'flex', alignItems: 'center', gap: '12px',
    padding: '20px 56px 14px 24px', flex: '0 0 auto',
  },
  customBadge: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '36px', height: '36px', flex: '0 0 36px', borderRadius: '10px',
    border: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-secondary)',
  },
  customHeading: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1 },
  customTitle: {
    margin: 0, fontSize: '15px', fontWeight: 600, lineHeight: '22px',
    color: 'var(--dsw-alias-label-primary)',
  },
  customSubtitle: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: '18px' },
  customList: {
    flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 24px 20px',
    display: 'flex', flexDirection: 'column', gap: '8px',
  },
  customRow: {
    display: 'flex', flexDirection: 'column', gap: '4px', padding: '12px 14px',
    borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l1)',
  },
  customRowHead: {
    display: 'flex', alignItems: 'center', gap: '8px',
    fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)',
  },
  customRowDot: { width: '8px', height: '8px', borderRadius: '50%', flex: '0 0 8px' },
  customRowState: { marginLeft: 'auto', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
  customRowProblem: {
    color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px',
    lineHeight: 1.5, paddingLeft: '16px',
  },
  customEmpty: {
    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', gap: '6px', padding: '24px',
  },
  customEmptyBadge: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '56px', height: '56px', borderRadius: '14px', marginBottom: '6px',
    border: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-tertiary)',
  },
  customEmptyTitle: { fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  customEmptyHint: {
    fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', marginBottom: '10px',
  },
  customBar: {
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '0 24px 10px', flex: '0 0 auto',
  },
  customBack: {
    display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '4px 8px',
    margin: '-4px 0 -4px -8px', border: 0, background: 'transparent', borderRadius: '6px',
    color: 'var(--dsw-alias-label-secondary)', fontSize: '13px', cursor: 'pointer',
  },
  customPathStrip: {
    display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 24px',
    background: 'var(--dsw-alias-interactive-bg-hover)', fontSize: '12px', flex: '0 0 auto',
  },
  customPathLabel: { color: 'var(--dsw-alias-label-tertiary)', flex: '0 0 auto' },
  customPathValue: {
    fontFamily: 'monospace', color: 'var(--dsw-alias-label-secondary)',
    wordBreak: 'break-all', minWidth: 0,
  },
  // The theme ships no warning-state token; this is WorkBuddy's amber, same
  // as the connecting dot in `market-card-style.ts`.
  customDirty: { marginLeft: 'auto', flex: '0 0 auto', color: '#e6a23c' },
  customEditor: {
    // WorkBuddy's seat here is a Monaco editor; the result being matched is
    // «edit the JSON without leaving the app», and for a file that is a dozen
    // lines a plain textarea carries it without shipping an editor engine.
    flex: 1, minHeight: 0, width: '100%', boxSizing: 'border-box', padding: '12px 24px',
    border: 0, resize: 'none', outline: 'none', background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    fontFamily: 'monospace', fontSize: '12px', lineHeight: 1.6,
  },
  customFoot: {
    display: 'flex', flexDirection: 'column', gap: '6px',
    padding: '8px 24px 14px', flex: '0 0 auto',
  },
  prompts: { display: 'flex', flexDirection: 'column', gap: '6px' },
  promptsLabel: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' },
  prompt: {
    // A full-width row rather than a chip: these are sentences, and a wrapping
    // chip row of sentences reads as a paragraph with borders in it.
    padding: '8px 10px', borderRadius: '8px', textAlign: 'left', cursor: 'pointer',
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-primary)', fontSize: '12px', lineHeight: 1.5,
  },
  footer: { display: 'flex', justifyContent: 'flex-end', gap: '8px' },
  note: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: 1.6 },
  refusal: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '13px' },
  expertDialog: {
    display: 'flex', flexDirection: 'column', minHeight: 0,
    maxHeight: 'min(560px, calc(100vh - 48px))',
  },
  expertHeader: {
    position: 'relative', display: 'flex', alignItems: 'center', gap: '20px',
    padding: '24px 48px 16px 24px', flex: '0 0 auto',
  },
  expertAvatar: {
    position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '56px', height: '56px', flex: '0 0 56px', overflow: 'hidden',
    borderRadius: '50%', color: '#fff', fontSize: '24px', fontWeight: 600,
  },
  expertAvatarImage: {
    position: 'absolute', inset: 0, width: '100%', height: '100%',
    objectFit: 'cover', display: 'block',
  },
  expertHeading: {
    display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column',
    alignItems: 'flex-start', gap: '10px',
  },
  expertTitleLine: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', minWidth: 0,
  },
  expertTitle: {
    margin: 0, color: 'var(--dsw-alias-label-primary)', fontSize: '18px',
    fontWeight: 600, lineHeight: '26px',
  },
  expertProfession: {
    color: 'var(--dsw-alias-label-tertiary)', fontSize: '14px', lineHeight: '22px',
  },
  expertUses: {
    position: 'absolute', top: '25px', right: '52px',
    color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: '20px',
  },
  closeButton: {
    position: 'absolute', top: '20px', right: '16px', display: 'flex',
    alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px',
    padding: 0, border: 0, borderRadius: '8px', background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: '20px',
  },
  expertScroll: {
    display: 'flex', flex: 1, minHeight: 0, overflowY: 'auto', flexDirection: 'column',
    gap: '24px', padding: '0 24px 24px',
  },
  expertDescription: {
    margin: 0, color: 'var(--dsw-alias-label-primary)', fontSize: '13px',
    lineHeight: 1.65, whiteSpace: 'pre-wrap',
  },
  promptSection: { display: 'flex', flexDirection: 'column', gap: '12px' },
  promptList: {
    display: 'flex', flexDirection: 'column', gap: '10px',
    padding: '14px', borderRadius: '14px',
    background: 'var(--dsw-alias-bg-layer-2)',
  },
  expertPrompt: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
    minHeight: '52px', width: '100%', padding: '11px 16px', border: 0, borderRadius: '12px',
    textAlign: 'left', cursor: 'pointer', background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: 1.55,
  },
  promptSkeleton: {
    minHeight: '52px', width: '100%', borderRadius: '12px',
    background: 'var(--dsw-alias-interactive-bg-hover)',
  },
  promptIcon: {
    display: 'flex', flex: '0 0 24px', alignItems: 'center', justifyContent: 'center',
    width: '24px', height: '24px', borderRadius: '50%',
    color: 'var(--dsw-alias-label-tertiary)',
  },
  sectionTitle: {
    display: 'flex', alignItems: 'center', gap: '8px',
    color: 'var(--dsw-alias-label-primary)', fontSize: '15px', fontWeight: 600,
  },
  cases: { display: 'flex', flexDirection: 'column', gap: '12px' },
  caseList: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '10px' },
  caseCard: {
    minWidth: 0, padding: 0, overflow: 'hidden', textAlign: 'left', cursor: 'pointer',
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '14px',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit',
  },
  caseCover: { width: '100%', height: '112px', objectFit: 'cover', display: 'block' },
  caseCoverFallback: {
    width: '100%', height: '112px', display: 'block',
    background: 'linear-gradient(135deg, var(--dsw-alias-state-business-tertiary), var(--dsw-alias-interactive-bg-hover))',
  },
  caseCopy: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0, padding: '9px 10px 11px' },
  caseTitle: {
    color: 'var(--dsw-alias-label-primary)', fontSize: '13px', fontWeight: 600,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  caseSubtitle: {
    color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  previewDialog: { display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' },
  previewHead: {
    position: 'relative', display: 'flex', flexDirection: 'column', gap: '8px',
    padding: '20px 52px 12px 24px',
  },
  previewTitleLine: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 },
  backButton: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 28px',
    width: '28px', height: '28px', padding: 0, border: 0, borderRadius: '8px',
    background: 'transparent', color: 'var(--dsw-alias-label-primary)',
    cursor: 'pointer', fontSize: '24px',
  },
  previewTitle: {
    margin: 0, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-primary)',
    fontSize: '18px', fontWeight: 600, lineHeight: '28px',
  },
  previewDescription: {
    margin: 0, color: 'var(--dsw-alias-label-secondary)',
    fontSize: '13px', lineHeight: 1.55,
  },
  expertChip: {
    display: 'inline-flex', alignItems: 'center', alignSelf: 'flex-start', gap: '6px',
    padding: '4px 8px', borderRadius: '7px',
    background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-secondary)', fontSize: '12px',
  },
  previewStage: {
    flex: 1, minHeight: 0, margin: '0 24px', overflow: 'hidden',
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '14px',
    background: 'var(--dsw-alias-bg-layer-1)',
  },
  previewFooter: {
    display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
    gap: '12px', padding: '14px 24px 20px',
  },
  previewPrimaryContent: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
  },
} satisfies Record<string, CSSProperties>

/** What the detail dialog needs. */
export interface MarketDetailProps {
  readonly item: CatalogItem | undefined
  readonly language: 'zh' | 'en'
  readonly categoryName: string
  /**
   * Which shelf this row came from.
   *
   * The sheet used to read every row as an expert: a skill's «类型» said 专家 and
   * its button said 召唤, because both were derived from `summonable` — which is
   * a fact about the window, not about the row.
   */
  readonly kind: 'expert' | 'skill' | 'connector'
  readonly t: T
  /**
   * The primary action, absent when this row cannot be acted on.
   * @param prompt - a suggestion the user picked, else the expert's own opening one.
   */
  readonly onPrimary?: (prompt?: string) => void
  /** Whether that action ends in a session (drives the copy and the suggestions). */
  readonly summonable: boolean
  /** Why it cannot, when it cannot; already localized. */
  readonly blocked?: string
  readonly installed: boolean
  /**
   * Opening questions this expert publishes, best first.
   *
   * The first is what a plain summon prefills; every one of them is offered
   * here as its own way in, which is how WorkBuddy's detail page presents them.
   */
  readonly prompts: readonly string[]
  /** Keep the prompt section's geometry stable while its per-expert manifest is read. */
  readonly promptLoading?: boolean
  /** Cases whose V2 relation explicitly names this expert/team, already capped at three. */
  readonly relatedCases?: readonly HomePlaybook[]
  readonly caseOpening?: number
  readonly caseError?: string
  readonly casePreview?: { readonly item: HomePlaybook; readonly artifact: PlaybookArtifact }
  readonly onCaseOpen?: (item: HomePlaybook) => void
  readonly onCaseBack?: () => void
  readonly onCaseUse?: (item: HomePlaybook) => void
  /**
   * Use what is already installed, when there is a way to.
   *
   * Offered instead of the primary action on a row that is already in place: an
   * installed skill's «安装» button would otherwise install it a second time.
   */
  readonly onTry?: () => void
  readonly tryLabel?: string
  /**
   * Undo the install from inside the sheet.
   *
   * The connector card used to carry 「断开」 on its footer, which put a
   * destructive act one stray click away on every connected row; the sheet is
   * where the reader has already named the row they mean, so it lives here.
   */
  readonly onRemove?: () => void
  readonly removeLabel?: string
  readonly onClose: () => void
}

/**
 * Render the detail dialog.
 * @param props - the row and its surroundings.
 * @returns the dialog, or null when nothing is selected.
 */
export function MarketDetail(props: MarketDetailProps): ReactNode {
  const { item, kind } = props
  if (item === undefined) return null
  return kind === 'expert'
    ? <ExpertMarketDetail {...props} item={item} />
    : <StandardMarketDetail {...props} item={item} />
}

function StandardMarketDetail(props: MarketDetailProps & { readonly item: CatalogItem }): ReactNode {
  const {
    item, language, categoryName, kind, t, onPrimary, summonable, blocked, installed,
    onTry, tryLabel, onRemove, removeLabel, onClose,
  } = props
  const label = kind === 'connector'
    ? t('connect')
    : t('install')
  const use = installed && onTry !== undefined

  return (
    <Modal
      open
      onClose={onClose}
      title={item.name}
      closeLabel={t('detailClose')}
      footer={(
        <div style={styles.footer}>
          <Button variant="ghost" onClick={onClose}>{t('detailClose')}</Button>
          {/*
            Primary, matching the 「连接」 the sheet shows before a connect:
            whichever way this row can go, its one action reads the same.
          */}
          {onRemove !== undefined && removeLabel !== undefined && (
            <Button
              variant="primary"
              data-testid="openlux-market-detail-remove"
              onClick={onRemove}
            >
              {removeLabel}
            </Button>
          )}
          {/*
            The state word earns its place only when nothing else says it: a
            sheet that offers 「断开」 is already talking about a connected row,
            and a second caption beside the button is clutter.
          */}
          {installed && !summonable && !use && onRemove === undefined && (
            <span style={styles.note}>{t(kind === 'connector' ? 'connected' : 'installed')}</span>
          )}
          {use && (
            <Button
              variant="primary"
              data-testid="openlux-market-detail-try"
              onClick={onTry}
            >
              {tryLabel ?? t('tryNow')}
            </Button>
          )}
          {!use && onPrimary !== undefined && (installed ? summonable : true) && (
            <Button
              variant="primary"
              data-testid="openlux-market-detail-action"
              onClick={() => onPrimary()}
            >
              {label}
            </Button>
          )}
          {onPrimary === undefined && blocked !== undefined && (
            <span style={styles.note}>{blocked}</span>
          )}
        </div>
      )}
    >
      <div style={styles.body}>
        <span style={styles.description}>{describe(item, language)}</span>
        <div style={styles.rows}>
          <div style={styles.row}>
            <span style={styles.label}>{t('detailKind')}</span>
            <span style={styles.value}>
              {kind === 'skill' && t('detailKindSkill')}
              {kind === 'connector' && t('detailKindConnector')}
            </span>
          </div>
          {categoryName !== '' && (
            <div style={styles.row}>
              <span style={styles.label}>{t('detailCategory')}</span>
              <span style={styles.value}>{categoryName}</span>
            </div>
          )}
          {item.version !== '' && (
            <div style={styles.row}>
              <span style={styles.label}>{t('detailVersion')}</span>
              <span style={styles.value}>{item.version}</span>
            </div>
          )}
          {/* The card no longer carries these, so this is where the author and
              the licence a skill ships under are read. */}
          {item.tags.length > 0 && (
            <div style={styles.row}>
              <span style={styles.label}>{t('detailTags')}</span>
              <span style={{ ...styles.value, ...styles.tags }}>
                {item.tags.map(tag => <Pill key={tag}>{tag}</Pill>)}
              </span>
            </div>
          )}
          {item.downloads > 0 && (
            <div style={styles.row}>
              <span style={styles.label}>{t('detailDownloads')}</span>
              <span style={styles.value}>{t('downloads', { count: item.downloads })}</span>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

function ExpertMarketDetail(props: MarketDetailProps & { readonly item: CatalogItem }): ReactNode {
  const {
    item, language, categoryName, t, onPrimary, blocked, prompts,
    promptLoading = false,
    relatedCases = [], caseOpening, caseError, casePreview,
    onCaseOpen, onCaseBack, onCaseUse, onClose,
  } = props
  if (casePreview !== undefined) {
    return (
      <ExpertCasePreview
        item={item}
        preview={casePreview}
        t={t}
        {...onCaseBack === undefined ? {} : { onBack: onCaseBack }}
        {...onCaseUse === undefined ? {} : { onUse: onCaseUse }}
        onClose={onClose}
      />
    )
  }
  return (
    <Modal
      open
      headless
      className="openlux-market-expert-detail-dialog"
      onClose={onClose}
      title={item.name}
      closeLabel={t('detailClose')}
    >
      <div style={styles.expertDialog} data-testid="openlux-market-expert-detail">
        <header style={styles.expertHeader}>
          <ExpertAvatar item={item} />
          <div style={styles.expertHeading}>
            <div style={styles.expertTitleLine}>
              <h2 style={styles.expertTitle}>{item.name}</h2>
              {item.team && <Pill>{t('teamBadge')}</Pill>}
              {categoryName !== '' && <span style={styles.expertProfession}>{categoryName}</span>}
            </div>
            {onPrimary !== undefined && (
              <Button
                variant="primary"
                size="sm"
                data-testid="openlux-market-detail-action"
                onClick={() => onPrimary()}
              >
                {t('summonExpert')}
              </Button>
            )}
            {onPrimary === undefined && blocked !== undefined && (
              <span style={styles.note}>{blocked}</span>
            )}
          </div>
          {item.downloads > 0 && (
            <span style={styles.expertUses}>{t('expertUseCount', { count: item.downloads })}</span>
          )}
          <button
            type="button"
            style={styles.closeButton}
            aria-label={t('detailClose')}
            onClick={onClose}
            onPointerEnter={event => {
              event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)'
            }}
            onPointerLeave={event => { event.currentTarget.style.background = 'transparent' }}
          >
            ×
          </button>
        </header>

        <div style={styles.expertScroll}>
          <p style={styles.expertDescription}>{describe(item, language)}</p>
          {item.tags.length > 0 && (
            <div style={styles.tags}>
              {item.tags.map(tag => <Pill key={tag}>{tag}</Pill>)}
            </div>
          )}

          {onPrimary !== undefined && (promptLoading || prompts.length > 0) && (
            <section style={styles.promptSection} aria-label={t('detailPrompts')}>
              <span style={styles.sectionTitle}><OffersGlyph />{t('detailPrompts')}</span>
              <div style={styles.promptList}>
                {promptLoading
                  ? [0, 1, 2].map(index => (
                      <span key={index} style={styles.promptSkeleton} aria-hidden="true" />
                    ))
                  : prompts.slice(0, 3).map(prompt => (
                      <button
                        key={prompt}
                        type="button"
                        style={styles.expertPrompt}
                        data-testid="openlux-market-prompt"
                        onClick={() => onPrimary(prompt)}
                        onPointerEnter={event => {
                          event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-active)'
                        }}
                        onPointerLeave={event => {
                          event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)'
                        }}
                      >
                        <span>{prompt}</span>
                        <span style={styles.promptIcon} aria-hidden="true"><ChatGlyph /></span>
                      </button>
                    ))}
              </div>
            </section>
          )}

          {relatedCases.length > 0 && onCaseOpen !== undefined && (
            <section style={styles.cases} data-testid="openlux-market-related-cases">
              <span style={styles.sectionTitle}><CasesGlyph />{t('homeCases')}</span>
              <div style={styles.caseList}>
                {relatedCases.map(related => (
                  <RelatedCaseCard
                    key={related.id}
                    item={related}
                    disabled={caseOpening === related.id}
                    onOpen={() => onCaseOpen(related)}
                  />
                ))}
              </div>
            </section>
          )}
          {caseError !== undefined && <span style={styles.refusal}>{caseError}</span>}
        </div>
      </div>
    </Modal>
  )
}

function ExpertCasePreview(
  { item, preview, t, onBack, onUse, onClose }: {
    readonly item: CatalogItem
    readonly preview: { readonly item: HomePlaybook; readonly artifact: PlaybookArtifact }
    readonly t: T
    readonly onBack?: () => void
    readonly onUse?: (item: HomePlaybook) => void
    readonly onClose: () => void
  },
): ReactNode {
  const [expanded, setExpanded] = useState(false)
  return (
    <Modal
      open
      headless
      className={`openlux-market-preview-dialog${expanded ? ' openlux-market-preview-dialog-expanded' : ''}`}
      onClose={onClose}
      title={preview.item.title}
      closeLabel={t('homeClose')}
    >
      <div style={styles.previewDialog} data-testid="openlux-market-case-preview">
        <header style={styles.previewHead}>
          <div style={styles.previewTitleLine}>
            {onBack !== undefined && (
              <button
                type="button"
                style={styles.backButton}
                aria-label={t('caseBackToExpert')}
                onClick={onBack}
              >
                ‹
              </button>
            )}
            <h2 style={styles.previewTitle}>{preview.item.title}</h2>
          </div>
          {(preview.item.subtitle || preview.item.description) !== '' && (
            <p style={styles.previewDescription}>
              {preview.item.subtitle || preview.item.description}
            </p>
          )}
          <span style={styles.expertChip}>{item.name}</span>
          <button
            type="button"
            style={styles.closeButton}
            aria-label={t('homeClose')}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div style={styles.previewStage}>
          <PlaybookArtifactPreview
            artifact={preview.artifact}
            title={preview.item.title}
            expanded={expanded}
            t={t}
          />
        </div>
        <footer style={styles.previewFooter}>
          <Tooltip label={t(expanded ? 'caseCollapse' : 'caseExpand')} side="top">
            <button
              type="button"
              className="openlux-market-preview-toggle"
              aria-label={t(expanded ? 'caseCollapse' : 'caseExpand')}
              onClick={() => setExpanded(value => !value)}
            >
              {expanded ? <CollapseGlyph /> : <IconFullscreenOutline16 />}
            </button>
          </Tooltip>
          {onUse !== undefined && preview.item.initPrompt !== '' && (
            <Button
              variant="primary"
              data-testid="openlux-market-case-use"
              onClick={() => onUse(preview.item)}
            >
              <span style={styles.previewPrimaryContent}>
                {t('caseCreateMine')}
                <IconRightUpOutline14 />
              </span>
            </Button>
          )}
        </footer>
      </div>
    </Modal>
  )
}

function avatarHue(seed: string): string {
  let value = 0
  for (let index = 0; index < seed.length; index += 1) {
    value = (value * 31 + seed.charCodeAt(index)) % 360
  }
  return `hsl(${value}deg 42% 45%)`
}

function ExpertAvatar({ item }: { readonly item: CatalogItem }): ReactNode {
  const [failed, setFailed] = useState(false)
  const remote = /^https?:\/\//u.test(item.icon)
  return (
    <span style={{ ...styles.expertAvatar, background: avatarHue(item.slug) }} aria-hidden="true">
      {[...item.name][0] ?? '?'}
      {remote && !failed && (
        <img
          src={item.icon}
          alt=""
          style={styles.expertAvatarImage}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  )
}

function ChatGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 3.5h10v6.8H8l-3.2 2.2v-2.2H3z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M6 6.9h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function CollapseGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 6h3.5V2.5M10 2.5V6h3.5M13.5 10H10v3.5M6 13.5V10H2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function OffersGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M5.1 9.7C4.4 9 4 8 4 7a4 4 0 0 1 8 0c0 1-.4 2-1.1 2.7-.6.6-.9 1.1-.9 1.8H6c0-.7-.3-1.2-.9-1.8Z" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6.4 13.5h3.2M8 1V.2M13.2 2.8l.6-.6M2.8 2.8l-.6-.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function CasesGlyph(): ReactNode {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="4" height="4" rx="1" stroke="currentColor" />
      <rect x="9.5" y="1.5" width="4" height="4" rx="1" stroke="currentColor" />
      <rect x="1.5" y="9.5" width="4" height="4" rx="1" stroke="currentColor" />
      <rect x="9.5" y="9.5" width="4" height="4" rx="1" stroke="currentColor" />
    </svg>
  )
}

function RelatedCaseCard(
  { item, disabled, onOpen }: {
    readonly item: HomePlaybook
    readonly disabled: boolean
    readonly onOpen: () => void
  },
): ReactNode {
  const [imageFailed, setImageFailed] = useState(false)
  return (
    <button
      type="button"
      style={styles.caseCard}
      disabled={disabled}
      title={item.title}
      data-testid={`openlux-market-related-case-${item.id}`}
      onClick={onOpen}
    >
      {item.cover !== '' && !imageFailed
        ? (
          <img
            src={item.cover}
            alt=""
            loading="lazy"
            style={styles.caseCover}
            onError={() => setImageFailed(true)}
          />
        )
        : <span style={styles.caseCoverFallback} aria-hidden="true" />}
      <span style={styles.caseCopy}>
        <span style={styles.caseTitle}>{item.title}</span>
        {(item.subtitle || item.description) !== '' && (
          <span style={styles.caseSubtitle}>{item.subtitle || item.description}</span>
        )}
      </span>
    </button>
  )
}

/** What the confirmation needs. */
export interface MarketConfirmProps {
  readonly item: CatalogItem | undefined
  /** Resolved destination directory, as the host reported it. */
  readonly path: string
  readonly busy: boolean
  /** Whether confirming ends in a session rather than in the roster. */
  readonly summonable: boolean
  readonly t: T
  readonly onCancel: () => void
  readonly onConfirm: () => void
}

/**
 * Render the install confirmation.
 *
 * Asked once per expert, on the summon that first writes it to disk. It is not
 * a courtesy step: what lands is a composition, and a `user` preset "carries
 * the same trust as shell access" in the kernel's own words — so the sheet
 * names the locked destination and says the thing that is true of every preset.
 * @param props - the row, the destination, and the two answers.
 * @returns the dialog, or null when nothing is pending.
 */
export function MarketConfirm(props: MarketConfirmProps): ReactNode {
  const { item, path, busy, summonable, t, onCancel, onConfirm } = props
  if (item === undefined) return null

  return (
    <Modal
      open
      onClose={onCancel}
      title={t('confirmTitle')}
      closeLabel={t('confirmCancel')}
      footer={(
        <div style={styles.footer}>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>{t('confirmCancel')}</Button>
          <Button
            variant="primary"
            disabled={busy}
            data-testid="openlux-market-confirm"
            onClick={onConfirm}
          >
            {busy ? t('preparing') : (summonable ? t('confirmSummon') : t('confirmInstall'))}
          </Button>
        </div>
      )}
    >
      <div style={styles.body}>
        <span style={styles.note}>{summonable ? t('confirmBodySummon') : t('confirmBody')}</span>
        <span style={styles.path} data-testid="openlux-market-confirm-path">{path}</span>
      </div>
    </Modal>
  )
}

/** Which sentence a success gets; the three partitions land in three places. */
function installedBodyKey(partition: 'expert' | 'skill' | 'connector'): MarketKey {
  if (partition === 'skill') return 'installedSkillBody'
  return partition === 'connector' ? 'connectedBody' : 'installedBody'
}

/** What the token dialog needs. */
export interface ConnectorTokenProps {
  /** The connector being connected, absent when the dialog is closed. */
  readonly item: CatalogItem | undefined
  /** What the manifest calls the secret, when it says. */
  readonly label?: string
  readonly value: string
  readonly busy: boolean
  readonly t: T
  readonly onChange: (value: string) => void
  readonly onCancel: () => void
  readonly onConfirm: () => void
}

/**
 * Collect the one secret a connector needs.
 *
 * A dialog rather than a field on the card, for the reason the install
 * confirmation is a dialog: this is the moment the user hands over a credential,
 * and it says which connector is about to receive it and where it is kept. The
 * value is `password`-typed and never echoed back by the host.
 * @param props - the connector, the field, and the two actions.
 * @returns the dialog, or null when nothing is being connected.
 */
export function ConnectorToken(props: ConnectorTokenProps): ReactNode {
  const { item, label, value, busy, t, onChange, onCancel, onConfirm } = props
  if (item === undefined) return null

  return (
    <Modal
      open
      onClose={onCancel}
      title={t('connectorTokenTitle')}
      closeLabel={t('connectorTokenCancel')}
      footer={(
        <div style={styles.footer}>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            {t('connectorTokenCancel')}
          </Button>
          <Button
            variant="primary"
            disabled={busy || value.trim() === ''}
            data-testid="openlux-market-token-confirm"
            onClick={onConfirm}
          >
            {busy ? t('connecting') : t('connectorTokenConfirm')}
          </Button>
        </div>
      )}
    >
      <div style={styles.body}>
        <span style={styles.note}>{t('connectorTokenBody', { name: item.name })}</span>
        <Input
          value={value}
          type="password"
          autoFocus
          placeholder={label ?? t('connectorTokenLabel')}
          data-testid="openlux-market-token-input"
          onChange={event => onChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && value.trim() !== '' && !busy) onConfirm()
          }}
        />
      </div>
    </Modal>
  )
}

/** What the custom-connector panel needs. */
export interface CustomConnectorProps {
  readonly open: boolean
  /** The file's text, read as the panel opened; absent until the read lands. */
  readonly file?: CustomConnectorFile
  /** The last re-read, absent until one has happened. */
  readonly sync?: CustomConnectorSync
  readonly busy: boolean
  /** Why the last save did not land, cleared by the next one that does. */
  readonly saveError?: string
  /** What the OS did with the file, absent until the opener was pressed. */
  readonly handoff?: CustomOpen['did']
  readonly t: T
  readonly onOpenFile: () => void
  readonly onSave: (content: string) => void
  readonly onClose: () => void
}

/** WorkBuddy's stacked-servers glyph, for the dialog head and the empty seat. */
function ServersGlyph({ size }: { readonly size: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="4.4" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2" y="8.6" width="12" height="4.4" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4.7" cy="5.2" r="0.75" fill="currentColor" />
      <circle cx="4.7" cy="10.8" r="0.75" fill="currentColor" />
    </svg>
  )
}

/**
 * The user's own MCP servers, edited where they take effect.
 *
 * WorkBuddy's «MCP 服务管理» shape (`mcp-panel.tsx` + `mcp-config-editor.tsx`),
 * two views in one framed card: the dialog opens on a *list* of the file's
 * servers — or a centred empty seat pointing at 「配置」 — and the JSON editor
 * is the second view behind 「配置 MCP」, with the file's path above it and a
 * save that validates before it writes and mounts the result immediately. An
 * earlier revision only *opened* the file and asked the user to come back and
 * press «重新读取»; the round-trip through an external editor is what this
 * replaces. What the dialog adds over a bare editor is the part no text editor
 * can tell you: whether what you wrote actually started, and what it said if
 * it did not.
 * @param props - the file, the last save's verdict, and the actions.
 * @returns the dialog, or null while closed.
 */
export function CustomConnector(props: CustomConnectorProps): ReactNode {
  const { open, file, sync, busy, saveError, handoff, t, onOpenFile, onSave, onClose } = props
  const [view, setView] = useState<'list' | 'editor'>('list')
  // The draft overlays the file's text; undefined means «not touched yet».
  // Keyed off the file content rather than copied once, so a save's normalized
  // write-back (or a fresh read on reopen) becomes the new baseline.
  const [draft, setDraft] = useState<string>()
  // Raised by the save press, so the baseline moving (= the save landed) is
  // what sends the user back to the list — a refused save moves nothing and
  // stays in the editor with its reason.
  const saved = useRef(false)
  useEffect(() => { setDraft(undefined) }, [file?.content, open])
  useEffect(() => { if (open) { setView('list'); saved.current = false } }, [open])
  useEffect(() => {
    if (saved.current) { setView('list'); saved.current = false }
  }, [file?.content])
  if (!open) return null

  const text = draft ?? file?.content ?? ''
  const dirty = file !== undefined && text !== file.content
  const rows = sync?.rows ?? []

  // Leaving the editor with unsaved edits gets one plain confirm — WorkBuddy's
  // own guard is exactly `window.confirm` (`mcp-config-editor.tsx`).
  const leaveEditor = (): void => {
    if (dirty && !window.confirm(t('customUnsaved'))) return
    setDraft(undefined)
    setView('list')
  }

  return (
    <Modal
      open
      headless
      className="openlux-market-custom-dialog"
      onClose={onClose}
      title={t('customTitle')}
      closeLabel={t('closeMarket')}
    >
      <div style={styles.customRoot} data-testid="openlux-market-custom-dialog">
        <header style={styles.customHeader}>
          <span style={styles.customBadge} aria-hidden="true"><ServersGlyph size={18} /></span>
          <div style={styles.customHeading}>
            <h2 style={styles.customTitle}>{t('customTitle')}</h2>
            <span style={styles.customSubtitle}>{t('customSubtitle')}</span>
          </div>
          {view === 'list' && (
            <Button
              variant="ghost"
              size="sm"
              icon={<IconSettingsOutline14 />}
              data-testid="openlux-market-custom-configure"
              onClick={() => setView('editor')}
            >
              {t('customConfigure')}
            </Button>
          )}
          <button
            type="button"
            style={styles.closeButton}
            aria-label={t('closeMarket')}
            onClick={onClose}
            onPointerEnter={event => {
              event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)'
            }}
            onPointerLeave={event => { event.currentTarget.style.background = 'transparent' }}
          >
            ×
          </button>
        </header>

        {view === 'list' && (
          <div style={styles.customList} data-testid="openlux-market-custom-list">
            {/* A file that did not parse has no rows; its reason shows here. */}
            {rows.length === 0 && sync !== undefined && sync.problems.map(problem => (
              <span key={problem} style={styles.refusal} data-testid="openlux-market-custom-problem">
                {problem}
              </span>
            ))}
            {rows.map(row => (
              <div key={row.name} style={styles.customRow} data-testid="openlux-market-custom-row">
                <div style={styles.customRowHead}>
                  <span
                    style={{
                      ...styles.customRowDot,
                      background: row.live
                        ? 'var(--dsw-alias-state-success-primary)'
                        : 'var(--dsw-alias-state-error-primary)',
                    }}
                    aria-hidden="true"
                  />
                  {row.name}
                  <span style={styles.customRowState}>
                    {row.live ? t('connected') : t('customRowDown')}
                  </span>
                </div>
                {row.problem !== undefined && (
                  <span style={styles.customRowProblem}>{row.problem}</span>
                )}
              </div>
            ))}
            {rows.length === 0 && (
              <div style={styles.customEmpty} data-testid="openlux-market-custom-empty">
                <span style={styles.customEmptyBadge} aria-hidden="true">
                  <ServersGlyph size={26} />
                </span>
                <span style={styles.customEmptyTitle}>{t('customEmptyTitle')}</span>
                <span style={styles.customEmptyHint}>{t('customEmptyHint')}</span>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="openlux-market-custom-empty-configure"
                  onClick={() => setView('editor')}
                >
                  {t('customEmptyAction')}
                </Button>
              </div>
            )}
          </div>
        )}

        {view === 'editor' && (
          <>
            <div style={styles.customBar}>
              <button
                type="button"
                style={styles.customBack}
                data-testid="openlux-market-custom-back"
                onClick={leaveEditor}
                onPointerEnter={event => {
                  event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)'
                }}
                onPointerLeave={event => { event.currentTarget.style.background = 'transparent' }}
              >
                ‹ {t('customBack')}
              </button>
              <span style={{ flex: 1 }} />
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                data-testid="openlux-market-custom-cancel"
                onClick={leaveEditor}
              >
                {t('customCancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                // Disabled while clean, WorkBuddy's rule: the button doubles as
                // the «you have unsaved changes» signal.
                disabled={busy || !dirty}
                data-testid="openlux-market-custom-save"
                onClick={() => { saved.current = true; onSave(text) }}
              >
                {busy ? t('customSaving') : t('customSave')}
              </Button>
            </div>
            {file !== undefined && (
              <div style={styles.customPathStrip}>
                <span style={styles.customPathLabel}>{t('customPathLabel')}:</span>
                <span style={styles.customPathValue} data-testid="openlux-market-custom-path">
                  {file.path}
                </span>
                {dirty && <span style={styles.customDirty}>{t('customDirty')}</span>}
              </div>
            )}
            <textarea
              value={text}
              spellCheck={false}
              disabled={busy || file === undefined}
              style={styles.customEditor}
              data-testid="openlux-market-custom-editor"
              aria-label={t('customTitle')}
              onChange={event => setDraft(event.target.value)}
            />
            <div style={styles.customFoot}>
              {saveError !== undefined && (
                <span style={styles.refusal} data-testid="openlux-market-custom-saveerror">
                  {saveError}
                </span>
              )}
              {/*
                The two lesser outcomes of the external open each need a
                sentence, or that button looks like it did nothing. Revealed is
                not a failure, so it is not coloured like one.
              */}
              {handoff === 'revealed' && (
                <span style={styles.note} data-testid="openlux-market-custom-revealed">
                  {t('customOpenRevealed')}
                </span>
              )}
              {handoff === 'nothing' && (
                <span style={styles.refusal} data-testid="openlux-market-custom-openfailed">
                  {t('customOpenFailed')}
                </span>
              )}
              <span style={styles.note}>
                {t('customBody')}
                {' '}
                <button
                  type="button"
                  style={{
                    border: 0, background: 'transparent', padding: 0, cursor: 'pointer',
                    color: 'var(--dsw-alias-label-secondary)', textDecoration: 'underline',
                    fontSize: 'inherit',
                  }}
                  data-testid="openlux-market-custom-open"
                  onClick={onOpenFile}
                >
                  {t('customOpen')}
                </button>
              </span>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

/** What the outcome dialog needs. */
export interface MarketOutcomeProps {
  readonly item: CatalogItem | undefined
  readonly outcome: InstallOutcome | undefined
  /**
   * Which partition installed, because "where it went and what to do next" is
   * the whole content of a success and the two answers differ: a preset is
   * picked when starting a session and managed on the kernel's own page, while a
   * skill is loaded by the model on its own and lives in a watched directory.
   */
  readonly partition?: 'expert' | 'skill' | 'connector'
  readonly t: T
  readonly onClose: () => void
}

/**
 * Render what the host answered.
 * @param props - the row and the outcome.
 * @returns the dialog, or null when there is nothing to report.
 */
export function MarketOutcome(props: MarketOutcomeProps): ReactNode {
  const { item, outcome, partition = 'expert', t, onClose } = props
  if (item === undefined || outcome === undefined) return null
  const refused = outcome.kind === 'refused'

  return (
    <Modal
      open
      onClose={onClose}
      title={refused
        ? t('refusedTitle')
        : t(partition === 'connector' ? 'connectedTitle' : 'installedTitle')}
      closeLabel={t('installedDone')}
      footer={(
        <div style={styles.footer}>
          <Button variant="primary" data-testid="openlux-market-outcome-done" onClick={onClose}>
            {t('installedDone')}
          </Button>
        </div>
      )}
    >
      <div style={styles.body} data-testid="openlux-market-outcome">
        {outcome.kind === 'installed' && (
          <>
            <span style={styles.note}>
              {t(installedBodyKey(partition), { name: item.name, path: outcome.path })}
            </span>
            {/* Named only when some skill did not come down: a partial install is
                still an install, and the persona will keep advertising the skill
                that is missing, so the gap has to be visible here rather than
                only in the log. */}
            {outcome.skills !== undefined && outcome.skills.installed < outcome.skills.total && (
              <span style={styles.refusal}>
                {t('installedSkillsPartial', {
                  installed: String(outcome.skills.installed),
                  total: String(outcome.skills.total),
                })}
              </span>
            )}
            <span style={styles.path}>{outcome.path}</span>
          </>
        )}
        {refused && (
          <>
            <span style={styles.refusal}>{t(`refused-${outcome.reason}`)}</span>
            {/* The host's own sentence, kept verbatim: it names which of the
                five refusals happened and, where it matters, the value that
                caused it. */}
            <span style={styles.note}>{outcome.message}</span>
          </>
        )}
      </div>
    </Modal>
  )
}
