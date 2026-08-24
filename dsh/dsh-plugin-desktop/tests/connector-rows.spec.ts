/**
 * Which connector rows offer to sign in again.
 *
 * The button itself lives in a `.tsx` with no DOM harness in this package, so
 * the decision it renders is asserted here instead — the same split the
 * expert rows use. What is worth pinning is the ranking: a repair in flight
 * has to outrank the failure it is fixing, or the row keeps its button through
 * the minutes the browser has the user and a second press starts a second
 * sign-in.
 */

import { describe, expect, it } from 'vitest'
import { connectorRow } from '../../openlux-plugin-account/src/client/connector-rows.ts'

describe('connector rows', () => {
  it('has nothing to say about a connector that is not connected', () => {
    expect(connectorRow(undefined, false)).toBeUndefined()
  })

  it('offers no repair for a healthy row, or for one broken by something else', () => {
    expect(connectorRow({ live: true }, false)).toEqual({ kind: 'connected', repairable: false })
    // A command that is gone is fixed by disconnecting, not by signing in.
    expect(connectorRow({ live: false }, false)).toEqual({ kind: 'offline', repairable: false })
  })

  it('offers the repair only for a dead sign-in', () => {
    expect(connectorRow({ live: false, needsAuthorization: true }, false))
      .toEqual({ kind: 'offline', repairable: true })
  })

  it('reads as busy while the repair runs, and takes the button away', () => {
    expect(connectorRow({ live: false, needsAuthorization: true }, true))
      .toEqual({ kind: 'working', repairable: false })
  })
})
