import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type {
  HostObservable,
  InjectFace,
  PropsLocale,
  PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { AccountHostCaller } from './types.ts'

export const SESSION_DELETE_CONFIRM_ID = 'openlux-session-delete-confirm'
export const SESSION_DELETE_CONFIRM_ORDER = 8

/** One pending row-menu delete request (kernel patch hands it over via the window hook). */
export interface SessionDeleteRequest {
  readonly id: string
  readonly title: string
}

export interface SessionDeleteConfirmInjected {
  readonly callHost: AccountHostCaller
  readonly dismiss: () => void
  /**
   * Clear the client's selection when the target is the current session, so
   * the conversation view stops touching it before the host disposes it
   * (mirrors WorkBuddy: deleting the open conversation lands on the blank view).
   */
  readonly releaseCurrent: (sessionId: string) => void
  readonly hooks: {
    readonly deleteRequest: HostObservable<SessionDeleteRequest | undefined>
  }
}

/**
 * The confirm card behind the kernel sidebar's row-menu 删除 item. The menu
 * item itself lives in a two-line kernel patch (`dsh-client-ui-workspace`);
 * everything the user can act on — confirmation, the host call, errors —
 * stays in this plugin.
 */
export function SessionDeleteConfirm(
  props: PropsRuntime<'shell.overlay'>
    & PropsLocale<'openlux.sessions'>
    & InjectFace<SessionDeleteConfirmInjected>,
): ReactNode {
  const { useDeleteRequest, callHost, dismiss, releaseCurrent, t } = props
  const request = useDeleteRequest(value => value)
  const [deleting, setDeleting] = useState(false)
  const [failure, setFailure] = useState<string>()

  useEffect(() => {
    setDeleting(false)
    setFailure(undefined)
  }, [request?.id])

  useEffect(() => {
    if (request === undefined) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      dismiss()
    }
    document.addEventListener('keydown', onKeyDown, { capture: true })
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [dismiss, request])

  if (request === undefined) return null

  const remove = async (): Promise<void> => {
    setDeleting(true)
    setFailure(undefined)
    try {
      releaseCurrent(request.id)
      const result = await callHost('automations.deleteSession', { sessionId: request.id })
      if (!result.ok) throw new Error(result.error.message)
      dismiss()
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
      setDeleting(false)
    }
  }

  const title = request.title === '' ? t('untitled') : request.title

  return (
    <div
      style={styles.root}
      role="dialog"
      aria-modal="true"
      aria-label={t('deleteTitle')}
      data-testid="openlux-session-delete-confirm"
    >
      <button type="button" style={styles.mask} aria-label={t('cancel')} onClick={dismiss} />
      <section style={styles.card}>
        <strong style={styles.heading}>{t('deleteTitle')}</strong>
        <p style={styles.body}>{t('deleteBody', { name: title })}</p>
        {failure === undefined ? null : (
          <p style={styles.error} role="alert">{t('deleteFailed')}：{failure}</p>
        )}
        <div style={styles.actions}>
          <Button variant="outline" size="sm" disabled={deleting} onClick={dismiss}>
            {t('cancel')}
          </Button>
          <button
            type="button"
            style={styles.dangerButton}
            disabled={deleting}
            onClick={() => { void remove() }}
          >
            {deleting ? t('deleting') : t('confirmDelete')}
          </button>
        </div>
      </section>
    </div>
  )
}

const styles = {
  root: {
    position: 'fixed', inset: 0, zIndex: 1100, display: 'flex',
    alignItems: 'center', justifyContent: 'center', padding: '24px',
    pointerEvents: 'auto',
  },
  mask: {
    position: 'absolute', inset: 0, border: 0,
    background: 'var(--dsw-alias-bg-mask-1)',
    backdropFilter: 'var(--dsw-mask-blur)', cursor: 'pointer',
  },
  card: {
    position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column',
    gap: '10px', width: 'min(400px, 100%)', boxSizing: 'border-box',
    padding: '18px 20px',
    border: '1px solid var(--dsw-alias-border-inverted)', borderRadius: '16px',
    background: 'var(--dsw-alias-bg-layer-2)', boxShadow: 'var(--dsw-shadow-lv3)',
  },
  heading: { color: 'var(--dsw-alias-label-primary)', fontSize: '15px' },
  body: {
    margin: 0, color: 'var(--dsw-alias-label-secondary)',
    fontSize: '12px', lineHeight: 1.6, wordBreak: 'break-all',
  },
  error: {
    margin: 0, padding: '8px 10px', borderRadius: '8px',
    background: 'var(--dsw-alias-state-error-tertiary)',
    color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px',
  },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' },
  dangerButton: {
    padding: '5px 14px', border: 0, borderRadius: '10px', cursor: 'pointer',
    background: 'var(--dsw-alias-state-error-primary)',
    color: 'var(--dsw-alias-label-inverted)', fontSize: '12px',
  },
} satisfies Record<string, CSSProperties>
