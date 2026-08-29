/**
 * Startup reconcile: what is installed follows what the console publishes.
 *
 * ## Why it exists
 *
 * Installing snapshots bytes: a preset directory for an expert, a skill
 * directory for a skill, a resolved bridge config for a connector. The console
 * moving on (an operator edits a persona, republishes a skill, fixes a
 * connector's server config) reaches nobody who already installed — the
 * install path even refuses a slug it already has. The old shell had the same
 * gap and closed it with a silent pass at startup
 * (`src/main/market/auto-update.ts`); this is that pass for the new shell,
 * with the digest doing the comparing instead of the version string, because
 * the console rebuilds artifacts on edits without necessarily bumping any
 * version.
 *
 * ## The old shell's rules, kept
 *
 * - **A snapshot that is not fresh decides nothing.** A cached or failed
 *   catalog read skips the whole partition rather than acting on old rows.
 * - **Digest agreement still checks the disk.** A broken preset with the right
 *   digest is reinstalled anyway — versions that "match" while assets are
 *   missing was a measured failure mode over there (`hasPersonaOnDisk`).
 * - **One item failing never stops the loop**, and failures are logged as one
 *   line, not thrown: offline and signed-out are ordinary states here.
 * - **Delisted items are kept, and said so.** The old shell only removed a
 *   delisted expert after proving no task used it; this shell has no session
 *   reader to prove that with, and the install layer's own rule is that
 *   removal belongs to the kernel's settings surface. So a delisted item stays
 *   usable and stops updating, with a log line as the record.
 *
 * ## What it never touches
 *
 * Anything without our provenance sidecar: user-authored presets, hand-made or
 * locally imported skills, the user's own `custom:` connectors. No sidecar
 * means the market never put it there and must never rewrite it.
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { readCatalog } from './catalog.ts'
import type { CatalogItem, CatalogType } from './catalog.ts'
import type { ConsoleAccess } from './console.ts'
import { reconcileConnectors } from './connector-install.ts'
import { installPreset, readInstallTarget, readProvenance } from './install.ts'
import type { MarketProvenance } from './install.ts'
import { installSkill, readManagedSkills } from './skill-install.ts'
import type { InstallRequest } from './wire.ts'

/**
 * Run the whole pass. Never throws: each partition catches for itself, and a
 * fault in one is a warning line, not a startup failure.
 * @param ctx - host context.
 * @param access - console origin and token reader.
 */
export async function reconcileMarketInstalls(ctx: Context, access: ConsoleAccess): Promise<void> {
  try {
    await reconcileExperts(ctx, access)
  } catch (error: unknown) {
    ctx.logger.warn(`openlux: expert reconcile failed: ${message(error)}`)
  }
  try {
    await reconcileSkills(ctx, access)
  } catch (error: unknown) {
    ctx.logger.warn(`openlux: skill reconcile failed: ${message(error)}`)
  }
  try {
    await reconcileConnectors(ctx, access)
  } catch (error: unknown) {
    ctx.logger.warn(`openlux: connector reconcile failed: ${message(error)}`)
  }
}

/** One market-installed preset, as found on disk. */
interface ManagedPreset {
  readonly id: string
  readonly broken: boolean
  readonly provenance: MarketProvenance
}

/** Re-install experts whose catalog artifact moved on, or whose copy is broken. */
async function reconcileExperts(ctx: Context, access: ConsoleAccess): Promise<void> {
  // `ctx.get` rather than a property read: the roster is consumed
  // opportunistically here, exactly as `market.target` consumes it.
  const presets = ctx.get('agentPresets')
  if (presets === undefined) return
  const target = await readInstallTarget(presets)
  if (!target.authorable || target.root === undefined) return
  const managed: ManagedPreset[] = []
  for (const preset of target.installed) {
    const provenance = await readProvenance(join(target.root, preset.id))
    if (provenance === undefined) continue
    managed.push({ id: preset.id, broken: preset.broken !== undefined, provenance })
  }
  if (managed.length === 0) return

  const items = await freshCatalog(ctx, access, 'expert')
  if (items === undefined) return
  for (const row of managed) {
    const item = items.get(row.id)
    if (item === undefined) {
      ctx.logger.info(`openlux: expert ${row.id} 已不在市场目录里，保留本地副本（不再更新）`)
      continue
    }
    if (item.artifact === undefined) continue
    const fresh = item.artifact.sha256.toLowerCase()
    if (!row.broken && fresh === row.provenance.sha256.toLowerCase()) continue
    const outcome = await installPreset(
      ctx, presets, access,
      requestOf('expert', row.id, row.provenance.itemId, item),
      undefined, { replace: true },
    )
    if (outcome.kind === 'installed') {
      ctx.logger.info(`openlux: expert ${row.id} ${row.broken ? '本地副本损坏，已重装自愈' : '已随市场更新'}`)
    } else {
      ctx.logger.warn(`openlux: expert ${row.id} 自动更新跳过: ${outcome.message}`)
    }
  }
}

/** Refresh skills whose digest moved on, or whose record predates digests. */
async function reconcileSkills(ctx: Context, access: ConsoleAccess): Promise<void> {
  const managed = await readManagedSkills()
  if (managed.length === 0) return
  const items = await freshCatalog(ctx, access, 'skill')
  if (items === undefined) return
  for (const row of managed) {
    const item = items.get(row.slug)
    if (item === undefined) {
      ctx.logger.info(`openlux: skill ${row.slug} 已不在市场目录里，保留本地副本（不再更新）`)
      continue
    }
    if (item.artifact === undefined) continue
    const fresh = item.artifact.sha256.toLowerCase()
    // A record without a digest predates digest recording; refreshing once
    // writes one, so every later launch compares bytes instead of guessing.
    if (row.provenance.sha256 !== undefined && fresh === row.provenance.sha256) continue
    const outcome = await installSkill(
      ctx, access,
      requestOf('skill', row.slug, row.provenance.itemId, item),
      undefined, { replace: true },
    )
    if (outcome.kind === 'installed') {
      ctx.logger.info(`openlux: skill ${row.slug} ${
        row.provenance.sha256 === undefined ? '登记补齐摘要，已换新一次' : '已随市场更新'}`)
    } else {
      ctx.logger.warn(`openlux: skill ${row.slug} 自动更新跳过: ${outcome.message}`)
    }
  }
}

/**
 * Read one partition's catalog and answer only when it is fresh.
 *
 * `stale` means these rows came from cache after a failed read, and `failure`
 * means the fresh read failed at all — either way the rows may predate what an
 * operator just retired, and updating installs against them would churn for
 * nothing. Offline and signed-out both land here, as a skip rather than a
 * fault.
 */
async function freshCatalog(
  ctx: Context,
  access: ConsoleAccess,
  type: CatalogType,
): Promise<ReadonlyMap<string, CatalogItem> | undefined> {
  const catalog = await readCatalog(ctx, { ...access, type })
  if (catalog.stale === true || catalog.failure !== undefined) {
    ctx.logger.info(`openlux: ${type} 目录快照不新鲜，本轮不对账`)
    return undefined
  }
  return new Map(catalog.items.map(item => [item.slug, item]))
}

/** Build the install request an update is, from the fresh catalog row. */
function requestOf(
  type: CatalogType,
  id: string,
  itemId: string,
  item: CatalogItem,
): InstallRequest {
  return {
    type,
    id,
    itemId,
    // `freshCatalog` callers only reach here with an artifact present.
    format: item.artifact!.format,
    sha256: item.artifact!.sha256,
    ...item.name === '' ? {} : { name: item.name },
    ...item.descriptionZh === '' ? {} : { description: item.descriptionZh },
    ...item.version === '' ? {} : { version: item.version },
    kernelApi: item.artifact!.kernelApi,
  }
}

/** One line for a log, whatever was thrown. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
