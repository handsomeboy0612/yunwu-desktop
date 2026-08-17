/**
 * 主进程与渲染进程共享的类型定义。
 * 通过 preload 的 contextBridge 暴露的 API 均以这些类型为契约。
 */

import type { MediaKind } from './media-directives'

/**
 * 模型类别(由云雾 `/v1/models` 的 model_type/tags/endpoints 推导)。
 * 仅 chat 类进入聊天模型选择器与内核聊天 allowlist;图像/音视频等生成类模型
 * 不适合作为对话模型,单独归类以免混入下拉框。
 */
export type ModelCategory = 'chat' | 'image' | 'video' | 'audio' | 'embedding' | 'other'

/**
 * 带能力标记的模型信息。能力来源于云雾后端返回的 tags(零 App 维护):
 *  - reasoning:「思考」tag → 写入内核 `reasoning:true`,开启深度思考;
 *  - vision:「识图/视觉/多模态」tag → 写入内核 `input:["text","image"]`;
 *  - tools:「工具」tag → 支持工具调用;
 *  - search:「联网」tag 或 Gemini 系 → 能联网检索,详见 `main/model-capabilities.ts`;
 *  - category:模型类别(仅 chat 可作对话模型)。
 */
export interface ModelInfo {
  /** 模型 id(不含 provider 前缀,如 `deepseek-r1-250528`)。 */
  id: string
  /** 是否推理模型(可展示深度思考)。 */
  reasoning: boolean
  /** 是否支持图片输入。 */
  vision: boolean
  /** 是否支持工具调用。 */
  tools: boolean
  /**
   * 能不能联网检索。**这是对话模型的一个能力,不是单独一类模型** ——
   * 带这个标记的本身就是对话模型(`gemini-2.5-flash`、`gpt-4o-mini-search-preview`),
   * 所以不给它做独立的选择器,否则同一批模型要用户勾两次。
   *
   * 用途:`web_search` 工具的后端从**用户已选对话模型里带这个标记的**挑
   * (见 `config-writer.ts:webSearchPolicyEntries`);一个都没选中带标记的,
   * 才回落到本地兜底清单。
   */
  search: boolean
  /** 模型类别。 */
  category: ModelCategory
  /**
   * 这个模型必须走的 openclaw api,**只在偏离供货商默认协议时才有值**。
   *
   * 云雾给每条模型标了 `supported_endpoint_types`:绝大多数是 `openai`(即
   * `/v1/chat/completions`),但有一批 gpt-5 / o 系列只标 `openai-response`
   * —— 拿 chat/completions 打它们，上游直接回 *This is not a chat model*。
   * 内核允许单个模型覆盖供货商级协议(`config/defaults.ts:239` 的 `raw.api ?? providerApi`),
   * 所以这里只记下那批特例,其余留空继承 `yunwu` 供货商的 `openai-completions`。
   */
  api?: 'openai-responses'
  /**
   * 上游官方支持的思考档位。**只有家族规则认得的模型才有值**(见
   * `model-capabilities.ts:thinkingProfile`);留空表示"是思考模型但档位未知",
   * 此时界面只出思考开关、不铺档位 —— 这是 WorkBuddy 的降级路径,它的原话是
   * *Only the reasoning toggle will be shown*(`D:\workbuddy` app.asar 的
   * `settings.models.fields.supportedEffortsEmptyHint`)。
   */
  thinkingLevels?: Exclude<ChatThinking, 'off'>[]
  /** 默认思考档位(开着思考且用户没手选档位时用);留空按 `low/medium/high` 的中档走。 */
  defaultThinkingLevel?: Exclude<ChatThinking, 'off'>
  /**
   * 上游允许彻底关闭思考吗。`false` = 官方关不掉(Gemini 3+ 全系与 Gemini 2.5 Pro,
   * 见 `new-yunwu-api/relay/channel/gemini/thinking_capability.go:170-191`),
   * 界面把开关锁在开,配置层再写 `thinkingLevelMap.off = null` 让内核也不放行。
   */
  canDisableThinking?: boolean
  /**
   * `false` = 这个模型会思考,但上游**不接受 `reasoning_effort`**(Grok 4 及以后;内核
   * `detectCompat` 对 grok 就是这么判的,见
   * `openclaw/src/llm/providers/openai-completions.ts:1305-1306`)。
   * 此时不写 `supportsReasoningEffort`、界面不铺档位。
   *
   * **它不等于"不能开关思考"**:2026-08-16 实测 `qwen3.5-plus` / `glm-4.5` 都是
   * 档位不吃、但 `enable_thinking:false` 真能关(见 `thinkingFormat`)。这两件事分开表达,
   * 混在一起会把能关的模型锁成常开。
   */
  thinkingEffort?: boolean
  /**
   * 思考参数用哪种方言下发,对应内核 `compat.thinkingFormat`
   * (取值见 `openclaw/src/config/types.models.ts:65-73`)。
   *
   * **必须逐模型给,不能按族推。** 内核的 `detectCompat` 只认 provider/baseUrl
   * (`openai-completions.ts:1262-1323`),我们的 provider 是 `yunwu`,所以它一律判成
   * `"openai"` —— 于是给阿里系、智谱系模型下发的 `reasoning_effort` 没人读,
   * 而 `glm-4.5` 更是直接回 400(*The parameters `reasoning_effort` is not supported*)。
   *
   * 真机实测(`scripts/probe-thinking-params.mjs`,2026-08-16)证明同族方言都能不一样:
   * `glm-4.7` 吃 `enable_thinking`(→ `qwen`)而 `glm-5.1` 吃 `thinking:{type}`(→ `deepseek`)。
   * 留空 = 用内核默认(对我们就是 `openai`)。
   */
  thinkingFormat?: ThinkingFormat
}

/**
 * 内核支持的思考参数方言(`openclaw/src/config/types.models.ts:65-73` 的 `MODEL_THINKING_FORMATS`)。
 *
 * **两条路的方言表不一样,对话走的是窄的那条。** provider 侧
 * (`openai-completions.ts:716-753`)方言表是全的,包含 `deepseek → thinking:{type}`;
 * 但对话跑的是 agent transport(`agents/openai-transport-stream.ts:4422-4449`),那里只有
 * `qwen` / `qwen-chat-template` → `enable_thinking`、`together`、`openrouter` 三支,
 * 其余一律只在 `compat.supportsReasoningEffort` 为真时补 `reasoning_effort`。
 *
 * 所以 **`deepseek` 方言在对话路径上内核什么都不发**,开与关都由插件补
 * (`resources/yunwu-video-plugin/index.mjs` 的 `wrapChatThinking`)。2026-08-17 真机:
 * 没补之前 `glm-5.2` 开着思考连发三轮都拿不到思考正文,补上 `thinking:{type:"enabled"}` 后
 * 137 字思考。这一条别再按 provider 侧那张表推断。
 */
export type ThinkingFormat =
  | 'openai'
  | 'openrouter'
  | 'deepseek'
  | 'together'
  | 'qwen'
  | 'qwen-chat-template'
  | 'zai'

/**
 * 可选的媒体能力。与 `ModelCategory` 刻意不同名:那个是「模型产出什么」的分类,
 * 这个是「我们上架了哪几种能力」——向量与语音识别不在里面,因为内核这侧没有消费方。
 */
export type MediaModelKind = 'image' | 'video' | 'audio'

/** 媒体候选池里的一条。判据是端点类型,见 shared/media-endpoints.ts。 */
export interface MediaModelOption {
  id: string
  /** 平台给的 tags,原样展示(形如「绘画,dall-e-3格式」)。 */
  tags?: string
  /** 出图专有:这个模型还能按参考图编辑(`/v1/images/edits`,或对话端点 / 厂商异步那两条路)。 */
  canEdit?: boolean
  /**
   * 出图专有:这个模型**只能改图**,必须给参考图(今天只有 `mj_blend`:上游 blend 不收 prompt)。
   *
   * 与视频那侧的 `imageToVideo` 是同一件事的两个档,界面上共用「需参考图」那个徽标。
   * 出图这侧没法像视频那样用 `maxInputImagesByModel: 0` 让内核自己跳过它(内核的出图能力
   * 没有逐模型旋钮),所以标出来更要紧。
   */
  editOnly?: boolean
  /**
   * 视频专有:这个模型走的是**图生视频**(要一张参考图),而不是文生。
   *
   * 两种混在同一档里是刻意的 —— 内核按能力在同一条 primary+fallbacks 链上跳候选
   * (`openclaw/src/video-generation/runtime.ts:185-205`),所以配置层不需要分档;
   * 界面只要标出来,别让用户以为随便选一个都能凭一句话出片。
   */
  imageToVideo?: boolean
}

/** 该账号选中的媒体模型。出图/视频顺序即 primary → fallbacks;语音只有一个。 */
export interface MediaSelection {
  image: string[]
  video: string[]
  audio: string
}

/** 云雾激活配置:桌面客户端拿到后写入本地 OpenClaw 配置,并用于拉起网关。 */
export interface ActivationConfig {
  /** 云雾 API 基础地址,例如 https://yunwu.ai(不含 /v1)。 */
  baseUrl: string
  /** 云雾 API 令牌(sk-...),OpenClaw 以此作为 provider apiKey 调模型,计费走云雾。 */
  token: string
  /** 允许使用的模型名单(带能力标记,不含 provider 前缀)。 */
  models: ModelInfo[]
  /** 默认主模型,必须包含在 models 内。 */
  defaultModel: string
  /**
   * 云雾用户 id(登录接口 `/api/user/login` 返回的 `id`)。
   * **这是账号身份的唯一权威**:令牌会重新签发、用户名可以自己改,只有它不变。
   * 模型清单按它分账号存,见 `main/model-catalog.ts` 的 accountKey。
   *
   * 必填:`loadActivation` 会把缺这个字段的激活态当作未激活(让用户重登一次),
   * 换来「拿到 ActivationConfig 就一定有 userId」这个不变量,下游不必到处兜 undefined。
   */
  userId: number
  /** 云雾账号名。只用于展示(欢迎屏称呼一声),不参与任何存储键。 */
  username?: string
}

/**
 * 该账号的对话模型清单状态。
 *
 * 没有"服务端推荐"这一项:清单完全是用户数据,首次登录自己选,之后自己增删
 * (见 `main/model-catalog.ts` 开头对「为什么没有下发」的说明)。
 */
export interface ModelCatalogView {
  /** 此刻生效的对话模型。 */
  selected: ModelInfo[]
  /** 用户是否真的选过。false 表示还在用本地兜底清单,该引导他去选。 */
  chosen: boolean
  /**
   * 此刻生效的媒体模型三档。**这一份是纯本地读、不打网络**,
   * 所以设置页与首启引导都能拿它先把界面画出来,再决定要不要去拉可选池
   * (拉池子要打一次 `/v1/models`,不该让每次进设置页都等它)。
   */
  media: MediaSelection
  /** 用户是否选过媒体模型。false 表示首启该多走一步(或设置页该提示他去选)。 */
  mediaChosen: boolean
}

/** 「这把 key 现在能选什么」——首启选择器与设置页「添加模型」共用。 */
export interface AvailableModelsView {
  /** 该 key 此刻真能调的对话模型,已按 id 排序(接口原始顺序是乱的)。 */
  models: ModelInfo[]
  /**
   * 首启默认勾上的 id:本地常见清单与可选池的交集。
   * 交集为空就是空数组——预勾一个他调不通的模型,等于让他第一句话就吃 404。
   */
  preset: string[]
}

/**
 * 媒体后台任务的进度（出图 / 出视频 / 出音乐）。
 *
 * 一条会话同时最多一个：内核的 duplicateGuard 是按「工具 + provider」锁的，
 * 同一时刻第二次提交会被并进前一单（2026-08-13 实测）。
 * 生产者是 `main/media-relay.ts`，那里也写着这条通道为什么必须存在。
 */
export interface MediaTaskProgress {
  sessionKey: string
  taskId: string
  /** `image_generate` / `video_generate` / `music_generate`。 */
  tool: string
  /** 可直接显示的中文名：图片 / 视频 / 音乐。 */
  label: string
  /** running=还在生成，delivering=产物已出正在投递，done/failed=终态（终态即从界面撤走）。 */
  phase: 'running' | 'delivering' | 'done' | 'failed'
  startedAt: number
  /** 失败原因，已整理成中文。 */
  error?: string
}

/** 「这把 key 的媒体模型能选什么」——媒体选择器(首启一步 + 设置页)共用。 */
export interface AvailableMediaModelsView {
  /** 按端点类型筛出来的可选池,三档各自已按 id 排序。 */
  pool: Record<MediaModelKind, MediaModelOption[]>
  /** 此刻生效的选择(没选过就是本地预选)。 */
  selected: MediaSelection
  /** 预勾选:本地预选与可选池的交集。 */
  preset: MediaSelection
  /** 用户是否真的选过媒体模型。false = 首启该多走一步。 */
  chosen: boolean
}

/** 供货商预设的元信息(决定默认接口地址与协议)。 */
export interface ProviderPreset {
  id: ProviderPresetId
  /** 展示名。 */
  label: string
  /** OpenClaw provider api。 */
  api: string
  /** 默认接口地址(用户可改)。 */
  baseUrl: string
  /** 是否必须填 Key(本地部署如 Ollama 可不填)。 */
  needsKey: boolean
  /** 是否可由用户添加(yunwu 为内置,随登录自动写入,不在"添加"列表中)。 */
  addable: boolean
}

/**
 * 内置供货商预设清单(对齐 WorkBuddy 的厂商分组)。
 * 主/渲染进程共用:渲染层据此渲染"添加供货商"入口并预填默认地址与协议。
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'yunwu',
    label: '云雾',
    api: 'openai-completions',
    baseUrl: 'https://yunwu.ai/v1',
    needsKey: true,
    addable: false
  },
  {
    id: 'openai',
    label: 'OpenAI',
    api: 'openai-completions',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    addable: true
  },
  {
    id: 'deepseek',
    label: '深度求索',
    api: 'openai-completions',
    baseUrl: 'https://api.deepseek.com/v1',
    needsKey: true,
    addable: true
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com/v1',
    needsKey: true,
    addable: true
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    api: 'google-generative-ai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    needsKey: true,
    addable: true
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    api: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    addable: true
  },
  {
    id: 'ollama',
    label: 'Ollama(本地)',
    api: 'ollama',
    baseUrl: 'http://localhost:11434',
    needsKey: false,
    addable: true
  },
  {
    id: 'custom',
    label: '自定义(OpenAI 兼容)',
    api: 'openai-completions',
    baseUrl: '',
    needsKey: true,
    addable: true
  }
]

/** Composer 模型选择器的一个选项(内核完整键 + 展示名 + 是否推理模型)。 */
export interface ChatModelOption {
  /** 内核完整键 `<provider>/<model>`(发给 sessions.patch)。 */
  key: string
  /** 展示名。 */
  label: string
  /** 是否推理模型(展示深度思考标记 + 决定思考档位是否生效)。 */
  reasoning: boolean
  /** 供货商展示名(用于分组标题)。 */
  providerLabel: string
  /**
   * 是否为用户在「模型」设置页自行添加的自定义模型(非内置云雾账号同步)。
   * 选择器中归入「自定义模型」分组,对齐 WorkBuddy。
   */
  custom?: boolean
  /** 仅思考模式:不允许关闭思考(思考开关锁定为开)。 */
  onlyReasoning?: boolean
  /** 允许关闭思考:默认 true;false 时思考开关锁定为开。 */
  canDisableThinking?: boolean
  /**
   * 支持的思考强度档位(驱动 Composer 档位按钮动态渲染)。**留空的语义是"档位未知"**:
   * 此时只出思考开关、不铺档位,照 WorkBuddy 的 `supportedEffortsEmptyHint` 走。
   */
  thinkingLevels?: Exclude<ChatThinking, 'off'>[]
  /** 默认思考强度(选中该模型时的默认档位);留空用中档。 */
  defaultThinkingLevel?: Exclude<ChatThinking, 'off'>
  /** `false` = 会思考但档位不可控(Grok 4+):不铺档位。能不能开关另看 `canDisableThinking`。 */
  thinkingEffort?: boolean
  /** 思考参数方言,写进内核 `compat.thinkingFormat`(见 `ModelInfo.thinkingFormat`)。 */
  thinkingFormat?: ThinkingFormat
}

/** 本地 OpenClaw 网关运行状态。 */
export interface GatewayStatus {
  running: boolean
  port: number
  pid?: number
  /** 附加信息或错误原因。 */
  message?: string
}

/** 统一的 IPC 调用返回结构,便于渲染层处理成功/失败。 */
export interface IpcResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

/** Desktop feedback category persisted in the desktop product's dedicated table. */
export type FeedbackCategory = 'problem' | 'suggestion' | 'other'

/** 渲染层经 IPC 交给主进程的图片；Uint8Array 支持选择、拖放和剪贴板图片。 */
export interface FeedbackImageInput {
  name: string
  type: string
  data: Uint8Array
}

export interface FeedbackSubmission {
  category: FeedbackCategory
  content: string
  /** 打开反馈弹窗时所在的产品页面，仅作排查上下文。 */
  page: string
  images: FeedbackImageInput[]
  /** 默认关闭；开启后只上传运行状态，不含对话、文件内容或令牌。 */
  includeDiagnostics: boolean
}

export interface FeedbackSubmitResult {
  feedbackId: number
}

/** 令牌校验结果:返回该令牌在云雾侧可用的模型列表(带能力标记)。 */
export interface ValidateResult {
  models: ModelInfo[]
}

/** 账号密码登录结果:换取到的规范化 baseUrl + sk- 令牌 + 账号身份。 */
export interface LoginResult {
  baseUrl: string
  token: string
  /** 云雾用户 id,账号身份的唯一权威(见 ActivationConfig.userId)。 */
  userId: number
  username: string
}

/**
 * 账户余额一格的取数结果。
 *
 *  - `ok`          刚取到的新数;
 *  - `stale`       这次没取到但手上有上次的值 → 显示旧值并标注可能过期;
 *  - `expired`     会话过期/从未存过 → 提示重新登录(只为刷余额,不影响聊天);
 *  - `unavailable` 没有可显示的值,且原因不是过期。
 *
 * 刻意不提供「取不到时按 0 处理」的路径:余额显示成 0 会被读成「我的钱没了」。
 */
export type AccountSnapshotStatus = 'ok' | 'stale' | 'expired' | 'unavailable'

/** 账户余额与用量(已按站点货币口径渲染好,渲染层直接显示不再换算)。 */
export interface AccountBalance {
  /** 余额原始 quota 整数,给「余额偏低」这类阈值判断用。 */
  quota: number
  /** 余额展示串,如 `$12.34`;TOKENS 站点为纯数字串。 */
  display: string
  /** 余额是否偏低(不足一个货币单位),界面据它标红并提示充值。 */
  low: boolean
  /** 累计已用的展示串,同上口径。 */
  usedDisplay: string
  /** 用户分组名(default / vip …),空串表示后端没给。 */
  group: string
  /** 后端认定的账号名。 */
  username: string
  /** 云雾用户 id。 */
  userId: number
  /** 累计请求次数。 */
  requestCount: number
  /** 取数时刻(ms),渲染层据它显示「几分钟前」。 */
  fetchedAt: number
}

/** 账户快照:状态 + (可能是上次的)余额值 + 失败原因。 */
export interface AccountSnapshot {
  status: AccountSnapshotStatus
  /** `ok` 必有;`stale` 必有(是旧值);`expired`/`unavailable` 可能为 null。 */
  balance: AccountBalance | null
  /** 非 ok 时的可读原因,挂在界面上做提示。 */
  message?: string
}

/**
 * 云雾登录人机验证码类型(go-captcha)。与后端 /api/status.captcha_type 对齐。
 * 五种全部由桌面端原生渲染;后端若换上这个联合类型之外的新方式,登录页如实报错待适配。
 */
export type CaptchaType =
  'slide-basic' | 'slide-region' | 'rotate' | 'click-text' | 'click-shape'

/** 站点登录验证码开关与类型(来自 /api/status)。 */
export interface CaptchaConfig {
  /** 登录是否强制人机验证(captcha_login_enabled)。 */
  enabled: boolean
  /** 当前验证码类型(captcha_type)。 */
  type: CaptchaType
}

/**
 * 一道验证码题面(主进程从 /api/go-captcha-data/* 取回后规范化)。
 * 图片以 base64 传给渲染层用 data URI 显示,避免渲染层跨源请求(CORS)。
 */
export interface CaptchaChallenge {
  key: string
  type: CaptchaType
  /** 主图 base64(不含 data: 前缀)。 */
  imageBase64: string
  imageWidth: number
  imageHeight: number
  /** 点选:提示缩略图;滑块:拼块图;旋转:要转的圆块。base64,不含前缀。 */
  thumbBase64?: string
  thumbWidth?: number
  thumbHeight?: number
  /**
   * 旋转专用:圆块直径。rotate 的题面只给 `thumb_size` 一个值,
   * `thumb_width`/`thumb_height` 与 `tile_*` 全部缺席(2026-08-14 真机取题核对)。
   */
  thumbSize?: number
  /** 滑块拼块初始位置/尺寸(渲染滑块初始位)。 */
  tileX?: number
  tileY?: number
  tileWidth?: number
  tileHeight?: number
}

/** 验证码校验结果:通过时返回可用于登录的一次性 captcha_token。 */
export interface CaptchaVerifyResult {
  /** 通过则为一次性令牌;失败为空。 */
  token: string
}

/**
 * 供货商预设 id(WorkBuddy 式模型管理页的厂商分组)。
 * `yunwu` 为内置账号供货商(随登录自动写入,不可删除);其余为用户可添加的第三方。
 */
export type ProviderPresetId =
  'yunwu' | 'openai' | 'gemini' | 'deepseek' | 'openrouter' | 'ollama' | 'anthropic' | 'custom'

/** 模型管理页中一个供货商下的单个模型(用户可增删、可手动标记能力)。 */
export interface ProviderModel {
  /** 模型 id(请求时发给上游的 model 值)。 */
  id: string
  /** 展示名(可选,默认取 id)。 */
  name?: string
  /** 深度思考(reasoning)能力。 */
  reasoning: boolean
  /** 图片输入能力。 */
  vision: boolean
  /** 工具调用能力。 */
  tools: boolean
  /** 模型类别。 */
  category: ModelCategory
  /**
   * 覆盖供货商级协议,只在这个模型偏离默认协议时才有值(见 `ModelInfo.api`)。
   * 内核按 `raw.api ?? providerApi` 解析(`config/defaults.ts:239`),所以同一个供货商下
   * 可以混着两种协议,不必为这批模型另开一个 provider。
   */
  api?: 'openai-responses'
  /** 上下文窗口(可选,留空用保守默认)。 */
  contextWindow?: number
  /** 最大输出 token(可选,留空用保守默认)。 */
  maxTokens?: number
  /** 仅思考模式:模型只能以思考模式运行,选择器不展示"关闭思考"入口(对齐 WorkBuddy)。 */
  onlyReasoning?: boolean
  /** 允许关闭思考:默认 true;无法关闭思考的接口/模型置 false。 */
  canDisableThinking?: boolean
  /**
   * 支持的思考强度档位(对齐 WorkBuddy「支持的思考强度」)。留空表示不做声明,
   * 由内核按模型默认能力(通常 low/medium/high)自行判定;声明后写入
   * compat.supportedReasoningEfforts + thinkingLevelMap,可放出 xhigh/max。
   */
  thinkingLevels?: Exclude<ChatThinking, 'off'>[]
  /** 默认思考强度(对齐 WorkBuddy「默认思考强度」)。留空表示用请求层默认(自动)。 */
  defaultThinkingLevel?: Exclude<ChatThinking, 'off'>
  /** `false` = 会思考但上游不吃 `reasoning_effort`,配置层据此不写 supportsReasoningEffort(见 `ModelInfo.thinkingEffort`)。 */
  thinkingEffort?: boolean
  /** 思考参数方言,写进内核 `compat.thinkingFormat`(见 `ModelInfo.thinkingFormat`)。 */
  thinkingFormat?: ThinkingFormat
}

/**
 * 一个供货商配置(对齐 WorkBuddy 的自定义模型:厂商/接口/Key/模型/能力)。
 * App 侧 `providers.json` 为单一数据源,声明式整体渲染进 openclaw.json。
 */
export interface ProviderConfig {
  /** 供货商在 openclaw `models.providers.<id>` 下的键(内置 yunwu;自定义为 slug)。 */
  id: string
  /** 展示名。 */
  label: string
  /** 预设厂商类型(决定默认 baseUrl/接口协议)。 */
  preset: ProviderPresetId
  /** OpenClaw provider api(openai-completions / anthropic-messages 等)。 */
  api: string
  /** 接口基础地址(openai 兼容通常以 /v1 结尾)。 */
  baseUrl: string
  /** API Key(在内存/渲染层为明文;落盘时按需 safeStorage 加密)。本地部署可空。 */
  apiKey: string
  /** 该供货商下的模型清单。 */
  models: ProviderModel[]
  /** 内置供货商(yunwu 账号)不可删除、Key 随登录自动维护。 */
  builtin?: boolean
}

/** 文件访问权限模式:default = 仅受管工作区;full = 全盘访问(高风险)。 */
export type PermissionMode = 'default' | 'full'

/**
 * 对话行为模式(对齐 WorkBuddy 的 Craft/Ask/Plan):
 *  - craft:完整执行,可读写文件、运行命令(默认);
 *  - ask:仅只读问答,不修改文件、不产生副作用;
 *  - plan:先产出分步方案,经确认后再执行。
 *
 * 说明:openclaw 工具白名单为配置级(不支持每轮 chat.send 传参),
 * 故本期以系统指令注入实现软约束;工具级硬隔离留作后续增强。
 */
export type ChatMode = 'craft' | 'ask' | 'plan'

/**
 * 深度思考(reasoning)档位。透传给内核 chat.send/sessions.patch,与 OpenClaw 的
 * ThinkingLevel 对齐(off/low/medium/high/xhigh/max;省略内部 minimal):
 *  - off:关闭思考;low/medium/high/xhigh/max:逐级加大推理预算。
 * 内核 `clampThinkingLevel` 会依据 provider+模型能力自动收敛:非推理模型即便传高档也降级为 off,
 * 模型不支持的高档(如 xhigh/max)会被安全收敛到最近可用档位,故 UI 层可放心传档位。
 * 落到 openai 兼容协议时:max→xhigh、off→不带 effort,其余透传为 reasoning_effort。
 */
export type ChatThinking = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** 可选的思考强度档位(不含 off),用于模型「支持的思考强度」声明与选择器渲染。 */
export const THINKING_LEVELS: Exclude<ChatThinking, 'off'>[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

/** 思考强度中文标签(对齐 WorkBuddy:低/中/高/超高/极致)。 */
export const THINKING_LABELS: Record<Exclude<ChatThinking, 'off'>, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '极致'
}

/**
 * 逐模型的思考偏好。
 *
 * WorkBuddy 的思考设置是**按模型存的**,不是一个全局值:在某个模型的悬浮卡片里改档位,
 * 若它不是当前选中的模型,只写它自己的偏好、不切换模型
 * (`onEffortPreferenceChange(primary.id, effort)`,见 `model-select.tsx` 里
 * `if (selectedId !== primary.id && onEffortPreferenceChange) … else onChange(...)`);
 * 选中的那个才立即改会话态。所以这里按模型键存。
 */
export interface ModelThinkPref {
  /** 是否开启思考;缺省=按模型默认(见 `thinkingOnOf`)。 */
  on?: boolean
  /** 手选档位;缺省=按模型声明的默认档。 */
  level?: Exclude<ChatThinking, 'off'>
}

/** 思考能力声明的结构子集(`ModelInfo` / `ProviderModel` / `ChatModelOption` 三者共有)。 */
export interface ThinkingCapability {
  reasoning?: boolean
  onlyReasoning?: boolean
  canDisableThinking?: boolean
  thinkingLevels?: Exclude<ChatThinking, 'off'>[]
  defaultThinkingLevel?: Exclude<ChatThinking, 'off'>
  thinkingEffort?: boolean
  thinkingFormat?: ThinkingFormat
}

/**
 * 该模型可选的档位。照 WorkBuddy 的 `getReasoningEffortItems`:拿它的档位元表
 * (`REASONING_EFFORT_META` = low/medium/high/xhigh/max,**不含 minimal**)去过滤模型声明,
 * 所以顺序由元表定、声明里的杂值会被丢掉。
 * 档位不可控的族(Grok 4+ 那种只会自己思考的)一律没有档位可选。
 */
export function thinkingLevelsOf(m?: ThinkingCapability | null): Exclude<ChatThinking, 'off'>[] {
  if (!m?.reasoning || m.thinkingEffort === false) {
    return []
  }
  const declared = m.thinkingLevels ?? []
  return THINKING_LEVELS.filter((l) => declared.includes(l))
}

/**
 * 思考开关能不能动。对齐 WorkBuddy 的
 * `canToggleThinking = supportsReasoning && !onlyReasoning && canDisableThinking !== false`。
 *
 * **这里刻意不再看 `thinkingEffort`。** 原来多加了那一条(理由是"档位不可控 ≈ onlyReasoning"),
 * 2026-08-16 的真机实测证明它是错的:`qwen3.5-plus` / `glm-4.5` / `glm-4.7` 都不吃
 * `reasoning_effort`,但 `enable_thinking:false` 一发过去思考立刻停(正文 3 字秒回)。
 * 两件事混成一条的后果是把这批能关的模型锁成常开。
 *
 * 真正关不掉的族(Grok 4+、`o1-mini`、qwen 的 `-thinking` 变体——上游原话
 * *The value of the enable_thinking parameter is restricted to True*)靠
 * `canDisableThinking:false` 表达,不再蹭 `thinkingEffort` 这条。
 */
export function canToggleThinking(m?: ThinkingCapability | null): boolean {
  return !!m?.reasoning && !m.onlyReasoning && m.canDisableThinking !== false
}

/**
 * 卡片里那行「思考强度」要不要显示。照 WorkBuddy 的 `isReasoningConfigurable`:
 * 只有用户真能改点什么(有档位可选,或至少能开关)才显示;
 * 既没档位又关不掉的模型什么都不给——这就是「档位未知」时 off 态的答案,不是我们自己定的。
 */
export function isThinkingConfigurable(m?: ThinkingCapability | null): boolean {
  if (!m?.reasoning) {
    return false
  }
  return thinkingLevelsOf(m).length > 0 || canToggleThinking(m)
}

/** 当前是否开着思考。照 WorkBuddy 的 `getDefaultIsThinking`:关不掉的族恒为开,其余默认开。 */
export function thinkingOnOf(m?: ThinkingCapability | null, pref?: ModelThinkPref): boolean {
  if (!m?.reasoning) {
    return false
  }
  if (!canToggleThinking(m)) {
    return true
  }
  return pref?.on ?? true
}

/**
 * 当前生效的档位;`undefined` = 该模型没有可选档位(档位未知或不可控)。
 * 照 WorkBuddy 的 `actionEffort`:手选值与模型默认档里取第一个仍在可选集中的,都不在则退到最低档。
 */
export function thinkingLevelOf(
  m?: ThinkingCapability | null,
  pref?: ModelThinkPref
): Exclude<ChatThinking, 'off'> | undefined {
  const levels = thinkingLevelsOf(m)
  if (levels.length === 0) {
    return undefined
  }
  return (
    [pref?.level, m?.defaultThinkingLevel].find((l) => !!l && levels.includes(l)) ?? levels[0]
  )
}

/**
 * 归一化后的 agent 运行事件(主进程从网关原始事件帧提炼,转发给渲染层用于流式渲染)。
 * 覆盖 WorkBuddy 式体验的三类信号:文字增量、工具步骤、运行生命周期。
 */
export type AgentEvent =
  | {
      /** 助手文字增量。deltaText 为本次增量,text 为累计快照,replace=true 表示整段替换。 */
      kind: 'delta'
      sessionKey: string
      runId?: string
      deltaText: string
      text?: string
      replace?: boolean
    }
  | {
      /**
       * 助手深度思考流(reasoning/thinking)。
       * 网关经 `agent` 事件 `stream:"thinking"` 广播,与正文(chat delta)分离。
       * thinkingDelta 为本次增量,thinkingText 为累计快照,replace=true 表示整段替换。
       */
      kind: 'thinking'
      sessionKey: string
      runId?: string
      thinkingDelta: string
      thinkingText?: string
      replace?: boolean
      /**
       * 思考段所属的轮次消息 id(来自 session.message 的 messageId)。
       * agent 多轮运行里每轮各有一段思考,用它把「思考段」按轮次插入时间线并去重,
       * 实现 WorkBuddy 式「思考 ↔ 工具」交错展示,而非只保留最后一段。
       */
      messageId?: string
    }
  | {
      /** 一轮回复结束。text 为最终文本,stopReason 为结束原因(stop/aborted/error 等)。 */
      kind: 'final'
      sessionKey: string
      runId?: string
      text: string
      stopReason?: string
      /**
       * 本轮模型附上的媒体产物(本机绝对路径,也可能是 URL)。
       *
       * 必须由主进程另行带上,**不能从 text 里解析**:内核在广播 chat 之前就把 `MEDIA:` 行
       * 从正文里剥走了(真机抓帧:同一轮 `agent`/`stream:"assistant"` 带 mediaUrls,而
       * `chat`/`state:"final"` 的文本里已经没有那一行)。历史还原读的是模型原话,那侧仍走
       * 正文解析 —— 两条路的输入不同,不要合并成一条。
       */
      mediaPaths?: string[]
      /**
       * 最终消息里的深度思考快照(从 message.content 的 `thinking` 块提取)。
       * 兜底路径:部分模型(如 glm)不经 `stream:"thinking"` 实时推送思考,
       * 而是把思考作为最终消息的内容块下发,这里提取出来补显「深度思考」。
       */
      thinking?: string
    }
  | {
      /** 工具步骤(读写文件、执行命令等)。用于渲染步骤条。 */
      kind: 'tool'
      sessionKey: string
      runId?: string
      itemId: string
      /** 人类可读标题,如 "write to IDENTITY.md (149 chars)"。 */
      title: string
      /** running / completed / failed。 */
      status: string
      name?: string
      /** 失败原因(status=failed 时)。 */
      error?: string
      /**
       * 工具入参。用于富卡片渲染:
       *  - update_plan → 解析为可勾选待办清单;
       *  - write/edit/apply_patch → 解析出产出物路径、行数增删、内容预览。
       *
       * 注意来源:内核把一次工具调用拆成两条流,面向 UI 的 item 流**不带入参**,
       * 入参只在 `stream:'tool'` 的 start 事件里。归一化层按 toolCallId 把两者合并
       * (见 gateway-client 的 toolCallDetails),所以这里通常是有值的。
       */
      input?: unknown
      /** 工具结果文本(来自 `stream:'tool'` 的 result 事件),用于算真实的 diff 行数。 */
      result?: string
      /** 命令类工具的结构化执行结果(退出码 / 耗时 / 还在后台跑)。 */
      exec?: ExecOutcome
      /** edit 类工具的展示用 diff(内核 `details.diff`,带行号与上下文)。 */
      diff?: string
    }
  | {
      /**
       * 专家团成员(子会话)的运行状态,来自网关 `sessions.changed`。
       *
       * 为什么不能从 `sessions_spawn` 的工具状态推:那个工具**当场**返回 `accepted`,
       * 成员还在干活它就已经 completed 了(结果稍后由内核另行回报)。照工具状态渲染,
       * 成员条会在派活的一瞬间集体变成"已完成",等于骗人。子会话自己的生命周期才是真的。
       */
      kind: 'member'
      /** 父会话 key(即任务的 sessionKey),事件按它路由到对应任务。 */
      sessionKey: string
      /**
       * 这条子会话是哪位成员,与名册 `TeamRosterEntry.key` 逐字相同。
       *
       * 取值优先 `sessions_spawn` 的 `label`(内核把它落在子会话条目上,见 gateway-client
       * 的 normalizeMemberEvent),取不到才退回 `agentId`。为什么不能只看 agentId:
       * 今天的专家团负责人**自己 spawn**(不指定 agentId),所有成员的 agentId 都是 `main`,
       * 拿它当键会让全团挤成一个人。存量任务仍是指名道姓 spawn `expert-<slug>-<id>`,
       * 那些事件没有 label,退回 agentId 正好对上老名册。
       */
      memberKey: string
      status: MemberRunStatus
    }
  | {
      /** 运行生命周期:start(开始思考)/ finishing / end(结束)。 */
      kind: 'lifecycle'
      sessionKey: string
      runId?: string
      phase: string
      stopReason?: string
      aborted?: boolean
      /**
       * 本轮是「主动让出」而非中止:agent 调 `sessions_yield` 收尾、挂起等子会话回信时为 true。
       *
       * 内核对这种收尾给的 stopReason 同样是 `aborted`,且在没有真实错误时会合成一句
       * `agent run aborted`(run-termination 里的 AGENT_RUN_ABORTED_ERROR)——只看 aborted
       * 会把暂停误判成失败。内核自己的消费方也是先认这个字段的:subagent-registry 里
       * `wait.yielded === true` 就把 pending 的 lifecycle error 清掉。
       */
      yielded?: boolean
      /**
       * 内核给出的中止/失败原因原文(如 `LLM idle timeout (600s): no response from model`)。
       * 没有它时 UI 只能显示笼统的「回复已中断」,用户无从判断是该重试还是环境有问题。
       */
      errorMessage?: string
    }

/** agent:send 的返回:本轮运行的 runId。 */
export interface AgentSendResult {
  runId?: string
  status?: string
}

/** update_plan 待办清单中的一步(对齐 WorkBuddy 的可勾选待办)。 */
export interface PlanStep {
  /** 步骤文案。 */
  text: string
  /** 状态:pending(待办)/ in_progress(进行中)/ completed(已完成)。 */
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * 产出物文件引用(对齐 WorkBuddy present_files 卡片)。
 *
 * 两个来源:write/edit/apply_patch 等写入类工具的入参,以及助手回复里的 `MEDIA:` 指令
 * (`image_generate` 这类生成工具不写文件到工作区,只在回复里附媒体路径)。
 */
export interface ArtifactRef {
  /** 工具入参里的原始路径(相对 agent workspace 或绝对路径)。 */
  path: string
  /** 展示用文件名(路径末段)。 */
  name: string
  /**
   * 媒体类别。缺省(旧数据/写入类工具)按扩展名现推即可,
   * 带上只是省掉一次推导并标明这条是从 `MEDIA:` 指令来的。
   */
  kind?: MediaKind
}

/** 读取产出物文件的返回。 */
export interface ArtifactContent {
  name: string
  path: string
  /** 真实本地绝对路径(用于展示 + 在文件管理器中定位/reveal)。 */
  abs?: string
  /** 按扩展名判定的媒体类别,决定预览面板走图片还是文本分支。 */
  kind?: MediaKind
  /** 文本内容(图片/其它二进制返回空)。 */
  content: string
  /** 图片字节的 base64。渲染层转 Blob + objectURL 展示(对齐 WorkBuddy)。 */
  imageBase64?: string
  /** 是否有可展示内容(文本正文或图片字节)。 */
  previewable: boolean
  /** 是否因超限被截断(图片超限时为 true 且不返回字节)。 */
  truncated: boolean
  /** 文件字节大小。 */
  size: number
}

/**
 * 一个工作空间:本地一个文件夹,被选中后作为该任务的工作目录(会话 `spawnedCwd`)。
 *
 * 与 WorkBuddy 同义 —— 它的工作空间也只是「一次会话落在哪个文件夹」,
 * 不是一道边界:选了它,AI 干活的默认位置就在这儿,但并不会被锁死在这儿。
 */
export interface WorkspaceEntry {
  /** 绝对路径。 */
  path: string
  /** 展示名(文件夹名)。 */
  name: string
  /** 最近一次被选用的时间,用于菜单排序。 */
  lastUsedAt: number
}

/**
 * 应用级偏好(设置页里的开关),落在 userData/preferences.json。
 *
 * 与 openclaw 的配置分开:这些是我们自己的产品选项,不进内核配置,也就不会触发热加载。
 */
export interface AppPreferences {
  /**
   * 「本地技能与记忆沉淀」。默认开;关掉后项目级记忆与项目级技能整段不注入提示词。
   *
   * 对位 WorkBuddy 的同名开关(它渲染端也是正向的 `enabled`,主进程存反向键
   * `disableLocalSkillsMemory`,默认 false)。关掉只停注入,已经写下的记忆文件留在
   * 工作空间里不动 —— 它那侧也是这么做的,`MemoryCollector` 只是把相关变量置空串。
   */
  localSkillsMemoryEnabled: boolean
}

/**
 * 任务组的 UI 元数据(持久化到 tasks.json)。
 *
 * 设计:消息历史不在此重复存储(遵循"无双写"),而是从内核 session store(jsonl)
 * 按需恢复;这里只存内核不感知的 UI 状态(标题/置顶/创建时间/会话 key)。
 */
export interface TaskMeta {
  id: string
  title: string
  /** 稳定会话 key(agent:<taskId>:main),与内核 isolated agent 一一对应。 */
  sessionKey: string
  pinned?: boolean
  createdAt: number
  /** 该任务绑定的专家 slug(由专家发起的会话);普通任务留空。 */
  expertSlug?: string
  /** 专家展示名快照(渲染任务项/会话头部,免二次查注册表)。 */
  expertName?: string
  /** 专家头像 URL 快照。 */
  expertAvatar?: string
}

/** 从内核 session 恢复的一条历史消息(文本 + 深度思考;工具步骤等富信息暂不恢复)。 */
export interface SessionMessage {
  role: 'user' | 'assistant'
  content: string
  /** 助手深度思考快照(从消息 content 的 `thinking` 块提取);重开任务时补显折叠块。 */
  thinking?: string
  /**
   * 本轮 update_plan 待办清单快照(取该轮最后一次 update_plan 调用参数解析)。
   * 重开任务时还原可勾选清单(对标实时运行的 D 能力)。
   */
  plan?: PlanStep[]
  /**
   * 本轮产出物文件(由 write/edit/apply_patch 工具调用参数聚合去重)。
   * 重开任务时还原产出物卡片(对标实时运行的 E 能力)。
   */
  artifacts?: ArtifactRef[]
  /**
   * 本轮完整执行过程(分段思考 / 工具步骤 / 问答卡 / 图示,按发生顺序)。
   * 内核已把这些完整落盘(toolCall + toolResult 成对、带 isError),
   * 所以重开任务能还原出与运行当时一致的「已完成」展开内容。
   */
  timeline?: TimelineItem[]
  /**
   * 这一轮的失败说明(重开历史时补显红色错误条)。
   *
   * 内核的 incomplete-turn 报错(⚠️ Agent couldn't generate a response)只作为
   * **投递载荷**发出去,不落进会话抄本,所以光按抄本还原会把失败的一轮画成
   * 「已完成」+ 一块思考,看不出这轮其实什么都没产出。由还原侧按同一份数据判定。
   */
  error?: string
}

/**
 * 本地 Agent 市场资产类型(与 admin-server desktop_market 的 type 对齐)。
 * 第一期只启用 skill;connector/expert 为后续期。
 */
export type MarketAssetType = 'skill' | 'connector' | 'expert'

/**
 * 市场条目(来自 admin-server `/api/desktop-market/items`,字段对齐后端 snake_case)。
 * 仅列出客户端展示/安装需要的字段;其余后端字段忽略。
 */
export interface MarketItem {
  id: number
  type: MarketAssetType
  slug: string
  name: string
  description_zh?: string
  description_en?: string
  version?: string
  icon?: string
  category_id?: number
  /** 后端存的是 JSON 字符串,渲染层按需解析。 */
  tags?: string
  download_count?: number
  featured?: boolean
  /** 上架时间(秒);「最新」排序用。 */
  published_at?: number
  /**
   * 是否专家团(仅 type=expert 有意义)。
   *
   * 服务端把 manifest.isTeam 物化成了一列 —— 列表快照 Omit 掉 manifest(longtext),
   * 否则「这条是不是专家团」在列表页无从得知,做不出「专家 / 专家团」二级 tab。
   */
  is_team?: boolean
  /**
   * 类型专属清单(JSON 字符串)。仅详情接口返回:
   *  - connector:ConnectorManifest(MCP 配置 + 鉴权模式);
   *  - expert:ExpertManifest(职业/模型/工具白名单/persona 技能/头像/快捷提示等);
   *  - skill:留空(靠 zip 制品)。
   */
  manifest?: string
}

/**
 * 专家列表的二级 tab(对齐 WorkBuddy `list-tabs-row.tsx` 的 listTab)。
 * 专家团与单体专家同表同类型,靠 is_team 区分。
 */
export type MarketListTab = 'expert' | 'team'

/**
 * 列表排序(对齐 WorkBuddy 的 综合 / 最热 / 最新)。
 * WorkBuddy 是服务端排(sort_by=reco_rank / use_count / published_at);我们的快照本就是
 * 全量一次到手,直接在本地按同样三个维度排,省一次往返。
 */
export type MarketSortOrder = 'reco' | 'popular' | 'newest'

/**
 * 条目描述:优先中文,缺失时退英文。
 *
 * 从开源仓库批量导入的技能只有英文描述(上游 SKILL.md 的 frontmatter 就是英文),中文描述
 * 要靠后续人工/翻译补。只读 description_zh 的话这批条目在卡片和详情里会是一片空白 ——
 * 用户看到的是"这个技能没写介绍",而不是"介绍还没翻译"。
 */
export function marketItemDesc(
  it: Pick<MarketItem, 'description_zh' | 'description_en'>
): string {
  return (it.description_zh || it.description_en || '').trim()
}

/**
 * 市场分类(来自 admin-server `/api/desktop-market/categories?type=`)。
 * 按资产类型隔离(skill/connector/expert 各一套),用于画廊分类 chips 过滤。
 */
export interface MarketCategory {
  id: number
  type: MarketAssetType
  name: string
  slug: string
  sort_order?: number
  status?: number
}

/**
 * 专家清单(运营在 admin-cloud 填写,存 DesktopMarketItem.manifest)。
 *
 * 专家 = 一个带专属 persona/工具白名单/专属模型/头像的对话角色。安装后:
 *  - persona zip 制品装入 `~/.openclaw/skills/<personaSkillSlug>`;
 *  - 元数据登记到本地专家注册表(供"我的专家"与 Composer 选择器渲染)。
 * 选中该专家开新会话时,把这些字段套用到一个任务级 isolated agent(播种):
 * 写入其 `AgentConfig`(model/tools/skills=[personaSkillSlug]/identity),并把 persona
 * 叠写进该 agent workspace 的 `AGENTS.md` 强化角色设定——由此得到 WorkBuddy 式的
 * "选专家→专属能力的新会话",且每个专家可开多条会话(各为任务列表里的一条)。
 */
export interface ExpertManifest {
  /**
   * 专家标识基名(slug 同源,如 'data-analyst')。
   * 持久专家 agent id 约定为 `expert-<slug>`(Phase 2 专家团委派目标用);
   * Phase 1 单体会话按任务 agent 播种,不强依赖该持久 agent。
   */
  agentId: string
  /** 职业/头衔(卡片副标题,如「数据分析师」)。 */
  profession?: string
  /** 专属模型内核完整键 `<provider>/<model>`(如 `yunwu/glm-5.1`);留空用当前默认主模型。 */
  model?: string
  /** 工具白名单(内核工具名列表);留空继承默认。安装时映射到 AgentConfig.tools.allow。 */
  tools?: string[]
  /**
   * 捆绑技能:该专家自带的市场技能 slug 列表(如内容专家自带「网页调研」)。
   * 安装专家时会一并安装这些技能到 skills/<slug>/;播种 agent 时并入 skills 白名单
   * (与 personaSkillSlug 一起),实现「专家=persona + 专属技能」。仅并入确实已安装的技能。
   */
  bundledSkills?: string[]
  /** persona 技能 slug(zip 制品装入 skills/<slug>,并作为该专家 agent 的 skills 白名单唯一项)。 */
  personaSkillSlug: string
  /** 头像 URL(admin 上传;卡片与会话头部展示)。 */
  avatar?: string
  /** 展示名覆盖(留空用市场条目 name);写入 AgentConfig.identity.name。 */
  displayName?: string
  /** 快捷提示词(会话空态 chips;没有 defaultInitPrompt 时首条兼作召唤预填)。 */
  quickPrompts?: string[]
  /**
   * 召唤该专家后预填进输入框的开场白。
   *
   * 对齐 WorkBuddy 的 defaultInitPrompt:它是"点了这个专家,替用户开的第一句口",与
   * quickPrompts 那排"试试这样问我"的 chips 是两件事。上游 406 个专家里 390 个把它同时
   * 放在 quickPrompts[0],所以此前只读 quickPrompts[0] 大体也对 —— 但剩下 16 个不是,
   * 那 16 个用 chips 的第一句当开场白会文不对题。
   */
  defaultInitPrompt?: string
  /** 专家团标记(多 agent 编排)。 */
  isTeam?: boolean
  /**
   * 团成员的专家 slug 列表:成员各自是独立上架的专家条目,须**已安装**才能被委派。
   * 我们自撰的样板团队用这种形式;导入的团队用 `members`(见下)。
   */
  memberSlugs?: string[]
  /**
   * 团成员名单(人设随本团 persona 包一起下发,见 ExpertTeamMember)。
   *
   * 与 memberSlugs 的区别是成员人设从哪来:memberSlugs 要求成员先作为独立专家被安装,
   * 而 members 的人设就在本团包的 `members/<id>.md` 里,装了团队即成员齐备。外部导入的
   * 团队一律走这条路——上游的成员根本不作为独立专家上架,用 slug 引用会永远指向空。
   */
  members?: ExpertTeamMember[]
  /**
   * 专家团负责人的**展示**信息(详情页编制的第一行,挂「⭐ 主理人」徽章)。
   *
   * 它刻意不在 `members` 里:members 是委派名册,主进程 `teamMemberRefs` 会按它逐个建持久
   * agent 并写进 `subagents.allowAgents`,渲染层 `resolveTeamRoster` 按它画成员条 —— 负责人
   * 混进去就成了自我委派。上游把两件事装在同一个数组里(members[] 含负责人且标 role=lead,
   * 委派另看 teamInfo.memberAgents),我们把展示的那一份单独拎出来,这样「谁能被派活」在
   * 类型上就是清楚的,不指望每个消费方都记得过滤。
   *
   * 负责人就是点「召唤」后与用户对话的那一位,它的人设即本条目自身,没有 `members/<id>.md`。
   */
  lead?: ExpertTeamMember
}

/** 专家团成员的运行状态(成员条上的转圈 / 对勾 / 叉)。 */
export type MemberRunStatus = 'running' | 'completed' | 'failed'

/** 专家团成员;人设正文在本团 persona 包的 `members/<id>.md`。 */
export interface ExpertTeamMember {
  /** 成员标识,同时是包内人设文件名(`members/<id>.md`)。 */
  id: string
  displayName?: string
  profession?: string
  avatar?: string
  /**
   * 一句话说明这名成员是干什么的,用于负责人人设里的委派名册(不做展示)。
   * 取自成员人设的 frontmatter description,可能是英文——它是给模型判断"该派谁"的信号。
   */
  description?: string
}

/**
 * 本地已安装的专家(读专家注册表 experts.json)。
 * 比通用 MarketInstalledItem 富,携带 Composer 选择器/会话头部所需的展示与播种字段。
 */
export interface InstalledExpert {
  slug: string
  name: string
  version: string
  /** 安装时间(毫秒)。 */
  installedAt: number
  /** 完整专家清单(播种任务 agent 与渲染卡片所需)。 */
  manifest: ExpertManifest
}

/**
 * 一张表装着两种形状,取用方必须挑明要哪一种(服务端 `?kind=`)。
 *
 * - `featured` = 专家中心那屏的整卡背景图大卡(cover + 关联专家),`scene_slug` 为空;
 * - `playbook` = 首页输入框下方那行实践案例,挂在某个 DesktopScene.slug 下。
 *
 * 两处的卡片模板不通用:2026-08-12 专家页把 126 条全铺出来,其中 117 条案例没有关联专家
 * 可渲染,只剩一张裁切过的封面叠在那儿。省略 kind 会拿到全量,那是留给旧客户端的口径。
 */
export type DesktopScenarioKind = 'featured' | 'playbook'

/**
 * 精选场景(桌面端首页场景卡)。字段对齐 admin-server model.DesktopScenario 的 JSON。
 * 点击场景卡:以 expertSlug 绑定的专家(或通用助手)开新会话,并预填 initPrompt。
 */
export interface DesktopScenario {
  id: number
  title: string
  subtitle?: string
  /**
   * 详情弹窗那两行说明。
   *
   * 照 WorkBuddy:它弹窗里 `.dc-detail-modal-subtitle` 那个位置渲染的就是案例的
   * description(13px、`-webkit-line-clamp: 2` 截两行、外面包一个 maxWidth 360 的 Tooltip
   * 看全文),而不是另起一段正文 —— 那一段是「发现」页详情页(`.dc-detail-description`)才有的。
   * 所以这里也放在副标题位、截两行,全文交给 title 悬浮提示。
   */
  description?: string
  /** emoji 或图标 URL(小图标/兜底)。 */
  icon?: string
  /** 整卡背景图 URL。 */
  cover?: string
  /** 关联专家 slug;空则通用助手(兼容旧单专家)。 */
  expert_slug?: string
  /** 卡片展示的成员专家 slug 列表(JSON 字符串数组)。 */
  member_slugs?: string
  /** 点击后预填输入框的起手提示。 */
  init_prompt?: string
  /**
   * 归属的首页场景 slug(DesktopScene.slug);空则不出现在首页案例区,只在专家中心露出。
   * 对齐 WorkBuddy:首页案例行是 `allCases.filter(c => c.scenario === 选中的场景)`,
   * 也就是说案例天然挂在某个场景下,不选场景就没有这一行。
   */
  scene_slug?: string
  /**
   * 产物类型:`html`(可交互网页) / `video` / `link`(第三方在线预览页) / 空(只有封面图)。
   *
   * 弹窗按它选预览控件 —— 照 WorkBuddy 的 `ArtifactPreview`:它按 fileType 一路 if 下来
   * (md / doc / ppt / html / code / table / link / video / image),全都不匹配才退回封面图。
   * 我们只导了它带场景那批里实际存在的三种(2026-08-11 实测 html 80、link 32、video 5)。
   */
  artifact_type?: string
  /** 产物在对象存储里的 key;有值即表示可以去换预览直链(URL 本身有过期,不随列表下发)。 */
  artifact_key?: string
  /** link 类的外部预览地址(内容不在我们手上,只能跳浏览器)。 */
  artifact_url?: string
  tags?: string
  sort_order?: number
  status: number
}

/** 案例产物的临时预览直链(每次打开弹窗现换,因为预签名会过期)。 */
export interface ScenarioArtifact {
  url: string
  artifact_type: string
}

/** 首页场景的二级提示:title 是胶囊展示文案,prompt 是点下去预填进输入框的正文。 */
export interface DesktopScenePrompt {
  title: string
  prompt: string
}

/**
 * 首页场景(输入框上方那行胶囊)。字段对齐 admin-server model.DesktopScene 的 JSON。
 *
 * 形状照 WorkBuddy 的 scene,不是我们自己设计的:它首页那行胶囊按 mode 分组渲染,
 * 选中某条后一级列表整体隐藏、换成该场景的提示标题二级行。与 DesktopScenario
 * (专家中心那屏的整卡背景图大卡)是两套数据,别混。
 */
export interface DesktopScene {
  id: number
  slug: string
  name: string
  /** 归属的首页模式:working(日常办公) / coding(代码开发) / design(设计创意)。 */
  mode: string
  /** 图标键(如 documentation / financial-services);未命中本地映射时走兜底。 */
  icon?: string
  /** 二级提示(JSON 字符串数组,形如 [{title,prompt}])。 */
  prompts?: string
  /**
   * 场景关联的插件名(JSON 字符串数组),原样留存 WorkBuddy 侧的 plugins[].name。
   * 它在 WorkBuddy 是「选中场景 → 这段会话启用这些专家团插件」,而 openclaw 没有会话级
   * 插件启用,我们眼下不消费——留着是为了后续把场景映射到我们的专家/技能。
   */
  plugin_names?: string
  sort_order?: number
  status: number
}

/**
 * 连接器(MCP)清单。运营在 admin-cloud 填写,存 DesktopMarketItem.manifest;
 * 客户端据此 `mcp set` 写入内核 mcp.servers 并 reload。
 */
export interface ConnectorManifest {
  /** MCP server 名(mcp.servers 下的键)。 */
  mcpName: string
  /**
   * 传给 `openclaw mcp set <name> <value>` 的 JSON 对象:
   *  - stdio:{ command, args?, env?, cwd? }
   *  - http :{ url, transport?: 'streamable-http'|'sse', headers? }
   */
  server: Record<string, unknown>
  /** 鉴权声明(可选)。 */
  auth?: {
    /** none:免鉴权;token:安装时收集令牌注入;oauth:安装后走 `mcp login`。 */
    mode: 'none' | 'token' | 'oauth'
    /** token 注入位置:http 头或 stdio 环境变量。 */
    inject?: 'header' | 'env'
    /** 头名/环境变量名(如 Authorization / API_KEY)。 */
    key?: string
    /** 值前缀(如 "Bearer ")。 */
    prefix?: string
    /** UI 收集令牌时的提示标签。 */
    label?: string
  }
}

/** 安装选项(连接器 token 型鉴权时携带用户令牌)。 */
export interface MarketInstallOptions {
  token?: string
}

/**
 * AI 生成的技能草稿(对齐 WorkBuddy「描述需求 → 自动创建技能」)。
 * 由模型产出,预览确认(可编辑)后本地直装到 ~/.openclaw/skills/<slug>/。
 */
export interface AiSkillDraft {
  slug: string
  name: string
  description: string
  /** 完整 SKILL.md 正文(含 YAML frontmatter)。 */
  skillMd: string
}

/**
 * 某类型的市场全量快照(一次请求拿全条目 + 可见分类)。
 *
 * 条目不含 manifest(longtext,装的时候才需要,由 marketDetail 按需取)。分类已在服务端滤掉
 * 「没有任何已上架条目」的那些,客户端拿到的每个 chip 都点得出东西。
 */
export interface MarketSnapshot {
  items: MarketItem[]
  categories: MarketCategory[]
  /**
   * 服务端声明的在架总数。启动期拿快照当「在架权威集合」删本地登记时要靠它兜底:
   * 条目数与 total 对不上就说明这份快照被截断了(将来若加分页/过滤),此时缺的那些
   * 会被误判成「已下架」而清掉,且不可逆。见 market/auto-update.ts:fetchExpertShelf。
   */
  total?: number
  /** true 表示本次为离线/降级返回的本地缓存数据(网络不可达或服务端异常时兜底)。 */
  stale?: boolean
}

/** 本地已安装的市场资产(读 skill 目录下 _yunwu_meta.json)。 */
export interface MarketInstalledItem {
  type: MarketAssetType
  slug: string
  name: string
  version: string
  /** 安装时间(毫秒)。 */
  installedAt: number
}

/** 自检步骤 id。 */
export type PreflightStepId =
  | 'locate-kernel'
  | 'kernel-version'
  | 'config-ready'
  | 'gateway-listen'
  | 'gateway-connect'
  | 'rpc-health'

/** 自检步骤状态。 */
export type PreflightStatus = 'pending' | 'running' | 'ok' | 'warn' | 'fail'

/** 自检步骤失败等级:fatal 阻断 / recoverable 可自愈 / warn 仅提示。 */
export type PreflightLevel = 'fatal' | 'recoverable' | 'warn'

/** 单个自检步骤。 */
export interface PreflightStep {
  id: PreflightStepId
  /** 面向用户的中文步骤名。 */
  label: string
  status: PreflightStatus
  level: PreflightLevel
  /** 耗时(毫秒),完成后填充。 */
  elapsedMs?: number
  /** 机器可读的原始错误。 */
  error?: string
  /** 面向用户的中文可操作提示。 */
  hint?: string
}

/** 一次自检的完整报告。 */
export interface PreflightReport {
  ok: boolean
  running: boolean
  steps: PreflightStep[]
  startedAt: number
  endedAt?: number
}

/** 自检模式:full = 启动完整链;light = 仅连通/RPC(新建任务快速校验)。 */
export type PreflightMode = 'full' | 'light'

/** preload 暴露给渲染进程的 API 契约(window.api)。 */
/** ask_user 单个问题(平台 UI 工具;对齐 WorkBuddy AskUserQuestion 结构)。 */
export interface AskQuestion {
  /** 题干。 */
  question: string
  /** 短标签(UI 分组/标题用)。 */
  header?: string
  /** 是否多选(默认单选)。 */
  multiSelect?: boolean
  /** 候选项;每项含展示文案与可选说明。 */
  options?: { label: string; description?: string }[]
}

/** 主进程 → 渲染层的一次 ask_user 提问请求(id 用于回填对应作答)。 */
export interface AskRequest {
  id: string
  questions: AskQuestion[]
}

/**
 * 用户对单题的作答(回填给模型的结构;亦用于在对话时间线渲染「用户回答卡片」)。
 * 对齐 WorkBuddy:答完后把 Q→答案沉淀成一张折叠卡片。
 */
export interface AskAnswer {
  header?: string
  question: string
  /** 已选项 label 列表。 */
  selected: string[]
  /** 「其他补充」自由文本。 */
  custom?: string
}

/** 文件改动的行数增删(来源:工具结果文本;用于步骤行右侧的 `+33 -0`)。 */
export interface DiffStats {
  added: number
  removed: number
}

/**
 * 命令类工具(exec / process)的结构化执行结果。
 *
 * 来源是内核工具结果上的 `details`,**不是**从结果文本里认字:
 * `{status:"completed", exitCode, durationMs, aggregated}` / 后台未结束时
 * `{status:"running", sessionId, pid, tail}`(真机读数见 references/workbuddy-ui.md)。
 * 结果正文那一份对「还在跑」只有一句「Command still running (session …, pid …)」,
 * 退出码根本不在里面——所以退出码必须走 details,不能靠解析。
 */
export interface ExecOutcome {
  /** completed | running | error | approval-pending 等,内核原样透出。 */
  status?: string
  /** 退出码(仅 completed 有;0 也要保留,别用真值判断)。 */
  exitCode?: number
  /** 命令耗时,毫秒。 */
  durationMs?: number
  /** 后台会话名与进程号(status=running 时用于「还在后台跑」那行)。 */
  sessionId?: string
  pid?: number
}

/**
 * 助手一轮回复的「执行过程」条目。实时事件流与历史还原**共用同一结构**,
 * 这样重开任务看到的过程与运行当时完全一致(WorkBuddy 即如此)。
 *
 * 关于 `at`:内核下发的正文是**整轮累计、只增不减**的(见网关 resolveBroadcastDelta),
 * 所以正文不能被搬进时间线,否则下一个 delta 会把它带回来造成重复。
 * 改为记录该项插入时的正文字符偏移,渲染时按偏移把正文切片穿插到各项之间——
 * 最后一个偏移之后的那段即「最终回答」,渲染在过程块之外。
 */
export type TimelineItem =
  | {
      kind: 'tool'
      /** 工具调用 id(实时为 itemId,历史为 toolCallId)。 */
      itemId: string
      /** 面向用户的中文动作文案。 */
      title: string
      /** running | completed | failed。 */
      status: string
      at?: number
      /** 原始工具名(用于分组判定与图标选择)。 */
      name?: string
      /** 目标文件绝对路径(write/edit 类才有;用于同文件分组与点击预览)。 */
      path?: string
      stats?: DiffStats
      /** 写入/编辑的内容,供展开查看(仅保留前若干行,避免历史文件过大)。 */
      preview?: string
      /** 命令类工具的退出码 / 耗时 / 后台进程,渲染成步骤行下面那条状态。 */
      exec?: ExecOutcome
      /**
       * edit 类工具的展示用 diff,渲染成带行号的加减色块。
       *
       * 来自内核 `toolResult.details.diff`(`openclaw/src/agents/sessions/tools/edit-diff.ts`
       * 的 `generateDiffString`):每行形如 `+12 新内容` / `-12 旧内容` / ` 12 上下文`,
       * 上下文超过 4 行时中间是一行 ` ...`。**比从入参猜准**——入参只有 old/new 片段,
       * 猜不出真实行号,也数不准同时有增有删的行数。
       */
      diff?: string
    }
  | {
      kind: 'thinking'
      id: string
      text: string
      at?: number
      /**
       * 这是这一轮的第几次尝试(只在 >1 时带)。
       *
       * 内核遇到「只有思考、没有可见回答」的一轮会**原样重跑同一条 prompt**
       * (`openclaw/src/agents/embedded-agent-runner/run.ts:3746`,上限
       * `DEFAULT_REASONING_ONLY_RETRY_LIMIT = 2`)。几次尝试的思考几乎逐字相同,
       * 并排堆着会被当成界面重复(用户 2026-08-17 报的正是这个),所以只留最后一次,
       * 用这个数字把"为什么它变了"说出来。
       */
      attempt?: number
    }
  | { kind: 'plan'; itemId: string; steps: PlanStep[]; at?: number }
  | {
      kind: 'ask'
      itemId: string
      status: 'waiting' | 'answered' | 'cancelled'
      questions: AskQuestion[]
      answers?: AskAnswer[]
      at?: number
    }
  | {
      kind: 'widget'
      itemId: string
      title: string
      code: string
      at?: number
    }

/**
 * 主进程 → 渲染层:模型调用 `show_widget` 展示一张自包含可视化卡(对齐 WorkBuddy「展示详情」)。
 * widgetCode 为模型现写的内联 SVG/HTML 片段,渲染层做净化后内联展示。
 */
export interface WidgetRequest {
  id: string
  title: string
  widgetCode: string
}

/**
 * 主进程 → 渲染层:模型调用 `present_files` 显式交付产物(对齐 WorkBuddy present_files)。
 * files 为绝对路径列表,渲染层据此渲染产物卡并自动打开右侧预览抽屉。
 */
export interface PresentRequest {
  id: string
  files: string[]
  explanation?: string
}

export interface DesktopApi {
  /** 校验云雾 baseUrl + token 是否可用,并返回可用模型列表。 */
  validateToken: (baseUrl: string, token: string) => Promise<IpcResult<ValidateResult>>
  /**
   * 账号密码登录(直连 API):成功后自动换取 sk- 令牌。
   * 后端以人机验证为由拒绝时附带 needCaptcha=true,渲染层据此补弹一次应用内验证层。
   */
  login: (
    baseUrl: string,
    username: string,
    password: string,
    captchaToken?: string
  ) => Promise<IpcResult<LoginResult> & { needCaptcha?: boolean }>
  /** 读取站点登录验证码开关与类型(/api/status)。 */
  captchaConfig: (baseUrl: string) => Promise<IpcResult<CaptchaConfig>>
  /** 取一道验证码题(主进程请求,规避渲染层跨源)。 */
  captchaFetch: (baseUrl: string, type: CaptchaType) => Promise<IpcResult<CaptchaChallenge>>
  /**
   * 提交验证码答案换取一次性 token。
   * answer 为明文答案:点选=\"x1,y1;x2,y2\";滑块=\"x,y\";主进程负责 AES 加密后提交。
   */
  captchaVerify: (
    baseUrl: string,
    type: CaptchaType,
    key: string,
    answer: string
  ) => Promise<IpcResult<CaptchaVerifyResult>>
  /**
   * 保存激活配置并写入本地 OpenClaw 配置。
   * 返回**主进程解析后**的配置:模型清单按账号取(见 main/model-catalog.ts),
   * 渲染层递进去的 models / defaultModel 只是占位。
   */
  activate: (config: ActivationConfig) => Promise<IpcResult<ActivationConfig>>
  /** 读取已保存的激活配置(未激活返回 null)。 */
  getActivation: () => Promise<IpcResult<ActivationConfig | null>>
  /** 清除激活(退出登录)。 */
  clearActivation: () => Promise<IpcResult>
  /**
   * 取账户余额快照(账户菜单用)。
   *
   * force=false 命中主进程 30 秒节流窗口就直接给缓存(菜单反复开合不会连打后端);
   * force=true 是用户点了刷新。取不到时按 status 降级,**任何情况都不会返回 0 当余额**。
   */
  accountSnapshot: (force?: boolean) => Promise<IpcResult<AccountSnapshot>>
  /**
   * 本地手上还有没有这个账号的会话(**不打网络**,启动时用来决定先去登录页还是主页面)。
   *
   * 只回答「有没有」。会话在服务端是不是已经被作废(改过密码 / 超过 30 天)只有问后端才知道,
   * 那一问放到进主页面之后的后台去做,不该压着首屏。
   */
  hasSession: () => Promise<IpcResult<boolean>>
  /** Submit to the dedicated desktop feedback system and return its tracking ID. */
  submitFeedback: (submission: FeedbackSubmission) => Promise<IpcResult<FeedbackSubmitResult>>
  /** 读取该账号的对话模型清单:已选中的 + 服务端推荐的 + 展示元数据。 */
  modelCatalog: () => Promise<IpcResult<ModelCatalogView>>
  /** 拉该 key 此刻真能调的对话模型(选择器的可选池,每次打开现拉)。 */
  availableModels: () => Promise<IpcResult<AvailableModelsView>>
  /** 保存选中的对话模型;返回更新后的激活配置(默认模型可能随之回退)。 */
  selectModels: (chat: ModelInfo[]) => Promise<IpcResult<ActivationConfig>>
  /** 拉媒体候选池 + 当前选择 + 预勾选(出图 / 视频 / 语音三档,每次打开现拉)。 */
  availableMediaModels: () => Promise<IpcResult<AvailableMediaModelsView>>
  /** 保存媒体模型选择(只传要改的那几档);返回落盘后此刻生效的三档。 */
  selectMediaModels: (selection: Partial<MediaSelection>) => Promise<IpcResult<MediaSelection>>
  /** 读取模型管理的供货商配置(含解密后的 Key)。 */
  listProviders: () => Promise<IpcResult<ProviderConfig[]>>
  /** 保存供货商配置(Key 落盘前 safeStorage 加密),并声明式渲染进 openclaw.json 热加载。 */
  saveProviders: (providers: ProviderConfig[]) => Promise<IpcResult>
  /** 按 id 保存单个供货商(增/改);只动这一条,不触碰其它模型的 Key。 */
  upsertProvider: (provider: ProviderConfig) => Promise<IpcResult<ProviderConfig[]>>
  /** 删除某供货商(内置 yunwu 不可删),返回删除后的列表。 */
  deleteProvider: (id: string) => Promise<IpcResult<ProviderConfig[]>>
  /** 启动本地 OpenClaw 网关(进入应用后自动调用,用户无感)。 */
  startGateway: () => Promise<IpcResult<GatewayStatus>>
  /** 停止本地 OpenClaw 网关。 */
  stopGateway: () => Promise<IpcResult<GatewayStatus>>
  /** 查询本地 OpenClaw 网关状态。 */
  gatewayStatus: () => Promise<IpcResult<GatewayStatus>>
  /** 通过 WS 网关客户端调用 health(里程碑 1:验证握手/鉴权/RPC 联通)。 */
  gatewayHealth: () => Promise<IpcResult<unknown>>
  /**
   * 向指定会话发送一条用户消息,触发 agent 运行(流式结果经 onAgentEvent 推送)。
   * opts.model:本会话使用的模型(不含 provider 前缀,如 `deepseek-v3.2`);省略则用 agent 默认模型。
   * opts.thinking:深度思考档位(off/low/medium/high 等);非推理模型会被内核安全降级。
   * opts.reasoning:本轮要不要思考正文。**档位未知的模型必须用它**——那种情况下不能塞一个猜的
   * 档位(可能被上游 400),也不能传 `thinking:"off"`(那会连思考正文一起关掉)。
   */
  sendAgent: (
    sessionKey: string,
    message: string,
    opts?: { model?: string; thinking?: ChatThinking; reasoning?: boolean }
  ) => Promise<IpcResult<AgentSendResult>>
  /** 中断指定会话当前运行。 */
  abortAgent: (sessionKey: string) => Promise<IpcResult>
  /** 订阅 agent 运行事件(文字增量/工具步骤/生命周期);返回取消订阅函数。 */
  onAgentEvent: (cb: (evt: AgentEvent) => void) => () => void
  /** 取某会话当前轮的缓冲事件(断线重连后幂等重放,补齐断连窗口内丢失的增量)。 */
  replayAgent: (sessionKey: string) => Promise<IpcResult<AgentEvent[]>>
  /** 读取某会话产出的文件用于预览(产出物卡片点开;含越权防护与大小上限)。 */
  readArtifact: (sessionKey: string, filePath: string) => Promise<IpcResult<ArtifactContent>>
  /** 批量取产出物文件大小(卡片副标题;取不到的条目会被略过)。 */
  statArtifacts: (
    sessionKey: string,
    paths: string[]
  ) => Promise<IpcResult<Array<{ path: string; size: number }>>>
  /**
   * 让任务就位:在共享 agent 上建一条会话,并把它的工作目录指到该任务自己的目录。
   * 首次发消息前调用,幂等。
   *
   * expertSlug 非空时,额外确保 `expert-<slug>` 这个常驻 agent 存在并按专家清单播种
   * (model/tools/skills/identity + persona AGENTS.md);该专家的所有任务共用它。
   * 留空则挂在内核默认 agent `main` 上。
   *
   * workspaceDir 非空时把该任务绑到这个工作空间(此后它的工作目录恒为该文件夹);
   * 留空即「不使用工作空间」,照旧落到按时间命名的一次性受管目录。
   */
  ensureTaskSession: (
    sessionKey: string,
    expertSlug?: string,
    workspaceDir?: string
  ) => Promise<IpcResult>
  /** 删除任务:删会话、把任务目录移入回收站、清理事件缓冲。 */
  deleteTask: (sessionKey: string) => Promise<IpcResult>
  /** 读取持久化的任务列表元数据(重启后恢复左侧任务列表)。 */
  loadTasks: () => Promise<IpcResult<TaskMeta[]>>
  /** 覆盖写入任务列表元数据。 */
  saveTasks: (tasks: TaskMeta[]) => Promise<IpcResult>
  /** 从内核 session store 恢复某任务的历史消息(切换任务时懒加载)。 */
  getTaskHistory: (sessionKey: string) => Promise<IpcResult<SessionMessage[]>>
  /** 后台发现内核中存在但本地未记录的孤儿任务(传入已知 id 求差集);不阻塞首屏。 */
  discoverTaskOrphans: (knownIds: string[]) => Promise<IpcResult<TaskMeta[]>>
  /** 获取受管工作区目录路径(不存在会自动创建)。 */
  getWorkspaceDir: () => Promise<IpcResult<string>>
  /** 在系统文件管理器中打开受管工作区目录(全局根目录)。 */
  openWorkspaceDir: () => Promise<IpcResult>
  /** 在系统文件管理器中打开某任务(会话)自己的产物目录。 */
  openTaskDir: (sessionKey: string) => Promise<IpcResult>
  /** 已知工作空间列表(用户显式新建/打开过的,按最近使用排序)。 */
  listWorkspaces: () => Promise<IpcResult<WorkspaceEntry[]>>
  /** 新建工作空间:在默认存储路径下创建同名文件夹并登记。名称非法时返回错误。 */
  createWorkspace: (name: string) => Promise<IpcResult<WorkspaceEntry>>
  /** 选择本地文件夹作为工作空间并登记;用户取消返回 null。 */
  pickWorkspaceDir: () => Promise<IpcResult<WorkspaceEntry | null>>
  /** 读取应用级偏好(设置页里那些开关)。 */
  getPrefs: () => Promise<IpcResult<AppPreferences>>
  /** 改写应用级偏好(按字段合并),返回合并后的完整值。 */
  setPrefs: (patch: Partial<AppPreferences>) => Promise<IpcResult<AppPreferences>>
  /** 在系统文件管理器中定位并选中某产物文件(reveal;对齐 WorkBuddy「打开文件」精准定位)。 */
  revealArtifact: (sessionKey: string, filePath: string) => Promise<IpcResult>
  /** 选择一个或多个本地文件(用于 @ 引用)。取消返回空数组。 */
  pickFiles: () => Promise<IpcResult<string[]>>
  /**
   * 获取拖入文件的本地绝对路径。
   * Electron ≥32 已移除 File.path,拖拽场景须经此(webUtils.getPathForFile)取路径。
   * 非本地文件(如浏览器内拖拽)返回空字符串。
   */
  getPathForFile: (file: File) => string
  /** 订阅网关状态变化;返回取消订阅函数。 */
  onGatewayStatus: (cb: (status: GatewayStatus) => void) => () => void
  /**
   * 订阅「模型配置下发内核失败」;返回取消订阅函数。
   * 保存/删除供货商写完 providers.json 即返回,下发在后台跑,只有失败才经此通知。
   */
  onConfigSyncError: (cb: (message: string) => void) => () => void
  /**
   * 订阅媒体后台任务(出图/出视频)的进度;返回取消订阅函数。
   *
   * 这条通道存在的原因见 `main/media-relay.ts`:内核对我们的 `acp:` 会话投不到完成事件,
   * 界面在等待期只能看到「本轮回复已中断」。有了它才能画「正在出图 · 已用 N 秒」的占位卡。
   */
  onMediaProgress: (cb: (progress: MediaTaskProgress) => void) => () => void
  /** 运行内核自检(默认 full);过程通过 onPreflightStep 流式上报,结束返回最终报告。 */
  runPreflight: (mode?: PreflightMode) => Promise<IpcResult<PreflightReport>>
  /** 订阅自检进度(每步更新推送完整报告);返回取消订阅函数。 */
  onPreflightStep: (cb: (report: PreflightReport) => void) => () => void
  /** 自定义标题栏:最小化窗口。 */
  windowMinimize: () => Promise<IpcResult>
  /** 自定义标题栏:切换最大化/还原,返回切换后的最大化状态。 */
  windowToggleMaximize: () => Promise<IpcResult<boolean>>
  /** 自定义标题栏:关闭窗口。 */
  windowClose: () => Promise<IpcResult>
  /** 查询窗口当前是否最大化(初始化图标状态)。 */
  windowIsMaximized: () => Promise<IpcResult<boolean>>
  /** 订阅窗口最大化状态变化(拖拽/双击等触发);返回取消订阅函数。 */
  onWindowMaximizedChange: (cb: (maximized: boolean) => void) => () => void
  /**
   * 拉取某类型的市场全量快照(条目 + 可见分类,一次拿全)。
   * 市场页/画廊统一走这个,不再翻页拼接,也不再单独拉分类。
   */
  getMarketSnapshot: (type: MarketAssetType) => Promise<IpcResult<MarketSnapshot>>
  /** 取市场条目详情(含 manifest,连接器安装前用于判定鉴权模式)。 */
  marketDetail: (type: MarketAssetType, slug: string) => Promise<IpcResult<MarketItem>>
  /**
   * 安装一个市场条目到本地内核:
   *  - skill/expert:下载 zip → 校验 → 解压 → 内核自动加载;
   *  - connector:读 manifest → `mcp set` 写入 mcp.servers → reload(token 型经 opts.token 注入)。
   */
  installMarketItem: (item: MarketItem, opts?: MarketInstallOptions) => Promise<IpcResult>
  /** 卸载一个已安装的市场条目(技能删目录 / 连接器 mcp unset)。 */
  uninstallMarketItem: (type: MarketAssetType, slug: string) => Promise<IpcResult>
  /** 列出本地已安装的市场条目(用于标记安装态/版本)。 */
  listInstalledMarket: (type: MarketAssetType) => Promise<IpcResult<MarketInstalledItem[]>>
  /**
   * 列出本地已安装的专家(富信息:含 manifest,供 Composer 选择器/会话头部渲染与播种)。
   * 与通用 listInstalledMarket('expert') 的区别:后者仅返回基础安装态,这里带完整清单。
   */
  listInstalledExperts: () => Promise<IpcResult<InstalledExpert[]>>
  /** 拉取精选场景(已上架)。kind 见 DesktopScenarioKind —— 专家页要 featured,首页案例区要 playbook。 */
  listScenarios: (kind?: DesktopScenarioKind) => Promise<IpcResult<DesktopScenario[]>>
  /**
   * 换一条案例产物的预览直链。
   * 每次打开弹窗都要重新换:直链是对象存储的预签名 URL,默认 24 小时后失效,
   * 而失效不报错 —— iframe 只是一片空白,所以不能随列表缓存下来。
   */
  scenarioArtifact: (id: number) => Promise<IpcResult<ScenarioArtifact>>
  /** 拉取首页场景(已上架,全量),用于输入框上方那行胶囊。 */
  listScenes: () => Promise<IpcResult<DesktopScene[]>>
  /** AI 按需求从市场技能中检索匹配项,返回 slug 列表(按相关度排序)。 */
  aiFindSkills: (need: string) => Promise<IpcResult<string[]>>
  /** AI 按需求生成一份技能草稿(SKILL.md),供预览确认。 */
  aiCreateSkill: (need: string) => Promise<IpcResult<AiSkillDraft>>
  /** 把(可能已编辑的)技能草稿本地直装。 */
  aiInstallGeneratedSkill: (draft: AiSkillDraft) => Promise<IpcResult>
  /** 从本地 zip 直装一个技能(对齐「上传技能」),返回 {slug,name}。 */
  installLocalSkillZip: (filePath: string) => Promise<IpcResult<{ slug: string; name: string }>>
  /**
   * 订阅平台 UI 工具 `ask_user` 的提问推送(agent 调用该工具时触发)。
   * 返回取消订阅函数。作答后须调 answerAskUser 回填,否则模型会一直阻塞等待。
   */
  onAskUser: (cb: (req: AskRequest) => void) => () => void
  /** 回填某次 ask_user 的用户作答(answers 结构自定,主进程原样 JSON 化后交还模型)。 */
  answerAskUser: (id: string, answers: unknown) => Promise<IpcResult>
  /** 订阅 `show_widget`:模型交付一张可视化卡(内联 SVG/HTML)。返回取消订阅函数。 */
  onShowWidget: (cb: (req: WidgetRequest) => void) => () => void
  /** 订阅 `present_files`:模型显式交付产物文件列表。返回取消订阅函数。 */
  onPresentFiles: (cb: (req: PresentRequest) => void) => () => void
}

/** 本地 OpenClaw 网关默认端口(与 OpenClaw 官方默认一致)。 */
export const OPENCLAW_DEFAULT_PORT = 18789

/**
 * 我们给本地网关设定的**服务端**握手窗口:spawn 时经 `OPENCLAW_HANDSHAKE_TIMEOUT_MS` 注入。
 *
 * 内核默认只给 15 秒(`DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS`),超时就由服务端主动关掉那条
 * 还没鉴权的连接。而网关冷启动的忙碌期远不止 15 秒,于是我们的 connect 帧明明送到了、却排不上
 * 处理 —— 真机日志(`%TEMP%/openclaw/openclaw-*.log`)里是一串
 * `cause=handshake-timeout lastFrameMethod=connect`,`handshakeMs` 实测 16.7 / 18.6 / 21.9 /
 * 40.4 / 50.6 秒。注意这些值本身就超过 15 秒:事件循环被堵住时,连服务端自己的超时定时器都晚点跑。
 *
 * 这就是「启动网关 ✓ / 连接网关 ✗,关掉重开就好」的全部原因 —— 重开之所以好,是因为上一次
 * 留下的网关已经过了忙碌期,握手立刻成功。调大客户端超时治不了它:被踢的是服务端那一侧。
 *
 * 内核为这件事留了口子,env 优先于 `gateway.handshakeTimeoutMs` 配置,且只按 Node 定时器上限
 * 钳制(见 openclaw `packages/gateway-client/src/timeouts.ts` 的 `resolvePreauthHandshakeTimeoutMs`;
 * 内核自己对该配置项的说明就是 *"Use higher values on loaded or low-powered hosts where local
 * clients can connect during startup warmup"*,正是我们这个场景)。
 * 走 env 而不写配置:`gateway.*` 属 restart 类路径,写它要连带重启网关,而 env 在 spawn 那一刻就生效。
 * 放宽的代价只是「未鉴权的空闲连接会多挂一会儿」,对一个只绑回环的本地网关可以忽略。
 */
export const OPENCLAW_HANDSHAKE_TIMEOUT_MS = 120000
