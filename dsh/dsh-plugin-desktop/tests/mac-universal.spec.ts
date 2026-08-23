import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  MACOS_UNIVERSAL_NATIVE_ENTRIES,
  prepareMacUniversalRuntime,
} from '../scripts/mac-universal.ts'

// Preparation resolves the root against the host, which prepends a drive letter
// on Windows, so every case below resolves too: both the expected chmod targets
// and the injected `exists` seam must name the same paths the inventory is
// checked against. A bare posix literal makes `exists` answer true everywhere on
// Windows, and then the incomplete-architecture case cannot fail at all.
describe('universal macOS native runtime preparation', () => {
  it('requires every CPU-specific file and repairs both node-pty helpers', () => {
    const chmod = vi.fn()
    const desktopRoot = resolve('/desktop')

    prepareMacUniversalRuntime({ desktopRoot, exists: () => true, chmod })

    expect(chmod.mock.calls).toEqual([
      [join(desktopRoot, 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'), 0o755],
      [join(desktopRoot, 'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper'), 0o755],
    ])
  })

  it('fails before changing permissions when one architecture is incomplete', () => {
    const chmod = vi.fn()
    const desktopRoot = resolve('/desktop')
    const missing = MACOS_UNIVERSAL_NATIVE_ENTRIES.at(-1)!.path

    expect(() => prepareMacUniversalRuntime({
      desktopRoot,
      exists: path => path !== join(desktopRoot, missing),
      chmod,
    })).toThrow(join(desktopRoot, missing))
    expect(chmod).not.toHaveBeenCalled()
  })
})
