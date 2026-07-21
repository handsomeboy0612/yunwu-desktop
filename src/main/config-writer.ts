import { writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ActivationConfig, ChatThinking, ProviderConfig, ProviderModel } from '@shared/types'
import { runOpenClaw } from './openclaw-cli'
import { upsertYunwuProvider, saveProviders } from './providers-store'

/**
 * OpenClaw 模型 metadata 默认值。OpenClaw 的 batch-json schema 要求
 * contextWindow / maxTokens 非空,这里给保守默认值(与云雾服务端保持一致)。
 */
const MODEL_CONTEXT_WINDOW = 128000
const MODEL_MAX_TOKENS = 8192

/**
 * 把模型名转成短 alias:去掉 . - _ / 空格,全小写,截到 16 字符。
 * 让用户能在聊天里用 /model gpt54 之类短名切换。与云雾服务端 modelAlias 逻辑一致。
 */
function modelAlias(m: string): string {
  const a = m.replace(/[.\-_/ ]/g, '').toLowerCase()
  return a.length > 16 ? a.slice(0, 16) : a
}

/** 思考强度阶梯(不含 off),与 OpenClaw thinkingLevelMap 键一致。 */
const THINKING_LADDER: Exclude<ChatThinking, 'off'>[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * 单个思考档位映射到 openai 兼容协议的 reasoning_effort 值:
 * max 在 openai 兼容下等价 xhigh(与内核 openai-completions 一致:max→xhigh),其余透传。
 */
function effortValue(level: Exclude<ChatThinking, 'off'>): string {
  return level === 'max' ? 'xhigh' : level
}

/**
 * 构造内核单个模型条目(带能力标记)。这是"零安装自动思考"的关键:
 *  - reasoning:true → 内核视为推理模型,深度思考不被降级为 off,并解析 reasoning_content;
 *  - compat.supportsReasoningEffort:true → 允许把思考档位转成 reasoning_effort 下发(已实测云雾接受);
 *  - input:["text","image"] → 视觉模型可接收图片附件。
 *
 * 思考强度声明(对齐 WorkBuddy「支持的思考强度」):当模型声明 thinkingLevels 时,
 *  - 顶层 thinkingLevelMap:控制运行期 clampThinkingLevel 的可用档位——已声明档位映射到其
 *    reasoning_effort 值,未声明档位置 null(内核据此从可用集中剔除),从而能放出 xhigh/max;
 *  - compat.supportedReasoningEfforts:供 openai 兼容能力层校验用。
 * 未声明则保持最小配置,由内核按模型默认能力(通常 low/medium/high)自行判定。
 */
function buildModelEntry(m: ProviderModel): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: m.id,
    name: m.name || m.id,
    contextWindow: m.contextWindow ?? MODEL_CONTEXT_WINDOW,
    maxTokens: m.maxTokens ?? MODEL_MAX_TOKENS
  }
  if (m.reasoning) {
    entry.reasoning = true
    const compat: Record<string, unknown> = { supportsReasoningEffort: true }
    const levels = (m.thinkingLevels ?? []).filter((l) => THINKING_LADDER.includes(l))
    if (levels.length > 0) {
      const map: Record<string, string | null> = {}
      for (const l of THINKING_LADDER) {
        map[l] = levels.includes(l) ? effortValue(l) : null
      }
      entry.thinkingLevelMap = map
      compat.supportedReasoningEfforts = Array.from(new Set(levels.map(effortValue)))
    }
    entry.compat = compat
  }
  if (m.vision) {
    entry.input = ['text', 'image']
  }
  return entry
}

/** 构造 models.providers 全量对象(声明式:整体替换,删除的供货商会被移除)。 */
function buildProvidersValue(providers: ProviderConfig[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of providers) {
    const value: Record<string, unknown> = {
      baseUrl: p.baseUrl.replace(/\/+$/, ''),
      api: p.api,
      models: p.models.map(buildModelEntry)
    }
    // 本地部署(如 Ollama)可无 Key;空 Key 不写,避免 provider 鉴权误判。
    if (p.apiKey) {
      value.apiKey = p.apiKey
    }
    out[p.id] = value
  }
  return out
}

/**
 * 构造 agents.defaults.models allowlist(键为 `<provider>/<model>`,仅 chat 类)。
 * 跨供货商 alias 去重:冲突时省略 alias(alias 仅为便捷短名,可缺省)。
 */
function buildAllowlistValue(providers: ProviderConfig[]): Record<string, unknown> {
  const allow: Record<string, unknown> = {}
  const usedAlias = new Set<string>()
  for (const p of providers) {
    for (const m of p.models) {
      if (m.category !== 'chat') {
        continue
      }
      const key = `${p.id}/${m.id}`
      const alias = modelAlias(m.id)
      if (alias && !usedAlias.has(alias)) {
        usedAlias.add(alias)
        allow[key] = { alias }
      } else {
        allow[key] = {}
      }
    }
  }
  return allow
}

/** 全部可作对话的模型键 `<provider>/<model>`(chat 类)。 */
function chatModelKeys(providers: ProviderConfig[]): string[] {
  const keys: string[] = []
  for (const p of providers) {
    for (const m of p.models) {
      if (m.category === 'chat') {
        keys.push(`${p.id}/${m.id}`)
      }
    }
  }
  return keys
}

/**
 * 解析默认主模型:优先沿用 preferred(若仍存在于 chat 模型中),否则回退首个 chat 模型。
 * 保证 primary 始终指向一个有效的对话模型,避免删模型后 primary 悬空。
 */
export function resolvePrimary(providers: ProviderConfig[], preferred?: string): string {
  const keys = chatModelKeys(providers)
  if (preferred && keys.includes(preferred)) {
    return preferred
  }
  return keys[0] ?? ''
}

/**
 * 拼装本地桌面首启的一次性配置。与云雾云端 bootstrap 的差异:
 *  - gateway.bind = loopback(仅本机访问,桌面客户端通过 127.0.0.1 连接,更安全);
 *    云端为了让 K8s ClusterIP 访问用的是 lan。
 *  - allowedOrigins 覆盖本地回环端口 + Electron 渲染进程来源。
 *  - gateway.auth.mode = none:仅回环下跳过共享密钥连接鉴权,是桌面端 WS 客户端
 *    (gateway-client)能建立连接的前提。安全性由 bind=loopback 保证(不对外暴露);
 *    客户端仍通过 ed25519 设备身份在回环自动配对以获得 operator scopes。
 *
 * 安全提示(后续硬化项):dangerouslyDisableDeviceAuth 暂设 true 以简化本地
 * Control UI(浏览器)联调;正式版应改为设备配对或本地网关令牌鉴权。
 */
/** 网关引导设置(仅首启/激活时需要;供货商更新无需重复下发)。 */
function bootstrapEntries(): Array<Record<string, unknown>> {
  return [
    { path: 'gateway.mode', value: 'local' },
    { path: 'gateway.bind', value: 'loopback' },
    { path: 'gateway.auth.mode', value: 'none' },
    {
      path: 'gateway.controlUi.allowedOrigins',
      value: ['http://127.0.0.1:18789', 'http://localhost:18789']
    },
    { path: 'gateway.controlUi.dangerouslyDisableDeviceAuth', value: true }
  ]
}

/**
 * 声明式渲染供货商 + allowlist + primary 进 openclaw.json。
 *
 * 实现选择:不手写 JSON 文件(易与 OpenClaw 内部 schema 漂移),而是调用官方
 * `openclaw config set --batch-file <path> --replace`,由 OpenClaw 校验并整体替换。
 *  - 设置父路径 `models.providers` 为全量对象 → 删除的供货商会被移除(声明式);
 *  - `agents.defaults.models` 全量替换 allowlist;
 *  - `--batch-file` 传文件路径而非内联 JSON,规避 Windows shell 转义问题。
 * 写入后内核 chokidar 监听 openclaw.json 变化,models.* 走热加载不重启网关。
 */
async function renderConfig(
  providers: ProviderConfig[],
  preferredPrimary: string | undefined,
  includeBootstrap: boolean
): Promise<void> {
  const primary = resolvePrimary(providers, preferredPrimary)
  const batch: Array<Record<string, unknown>> = []
  if (includeBootstrap) {
    batch.push(...bootstrapEntries())
  }
  batch.push({ path: 'models.providers', value: buildProvidersValue(providers) })
  batch.push({ path: 'agents.defaults.models', value: buildAllowlistValue(providers) })
  if (primary) {
    batch.push({ path: 'agents.defaults.model.primary', value: primary })
  }

  const file = join(tmpdir(), `yunwu-openclaw-batch-${Date.now()}.json`)
  writeFileSync(file, JSON.stringify(batch), 'utf-8')
  try {
    await runOpenClaw(['config', 'set', '--batch-file', file, '--replace'])
  } finally {
    try {
      rmSync(file)
    } catch {
      /* 清理失败不影响主流程 */
    }
  }
}

/**
 * 把激活配置写入本地 OpenClaw(~/.openclaw/openclaw.json)。
 * 激活流亦纳入单一数据源:把云雾账号 upsert 进 providers.json,再声明式整体渲染。
 */
export async function writeOpenClawConfig(config: ActivationConfig): Promise<void> {
  const providers = upsertYunwuProvider(config)
  saveProviders(providers)
  await renderConfig(providers, `yunwu/${config.defaultModel}`, true)
}

/**
 * 保存供货商配置并渲染进 openclaw.json(模型管理页保存入口)。
 * preferredPrimary 用于尽量保留用户当前默认模型;失效时回退首个可用 chat 模型。
 */
export async function applyProvidersConfig(
  providers: ProviderConfig[],
  preferredPrimary?: string
): Promise<void> {
  saveProviders(providers)
  await renderConfig(providers, preferredPrimary, false)
}
