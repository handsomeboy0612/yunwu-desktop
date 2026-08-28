/**
 * Native V2 home-content reader.
 *
 * Scenes, expert showcases, and playbooks are separate publish modules on the
 * console. They stay separate HTTP/ETag reads here as well; combining them into
 * one renderer payload must not turn a playbook edit into a scenes cache miss.
 */

import type { Context } from '@deepseek-ai/cordis'
import { asEnvelope, normalizeBase, requestJson } from '../account/http.ts'
import { readContentModule } from './content-cache.ts'
import { ConsoleError, type ConsoleAccess } from './console.ts'
import type {
  CatalogFailure,
  HomeContent,
  HomeExpertRef,
  HomePlaybook,
  HomeScene,
  HomeShowcase,
  PlaybookArtifact,
} from './wire.ts'

const HOME_TIMEOUT_MS = 12_000

export async function readHomeContent(
  ctx: Context,
  access: ConsoleAccess,
  signal?: AbortSignal,
): Promise<HomeContent> {
  const base = normalizeBase(access.baseUrl)
  const token = access.apiKey()
  const apiKey = (): Promise<string | undefined> => token
  const [scenes, showcases, playbooks] = await Promise.all([
    readContentModule(ctx, {
      key: `${base}|home-scenes`,
      url: `${base}/api/desktop-content/home-scenes`,
      apiKey,
      timeoutMs: HOME_TIMEOUT_MS,
      parse: scenesOf,
    }, signal),
    readContentModule(ctx, {
      key: `${base}|home-showcases`,
      url: `${base}/api/desktop-content/expert-showcases`,
      apiKey,
      timeoutMs: HOME_TIMEOUT_MS,
      parse: showcasesOf,
    }, signal),
    readContentModule(ctx, {
      key: `${base}|home-playbooks`,
      url: `${base}/api/desktop-content/playbooks`,
      apiKey,
      timeoutMs: HOME_TIMEOUT_MS,
      parse: playbooksOf,
    }, signal),
  ])
  const failure = firstFailure(scenes.failure, showcases.failure, playbooks.failure)
  return {
    scenes: scenes.value ?? [],
    showcases: showcases.value ?? [],
    playbooks: playbooks.value ?? [],
    ...scenes.stale === true || showcases.stale === true || playbooks.stale === true
      ? { stale: true }
      : {},
    ...failure === undefined ? {} : { failure },
  }
}

/**
 * Read only the curated scene strip used by the expert center.
 *
 * The blank-session home no longer renders product content, so opening the
 * market must not also fetch home chips and every playbook. This projection
 * keeps the same durable cache key as the combined legacy reader.
 */
export async function readFeaturedScenes(
  ctx: Context,
  access: ConsoleAccess,
  signal?: AbortSignal,
): Promise<readonly HomeShowcase[]> {
  const base = normalizeBase(access.baseUrl)
  const token = access.apiKey()
  const result = await readContentModule(ctx, {
    key: `${base}|home-showcases`,
    url: `${base}/api/desktop-content/expert-showcases`,
    apiKey: (): Promise<string | undefined> => token,
    timeoutMs: HOME_TIMEOUT_MS,
    parse: showcasesOf,
  }, signal)
  if (result.value !== undefined) return result.value
  const failure = result.failure
  if (failure?.kind === 'signed-out') throw new ConsoleError('当前没有登录凭据，无法读取精选场景。')
  if (failure?.kind === 'http') throw new ConsoleError(`精选场景读取失败（HTTP ${failure.status}）。`)
  if (failure?.kind === 'refused') throw new ConsoleError(failure.message)
  if (failure?.kind === 'transport') throw new ConsoleError(failure.message)
  throw new ConsoleError('控制台没有返回可用的精选场景。')
}

/**
 * Read the three use cases attached to one expert or team.
 *
 * This is a separate projection from home playbooks: a case does not need a
 * home scene to be useful on an expert detail page.
 */
export async function readRelatedPlaybooks(
  ctx: Context,
  access: ConsoleAccess,
  expertSlug: string,
  signal?: AbortSignal,
): Promise<readonly HomePlaybook[]> {
  const slug = expertSlug.trim().toLowerCase()
  if (slug === '') return []
  const base = normalizeBase(access.baseUrl)
  const token = access.apiKey()
  const result = await readContentModule(ctx, {
    key: `${base}|related-playbooks|${slug}`,
    url: `${base}/api/desktop-content/playbooks?expert_slug=${encodeURIComponent(slug)}`,
    apiKey: (): Promise<string | undefined> => token,
    timeoutMs: HOME_TIMEOUT_MS,
    parse: playbooksOf,
  }, signal)
  if (result.value !== undefined) return result.value
  const failure = result.failure
  if (failure?.kind === 'signed-out') throw new ConsoleError('当前没有登录凭据，无法读取使用案例。')
  if (failure?.kind === 'http') throw new ConsoleError(`使用案例读取失败（HTTP ${failure.status}）。`)
  if (failure?.kind === 'refused') throw new ConsoleError(failure.message)
  if (failure?.kind === 'transport') throw new ConsoleError(failure.message)
  throw new ConsoleError('控制台没有返回可用的使用案例。')
}

/** Resolve the current revision only when the user opens a case. */
export async function readPlaybookArtifact(
  ctx: Context,
  access: ConsoleAccess,
  id: number,
  signal?: AbortSignal,
): Promise<PlaybookArtifact> {
  if (!Number.isSafeInteger(id) || id <= 0) throw new ConsoleError('案例编号无效。')
  const token = await access.apiKey()
  if (token === undefined) throw new ConsoleError('当前没有登录凭据，无法读取案例。')
  const reply = await requestJson(
    ctx,
    `${normalizeBase(access.baseUrl)}/api/desktop-content/playbooks/${id}/artifact-url`,
    { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
    HOME_TIMEOUT_MS,
    signal,
  )
  const envelope = asEnvelope<{ url?: unknown; artifact_type?: unknown }>(reply.body)
  if (!reply.response.ok || envelope.success === false) {
    throw new ConsoleError(envelope.message === undefined || envelope.message === ''
      ? `控制台返回 HTTP ${reply.response.status}。`
      : envelope.message)
  }
  const url = text(envelope.data?.url)
  const artifactType = text(envelope.data?.artifact_type)
  if (url === '' || artifactType === '') throw new ConsoleError('控制台没有返回可打开的案例产物。')
  return { url, artifactType }
}

function scenesOf(raw: unknown): HomeScene[] | undefined {
  const items = moduleItems(raw)
  if (items === undefined) return undefined
  return items.flatMap(entry => {
    const row = record(entry)
    const id = positive(row['id'])
    const slug = text(row['slug'])
    if (id === 0 || slug === '') return []
    const prompts = array(row['prompts']).flatMap(promptEntry => {
      const prompt = record(promptEntry)
      const body = text(prompt['prompt'])
      return body === '' ? [] : [{ title: text(prompt['title']), prompt: body }]
    })
    return [{
      id,
      slug,
      name: text(row['name_zh']) || slug,
      mode: text(row['mode']),
      iconKey: text(row['icon_key']),
      prompts,
      experts: expertsOf(row['experts']),
    }]
  })
}

function showcasesOf(raw: unknown): HomeShowcase[] | undefined {
  const items = moduleItems(raw)
  if (items === undefined) return undefined
  return items.flatMap(entry => {
    const row = record(entry)
    const id = positive(row['id'])
    const slug = text(row['slug'])
    if (id === 0 || slug === '') return []
    return [{
      id,
      slug,
      title: text(row['title_zh']) || slug,
      subtitle: text(row['subtitle_zh']),
      description: text(row['description']),
      initPrompt: text(row['init_prompt']),
      cover: nestedText(row['cover_asset'], 'url'),
      experts: expertsOf(row['experts']),
    }]
  })
}

function playbooksOf(raw: unknown): HomePlaybook[] | undefined {
  const items = moduleItems(raw)
  if (items === undefined) return undefined
  return items.flatMap(entry => {
    const row = record(entry)
    const id = positive(row['id'])
    const slug = text(row['slug'])
    if (id === 0 || slug === '') return []
    return [{
      id,
      slug,
      title: text(row['title_zh']) || slug,
      titleEn: text(row['title_en']),
      subtitle: text(row['subtitle_zh']),
      subtitleEn: text(row['subtitle_en']),
      description: text(row['description']),
      descriptionEn: text(row['description_en']),
      initPrompt: text(row['init_prompt']),
      initPromptEn: text(row['init_prompt_en']),
      sceneSlug: text(row['scene_slug']),
      cover: nestedText(row['cover_asset'], 'url'),
      coverEn: nestedText(row['cover_asset_en'], 'url'),
      artifactType: nestedText(row['current_revision'], 'artifact_type'),
      sortOrder: positive(row['sort_order']),
      experts: expertsOf(row['experts']),
      tags: array(row['tags']).map(entry => nestedText(entry, 'name_zh')).filter(Boolean),
      tagsEn: array(row['tags']).map(entry => nestedText(entry, 'name_en')),
    }]
  })
}

function expertsOf(raw: unknown): HomeExpertRef[] {
  return array(raw).flatMap(entry => {
    const row = record(entry)
    const id = positive(row['id'])
    const slug = text(row['slug'])
    return id === 0 || slug === '' ? [] : [{ id, slug, name: text(row['name_zh']) || slug }]
  })
}

function moduleItems(raw: unknown): unknown[] | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const items = (raw as Record<string, unknown>)['items']
  return Array.isArray(items) ? items : undefined
}

function firstFailure(...failures: readonly (CatalogFailure | undefined)[]): CatalogFailure | undefined {
  return failures.find(failure => failure !== undefined)
}

function array(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : []
}

function record(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
}

function nestedText(raw: unknown, key: string): string {
  return text(record(raw)[key])
}

function text(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

function positive(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}
