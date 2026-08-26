import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { HomePlaybook, PlaybookArtifact } from '../market/wire.ts'
import type { HomeContentStore } from './home-content-store.ts'
import type { AccountHostCaller } from './types.ts'

export const HOME_SCENES_ID = 'openlux-home-scenes'
export const HOME_CASES_ID = 'openlux-home-cases'
export const HOME_SCENES_ORDER = 20
export const HOME_CASES_ORDER = 30

export interface HomeContentInjected {
  readonly hooks: { readonly homeContent: HomeContentStore }
  readonly load: () => void
  readonly selectScene: (slug: string | undefined) => void
  readonly callHost: AccountHostCaller
}

type HomeDockProps = PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'openlux.market'>
  & InjectFace<HomeContentInjected>

/** Scene and starter-prompt rows immediately above the blank composer. */
export function HomeScenesDock(props: HomeDockProps): ReactNode {
  const {
    session, inputActions, load, selectScene, t, useHomeContent,
  } = props
  const view = useHomeContent(value => value)
  useEffect(() => {
    if (session.blank) load()
  }, [load, session.blank])
  if (!session.blank) return null
  if (!view.read && view.fetching) {
    return <div style={styles.loading}>{t('homeLoading')}</div>
  }

  const selected = view.selectedScene
  const scene = selected === undefined
    ? undefined
    : view.content.scenes.find(item => item.slug === selected)
  const prompts = (scene?.prompts ?? view.content.scenes.flatMap(item => item.prompts)).slice(0, 4)
  if (view.content.scenes.length === 0 && prompts.length === 0) return null

  return (
    <div style={styles.scenesRoot} data-testid={HOME_SCENES_ID}>
      <div style={styles.sceneRow}>
        <button
          type="button"
          style={selected === undefined ? styles.sceneActive : styles.sceneChip}
          onClick={() => { selectScene(undefined) }}
        >
          {t('homeAllScenes')}
        </button>
        {view.content.scenes.map(item => (
          <button
            key={item.slug}
            type="button"
            style={selected === item.slug ? styles.sceneActive : styles.sceneChip}
            onClick={() => { selectScene(item.slug) }}
          >
            {item.name}
          </button>
        ))}
      </div>
      {prompts.length > 0 && (
        <div style={styles.promptGrid}>
          {prompts.map(prompt => (
            <button
              key={`${prompt.title}:${prompt.prompt}`}
              type="button"
              style={styles.prompt}
              title={prompt.prompt}
              onClick={() => { inputActions.setDraft(prompt.prompt) }}
            >
              <span style={styles.promptTitle}>{prompt.title || prompt.prompt}</span>
              {prompt.title !== '' && <span style={styles.promptBody}>{prompt.prompt}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Featured experts and practice cases; CSS order places this after InputBar. */
export function HomeCasesDock(props: HomeDockProps): ReactNode {
  const {
    session, inputActions, load, callHost, t, useHomeContent,
  } = props
  const view = useHomeContent(value => value)
  const [preview, setPreview] = useState<{ item: HomePlaybook; artifact: PlaybookArtifact }>()
  const [opening, setOpening] = useState<number>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (session.blank) load()
  }, [load, session.blank])
  const playbooks = useMemo(() => (
    view.selectedScene === undefined
      ? view.content.playbooks
      : view.content.playbooks.filter(item => item.sceneSlug === view.selectedScene)
  ), [view.content.playbooks, view.selectedScene])
  if (!session.blank || (!view.read && view.fetching)) return null
  if (view.content.showcases.length === 0 && view.content.playbooks.length === 0) return null

  const open = async (item: HomePlaybook): Promise<void> => {
    setOpening(item.id)
    setError(undefined)
    const reply = await callHost<PlaybookArtifact>('market.playbookArtifact', { id: item.id })
    setOpening(undefined)
    if (!reply.ok) {
      setError(t('homeOpenFailed', { message: reply.error.message }))
      return
    }
    if (reply.value.artifactType === 'link') {
      window.open(reply.value.url, '_blank', 'noopener,noreferrer')
      return
    }
    setPreview({ item, artifact: reply.value })
  }

  return (
    <div style={styles.casesRoot} data-testid={HOME_CASES_ID}>
      {view.content.showcases.length > 0 && (
        <section>
          <div style={styles.sectionTitle}>{t('homeFeatured')}</div>
          <div style={styles.cardRow}>
            {view.content.showcases.map(item => (
              <button
                key={item.slug}
                type="button"
                style={styles.showcase}
                onClick={() => { if (item.initPrompt !== '') inputActions.setDraft(item.initPrompt) }}
              >
                <Cover url={item.cover} />
                <span style={styles.cardCopy}>
                  <strong style={styles.cardTitle}>{item.title}</strong>
                  <span style={styles.cardSubtitle}>{item.subtitle || item.description}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      <section>
        <div style={styles.sectionLine}>
          <div style={styles.sectionTitle}>{t('homeCases')}</div>
          {view.content.stale === true && <span style={styles.cacheNote}>{t('homeCached')}</span>}
        </div>
        {playbooks.length === 0
          ? <div style={styles.empty}>{t('homeNoCases')}</div>
          : (
            <div style={styles.cardRow}>
              {playbooks.map(item => (
                <article key={item.slug} style={styles.caseCard}>
                  <button
                    type="button"
                    style={styles.casePreview}
                    disabled={opening === item.id}
                    title={t('homePreview')}
                    onClick={() => { void open(item) }}
                  >
                    <Cover url={item.cover} />
                  </button>
                  <span style={styles.cardCopy}>
                    <strong style={styles.cardTitle}>{item.title}</strong>
                    <span style={styles.cardSubtitle}>{item.subtitle || item.description}</span>
                  </span>
                  <button
                    type="button"
                    style={styles.useButton}
                    disabled={item.initPrompt === ''}
                    onClick={() => { inputActions.setDraft(item.initPrompt) }}
                  >
                    {t('homeUse')}
                  </button>
                </article>
              ))}
            </div>
          )}
      </section>
      {error !== undefined && <div style={styles.error}>{error}</div>}
      {preview !== undefined && (
        <Modal
          open
          onClose={() => { setPreview(undefined) }}
          title={preview.item.title}
          closeLabel={t('homeClose')}
          footer={(
            <Button variant="primary" onClick={() => setPreview(undefined)}>{t('homeClose')}</Button>
          )}
        >
          {preview.artifact.artifactType === 'video'
            ? (
              <video
                src={preview.artifact.url}
                controls
                autoPlay
                style={styles.artifact}
              />
            )
            : (
              <iframe
                src={preview.artifact.url}
                title={preview.item.title}
                sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
                referrerPolicy="no-referrer"
                style={styles.artifact}
              />
            )}
        </Modal>
      )}
    </div>
  )
}

function Cover({ url }: { readonly url: string }): ReactNode {
  return url === ''
    ? <span style={styles.coverFallback} aria-hidden="true" />
    : <img src={url} alt="" loading="lazy" style={styles.cover} />
}

const styles = {
  scenesRoot: {
    width: '100%', maxWidth: '780px', margin: '0 auto', display: 'flex',
    flexDirection: 'column', gap: '10px',
  },
  loading: {
    width: '100%', maxWidth: '780px', margin: '0 auto', color: 'var(--dsw-alias-label-tertiary)',
    fontSize: '12px', lineHeight: '18px', textAlign: 'center',
  },
  sceneRow: { display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: '8px' },
  sceneChip: {
    border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-secondary)', borderRadius: '999px', padding: '5px 12px',
    fontSize: '12px', lineHeight: '18px', cursor: 'pointer',
  },
  sceneActive: {
    border: '1px solid var(--dsw-alias-state-business-primary)',
    background: 'var(--dsw-alias-state-business-tertiary)',
    color: 'var(--dsw-alias-label-primary-bluish)', borderRadius: '999px', padding: '5px 12px',
    fontSize: '12px', lineHeight: '18px', cursor: 'pointer',
  },
  promptGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px' },
  prompt: {
    minWidth: 0, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)', borderRadius: '10px', padding: '9px 12px',
    cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: '2px',
  },
  promptTitle: { fontSize: '13px', fontWeight: 500, lineHeight: '19px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  promptBody: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px', lineHeight: '16px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  casesRoot: {
    order: 1, width: '100%', maxWidth: '780px', margin: '2px auto 0', display: 'flex',
    flexDirection: 'column', gap: '12px',
  },
  sectionLine: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
  sectionTitle: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', fontWeight: 500, lineHeight: '18px', marginBottom: '6px' },
  cacheNote: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px', lineHeight: '16px' },
  cardRow: { display: 'flex', gap: '10px', overflowX: 'auto', paddingBottom: '2px' },
  showcase: {
    flex: '0 0 190px', minWidth: 0, padding: 0, overflow: 'hidden', border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '10px', background: 'var(--dsw-alias-bg-base)', color: 'inherit', cursor: 'pointer', textAlign: 'left',
  },
  caseCard: {
    flex: '0 0 190px', minWidth: 0, overflow: 'hidden', border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '10px', background: 'var(--dsw-alias-bg-base)', display: 'flex', flexDirection: 'column',
  },
  casePreview: { width: '100%', height: '78px', padding: 0, border: 0, background: 'none', cursor: 'pointer' },
  cover: { width: '100%', height: '78px', objectFit: 'cover', display: 'block' },
  coverFallback: {
    width: '100%', height: '78px', display: 'block',
    background: 'linear-gradient(135deg, var(--dsw-alias-state-business-tertiary), var(--dsw-alias-interactive-bg-hover))',
  },
  cardCopy: { minWidth: 0, padding: '8px 10px 7px', display: 'flex', flexDirection: 'column', gap: '2px' },
  cardTitle: { color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: '18px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  cardSubtitle: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px', lineHeight: '16px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  useButton: {
    margin: '0 10px 9px', padding: '4px 8px', border: 0, borderRadius: '7px',
    background: 'var(--dsw-alias-state-business-tertiary)', color: 'var(--dsw-alias-label-primary-bluish)',
    fontSize: '11px', lineHeight: '16px', cursor: 'pointer',
  },
  empty: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: '18px' },
  error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', lineHeight: '18px' },
  artifact: { width: 'min(76vw, 960px)', height: 'min(68vh, 680px)', border: 0, borderRadius: '8px', display: 'block' },
} satisfies Record<string, CSSProperties>
