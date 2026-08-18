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
import { en as marketEn, zh as marketZh, type MarketKey } from './market-locales.ts'
import { MARKET_SECTION_ID, MARKET_SECTION_ORDER, MarketSection } from './MarketSection.tsx'
import type { MarketSectionInjected } from './MarketSection.tsx'
import { SIGN_IN_ORDER, SIGN_IN_STEP_ID, SignInStep } from './SignInStep.tsx'
import type { SignInStepInjected } from './SignInStep.tsx'
import { AccountStore } from './store.ts'
import { SummonController, type SummonRequest } from './summon.ts'

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
    /** Market gallery copy. */
    'openlux.market': MarketKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'openlux.account'

/** The market section's own namespace; a nav label is read outside the section. */
const MARKET_NS = 'openlux.market'

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
  ctx.effect(() => ctx.locale.register(MARKET_NS, { zh: marketZh, en: marketEn }), 'openlux-market: copy dictionaries')
  const marketText = ctx.locale.bind(MARKET_NS)

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

  // Summoning needs the conversation flow, which only exists in the advanced
  // desktop composition; the binding is filled while that scope lives and the
  // section simply offers install-only copy while it is absent. Same shape as
  // the kernel's own creator-draft entry (`ui-agent-preset`).
  let summon: ((request: SummonRequest) => void) | undefined

  ctx.inject(['sessions', 'workspaces'], (scope: ClientContext) => {
    const controller = new SummonController(scope)
    scope.effect(() => {
      // The pick may predate the session that takes it: the workspace connect
      // either creates a blank session or reuses one, and nothing hands back
      // its id — so the request is applied by whoever sees the list change.
      const stop = scope.sessions.list.subscribe(() => { void controller.apply() })
      summon = (request: SummonRequest) => { controller.summon(request) }
      return () => {
        summon = undefined
        stop()
      }
    }, 'openlux-market: summon flow')
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: MARKET_SECTION_ID,
    order: MARKET_SECTION_ORDER,
    // A thunk rather than a string: the shell re-resolves nav labels on locale
    // change instead of subscribing to it (`ui-settings-general`).
    label: () => marketText('nav'),
    locale: MARKET_NS,
    inject: (): MarketSectionInjected => ({
      callHost,
      language: () => (ctx.locale.getSnapshot().active === 'en' ? 'en' : 'zh'),
      // Read per render rather than captured: the binding follows the
      // conversation scope's lifetime, not this section's.
      ...summon === undefined ? {} : { summon },
    }),
  }, MarketSection))
}
