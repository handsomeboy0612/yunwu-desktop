/**
 * OpenLux account plugin, browser half: sign-in as one entry in the shell's
 * first-run queue, and the account row at the sidebar foot.
 *
 * Both surfaces share one store, because each can change what the other
 * shows — signing in from the step lights up the row, signing out from the row
 * brings the page back.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
// Type-only: merges the settings shell's slot rows, including
// 'settings.onboarding', into the SlotMap this file registers against.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: same, for the sidebar's 'sidebar.footer.action'.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: merges the locale plugin's `ctx.locale`.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ACCOUNT_ACTION_ID, AccountAction } from './AccountAction.tsx'
import type { AccountActionInjected } from './AccountAction.tsx'
import { callAccountHost } from './host.ts'
import { en, zh, type AccountKey } from './locales.ts'
import { SIGN_IN_ORDER, SIGN_IN_STEP_ID, SignInStep } from './SignInStep.tsx'
import type { SignInStepInjected } from './SignInStep.tsx'
import { AccountStore } from './store.ts'

export { ACCOUNT_ACTION_ID, AccountAction } from './AccountAction.tsx'
export type { AccountActionInjected } from './AccountAction.tsx'
export { SIGN_IN_ID } from './SignInForm.tsx'
export { SIGN_IN_ORDER, SIGN_IN_STEP_ID, SignInStep } from './SignInStep.tsx'
export type { SignInStepInjected } from './SignInStep.tsx'
export { AccountStore } from './store.ts'
export type { AccountView, Balance, BalanceStatus } from './store.ts'
export type { AccountKey } from './locales.ts'
export type { AccountHostCaller } from './types.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sign-in, challenge, and account-row copy. */
    'openlux.account': AccountKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'openlux.account'

/**
 * Required services. Both target slots are declared by other plugins whose
 * activation order relative to this one is not constrained, so each
 * registration waits on its slot through `slots.inject()`.
 */
export const inject = ['slots', 'connection', 'locale']

/**
 * Register the sign-in step and the sidebar account row.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'openlux-account: copy dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  const callHost: AccountActionInjected['callHost'] =
    (method, args, signal) => callAccountHost(connection, method, args, signal)
  const store = new AccountStore(callHost)
  const useAccount = bindSnapshotSelector(store) as AccountActionInjected['useAccount']
  // One bound translate for every face; copy freshness rides the locale
  // revision rather than a re-registration.
  const t = ctx.locale.bind(NS) as SignInStepInjected['t']

  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding',
    id: SIGN_IN_STEP_ID,
    order: SIGN_IN_ORDER,
    inject: (): SignInStepInjected => ({ callHost, t, store }),
  }, SignInStep))

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: ACCOUNT_ACTION_ID,
    inject: (): AccountActionInjected => ({ callHost, t, store, useAccount }),
  }, AccountAction))
}
