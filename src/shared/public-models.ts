/**
 * 对话模型的**本地兜底**清单,以及出图模型的固定清单。
 *
 * ## 它在两层里的位置
 *
 * 对话模型只有两层(见 `docs/desktop-media-and-expert-capability-plan.md` 的 P5):
 *
 *  1. **用户自己选**——首次登录时从他 key 的可选池(`/v1/models`)里勾,之后在设置→模型页
 *     随时增删,按账号存进 `model-catalog.json`。
 *  2. **自定义模型**——别家厂商、自带 baseUrl 与独立 Key,原样保留。
 *
 * 这份常量**不是"推荐清单",没有服务端下发这回事**:桌面端每一次调用都记在用户自己的云雾
 * 余额上,由我们钦定一份清单既不省他的钱、也不代表他的 key 真调得通;下发只在有公共额度的
 * 产品里才成立。它的两个用途都是本地的:首启选择器拿它做**预勾选**(且只勾在可选池里真实
 * 存在的),以及该账号还没选过时的临时清单。改它不影响任何已经选过的用户。
 *
 * ## 为什么不是「按 key 拉一份就落盘」
 *
 * 最早的做法是登录后打 `/v1/models`、把该令牌能访问的模型**截前 40 个**落盘。
 * 2026-08-10 把那 40 个打印出来才看清它是什么:`tts-1`、`dall-e-3`、`text-ada-001`、
 * `davinci-002`、`gpt-4-32k`、一堆 `doubao-seedance` 视频模型 —— 就是接口返回顺序的前 40 个,
 * **一个都没挑过**。病根是「截前 N 个」这个动作,不是「按 key 拉」这件事本身:
 * 接口如今自带 `model_type` 与 `tags`(2026-08-12 复核:485 个模型里对话类 263 个、tag 覆盖良好),
 * 拿它做可选池是准的,只是不能不加挑选地直接当清单。
 *
 * ## 选定即固化:清单是用户数据,不是 key 的函数
 *
 * 真栽过一次:照单全收把配置从 30KB 推到 124KB,**换账号时新配置 29KB 不到旧的一半,被内核的
 * 体积骤降保护拒写,人卡在登录页看一句 `Config write rejected`**。根因不是"模型多",是清单
 * 随外部输入整份重算。所以定死:`/v1/models` 只提供**可选池**,清单只在用户主动保存时才变;
 * 清单按账号分别存(`model-catalog.ts`),模型下架或调不通只标灰提示、不自动删。
 *
 * ## 形状照 WorkBuddy(但对话那层刻意不跟)
 *
 * WorkBuddy 的内核配置(`%USERPROFILE%\.workbuddy\settings.json`)里一个模型都没有:
 * 官方模型是它远端 `/v3/config` 下发的、用户看不见也改不了,用户自定义模型另存 `models.json`
 * (设置页标题就叫「自定义模型」)。**我们刻意不跟这一层**:它的官方模型是腾讯自家掏钱、用户
 * 不为此付费,所以由产品方钦定才说得通;我们这份花的是用户自己账户的余额,他的 key 本来就
 * 够得着 263 个对话模型,凭什么由我们替他挑四个。判据始终是结果,照抄会得到更差的结果。
 *
 * ## 为什么配置里不能像 WorkBuddy 那样一个模型都不写
 *
 * 被内核逼的,别再试一遍:
 *
 *  1. 它的 agent 运行时在同进程,模型记录调用时递过去即可;我们的内核是另一个进程,
 *     模型注册表由 `discoverModels` 从 `<agentDir>/models.json` 读,而那份文件是
 *     `prepareOpenClawModelsJsonSource(config, ...)` **从 openclaw.json 派生**的,
 *     绕过配置直接写会被下一次派生覆盖。
 *  2. 自定义供货商 id 被 schema 强制要求枚举模型:`ModelProvidersSchema` 的 superRefine
 *     里,非内置 overlay 的 id 缺 `models` 直接判
 *     "custom model providers must declare models"。`yunwu` 不在那份内置白名单里。
 *  3. 换成白名单里的 overlay id(如 `litellm`)确实可以不声明模型,但**那样一个对话模型
 *     都没有**。隔离配置目录实测过:只写 baseUrl + apiKey 的 litellm,
 *     `infer model list` 里它的条目数为 0,指定 `litellm/claude-opus-4-6` 报
 *     `Model not found`。出图能透传是因为图像接口把模型 id 直接发给端点,不过模型注册表。
 *
 * ## 清单长短的成本:两条都不是你以为的那样
 *
 *  - **模型多不会拖慢启动。** 冷启动 provider auth 预热的成本 ≈ agent 数 × 供货商数
 *    (`agents/model-provider-auth.ts:309-394`),与模型数无关;实测把模型 40 → 7 之后预热
 *    反而更慢(49.5s vs 19.8~25.1s)。热加载也不逐个模型走网络:`refreshContextWindowCache`
 *    清缓存后只调**一次** `loadModelCatalog`(`agents/context.ts:246-251, 212-214`)。
 *  - **模型少才有风险,而且判据是字节不是个数。** 内核有配置体积骤降保护
 *    (`src/config/io.ts:516-522`:`previousBytes >= 512 && nextBytes < floor(previousBytes * 0.5)`
 *    就整批拒写,网关侧从不传 `allowConfigSizeDrop`),报出来是一句和模型毫无关系的
 *    `Config write rejected`。带 reasoning/compat 的条目约 366 字节、普通对话模型约 190 字节,
 *    所以"删几个会撞线"随用户选了哪些模型而变。**这件事已由 `config-writer.ts` 的
 *    `setConfigBatchStepwise` 在写之前自己算比值、按需拆批接住,改这份清单时不必再心算。**
 */

import type { ModelInfo } from './types'

/**
 * 出图模型的**预勾选**清单。顺序即 primary → fallbacks。
 *
 * 曾经这是「用户改不了的固定三个」,原因是被内核逼的:litellm 槽位的请求体写死
 * `{model,prompt,n,size}`、不发 `response_format`,而内核的响应解析只读 `b64_json` ——
 * 于是默认返 url 的 seedream / qwen-image 一律报 "response malformed"。
 * 2026-08-13 起出图改走自研插件的 `yunwu-image` provider(自己发 `response_format`、
 * 回 url 就下载),这个限制没了,候选变成这把 key 的全部 OpenAI 兼容出图模型,由用户自己选。
 * 2026-08-17 实测 29 个:专用出图端点 23 + 只在对话端点上出图的 Gemini 图像族 6
 * (见 `media-endpoints.ts:isChatImageModel`)。
 *
 * 于是这份常量退成两个本地用途,和 `PUBLIC_CHAT_MODELS` 同一性质:首启的预勾选(且只勾
 * 池子里真实存在的),以及该账号还没选过时的临时清单。
 *
 * 顺序照内核自己的默认排(litellm 的 DEFAULT_LITELLM_IMAGE_MODEL 也是 gpt-image-2),
 * 实测它也最快(25 秒)。**三个都留着**当候选:`/v1/models` 列出来不等于有渠道能接 ——
 * 同一个 gpt-image-2、同一个域名,用分组不全的 token 稳定回 429「当前分组上游负载已饱和」,
 * 换全分组 token 就 200。这是 key 的属性、不是模型的属性,客户端无从预判,
 * 只能靠内核逐个 candidate 试。
 */
export const IMAGE_MODEL_PREFERENCE = ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1']

/**
 * 视频模型的预勾选。`veo_3_1-fast` 是端到端验过的那条(约 30~98 秒出片)。
 *
 * 只给一个:视频比出图贵得多,预勾一串 fallback 等于在用户没要求时替他多试几家。
 * 插件现在认领 15 个模型,想用别家在选择器里自己勾。
 */
export const VIDEO_MODEL_PREFERENCE = ['veo_3_1-fast']

/**
 * 语音合成的预选。内核 TTS 只吃**一个**模型字段
 * (`messages.tts.providers.openai.model`,没有 fallbacks),所以这里是单值不是清单。
 *
 * `tts-1` 是六种 response_format 全验通的那条(2026-08-13,含语音条用的 opus
 * 与电话通道用的 pcm)。
 */
export const AUDIO_MODEL_PREFERENCE = 'tts-1'

/**
 * 本地兜底的对话模型清单。**顺序即优先级,第一条是兜底的默认模型。**
 *
 * 两个用途,都不是"推荐":
 *  1. 首启选择器的**预勾选来源** —— 且只勾**在用户可选池里真实存在**的那些
 *     (`model-catalog.ts:presetSelection`)。预勾一个他调不通的模型,等于让他一进主界面
 *     第一句话就吃 404;一个都没命中就不勾,让他自己挑。
 *  2. 该账号还没选过时的临时清单(启动对齐要有东西可写)。
 *
 * 用户一旦选过,这份就再也不参与——改它不影响任何已经选过的人。
 *
 * 挑选口径:能力覆盖(推理 / 识图 / 工具 / 联网)优先,同档取快取省,数量压到个位数。
 * 能力标记由我们自己声明而不是从 `/v1/models` 的 tags 推 —— 这份是**离线兜底**,
 * 不能依赖一次网络请求才知道自己长什么样。
 */
export const PUBLIC_CHAT_MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-6', reasoning: true, vision: true, tools: true, search: false, category: 'chat' },
  // search 为真的这条不是凑数:2026-08-14 实测它带 googleSearch 工具能答对中文时事
  // (25~31 秒,慢但准)。默认清单里有一条能联网的,意味着开箱即有 web_search 后端。
  { id: 'gemini-3-pro-preview', reasoning: true, vision: true, tools: true, search: true, category: 'chat' },
  { id: 'gpt-4o-2024-08-06', reasoning: false, vision: true, tools: true, search: false, category: 'chat' },
  { id: 'deepseek-v4-flash', reasoning: false, vision: false, tools: true, search: false, category: 'chat' }
]

/**
 * `web_search` 的**兜底后端**:用户选的对话模型里一个带联网标记的都没有时才用这份。
 *
 * 为什么要有这份而不是「没有就关掉搜索」:搜索是专家查资料的基础能力,用户挑对话模型时
 * 想的是「谁答得好」,不会去想「谁能联网」。一个都没选中带联网的就静默失去查资料能力,
 * 对用户是莫名其妙的能力缺失。
 *
 * 顺序即优先级,按 2026-08-14 真机实测排(问「2026 年 8 月 13 日上证指数收盘」,
 * 正确答案 3926.96,全部走 googleSearch grounding):
 *
 * | 模型 | 实测 | 倍率 | 一次搜索账单 |
 * |---|---|---|---|
 * | `gemini-2.5-flash` | 2.8 秒答对,带新浪/东财来源链接 | 0.15 | 523 quota |
 * | `gemini-3.1-flash-lite` | 2.6 秒答对 | 0.125 | 同档 |
 * | `gemini-3-flash-preview` | 4.3 秒答对 | 0.25 | 同档 |
 *
 * **这三条都在模型广场上架**(判据见 `references/platform-data.md`),这是硬要求:
 * 广场上看得见的才是配好价格、正式给用户用的。曾经用过 `deepseek-v3-search`,它能调通
 * 也便宜,但 `-search` 是平台的能力后缀、会被归一化剥掉,广场里根本不存在这个名字。
 *
 * 没放 OpenAI 那族(`gpt-4o-mini-search-preview` 等):实测中文问国内时事拿到的是**去年
 * 同日**的数据 —— 这是模型自身的检索覆盖问题,所以不做默认。它们仍留在池子里供用户自己选。
 *
 * **排序理由里不掺渠道状况**(限流、上游报模型不存在之类):那是中转站侧的事,会变,
 * 而且中转站修好了我们自然就能用。我们只按「模型自身答得怎么样」和「广场上有没有」选。
 */
export const SEARCH_FALLBACK_MODELS = [
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview'
]

/**
 * 兜底的落盘清单。**只有对话模型**。
 *
 * 这里曾经还挂着三个写死的出图模型条目,因为老的出图接线走内核 `litellm` 槽位、
 * `resolveImageGeneration` 是按 id 在供货商的 models 里找它们的。2026-08-13 出图改由
 * 自研插件的 `yunwu-image` provider 接(插件自己认领模型、凭证读 `models.providers.yunwu`),
 * 那条依赖没了 —— 与视频从一开始就是同一个形状(视频模型也从不进这份清单)。
 *
 * 顺带消掉一类隐患:媒体模型不再需要「留在落盘清单里但不能进对话下拉框」这种双重要求,
 * 也就不存在漏标 category 就污染对话下拉框的路径。
 */
export const PUBLIC_MODELS: ModelInfo[] = PUBLIC_CHAT_MODELS

/** 兜底的开箱默认对话模型。 */
export const PUBLIC_DEFAULT_MODEL = PUBLIC_CHAT_MODELS[0].id
