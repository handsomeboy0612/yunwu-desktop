/**
 * Process-wide snapshot of what is connected, for faces outside the market.
 *
 * The composer's connector capsule needs the same answer the market's
 * connector tab reads (`market.connectors`), but the two mount in different
 * slots and share no React tree. The market already keeps a module-level
 * snapshot for its own remount case (`marketProcessSnapshot`); this is the
 * same idea with a subscription, so the capsule updates the moment a connect
 * or disconnect lands instead of waiting for its next mount.
 *
 * @module openlux-plugin-account/client/connector-live
 */

import type { ConnectorTarget } from '../market/wire.ts'

let snapshot: ConnectorTarget | undefined
const watchers = new Set<() => void>()

/**
 * Publish a fresh read; every watcher is told.
 * @param target - what `market.connectors` answered.
 */
export function publishConnectorsLive(target: ConnectorTarget): void {
  snapshot = target
  for (const notify of [...watchers]) notify()
}

/** The last published read, or undefined before the first. */
export function connectorsLiveSnapshot(): ConnectorTarget | undefined {
  return snapshot
}

/**
 * Watch for publishes.
 * @param watcher - called after each {@link publishConnectorsLive}.
 * @returns the unsubscribe.
 */
export function watchConnectorsLive(watcher: () => void): () => void {
  watchers.add(watcher)
  return () => { watchers.delete(watcher) }
}
