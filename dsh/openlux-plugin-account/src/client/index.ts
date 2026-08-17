/**
 * OpenLux account plugin, browser half: registers sign-in as one entry in the
 * shell's first-run queue and binds it to this package's host half.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: merges the settings shell's slot rows, including
// 'settings.onboarding', into the SlotMap this file registers against.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: merges the locale plugin's `ctx.locale`.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { callAccountHost } from './host.ts'
import { en, zh, type AccountKey } from './locales.ts'
import { SIGN_IN_ID, SIGN_IN_ORDER, SignInStep } from './SignInStep.tsx'
import type { SignInStepInjected } from './SignInStep.tsx'

export { SIGN_IN_ID, SIGN_IN_ORDER, SignInStep } from './SignInStep.tsx'
export type { SignInStepInjected } from './SignInStep.tsx'
export type { AccountKey } from './locales.ts'
export type { AccountHostCaller } from './types.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sign-in and challenge copy. */
    'openlux.account': AccountKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'openlux.account'

/**
 * Required services. The onboarding slot is declared by the settings shell,
 * whose activation order relative to this plugin is not constrained, so the
 * registration itself waits on the slot through `slots.inject()`.
 */
export const inject = ['slots', 'connection', 'locale']

/**
 * Register the sign-in step once its slot reaches the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'openlux-account: copy dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  // One bound translate for every face; copy freshness rides the locale
  // revision rather than a re-registration.
  const t = ctx.locale.bind(NS) as SignInStepInjected['t']
  const injected = (): SignInStepInjected => ({
    callHost: (method, args, signal) => callAccountHost(connection, method, args, signal),
    t,
  })

  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding',
    id: SIGN_IN_ID,
    order: SIGN_IN_ORDER,
    inject: injected,
  }, SignInStep))
}
