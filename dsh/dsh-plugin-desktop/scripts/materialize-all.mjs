/**
 * Materialize every downloaded WorkBuddy expert package into this package's
 * preset directory.
 *
 * The single-package entry point ({@link materializeExpert}) is the interesting
 * code; this is the enumeration around it, and it exists so that shipping the
 * whole set is one reproducible command rather than 22 invocations with
 * hand-picked order numbers. Re-running it is how an upstream re-import lands:
 * the generator rewrites each preset directory from scratch, and its assertions
 * are what turn a reworded upstream package into a build failure instead of a
 * silently wrong persona.
 *
 * Order is `20 + index` over the sorted slugs — deterministic, so a re-import
 * does not reshuffle the picker, and above the dsh CLI's own presets (standard,
 * PTC, minimal, creative) which the picker lists first.
 *
 * The source root is *found*, not assumed: WorkBuddy's install location differs
 * per machine, and the marketplace path lives under the user's home rather than
 * beside the app. Pass it explicitly to import from a copy.
 * @module scripts/materialize-all
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materializeExpert } from './materialize-expert.mjs'

/** Where WorkBuddy keeps the packages it has downloaded. */
const DEFAULT_SOURCE = join(homedir(), '.workbuddy', 'plugins', 'marketplaces', 'experts', 'plugins')

/** The first order value above the presets the dsh CLI ships. */
const FIRST_ORDER = 20

/**
 * Materialize every package under one source root.
 * @param sourceRoot - directory of WorkBuddy expert packages.
 * @returns one row per package, in picker order.
 * @throws {Error} when the source root is absent, so a wrong path fails loudly
 * instead of writing an empty preset set.
 */
export function materializeAll(sourceRoot = DEFAULT_SOURCE) {
  if (!existsSync(sourceRoot)) {
    throw new Error(`no WorkBuddy packages at ${sourceRoot} — pass the marketplace directory as the first argument`)
  }
  const slugs = readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  return slugs.map((slug, index) => materializeExpert(join(sourceRoot, slug), { order: FIRST_ORDER + index }))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rows = materializeAll(process.argv[2] ?? DEFAULT_SOURCE)
  for (const row of rows) {
    const kind = row.team ? `team(${String(row.members.length)})` : 'expert'
    console.log(`${row.slug}\t${kind}\tskills=${String(row.skillCount)}\t${row.name}`)
  }
  console.log(`materialized ${String(rows.length)} presets`)
}
