import { defineStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Shared open/closed state for the sidebar trigger and frame overlay. */
export interface AutomationView {
  readonly open: boolean
}

export function createAutomationViewStore() {
  return defineStore({
    init: (): AutomationView => ({ open: false }),
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

export type AutomationViewStore = ReturnType<typeof createAutomationViewStore>
