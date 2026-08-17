/** OpenLux sign-in, mounted as one step of the shell's first-run queue. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, OnboardingSurface } from '@deepseek-ai/dsh-client-ui-primitives'
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
}

/**
 * Render the sign-in takeover until the account is usable.
 * @param props - the coordinator's owner share for the active step.
 * @returns the takeover surface, or null once this step is done.
 */
export function SignInStep(props: PropsRuntime<'settings.onboarding'> & SignInStepInjected): ReactNode {
  const { complete, callHost } = props
  const [finished, setFinished] = useState(false)
  const [hostReply, setHostReply] = useState('联系宿主中…')
  // `complete` hands the queue to the next entry; a second call would advance
  // it past a step that never rendered.
  const called = useRef(false)
  const finish = useCallback((): void => {
    if (called.current) return
    called.current = true
    setFinished(true)
    complete()
  }, [complete])

  useEffect(() => {
    let live = true
    void (async () => {
      const result = await callHost<{ codeword: string; note: string; credentialsAvailable: boolean }>(
        'ping',
        { note: '来自登录步' },
      )
      if (!live) return
      setHostReply(result.ok
        ? `宿主应答 ${result.value.codeword}，回声「${result.value.note}」，`
          + `凭据服务${result.value.credentialsAvailable ? '在' : '缺席'}`
        : `宿主调用失败 ${result.error.code}：${result.error.message}`)
    })()
    return () => { live = false }
  }, [callHost])

  if (finished) return null

  return (
    <OnboardingSurface>
      <div data-testid={SIGN_IN_ID} style={{ padding: '32px', textAlign: 'center' }}>
        <h2>登录 OpenLux</h2>
        <p>骨架占位：本步来自 openlux-plugin-account，尚未接入登录表单。</p>
        <p data-testid="openlux-host-probe">{hostReply}</p>
        <Button variant="primary" onClick={finish}>先跳过</Button>
      </div>
    </OnboardingSurface>
  )
}
