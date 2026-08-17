/**
 * OpenLux account plugin, browser half: registers sign-in as one entry in the
 * shell's first-run queue.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: merges the settings shell's slot rows, including
// 'settings.onboarding', into the SlotMap this file registers against.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { SIGN_IN_ID, SIGN_IN_ORDER, SignInStep } from './SignInStep.tsx'

export { SIGN_IN_ID, SIGN_IN_ORDER, SignInStep } from './SignInStep.tsx'

/**
 * Required services. The onboarding slot is declared by the settings shell,
 * whose activation order relative to this plugin is not constrained, so the
 * registration itself waits on the slot through `slots.inject()`.
 */
export const inject = ['slots']

/**
 * Register the sign-in step once its slot reaches the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding',
    id: SIGN_IN_ID,
    order: SIGN_IN_ORDER,
  }, SignInStep))
}
