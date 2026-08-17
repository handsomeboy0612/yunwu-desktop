import type {
  ChatThinking,
  ModelCategory,
  ModelInfo,
  ThinkingCapability,
  ThinkingFormat
} from '@shared/types'

/**
 * 从云雾 `/v1/models` 返回的单个模型条目推导能力标记。
 *
 * 设计:能力来源以后端返回的 `tags` / `model_type` 为准(零 App 维护 —— 云雾在 admin
 * 打好 tag 后,客户端不升级也能自动正确)。当后端未打 tag 时,再回退到模型名启发式,
 * 保证老数据/漏标模型也有合理默认。已通过真机抓包验证 tag 语义:
 *  - 「思考」→ 推理模型(流式吐 reasoning_content);
 *  - 「识图/视觉/多模态」→ 图片输入;
 *  - 「工具」→ 工具调用;
 *  - model_type「文本」=chat,「图像/绘画」=image,「视频」=video,「音频/语音」=audio。
 */

/** 云雾 /v1/models data[] 的原始条目(仅取我们关心的字段)。 */
export interface RawModelEntry {
  id?: string
  model_type?: string
  tags?: string
  supported_endpoint_types?: string[]
}

/** 判断字符串是否包含任一关键字。 */
function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n))
}

/**
 * 家族级思考能力。**命中即权威,盖过 tag**;返回 null 表示"这个族我们没查过"。
 *
 * 为什么必须有这张表:2026-08-16 拿真机快照量过,478 条里对话类 278 条,带「思考」/「推理」
 * tag 的只有 62 条(22%),而 `claude-*` 全家、`gpt-5.4` / `gpt-5.2`、`o3-mini` / `o4-mini`、
 * `gemini-3-flash-preview`、`deepseek-v4-flash` 都不带。同一份快照里 tags 全空的对话模型是
 * **0 条**,所以下面 `reasoningByName` 那条「tags 为空才走名字」的老兜底在真实账号上永远不触发
 * —— 只信 tag 等于给 Claude 与 GPT-5 静默摘掉思考。真机 `openclaw.json` 已经是这个样子:
 * 已选的 4 个模型里只有 `gpt-5-pro` 是 `reasoning:true`,`claude-opus-4-6` 是 `false`。
 *
 * 表里的档位与「能不能关」不是我们发明的,全部来自平台适配器已有的官方边界:
 *  - Gemini:`new-yunwu-api/relay/channel/gemini/thinking_capability.go:170-203`
 *    (3+ 全系走 thinkingLevel 且官方关不掉;2.5 Pro 也关不掉;2.5 Flash / Flash-Lite 可关;
 *    2.5 之前没有思考配置);
 *  - Claude:`relay/channel/claude/relay-claude.go:547-565` 的 switch **只认
 *    low / medium / high**,传 xhigh / max 会走不到任何 case,Thinking 字段留空 ——
 *    也就是思考被静默丢掉,所以这一族绝不能放开 xhigh / max;
 *  - OpenAI:`relay/channel/openai/adaptor.go:54-67` 与 `:344-348`
 *    (`gpt-5-pro` 只支持 high、`gpt-5-chat-latest` 不是推理模型、
 *    `gpt-5.x` / codex 的 minimal 会被平台映射成 low)。
 *
 * 查不到的族一律留 `levels` 为空,让界面只出思考开关 —— 照 WorkBuddy 的降级路径走
 * (`supportedEffortsEmptyHint`:*Only the reasoning toggle will be shown*),不编造档位。
 *
 * **往表里加东西的纪律**(2026-08-17 定,起因是"要不要把所有模型测一遍写进来"):
 *  1. 实测结论只按**精确模型名**写。族级泛化必须有多条同族实测且结论一致才敢写 ——
 *     反例摆在下面:`glm-4.5` / `glm-4.7` 走 `enable_thinking`,`glm-5.1` 走
 *     `thinking:{type}`,同一族两种方言。
 *  2. 一次观测不算通则。`glm-4.5-air` 前后两轮实测给出过相反结论(同一个模型名背后的
 *     上游渠道会轮换),这类易变的判断该留在后台下发层(改了不用发版),不要固化进本表。
 *  3. 本表存"家族级稳定的事实",单模型怪癖走下发层 —— 两层的顺序见 model-catalog.ts。
 */
interface ThinkingProfile {
  /**
   * 留空 = **这一族的"会不会思考"仍交给标签/名字判定**,本条只想约束下发方式。
   * 这个区分是必需的:2026-08-16 第一版把「glm / doubao / kimi 不发 effort」写成
   * `{ reasoning: true, effort: false }`,结果连 `glm-4-plus`、`doubao-pro-32k` 这些
   * 老的非思考模型也被判成会思考(会思考数 141 → 185)。压制档位不等于宣称会思考。
   */
  reasoning?: boolean
  levels?: Exclude<ChatThinking, 'off'>[]
  canDisable?: boolean
  default?: Exclude<ChatThinking, 'off'>
  /**
   * `reasoning_effort` 吃不吃。**与"能不能关"无关**,见 `canDisable`。
   *
   * 三态且默认偏保守:`true` = 明说吃(不给 levels 时也照样下发,如 deepseek-v4);
   * `false` = 明说不吃;**留空 = 按"不吃"处理**(除非同时给了 `levels`,给档位本身就是明说吃)。
   * 留空为什么不是"发"见 `effortAffirmed` —— 发错的代价是 400、整条对话失败,
   * 不发的代价只是少一排档位。
   */
  effort?: boolean
  /** 思考参数方言(内核 `compat.thinkingFormat`);只给实测确认过的模型写。 */
  format?: ThinkingFormat
}

/**
 * `low / medium / high` 是平台四条适配器路径的公约数:Gemini 两种控制方式都收
 * (budget 与 level 各有换算),Claude 的 switch 正好只认这三个,OpenAI 全系支持。
 * 所以放开档位时只放这三档,`xhigh` / `max` 要有族级证据才给。
 */
const COMMON_LEVELS: Exclude<ChatThinking, 'off'>[] = ['low', 'medium', 'high']

/** 模型名里是否含以 `-` 分隔的独立片段(照平台 `hasModelToken`,避免 prompt 撞上 pro)。 */
function hasSegment(name: string, token: string): boolean {
  return name.split('-').includes(token)
}

/** 解析 `gemini-<主>[.<次>]-` 前缀为可比较版本号(2.5 → 2005,3 → 3000),与平台 `geminiVersionCode` 同口径。 */
function geminiVersion(name: string): number {
  const m = /^gemini-(\d+)(?:\.(\d+))?(?:-|$)/.exec(name)
  if (!m) {
    return 0
  }
  return Number(m[1]) * 1000 + (m[2] ? Number(m[2]) : 0)
}

function geminiProfile(s: string): ThinkingProfile | null {
  const version = geminiVersion(s)
  // `gemini-pro-latest` 这类滚动别名解析不出代次,平台自己也只能按 2.5 语义兜底
  // (thinking_capability.go:180-186)。我们不跟着猜档位,交给标签判定 + 只出开关。
  if (version === 0) {
    return null
  }
  // Gemini 3+ 改用 thinkingLevel,官方明确不支持关闭思考(:170-173 与结构体注释 :27)。
  if (version >= 3000) {
    return { reasoning: true, levels: COMMON_LEVELS, canDisable: false, default: 'medium' }
  }
  // 2.5 之前没有思考配置,传参会被上游 400(:176-178)。
  if (version < 2005) {
    return { reasoning: false }
  }
  // 2.5 系列:Pro 各代都不允许关闭(:188-191),Flash / Flash-Lite 允许(:192-198)。
  return {
    reasoning: true,
    levels: COMMON_LEVELS,
    canDisable: !hasSegment(s, 'pro'),
    default: 'medium'
  }
}

function claudeProfile(s: string): ThinkingProfile | null {
  // 两种命名并存:新的 `claude-<名>-<主>-<次>`,旧的 `claude-<主>-<次>-<名>`。
  const modern = /^claude-(?:opus|sonnet|haiku|fable)-(\d+)/.exec(s)
  const legacy = /^claude-(\d+)-(\d+)-/.exec(s)
  const major = modern ? Number(modern[1]) : legacy ? Number(legacy[1]) : 0
  const minor = legacy ? Number(legacy[2]) : 0
  // 扩展思考从 3.7 起;`claude-3-haiku` / `claude-3-5-sonnet` 没有这个能力。
  if (!(major >= 4 || (major === 3 && minor >= 7))) {
    return { reasoning: false }
  }
  return { reasoning: true, levels: COMMON_LEVELS, canDisable: true, default: 'medium' }
}

function openaiProfile(s: string): ThinkingProfile | null {
  // `gpt-5*-chat*` 整条支线都是非推理的对话模型 —— 平台对 `gpt-5-chat-latest` 的注释原话是
  // 「非推理模型,不会真正使用 reasoning_effort」(adaptor.go:61),这批只是它的日期快照与代次兄弟
  // (`gpt-5-chat`、`gpt-5.1-chat-latest`、`gpt-5.2-chat-2026-02-10`…,真机快照里 9 条)。
  // 搜索专用支线同理:它走的是内建检索,不吃思考参数。
  if (hasSegment(s, 'chat') || s.includes('-search-api') || s.includes('-search-preview')) {
    return { reasoning: false }
  }
  if (s.startsWith('gpt-5')) {
    // pro 系列官方只收 high(adaptor.go:59),也没有"不思考"这个状态。
    if (hasSegment(s, 'pro')) {
      return { reasoning: true, levels: ['high'], canDisable: false, default: 'high' }
    }
    return { reasoning: true, levels: COMMON_LEVELS, canDisable: true, default: 'medium' }
  }
  if (/^o[134](-|$)/.test(s)) {
    // o1 的这两个老快照不接受 reasoning_effort(adaptor.go 注释原话:给了只会 400),
    // 所以标成"档位不可控"而不是"没声明档位"——后者会让下发路径按未知档兜一个 medium 出去,
    // 正好撞上那个 400。effort:false 之后 `config-writer` 会写
    // compat.supportsReasoningEffort:false,内核便完全不下发档位,思考正文照旧解析。
    if (s.startsWith('o1-mini') || s.startsWith('o1-preview')) {
      // canDisable:false 是 2026-08-16 补的:这两个快照始终思考,而"关不掉"以前是靠
      // `canToggleThinking` 里那条 `thinkingEffort === false` 顺带实现的。那条已经拆掉
      // (实测有一批模型档位不可控但真能关),所以关不掉必须在这里如实写出来。
      return { reasoning: true, effort: false, canDisable: false }
    }
    return { reasoning: true, levels: COMMON_LEVELS, canDisable: true, default: 'medium' }
  }
  return null
}

/**
 * Grok:`-non-reasoning` 变体名字就写着不推理;4 代及以后**始终思考但不接受 reasoning_effort**
 * —— 这不是我们猜的,内核 `detectCompat` 对 grok 直接把 `supportsReasoningEffort` 置 false
 * (`openclaw/src/llm/providers/openai-completions.ts:1305-1306`)。真机快照里
 * `grok-4.5` / `grok-4.3` / `grok-4.6` 是靠平台「思考」标签进来的,若不在这里标成"档位不可控",
 * 界面一开开关就会下发一个上游不认的参数。
 */
function grokProfile(s: string): ThinkingProfile | null {
  if (/non-reasoning/.test(s)) {
    return { reasoning: false }
  }
  // grok-build 是 xAI 的编码款,版本号形如 `grok-build-0.1`,`^grok-(\d+)` 匹配不上,
  // 于是整条走不到任何规则。2026-08-17 实测:base T42 一直在想,两种关法都无效
  // (`enable_thinking:false` 后 T49、`thinking:{type}` 后 T42),effort 那一发渠道报错。
  // 形状与 grok 4 代一致 —— 始终思考、关不掉、不吃档位。
  if (s.startsWith('grok-build')) {
    return { reasoning: true, canDisable: false, effort: false }
  }
  const major = /^grok-(\d+)/.exec(s)
  if (major && Number(major[1]) >= 4) {
    // canDisable:false 与上面 o1-mini 同一个理由:内核对 grok 完全不下发档位,也就没有
    // 任何途径把"别思考"送达上游 —— 它始终思考。原来这个事实是靠 `canToggleThinking`
    // 里的 `thinkingEffort === false` 顺带表达的,那条已拆(见 shared/types.ts)。
    return { reasoning: true, effort: false, canDisable: false }
  }
  return null
}

/**
 * 下面这几族(qwen / glm / doubao / deepseek / kimi / minimax / mimo)**全部来自真机实测**,
 * 不是文档推断。
 *
 * 脚本 `scripts/probe-thinking-params.mjs`(海外站真实令牌,全流式),对每个模型打最多 6 发:
 * 什么都不传、只传 `reasoning_effort`、`enable_thinking` 开/关、`thinking:{type}` 开/关,
 * 判据是流里有没有 `reasoning_content`。两轮的总账:
 *  - 2026-08-16(38 条 tags 说思考的):会思考 22(可关 12 / 关不掉 10)、确认不思考 7、打不通 9;
 *  - 2026-08-17(158 条**我们判不思考**的全扫一遍):**漏判 27 条**、确认不思考 91、打不通 40。
 * 原始逐发结果在 `.tmp-probe/thinking-params.json` 与 `.tmp-probe/thinking-missed-deep.json`。
 *
 * **第二轮那 27 条是这张表存在的最强理由**:它们的 tags 只写「对话」/「对话,工具」,
 * 一个「思考」字都没有,却默认就吐思考 —— 只信标签等于让用户拿 `qwen3.6-plus`、`glm-5.2`、
 * `kimi-k2.6` 这些主力模型对话时,思考过程不解析、界面也没有思考开关。
 * 反过来标签也会错标(`qwq-32b` 标了思考却一个思考字不回)。
 *
 * 方言同样逐模型不同,**同族多方言是常态**:`glm-4.7` 吃 `enable_thinking`、`glm-5.x` 吃
 * `thinking:{type}`;qwen 族里 `qwen3.6-plus` 可关、相邻的 `qwen3.6-27b` 关不掉、
 * `qwen3-coder-plus` 压根不想。所以名单式(精确名 / 明确前缀)是必需的,前缀一泛化就出错。
 *
 * **没测到的一律不写**(doubao seed-1-6 全系两轮都 429、deepseek-r1 的日期别名 no access):
 * 宁可退回标签判定,也不把猜的结论当事实下发。**两轮结论相反的也不写**——`qwen3.8-max`
 * 单发扫描时在想、六发复测时一个思考字都没有(同一个模型名背后的上游渠道会轮换),
 * 这种易变判断的正确归宿是服务端下发层(改了不用发版),不是这张要跟着版本走的表。
 */
function qwenProfile(s: string): ThinkingProfile | null {
  // 实测始终思考、两种方言都关不掉(`enable_thinking:false` 与 `thinking:{type:disabled}`
  // 打完仍在吐思考)。2026-08-17 补测,逐发见下:
  //   qvq-max      base T11 / effort T8  / qwen_off T11 / ds_off T10
  //   qwq-plus     base T15 / effort T15 / qwen_off T15 / ds_off T15
  //   qwen3.6-27b  base T29 / effort T29 / qwen_off T29 / ds_off T29
  // 这条必须排在下面 `qwq` 那条不思考规则前面:原来 `startsWith('qwq')` 把 qwq-plus 一起
  // 判成不思考,而实测它每发都在想 —— 前缀式规则在这一族又错了一次。
  if (QWEN_MEASURED_LOCKED_ON.has(s)) {
    return { reasoning: true, canDisable: false, effort: false }
  }
  // 实测零思考输出:qwen3-coder-plus / -30b-a3b-instruct / -480b-a35b-instruct 三条都标了
  // 「思考」tag,但六发全无 reasoning_content。`qwq-32b` 同样(名字写着 qwq 却不想),
  // 但**只按精确名写**:同族的 qwq-plus 恰恰关不掉(见上)。
  if (s === 'qwq-32b' || s.startsWith('qwen3-coder')) {
    return { reasoning: false }
  }
  // 名字里带 think / thinking 的变体:实测始终思考且关不掉,上游对 `enable_thinking:false`
  // 直接回 400 *The value of the enable_thinking parameter is restricted to True*
  // (qwen3-30b-a3b-thinking-2507 / qwen3-next-80b-a3b-thinking 两条都拿到这句原话)。
  if (hasSegment(s, 'think') || hasSegment(s, 'thinking') || /-thinking-\d/.test(s)) {
    return { reasoning: true, canDisable: false, effort: false }
  }
  // 实测过的这几条:默认就思考,`enable_thinking:false` 真能关(关掉后正文 3 字、2.4 秒回,
  // 一个思考字都没有);`reasoning_effort` 无影响。
  //
  // **只列实测过的,不按 `^qwen3` 泛化。** 第一版泛化了,于是 `qwen3-vl-32b-instruct` 这类
  // `-instruct` 变体(它恰恰是 `-thinking` 的非思考对照款)、以及没测过的 `qwen3-max` /
  // `qwen3.6-plus` 全被宣称成会思考 —— 27 条凭空多出来。判定权还给标签更诚实。
  if (QWEN_MEASURED_TOGGLEABLE.has(s)) {
    return { reasoning: true, canDisable: true, effort: false, format: 'qwen' }
  }
  // 其余 qwen 不替它判会不会思考(交给标签),但方言可以给整族:阿里通道读的是顶层
  // `enable_thinking`(`new-yunwu-api/relay/channel/ali/adaptor.go:121-126`,平台 dto 里这个
  // 字段的注释就写着 `// Ali Qwen Params`),而 effort 这一族不吃 —— 实测 5 条一致,
  // `glm-4.5`(同样走阿里那套错误码)更是直接 400。给了方言,思考开关才真能送达。
  return { effort: false, format: 'qwen' }
}

/**
 * qwen 族里**实测确认"默认思考且能关"**的模型(`scripts/probe-thinking-params.mjs`,2026-08-16)。
 * 名单式而非规则式:同族里 `-instruct` 不思考、`-thinking` 关不掉、基础款可关,规律不成立。
 */
const QWEN_MEASURED_TOGGLEABLE = new Set([
  'qwen3.5-plus',
  'qwen3.5-plus-2026-02-15',
  'qwen3.5-122b-a10b',
  'qwen3.5-397b-a17b',
  'qwen3-max-2026-01-23',
  // 下面 11 条是 2026-08-17 补测进来的,**全部是平台 tags 没写「思考」的漏标模型**
  // (`对话` / `对话,工具` / `对话,识图`),第一轮因此被判成不会思考:用户拿它们对话时
  // 思考过程不解析、界面也没有开关。逐发一致 —— base 与 effort 都在想,
  // `enable_thinking:false` 一发就归零并给出正文(3~17 字),`thinking:{type}` 多数无效。
  'qwen3-8b',
  'qwen3-14b',
  'qwen3-30b-a3b',
  'qwen3.5-27b',
  'qwen3.5-35b-a3b',
  'qwen3.6-plus',
  'qwen3.6-plus-2026-04-02',
  'qwen3.6-35b-a3b',
  'qwen3.6-max-preview',
  'qwen3.7-plus',
  'qwen3.7-max'
])

/**
 * qwen 族里实测**始终思考且关不掉**的模型(2026-08-17)。
 *
 * 和上面那份并列存在是有原因的:同族里可关 14 条、关不掉 3 条、压根不想 4 条,
 * 三种形状交错分布在 `qwen3.6-plus`(可关) / `qwen3.6-27b`(关不掉) / `qwen3-coder-plus`(不想)
 * 这样的相邻名字上。任何前缀规则都会把其中一类判错。
 */
const QWEN_MEASURED_LOCKED_ON = new Set(['qvq-max', 'qwq-plus', 'qwen3.6-27b'])

function glmProfile(s: string): ThinkingProfile | null {
  // glm-4.5-air:标了「思考」,实测六发零思考。
  if (s.startsWith('glm-4.5-air')) {
    return { reasoning: false }
  }
  // glm-5 系走 `thinking:{type:disabled}` 才关得掉,而 4.5 / 4.7 走 `enable_thinking:false`
  // —— 同一族两种方言,这正是"不能按族推"的最硬证据,所以按**代**分而不是整族一刀。
  //
  // 5 系三条现在都实测过了(2026-08-17 补测 glm-5 与 glm-5.2,两条 tags 都没写「思考」、
  // 之前被判成不会思考):glm-5 base T13 → ds_off T0/C3;glm-5.2 base T17、
  // `enable_thinking:false` 无效(T24 仍在想)、ds_off T0/C3。与 5.1 同一形状,零反例,
  // 所以这一代敢按前缀写 —— 以后出的 glm-5.x 自动走对方言。
  if (/^glm-5(\.\d+)?(-|$)/.test(s)) {
    return { reasoning: true, canDisable: true, effort: false, format: 'deepseek' }
  }
  if (s === 'glm-4.5' || s === 'glm-4.7') {
    return { reasoning: true, canDisable: true, effort: false, format: 'qwen' }
  }
  // 其余 glm 没实测过,所以**不替它判会不会思考**(留给标签),只借族级证据压掉档位下发:
  // glm-4.5 上游的原话是 *The parameters `reasoning_effort` is not supported*(HTTP 400),
  // 整条消息会失败,这个风险足以覆盖整族。
  return { effort: false }
}

function doubaoProfile(s: string): ThinkingProfile | null {
  // 实测可关、方言是 `thinking:{type}`(与平台 dto 那句 `// doubao,zhipu_v4` 注释对得上)。
  //
  // 后两条是 2026-08-17 补测的,而它们**平台 tags 里压根没写「思考」**
  // (`对话,识图,工具` 之类),第一轮因此被判成不会思考 —— 用户拿 `doubao-seed-2-0-lite`
  // (海外站 512 次/时,doubao 族用量第一) 对话时,思考过程既不解析也没有开关。
  // 逐发证据(base / effort / enable_thinking:false / thinking:{type:disabled}):
  // lite 36/36/36/**0** 块思考,mini 33/49/42/**0** —— 默认就思考,只有 `thinking:{type}` 关得掉,
  // effort 全程无影响。这是"标签漏标"的又一例,也是为什么会思考这件事不能只信 tags。
  if (
    s.startsWith('doubao-seed-2-0-code-preview') ||
    s.startsWith('doubao-seed-1-6-flash') ||
    s.startsWith('doubao-seed-2-0-lite') ||
    s.startsWith('doubao-seed-2-0-mini') ||
    // 这两条同样是 tags 没写「思考」的漏标(2026-08-17):
    // 2-0-pro base T16、`enable_thinking:false` 无效、ds_off T0/**C84**;1-8 base T16、ds_off T0/C4
    s.startsWith('doubao-seed-2-0-pro') ||
    s.startsWith('doubao-seed-1-8')
  ) {
    return { reasoning: true, canDisable: true, effort: false, format: 'deepseek' }
  }
  // 其余 doubao 仍**不替它判会不会思考**(seed-1-6 全系与 2-1-pro 两轮实测都是 429
  // 「当前分组上游负载已饱和」,属中转站侧的事,不是模型没有这个能力)。
  //
  // 但族级方言现在敢写了:火山这族实测 4 条(2-0-code-preview / 1-6-flash / 2-0-lite /
  // 2-0-mini) 全是 `thinking:{type}` 关得掉、`enable_thinking` 无效、effort 无影响,零反例,
  // 平台 dto `openai_request.go:92` 那句 `// doubao,zhipu_v4` 也指同一处。
  // 不写方言的代价是具体的:靠 tags 判成会思考的那 5 条(2-1-pro 等)界面会给关思考开关,
  // 而"关"会按默认的 openai 方言只删掉 `reasoning_effort` —— 对火山这族等于什么都没做,
  // 用户关了还在想。写上方言,至少这一路是对的。
  //
  // 留一个已知的不确定:`-thinking-` 变体(seed-1-6-thinking-*)照 qwen 的先例可能压根关不掉,
  // 429 让它没测成。真是那样,现象是"关了仍在想",与不写方言时一样,不会更差。
  return { effort: false, format: 'deepseek' }
}

function deepseekProfile(s: string): ThinkingProfile | null {
  // v3 系(含 v3.1 / v3-1-250821):实测零思考输出,尽管 tags 标了「思考」。
  if (/^deepseek-v3/.test(s)) {
    return { reasoning: false }
  }
  // r1 系:实测始终思考、关不掉,且不吃 effort。
  if (/^deepseek-r/.test(s) || s.startsWith('deepseek-reasoner')) {
    return { reasoning: true, canDisable: false, effort: false }
  }
  // v4 系(pro / pro-0813 / flash 三条都实测过):base 不思考,**传 reasoning_effort 才思考**
  // —— 这一族是唯一"effort 就是开关"的,与平台 dto 注释暗示的 thinking:{type} 相反
  // (真机传 thinking:{type:enabled} 反而不思考)。
  //
  // 这条顺手修掉一个用户可见的漏:`deepseek-v4-flash` 的 tags 只有「对话,工具」,
  // 名字启发式也不命中,于是一直被判成不会思考 —— 而它是首启预勾的模型之一,
  // 用户拿它对话时思考过程压根没被解析出来。
  //
  // 方言必须写 `deepseek`:内核对 v4 这两个 id 自带一个思考 wrapper(关→
  // `thinking:{type:disabled}` 并删掉 effort,开→ `thinking:{type:enabled}` + effort),
  // 但它只在 `thinkingFormat` 未写或写成 `deepseek` 时才生效
  // (`openclaw/src/agents/embedded-agent-runner/extra-params.ts:967-971`)。
  // 写成 `openai` 会双重打击:wrapper 不挂,还额外触发把 `thinking` 字段删掉的清理器
  // —— 2026-08-16 真机就是这样:关思考时线上收到 `reasoning_effort:"high"`。
  if (/^deepseek-v4-(pro|flash)/.test(s)) {
    return { reasoning: true, canDisable: true, effort: true, format: 'deepseek' }
  }
  return null
}

function kimiProfile(s: string): ThinkingProfile | null {
  // kimi-k3 实测:默认思考,`enable_thinking:false` 与 `thinking:{type:disabled}` 都关不掉。
  if (s.startsWith('kimi-k3')) {
    return { reasoning: true, canDisable: false, effort: false }
  }
  // k2.6 是 2026-08-17 补测出来的漏标(tags 只有「对话」):base T22 在想,
  // `enable_thinking:false` 无效(T11),`thinking:{type:disabled}` → T0/C3 关得掉。
  if (s.startsWith('kimi-k2.6')) {
    return { reasoning: true, canDisable: true, effort: false, format: 'deepseek' }
  }
  // k2.7-code:base T85 / effort T137 一直在想,`enable_thinking:false` 无效,而
  // `thinking:{type:disabled}` 被上游顶回来,原话是 *invalid thinking: only type=enabled
  // is allowed for this model*(HTTP 400)。**这是结论不是故障** —— 上游自己说了只能开着。
  if (s.startsWith('kimi-k2.7')) {
    return { reasoning: true, canDisable: false, effort: false }
  }
  // 其余 kimi 未实测,不替它判会不会思考。族级结论只取一条:内核 `detectCompat` 对 moonshot
  // 直接把 supportsReasoningEffort 置 false(`openai-completions.ts:1305-1306`),跟着不发档位。
  return { effort: false }
}

/**
 * MiniMax 与小米 mimo:2026-08-17 才第一次进这张表,之前整族没有条目 —— 而它们全都是
 * tags 不写「思考」的漏标模型,也就是说这两族此前在客户端一律被当作不会思考。
 *
 * 逐发(base / effort / `enable_thinking:false` / `thinking:{type:disabled}`):
 *  - `MiniMax-M2.7`   T8 / T8 / T8 / **T0 + 827 字正文** → 可关,thinking:{type} 方言
 *  - `MiniMax-M2.5`   T48 / T13 / 400 / 400 → **关不掉**:两种关法都被上游顶回,原话是
 *    *InternalError.Algo.InvalidParameter: The value of the enable_thinking parameter is
 *    restricted to True*(与 qwen 的 `-thinking` 变体同一句)。上游明说的比任何推断都硬。
 *  - `mimo-v2.5`      T3 / T2 / T12 / **T0/C4**          → 可关,thinking:{type}
 *  - `mimo-v2.5-pro`  T24 / T39 / T27 / **T0/C3**        → 同上
 *
 * mimo 两条一致所以敢给族级方言;MiniMax 只有一条关成功,方言只写在那一条上。
 */
function minimaxProfile(s: string): ThinkingProfile | null {
  if (s.startsWith('minimax-m2.7')) {
    return { reasoning: true, canDisable: true, effort: false, format: 'deepseek' }
  }
  if (s.startsWith('minimax-m2.5')) {
    return { reasoning: true, canDisable: false, effort: false }
  }
  // 其余 MiniMax 不替它判会不会思考。effort 这一族实测无影响,档位不下发。
  return { effort: false }
}

function mimoProfile(s: string): ThinkingProfile | null {
  if (s.startsWith('mimo-v2.5')) {
    return { reasoning: true, canDisable: true, effort: false, format: 'deepseek' }
  }
  return { effort: false, format: 'deepseek' }
}

/** 按模型名查家族级思考能力;没查过的族返回 null(界面只出开关)。 */
function thinkingProfile(id: string): ThinkingProfile | null {
  const s = id.toLowerCase()
  // gpt-oss 是 OpenAI 的开源款,名字以 gpt- 开头但走的**不是** OpenAI 那套 —— 必须拦在
  // openaiProfile 前面,否则会被当成 gpt 系而拿到 low/medium/high 档位。
  // 实测 `gpt-oss-120b`:base T362 / effort T243 一直在想,两种关法都无效(T283 / T264)。
  if (s.startsWith('gpt-oss')) {
    return { reasoning: true, canDisable: false, effort: false }
  }
  if (s.startsWith('minimax')) {
    return minimaxProfile(s)
  }
  if (s.startsWith('mimo')) {
    return mimoProfile(s)
  }
  if (s.startsWith('grok')) {
    return grokProfile(s)
  }
  // qvq 是阿里的视觉推理款(`qvq-max`),名字既不以 qwen 也不以 qwq 开头 —— 漏了它就等于
  // 这一条走不到任何家族规则。2026-08-17 实测它始终思考且关不掉。
  if (s.startsWith('qwen') || s.startsWith('qwq') || s.startsWith('qvq')) {
    return qwenProfile(s)
  }
  if (s.startsWith('glm')) {
    return glmProfile(s)
  }
  if (s.startsWith('doubao')) {
    return doubaoProfile(s)
  }
  if (s.startsWith('deepseek')) {
    return deepseekProfile(s)
  }
  if (s.startsWith('kimi')) {
    return kimiProfile(s)
  }
  if (s.startsWith('gemini')) {
    return geminiProfile(s)
  }
  if (s.startsWith('claude')) {
    return claudeProfile(s)
  }
  if (s.startsWith('gpt-') || /^o[134]/.test(s)) {
    return openaiProfile(s)
  }
  return null
}

/**
 * 家族表有没有**明说**这个模型吃 `reasoning_effort`(明说 = 给了 levels 或写了 effort:true)。
 *
 * 没明说就一律按"不吃"处理 —— 包括家族表压根不认识这个模型的情况。这条默认是反过来的,
 * 理由是两种错的代价差一个量级:
 *  - 不该发而发了 → 上游可能直接 400(`glm-4.5` 的原话是 *The parameters `reasoning_effort`
 *    is not supported*),整条对话失败,用户完全没法用这个模型;
 *  - 该发而没发 → 界面少一排档位胶囊,思考本身照旧(内核不下发档位而已)。
 *
 * 为什么必须是"未知也不发":2026-08-17 自检时用合成 id 试过 —— `baichuan5-max`(标签写「推理」)、
 * `yi-3-large`、`llama-5-thinking`、`nova-pro-1.5`、`spark-x2-reasoning` 这类家族表今天不认识的
 * 名字,全都会被判成会思考并默认发 effort;`glm-6` / `qwen4-max` 之所以安全,纯粹是因为
 * GLM / Qwen 整族兜底已经压成了 effort:false。也就是说平台以后上一个新家族的推理模型,
 * 就可能复刻 glm-4.5 那个 400。改这条默认之后,风险不再依赖"清单测得全不全"。
 *
 * 代价是知道的:未知模型开了思考却拿不到档位,极端情况下(上游只在收到 effort 时才思考)
 * 开关会像没反应。这类模型的正解是实测一条、写进上面的家族表,或走后台下发层把
 * `thinking_effort` 覆盖成 true —— 覆盖层在家族表之后生效(见 model-catalog.ts 的顺序注释),
 * 所以不必等客户端发版。
 *
 * 影响半径量过(2026-08-17,真机快照 320 条对话模型):会收到 effort 的 96 条全部有家族表
 * 明确背书(claude / gpt / gemini / o 系给了 levels,deepseek-v4 写了 effort:true),
 * 所以这条改动对当天的线上模型是零行为变化,只挡未来。
 */
function effortAffirmed(p: ThinkingProfile | null): boolean {
  return !!p && (p.effort === true || !!p.levels)
}

/** 依据模型名做推理能力启发式(家族表没命中、tag 也没标时的兜底)。 */
function reasoningByName(id: string): boolean {
  const s = id.toLowerCase()
  // 先排掉"明说不推理"的变体。这条不是防御性代码,是真机踩到的:`includes('reason')` 会把
  // `grok-4-1-fast-non-reasoning` / `grok-4-20-non-reasoning` 判成推理模型。老写法把名字兜底
  // 关在「tags 为空」后面,所以一直没暴露;现在名字兜底常态生效,这一层必须补上。
  if (/non-reasoning|non-thinking|nothinking/.test(s)) {
    return false
  }
  return (
    /(^|[^a-z])(o1|o3|o4)([^a-z]|$)/.test(s) ||
    /\br1\b/.test(s) ||
    s.includes('thinking') ||
    s.includes('reason') ||
    s.includes('-think') ||
    s.includes('deepseek-r')
  )
}

/** 依据模型名做视觉能力启发式(后端无「识图」tag 时的兜底)。 */
function visionByName(id: string): boolean {
  const s = id.toLowerCase()
  return s.includes('-vl') || s.includes('vision') || s.includes('-vl-') || /\bvl\b/.test(s)
}

/**
 * 依据模型名判断「这个对话模型能不能联网检索」。
 *
 * **这一档不能只看 tags,和别的能力标记不一样,但原因不是平台漏标**(2026-08-14 查库核对过,
 * 别再去提「让后台补 tag」):云雾「联网」tag 的语义是**这个条目默认就联网**,所以它标在
 * 名字里带 search/deepsearch 的**变体条目**上 —— 19 条带 tag 的里几乎全是这一类
 * (`deepseek-v3-search`、`grok-3-deepsearch`、`qwen3-max-preview-search`…),
 * 其中也**包括** Gemini 的 `gemini-2.5-flash-deepsearch` / `gemini-2.5-pro-deepsearch`。
 *
 * 而我们要问的是另一件事:**这个模型能不能被要求联网**。基础的 `gemini-2.5-flash` 默认
 * 不联网,得调用方显式传一个名为 `googleSearch` 的 function 工具,云雾才把它翻译成 Gemini 的
 * Google Search grounding(`new-yunwu-api/relay/channel/gemini/relay-gemini.go:390-431`)。
 * 按平台口径它确实不该有那个 tag —— 两套判据回答的是不同问题,所以这里必须自己判。
 * 这与本文件头「tags 只认产出词、不认能力词」是同一种区分。
 *
 * (顺带:那 19 条带 tag 的里有 13 条**没有任何渠道承载**,`/v1/models` 与广场都进不去,
 * 所以线上真正带「联网」tag 又在架的只有 OpenAI 那 6 条。)
 *
 * 两族的**调用形状不同**(Gemini 要传 googleSearch 工具,OpenAI 那族天然搜索、不能传),
 * 分辨这件事归插件——它是运行时权威,与媒体那侧「判据在插件、界面只管铺」同一分工
 * (见 `shared/media-endpoints.ts` 文件头)。这里只回答「有没有这个能力」。
 *
 * 实测(2026-08-14,问「2026 年 8 月 13 日上证指数收盘」,正确答案 3926.96):
 * `gemini-2.5-flash` 2.8 秒答对、`gemini-3.1-flash-lite` 2.6 秒答对、
 * `gemini-3-flash-preview` / `gemini-2.5-flash-lite` / `gemini-2.5-pro` / `gemini-3-pro-preview`
 * 也都答对(后三个 20~31 秒);而 `gpt-4o-mini-search-preview` 只答得出英文问的海外信息,
 * 中文问国内时事拿到的是去年同日的数据。**所以这里判的是能力,快慢与准度由默认顺序决定。**
 *
 * 不在这里排除「实测调不通」的那几个(`gemini-2.0-flash-lite` 被上游下架、
 * `gemini-flash-latest` 稳定 429):那是渠道问题不是能力问题,而且会变。运行时逐个试即可
 * —— 与 `public-models.ts` 里「`/v1/models` 列出来不等于有渠道能接」是同一条纪律。
 */
function searchByName(id: string): boolean {
  const s = id.toLowerCase()
  return s.includes('-search-preview') || s.includes('-search-api') || s.startsWith('gemini-')
}

/**
 * 依据模型名判断是否为向量模型(后端 model_type / endpoints 都没给时的兜底)。
 *
 * 这层兜底是必需的,而且比「漏标」更糟 —— 后端是**标反了**。2026-08-06 实测本机账号
 * (101 个模型)拉 `/v1/models`,三个 `text-embedding-*` 回的是:
 * `model_type` 缺失、`supported_endpoint_types: []`、而 `tags` 是 **"推理,工具,文件,32K"**。
 * 于是两条判据全落空、走末行兜底判成 chat,还顺带拿到 reasoning=true —— 而默认对话模型选的
 * 正是 `chat.find((m) => m.reasoning)`(见 shared/model-selection.ts),向量模型不是「碰巧
 * 混进来」,是**优先被选中**当账户默认模型。
 *
 * 后果实测过:`agents.list` 里两条任务 agent 的 model 就是 `yunwu/text-embedding-3-small`
 * 与 `yunwu/text-embedding-ada-002`,而向量模型根本不能对话。平时被会话级模型覆盖遮着,
 * 一旦 `sessions.patch` 失败回退到 agent 默认模型,就会真拿它跑对话。
 *
 * 治本在云雾后台把 tag 改对(那才是「零 App 维护」的设计意图,见本文件头注释);这层兜底
 * 是防线,不是替代品。只取无歧义的字样,宁可漏判也不误伤对话模型。
 *
 * 顺带一提,WorkBuddy 没有这类 bug 是因为它压根不做分类:官方模型是 `cli/product.json` 里
 * 44 条手工维护的清单(无 category 字段、无一个向量模型),自定义模型靠用户在表单里逐条勾
 * 能力(`~/.workbuddy/models.json`)。全量 asar 里 `v1/models` 零命中 —— 它从不拉模型目录。
 * 我们做不到那个形状:卖点就是用户自带云雾账号、账号里有什么就能用什么,清单不由我们掌控。
 */
function embeddingByName(id: string): boolean {
  const s = id.toLowerCase()
  return (
    s.includes('embed') || s.includes('text2vec') || /(^|[^a-z])(bge|m3e)([^a-z]|$)/.test(s)
  )
}

/**
 * 这个对话模型必须走 `/v1/responses` 吗。
 *
 * 云雾在 `supported_endpoint_types` 里标了协议:`openai` = `/v1/chat/completions`,
 * `openai-response` = `/v1/responses`。2026-08-15 真机统计:全站 478 条里 279 条标 `openai`、
 * 48 条标 `openai-response`,广场上架的对话池 266 个里有 13 个**只标后者**。
 *
 * 只在「只支持 responses」时返回真。两种都标的那 32 个保持现状走 completions ——
 * 它们今天能用,切协议属于另一件事(responses 的 reasoning item 更完整,但要另验一轮)。
 *
 * 实测这批拿 chat/completions 打会被上游直接顶回来:`gpt-5.5-pro` / `gpt-5-pro` /
 * `gpt-5.2-pro` / `gpt-5.4-pro` 报 *This is not a chat model*、`gpt-5-pro` 还额外说
 * *only supported in v1/responses*;换 `/v1/responses` 后同一批 4~8 秒正常回话。
 */
function requiresResponsesApi(endpoints: string[]): boolean {
  return endpoints.includes('openai-response') && !endpoints.includes('openai')
}

/** 词边界匹配,避免 `tts` 撞上 `attsomething` 这类子串误伤。 */
function hasWord(id: string, words: string[]): boolean {
  return words.some((w) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`).test(id))
}

/**
 * 按模型名兜底判类别 —— 这层不是锦上添花,是**主力**。
 *
 * 2026-08-12 拿真机账号打 `/v1/models` 量过:108 条里只有 **13 条**带 `model_type`、
 * 30 条带 `supported_endpoint_types`。也就是说 88% 的条目两条判据全落空,直接掉进末行
 * 「未知 → chat」,于是 `tts-1` / `whisper-1` / `dall-e-3` / `mj_imagine` / `kling-video` /
 * `suno_music_open` / `text-moderation-*` 全被当成对话模型列进选择器,占满第一屏。
 *
 * 这与技能文档里记的老坑是同一个:那次是「无脑截 `/v1/models` 前 40 个」拿到一堆
 * `tts-1` / `dall-e-3` / `davinci-002`,这次换成「全列出来让用户挑」,垃圾原封不动还在。
 * **病根一直是没按类别过滤,不是取的条数。**
 *
 * 只收无歧义的字样,宁可漏判也不误伤对话模型(漏判只是多一条噪音,误伤是用户选不到能用的模型)。
 */
function nonChatByName(id: string): ModelCategory | null {
  const s = id.toLowerCase()
  // 出图放在出视频前面:`kling-image` / `kling-omni-image` 与 `kling-video` 共用厂商前缀。
  if (hasWord(s, ['image', 'images', 'imagen']) || includesAny(s, ['dall-e', 'dalle', 'midjourney', 'mj_', 'stable-diffusion', 'flux', 'ideogram', 'recraft', 'kolors', 'seedream'])) {
    return 'image'
  }
  if (hasWord(s, ['video', 'sora', 'veo', 'kling', 'hailuo', 'vidu', 'luma', 'runway', 'pixverse']) || includesAny(s, ['seedance', 'wanx'])) {
    return 'video'
  }
  if (hasWord(s, ['tts', 'stt', 'whisper', 'audio', 'speech', 'voice', 'suno', 'realtime', 'music'])) {
    return 'audio'
  }
  // 审核端点与 GPT-3 时代的补全模型:都不是对话接口,列出来只会让用户白选一次。
  if (includesAny(s, ['moderation']) || hasWord(s, ['ada', 'curie', 'babbage', 'davinci'])) {
    return 'other'
  }
  return null
}

/**
 * 从 model_type + endpoints + tags 推导类别;三者都没给时按模型名兜底。
 *
 * **判据分三档,顺序不能调**,这个顺序是 2026-08-12 被真机打出来的:
 *
 * 1. `model_type` —— 云雾后台逐模型填的产出类型,最权威。它说是「对话」就到此为止。
 *    第一版没有这一档,`gemini-3-pro-preview`(`model_type: "对话"`,tags 含「音频」)
 *    当场被判成音频模型,而它正是我们的默认对话模型之一。
 * 2. `endpoints` —— 调用契约,次权威。
 * 3. `tags` / 模型名 —— 只在前两档都空时兜底。
 *
 * **tags 只认「产出」词,不认「能力」词。** 这是同一次翻车的另一半:tags 里的「音频」
 * 「多模态」说的是这个对话模型**能读**音频/图片,不是它**产出**音频。所以这里只收
 * 「文本转语音」「转录」「音乐」这类无歧义的产出语义。
 */
function deriveCategory(id: string, modelType: string, endpoints: string[], tags: string): ModelCategory {
  const mt = modelType || ''
  const eps = endpoints.join(',')

  // 第 0 档:名字里有无歧义的产出字样时,压过后台标的类型 —— 因为后台会标错。
  // 实测本地库里 `aigc-video-hailuo` 与 `kling-omni-video` 的 `model_type` 都写着「对话」,
  // 照它走这两个出视频模型就进了对话下拉框。和 `embeddingByName` 那层是同一个理由:
  // 治本在云雾后台把类型改对,这层只是防线。只收无歧义字样,所以不会误伤
  // `gemini-3-pro-preview` 这类「能读音频的对话模型」——它名字里没有那些字。
  const unambiguous = nonChatByName(id)
  if (unambiguous && unambiguous !== 'other') {
    return unambiguous
  }

  // 第 1 档:后台明确标了产出类型就照它,别让下面的启发式推翻。
  if (mt) {
    if (includesAny(mt, ['图像', '绘画', 'image'])) return 'image'
    if (includesAny(mt, ['视频', 'video'])) return 'video'
    if (includesAny(mt, ['音频', '语音', 'audio', 'tts', 'stt', '音乐'])) return 'audio'
    // 「检索」是云雾模型广场左侧那一档的原话,装的是 embedding + rerank(2026-08-14 查库 14 条)。
    // **漏了它就是老坑重演**:这一档本该在最权威的位置拦下,漏掉后 11 条靠 tags 的「嵌入」
    // 或名字里的 bge 侥幸兜住,而 `qwen3-rerank` / `Qwen/Qwen3-Reranker-0.6B` /
    // `netease-youdao/bce-reranker-base_v1` 两条都没兜住,一路掉到末行判成 chat,
    // 真机对话池里确实混进来了(它们上架状态正常,广场过滤也拦不住)。
    if (includesAny(mt, ['向量', 'embed', '检索'])) return 'embedding'
    if (includesAny(mt, ['对话', '文本', 'chat', 'text'])) return 'chat'
  }

  // 第 2 档:调用契约。`图生图`/`图生视频` 共享 `图生` 前缀,关键字必须写全 —— 只写
  // `图生` 会把 `kling-3.0-turbo`(eps 是「文生视频,图生视频」)判成出图模型。
  if (includesAny(eps, ['image-generation', '文生图', '图生图', '生图', '绘画', '扩图'])) {
    return 'image'
  }
  if (includesAny(eps, ['video', '视频'])) {
    return 'video'
  }
  if (includesAny(eps, ['tts', 'stt', 'audio', 'speech', '语音'])) {
    return 'audio'
  }
  if (includesAny(eps, ['embedding'])) {
    return 'embedding'
  }

  // 第 3 档:tags 的产出词 + 模型名。
  if (includesAny(tags, ['文生图', '图生图', '生图', '绘画'])) return 'image'
  if (includesAny(tags, ['文生视频', '图生视频', '视频'])) return 'video'
  if (includesAny(tags, ['文本转语音', '转录', '音乐'])) return 'audio'
  // 「重排」是 rerank 类的 tag(库里原话是「重排序」)。它和向量模型一样不能对话,
  // 归到同一档;留这条是给 model_type 缺失的情况兜底,不是替代第 1 档。
  if (includesAny(tags, ['向量', '嵌入', '重排'])) return 'embedding'
  if (embeddingByName(id)) return 'embedding'

  const byName = nonChatByName(id)
  if (byName) {
    return byName
  }
  // 文本 / 对话 / 未知 → 默认按对话模型处理。
  return 'chat'
}

/** 把一条原始模型条目推导为带能力的 ModelInfo。 */
export function deriveModelInfo(entry: RawModelEntry): ModelInfo | null {
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  if (!id) {
    return null
  }
  const tags = entry.tags ?? ''
  const modelType = entry.model_type ?? ''
  const endpoints = Array.isArray(entry.supported_endpoint_types) ? entry.supported_endpoint_types : []
  const category = deriveCategory(id, modelType, endpoints, tags)

  // 思考能力:家族表命中就照它(含"这一族没有思考"这种否定结论,平台会拒掉思考参数);
  // 没命中才回落到 tag 与名字。名字兜底不再要求 tags 为空 —— 真机快照里对话模型的 tags
  // 全都非空,那条前置条件等于把兜底关死了。与本文件 `search` 那档同一形状,理由见 searchByName。
  const profile = category === 'chat' ? thinkingProfile(id) : null
  const reasoning =
    category === 'chat' &&
    (profile?.reasoning ?? (includesAny(tags, ['思考', '推理']) || reasoningByName(id)))
  const thinking = reasoning && profile && profile.reasoning !== false ? profile : null
  const vision =
    category === 'chat' &&
    (includesAny(tags, ['识图', '视觉', '多模态', '图像分析']) || (tags === '' && visionByName(id)))
  const tools = category === 'chat' && (includesAny(tags, ['工具', '函数']) || tags === '')
  // 与上面三个不同:tag 命中或名字命中都算,不要求 tags 为空才走名字兜底。
  // 理由见 searchByName —— Gemini 系 tags 齐全却没有「联网」这一条,按老写法会被判成不能联网。
  const search =
    category === 'chat' && (includesAny(tags, ['联网', '搜索']) || searchByName(id))
  // 协议只对对话模型有意义:媒体那三档由插件自己发请求,不经内核的 provider 层。
  const api = category === 'chat' && requiresResponsesApi(endpoints) ? 'openai-responses' : undefined

  return {
    id,
    reasoning,
    vision,
    tools,
    search,
    category,
    ...(api ? { api } : {}),
    ...(thinking?.levels ? { thinkingLevels: thinking.levels } : {}),
    ...(thinking?.default ? { defaultThinkingLevel: thinking.default } : {}),
    ...(thinking?.canDisable === false ? { canDisableThinking: false } : {}),
    ...(reasoning && !effortAffirmed(thinking) ? { thinkingEffort: false } : {}),
    ...(thinking?.format ? { thinkingFormat: thinking.format } : {})
  }
}

/**
 * 用**当前**家族表校正一条已落盘模型的思考声明。
 *
 * 为什么需要它:能力字段是在用户勾选那一刻快照进磁盘的,此后代码里的表怎么改都不会回头
 * 改它。2026-08-16 实测撞上过:`deepseek-v4-flash` 已经修成"会思考",但本机
 * `openclaw.json` 里仍是 `reasoning:false` —— 因为盘上那份快照是老表推的,而启动对齐
 * (`syncAccountModels`)只比 id 集合,集合没变就直接返回。存量安装因此永远拿不到修复。
 *
 * 校正范围严格限定在家族表**明确表态**的字段:
 *  - 表里没有这个族(返回 null)→ 原样返回,标签推出来的结论不动;
 *  - 表里没对"会不会思考"表态(只声明了方言/不发档位)→ 保留原 `reasoning`;
 *  - 判成不思考 → 连带清掉档位与方言,避免留下自相矛盾的残留字段。
 *
 * **只用于内置 yunwu 供货商**。自定义供货商的能力是用户在表单里手填的,拿家族表盖掉
 * 等于替用户改他自己的设置(同名不同物的风险见 `docs/desktop-model-capability-profile-plan.md`
 * 里的 ProviderScope 一节)。
 */
export function alignThinkingCapability<
  T extends { id: string; category: ModelCategory; reasoning: boolean } & ThinkingCapability
>(m: T): T {
  if (m.category !== 'chat') {
    return m
  }
  const profile = thinkingProfile(m.id)
  if (!profile) {
    // 家族表不认识它:标签推出来的结论一律不动,但「没明说吃档位就别发 effort」这条兜底要落
    // (见 effortAffirmed)。盘上已有明确的 true 不推翻 —— 那只可能来自后台下发层,
    // 即有人实测过说吃,比家族表的沉默更有信息量。
    if (m.reasoning && m.thinkingEffort === undefined) {
      return { ...m, thinkingEffort: false }
    }
    return m
  }
  const reasoning = profile.reasoning ?? m.reasoning
  const next = { ...m, reasoning } as T & ThinkingCapability
  delete next.thinkingLevels
  delete next.defaultThinkingLevel
  delete next.canDisableThinking
  delete next.thinkingEffort
  delete next.thinkingFormat
  if (reasoning) {
    if (profile.levels) {
      next.thinkingLevels = profile.levels
    }
    if (profile.default) {
      next.defaultThinkingLevel = profile.default
    }
    if (profile.canDisable === false) {
      next.canDisableThinking = false
    }
    if (!effortAffirmed(profile)) {
      next.thinkingEffort = false
    }
    if (profile.format) {
      next.thinkingFormat = profile.format
    }
  }
  return next
}

/** 批量推导,过滤无效条目。 */
export function deriveModelInfos(entries: RawModelEntry[]): ModelInfo[] {
  const out: ModelInfo[] = []
  for (const e of entries) {
    const info = deriveModelInfo(e)
    if (info) {
      out.push(info)
    }
  }
  return out
}

/** 从模型 id 兜底推导能力(用于老配置迁移:仅有 id 字符串时)。 */
export function inferModelInfoFromId(id: string): ModelInfo {
  const category: ModelCategory = embeddingByName(id) ? 'embedding' : (nonChatByName(id) ?? 'chat')
  const profile = category === 'chat' ? thinkingProfile(id) : null
  const reasoning = category === 'chat' && (profile?.reasoning ?? reasoningByName(id))
  const thinking = reasoning && profile && profile.reasoning !== false ? profile : null
  return {
    id,
    reasoning,
    vision: category === 'chat' && visionByName(id),
    tools: category === 'chat',
    search: category === 'chat' && searchByName(id),
    category,
    ...(thinking?.levels ? { thinkingLevels: thinking.levels } : {}),
    ...(thinking?.default ? { defaultThinkingLevel: thinking.default } : {}),
    ...(thinking?.canDisable === false ? { canDisableThinking: false } : {}),
    ...(reasoning && !effortAffirmed(thinking) ? { thinkingEffort: false } : {}),
    ...(thinking?.format ? { thinkingFormat: thinking.format } : {})
  }
}
