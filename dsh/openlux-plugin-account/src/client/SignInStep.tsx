/**
 * OpenLux sign-in, mounted as one step of the shell's first-run queue.
 *
 * The step decides its own applicability, the way every kernel onboarding
 * entry does: if a usable key is already on this machine — signed in earlier,
 * typed into the Models page, or supplied through the environment — it
 * completes without drawing anything, and the queue moves on. That check is
 * the host's, because only the host can ask the credential store.
 *
 * The console forces a human check before it will look at a password, so the
 * challenge is not an escalation after a failed attempt: pressing sign-in
 * opens it first, and the token it yields rides along with the credentials.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Input, OnboardingSurface } from '@deepseek-ai/dsh-client-ui-primitives'
import { Captcha, type CaptchaType } from './Captcha.tsx'
import type { AccountKey } from './locales.ts'
import type { AccountHostCaller } from './types.ts'

/**
 * Between the shell's own versioned notice (-100) and its credential prompt
 * (0), both registered by `dsh-client-ui-settings-models`. Signing in writes
 * the credential the later step looks for, so it must run first, and once it
 * has, that step completes without rendering.
 */
export const SIGN_IN_ORDER = -50

/** Slot id; also the DOM marker the live checks look for. */
export const SIGN_IN_ID = 'openlux-sign-in'

/** What this step needs from the plugin body. */
export interface SignInStepInjected {
  /** Calls the host half, which owns requests a browser origin cannot make. */
  readonly callHost: AccountHostCaller
  /** Bound translate for this package's namespace. */
  readonly t: (key: AccountKey) => string
}

interface AccountStatus {
  readonly signedIn: boolean
  readonly apiKeyConfigured: boolean
}

interface CaptchaConfig {
  readonly enabled: boolean
  readonly type: CaptchaType
}

type SignInReply =
  | { readonly kind: 'ok'; readonly userId: number; readonly username: string }
  | { readonly kind: 'rejected'; readonly message: string; readonly needCaptcha: boolean }
  | { readonly kind: 'failed'; readonly message: string }

const styles = {
  // The stage stretches its child and leaves the vertical rhythm to the step
  // (`ui-primitives/src/OnboardingSurface.module.css`), so the card centers
  // itself in the height it was handed.
  card: {
    display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '16px',
    width: '340px', padding: '32px', textAlign: 'center',
  },
  title: { margin: 0, color: 'var(--dsw-alias-label-primary)', fontSize: '20px', fontWeight: 600 },
  description: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '13px', lineHeight: 1.5 },
  form: { display: 'flex', flexDirection: 'column', gap: '10px', textAlign: 'left' },
  label: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
  error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', minHeight: '16px', textAlign: 'left' },
  footer: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: 1.5, margin: 0 },
} satisfies Record<string, CSSProperties>

/**
 * Render the sign-in takeover until the account is usable.
 * @param props - the coordinator's owner share for the active step.
 * @returns the takeover surface, or null once this step is done.
 */
export function SignInStep(props: PropsRuntime<'settings.onboarding'> & SignInStepInjected): ReactNode {
  const { complete, callHost, t } = props

  const [ready, setReady] = useState(false)
  const [finished, setFinished] = useState(false)
  const [captcha, setCaptcha] = useState<CaptchaConfig>({ enabled: false, type: 'slide-basic' })
  const [showChallenge, setShowChallenge] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // `complete` hands the queue to the next entry; a second call would advance
  // it past a step that never rendered.
  const called = useRef(false)
  const live = useRef(true)
  useEffect(() => () => { live.current = false }, [])

  const finish = useCallback((): void => {
    if (called.current) return
    called.current = true
    setFinished(true)
    complete()
  }, [complete])

  useEffect(() => {
    void (async () => {
      const [status, config] = await Promise.all([
        callHost<AccountStatus>('status', {}),
        callHost<CaptchaConfig>('captcha.config', {}),
      ])
      if (!live.current) return
      if (status.ok && status.value.apiKeyConfigured) {
        finish()
        return
      }
      // An unreadable console must not lock the user out of their own app: the
      // form still opens, and sign-in will report whatever goes wrong then.
      if (config.ok) setCaptcha(config.value)
      setReady(true)
    })()
  }, [callHost, finish])

  const attempt = useCallback(async (captchaToken?: string): Promise<void> => {
    setBusy(true)
    setError('')
    const result = await callHost<SignInReply>('sign-in', {
      username,
      password,
      ...captchaToken === undefined ? {} : { captchaToken },
    })
    if (!live.current) return
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    if (result.value.kind === 'ok') {
      finish()
      return
    }
    setError(result.value.message)
  }, [callHost, username, password, finish])

  function onSubmit(event: React.FormEvent): void {
    event.preventDefault()
    if (busy) return
    if (username.trim() === '' || password === '') {
      setError(t('emptyFields'))
      return
    }
    // The token is one-shot and the console consumes it on the attempt, so
    // each try opens its own challenge rather than reusing the last one.
    if (captcha.enabled) {
      setError('')
      setShowChallenge(true)
      return
    }
    void attempt()
  }

  if (finished || !ready) return null

  return (
    <OnboardingSurface>
      <div style={styles.card} data-testid={SIGN_IN_ID}>
        {showChallenge ? (
          <Captcha
            callHost={callHost}
            type={captcha.type}
            t={t}
            onPassed={token => {
              setShowChallenge(false)
              void attempt(token)
            }}
            onCancel={() => setShowChallenge(false)}
          />
        ) : (
          <>
            <h2 style={styles.title}>{t('title')}</h2>
            <p style={styles.description}>{t('description')}</p>
            <form style={styles.form} onSubmit={onSubmit}>
              <label style={styles.label} htmlFor="openlux-account">{t('account')}</label>
              <Input
                id="openlux-account"
                name="username"
                autoComplete="username"
                autoFocus
                disabled={busy}
                placeholder={t('accountPlaceholder')}
                value={username}
                onChange={event => setUsername(event.target.value)}
              />
              <label style={styles.label} htmlFor="openlux-password">{t('password')}</label>
              <Input
                id="openlux-password"
                name="password"
                type="password"
                autoComplete="current-password"
                disabled={busy}
                placeholder={t('passwordPlaceholder')}
                value={password}
                onChange={event => setPassword(event.target.value)}
              />
              <div style={styles.error} role="alert" data-testid="openlux-sign-in-error">{error}</div>
              <Button variant="primary" type="submit" disabled={busy}>
                {t(busy ? 'submitting' : 'submit')}
              </Button>
            </form>
            <p style={styles.footer}>{t('needAccount')}</p>
            {/*
              An escape hatch, not a dismissal: the kernel's own credential
              step follows this one and takes a key typed by hand, which is
              the way in when the console itself is unreachable.
            */}
            <Button variant="ghost" size="sm" disabled={busy} onClick={finish}>{t('later')}</Button>
          </>
        )}
      </div>
    </OnboardingSurface>
  )
}
