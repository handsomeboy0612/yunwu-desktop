/**
 * The desktop shell's own answer to "where does this File live on disk".
 *
 * The shell's preload exposes `webUtils.getPathForFile` on the main world under
 * a fixed key (`dsh-plugin-desktop/src/file-path-bridge-contract.ts`, and the
 * preload that installs it, `src/preload.ts`); the shell itself reads it the
 * same way to adopt a dropped workspace folder
 * (`src/client/workspace-folder-drop.ts`). It arrived in 0.1.1-rc.2 — before
 * that the windows were built with no preload at all, which is why this
 * plugin's own file intake was written to move bytes instead of a path.
 *
 * Two callers-side facts decide the shape here. The key is absent in a browser
 * deployment, where no path exists to hand over. And a File that never came
 * from disk — a clipboard image, anything constructed in the page — resolves to
 * the empty string rather than throwing, so emptiness is the signal, not an
 * error. Both collapse into `undefined`, which means "ask the host to stage the
 * bytes".
 *
 * @module openlux-plugin-account/client/file-path-bridge
 */

/** What the shell's preload puts on the main world. */
interface FilePathBridge {
  getPathForFile: (file: File) => string
}

/** The key the shell's contract fixes; changing it is a shell-side decision. */
const BRIDGE_KEY = '__DSH_DESKTOP_FILE_PATH__'

/**
 * Resolve one File to its absolute path, when this deployment can.
 * @param file - a file the user picked, dropped, or pasted.
 * @returns the path, or `undefined` when there is none to have.
 */
export function diskPathOf(file: File): string | undefined {
  const bridge = (globalThis as Record<string, unknown>)[BRIDGE_KEY] as FilePathBridge | undefined
  if (bridge === undefined) return undefined
  let path: string
  try {
    path = bridge.getPathForFile(file)
  } catch {
    // The bridge is a context-isolated function call; a rejected argument is a
    // "no path" answer like any other, not a reason to lose the attachment.
    return undefined
  }
  const trimmed = path.trim()
  return trimmed === '' ? undefined : trimmed
}
