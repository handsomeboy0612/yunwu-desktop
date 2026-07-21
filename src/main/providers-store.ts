import { app, safeStorage } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { ActivationConfig, ProviderConfig, ProviderModel } from '@shared/types'

/**
 * 模型管理的单一数据源:userData/providers.json。
 *
 * 设计:
 *  - App 侧以 providers.json 为准,声明式整体渲染进 openclaw.json(见 config-writer),
 *    靠内核 chokidar 文件监听热加载,不重启网关。
 *  - API Key 落盘时用 Electron safeStorage(操作系统钥匙串)加密;不可用时降级明文。
 *  - 内置 yunwu 供货商随登录自动写入(builtin:true),不可删除、Key 随账号维护。
 */

/** providers.json 路径。 */
function providersFile(): string {
  return join(app.getPath('userData'), 'providers.json')
}

/** 加密标记前缀:据此区分密文与降级明文。 */
const ENC_PREFIX = 'enc:v1:'

/** 加密 API Key;safeStorage 不可用时降级为明文(仍可用)。 */
function encryptKey(plain: string): string {
  if (!plain) {
    return ''
  }
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
    }
  } catch {
    /* 加密失败降级明文 */
  }
  return plain
}

/** 解密 API Key;非密文(降级明文)原样返回。 */
function decryptKey(stored: string): string {
  if (!stored) {
    return ''
  }
  if (stored.startsWith(ENC_PREFIX)) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
    } catch {
      return ''
    }
  }
  return stored
}

/** 读取供货商配置(apiKey 解密为明文,供渲染层展示/编辑与内核写入)。 */
export function loadProviders(): ProviderConfig[] {
  const file = providersFile()
  if (!existsSync(file)) {
    return []
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    if (!Array.isArray(raw)) {
      return []
    }
    return (raw as ProviderConfig[])
      .filter((p) => p && typeof p.id === 'string')
      .map((p) => ({ ...p, apiKey: decryptKey(p.apiKey ?? '') }))
  } catch {
    return []
  }
}

/** 覆盖写入供货商配置(apiKey 加密落盘)。 */
export function saveProviders(providers: ProviderConfig[]): void {
  const toStore = providers.map((p) => ({ ...p, apiKey: encryptKey(p.apiKey ?? '') }))
  writeFileSync(providersFile(), JSON.stringify(toStore, null, 2), 'utf-8')
}

/** 从激活配置构造内置 yunwu 供货商(能力沿用 ActivationConfig.models 的推导结果)。 */
export function yunwuProviderFromActivation(config: ActivationConfig): ProviderConfig {
  const models: ProviderModel[] = config.models.map((m) => ({
    id: m.id,
    reasoning: m.reasoning,
    vision: m.vision,
    tools: m.tools,
    category: m.category
  }))
  return {
    id: 'yunwu',
    label: '云雾',
    preset: 'yunwu',
    api: 'openai-completions',
    baseUrl: config.baseUrl.replace(/\/+$/, '') + '/v1',
    apiKey: config.token,
    builtin: true,
    models
  }
}

/**
 * 用激活配置 upsert 内置 yunwu 供货商:保留用户添加的第三方供货商,仅替换 yunwu。
 * 返回 upsert 后的完整列表(未落盘,由调用方负责保存)。
 */
export function upsertYunwuProvider(config: ActivationConfig): ProviderConfig[] {
  const others = loadProviders().filter((p) => p.id !== 'yunwu')
  return [yunwuProviderFromActivation(config), ...others]
}

/** 删除某供货商(内置 yunwu 不可删);返回删除后的列表并落盘。 */
export function deleteProvider(id: string): ProviderConfig[] {
  const next = loadProviders().filter((p) => !(p.id === id && !p.builtin))
  saveProviders(next)
  return next
}
