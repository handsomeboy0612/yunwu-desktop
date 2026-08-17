/**
 * Install one market preset into the kernel's own writable preset root.
 *
 * The kernel has no store, but it does have every judgement an installer needs,
 * and this file is built so that each step defers to one of them rather than to
 * a rule of ours:
 *
 * 1. `agentPresets.authorable` decides whether installing is possible at all —
 *    a deployment with no user-writable root has none, and the kernel's own
 *    settings section greys itself out on the same getter.
 * 2. `agentPresets.roots` decides *where*, not `$DSH_HOME/.agent-presets` written
 *    out by hand: `roots` is the derived set (configured roots, then the
 *    harness-home user root). The kernel's own `writableRoot()` cannot be called
 *    from a package outside its workspace, so {@link writableRootOf} mirrors its
 *    two lines and step 5 catches a mirror that drifts.
 * 3. `list()` decides whether the id is free. Discovery is first-root-wins, so a
 *    shipped preset with the same id would shadow whatever we wrote — checking
 *    the roster rather than the directory is what catches that, and it catches
 *    ghost directories (rows the kernel reports `broken`) too.
 * 4. The unpack is staged and renamed into place, so a failure halfway leaves
 *    nothing behind. The staging directory lives *inside* the writable root for
 *    two reasons: rename is only atomic within one filesystem, and discovery
 *    skips any child whose name fails the kernel's own id pattern
 *    (`lib/index.js:247`) — a `.`-prefixed name is therefore invisible to it,
 *    so a half-written directory can never be listed, not even as broken.
 * 5. `list()` decides whether the install worked. This is also what makes the
 *    mirrored id pattern below safe: were ours ever laxer than the kernel's,
 *    the directory would not be discovered, this step would fail, and the
 *    install would roll back — rather than leaving a directory nobody can see.
 *
 * What this file does NOT do is manage what is already installed. Uninstalling,
 * changing the default, reading a composition, and dealing with broken rows are
 * all in the kernel's Agent-presets settings section already; duplicating them
 * would give the same object two owners.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Types only, which is also what makes `ctx.get('agentPresets')` resolve at the
// call site — the kernel's own opportunistic consumers import this package
// exactly this way (`subagent/src/child-agent.ts:22-27`). Importing its runtime
// half does not work: the kernel's packages arrive as published tarballs
// installed per workspace package, and the copy that lands in ours cannot
// resolve its own `@deepseek-ai/dsh-scope` — the shell fails to boot with
// ERR_MODULE_NOT_FOUND (observed, not feared). Declaring that closure would
// mean carrying several packages we never call, in lockstep versions, to reuse
// three lines.
import type { AgentPreset, AgentPresets, PresetRoot } from '@deepseek-ai/dsh-agent-presets'
// This one, by contrast, compiles to node builtins only and no transitive
// package, so the kernel's own `~` handling is reachable.
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { requestBytes } from '../account/http.ts'
import { ARCHIVE_LIMITS, ArchiveError, readTarGz, type ArchiveEntry } from './targz.ts'

/**
 * The kernel's preset id pattern, mirrored because it is not reachable.
 *
 * `PRESET_ID` lives in the package's `preset.ts` and is not re-exported from
 * its entry (`dsh-agent-presets/lib/types/index.d.ts:36-42`), and the package
 * exposes no subpath for it. The kernel's own copy dialog mirrors it for the
 * same reason. Kept verbatim from `lib/index.js:101`; step 5 is what notices if
 * it ever drifts.
 */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

/**
 * The directory installs are written to, derived as the kernel derives it.
 *
 * `writableRoot()` cannot be called from here (see the import note above), so
 * its two decisions are made here instead: the first root whose trust is `user`
 * wins, and the path is expanded and absolutised — the expansion itself is the
 * kernel's own function, so only the selection is ours. `roots` rather than
 * `config.roots`, because the roster appends the harness-home user root and it
 * is usually the only writable one there is.
 *
 * A wrong answer here cannot install into the wrong place silently: the kernel
 * would not discover what we wrote, and step 5 rolls the install back.
 * @param roots - the roster's derived roots, in precedence order.
 * @returns the writable root, or undefined when this deployment has none.
 */
function writableRootOf(roots: readonly PresetRoot[]): string | undefined {
  const root = roots.find(candidate => candidate.trust === 'user')
  return root === undefined ? undefined : resolve(expandHomePath(root.path))
}

/** The composition file whose presence is what makes a directory a preset. */
const COMPOSITION_FILE = 'agent.cordis.yml'

/**
 * Where an install records what it came from.
 *
 * A separate file on purpose. `preset.yml` carries display text by definition,
 * and the kernel rewrites its `name` and `order` during a copy, so provenance
 * put there would be silently lost by an ordinary user action. Discovery reads
 * only the composition and `preset.yml`, so an extra file costs nothing.
 */
export const PROVENANCE_FILE = 'openlux-market.json'

/** Compressed size cap for one artifact download. */
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024

/** Longer than an account call: this is a file transfer, not a form post. */
const DOWNLOAD_TIMEOUT_MS = 60_000

/** What an installed preset came from, as recorded next to its composition. */
export interface MarketProvenance {
  /** Format version of this file, so a later client can migrate it. */
  readonly schema: 1
  /** Catalog item this preset was installed from. */
  readonly itemId: string
  /** Artifact digest, as verified at install time. */
  readonly sha256: string
  /** Where the artifact was fetched from. */
  readonly source: string
  /** ISO timestamp of the install. */
  readonly installedAt: string
  readonly version?: string
  /** Kernel API the artifact was built for, when the catalog declared one. */
  readonly kernelApi?: string
}

/** One install, as asked for by the gallery. */
export interface InstallRequest {
  /** Preset id, which becomes the directory name; the catalog owns it. */
  readonly id: string
  /** Artifact URL, already signed by the catalog. */
  readonly url: string
  /** Expected artifact digest, hex. */
  readonly sha256: string
  readonly itemId: string
  readonly version?: string
  readonly kernelApi?: string
}

/** Why an install did not happen; every one of these is an ordinary outcome. */
export type RefusalReason =
  | 'not-authorable'
  | 'invalid-id'
  | 'already-installed'
  | 'download-failed'
  | 'digest-mismatch'
  | 'bad-archive'
  | 'broken-after-install'

/** Result of an install attempt. */
export type InstallOutcome =
  | { readonly kind: 'installed'; readonly id: string; readonly path: string }
  | { readonly kind: 'refused'; readonly reason: RefusalReason; readonly message: string }

/** An installed preset the gallery needs to know about. */
export interface InstalledPreset {
  readonly id: string
  readonly trust: string
  /** The kernel's own health verdict, verbatim when it has one. */
  readonly broken?: string
  /** Catalog item, when this row was installed by us rather than by hand. */
  readonly itemId?: string
  readonly version?: string
}

/** Where installs land, and what is already there. */
export interface InstallTarget {
  /** Whether this deployment can accept installs at all. */
  readonly authorable: boolean
  /** The directory installs are written to, absent when not authorable. */
  readonly root?: string
  /** Every preset the roster currently supplies, ours or not. */
  readonly installed: readonly InstalledPreset[]
}

/**
 * Report where an install would land and what the roster already holds.
 *
 * The gallery needs this before it can say "installed" on a card, and the
 * confirmation dialog needs the resolved directory to name the target it is
 * asking about — the market shell rule is that the dialog shows the locked
 * destination, not a description of one.
 * @param presets - the roster service, as read by the caller.
 * @returns the install target.
 */
export async function readInstallTarget(presets: AgentPresets): Promise<InstallTarget> {
  // The kernel decides whether installing is possible; we only locate where.
  const root = presets.authorable ? writableRootOf(presets.roots) : undefined
  if (root === undefined) return { authorable: false, installed: await describe(presets, undefined) }
  return { authorable: true, root, installed: await describe(presets, root) }
}

/**
 * Read the roster and attach our own provenance to the rows that carry it.
 * @param presets - the roster service.
 * @param root - the writable root, when there is one; only rows there can
 * carry provenance, because only those were installed by us.
 * @returns the roster as the gallery sees it.
 */
async function describe(presets: AgentPresets, root: string | undefined): Promise<InstalledPreset[]> {
  const roster = await presets.list()
  return await Promise.all(roster.map(async (preset: AgentPreset): Promise<InstalledPreset> => {
    const provenance = root === undefined ? undefined : await readProvenance(join(root, preset.id))
    return {
      id: preset.id,
      trust: preset.trust,
      ...preset.broken === undefined ? {} : { broken: preset.broken },
      ...provenance?.itemId === undefined ? {} : { itemId: provenance.itemId },
      ...provenance?.version === undefined ? {} : { version: provenance.version },
    }
  }))
}

/**
 * Read one preset's provenance file.
 *
 * A missing or unreadable file is not a fault: a preset the user authored or
 * copied by hand has none, and that is exactly the distinction the market
 * cleanup pass later needs — no sidecar means the market never put it there
 * and must never take it away.
 * @param directory - the preset directory.
 * @returns the provenance, or undefined when this preset has none.
 */
export async function readProvenance(directory: string): Promise<MarketProvenance | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(directory, PROVENANCE_FILE), 'utf8'))
    const record = parsed as MarketProvenance | null
    return record?.schema === 1 ? record : undefined
  } catch {
    return undefined
  }
}

/**
 * Install one preset from the catalog.
 *
 * Serialised by the caller (`index.ts` holds one queue for this channel): two
 * installs racing would stage into the same root and could rename over each
 * other's verification window.
 * @param ctx - host context, for the download.
 * @param presets - the roster service, as read by the caller.
 * @param request - what to install, as the catalog described it.
 * @param signal - caller cancellation.
 * @returns what happened; refusals are values, not exceptions.
 */
export async function installPreset(
  ctx: Context,
  presets: AgentPresets,
  request: InstallRequest,
  signal?: AbortSignal,
): Promise<InstallOutcome> {
  if (!presets.authorable) {
    return refuse('not-authorable', '当前部署没有可写的预设目录，无法安装专家。')
  }
  if (!PRESET_ID.test(request.id)) {
    return refuse('invalid-id', `专家标识 ${JSON.stringify(request.id)} 不符合内核的目录命名规则（小写字母、数字、连字符）。`)
  }
  const root = writableRootOf(presets.roots)
  if (root === undefined) {
    // The kernel says installs are possible but no root here says `user`: a
    // contradiction, so it stops rather than picking a directory on its own.
    return refuse('not-authorable', '内核报告可以安装，但没有解析出可写的预设目录，已中止。')
  }
  const existing = (await presets.list()).find(preset => preset.id === request.id)
  if (existing !== undefined) {
    return refuse('already-installed', existing.broken === undefined
      ? `已经装过 ${request.id} 了（来源：${existing.trust}）。要重装请先在「设置 → Agent 预设」里删除它。`
      // A broken row still occupies the id, and the kernel's own section is
      // where it gets removed — saying so is more useful than overwriting it.
      : `${request.id} 这个位置上有一份损坏的预设：${existing.broken}`)
  }

  let archive: Uint8Array
  try {
    archive = await requestBytes(ctx, request.url, DOWNLOAD_TIMEOUT_MS, MAX_DOWNLOAD_BYTES, signal)
  } catch (error: unknown) {
    return refuse('download-failed', error instanceof Error ? error.message : String(error))
  }
  const digest = createHash('sha256').update(archive).digest('hex')
  if (digest.toLowerCase() !== request.sha256.trim().toLowerCase()) {
    // Nothing has been written yet, and nothing will be: a digest that does
    // not match means the bytes are not the ones the catalog vouched for.
    return refuse('digest-mismatch', `制品校验失败：期望 ${request.sha256.trim().toLowerCase()}，实际 ${digest}。`)
  }

  let entries: ArchiveEntry[]
  try {
    entries = readTarGz(archive, ARCHIVE_LIMITS)
    assertPresetShape(entries)
  } catch (error: unknown) {
    if (error instanceof ArchiveError) return refuse('bad-archive', error.message)
    throw error
  }

  await mkdir(root, { recursive: true })
  const staging = join(root, `.openlux-staging-${request.id}-${randomUUID().slice(0, 8)}`)
  const destination = join(root, request.id)
  try {
    await writeEntries(entries, staging)
    await writeFile(join(staging, PROVENANCE_FILE), `${JSON.stringify(provenanceOf(request), undefined, 2)}\n`, 'utf8')
    await rename(staging, destination)
  } catch (error: unknown) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }

  const installed = (await presets.list()).find(preset => preset.id === request.id)
  if (installed === undefined || installed.broken !== undefined) {
    // Roll back rather than leave a card the user cannot use. The kernel's
    // reason is passed through verbatim: it is written for the person who has
    // to fix the artifact, and paraphrasing it loses the file it names.
    await rm(destination, { recursive: true, force: true })
    return refuse('broken-after-install', installed?.broken
      ?? `内核没有发现装好的预设 ${request.id}，制品的目录结构可能不对。`)
  }
  return { kind: 'installed', id: request.id, path: destination }
}

/** Build the sidecar record for one install. */
function provenanceOf(request: InstallRequest): MarketProvenance {
  return {
    schema: 1,
    itemId: request.itemId,
    sha256: request.sha256.trim().toLowerCase(),
    source: request.url,
    installedAt: new Date().toISOString(),
    ...request.version === undefined ? {} : { version: request.version },
    ...request.kernelApi === undefined ? {} : { kernelApi: request.kernelApi },
  }
}

/**
 * Check that the archive is a preset directory's contents.
 *
 * The archive root is the preset directory itself — the same shape the
 * community's preset repositories have, so an archive and a checkout are
 * interchangeable. It deliberately does NOT carry its own directory name: the
 * id comes from the catalog entry, and a name inside the archive would be a
 * second source of truth for it.
 */
function assertPresetShape(entries: readonly ArchiveEntry[]): void {
  if (!entries.some(entry => entry.kind === 'file' && entry.path === COMPOSITION_FILE)) {
    const wrapper = entries[0]?.path.split('/')[0]
    throw new ArchiveError(entries.every(entry => entry.path.split('/')[0] === wrapper)
      ? `制品根目录下没有 ${COMPOSITION_FILE}：整个 preset 目录被多包了一层 ${JSON.stringify(wrapper ?? '')}。`
      : `制品根目录下没有 ${COMPOSITION_FILE}，这不是一个 preset 目录。`)
  }
  if (entries.some(entry => entry.path === PROVENANCE_FILE)) {
    // Provenance is what this client observed, not something an artifact gets
    // to assert about itself.
    throw new ArchiveError(`制品里自带了 ${PROVENANCE_FILE}，不予安装。`)
  }
}

/**
 * Write accepted members under one directory.
 * @param entries - members from {@link readTarGz}, whose paths are relative.
 * @param destination - the staging directory, created here.
 */
async function writeEntries(entries: readonly ArchiveEntry[], destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  for (const entry of entries) {
    const target = join(destination, entry.path)
    if (entry.kind === 'directory') {
      await mkdir(target, { recursive: true })
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    // No mode is carried over. An archive does not get to decide that a file
    // in a preset directory is executable; skills are run through their
    // interpreter, so nothing here needs the bit.
    await writeFile(target, entry.body)
  }
}

/** Shape a refusal. */
function refuse(reason: RefusalReason, message: string): InstallOutcome {
  return { kind: 'refused', reason, message }
}
