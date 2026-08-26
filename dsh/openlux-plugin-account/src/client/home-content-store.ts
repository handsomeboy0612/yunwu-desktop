/** Browser-side home payload shared by the two blank-composer slot entries. */

import type { HomeContent } from '../market/wire.ts'
import type { AccountHostCaller } from './types.ts'

export interface HomeContentView {
  readonly read: boolean
  readonly fetching: boolean
  readonly content: HomeContent
  readonly selectedScene: string | undefined
  readonly message: string | undefined
}

const EMPTY_CONTENT: HomeContent = { scenes: [], showcases: [], playbooks: [] }
const EMPTY: HomeContentView = {
  read: false,
  fetching: false,
  content: EMPTY_CONTENT,
  selectedScene: undefined,
  message: undefined,
}

export class HomeContentStore {
  private view: HomeContentView = EMPTY
  private readonly listeners = new Set<() => void>()
  private reading: Promise<void> | undefined

  constructor(private readonly callHost: AccountHostCaller) {}

  getSnapshot = (): HomeContentView => this.view

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Revalidate once per blank-session mount; concurrent slot mounts share it. */
  load = (): Promise<void> => {
    this.reading ??= this.read().finally(() => { this.reading = undefined })
    return this.reading
  }

  selectScene = (slug: string | undefined): void => {
    this.commit({ ...this.view, selectedScene: slug })
  }

  private async read(): Promise<void> {
    this.commit({ ...this.view, fetching: true, message: undefined })
    const reply = await this.callHost<HomeContent>('market.home', {})
    if (reply.ok) {
      this.commit({
        read: true,
        fetching: false,
        content: reply.value,
        selectedScene: this.view.selectedScene,
        message: undefined,
      })
      return
    }
    this.commit({
      ...this.view,
      read: true,
      fetching: false,
      message: reply.error.message,
    })
  }

  private commit(next: HomeContentView): void {
    this.view = next
    for (const listener of this.listeners) listener()
  }
}
