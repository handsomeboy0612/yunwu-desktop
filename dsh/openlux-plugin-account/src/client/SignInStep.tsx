/** OpenLux sign-in, mounted as one step of the shell's first-run queue. */

import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, OnboardingSurface } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Between the shell's own versioned notice (-100) and its credential prompt
 * (0), both registered by `dsh-client-ui-settings-models`. Signing in writes
 * the credential the later step looks for, so it must run first, and once it
 * has, that step completes without rendering.
 */
export const SIGN_IN_ORDER = -50

/** Slot id; also the DOM marker the live checks look for. */
export const SIGN_IN_ID = 'openlux-sign-in'

/**
 * Render the sign-in takeover until the account is usable.
 * @param props - the coordinator's owner share for the active step.
 * @returns the takeover surface, or null once this step is done.
 */
export function SignInStep(props: PropsRuntime<'settings.onboarding'>): ReactNode {
  const { complete } = props
  const [finished, setFinished] = useState(false)
  // `complete` hands the queue to the next entry; a second call would advance
  // it past a step that never rendered.
  const called = useRef(false)
  const finish = useCallback((): void => {
    if (called.current) return
    called.current = true
    setFinished(true)
    complete()
  }, [complete])

  if (finished) return null

  return (
    <OnboardingSurface>
      <div data-testid={SIGN_IN_ID} style={{ padding: '32px', textAlign: 'center' }}>
        <h2>登录 OpenLux</h2>
        <p>骨架占位：本步来自 openlux-plugin-account，尚未接入登录表单。</p>
        <Button variant="primary" onClick={finish}>先跳过</Button>
      </div>
    </OnboardingSurface>
  )
}
