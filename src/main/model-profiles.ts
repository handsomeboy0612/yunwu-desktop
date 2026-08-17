import {
  THINKING_LEVELS,
  type ChatThinking,
  type ThinkingCapability,
  type ThinkingFormat
} from '@shared/types'
import { fetchDesktopConfig, readCachedDesktopConfig } from './market/market-client'

/**
 * 服务端下发的模型参数覆盖层(第二层)。
 *
 * 三层来自 WorkBuddy 的模型配置形状,我们照它做:
 *  1. 客户端本地表 —— `model-capabilities.ts` 的家族表(它的
 *     `DEFAULT_LOCAL_CUSTOM_MODEL_SETTINGS_CONFIG`);
 *  2. **服务端下发覆盖** —— 本文件(它的 `getProductConfiguration().customModelSettings`);
 *  3. 用户自己改 —— 自定义模型表单里的五个字段,优先级最高,后台改不动。
 *
 * 为什么必须有第二层:「某个模型会不会思考 / 有哪些档位 / 能不能关 / 发哪种方言」只能逐模型
 * 实测得到(2026-08-16 真机:`glm-4.7` 吃 `enable_thinking` 而 `glm-5.1` 吃 `thinking:{type}`,
 * 同族两种方言;`glm-4.5` 收到 `reasoning_effort` 直接 400)。这种事实注定要持续修,
 * 塞进客户端常量就意味着每修一条发一次版。
 *
 * 照抄 WorkBuddy 的三条失效路径设计,它们不是锦上添花:
 *  - **拉不到就回落本地**:整段吞异常,覆盖层留空,家族表照常工作;
 *  - **灰度开关**:`rollout.enabled === false` 时整份远端配置作废(后台填错了怎么回滚的答案);
 *  - **空值不覆盖**:字段缺失 = 不表态,不是「覆盖成 false」。
 *
 * ⚠️ 这条通道只下发**能力**,不下发「该用哪些模型」——清单是用户数据(2026-08-12 拍板),
 * 所以本文件不消费也不接受任何模型清单字段。
 */

/** 一条覆盖:字段缺失 = 不覆盖,沿用家族表的判断。 */
export interface ModelProfile {
  reasoning?: boolean
  onlyReasoning?: boolean
  canDisableThinking?: boolean
  thinkingLevels?: Exclude<ChatThinking, 'off'>[]
  defaultThinkingLevel?: Exclude<ChatThinking, 'off'>
  thinkingEffort?: boolean
  thinkingFormat?: ThinkingFormat
}

/** 服务端 `/api/desktop-config` 的响应形状(全部按不可信处理)。 */
interface WireProfile {
  model_name?: unknown
  provider_scope?: unknown
  category?: unknown
  reasoning?: unknown
  thinking_levels?: unknown
  default_thinking_level?: unknown
  can_disable_thinking?: unknown
  only_reasoning?: unknown
  thinking_effort?: unknown
  thinking_format?: unknown
}

interface WirePayload {
  modelProfiles?: {
    rollout?: { enabled?: unknown }
    items?: unknown
  }
}

const THINKING_FORMATS: ThinkingFormat[] = [
  'openai',
  'openrouter',
  'deepseek',
  'together',
  'qwen',
  'qwen-chat-template',
  'zai'
]

/** 作用域 + 模型名 → 覆盖。空 Map = 没有覆盖层(未登录 / 拉不到 / 灰度关闭)。 */
let overlay = new Map<string, ModelProfile>()

function keyOf(providerId: string, modelName: string): string {
  return `${providerId}/${modelName}`
}

/**
 * 逐条契约校验。**不合规整条丢弃**,不做「尽力修补」——照 WorkBuddy 的
 * `isValidLocalCustomModel`(它的注释原话是「models.json 可能由 AI 生成,内容完全不可信」)。
 * 我们这份是运营手填 + 脚本批量导入,一样不可信;半条脏数据比整条丢弃更难查。
 *
 * 返回 null 表示丢弃;调用方负责记日志。
 */
function parseProfile(raw: WireProfile): { key: string; profile: ModelProfile } | null {
  const modelName = typeof raw.model_name === 'string' ? raw.model_name.trim() : ''
  if (!modelName) {
    return null
  }
  const scope = typeof raw.provider_scope === 'string' ? raw.provider_scope.trim() : ''
  if (!scope) {
    return null
  }
  // 本期只消费对话模型。媒体参数(params)服务端已建字段,等出图/视频真有运营需求再接;
  // 现在悄悄消费它等于凭空多一条没人验过的输入。
  const category = typeof raw.category === 'string' ? raw.category.trim() : 'chat'
  if (category !== 'chat') {
    return null
  }

  const profile: ModelProfile = {}
  if (typeof raw.reasoning === 'boolean') {
    profile.reasoning = raw.reasoning
  }
  if (typeof raw.only_reasoning === 'boolean') {
    profile.onlyReasoning = raw.only_reasoning
  }
  if (typeof raw.can_disable_thinking === 'boolean') {
    profile.canDisableThinking = raw.can_disable_thinking
  }
  if (typeof raw.thinking_effort === 'boolean') {
    profile.thinkingEffort = raw.thinking_effort
  }

  if (raw.thinking_levels !== undefined && raw.thinking_levels !== null) {
    if (!Array.isArray(raw.thinking_levels)) {
      return null
    }
    const levels = raw.thinking_levels.filter(
      (l): l is Exclude<ChatThinking, 'off'> =>
        typeof l === 'string' && (THINKING_LEVELS as string[]).includes(l)
    )
    // 给了档位但没有一个认得出来(如 `["ultra"]`)= 这条数据是错的,整条丢弃。
    // 只留认得出的那部分等于把运营的错默默改成另一种错。
    if (levels.length !== raw.thinking_levels.length) {
      return null
    }
    if (levels.length > 0) {
      profile.thinkingLevels = THINKING_LEVELS.filter((l) => levels.includes(l))
    }
  }

  if (typeof raw.default_thinking_level === 'string' && raw.default_thinking_level.trim()) {
    const level = raw.default_thinking_level.trim()
    if (!(THINKING_LEVELS as string[]).includes(level)) {
      return null
    }
    if (profile.thinkingLevels && !profile.thinkingLevels.includes(level as never)) {
      return null
    }
    profile.defaultThinkingLevel = level as Exclude<ChatThinking, 'off'>
  }

  if (typeof raw.thinking_format === 'string' && raw.thinking_format.trim()) {
    const format = raw.thinking_format.trim() as ThinkingFormat
    if (!THINKING_FORMATS.includes(format)) {
      return null
    }
    profile.thinkingFormat = format
  }

  // 档位不可控却配了档位:界面会铺出一排点了不生效的假档位。服务端也拦了这一条,
  // 客户端再拦一次 —— 旧服务端 / 手改数据库都绕得过服务端那道。
  if (profile.thinkingEffort === false && profile.thinkingLevels) {
    return null
  }
  // 判成不思考就不该再带思考细节。这里不丢弃、只清干净,与 alignThinkingCapability 同口径:
  // 运营把某个模型改判成「不会思考」是正常操作,残留字段不该逼他再手动清一遍。
  if (profile.reasoning === false) {
    delete profile.thinkingLevels
    delete profile.defaultThinkingLevel
    delete profile.canDisableThinking
    delete profile.thinkingEffort
    delete profile.thinkingFormat
  }
  if (Object.keys(profile).length === 0) {
    return null
  }
  return { key: keyOf(scope, modelName), profile }
}

/** 把一份响应正文解析成覆盖表。灰度关闭 → 空表(整份作废)。 */
function buildOverlay(payload: WirePayload | null | undefined): Map<string, ModelProfile> {
  const next = new Map<string, ModelProfile>()
  const section = payload?.modelProfiles
  if (!section || section.rollout?.enabled !== true) {
    return next
  }
  const items = Array.isArray(section.items) ? section.items : []
  let dropped = 0
  for (const item of items) {
    const parsed = item && typeof item === 'object' ? parseProfile(item as WireProfile) : null
    if (!parsed) {
      dropped++
      continue
    }
    next.set(parsed.key, parsed.profile)
  }
  if (dropped > 0) {
    console.warn(`[model-profiles] 丢弃不合规档案 ${dropped} 条(整条丢弃,回落家族表)`)
  }
  return next
}

/** 覆盖表指纹:用来判「刷新之后要不要重下发」。 */
function fingerprint(map: Map<string, ModelProfile>): string {
  return [...map.entries()]
    .map(([k, p]) =>
      [
        k,
        p.reasoning === undefined ? '' : p.reasoning ? 'R' : 'r',
        p.onlyReasoning === undefined ? '' : p.onlyReasoning ? 'O' : 'o',
        p.canDisableThinking === undefined ? '' : p.canDisableThinking ? 'D' : 'd',
        (p.thinkingLevels ?? []).join('|'),
        p.defaultThinkingLevel ?? '',
        p.thinkingEffort === undefined ? '' : p.thinkingEffort ? 'E' : 'e',
        p.thinkingFormat ?? ''
      ].join(':')
    )
    .sort()
    .join(',')
}

/** 当前生效的覆盖(没有则 null)。 */
export function profileOf(providerId: string, modelName: string): ModelProfile | null {
  return overlay.get(keyOf(providerId, modelName)) ?? null
}

/**
 * 把覆盖套到一条模型能力上。**必须显式传 providerId**。
 *
 * 为什么不做成「按模型名查」:本机现成的反例是 `providers.json` 里同时有
 * `yunwu/deepseek-v4-flash` 与用户自建的 `cm-deepseek-v4-flash/deepseek-v4-flash`,
 * 后者指向别家 baseUrl。同名不同物,云雾这条覆盖套到自建那条上是纯错 ——
 * 所以签名强制带作用域,宁可多传一个参数,也不留这个歧义。
 */
export function applyProfile<
  T extends { id: string; category?: string; reasoning?: boolean } & ThinkingCapability
>(m: T, providerId: string): T {
  const p = profileOf(providerId, m.id)
  if (!p) {
    return m
  }
  const next = { ...m } as T
  if (p.reasoning !== undefined) {
    next.reasoning = p.reasoning
  }
  // 覆盖成「不会思考」时连带清掉思考细节,避免留下自相矛盾的残留(同 alignThinkingCapability)。
  if (next.reasoning === false) {
    delete next.onlyReasoning
    delete next.canDisableThinking
    delete next.thinkingLevels
    delete next.defaultThinkingLevel
    delete next.thinkingEffort
    delete next.thinkingFormat
    return next
  }
  if (p.onlyReasoning !== undefined) {
    next.onlyReasoning = p.onlyReasoning
  }
  if (p.canDisableThinking !== undefined) {
    next.canDisableThinking = p.canDisableThinking
  }
  if (p.thinkingLevels) {
    next.thinkingLevels = p.thinkingLevels
  }
  if (p.defaultThinkingLevel) {
    next.defaultThinkingLevel = p.defaultThinkingLevel
  }
  if (p.thinkingEffort !== undefined) {
    next.thinkingEffort = p.thinkingEffort
    // 档位不可控时界面不铺档位,残留的声明会跟着写进内核配置,清掉。
    if (p.thinkingEffort === false) {
      delete next.thinkingLevels
      delete next.defaultThinkingLevel
    }
  }
  if (p.thinkingFormat) {
    next.thinkingFormat = p.thinkingFormat
  }
  return next
}

/** 批量版,省得每个调用点写一遍 map。 */
export function applyProfiles<
  T extends { id: string; category?: string; reasoning?: boolean } & ThinkingCapability
>(models: T[], providerId: string): T[] {
  if (overlay.size === 0) {
    return models
  }
  return models.map((m) => applyProfile(m, providerId))
}

/**
 * 启动期只读磁盘缓存,**不打网络**。
 *
 * 硬约束来自实测:网关启动到 ready 20 秒 +,其后还有约 50 秒是忙的,而启动期每一次落盘都
 *触发一轮热加载。所以启动只吃上一次的缓存,网络刷新排到启动之后(见 refreshModelProfiles)。
 * 首次装机没有缓存 = 当作没有覆盖层,家族表照常工作,下次启动生效 —— 用一次滞后换零启动开销,
 * 与「拉不到不清空」的既有纪律同向。
 */
export function loadModelProfilesFromCache(): void {
  try {
    overlay = buildOverlay(readCachedDesktopConfig<WirePayload>())
    if (overlay.size > 0) {
      console.log(`[model-profiles] 启动读缓存:生效 ${overlay.size} 条模型参数覆盖`)
    }
  } catch (err) {
    console.warn('[model-profiles] 读缓存失败,回落家族表:', err)
    overlay = new Map()
  }
}

/**
 * 拉一次服务端配置并刷新覆盖表。返回覆盖表是否真的变了 ——
 * 变了调用方才去重下发(`syncAccountModels` 内部还会再按能力指纹判一次 noop)。
 *
 * 失败一律不清空:拉不到时保留缓存里那份,与市场那侧「快照拿不到就整轮不对账」同一条纪律。
 */
export async function refreshModelProfiles(): Promise<boolean> {
  const before = fingerprint(overlay)
  try {
    overlay = buildOverlay(await fetchDesktopConfig<WirePayload>())
  } catch (err) {
    console.warn('[model-profiles] 刷新失败,沿用现有覆盖:', err)
    return false
  }
  const after = fingerprint(overlay)
  if (before === after) {
    return false
  }
  console.log(`[model-profiles] 覆盖表更新:生效 ${overlay.size} 条`)
  return true
}

/** 仅供测试/探针:直接注入一份覆盖,不碰网络与磁盘。 */
export function __setModelProfilesForTest(items: unknown[], enabled = true): void {
  overlay = buildOverlay({ modelProfiles: { rollout: { enabled }, items } })
}
