import { writeFileSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import type {
  ActivationConfig,
  ChatThinking,
  MediaSelection,
  ModelInfo,
  ProviderConfig,
  ProviderModel,
  ThinkingCapability
} from '@shared/types'
import {
  AUDIO_MODEL_PREFERENCE,
  IMAGE_MODEL_PREFERENCE,
  SEARCH_FALLBACK_MODELS,
  VIDEO_MODEL_PREFERENCE
} from '@shared/public-models'
import {
  resolveAccountMediaModels,
  resolveAccountModels,
  resolveActivation,
  saveSelectedChatModels
} from './model-catalog'
import { runOpenClaw } from './openclaw-cli'
import { gatewayClient, viaGatewayOrCli } from './gateway-client'
import {
  applyConfigEntries,
  configBatchIsNoop,
  deleteConfigPath,
  type ConfigEntry
} from './config-entries'
import { UI_TOOLS_SERVER_NAME } from './ui-tools-bundle'
import { loadActivation, saveActivation } from './store'
import {
  upsertYunwuProvider,
  saveProviders,
  loadProviders,
  upsertProvider
} from './providers-store'

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
  // 单模型协议覆盖:内核解析成 `raw.api ?? providerApi`(`config/defaults.ts:239`),
  // 所以只有这批特例需要写,其余继承供货商的 openai-completions。
  if (m.api) {
    entry.api = m.api
  }
  if (m.reasoning) {
    entry.reasoning = true
    // Grok 4+ 会思考但上游不吃 reasoning_effort(内核 detectCompat 自己就是这么判 grok 的)。
    // 这里如实写 false:内核据此完全不下发档位,思考正文照旧解析。
    const supportsEffort = m.thinkingEffort !== false
    const compat: Record<string, unknown> = { supportsReasoningEffort: supportsEffort }
    // 思考参数方言。内核的 `detectCompat` 只按 provider / baseUrl 认方言
    // (`openai-completions.ts:1262-1323`),我们的 provider 是 `yunwu`,所以它一律判成
    // `"openai"` —— 阿里系、智谱系、火山系模型收到的 `reasoning_effort` 因此没人读,
    // `glm-4.5` 更是直接回 400(*The parameters `reasoning_effort` is not supported*)。
    //
    // 写了这一行,内核才会改发该族真正读的字段:`qwen`/`zai` → `enable_thinking`、
    // `deepseek` → `thinking:{type}`(`openai-completions.ts:716-730`)。
    //
    // **注意它和上面那行看着矛盾但不矛盾**:那两个分支在源码里排在
    // `supportsReasoningEffort` 判断之前,所以「档位不可控(false)+ 有方言」的组合下,
    // 内核不发 reasoning_effort、只发 enable_thinking 布尔 —— 正好是这批模型要的形状
    // (档位假、开关真)。
    if (m.thinkingFormat) {
      compat.thinkingFormat = m.thinkingFormat
    }
    const levels = supportsEffort
      ? (m.thinkingLevels ?? []).filter((l) => THINKING_LADDER.includes(l))
      : []
    const cannotDisable = supportsEffort && m.canDisableThinking === false
    if (levels.length > 0 || cannotDisable) {
      const map: Record<string, string | null> = {}
      if (levels.length > 0) {
        for (const l of THINKING_LADDER) {
          map[l] = levels.includes(l) ? effortValue(l) : null
        }
        // `minimal` 不在 THINKING_LADDER 里,不显式置 null 的话内核会把它留在可用集里:
        // 2026-08-16 直接调 vendor dist 的 getSupportedThinkingLevels 验过,不写 map 时
        // 返回的是 off,minimal,low,medium,high。我们的档位阶梯没有 minimal,留着等于放出
        // 一个没验过的档位(平台对 gpt-5.x 还会把它改写成 low,见 openai/adaptor.go:344-348)。
        map.minimal = null
        compat.supportedReasoningEfforts = Array.from(new Set(levels.map(effortValue)))
      }
      if (cannotDisable) {
        // 上游官方关不掉思考(Gemini 3+ 全系、Gemini 2.5 Pro、gpt-5-pro)时把 off 摘掉。
        // 这是内核现成的旋钮,不是我们发明的:同一次真机核对里 map.off=null 让可用集从
        // off,minimal,low,medium,high 变成 minimal,low,medium,high,且 clamp('off')
        // 降到最低可用档而不是静默放行。界面锁开关只锁我们自己,这一行才让内核也认。
        map.off = null
      }
      entry.thinkingLevelMap = map
    }
    entry.compat = compat
  }
  if (m.vision) {
    entry.input = ['text', 'image']
  }
  return entry
}

/**
 * 供货商级请求超时(秒)。它同时决定内核「流空闲看门狗」的阈值。
 *
 * 为什么必须显式设置:内核默认 120 秒收不到内容增量就判定模型失联、中止本轮
 * (`stopReason=aborted`,`LLM idle timeout (120s)`)。而上游在憋大段正文或大 tool 入参时
 * 只发 ping 保活,ping 不计作内容增量——实测一次 8600 token 的交付在上游正常完成前 11 秒
 * 被掐断,产物丢失而 token 照计费。
 *
 * 为什么走 provider 级而不是 `agents.defaults.timeoutSeconds`:后者在内核里被
 * `Math.min(v, 120s)` 夹住,只能调小不能调大。provider 级 timeoutSeconds 映射为
 * model.requestTimeoutMs,走的是不受该上限约束的分支——**前提是不设
 * `agents.defaults.timeoutSeconds`**,一旦设了它会重新成为上界,故我们刻意不设。
 */
const PROVIDER_TIMEOUT_SECONDS = 600

/**
 * 出图 provider id(插件 `yunwu-video` 注册的第二条,见 resources/yunwu-video-plugin)。
 *
 * ## 为什么从 `litellm` 槽位搬到自研插件
 *
 * 原来寄居在内核的 `litellm` 槽位(留给「OpenAI 兼容中转站」的通用槽位)。它能用,但把出图
 * 锁死在三个 `gpt-image-*` 上:槽位的请求体是写死的 `{model,prompt,n,size}`、**不发
 * `response_format`**,而内核的响应解析只读 `b64_json`。默认返 url 的模型(seedream、
 * qwen-image、z-image)一律报 "response malformed" —— 这就是「出图模型用户改不了」的根因,
 * 不是产品选择。
 *
 * 2026-08-13 实测:补上 `response_format: 'b64_json'` 之后 seedream / grok-imagine 都返 b64,
 * 但 qwen-image-3.0 与 z-image-turbo 照样返 url;而 `/v1/images/edits` 只收 multipart,
 * litellm 槽位发的 JSON 形状回 **HTTP 500 "request Content-Type isn't multipart/form-data"**
 * —— 也就是说经它的图生图本来就是坏的。两条都得自己发请求才能解决,所以改由插件接。
 *
 * ## 搬过来顺带没了三样东西
 *
 *  1. `models.providers.litellm` 那份供货商覆盖(令牌不用再落第二份);
 *  2. 那份覆盖里的 `request.allowPrivateNetwork: true` —— 它是为了绕开内核 SSRF 策略把
 *     fake-IP DNS 解析出的 198.18.x.x 判成内网。插件自己发 fetch,不过内核那套策略;
 *  3. 出图模型必须跟着落进 `models.providers.yunwu.models` 的要求(插件自带清单)。
 */
const IMAGE_PROVIDER_ID = 'yunwu-image'

/**
 * 出图请求超时。实测云雾出一张 1024×1024 的 seedream 要 75 秒,而内核对 image_generate 的
 * 默认上限只有 120 秒(CODEX_DYNAMIC_IMAGE_GENERATION_TOOL_TIMEOUT_MS),多张并发或更高
 * 分辨率就会顶到。显式放宽到 5 分钟(内核对该覆盖的硬上限是 10 分钟)。
 */
const IMAGE_GENERATION_TIMEOUT_MS = 300_000

/**
 * 该账号此刻生效的媒体模型选择(用户选过就用他选的,没选过用本地预选)。
 *
 * 为什么读 activation 而不是像对话模型那样从 `providers` 推:媒体模型不落进供货商的
 * models 数组(插件自带清单),所以供货商列表里根本没有它们的影子,唯一的来源是
 * 按账号存的那份选择(`model-catalog.ts`)。没登录时返回预选,让启动对齐有东西可写。
 */
function accountMediaSelection(): MediaSelection {
  const act = loadActivation()
  return act
    ? resolveAccountMediaModels(act)
    : { image: IMAGE_MODEL_PREFERENCE, video: VIDEO_MODEL_PREFERENCE, audio: AUDIO_MODEL_PREFERENCE }
}

/**
 * 有没有资格上架 `image_generate`:与视频同口径 —— 只要内置云雾供货商带着 apiKey,
 * 且用户至少选了一个出图模型。
 *
 * 返回 `<IMAGE_PROVIDER_ID>/<model>` 形式的引用,顺序即 primary → fallbacks。
 * 一个都没选就返回 null:此时不写 `imageGenerationModel`,`image_generate` 保持不上架
 * (内核对它是「没配就不注册」),比给模型一台必然失败的工具好。
 *
 * 模型清单不校验是否在供货商 models 里了 —— 插件按 live 端点类型自己判归属,
 * 用户选了个已下架的会在调用时拿到一句说明白的报错,而不是静默不上架。
 */
function resolveImageGeneration(providers: ProviderConfig[], models: string[]): string[] | null {
  const yunwu = providers.find((p) => p.id === 'yunwu' && p.baseUrl && p.apiKey)
  if (!yunwu?.apiKey || models.length === 0) {
    return null
  }
  return models.map((id) => `${IMAGE_PROVIDER_ID}/${id}`)
}

/**
 * 出图模型选择的配置条目。
 *
 * 内核对 `image_generate` 是「没配 imageGenerationModel 就不注册」:工具压根不进模型的
 * tools schema。线上实测踩过一次——图文专家手上只有识图的 `image`,没有出图的
 * `image_generate`,于是它拿 canvas / browser 硬凑,还在回复里声称已经出了图。
 */
function imageGenerationModelEntries(modelRefs: string[]): ConfigEntry[] {
  const [primary, ...fallbacks] = modelRefs
  const entries: ConfigEntry[] = [
    { path: 'agents.defaults.imageGenerationModel.primary', value: primary },
    { path: 'agents.defaults.imageGenerationModel.timeoutMs', value: IMAGE_GENERATION_TIMEOUT_MS }
  ]
  // 用户可能从多选删回一个,此时要把旧的 fallbacks 清掉,否则被删的模型仍在候选里。
  entries.push({
    path: 'agents.defaults.imageGenerationModel.fallbacks',
    value: fallbacks
  })
  return entries
}

/**
 * 视频生成 provider id(插件 `yunwu-video` 注册的那条)。
 *
 * 与对话供货商 `yunwu` 刻意分开:videoGenerationModel 的 primary 写成
 * `yunwu-video/<model>`,网关靠这条把插件拉进启动计划;凭证仍读
 * `models.providers.yunwu`(插件运行时自己取)。
 */
const VIDEO_PROVIDER_ID = 'yunwu-video'

/**
 * 视频请求超时。实测 veo_3_1-fast 约 30s、可灵 318s、海螺 96s,上游偶发排队更久;
 * 与 openrouter 视频 provider 同口径给 10 分钟。
 */
const VIDEO_GENERATION_TIMEOUT_MS = 600_000

/**
 * 有没有资格上架 video_generate:内置云雾供货商带着 apiKey,且用户至少选了一个视频模型。
 *
 * 模型清单在插件里(现在 15 个),不要求写进 models.providers.yunwu.models —
 * 视频模型混进对话目录只会污染下拉框。
 */
function resolveVideoGeneration(providers: ProviderConfig[], models: string[]): string[] | null {
  const yunwu = providers.find((p) => p.id === 'yunwu' && p.baseUrl && p.apiKey)
  if (!yunwu?.apiKey || models.length === 0) {
    return null
  }
  return models.map((id) => `${VIDEO_PROVIDER_ID}/${id}`)
}

function videoGenerationModelEntries(modelRefs: string[]): ConfigEntry[] {
  const [primary, ...fallbacks] = modelRefs
  return [
    { path: 'agents.defaults.videoGenerationModel.primary', value: primary },
    { path: 'agents.defaults.videoGenerationModel.timeoutMs', value: VIDEO_GENERATION_TIMEOUT_MS },
    { path: 'agents.defaults.videoGenerationModel.fallbacks', value: fallbacks }
  ]
}

/**
 * 语音合成(TTS)的接线。**不在 `agents.defaults` 下**,内核 TTS 配置在
 * `messages.tts.providers.<id>`,各 provider 自带 baseUrl / apiKey
 * (`openclaw/docs/tools/tts.md:815-876`)。
 *
 * 走 `openai` 这个 provider id 是因为它就是「OpenAI 兼容 `/v1/audio/speech`」那条实现,
 * 而云雾正是 OpenAI 兼容中转。2026-08-13 端到端验过:配上之后隔离网关
 * `tts.convert` 落盘真 mp3(41472 B、帧同步 `fff3`),六种 response_format 全通;
 * 启动日志会打一句 `openai speech provider selected, enabled automatically` ——
 * **配了 provider 内核就自动启用**,不用另外开 `messages.tts.enabled`。
 *
 * 模型名不受内核那份写死清单限制:baseUrl 一旦不是官方地址,`isValidOpenAIModel` /
 * `isValidOpenAIVoice` 无条件返回 true(`tts.ts:55-67`),所以平台上 `tts-1-1106`
 * 这类不在 `OPENAI_TTS_MODELS` 里的名字也能用。
 *
 * `tts` 工具本身是**无条件挂进工具表**的(`agents/openclaw-tools.ts:439`),
 * 不受这段配置影响 —— 也就是说不配的话专家手上有工具但一调必失败,这正是要补上它的原因。
 */
function resolveTtsWiring(
  providers: ProviderConfig[],
  model: string
): { baseUrl: string; apiKey: string; model: string } | null {
  const yunwu = providers.find((p) => p.id === 'yunwu' && p.baseUrl && p.apiKey)
  if (!yunwu?.apiKey || !model) {
    return null
  }
  return { baseUrl: yunwu.baseUrl.replace(/\/+$/, ''), apiKey: yunwu.apiKey, model }
}

/** 默认音色。内核对非官方 baseUrl 不校验音色名,`alloy` 是验过的那个。 */
const TTS_VOICE = 'alloy'

/**
 * TTS 的配置条目。
 *
 * 整体写 `messages.tts.providers.openai` 这个子对象,不拆成叶子路径:CLI 兜底那条路
 * (`config set`)会把命中 sensitive 标记的叶子加密成 `enc:v1:...`,而 provider 拿它去打
 * 上游会被云雾判为无效 token(出图那侧实测过 401 Invalid token)。
 */
function ttsEntries(wiring: { baseUrl: string; apiKey: string; model: string }): ConfigEntry[] {
  return [
    { path: 'messages.tts.provider', value: 'openai' },
    {
      path: 'messages.tts.providers.openai',
      value: {
        baseUrl: wiring.baseUrl,
        apiKey: wiring.apiKey,
        model: wiring.model,
        voice: TTS_VOICE
      }
    }
  ]
}

/**
 * 三种媒体能力的落盘条目:出图、视频、语音合成。
 *
 * 每一档「接不出线就不写」——内核对 `image_generate` / `video_generate` 是**按配置键存不存在**
 * 决定要不要上架,不写就是不上架,比给模型一台必然失败的工具好。清理遗留键靠
 * `removeStale*` 那几个(它们在启动时跑)。
 */
function mediaWiringEntries(providers: ProviderConfig[]): ConfigEntry[] {
  const selection = accountMediaSelection()
  const entries: ConfigEntry[] = []
  const imageRefs = resolveImageGeneration(providers, selection.image)
  if (imageRefs) {
    entries.push(...imageGenerationModelEntries(imageRefs))
  }
  const videoRefs = resolveVideoGeneration(providers, selection.video)
  if (videoRefs) {
    entries.push(...videoGenerationModelEntries(videoRefs))
  }
  const tts = resolveTtsWiring(providers, selection.audio)
  if (tts) {
    entries.push(...ttsEntries(tts))
  }
  return entries
}

/**
 * 用户改完媒体模型之后的下发。
 *
 * 先写再清:`mediaWiringEntries` 只写接得出线的那几档,清理那几个函数只删接不出线的 ——
 * 用户把出图删空时,正是靠后半段把 `imageGenerationModel` 摘掉、让 `image_generate` 下架。
 */
export async function applyMediaSelection(): Promise<void> {
  const batch = mediaWiringEntries(loadProviders())
  if (batch.length > 0) {
    await setConfigBatch(batch)
  }
  await removeStaleImageGenerationModel()
  await removeStaleVideoGenerationModel()
  await removeStaleTtsProvider()
}

/** 构造 models.providers 全量对象(声明式:整体替换,删除的供货商会被移除)。 */
function buildProvidersValue(providers: ProviderConfig[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of providers) {
    const value: Record<string, unknown> = {
      baseUrl: p.baseUrl.replace(/\/+$/, ''),
      api: p.api,
      timeoutSeconds: PROVIDER_TIMEOUT_SECONDS,
      models: p.models.map(buildModelEntry)
    }
    // 本地部署(如 Ollama)可无 Key;空 Key 不写,避免 provider 鉴权误判。
    if (p.apiKey) {
      value.apiKey = p.apiKey
    }
    out[p.id] = value
  }
  // 这里刻意不再补出图的供货商覆盖:出图改由插件的 `yunwu-image` provider 接,凭证读
  // `models.providers.yunwu`。`models.providers` 是整体替换的,所以旧安装里遗留的
  // `litellm` 条目会在下一次写入时自然消失,不需要单独删。
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
function bootstrapEntries(): ConfigEntry[] {
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
 * agent 默认项中与「引导文件」相关的固定策略(每次渲染都下发,幂等)。
 *
 * 关掉四个可选引导文件:内核默认会在每个 agent workspace 铺 SOUL.md / IDENTITY.md /
 * USER.md / HEARTBEAT.md,并在 system 里注入。对云雾的专家会话它们是纯负担——角色由
 * persona(AGENTS.md)唯一定义,内核那套「自述身份 / 记录用户画像 / 心跳」会与 persona
 * 抢身份,实测导致模型自称"小助"、把 IDENTITY.md 当产出物写。
 *
 * 为什么不用更省事的 `skipBootstrap: true`:它会让 ensureAgentWorkspace 走提前返回分支,
 * 连 workspace 的 `git init` 一起跳过,而内核可能依赖它做文件改动回溯。只关可选文件更精准。
 * BOOTSTRAP.md 不在此开关覆盖范围内,由客户端播种后显式删除(见 agent-manager)。
 */
function agentBootstrapPolicyEntries(): ConfigEntry[] {
  return [
    {
      path: 'agents.defaults.skipOptionalBootstrapFiles',
      value: ['SOUL.md', 'USER.md', 'HEARTBEAT.md', 'IDENTITY.md']
    },
    ...sessionMaintenanceEntries()
  ]
}

/**
 * 让任务会话既不因为「太多」也不因为「太旧」被内核清掉。
 *
 * 一个任务现在是共享 agent 上的一条会话,普通任务全部落在 `main` 的会话库里。而内核的
 * 会话维护默认 `mode: enforce` + `maxEntries: 500` + `pruneAfter: 30d`,且把 `acp:` 会话
 * 判为 disposable(`isProtectedSessionMaintenanceEntry` 对 synthetic key **第一行就返回
 * false**,见内核 `src/config/sessions/store-maintenance.ts:282-289`)——被清掉的条目还会
 * 连带走 artifact cleanup 清 transcript(`store-maintenance-operations.ts:220-225`),
 * 用户看到的是「侧栏里的老任务点开一片空白」。
 *
 * 两条上限要分开说,它们是两次改动:
 *
 * - **条数**:过去撞不到纯属结构使然(一任务一 agent,每个会话库里只有一条),改成共享
 *   agent 之后 500 就成了真实天花板,所以显式抬高。
 * - **年龄**:2026-08-11 补上。当时刻意没动,理由是「不把修回归和改产品策略混在一起」——
 *   现在是专门来改这条产品策略的。锚定事实是 WorkBuddy:本机它的 `sessions/` 里躺着 39 天前
 *   的会话文件(`tasks/` 20 天、`projects/` 34 天),**它不按年龄清理**。我们要的结果一样:
 *   任务是文档,放久了不该自己消失。
 *
 * **别以为条数上限顺带保住了年龄这一半。** 两处 prune 的触发条件不同:加载那条路
 * (`store-load.ts:441`)确实要 `beforeCount > maxEntries` 才跑,但每次存盘走的
 * `applyEnforcedMaintenance`(`store-maintenance-operations.ts:198`)是**无条件** prune,
 * 500 那道门槛只挡后面的 cap。真机预演证过:临时 store 只有 5 条,40 天前的 `acp:` 任务
 * 会话照样 `pruned`(`openclaw sessions cleanup --dry-run --store <临时文件>`,零风险复现)。
 *
 * 取 `pruneAfter` 而不是 `mode: "warn"`:warn 会把年龄和条数两套一起停掉
 * (`store-maintenance-operations.ts:270-278` 直接 return `changedStore: false`,已实测),
 * 而条数上限是我们要留着的真实保护。单位只认 ms/s/m/h/d(**不认 years**),写错不会静默
 * 退回默认值,而是让整份配置被判非法、应用起不来——所以这个值别改成花样写法。
 */
function sessionMaintenanceEntries(): ConfigEntry[] {
  return [
    { path: 'session.maintenance.maxEntries', value: 20000 },
    { path: 'session.maintenance.pruneAfter', value: '3650d' }
  ]
}

/**
 * 内建工具开关(每次渲染都下发,幂等)。
 *
 * `tools.experimental.planTool`:内核把结构化任务清单工具 `update_plan` 设为可选,
 * 默认仅在"strict-agentic 内嵌运行"下自动开启——我们的云雾 provider/模型不在该判定内,
 * 于是工具从不进模型的 tools schema,哪怕 TOOLS.md 反复要求"先用 update_plan 列清单",
 * 模型手上也没有这个工具 → 任务清单永远不出现。这里显式打开,补齐与 WorkBuddy 一致的
 * 可勾选进度卡(客户端侧的 PLAN_TOOL_NAMES 渲染与 TOOLS.md 引导早已就位)。
 */
function builtinToolPolicyEntries(): ConfigEntry[] {
  return [{ path: 'tools.experimental.planTool', value: true }]
}

/**
 * 我们已经自带 provider 的内核工具。这几个当年被拉黑是对的(那时没有对应 provider,
 * 留着就是「有工具但一调必失败」),补上 provider 之后必须放出来。
 */
const SUPPLIED_TOOLS = ['web_search', 'image_generate', 'video_generate'] as const

/**
 * 把 `tools.deny` 里那几个「我们现在供得上」的工具摘出来。
 *
 * **这条是被真机打出来两次的同一个坑**:第一次是 `web_search`——provider 装好、配置也指对了,
 * 模型手上仍然没有这个工具;第二次是 `image_generate`——用户让它画一张戴围巾的小黄狗,
 * 它跑去 shell 里执行 `openclaw infer image generate --help`,拿 CLI 硬凑。两次的根因都是
 * 配置里躺着一条陈年的 `tools.deny`,内核照它把工具从模型的 tools schema 里滤掉
 * (`openclaw/src/agents/agent-tools.policy.ts:163` 取全局 `tools.deny`,`:140-146` 过滤)。
 *
 * 注册成功 ≠ 模型手上有。所以这里一次性覆盖我们供得上的全部工具,而不是遇到一个补一个。
 * 名单外的拒绝项(比如 `skill_workshop`)原样留着:那个键不是我们写的,可能还有别人加的。
 *
 * **必须只有这一个地方写 `tools.deny`**:两处各自从磁盘那份算一遍再一起提交,后写的会把
 * 先写的摘除结果顶回去(两边读到的是同一份旧快照)。
 */
function suppliedToolDenyReleaseEntries(): ConfigEntry[] {
  const deny = (readOpenClawConfig()?.tools as { deny?: unknown } | undefined)?.deny
  if (!Array.isArray(deny)) {
    return []
  }
  const next = deny.filter(
    (tool) => !SUPPLIED_TOOLS.includes(tool as (typeof SUPPLIED_TOOLS)[number])
  )
  return next.length === deny.length ? [] : [{ path: 'tools.deny', value: next }]
}

/**
 * 给人设插件开「会话类钩子」。
 *
 * 它要用 `before_model_resolve` 让专家团成员跟随负责人选定的模型(理由见插件源码
 * `resources/persona-plugin/index.mjs` 里那个钩子的注释)。这类钩子对**非内置**插件
 * 默认关闭:内核在注册时直接 return,只往插件诊断里塞一条 warn,运行时不报错也不打日志
 * (`openclaw/src/plugins/registry.ts:2555-2567`),表现就是钩子静默不执行。
 * 名单见 `openclaw/src/plugins/hook-types.ts:226-234`——插件里另一个
 * `before_prompt_build` 不在名单内,所以此前一直不需要这条。
 *
 * 顺带补上启动计划的另一条入口:`plugins.entries.<id>.hooks` 有显式策略,本身就能让
 * `hasHookRuntimeStartupIntent` 认这个插件(`gateway-startup-plugin-ids.ts:1698`),
 * 与 manifest 里的 `activation.onCapabilities: ["hook"]` 互为双保险。
 */
function personaPluginPolicyEntries(): ConfigEntry[] {
  return [{ path: 'plugins.entries.yunwu-persona.hooks.allowConversationAccess', value: true }]
}

/**
 * 把联网搜索指到我们自己那家 provider(插件里的 `yunwu-search`)。
 *
 * **为什么必须显式写,尽管内核会自动探测**:`resolveWebSearchProviderId` 在没配 provider 时
 * 按凭据自动挑第一家(`openclaw/src/web-search/runtime.ts:191-201`),我们的 provider 声明了
 * `requiresCredential` 且凭据直接读云雾对话槽位的 key,所以本来就够条件被选中。但那条路要跟
 * 别家抢:环境里只要有 `TAVILY_API_KEY` / `PERPLEXITY_API_KEY` 之类,排序就可能把它排前面
 * (那几家自带 `autoDetectOrder`),用户会莫名收到一句「需要 API key」。写死就没有这个不确定性。
 *
 * `tools.*` 属 none 类(内核 `config-reload-plan.ts:126`),落盘即生效、不用重启;但**插件代码
 * 本身的改动要重启网关**(`plugins.load` 是 restart 类),所以第一次上这个功能仍要重启一次。
 *
 * 要复现的结果:用户选的对话模型自己不能联网时,专家要查最新资料照样查得到 —— 主模型不变,
 * 只有检索这一步交给带联网的对话模型(后端与理由见插件里 buildSearchProvider 的注释)。
 */
/**
 * `web_search` 该拿哪些模型当后端。**顺序即优先级,插件按顺序试,前一个不行换下一个。**
 *
 * 取值口径就是用户自己那份对话模型清单里带联网标记的那几条 —— 带搜索能力的本来就是对话
 * 模型(`gemini-2.5-flash`、`gpt-4o-mini-search-preview` 都在对话池里),所以**不给搜索单开
 * 一档选择器**:那等于让用户为同一批模型勾两次,还要求他知道哪个模型会联网。
 * 他在设置→模型里勾了谁,查资料就用谁。
 *
 * 兜底清单**追加在后面而不是替换**:用户选中的排前面(尊重他的选择),后面几条是
 * primary 挂了时的备份。用户一条带联网的都没选时,这份就是全部 —— 理由见
 * `public-models.ts:SEARCH_FALLBACK_MODELS`。
 *
 * 落 `tools.web.search.yunwu.*` 这个命名空间是内核认的:`ToolsWebSearchSchema` 带
 * `.catchall(z.unknown())`(`openclaw/src/config/zod-schema.agent-runtime.ts:404`),
 * 未知 key 一律放行,只有 legacy 那 12 家(brave/tavily/gemini…)不能当对象键
 * (`config/web-search-legacy-provider-keys.ts:2-15`)——`yunwu` 不在名单里。
 * 而且我们的凭据本来就写在 `tools.web.search.yunwu.apiKey`(provider 自报的
 * `credentialPath`),模型清单挨着它放,不另开第二条路。
 */
function accountSearchModels(): string[] {
  const act = loadActivation()
  const picked = act
    ? resolveAccountModels(act)
        .filter((m) => m.category === 'chat' && m.search)
        .map((m) => m.id)
    : []
  return [...new Set([...picked, ...SEARCH_FALLBACK_MODELS])]
}

function webSearchPolicyEntries(): ConfigEntry[] {
  const entries: ConfigEntry[] = [
    { path: 'tools.web.search.provider', value: 'yunwu-search' },
    { path: 'tools.web.search.yunwu.models', value: accountSearchModels() }
  ]
  // 拉黑名单的摘除统一在 `suppliedToolDenyReleaseEntries` 里做(同一个批次里不能有
  // 两处写 `tools.deny`,理由见那个函数的注释)。
  return entries
}

/**
 * 读磁盘上的 openclaw.json 取现状。纯 fs 读(与 agent-manager / session-history 一致),
 * 不经 CLI —— 用 `openclaw config get` 读一次要约 2.9 秒的冷启动,而我们只想比个值。
 * 读不到就当空对象:此时任何写入都不是 noop,照写即可。
 */
function readOpenClawConfig(): Record<string, unknown> {
  try {
    return JSON.parse(
      readFileSync(join(homedir(), '.openclaw', 'openclaw.json'), 'utf-8')
    ) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * 把一批 `{path,value}` 声明式写入 openclaw.json。
 *
 * 优先经网关 config.set:提交在网关进程内完成,响应返回即对内存里的 runtime config 生效,
 * 也省掉每次几秒的内核冷启动。网关没在跑时退回官方 `config set --batch-file`(用文件传参
 * 而非内联 JSON,规避 Windows shell 转义)——此时不存在内存与磁盘不一致的问题,写文件即正确,
 * 故不等建连(这几个入口都在启动早期跑)。
 */
async function setConfigBatch(batch: ConfigEntry[]): Promise<void> {
  if (batch.length === 0) {
    return
  }
  await viaGatewayOrCli(
    '写入配置',
    () => gatewayClient.setConfig((config) => applyConfigEntries(config, batch)),
    () => setConfigBatchViaCli(batch),
    { skipWhenDisconnected: true }
  )
}

async function setConfigBatchViaCli(batch: ConfigEntry[]): Promise<void> {
  // 值没变就别写。CLI `config set` 不像网关 config.patch 那样有 noop 短路,给什么写什么;
  // 而启动期这批策略几乎每次都与现值相同,白写一次要付 CLI 冷启动(约 2.9s)+ 一轮网关热加载,
  // 且热加载正好落在网关预热最忙的窗口里 —— 后面那些配置写入撞车都是从这个窗口开始的。
  if (configBatchIsNoop(batch, readOpenClawConfig())) {
    return
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
 * 启动时的一次性配置下发(每次启动调用,幂等):运行期策略 + UI 工具 MCP 登记。
 *
 * 为什么单独有这个入口:renderConfig 只在激活或用户保存供货商时才跑,存量安装不会为了
 * 一次升级专门去设置页点一下保存,策略就永远补不上(实测 skipOptionalBootstrapFiles
 * 在已安装机器上一直是 undefined)。这里按**子路径**定点写入,不碰 models / primary,
 * 避免顺手改掉用户的默认模型。
 *
 * 为什么这批必须合成一次写:配置写入在启动阶段几乎必然走 CLI 兜底(网关由 preflight
 * 拉起,与这条链赛跑,实测冷启动到 ready 要 20 秒以上),而 openclaw CLI 冷启动光读一次
 * 配置就要 2.9 秒;更贵的是每次落盘都会让网关再做一次热加载,而它此时正忙于 provider
 * auth 预热(实测 40.8 秒、事件循环单次阻塞到 1.1 秒)。两次写变一次,直接省掉一整轮。
 *
 * 这批里的值全是静态的,写过一次之后 configBatchIsNoop 就会短路掉——UI 工具的 MCP 登记
 * 曾经是唯一每次都变的那一项(临时端口),现已挪进插件包的 .mcp.json(见 ui-tools-bundle.ts),
 * 于是稳态下这里一次盘都不落。
 */
export async function applyStartupConfig(): Promise<void> {
  const providers = loadProviders()
  const batch: ConfigEntry[] = [
    ...agentBootstrapPolicyEntries(),
    ...builtinToolPolicyEntries(),
    ...personaPluginPolicyEntries(),
    ...webSearchPolicyEntries(),
    ...suppliedToolDenyReleaseEntries()
  ]
  // 媒体接线也要在这里补一遍:renderConfig 只在激活或用户保存供货商时才跑,存量安装
  // 不会为了一次升级专门去设置页点一下保存,否则出图 / 视频 / 语音就永远不上架。
  // 按子路径写(与 renderConfig 的整体替换不冲突),写过一次即被 noop 短路。
  batch.push(...mediaWiringEntries(providers))
  for (const p of providers) {
    // 供货商 id 直接拼进配置路径,含点或其它分隔符会破坏寻址,跳过而非写坏配置。
    if (!/^[A-Za-z0-9_-]+$/.test(p.id)) {
      console.warn(`[config] 供货商 id「${p.id}」不适合作为配置路径段,跳过超时策略下发`)
      continue
    }
    batch.push({
      path: `models.providers.${p.id}.timeoutSeconds`,
      value: PROVIDER_TIMEOUT_SECONDS
    })
  }
  await setConfigBatch(batch)
}

/** 内核下发失败时的通知回调(由 index.ts 接到渲染层)。 */
let onSyncError: ((message: string) => void) | null = null

/** 登记内核下发失败的通知出口。未登记时失败只写日志。 */
export function setConfigSyncErrorHandler(fn: ((message: string) => void) | null): void {
  onSyncError = fn
}

/**
 * openclaw.json 的下发队列。
 *
 * providers.json 才是单一数据源,写它是毫秒级的,界面据它立刻更新即可;而下发到内核要等
 * config.set 落盘 + 网关热加载(2026-08-12 真机实测:config.set 2.3~12.5 秒、热加载再
 * 0.5~9.4 秒),没道理让用户点一下删除干等这么久。
 * WorkBuddy 和 Claude Code 改配置就是本进程写文件、立即返回,不存在这个等待
 * ——我们多出来的这段是「内核在另一个进程」逼出来的,那就别把它摆在用户面前。
 *
 * 必须串行:连续两次编辑若并发渲染,后一次可能读到前一次写盘前的 providers.json。
 */
let renderQueue: Promise<unknown> = Promise.resolve()

/**
 * 排在队列里等着跑的那个后台下发(只留一个)。
 *
 * 每次渲染都是**全量声明式**——整份 `models.providers` + `agents.defaults.models` 都是从
 * providers.json 现算的,所以中间态没有任何信息价值,只有最后一份需要落盘。用户在模型页
 * 连勾十下若逐次排队,就是十次 `config.set` + 十轮热加载串着跑,中间任何别的配置写入都得等。
 *
 * 刻意不用定时器防抖:那要挑一个等待时长,挑长了用户切走页面就丢、挑短了照样连发。
 * 槽式合并没有这个参数,而且与「等结果」的入口(登录、启动对齐)共用同一条串行链,
 * 不会出现后台写和登录写并发改同一份配置。
 */
const pendingBackgroundRenders = new Map<BackgroundRenderKey, () => Promise<void>>()

/**
 * 后台渲染的分槽键。**必须按「这个任务写哪棵子树」分开**,不能共用一个槽。
 *
 * 2026-08-16 真机抓到的 bug 就是共用一个槽:`applyAccountChatModels` 先入队整份重渲染
 * (20 条,带模型清单),紧接着入队搜索后端那 2 条 —— 后者把前者从槽里顶掉,队列真正执行时
 * 只跑了 2 条,模型清单**永远下发不出去**。症状是保存后 openclaw.json 一个字节都不变、
 * 一条错误日志也没有(覆盖是静默的),而界面显示保存成功。
 *
 * 合并本身是对的,但只在**同类任务**之间成立:整份重渲染是全量声明式的,后一次天然包含
 * 前一次的全部效果;而搜索后端写的是 `tools.*`,跟它毫无重叠。
 */
type BackgroundRenderKey = 'render' | 'web-search'

/** 把一次下发排进队列并返回其结果(失败会抛给调用方)。 */
function enqueueRender(run: () => Promise<void>): Promise<void> {
  const next = renderQueue.then(run, run)
  renderQueue = next.catch(() => {
    /* 队列本身不因单次失败中断 */
  })
  return next
}

/**
 * 同上,但不等结果:失败只记日志并通知渲染层。用于用户不该干等的编辑操作。
 *
 * **每个 key 一个槽**:同 key 的后一次直接替换槽里的内容(合并连续编辑,理由见 key 的类型注释),
 * 不同 key 各自排队,谁也不会把谁顶掉。
 */
function enqueueRenderInBackground(key: BackgroundRenderKey, run: () => Promise<void>): void {
  const slotTaken = pendingBackgroundRenders.has(key)
  pendingBackgroundRenders.set(key, run)
  if (slotTaken) {
    return
  }
  void enqueueRender(async () => {
    const job = pendingBackgroundRenders.get(key)
    pendingBackgroundRenders.delete(key)
    await job?.()
  }).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[config] 模型配置下发内核失败:', msg)
    onSyncError?.(msg)
  })
}

/**
 * 分批写入的安全线:一次落盘不让配置掉到前值的这个比例以下。
 *
 * 内核判据是 `previousBytes >= 512 && nextBytes < floor(previousBytes * 0.5)` 就整批拒写
 * (`openclaw/src/config/io.ts:516-522`),而网关侧从不传 `allowConfigSizeDrop`
 * (整个 `src/gateway` 零命中),报出来是一句和模型毫无关系的 `Config write rejected`。
 *
 * 取 0.55 而不是贴着 0.5:我们算的是「读进来重新序列化」的字节数,内核写的是它自己拼的那份
 * (多一个 `meta.lastTouchedAt`)。同口径见 `agent-manager.ts:pruneUnusedExpertAgents`
 * ——它删 71 个 agent 时也是按 55% 分的两批。
 *
 * **判据必须是字节比值,不能写成「超过 N 个模型就分批」**:2026-08-12 真机测过,同样是
 * 27 个模型删回 7 个,带 reasoning/compat 的胖条目约 366 字节、普通对话模型只有约 190 字节,
 * 撞不撞线取决于用户恰好选了哪些模型,那个 N 根本不存在。
 */
const SIZE_DROP_SAFE_RATIO = 0.55

/** 内核判骤降保护的最小基数(低于它不设防,见 io.ts:516)。 */
const SIZE_DROP_MIN_BYTES = 512

/** 按内核落盘口径估算配置字节数(它写的就是 `JSON.stringify(cfg, null, 2) + '\n'`)。 */
function configBytes(config: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

/** 这一批写完之后配置长什么样(纯计算,不落盘)。 */
function projectConfig(
  base: Record<string, unknown>,
  batch: ConfigEntry[]
): Record<string, unknown> {
  const next = structuredClone(base)
  applyConfigEntries(next, batch)
  return next
}

/** 本次被删掉的一个模型条目,以及它在 allowlist 里对应的那一项。 */
interface DroppedModel {
  providerId: string
  /** 配置里的原始模型条目(原样留回,字节数才对得上)。 */
  entry: Record<string, unknown>
  allowKey: string
  allowValue: unknown
}

function providersOf(config: Record<string, unknown>): Record<string, unknown> {
  const models = config.models as { providers?: Record<string, unknown> } | undefined
  return models?.providers ?? {}
}

function modelEntriesOf(provider: unknown): Record<string, unknown>[] {
  const models = (provider as { models?: unknown })?.models
  return Array.isArray(models) ? (models as Record<string, unknown>[]) : []
}

/** 列出「现配置里有、这批写完就没了」的模型条目,供分批时按需留回。 */
function droppedModels(
  current: Record<string, unknown>,
  next: Record<string, unknown>
): DroppedModel[] {
  const nextProviders = providersOf(next)
  const curAllow = ((current.agents as Record<string, unknown> | undefined)?.defaults as
    | Record<string, unknown>
    | undefined)?.models as Record<string, unknown> | undefined
  const out: DroppedModel[] = []
  for (const [providerId, provider] of Object.entries(providersOf(current))) {
    // 供货商整个没了就没处留回,跳过(它的字节由别的步骤承担)。
    if (!(providerId in nextProviders)) {
      continue
    }
    const keep = new Set(modelEntriesOf(nextProviders[providerId]).map((m) => String(m.id)))
    for (const entry of modelEntriesOf(provider)) {
      const id = String(entry.id ?? '')
      if (!id || keep.has(id)) {
        continue
      }
      const allowKey = `${providerId}/${id}`
      out.push({
        providerId,
        entry,
        allowKey,
        // 只留回它原本就在 allowlist 里的那一项:出图模型本就不该进对话下拉框。
        allowValue: curAllow && allowKey in curAllow ? curAllow[allowKey] : undefined
      })
    }
  }
  // allowlist 里没有的(出图模型)排在前面先被留回:它们不影响对话下拉框,是最安全的填充物。
  return out.sort((a, b) => Number(a.allowValue !== undefined) - Number(b.allowValue !== undefined))
}

/** 在最终批次的基础上把一部分被删模型留回去,得到一个中间态批次。 */
function batchWithRestored(batch: ConfigEntry[], restored: DroppedModel[]): ConfigEntry[] {
  if (restored.length === 0) {
    return batch
  }
  return batch.map((entry) => {
    if (entry.path === 'models.providers') {
      const value = structuredClone(entry.value) as Record<string, unknown>
      for (const d of restored) {
        const provider = value[d.providerId] as { models?: unknown[] } | undefined
        if (provider && Array.isArray(provider.models)) {
          provider.models.push(d.entry)
        }
      }
      return { path: entry.path, value }
    }
    if (entry.path === 'agents.defaults.models') {
      const value = { ...(entry.value as Record<string, unknown>) }
      for (const d of restored) {
        if (d.allowValue !== undefined && !(d.allowKey in value)) {
          value[d.allowKey] = d.allowValue
        }
      }
      return { path: entry.path, value }
    }
    return entry
  })
}

/**
 * 下发一批配置,必要时拆成多次写,避免撞上内核的体积骤降保护。
 *
 * 每一步都先在内存里算出「写完是多少字节」再决定要不要拆——判据与内核用的是同两个数,
 * 所以不必猜。拆法是「先留回一部分被删的模型,分几次删干净」,与
 * `pruneUnusedExpertAgents` 分批删 agent 是同一个形状。
 *
 * 留回也救不回来时(缩减来自模型之外,比如整个供货商被删)就照原样写一次:
 * 此时拆批无从下手,让内核自己判,失败经 onSyncError 报给用户,总好过在这里静默不写。
 */
async function setConfigBatchStepwise(batch: ConfigEntry[]): Promise<void> {
  let base = readOpenClawConfig()
  let remaining = droppedModels(base, projectConfig(base, batch))
  // 每一步至少删掉一个条目,所以循环次数天然有界;+1 是最后那次收尾的全量写。
  for (let guard = 0; guard <= remaining.length; guard++) {
    const baseBytes = configBytes(base)
    const floorBytes = baseBytes * SIZE_DROP_SAFE_RATIO
    // 一次写到位就不撞线:直接收尾。
    if (baseBytes < SIZE_DROP_MIN_BYTES || configBytes(projectConfig(base, batch)) >= floorBytes) {
      await setConfigBatch(batch)
      return
    }
    // 留回的条目越多这一步越大,单调,所以找最小的安全留回数即可。
    let keep = remaining.length
    for (let k = 1; k <= remaining.length; k++) {
      const step = batchWithRestored(batch, remaining.slice(0, k))
      if (configBytes(projectConfig(base, step)) >= floorBytes) {
        keep = k
        break
      }
    }
    if (keep >= remaining.length) {
      // 全留回也不够:缩减不来自模型,拆批没有对象。
      await setConfigBatch(batch)
      return
    }
    const step = batchWithRestored(batch, remaining.slice(0, keep))
    console.log(
      `[config] 配置体积骤降保护:本次先留回 ${keep} 个模型条目分批写(${baseBytes} 字节起)`
    )
    await setConfigBatch(step)
    base = readOpenClawConfig()
    remaining = droppedModels(base, projectConfig(base, batch))
  }
  await setConfigBatch(batch)
}

async function renderConfig(
  providers: ProviderConfig[],
  preferredPrimary: string | undefined,
  includeBootstrap: boolean
): Promise<void> {
  const primary = resolvePrimary(providers, preferredPrimary)
  const batch: ConfigEntry[] = []
  if (includeBootstrap) {
    batch.push(...bootstrapEntries())
  }
  // 引导策略不限于首启:每次渲染都下发,存量安装才能补上(网关引导项则只首启一次)。
  batch.push(...agentBootstrapPolicyEntries())
  batch.push(...builtinToolPolicyEntries())
  batch.push({ path: 'models.providers', value: buildProvidersValue(providers) })
  batch.push({ path: 'agents.defaults.models', value: buildAllowlistValue(providers) })
  batch.push(...mediaWiringEntries(providers))
  if (primary) {
    batch.push({ path: 'agents.defaults.model.primary', value: primary })
  }
  // 走分批入口:这批带整份 `models.providers`,用户一次删多个模型时可能撞骤降保护。
  await setConfigBatchStepwise(batch)
}

/**
 * 把激活配置写入本地 OpenClaw(~/.openclaw/openclaw.json)。
 * 激活流亦纳入单一数据源:把云雾账号 upsert 进 providers.json,再声明式整体渲染。
 */
export async function writeOpenClawConfig(config: ActivationConfig): Promise<void> {
  const providers = upsertYunwuProvider(config)
  saveProviders(providers)
  // 等结果,但**不把失败上抛成登录失败**。
  //
  // 登录成不成只该取决于凭据。内核在另一个进程,有自己的落盘、schema 校验、防误删体积
  // 保护和热加载,任何一环不顺都会变成一句与账号密码毫无关系的报错把人挡在登录页外面。
  // 实测撞过:换账号时新配置不到旧配置一半,内核整批拒写 `Config write rejected: size-drop`,
  // 用户看到的却是「激活失败」,反复重试也没用——因为重试的是登录,而坏的是配置。
  // WorkBuddy / Claude Code 的登录压根不写另一个进程的配置,自然没有这一类失败。
  //
  // 仍然 await 是因为紧接着就要起网关发第一条消息,配置早一步生效体验更稳;失败则记日志
  // 并走通知通道,下次启动由 resyncKernelProvidersIfMissing 补。
  try {
    await enqueueRender(() => renderConfig(providers, `yunwu/${config.defaultModel}`, true))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[config] 激活配置下发内核失败(不阻断登录):', msg)
    onSyncError?.(msg)
  }
}

/**
 * 内核配置里缺了激活账号的供货商时补渲染一次。
 *
 * 激活时的下发已经改成失败不阻断登录了,代价是可能留下「已登录但内核不知道有这个账号」的
 * 状态——那样第一条消息会以模型不存在告终。而供货商只在激活/编辑时才渲染,不补这一下,
 * 这个状态会一直留到用户下次去模型管理页手动保存为止。
 *
 * 判据取「内核配置里有没有 yunwu 这一条」,不是比对内容:内容比对要复刻整套渲染规则,
 * 而这里只想接住「整批没写进去」这一种失败。稳态下每次启动就是一次内存里的键存在性判断。
 */
export function resyncKernelProvidersIfMissing(config: ActivationConfig): void {
  const models = readOpenClawConfig().models as { providers?: Record<string, unknown> } | undefined
  if (models?.providers && 'yunwu' in models.providers) {
    return
  }
  console.log('[config] 内核配置缺少云雾供货商,补下发一次')
  enqueueRenderInBackground('render', () =>
    renderConfig(loadProviders(), `yunwu/${config.defaultModel}`, true)
  )
}

/**
 * 把内置云雾供货商的模型清单对齐到该账号此刻生效的清单(启动时跑一次)。
 *
 * 为什么必须有这一步:providers.json 里那份清单是**激活当时**写的快照,此后再不更新。
 * 存量安装不会为了一次升级专门去设置页点一下「保存」,所以只能靠启动时对齐 ——
 * 这也是老版本遗留的那 40 个按账号拉来的模型消失的唯一途径。
 *
 * 后果实测过一次,很难自己想到:本机 providers.json 的 40 个模型里一个 `gpt-image-*`
 * 都没有,于是 resolveImageGeneration 一直返回 null,`imageGenerationModel` 从来没被写进
 * 配置,内核也就从来没注册过 `image_generate`;图文专家手上根本没有出图工具,只能拿
 * canvas / browser 硬凑,还声称已经出了图。
 *
 * 清单从哪来见 `model-catalog.ts`:用户选过就是他选的,没选过是本地兜底常量。
 * **这一步不打网络**,所以离线启动也照样对齐。
 *
 * 两条保护:
 *  1. id 集合没变 → 不写盘、不下发,启动期零额外开销(下发本身也会被 noop 短路)。
 *  2. 只动内置 yunwu 那一条,用户自己加的自定义模型不碰。
 */
export async function syncAccountModels(config: ActivationConfig): Promise<void> {
  const wanted = resolveAccountModels(config)
  const before = loadProviders().find((p) => p.id === 'yunwu')
  const beforeIds = (before?.models ?? []).map((m) => m.id)
  // 比的是**能力指纹**而不只是 id 集合。只比 id 的那一版有个不显眼的后果:家族表把某个模型
  // 从"不思考"改对成"会思考"之后,存量安装的 id 集合没变,于是直接 return —— 修复永远到不了
  // 已经装好的机器上(实测撞过,见 model-capabilities.ts 的 alignThinkingCapability)。
  if (capabilityFingerprint(before?.models ?? []) === capabilityFingerprint(wanted)) {
    return
  }
  // 默认模型沿用用户当前选择;它若已不在清单里(用户把它删了、或老账号拉来的模型),
  // 回退到清单第一条。resolvePrimary 还会再兜一层。
  const chatIds = wanted.filter((m) => m.category === 'chat').map((m) => m.id)
  const defaultModel = chatIds.includes(config.defaultModel) ? config.defaultModel : chatIds[0] ?? ''
  const next: ActivationConfig = { ...config, models: wanted, defaultModel }
  saveActivation(next)
  const providers = upsertYunwuProvider(next)
  saveProviders(providers)
  console.log(`[config] 账号模型清单对齐:${beforeIds.length} → ${wanted.length}`)
  await enqueueRender(() => renderConfig(providers, `yunwu/${next.defaultModel}`, false))
}

/**
 * 一组模型的能力指纹(顺序无关)。覆盖所有会影响 `buildModelEntry` 输出的字段 ——
 * 少覆盖一个,那个字段的修复就到不了存量安装;多覆盖无害,只是多写一次盘。
 */
function capabilityFingerprint(
  models: readonly (Pick<ModelInfo, 'id' | 'reasoning' | 'vision' | 'tools'> &
    Partial<Pick<ModelInfo, 'api' | 'category'>> &
    ThinkingCapability)[]
): string {
  return models
    .map((m) =>
      [
        m.id,
        m.category ?? 'chat',
        m.reasoning ? 'R' : '-',
        m.vision ? 'V' : '-',
        m.tools ? 'T' : '-',
        m.api ?? '',
        (m.thinkingLevels ?? []).join('|'),
        m.defaultThinkingLevel ?? '',
        m.canDisableThinking === false ? 'lock' : '',
        m.thinkingEffort === false ? 'noeffort' : '',
        m.thinkingFormat ?? ''
      ].join(':')
    )
    .sort()
    .join(',')
}

/**
 * 保存该账号选中的对话模型(设置→模型页的增删入口)。
 *
 * 写盘顺序与登录那条一致:先落清单与激活态,再把内置 yunwu 供货商整份重算、下发内核。
 * 下发排进后台队列并**与相邻的几次编辑合并**(见 enqueueRenderInBackground),
 * 所以连续勾选不会变成一串串行的 config.set。
 *
 * **默认模型取清单第一条**:界面上那句「清单的第一条会作为默认模型」和已选标签上的
 * 「默认」角标,只有这里显式钉一次才成立。`resolveActivation` / `resolvePrimary` 是
 * 「旧默认还在就沿用」的粘滞规则(`model-catalog.ts:330`、本文件 `resolvePrimary`),
 * 那是给后台路径兜底的——启动对齐、模型下架都不该悄悄换掉用户的默认模型。但用户在选择器里
 * 亲手拖出来的顺序是**当着他的面**定的,再沿用旧值就成了「拖了没反应」。
 * 2026-08-17 真机撞到过:清单第一条已经是 deepseek-v4-flash,`primary` 仍是 claude-opus-4-6。
 *
 * 出图那三个不经过这里:它们由 resolveAccountModels 恒定带上,用户改不到。
 */
export function applyAccountChatModels(
  config: ActivationConfig,
  chat: ModelInfo[]
): ActivationConfig {
  // 用落盘后的那份而不是入参:它去过重、滤过非 chat,还兜过「删到 0」。
  const kept = saveSelectedChatModels(config, chat)
  const next = resolveActivation({ ...config, defaultModel: kept[0]?.id ?? config.defaultModel })
  saveActivation(next)
  applyProvidersConfig(upsertYunwuProvider(next), `yunwu/${next.defaultModel}`)
  // 搜索后端跟着对话模型清单走(用户勾了哪个带联网的,查资料就用哪个),所以这里得补一次
  // 下发 —— applyProvidersConfig 只渲染供货商那棵子树,而搜索后端落在 tools.* 下。
  // 不补的话用户改完模型要等下次启动 applyStartupConfig 才生效。
  // 值没变时 configBatchIsNoop 会短路掉,连续勾选不会变成一串落盘。
  // 单独一个槽:它与整份重渲染写的是不同子树,共用槽会互相顶掉(见 BackgroundRenderKey)。
  enqueueRenderInBackground('web-search', () =>
    setConfigBatch([...webSearchPolicyEntries(), ...suppliedToolDenyReleaseEntries()])
  )
  return next
}

/**
 * 保存供货商配置(模型管理页保存入口)。写完 providers.json 立即返回,
 * openclaw.json 的渲染排进后台队列,失败经 onSyncError 通知渲染层。
 * preferredPrimary 用于尽量保留用户当前默认模型;失效时回退首个可用 chat 模型。
 */
export function applyProvidersConfig(
  providers: ProviderConfig[],
  preferredPrimary?: string
): void {
  saveProviders(providers)
  enqueueRenderInBackground('render', () => renderConfig(providers, preferredPrimary, false))
}

/**
 * upsert 单个供货商(模型管理页的增/改入口),渲染同样排进后台队列。
 * 与 applyProvidersConfig 的整表覆盖相对:只动这一条,其余条目的 Key 原样留在磁盘上。
 */
export function applyProviderUpsert(
  provider: ProviderConfig,
  preferredPrimary?: string
): ProviderConfig[] {
  const next = upsertProvider(provider)
  enqueueRenderInBackground('render', () => renderConfig(next, preferredPrimary, false))
  return next
}

/**
 * 清掉 openclaw.json 里遗留的 UI 工具登记(存量安装的 `mcp.servers.yw`)。
 *
 * 登记已挪到插件包的 `.mcp.json`(见 ui-tools-bundle.ts)。这一条必须删干净:内核合并
 * MCP 时用户配置排在 bundle 之后(`loadMergedBundleMcpConfig` 里 configured 覆盖 bundle),
 * 旧条目留着,插件包那份就永远不生效,而它指向的临时端口早已失效。
 *
 * 只在键真的存在时才动手,所以这是一次性的:删完之后每次启动都直接返回,主配置零写入。
 * 网关侧整份写回时直接把键删掉即可;CLI 兜底用内核一方的 `mcp unset`,不去赌
 * `config set` 对 null 的处理(它是路径整体赋值语义,写进去的可能是字面 null,过不了 schema)。
 */
export async function removeLegacyUiToolsMcpEntry(): Promise<void> {
  const servers = (readOpenClawConfig().mcp as { servers?: Record<string, unknown> } | undefined)
    ?.servers
  if (!servers || !(UI_TOOLS_SERVER_NAME in servers)) {
    return
  }
  await viaGatewayOrCli(
    '清理旧的 UI 工具 MCP 登记',
    () =>
      gatewayClient.setConfig((config) =>
        deleteConfigPath(config, `mcp.servers.${UI_TOOLS_SERVER_NAME}`)
      ),
    () => runOpenClaw(['mcp', 'unset', UI_TOOLS_SERVER_NAME]).then(() => undefined),
    // 与启动期其它写入同口径:网关多半还没起来,等满建连超时只是白拖启动,
    // 而网关没在跑时不存在「内存配置与磁盘不一致」的竞态,直接写文件就是对的。
    { skipWhenDisconnected: true }
  )
}

/**
 * 接不出出图供货商、或用户把出图模型删空时,清掉遗留的 `agents.defaults.imageGenerationModel`。
 *
 * 为什么不能只是「不写」:内核**按这个键存不存在**决定要不要上架 `image_generate`
 * (媒体类工具都是这种 gated 形态)。键留着而云雾供货商没了 / 一个出图模型都没选,
 * 等于给模型一台坏工具:每次调用都以报错告终,而模型还会照常宣称已出图。
 * 换 key、模型下架、从别的账号迁过来、用户主动清空选择,都会走到这里。
 *
 * 删法:网关侧整份写回时直接删键,CLI 兜底用内核一方的 `config unset`。
 * **不能**把 `{value: null}` 塞进 `config set --batch-file` —— 它是路径整体赋值语义,
 * 写进去就是字面 null,内核直接判
 * `Config validation failed: agents.defaults.imageGenerationModel: Invalid input`,
 * 而且是整批失败,连带引导策略一起没下发(实测撞出来的)。
 *
 * 只在键真在、且确实接不出线时才动手,稳态下每次启动直接返回。
 */
export async function removeStaleImageGenerationModel(): Promise<void> {
  const agents = readOpenClawConfig().agents as Record<string, unknown> | undefined
  const defaults = agents?.defaults as Record<string, unknown> | undefined
  if (defaults?.imageGenerationModel === undefined) {
    return
  }
  if (resolveImageGeneration(loadProviders(), accountMediaSelection().image)) {
    return
  }
  await viaGatewayOrCli(
    '清理失效的出图模型选择',
    () =>
      gatewayClient.setConfig((config) =>
        deleteConfigPath(config, 'agents.defaults.imageGenerationModel')
      ),
    () =>
      runOpenClaw(['config', 'unset', 'agents.defaults.imageGenerationModel']).then(
        () => undefined
      ),
    { skipWhenDisconnected: true }
  )
}

/**
 * 接不出视频供货商时,清掉遗留的 `agents.defaults.videoGenerationModel`。
 *
 * 与出图同口径:内核按这个键决定要不要上架 `video_generate`。键留着而
 * `models.providers.yunwu` 没了,等于给模型一台必然失败的工具。
 */
export async function removeStaleVideoGenerationModel(): Promise<void> {
  const agents = readOpenClawConfig().agents as Record<string, unknown> | undefined
  const defaults = agents?.defaults as Record<string, unknown> | undefined
  if (defaults?.videoGenerationModel === undefined) {
    return
  }
  if (resolveVideoGeneration(loadProviders(), accountMediaSelection().video)) {
    return
  }
  await viaGatewayOrCli(
    '清理失效的视频模型选择',
    () =>
      gatewayClient.setConfig((config) =>
        deleteConfigPath(config, 'agents.defaults.videoGenerationModel')
      ),
    () =>
      runOpenClaw(['config', 'unset', 'agents.defaults.videoGenerationModel']).then(
        () => undefined
      ),
    { skipWhenDisconnected: true }
  )
}

/**
 * 接不出语音供货商、或用户把语音模型清空时,清掉遗留的 `messages.tts.providers.openai`。
 *
 * 与前两条不同的是 `tts` 工具**无条件在工具表里**(`agents/openclaw-tools.ts:439`),
 * 所以这里删的不是「工具上不上架」,而是「provider 配没配」:留着一份指向失效 key 的
 * provider,内核照样把它选为默认语音 provider,每次朗读都以 401 告终。
 *
 * 只删我们写的那一份 `openai` 与 `provider` 选择;用户要是自己配了别家 provider,不动它。
 */
export async function removeStaleTtsProvider(): Promise<void> {
  const messages = readOpenClawConfig().messages as Record<string, unknown> | undefined
  const tts = messages?.tts as { providers?: Record<string, unknown> } | undefined
  if (!tts?.providers || tts.providers.openai === undefined) {
    return
  }
  if (resolveTtsWiring(loadProviders(), accountMediaSelection().audio)) {
    return
  }
  await viaGatewayOrCli(
    '清理失效的语音模型选择',
    () =>
      gatewayClient.setConfig((config) => {
        deleteConfigPath(config, 'messages.tts.providers.openai')
        deleteConfigPath(config, 'messages.tts.provider')
      }),
    async () => {
      await runOpenClaw(['config', 'unset', 'messages.tts.providers.openai'])
      await runOpenClaw(['config', 'unset', 'messages.tts.provider'])
    },
    { skipWhenDisconnected: true }
  )
}
