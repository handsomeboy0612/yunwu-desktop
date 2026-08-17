/**
 * Sign-in as one entry in the shell's first-run queue.
 *
 * This file is only the readiness decision; the page itself is `SignInForm`,
 * because the sidebar mounts the same page after a sign-out.
 *
 * The step decides its own applicability, the way every kernel onboarding
 * entry does: if a usable key is already on this machine — signed in earlier,
 * typed into the Models page, or supplied through the environment — it
 * completes without drawing anything and the queue moves on. Only the host can
 * ask the credential store, so the decision waits on it and paints nothing
 * meanwhile, which the slot contract explicitly allows.
 *
 * Worth knowing about the queue: it is not first-run-only. The coordinator
 * arms it whenever the current session is blank and clears its completed set
 * every time that stops being true (`ui-settings-general/src/client/
 * SettingsRoot.tsx:122-133`), so a user who signs out, opens a session, and
 * comes back to an empty one meets this step again on its own.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SignInForm } from './SignInForm.tsx'
import type { AccountKey } from './locales.ts'
import type { AccountStore } from './store.ts'
import type { AccountHostCaller } from './types.ts'

export { SIGN_IN_ID } from './SignInForm.tsx'

/**
 * Between the shell's own versioned notice (-100) and its credential prompt
 * (0), both registered by `dsh-client-ui-settings-models`. Signing in writes
 * the credential the later step looks for, so it must run first, and once it
 * has, that step completes without rendering.
 */
export const SIGN_IN_ORDER = -50

/** Slot id for the onboarding registration. */
export const SIGN_IN_STEP_ID = 'openlux-sign-in'

/** What this step needs from the plugin body. */
export interface SignInStepInjected {
  /** Calls the host half, which owns requests a browser origin cannot make. */
  readonly callHost: AccountHostCaller
  /** Bound translate for this package's namespace. */
  readonly t: (key: AccountKey) => string
  /** Shared account state, so signing in here lights up the sidebar. */
  readonly store: AccountStore
}

/**
 * Decide whether sign-in is needed, and show the page if it is.
 * @param props - the coordinator's owner share for the active step.
 * @returns the takeover, or null once this step is settled.
 */
export function SignInStep(props: PropsRuntime<'settings.onboarding'> & SignInStepInjected): ReactNode {
  const { complete, callHost, t, store } = props
  const [needed, setNeeded] = useState<boolean | undefined>(undefined)

  // `complete` hands the queue to the next entry; a second call would advance
  // it past a step that never rendered.
  const called = useRef(false)
  const live = useRef(true)
  useEffect(() => () => { live.current = false }, [])

  const finish = useCallback((): void => {
    if (called.current) return
    called.current = true
    setNeeded(false)
    complete()
  }, [complete])

  useEffect(() => {
    void (async () => {
      const status = await callHost<{ apiKeyConfigured: boolean }>('status', {})
      if (!live.current) return
      if (status.ok && status.value.apiKeyConfigured) {
        finish()
        return
      }
      setNeeded(true)
    })()
  }, [callHost, finish])

  if (needed !== true) return null

  return (
    <SignInForm
      callHost={callHost}
      t={t}
      onSignedIn={() => {
        void store.signedIn()
        finish()
      }}
      onDismiss={finish}
    />
  )
}
