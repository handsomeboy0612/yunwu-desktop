import type { ConsoleAccess } from '../market/console.ts'

/** Four runtime purposes delivered as one atomic server snapshot. */
export interface DeliveredModelConfig {
  readonly configured: boolean
  readonly revision: number
  readonly chatModels: readonly string[]
  readonly searchModels: readonly string[]
  readonly defaultImageModel?: string
  readonly defaultVideoModel?: string
}

interface DeliveryWire {
  readonly configured?: boolean | number
  readonly revision?: number
  readonly intent_revision?: number
  readonly effective_revision?: string
  readonly intent?: DeliveryIntentWire
  readonly chat_models?: unknown
  readonly search_models?: unknown
  readonly default_image_model?: unknown
  readonly default_video_model?: unknown
}

interface DeliveryIntentWire {
  readonly configured?: boolean | number
  readonly revision?: number
  readonly chat_models?: unknown
  readonly search_models?: unknown
  readonly default_image_model?: unknown
  readonly default_video_model?: unknown
}

interface ApiEnvelope {
  readonly success?: boolean
  readonly message?: string
  readonly data?: DeliveryWire
}

const DELIVERY_TIMEOUT_MS = 8_000

function normalizeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

function normalizedOptionalName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.trim()
  return name === '' ? undefined : name
}

/**
 * Fetch the server-owned model-purpose snapshot with the desktop token.
 *
 * An unreachable endpoint throws, while `configured:false` is a valid answer. Callers use that
 * distinction to preserve the packaged defaults on old/unconfigured deployments without treating
 * a transient network failure as an instruction to clear anything.
 */
export async function fetchDeliveredModelConfig(
  access: ConsoleAccess,
  signal?: AbortSignal,
): Promise<DeliveredModelConfig> {
  const token = await access.apiKey()
  if (token === undefined || token.trim() === '') throw new Error('no desktop token')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(`${access.baseUrl.replace(/\/+$/, '')}/api/desktop-config/model-delivery`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`model delivery returned HTTP ${String(response.status)}`)
    }
    const envelope = await response.json() as ApiEnvelope
    if (envelope.success !== true || envelope.data === undefined) {
      throw new Error(envelope.message?.trim() || 'model delivery returned an invalid envelope')
    }
    const wire = envelope.data
    // New clients consume the global, unfiltered intent. The top-level fields
    // remain the token-specific effective projection for old clients.
    const source = wire.intent ?? wire
    const configured = source.configured === true || source.configured === 1
    const defaultImageModel = normalizedOptionalName(source.default_image_model)
    const defaultVideoModel = normalizedOptionalName(source.default_video_model)
    return {
      configured,
      revision: typeof wire.intent_revision === 'number'
        ? wire.intent_revision
        : typeof source.revision === 'number'
          ? source.revision
          : typeof wire.revision === 'number' ? wire.revision : 0,
      chatModels: normalizeNames(source.chat_models),
      searchModels: normalizeNames(source.search_models),
      ...defaultImageModel === undefined ? {} : { defaultImageModel },
      ...defaultVideoModel === undefined ? {} : { defaultVideoModel },
    }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}
