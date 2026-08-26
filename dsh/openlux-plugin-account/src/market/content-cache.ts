/**
 * Revalidated console-content cache shared by catalog and home modules.
 *
 * Level one is this process' Map. Level two is one bounded JSON file under the
 * DSH home, so reopening the app can send the last ETag and can still render
 * owned content while the console is temporarily unreachable. Responses are
 * kept as raw JSON and parsed by the current reader on every use; a stale disk
 * shape is therefore ignored instead of becoming an old implicit contract.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { asEnvelope, requestJson } from '../account/http.ts'
import type { CatalogFailure } from './wire.ts'

const CACHE_SCHEMA = 1
const CACHE_FILE = 'openlux-content-cache.json'
const MAX_CACHE_BYTES = 8 * 1024 * 1024
const MAX_CACHE_ENTRIES = 64

interface CacheEntry {
  readonly etag?: string
  readonly body: unknown
  readonly savedAt: number
}

interface CacheFile {
  readonly schema: typeof CACHE_SCHEMA
  readonly entries: Record<string, CacheEntry>
}

export interface ContentModuleRead<T> {
  readonly value?: T
  readonly stale?: boolean
  readonly failure?: CatalogFailure
}

export interface ContentModuleRequest<T> {
  readonly key: string
  readonly url: string
  readonly apiKey: () => Promise<string | undefined>
  readonly timeoutMs: number
  readonly parse: (data: unknown) => T | undefined
}

let cachePath = ''
let loaded: Promise<void> | undefined
const memory = new Map<string, CacheEntry>()
let writes: Promise<void> = Promise.resolve()

/** Read one independently versioned module through memory, disk, and ETag. */
export async function readContentModule<T>(
  ctx: Context,
  request: ContentModuleRequest<T>,
  signal?: AbortSignal,
): Promise<ContentModuleRead<T>> {
  const token = await request.apiKey()
  if (token === undefined) return { failure: { kind: 'signed-out' } }

  await loadDiskCache()
  let held = memory.get(request.key)
  let heldValue = held === undefined ? undefined : request.parse(asEnvelope<unknown>(held.body).data)
  if (held !== undefined && heldValue === undefined) {
    memory.delete(request.key)
    held = undefined
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (held?.etag !== undefined) headers['If-None-Match'] = held.etag

  let reply
  try {
    reply = await requestJson(
      ctx,
      request.url,
      { method: 'GET', headers },
      request.timeoutMs,
      signal,
    )
  } catch (error: unknown) {
    return failed(heldValue, {
      kind: 'transport',
      message: error instanceof Error ? error.message : String(error),
    })
  }

  if (reply.response.status === 304 && heldValue !== undefined) return { value: heldValue }
  if (!reply.response.ok) {
    return failed(heldValue, { kind: 'http', status: reply.response.status })
  }

  const envelope = asEnvelope<unknown>(reply.body)
  if (envelope.success === false) {
    return failed(heldValue, envelope.message === undefined || envelope.message === ''
      ? { kind: 'http', status: reply.response.status }
      : { kind: 'refused', message: envelope.message })
  }
  const value = request.parse(envelope.data)
  if (value === undefined) {
    return failed(heldValue, { kind: 'refused', message: '控制台返回的内容格式无效。' })
  }

  const etag = reply.response.headers.get('etag') ?? undefined
  memory.set(request.key, {
    ...etag === undefined ? {} : { etag },
    body: reply.body,
    savedAt: Date.now(),
  })
  await persistDiskCache(ctx)
  return { value }
}

function failed<T>(held: T | undefined, failure: CatalogFailure): ContentModuleRead<T> {
  return held === undefined ? { failure } : { value: held, stale: true, failure }
}

async function loadDiskCache(): Promise<void> {
  const path = dshHomePath(CACHE_FILE)
  if (path !== cachePath) {
    cachePath = path
    memory.clear()
    loaded = undefined
    writes = Promise.resolve()
  }
  loaded ??= (async () => {
    try {
      const info = await stat(path)
      if (info.size > MAX_CACHE_BYTES) return
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<CacheFile> | null
      if (parsed?.schema !== CACHE_SCHEMA || parsed.entries === undefined) return
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (!isCacheEntry(entry)) continue
        memory.set(key, entry)
      }
    } catch {
      // Missing, truncated, or from an older schema is simply a cold cache.
    }
  })()
  await loaded
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (value === null || typeof value !== 'object') return false
  const row = value as Partial<CacheEntry>
  return Number.isFinite(row.savedAt) && row.savedAt! > 0 && 'body' in row
    && (row.etag === undefined || typeof row.etag === 'string')
}

async function persistDiskCache(ctx: Context): Promise<void> {
  writes = writes.then(async () => {
    const rows = [...memory.entries()]
      .sort((a, b) => b[1].savedAt - a[1].savedAt)
      .slice(0, MAX_CACHE_ENTRIES)
    const entries = Object.fromEntries(rows)
    const body = `${JSON.stringify({ schema: CACHE_SCHEMA, entries } satisfies CacheFile)}\n`
    if (Buffer.byteLength(body) > MAX_CACHE_BYTES) return

    const path = cachePath
    const temporary = `${path}.${process.pid}.tmp`
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 })
    try {
      await rename(temporary, path)
    } catch {
      // Windows can refuse replacing an existing destination. Cache durability
      // is preferable to leaving the completed temporary file unused.
      await rm(path, { force: true })
      await rename(temporary, path)
    }
  }).catch((error: unknown) => {
    ctx.logger.warn(`openlux: content cache write failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  await writes
}
