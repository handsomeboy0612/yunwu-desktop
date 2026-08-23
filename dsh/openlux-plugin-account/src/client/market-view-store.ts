/**
 * Open/closed state for the market overlay, shared by the sidebar launcher
 * and the frame overlay.
 *
 * Same seat the community-market shell uses (`defineStore` on a root-scoped
 * slot): one handle, two registrations, the framework caches one instance.
 * A React `useState` in either face would not be visible to the other.
 *
 * @module openlux-plugin-account/client/market-view-store
 */

import { defineStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Whether the market overlay is showing. */
export interface MarketView {
  readonly open: boolean
}

/**
 * Declare the overlay's store handle.
 * @returns the handle both slot registrations share.
 */
export function createMarketViewStore() {
  return defineStore({
    init: (): MarketView => ({ open: false }),
    actions: {
      open: (draft: { open: boolean }) => {
        draft.open = true
      },
      close: (draft: { open: boolean }) => {
        draft.open = false
      },
    },
  })
}

/** The handle type both faces receive as `useStore` / `actions`. */
export type MarketViewStore = ReturnType<typeof createMarketViewStore>
