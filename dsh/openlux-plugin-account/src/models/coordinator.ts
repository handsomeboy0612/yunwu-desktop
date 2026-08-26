/**
 * One process-local owner for model synchronization.
 *
 * Network preparation is latest-wins; settings commits are serialized and
 * re-check both the generation and credential digest immediately before write.
 * The runtime state is never persisted and never contains a plaintext key.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ConsoleAccess } from '../market/console.ts'
import { invalidateRuntimeModelCaches } from './runtime-cache.ts'
import { syncModels, type SyncOutcome } from './sync.ts'

const API_KEY_REF = credentialRef('OPENLUX_API_KEY')

export interface MutableModelDefaults {
  imageModel: string | undefined
  videoModel: string | undefined
  searchModels: readonly string[]
}

export interface RuntimeModelAccess {
  readonly baseUrl: string
  readonly apiKey: string
  readonly generation: number
  readonly tokenDigest: string
}

export interface ModelSyncStatus {
  readonly generation: number
  readonly refreshedAt?: number
  readonly outcome?: SyncOutcome
}

export class ModelSyncCoordinator {
  private generation = 0
  private active: AbortController | undefined
  private writeTail: Promise<unknown> = Promise.resolve()
  private readonly baseline: MutableModelDefaults
  private refreshedAt: number | undefined
  private lastOutcome: SyncOutcome | undefined

  constructor(
    private readonly ctx: Context,
    private readonly modelBaseUrl: string,
    private readonly configAccess: ConsoleAccess,
    private readonly defaults: MutableModelDefaults,
  ) {
    this.baseline = {
      imageModel: defaults.imageModel,
      videoModel: defaults.videoModel,
      searchModels: [...defaults.searchModels],
    }
  }

  /** Resolve one immutable token snapshot for a complete tool invocation. */
  async captureAccess(): Promise<RuntimeModelAccess> {
    const resolved = await this.ctx.credentials.resolve(API_KEY_REF)
    if (resolved === undefined || resolved.value.trim() === '') throw new Error('当前没有可用的桌面令牌')
    return {
      baseUrl: this.modelBaseUrl,
      apiKey: resolved.value,
      generation: this.generation,
      tokenDigest: digest(resolved.value),
    }
  }

  /** Whether an invocation still belongs to the active account generation. */
  async isCurrent(access: RuntimeModelAccess): Promise<boolean> {
    if (access.generation !== this.generation) return false
    const resolved = await this.ctx.credentials.resolve(API_KEY_REF)
    return resolved !== undefined && digest(resolved.value) === access.tokenDigest
  }

  /**
   * Read every model fact for a candidate token without changing settings.
   * Used before a credential switch so a bad/expired candidate changes nothing.
   */
  async preflight(apiKey: string, signal?: AbortSignal): Promise<SyncOutcome> {
    invalidateRuntimeModelCaches()
    const outcome = await syncModels(
      this.ctx,
      {
        model: { baseUrl: this.modelBaseUrl, apiKey: async () => apiKey },
        config: this.configAccess,
      },
      signal,
      { commit: false },
    )
    if (outcome.skipped !== 'prepared' || (outcome.models ?? 0) === 0) {
      throw new Error('候选令牌无法读取完整模型目录，当前令牌未切换')
    }
    return outcome
  }

  /**
   * Run one latest-wins round. Reads may overlap; only the commit section joins
   * the write queue, and stale rounds are refused inside that queue.
   */
  async refresh(reason: string, signal?: AbortSignal, exactKey?: string): Promise<SyncOutcome> {
    if (reason === 'manual') invalidateRuntimeModelCaches()
    const generation = ++this.generation
    this.active?.abort()
    const controller = new AbortController()
    this.active = controller
    const unlink = linkAbort(signal, controller)
    try {
      const apiKey = exactKey ?? await this.resolveKey()
      if (apiKey === undefined) return { changed: false, skipped: 'no-key' }
      const tokenDigest = digest(apiKey)
      const outcome = await syncModels(
        this.ctx,
        {
          model: { baseUrl: this.modelBaseUrl, apiKey: async () => apiKey },
          config: this.configAccess,
        },
        controller.signal,
        {
          canCommit: async () => {
            if (generation !== this.generation || controller.signal.aborted) return false
            const current = await this.ctx.credentials.resolve(API_KEY_REF)
            return current !== undefined && digest(current.value) === tokenDigest
          },
          serializeWrite: task => this.serializeWrite(task),
        },
      )
      if (generation !== this.generation || outcome.skipped === 'stale') {
        return { changed: false, skipped: 'stale' }
      }
      if (outcome.models !== undefined && outcome.delivery !== undefined) {
        this.applyDefaults(outcome)
      }
      this.refreshedAt = Date.now()
      this.lastOutcome = outcome
      this.log(reason, outcome)
      return outcome
    } finally {
      unlink()
      if (this.active === controller) this.active = undefined
    }
  }

  /** Invalidate in-flight reads and token-scoped directory cache on logout. */
  invalidate(): void {
    this.generation += 1
    this.active?.abort()
    this.active = undefined
    invalidateRuntimeModelCaches()
  }

  status(): ModelSyncStatus {
    return {
      generation: this.generation,
      ...this.refreshedAt === undefined ? {} : { refreshedAt: this.refreshedAt },
      ...this.lastOutcome === undefined ? {} : { outcome: this.lastOutcome },
    }
  }

  private async resolveKey(): Promise<string | undefined> {
    return await this.ctx.credentials.resolve(API_KEY_REF)
      .then(hit => hit?.value)
      .catch(() => undefined)
  }

  private serializeWrite<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(task, task)
    this.writeTail = result.catch(() => undefined)
    return result
  }

  private applyDefaults(outcome: SyncOutcome): void {
    const delivery = outcome.delivery
    if (delivery === undefined) return
    // Every successful snapshot is complete. Empty values deliberately restore
    // the immutable packaged/config baseline instead of retaining another
    // token's defaults.
    this.defaults.imageModel = delivery.defaultImageModel ?? this.baseline.imageModel
    this.defaults.videoModel = delivery.defaultVideoModel ?? this.baseline.videoModel
    this.defaults.searchModels = delivery.searchModels.length > 0
      ? [...delivery.searchModels]
      : [...this.baseline.searchModels]
  }

  private log(reason: string, outcome: SyncOutcome): void {
    if (outcome.changed) {
      this.ctx.logger.info(`openlux: model delivery synced (${reason}): `
        + `${outcome.models ?? 0} chat models, `
        + `${outcome.delivery?.searchModels.length ?? 0} search models, `
        + `image=${this.defaults.imageModel ?? 'catalogue'}, `
        + `video=${this.defaults.videoModel ?? 'catalogue'}`)
      return
    }
    this.ctx.logger.debug(`openlux: model sync (${reason}) changed nothing: ${outcome.skipped}`)
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function linkAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (signal === undefined) return () => {}
  if (signal.aborted) controller.abort()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
}
