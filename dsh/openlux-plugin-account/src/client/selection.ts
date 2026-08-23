/**
 * Which model a session will run its next turn on, read from the browser.
 *
 * The kernel keeps this in one place — `ctx.modelDirectories`, the per-session
 * store the composer's picker and the `/model` popup both render from, so
 * reading it here is reading exactly what the user sees. Reached structurally
 * rather than by import: `dsh-client-ui-model-selection` is not a dependency of
 * this plugin, and the kernel itself types cross-package faces this way when the
 * dependency direction forbids the import.
 *
 * What this deliberately does *not* try to answer is whether that model can be
 * handed a picture. Nothing on the wire says so — the kernel's model catalog
 * carries `id`, `name`, `description` and `reasoning` and no modalities, in rc.8
 * as in ours — so the capability half comes from our own host
 * (`files.vision`), and only the two together decide anything.
 *
 * @module openlux-plugin-account/client/selection
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ModelChoice } from './AttachFileButton.tsx'

/** The directory service's face, in the two members this module uses. */
interface ModelDirectoriesFace {
  directoryFor(id: SessionId): ModelDirectoryFace
}

/** One session's directory, likewise narrowed. */
interface ModelDirectoryFace {
  /** Refresh from the host; the picker calls this whenever it opens. */
  load(): Promise<unknown>
  readonly store: {
    getSnapshot(): { current: ModelChoice | null }
    subscribe(fn: () => void): () => void
  }
}

/**
 * The session's current selection, or `undefined` when it is not knowable yet.
 *
 * Three things produce `undefined`, and callers must treat them alike: no
 * directory service in this composition, a session the service does not know
 * (`directoryFor` fails loud on those), and a store that has not loaded — the
 * snapshot's `current` is `null` until something asks the host, and in a fresh
 * session nothing has if the user never opened the picker.
 *
 * That last case is why a miss also *starts* a load. The value is still absent
 * for this call, so the caller still has to have a safe answer for "unknown",
 * but a caller that asks twice (once while a drag is entering the window, once
 * when it lands) gets a real answer the second time.
 * @param ctx - the client root context.
 * @param id - the session whose selection is wanted.
 * @returns the provider and model, when both are known.
 */
export function modelChoice(ctx: ClientContext, id: SessionId): ModelChoice | undefined {
  const directory = directoryOf(ctx, id)
  if (directory === undefined) return undefined
  const current = directory.store.getSnapshot().current
  if (current === null) {
    // Fire and forget: this is the picker's own refresh entry, documented as
    // preserving the last good value on failure.
    void directory.load().catch(() => undefined)
    return undefined
  }
  return current
}

/**
 * The same directory, or `undefined` for any of the three ways it can be absent.
 * @param ctx - the client root context.
 * @param id - the session whose directory is wanted.
 * @returns the narrowed directory face.
 */
function directoryOf(ctx: ClientContext, id: SessionId): ModelDirectoryFace | undefined {
  const directories = ctx.get('modelDirectories') as ModelDirectoriesFace | undefined
  if (directories === undefined) return undefined
  try {
    return directories.directoryFor(id)
  } catch {
    return undefined
  }
}

/**
 * Call back whenever this session's selection changes.
 *
 * The picker writes through the same store {@link modelChoice} reads, so this
 * is how a caller learns that the model it routed a picture by is no longer the
 * model that will run the turn.
 * @param ctx - the client root context.
 * @param id - the session to watch.
 * @param listener - invoked after each change; the new value is read separately.
 * @returns an unsubscribe, a no-op when the directory is not knowable.
 */
export function watchModelChoice(ctx: ClientContext, id: SessionId, listener: () => void): () => void {
  const directory = directoryOf(ctx, id)
  if (directory === undefined) return () => undefined
  return directory.store.subscribe(listener)
}
