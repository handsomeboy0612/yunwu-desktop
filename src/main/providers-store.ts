import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { ActivationConfig, ProviderConfig, ProviderModel } from '@shared/types'
import { decryptSecret, encryptSecret } from './secret-box'

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

/** API Key 的加解密走 secret-box(与会话 cookie 同一套编码,前缀一致故老密文照样能读)。 */
const encryptKey = encryptSecret
const decryptKey = decryptSecret

/** 读取磁盘上的原始条目(apiKey 仍为密文/降级明文)。 */
function readStored(): ProviderConfig[] {
  const file = providersFile()
  if (!existsSync(file)) {
    return []
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    if (!Array.isArray(raw)) {
      return []
    }
    return (raw as ProviderConfig[]).filter((p) => p && typeof p.id === 'string')
  } catch {
    return []
  }
}

/** 读取供货商配置(apiKey 解密为明文,供渲染层展示/编辑与内核写入)。 */
export function loadProviders(): ProviderConfig[] {
  return readStored().map((p) => ({ ...p, apiKey: decryptKey(p.apiKey ?? '') }))
}

/**
 * 覆盖写入供货商配置(apiKey 加密落盘)。
 *
 * 空 Key 保护:待写条目的 Key 为空、而磁盘上同 id 条目已有 Key 时,保留磁盘上的原值。
 * 因为 decryptKey 解密失败时返回空串,若原样写回就会把用户的 Key **永久抹掉**且毫无提示
 * ——一次偶发的钥匙串读取失败足以让所有模型集体失效。需要 Key 的供货商在 UI 层本就不允许
 * 留空,本地部署(无 Key)则磁盘上也没有可保留的旧值,故这条保护不会挡到任何正常路径。
 */
export function saveProviders(providers: ProviderConfig[]): void {
  const stored = new Map(readStored().map((p) => [p.id, p.apiKey ?? '']))
  const toStore = providers.map((p) => ({
    ...p,
    apiKey: p.apiKey ? encryptKey(p.apiKey) : stored.get(p.id) ?? ''
  }))
  writeFileSync(providersFile(), JSON.stringify(toStore, null, 2), 'utf-8')
}

/**
 * 按 id upsert 单个供货商(存在则替换,否则追加),返回落盘后的完整列表。
 *
 * 模型管理页的增/改走这里,而不是把整张表覆盖写回:后者意味着编辑任意一个模型都要重写
 * **所有**模型的 Key,页面内存里任何一条状态不对都会波及全部条目。按 id 单条写入后,
 * 改 A 在物理上就碰不到 B。(对齐 WorkBuddy 的 models.json:一条记录一个模型、各自带 Key。)
 */
export function upsertProvider(provider: ProviderConfig): ProviderConfig[] {
  const list = loadProviders()
  const idx = list.findIndex((p) => p.id === provider.id)
  if (idx >= 0) {
    list[idx] = provider
  } else {
    list.push(provider)
  }
  saveProviders(list)
  return list
}

/** 从激活配置构造内置 yunwu 供货商(能力沿用 ActivationConfig.models 的推导结果)。 */
export function yunwuProviderFromActivation(config: ActivationConfig): ProviderConfig {
  const models: ProviderModel[] = config.models.map((m) => ({
    id: m.id,
    reasoning: m.reasoning,
    vision: m.vision,
    tools: m.tools,
    category: m.category,
    // 只有偏离供货商默认协议的那批带值(gpt-5 pro / codex 系列只吃 /v1/responses)。
    ...(m.api ? { api: m.api } : {}),
    // 思考声明:家族表命中的模型才有,`config-writer` 据此写 thinkingLevelMap。
    ...(m.thinkingLevels?.length ? { thinkingLevels: m.thinkingLevels } : {}),
    ...(m.defaultThinkingLevel ? { defaultThinkingLevel: m.defaultThinkingLevel } : {}),
    ...(m.canDisableThinking === false ? { canDisableThinking: false } : {}),
    ...(m.thinkingEffort === false ? { thinkingEffort: false } : {}),
    ...(m.thinkingFormat ? { thinkingFormat: m.thinkingFormat } : {})
  }))
  return {
    id: 'yunwu',
    label: '云雾',
    preset: 'yunwu',
    // 供货商级默认:云雾 279 条模型标的都是 `openai`,少数特例在 models[].api 上单独覆盖。
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
