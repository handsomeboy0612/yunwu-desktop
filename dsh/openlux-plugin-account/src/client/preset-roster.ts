/**
 * Which composition a plain session runs, and what the others are called.
 *
 * The hero chip needs two facts the session list cannot supply: which preset is
 * the deployment default (so a plain session says nothing at all), and what a
 * preset's display name is (a session row carries only the id). Both come from
 * the roster RPC — the same call the kernel's own seat makes, so this is a read
 * of the kernel's state rather than a second registry.
 *
 * ## Why a store rather than component state
 *
 * The read is async and the answer outlives any one mount: the hero unmounts on
 * every send and remounts on every new session, and re-fetching a roster that
 * changes only when someone installs a preset would put an RPC on that path for
 * nothing. The kernel's seat controller keeps its roster the same way.
 *
 * ## Two ways it goes stale, two ways back
 *
 * A preset installed after the last read is missing from `rows`, and the chip
 * would then name it by id. That one the chip repairs itself: it asks for a
 * reload when it meets an id it does not know, which is what the kernel's seat
 * does in the same situation (`sync()`: an unknown current preset falls through
 * to `load()`).
 *
 * The default moving is the other one, and nothing here can notice it —
 * choosing a default is a settings write, so the roster answer changes with no
 * preset call involved, and a stale default makes the chip name the very preset
 * a session is already on by default. So the plugin also subscribes to the
 * host's `settings/document-updated` for this namespace and calls `load()`,
 * which is exactly what the kernel's own seat does with it (`client/index.ts`).
 *
 * @module openlux-plugin-account/client/preset-roster
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Settings namespace the deployment default lives in.
 *
 * Stated rather than imported: the kernel publishes the same string as
 * `AGENT_PRESET_SETTINGS_NS` from its own browser half, and a client bundle may
 * not take values across plugins. It is also the document key on disk
 * (`~/.dsh/settings.yaml`'s `agent-presets`), so it is checkable without us.
 */
export const PRESET_SETTINGS_NS = 'agent-presets'

/** An RPC answer, in the two arms every caller here reads. */
type Reply<T> = {
  readonly result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } }
}

/** One roster row as the wire carries it (`api/agent-presets.d.ts`). */
interface WireRow {
  readonly id: string
  readonly trust: 'system' | 'user'
  readonly isDefault: boolean
  /** Display name from `preset.yml`, absent when it published none. */
  readonly name?: string
}

/**
 * The two roster RPCs, named structurally.
 *
 * The connection's `api` reaches a plugin without the agent-preset domain on its
 * type (the wire face is assembled host-side), so the calls are stated here
 * rather than left implicitly `any` — the same thing `summon.ts` does for the
 * composer face it takes out of the service registry.
 */
interface PresetsWire {
  readonly agentPresets: {
    list(request: Record<string, never>): Promise<Reply<{ readonly presets: readonly WireRow[] }>>
    select(request: { sessionId: SessionId; agentPreset: string }): Promise<Reply<unknown>>
  }
}

/** One preset, in the two facts the chip draws. */
export interface PresetRow {
  /** The preset's own display name, or its id when it published none. */
  readonly name: string
  /** `system` ships with the deployment; `user` was authored or installed here. */
  readonly trust: 'system' | 'user'
}

/** The roster as the chip reads it. */
export interface RosterView {
  /** False until the first read lands; the chip draws nothing before that. */
  readonly read: boolean
  /**
   * The composition a plain session runs — the one the chip stays silent about.
   * Undefined in a deployment that composes no presets.
   */
  readonly defaultId: string | undefined
  readonly rows: Readonly<Record<string, PresetRow>>
}

const EMPTY: RosterView = { read: false, defaultId: undefined, rows: {} }

/**
 * What the chip should say about a session, or nothing at all.
 *
 * Silent on the default because that is the whole point of the seat: the three
 * shipped compositions are the product's own plumbing, and a control naming one
 * of them invites a choice nobody should have to make. Silent before the first
 * read too — an id flashing into a name looks like a bug.
 *
 * A preset the roster has never heard of is named by its id rather than hidden:
 * the session really is running something other than the default, and saying
 * «something» while offering the way out is better than saying nothing.
 * @param view - the roster snapshot.
 * @param preset - the composition the current session runs, if any.
 * @returns the name to draw, or undefined to draw nothing.
 */
export function chipName(view: RosterView, preset: string | undefined): string | undefined {
  if (!view.read) return undefined
  if (preset === undefined || preset === '') return undefined
  if (preset === view.defaultId) return undefined
  return view.rows[preset]?.name ?? preset
}

/** Observable roster; one instance per plugin activation. */
export class PresetRoster {
  private view: RosterView = EMPTY
  private readonly listeners = new Set<() => void>()
  /** Set while a read is in flight, so a burst of asks makes one call. */
  private reading: Promise<void> | undefined

  constructor(private readonly connection: ConnectionHandle) {}

  /** The roster domain of the live connection's wire face. */
  private get wire(): PresetsWire {
    return this.connection.api as unknown as PresetsWire
  }

  /** Current snapshot; stable identity between changes, as uSES requires. */
  getSnapshot = (): RosterView => this.view

  /**
   * Subscribe to changes.
   * @param listener - called after every committed change.
   * @returns the unsubscriber.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Read the roster, unless a read is already running.
   * @returns once the snapshot reflects the host, or the failure was swallowed.
   */
  load = async (): Promise<void> => {
    this.reading ??= this.read().finally(() => { this.reading = undefined })
    await this.reading
  }

  /**
   * Put one session back on the deployment default.
   *
   * The kernel refuses a session that has already run a turn, which is not a
   * case this reaches: the chip lives on the new-session screen, and that screen
   * is gone once a conversation starts.
   * @param sessionId - the session to reset.
   * @returns the kernel's refusal when it refused, else undefined.
   */
  clear = async (sessionId: SessionId): Promise<string | undefined> => {
    const target = this.view.defaultId
    if (target === undefined) return undefined
    const reply = await this.wire.agentPresets.select({ sessionId, agentPreset: target })
    return reply.result.ok ? undefined : reply.result.error.message
  }

  /** One roster read. Failures leave the previous answer standing. */
  private async read(): Promise<void> {
    try {
      const reply = await this.wire.agentPresets.list({})
      if (!reply.result.ok) return
      const { presets } = reply.result.value
      const rows: Record<string, PresetRow> = {}
      for (const preset of presets) {
        rows[preset.id] = { name: preset.name ?? preset.id, trust: preset.trust }
      }
      this.set({ read: true, defaultId: presets.find(row => row.isDefault)?.id, rows })
    } catch {
      // Offline or mid-reconnect. The chip keeps whatever it had (nothing, on a
      // cold start), and asks again the next time it meets an unknown preset.
    }
  }

  /** Commit one snapshot and notify. */
  private set(view: RosterView): void {
    this.view = view
    for (const listener of this.listeners) listener()
  }
}
