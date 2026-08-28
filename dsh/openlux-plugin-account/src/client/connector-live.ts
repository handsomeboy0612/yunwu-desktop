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

/**
 * The connector the user last carried into a chat with 「去对话」.
 *
 * The composer capsule shows only this row (产品拍板 2026-08-28): the entry is
 * the proof that *that* connector rode along, not a standing advertisement for
 * the gallery. Module-level like the snapshot above — the press happens in the
 * market's tree, the capsule lives in the composer's, and they share no React
 * parent. Cleared never: the latest press wins, and a slug whose record is
 * gone simply stops matching, which hides the capsule again.
 */
let triedSlug: string | undefined
const triedWatchers = new Set<() => void>()

/**
 * Remember the 「去对话」 press, or withdraw it; every watcher is told.
 * @param slug - the connector carried into the chat, or undefined when the
 * capsule's toggle takes the reference back down (关掉=不引用,不是断开).
 */
export function publishTriedConnector(slug: string | undefined): void {
  triedSlug = slug
  for (const notify of [...triedWatchers]) notify()
}

/** The last carried connector's slug, or undefined before any press. */
export function triedConnectorSnapshot(): string | undefined {
  return triedSlug
}

/**
 * Watch for {@link publishTriedConnector}.
 * @param watcher - called after each publish.
 * @returns the unsubscribe.
 */
export function watchTriedConnector(watcher: () => void): () => void {
  triedWatchers.add(watcher)
  return () => { triedWatchers.delete(watcher) }
}
