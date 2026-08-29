/**
 * Ambient stand-in for `electron`, which this package deliberately does not
 * depend on.
 *
 * The only consumer is `market/connector-install.ts`'s `openCustomFile`, which
 * does a guarded `await import('electron')` and copes with every shape of
 * absence at runtime — the host that carries this plugin is Electron, but the
 * plugin also builds for deployments that have none. Before the repo split
 * this import type-checked by accident: module walk-up escaped the workspace
 * and landed on the old shell's `yunwu-desktop/node_modules/electron`
 * (found 2026-08-29, first typecheck outside that tree). Declaring the module
 * here keeps the compiler out of it without buying the whole Electron
 * dependency for one optional call; the call site's local `Shell` interface
 * is the actual contract.
 */
declare module 'electron'
