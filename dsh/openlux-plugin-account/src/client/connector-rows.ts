/**
 * What one connector row shows, decided away from the component.
 *
 * The card's own state enum carries localized sentences, so the choice between
 * "connected", "did not come up" and "busy" would otherwise be made inside a
 * `.tsx` where nothing can reach it. It is a small decision with three inputs
 * and one non-obvious rule (a repair in flight outranks a failure), which is
 * exactly the kind that is worth being able to assert on.
 */

import type { InstalledConnector } from '../market/wire.ts'

/** How one connected row reads right now. */
export interface ConnectorRow {
  readonly kind:
    /** Mounted and serving tools. */
    | 'connected'
    /** Recorded but not mounted; the card shows why. */
    | 'offline'
    /** Something is being done to it, and the row says so instead. */
    | 'working'
  /**
   * Whether the row offers to put it back together in place.
   *
   * Only a dead web sign-in can be repaired: everything else that stops a
   * connector — a command that is gone, a namespace collision, a token dropped
   * from the seam — is fixed somewhere other than this row.
   */
  readonly repairable: boolean
}

/**
 * Read one row's state.
 * @param connected - what the host says about it, or undefined when the
 *   connector is not connected at all.
 * @param busy - whether this row is the one with an operation in flight.
 * @returns the row, or undefined when there is nothing connected to describe.
 */
export function connectorRow(
  connected: Pick<InstalledConnector, 'live' | 'needsAuthorization'> | undefined,
  busy: boolean,
): ConnectorRow | undefined {
  if (connected === undefined) return undefined
  const repairable = connected.needsAuthorization === true
  // Busy wins over the failure it is trying to fix. Without this the row would
  // keep showing "did not connect" and its button through the minutes the
  // browser has the user, and a second press would start a second sign-in.
  if (busy) return { kind: 'working', repairable: false }
  return { kind: connected.live ? 'connected' : 'offline', repairable }
}
