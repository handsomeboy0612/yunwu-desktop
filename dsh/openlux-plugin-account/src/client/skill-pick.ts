/**
 * Let the user point at a skill directory on their own disk.
 *
 * The renderer cannot read a directory, and it must not: the host is what walks
 * the tree and what enforces the caps. So this resolves one thing — the absolute
 * path of the folder the user chose — and hands that over.
 *
 * How the path is obtained is the shell's own answer, not an invention here:
 * `webkitdirectory` yields the folder's files, each carrying a
 * `webkitRelativePath` whose FIRST segment is the chosen folder itself, and the
 * desktop preload resolves any picked File to its real path
 * (`file-path-bridge.ts`). Trimming the part below that first segment off the
 * absolute path leaves the folder — trimming the whole relative path would
 * leave its parent, which is a directory the user did not choose. In a browser
 * deployment there is no bridge, so this answers `unsupported` and the caller
 * says the feature needs the desktop app.
 *
 * @module openlux-plugin-account/client/skill-pick
 */

import { diskPathOf } from './file-path-bridge.ts'

/** What a directory pick can end in. */
export type SkillPick =
  /** The absolute directory the user chose. */
  | { readonly kind: 'picked'; readonly path: string }
  /** The user closed the picker without choosing. */
  | { readonly kind: 'cancelled' }
  /** This deployment cannot resolve a path for a picked file. */
  | { readonly kind: 'unsupported' }

/** Attributes the DOM has but the React/TS lib types do not spell for us. */
interface DirectoryInput extends HTMLInputElement {
  webkitdirectory: boolean
}

/**
 * Open a folder picker and resolve the chosen directory.
 * @returns what the pick ended in.
 */
export async function pickSkillDirectory(): Promise<SkillPick> {
  const input = document.createElement('input') as DirectoryInput
  input.type = 'file'
  input.webkitdirectory = true
  input.style.display = 'none'
  document.body.append(input)
  try {
    const files = await new Promise<readonly File[]>(resolve => {
      // `change` fires with a selection; `cancel` fires when the dialog closes
      // with none. Without the second one a cancelled pick would leave the
      // caller waiting forever.
      input.addEventListener('change', () => resolve([...input.files ?? []]), { once: true })
      input.addEventListener('cancel', () => resolve([]), { once: true })
      input.click()
    })
    const first = files[0]
    if (first === undefined) return { kind: 'cancelled' }
    const absolute = diskPathOf(first)
    if (absolute === undefined) return { kind: 'unsupported' }
    const relative = first.webkitRelativePath
    if (relative === '') return { kind: 'unsupported' }
    // Everything below the chosen folder; empty when the file sits directly in
    // it, in which case only the file name comes off.
    const below = relative.split('/').slice(1).join('/')
    // The relative half is POSIX-separated even on Windows, where the absolute
    // half is not, so the suffix is matched in whichever spelling the path uses.
    const suffix = below === '' ? '' : below
    const candidates = suffix === ''
      ? [absolute.split(/[\\/]/u).pop() ?? '']
      : [suffix, suffix.replace(/\//gu, '\\')]
    const tail = candidates.find(value => value !== '' && absolute.endsWith(value))
    if (tail === undefined) return { kind: 'unsupported' }
    const root = absolute.slice(0, absolute.length - tail.length).replace(/[\\/]+$/u, '')
    return root === '' ? { kind: 'unsupported' } : { kind: 'picked', path: root }
  } finally {
    input.remove()
  }
}
