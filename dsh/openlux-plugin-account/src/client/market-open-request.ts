/**
 * Open-the-market requests from faces that cannot hold the overlay's store.
 *
 * The composer's connector capsule opens the market *on the connector tab*,
 * but it cannot take the overlay's store handle: the capsule sits in a
 * session-scoped slot and the store is already mounted under root-scoped
 * ones, and the kernel enforces one scope per handle («store handle mounted
 * under "conversation.input.left" (scope "session") is already mounted under
 * scope "root"» — the loader refused the whole plugin). So the capsule
 * publishes here, and the always-mounted `MarketOverlay` — which does own the
 * store — subscribes and opens itself.
 *
 * The tab half is take-once: `MarketSection` owns its tab state locally and
 * consumes the request when it mounts (the overlay unmounts its section on
 * close, so every open reads fresh). Take-once keeps a stale request from
 * re-aiming a later open that came from the sidebar launcher.
 *
 * @module openlux-plugin-account/client/market-open-request
 */

import type { CatalogType } from '../market/wire.ts'

let requested: CatalogType | undefined
const watchers = new Set<() => void>()

/**
 * Ask the market to open on this tab.
 * @param tab - the partition to show.
 */
export function requestMarketOpen(tab: CatalogType): void {
  requested = tab
  for (const notify of [...watchers]) notify()
}

/**
 * Watch for open requests; the overlay's store owner answers them.
 * @param watcher - called on each {@link requestMarketOpen}.
 * @returns the unsubscribe.
 */
export function watchMarketOpen(watcher: () => void): () => void {
  watchers.add(watcher)
  return () => { watchers.delete(watcher) }
}

/**
 * Consume the pending tab request.
 * @returns the requested tab, or undefined when nobody asked.
 */
export function takeMarketTab(): CatalogType | undefined {
  const tab = requested
  requested = undefined
  return tab
}
