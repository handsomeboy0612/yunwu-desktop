/**
 * The filter behind «我的专家».
 *
 * Its own module because it is one judgement about somebody else's state, and
 * it is silent when wrong: a missed `itemId` turns the page into a list of
 * downloads. This package's test suite runs on node with no DOM
 * (`vitest.config.ts`), so a rule worth asserting has to live where a test can
 * import it without rendering a component.
 *
 * @module openlux-plugin-account/client/expert-rows
 */

import type { InstalledPreset } from '../market/wire.ts'

/**
 * The experts this person wrote, as opposed to the ones they downloaded.
 *
 * Two conditions, each deferring to an owner that already knows. `user` trust
 * is the kernel's line between a composition that shipped with the deployment
 * (`standard`, `code`, `cordis`) and one that someone put here — «a `user`
 * preset was authored locally, by a person or by an agent». `itemId` is ours:
 * an install writes `openlux-market.json` beside the composition
 * (`market/install.ts`), so a row carrying one came from the catalog and
 * belongs on the catalog's card, not on this page.
 * @param installed - the roster as the host described it.
 * @returns the authored rows, roster order.
 */
export function createdExperts(
  installed: readonly InstalledPreset[],
): readonly InstalledPreset[] {
  return installed.filter(preset => preset.trust === 'user' && preset.itemId === undefined)
}
