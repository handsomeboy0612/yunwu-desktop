/**
 * 主进程与渲染进程共享的类型定义。
 * 通过 preload 的 contextBridge 暴露的 API 均以这些类型为契约。
 */

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
  /** 模型类别。 */
  category: ModelCategory
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
  { id: 'yunwu', label: '云雾', api: 'openai-completions', baseUrl: 'https://yunwu.ai/v1', needsKey: true, addable: false },
  { id: 'openai', label: 'OpenAI', api: 'openai-completions', baseUrl: 'https://api.openai.com/v1', needsKey: true, addable: true },
  { id: 'deepseek', label: '深度求索', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', needsKey: true, addable: true },
  { id: 'anthropic', label: 'Anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1', needsKey: true, addable: true },
  { id: 'gemini', label: 'Google Gemini', api: 'google-generative-ai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', needsKey: true, addable: true },
  { id: 'openrouter', label: 'OpenRouter', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, addable: true },
  { id: 'ollama', label: 'Ollama(本地)', api: 'ollama', baseUrl: 'http://localhost:11434', needsKey: false, addable: true },
  { id: 'custom', label: '自定义(OpenAI 兼容)', api: 'openai-completions', baseUrl: '', needsKey: true, addable: true }
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
  /** 仅思考模式:不允许关闭思考(思考开关锁定为开)。 */
  onlyReasoning?: boolean
  /** 允许关闭思考:默认 true;false 时思考开关锁定为开。 */
  canDisableThinking?: boolean
  /** 支持的思考强度档位(驱动 Composer 档位按钮动态渲染);留空回退 low/medium/high。 */
  thinkingLevels?: Exclude<ChatThinking, 'off'>[]
  /** 默认思考强度(选中该模型时的默认档位);留空用 high。 */
  defaultThinkingLevel?: Exclude<ChatThinking, 'off'>
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

/** 令牌校验结果:返回该令牌在云雾侧可用的模型列表(带能力标记)。 */
export interface ValidateResult {
  models: ModelInfo[]
}

/** 账号密码登录结果:换取到的规范化 baseUrl + sk- 令牌 + 账号名。 */
export interface LoginResult {
  baseUrl: string
  token: string
  username: string
}

/**
 * 云雾登录人机验证码类型(go-captcha)。与后端 /api/status.captcha_type 对齐。
 * 桌面端原生支持 click-*(点选)与 slide-*(滑块);rotate 交由网页登录兜底。
 */
export type CaptchaType =
  | 'slide-basic'
  | 'slide-region'
  | 'rotate'
  | 'click-text'
  | 'click-shape'

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
  /** 点选:提示缩略图;滑块:拼块图。base64,不含前缀。 */
  thumbBase64?: string
  thumbWidth?: number
  thumbHeight?: number
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
  | 'yunwu'
  | 'openai'
  | 'gemini'
  | 'deepseek'
  | 'openrouter'
  | 'ollama'
  | 'anthropic'
  | 'custom'

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
    }
  | {
      /** 一轮回复结束。text 为最终文本,stopReason 为结束原因(stop/aborted/error 等)。 */
      kind: 'final'
      sessionKey: string
      runId?: string
      text: string
      stopReason?: string
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
    }
  | {
      /** 运行生命周期:start(开始思考)/ finishing / end(结束)。 */
      kind: 'lifecycle'
      sessionKey: string
      runId?: string
      phase: string
      stopReason?: string
      aborted?: boolean
    }

/** agent:send 的返回:本轮运行的 runId。 */
export interface AgentSendResult {
  runId?: string
  status?: string
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
}

/** 从内核 session 恢复的一条历史消息(仅文本;工具步骤等富信息暂不恢复)。 */
export interface SessionMessage {
  role: 'user' | 'assistant'
  content: string
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
export interface DesktopApi {
  /** 校验云雾 baseUrl + token 是否可用,并返回可用模型列表。 */
  validateToken: (baseUrl: string, token: string) => Promise<IpcResult<ValidateResult>>
  /**
   * 账号密码登录(直连 API):成功后自动换取 sk- 令牌。
   * 若站点开启人机验证,返回的结果附带 needCaptcha=true,渲染层可引导到网页登录。
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
  /** 网页登录:打开内嵌窗口在官方登录页完成(账号密码 + 人机验证),成功后换取 sk- 令牌。 */
  loginWebview: (baseUrl: string) => Promise<IpcResult<LoginResult>>
  /** 保存激活配置并写入本地 OpenClaw 配置。 */
  activate: (config: ActivationConfig) => Promise<IpcResult>
  /** 读取已保存的激活配置(未激活返回 null)。 */
  getActivation: () => Promise<IpcResult<ActivationConfig | null>>
  /** 清除激活(退出登录)。 */
  clearActivation: () => Promise<IpcResult>
  /** 读取模型管理的供货商配置(含解密后的 Key)。 */
  listProviders: () => Promise<IpcResult<ProviderConfig[]>>
  /** 保存供货商配置(Key 落盘前 safeStorage 加密),并声明式渲染进 openclaw.json 热加载。 */
  saveProviders: (providers: ProviderConfig[]) => Promise<IpcResult>
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
   */
  sendAgent: (
    sessionKey: string,
    message: string,
    opts?: { model?: string; thinking?: ChatThinking }
  ) => Promise<IpcResult<AgentSendResult>>
  /** 中断指定会话当前运行。 */
  abortAgent: (sessionKey: string) => Promise<IpcResult>
  /** 订阅 agent 运行事件(文字增量/工具步骤/生命周期);返回取消订阅函数。 */
  onAgentEvent: (cb: (evt: AgentEvent) => void) => () => void
  /** 取某会话当前轮的缓冲事件(断线重连后幂等重放,补齐断连窗口内丢失的增量)。 */
  replayAgent: (sessionKey: string) => Promise<IpcResult<AgentEvent[]>>
  /** 确保任务对应的 isolated agent 已在内核注册(首次发消息前调用,惰性创建)。 */
  ensureTaskAgent: (agentId: string) => Promise<IpcResult>
  /** 删除任务对应的 isolated agent 及其 workspace/session,并清理事件缓冲。 */
  deleteTaskAgent: (agentId: string, sessionKey: string) => Promise<IpcResult>
  /** 读取持久化的任务列表元数据(重启后恢复左侧任务列表)。 */
  loadTasks: () => Promise<IpcResult<TaskMeta[]>>
  /** 覆盖写入任务列表元数据。 */
  saveTasks: (tasks: TaskMeta[]) => Promise<IpcResult>
  /** 从内核 session store 恢复某任务的历史消息(切换任务时懒加载)。 */
  getTaskHistory: (agentId: string) => Promise<IpcResult<SessionMessage[]>>
  /** 后台发现内核中存在但本地未记录的孤儿任务(传入已知 id 求差集);不阻塞首屏。 */
  discoverTaskOrphans: (knownIds: string[]) => Promise<IpcResult<TaskMeta[]>>
  /** 获取受管工作区目录路径(不存在会自动创建)。 */
  getWorkspaceDir: () => Promise<IpcResult<string>>
  /** 在系统文件管理器中打开受管工作区目录。 */
  openWorkspaceDir: () => Promise<IpcResult>
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
}

/** 本地 OpenClaw 网关默认端口(与 OpenClaw 官方默认一致)。 */
export const OPENCLAW_DEFAULT_PORT = 18789
