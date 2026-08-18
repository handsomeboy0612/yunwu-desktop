/**
 * Catalog reader: what the console offers *this* kernel.
 *
 * The gallery cannot read the console itself — the snapshot route authenticates
 * with the `sk-` token this plugin holds and answers without CORS headers, the
 * same two reasons the account endpoints live host-side.
 *
 * ## Why the kernel version rides along
 *
 * A preset archive is written against one kernel API: its composition names
 * plugin packages and carries `!!js` expressions, so a composition authored for
 * a later kernel installs fine and then fails to load. The catalog is therefore
 * asked for artifacts matching the kernel this process actually runs, and rows
 * with nothing matching arrive marked rather than dropped, so the gallery can
 * say "not available for this version" instead of silently showing a shorter
 * list than the console shows (`docs/dsh-kernel-migration.md`, artifact table).
 *
 * ## Why ETag rather than a duration
 *
 * The catalog changes when an operator publishes, not on a schedule, so every
 * read revalidates and a match costs one empty 304. That is the console's own
 * caching contract for this route (`controller/desktop_market_client.go`), and
 * honouring it keeps the gallery instant on reopen without ever showing a
 * version an operator has already retired.
 */

import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import { asEnvelope, normalizeBase, requestJson } from '../account/http.ts'
import { formatFor } from './wire.ts'
import type {
  Catalog, CatalogArtifact, CatalogCategory, CatalogFailure, CatalogItem, CatalogType, Unavailable,
} from './wire.ts'

export type {
  Catalog, CatalogArtifact, CatalogCategory, CatalogFailure, CatalogItem, CatalogType, Unavailable,
} from './wire.ts'


/** Budget: the gallery is a foreground read, but not one that blocks input. */
const CATALOG_TIMEOUT_MS = 12_000

/** Preset ids are directory names; the kernel's own rule decides which. */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

/** What one revalidation kept. */
interface Cached {
  readonly etag: string | undefined
  readonly catalog: Catalog
}

/** Per-origin, per-type memo; the process is the cache's lifetime. */
const cache = new Map<string, Cached>()

const require_ = createRequire(import.meta.url)

/**
 * Kernel API version this process runs.
 *
 * Read from an installed kernel package rather than from our own manifest: what
 * matters is the kernel the composition actually loaded, and a plugin pinned to
 * one version can still be dropped into a host running another. `home-paths` is
 * the one kernel package a plugin outside the repository can touch at runtime
 * (Node built-ins only, no `dsh-scope` peer to resolve).
 * @returns the version string, or `unknown` when it cannot be read.
 */
export function kernelApi(): string {
  try {
    const manifest = require_('@deepseek-ai/dsh-home-paths/package.json') as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Read the catalog for one type.
 * @param ctx - host context.
 * @param options.baseUrl - console origin.
 * @param options.apiKey - reader for the `sk-` token.
 * @param options.type - which partition to read.
 * @param signal - caller cancellation.
 * @returns the catalog, from cache when a fresh read failed.
 */
export async function readCatalog(
  ctx: Context,
  options: {
    readonly baseUrl: string
    readonly apiKey: () => Promise<string | undefined>
    readonly type: CatalogType
  },
  signal?: AbortSignal,
): Promise<Catalog> {
  const base = normalizeBase(options.baseUrl)
  const api = kernelApi()
  const key = `${base}|${options.type}|${api}`
  const held = cache.get(key)

  const token = await options.apiKey()
  // Not an error: a signed-out client has a catalog it cannot read yet, and
  // the gallery's answer to that is the sign-in row it already shows.
  if (token === undefined) {
    return { kernelApi: api, items: [], categories: [], failure: { kind: 'signed-out' } }
  }

  // One format per partition, and none for connectors: they carry an MCP launch
  // manifest in their own row rather than an archive, so asking for one would
  // mark every connector unavailable.
  const format = formatFor(options.type)
  const url = `${base}/api/desktop-market/snapshot`
    + `?type=${encodeURIComponent(options.type)}&kernel_api=${encodeURIComponent(api)}`
    // No format means "catalog only, no artifacts", which the console handles
    // as its own case and which is exactly right for connectors.
    + (format === undefined ? '' : `&format=${encodeURIComponent(format)}`)
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (held?.etag !== undefined) headers['If-None-Match'] = held.etag

  let reply
  try {
    reply = await requestJson(ctx, url, { method: 'GET', headers }, CATALOG_TIMEOUT_MS, signal)
  } catch (error: unknown) {
    return failed(api, held, {
      kind: 'transport',
      message: error instanceof Error ? error.message : String(error),
    })
  }

  // 304 is the hit: the body is empty by contract, and the rows we hold are
  // the ones the console would have sent.
  // A revalidation that matched makes the held rows current again, so an
  // earlier failure's marks do not ride along.
  if (reply.response.status === 304 && held !== undefined) {
    const { kernelApi: api304, items, categories } = held.catalog
    return { kernelApi: api304, items, categories }
  }
  if (!reply.response.ok) {
    return failed(api, held, { kind: 'http', status: reply.response.status })
  }

  const envelope = asEnvelope<{ items?: unknown; categories?: unknown }>(reply.body)
  if (envelope.success === false) {
    return failed(api, held, envelope.message === undefined || envelope.message === ''
      ? { kind: 'http', status: reply.response.status }
      : { kind: 'refused', message: envelope.message })
  }

  const catalog: Catalog = {
    kernelApi: api,
    items: itemsOf(envelope.data?.items, api, options.type),
    categories: categoriesOf(envelope.data?.categories),
  }
  cache.set(key, { etag: reply.response.headers.get('etag') ?? undefined, catalog })
  return catalog
}

/**
 * Answer a failed read with whatever is still true.
 * @param api - kernel api the read was for.
 * @param held - the cached answer, when there is one.
 * @param failure - why the fresh read failed.
 * @returns the stale catalog, or an empty one carrying the reason.
 */
function failed(api: string, held: Cached | undefined, failure: CatalogFailure): Catalog {
  if (held === undefined) return { kernelApi: api, items: [], categories: [], failure }
  return { ...held.catalog, stale: true, failure }
}

/**
 * Normalize the wire rows, marking the ones this client cannot install.
 * @param raw - the `items` field, whatever it holds.
 * @param api - kernel api the artifacts were asked for.
 * @returns the rows the gallery renders.
 */
function itemsOf(raw: unknown, api: string, type: CatalogType): CatalogItem[] {
  if (!Array.isArray(raw)) return []
  const items: CatalogItem[] = []
  for (const entry of raw) {
    const row = (entry ?? {}) as Record<string, unknown>
    const slug = text(row['slug'])
    if (slug === '') continue
    const artifact = artifactOf(row['artifact'], api, formatFor(type))
    const unavailable: Unavailable | undefined = !PRESET_ID.test(slug)
      ? 'bad-id'
      // A connector has no archive by design, so absence is not unavailability.
      : artifact === undefined && formatFor(type) !== undefined ? 'no-artifact' : undefined
    items.push({
      slug,
      name: text(row['name']) === '' ? slug : text(row['name']),
      descriptionZh: text(row['description_zh']),
      descriptionEn: text(row['description_en']),
      version: text(row['version']),
      icon: text(row['icon']),
      categoryId: count(row['category_id']),
      tags: tagsOf(row['tags']),
      team: row['is_team'] === true || row['is_team'] === 1,
      featured: row['featured'] === true || row['featured'] === 1,
      downloads: count(row['download_count']),
      ...artifact === undefined ? {} : { artifact },
      ...unavailable === undefined ? {} : { unavailable },
    })
  }
  return items
}

/**
 * Read one item's archive, accepting only what this client installs.
 *
 * The console selects by the query, but the client re-checks: a server that
 * widened its answer must not hand this installer an archive shape it has no
 * reader for.
 *
 * There is deliberately no download URL here. The console does not put one in
 * the snapshot and explains why: a presigned URL expires in hours while this
 * body is ETag-cached for days, so a URL cached beside it would be dead exactly
 * when someone finally clicks install, and ETag cannot express that staleness.
 * The digest and size are the facts that do not expire; the link is signed at
 * click time (`controller/desktop_market_client.go:97-107`).
 * @param raw - the `artifact` field.
 * @param api - kernel api the artifact must declare.
 * @param wanted - format this partition asked for; undefined means none.
 * @returns the archive, or undefined when there is nothing installable.
 */
function artifactOf(
  raw: unknown,
  api: string,
  wanted: string | undefined,
): CatalogArtifact | undefined {
  if (wanted === undefined) return undefined
  const row = (raw ?? {}) as Record<string, unknown>
  const sha256 = text(row['sha256'])
  const format = text(row['format'])
  const kernelApi = text(row['kernel_api'])
  if (sha256 === '') return undefined
  if (format !== wanted) return undefined
  if (kernelApi !== '' && kernelApi !== api) return undefined
  return { format, kernelApi: kernelApi === '' ? api : kernelApi, sha256, size: count(row['size']) }
}

/**
 * Normalize the category rows.
 * @param raw - the `categories` field.
 * @returns the filter rows.
 */
function categoriesOf(raw: unknown): CatalogCategory[] {
  if (!Array.isArray(raw)) return []
  const categories: CatalogCategory[] = []
  for (const entry of raw) {
    const row = (entry ?? {}) as Record<string, unknown>
    const id = count(row['id'])
    const name = text(row['name'])
    if (id > 0 && name !== '') categories.push({ id, name })
  }
  return categories
}

/**
 * Read the tag list, which the console stores as a JSON text column.
 * @param raw - the `tags` field, an array or its JSON text.
 * @returns the tags, empty when unreadable.
 */
function tagsOf(raw: unknown): string[] {
  const parsed: unknown = typeof raw === 'string' && raw !== ''
    ? ((): unknown => { try { return JSON.parse(raw) } catch { return undefined } })()
    : raw
  if (!Array.isArray(parsed)) return []
  return parsed.map(tag => text(tag)).filter(tag => tag !== '')
}

/**
 * Read a string field.
 * @param value - the raw field.
 * @returns the string, empty when absent or another type.
 */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Read a non-negative number field.
 * @param value - the raw field.
 * @returns the number, zero when absent or unreadable.
 */
function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}
