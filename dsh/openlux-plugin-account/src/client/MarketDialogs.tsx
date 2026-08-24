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

import type { CSSProperties, ReactNode } from 'react'
import { Button, Input, Modal, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CatalogItem, CustomConnectorSync, CustomOpen, InstallOutcome } from '../market/wire.ts'
import { describe } from './MarketCard.tsx'
import type { MarketKey } from './market-locales.ts'

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
} satisfies Record<string, CSSProperties>

/** What the detail dialog needs. */
export interface MarketDetailProps {
  readonly item: CatalogItem | undefined
  readonly language: 'zh' | 'en'
  readonly categoryName: string
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
  readonly onClose: () => void
}

/**
 * Render the detail dialog.
 * @param props - the row and its surroundings.
 * @returns the dialog, or null when nothing is selected.
 */
export function MarketDetail(props: MarketDetailProps): ReactNode {
  const {
    item, language, categoryName, t, onPrimary, summonable, blocked, installed, prompts, onClose,
  } = props
  if (item === undefined) return null
  const label = summonable ? t('summon') : t('install')

  return (
    <Modal
      open
      onClose={onClose}
      title={item.name}
      closeLabel={t('detailClose')}
      footer={(
        <div style={styles.footer}>
          <Button variant="ghost" onClick={onClose}>{t('detailClose')}</Button>
          {installed && !summonable && <span style={styles.note}>{t('installed')}</span>}
          {onPrimary !== undefined && (installed ? summonable : true) && (
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
        {summonable && onPrimary !== undefined && prompts.length > 0 && (
          <div style={styles.prompts}>
            <span style={styles.promptsLabel}>{t('detailPrompts')}</span>
            {prompts.map(prompt => (
              <button
                key={prompt}
                type="button"
                style={styles.prompt}
                data-testid="openlux-market-prompt"
                onClick={() => onPrimary(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>
        )}
        <div style={styles.rows}>
          <div style={styles.row}>
            <span style={styles.label}>{t('detailKind')}</span>
            <span style={styles.value}>{item.team ? t('kindTeam') : t('kindAgent')}</span>
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
          {item.tags.length > 0 && (
            <div style={styles.row}>
              <span style={styles.label}>{t('detailTags')}</span>
              <span style={{ ...styles.value, ...styles.tags }}>
                {item.tags.map(tag => <Pill key={tag}>{tag}</Pill>)}
              </span>
            </div>
          )}
        </div>
      </div>
    </Modal>
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
  /** The last re-read, absent until one has happened. */
  readonly sync?: CustomConnectorSync
  readonly busy: boolean
  /** What the OS did with the file, absent until the opener was pressed. */
  readonly handoff?: CustomOpen['did']
  readonly t: T
  readonly onOpenFile: () => void
  readonly onReload: () => void
  readonly onClose: () => void
}

/**
 * The user's own MCP servers.
 *
 * Two buttons and a list of complaints, because the servers themselves are
 * managed in a file the user edits — WorkBuddy's «自定义连接器» opens the MCP
 * config in its host editor and shows no cards for what is in it either. What
 * this adds over the bare file is the part a text editor cannot tell you:
 * whether what you wrote actually started, and what it said if it did not.
 * @param props - the last re-read and the three actions.
 * @returns the dialog, or null while closed.
 */
export function CustomConnector(props: CustomConnectorProps): ReactNode {
  const { open, sync, busy, handoff, t, onOpenFile, onReload, onClose } = props
  if (!open) return null

  return (
    <Modal
      open
      onClose={onClose}
      title={t('customTitle')}
      closeLabel={t('closeMarket')}
      footer={(
        <div style={styles.footer}>
          <Button
            variant="ghost"
            disabled={busy}
            data-testid="openlux-market-custom-open"
            onClick={onOpenFile}
          >
            {t('customOpen')}
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            data-testid="openlux-market-custom-reload"
            onClick={onReload}
          >
            {busy ? t('customReloading') : t('customReload')}
          </Button>
        </div>
      )}
    >
      <div style={styles.body}>
        <span style={styles.note}>{t('customBody')}</span>
        {/*
          The path is always worth showing — it is what the user needs whatever
          the OS did — but the two lesser outcomes each need a sentence, or the
          button looks like it did nothing. Revealed is not a failure, so it is
          not coloured like one.
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
        {(handoff !== undefined || sync !== undefined) && (
          <span style={styles.path} data-testid="openlux-market-custom-path">
            {sync?.path ?? ''}
          </span>
        )}
        {sync !== undefined && (
          <span style={styles.note} data-testid="openlux-market-custom-live">
            {t('customLive', { count: sync.live })}
          </span>
        )}
        {sync?.problems.map(problem => (
          <span key={problem} style={styles.refusal} data-testid="openlux-market-custom-problem">
            {problem}
          </span>
        ))}
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
