/**
 * 云雾媒体生成 provider 插件:视频(`video_generate`)+ 出图(`image_generate`)。
 *
 * 插件 id 仍是 `yunwu-video`(历史原因,改 id 要迁移已安装的扩展目录,不值得);
 * 里面注册两个 provider:`yunwu-video` 与 `yunwu-image`,manifest 的 `contracts` 各声明一条,
 * 网关按 provider id 找插件就是查那份声明(`plugins/gateway-startup-plugin-ids.ts:1273`)。
 *
 * # 为什么自己写,不复用内核 openai 视频 provider
 *
 * 2026-08-13 实测三条:
 *  1. 劫持 `models.providers.openai.baseUrl` 指向云雾会污染对话模型目录(多出 16 个 openai 模型);
 *  2. 内核 openai 视频 provider 走 `GET /v1/videos/{id}/content` 取件,云雾对该路径恒 403
 *     (中转层 `openai_veo` 任务不落 S3,回落直连上游被端口策略拒);
 *  3. 云雾统一异步接口 `POST /v1/video/create` + `GET /v1/video/query` 全程通,响应直接给
 *     可下载的 `video_url`。
 *
 * 所以自己接,不碰 openai 槽位:统一异步接口一个适配器,厂商专属接口各一个
 * (现有可灵 v1、可灵 3.0 turbo、Vidu、海螺、PixVerse、百炼、grok)。
 * 形状照 `openclaw/extensions/vydra/video-generation-provider.ts`
 * (提交 → 轮询 → 拿 url → 下载 → 回 buffer),实现故意用 plain fetch —— 与同目录的
 * `yunwu-persona` 同约束:入口会被内核转成 CommonJS,顶层 await / 复杂 SDK 别名都容易
 * 静默加载失败(只写网关日志、对客户端完全静默)。
 *
 * # 凭证从哪来
 *
 * 读 `models.providers.yunwu` 的 baseUrl + apiKey(登录时已写入)。provider id 用
 * `yunwu-video` 而不是 `yunwu`,避免跟对话供货商的模型目录搅在一起 ——
 * `agents.defaults.videoGenerationModel.primary` 写成 `yunwu-video/veo_3_1-fast`。
 *
 * # 适配器扩展点
 *
 * 厂商私有协议(可灵 / Vidu / PixVerse / 百炼 / 海螺)各有专属入口,中转层在
 * `middleware/video_model_guard.go` 明确拒收通用接口。骨架共用,每家只要补三个函数:
 * 拼提交体、解析轮询体、取 url。见下方 `ADAPTERS`。
 *
 * **归属判据由适配器自己声明**(`endpointTypes`),不由骨架写死。所以新接一家只动它自己那个对象:
 * 它的模型会自动出现在 live 目录里,也自动从「还没接这一家」的报错里消失。
 *
 * 每家的调用契约都以**库里 `models.endpoints` 字段**为准(逐模型的 path + method),
 * 那是平台自己维护的那份,比文档新。中转层的路由注册在 `router/relay-router.go`。
 *
 * # 模型清单不写死:按端点类型现拉现判
 *
 * 第一版把 8 个模型 id 写成常量,于是上游上新要发版、下架了还照样列着。改成从
 * `/v1/models` 现拉,按 `supported_endpoint_types` 判归属 —— 判据本身才是稳定的那一层。
 * 静态那份只留作**离线兜底**(拉不到目录时至少验过的几条还能跑)。
 *
 * # 出图为什么也走这里,而不是内核的 litellm 槽位
 *
 * litellm 槽位的请求体是写死的 `{model,prompt,n,size}`
 * (`extensions/litellm/image-generation-provider.ts:116-124`),**不发 `response_format`**;
 * 而内核的响应解析只读 `b64_json`(`image-generation/image-assets.ts:184`)。于是默认返 url
 * 的模型一律报 "response malformed" —— 这就是出图长期只能用 gpt-image 那三个的原因。
 *
 * 2026-08-13 逐族实测(海外站):补上 `response_format: 'b64_json'` 之后 `gpt-image-2`、
 * `doubao-seedream-4-0-250828`、`grok-imagine-image` 都返 b64;但 `qwen-image-3.0` 与
 * `z-image-turbo` **照样返 url**。两种都存在,所以内核那个只认 b64 的工厂
 * (`createOpenAiCompatibleImageGenerationProvider`)也不够用 —— 这里自己发请求、
 * 两种响应都吃(url 就下载),23 个出图模型才都能用(2026-08-13 是 21 个,上游上新自动进来的)。
 *
 * 出图还有**第二条路**:Gemini 图像族在云雾这儿只开了对话端点,图以 markdown data URI
 * 回在助手正文里。判据 `isChatImageModel`、请求 `postChatImage`、解析 `chatImageAssetsFrom`,
 * 2026-08-17 文生 + 改图各真机验过一发。
 *
 * **第三条路是厂商专属的异步出图**(MJ / 可灵):提交拿 task id → 轮询 → 取 url → 下载,
 * 与视频那侧同一个骨架,也是一家一个适配器(`IMAGE_ASYNC_ADAPTERS`)。它们不能混进前两条:
 * 路径在站点根、请求体各不相同、`n` 与 `size` 的对应物也各不相同。
 */

const PROVIDER_ID = 'yunwu-video'
const IMAGE_PROVIDER_ID = 'yunwu-image'
const CHAT_PROVIDER_ID = 'yunwu'
const DEFAULT_MODEL = 'veo_3_1-fast'
const DEFAULT_TIMEOUT_MS = 600_000
const POLL_INTERVAL_MS = 5_000
const MAX_POLL_ATTEMPTS = 120
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024
/** 目录缓存有效期。判据是「上游增删模型」这种事的时间尺度,分钟级足够。 */
const CATALOG_TTL_MS = 5 * 60_000
const CATALOG_TIMEOUT_MS = 15_000

/**
 * 吃统一异步接口(`/v1/video/create`)的端点类型。**这三个字符串是判据,模型 id 不是。**
 *
 * 2026-08-13 拿 yw_zhoucongjie 的 auto 令牌真机读 `/v1/models`(476 条)得到的分布:
 *   `OpenAI video format`   3 → veo_3_1 / -fast / -components
 *   `Doubao video (Async)`  3 → doubao-seedance-1-0-pro-250528 / -1-0-pro-fast-251015 / -1-5-pro-251215
 *   `Doubao video`          2 → doubao-seedance-2-0-260128 / -2-0-fast-260128
 * 这三类的全集正好等于原来写死的那 8 条,所以换成 live 过滤不改变今天的行为,
 * 只是把「上游上新 / 下架」交给上游自己说。
 *
 * 其余视频模型都带自家专属端点类型(`Text to video` 可灵、`Vidu * to video`、`Pix *`、
 * `Wan video generation`、`Hailuo video generation`、`Happyhorse video`、`官方格式` grok),
 * 中转层 `middleware/video_model_guard.go` 会明确拒收通用接口 —— 那些各归各自的适配器,
 * 不能混进这里。各家的图生 / 首尾帧 / 参考生到 2026-08-17 已经接齐;还没接的是「另一档能力」
 * (视频续写、特效、数字人、对口型、多主体、视频编辑),它们照旧落在 `pickAdapter` 那句
 * 「还没接这一家」的报错里。
 */
const UNIFIED_ENDPOINT_TYPES = new Set([
  'OpenAI video format',
  'Doubao video',
  'Doubao video (Async)',
  // 下面两个是 2026-08-17 补的,判据全在平台源码里,不是猜的:
  //  - 库里这两类的 `endpoints.path` 写的就是 `/v1/video/create`(海外站 `models` 表,
  //    `Unified video format` 23 条 = veo2 / veo3 / veo3.1 全家 + sora-2-pro + omni-flash-*,
  //    `Grok video` 3 条 = grok-video-3 / -10s / -15s);
  //  - 这条入口的适配器本来就是「VEO + Sora2 + Grok-Video 三家共用」
  //    (`relay/channel/task/unified_video/adaptor.go:23`、`:43-94`);
  //  - 入口封堵名单里只有可灵 / Vidu / PixVerse / 百炼 / MiniMax / 腾讯 六家
  //    (`middleware/video_model_guard.go:60-65`),这两类一条都不在里面。
  // 换句话说它们与原来那三类是**同一条路**,只是平台又起了两个类型名 —— 正是「按类型名筛」
  // 这个判据要覆盖的情形:接一家就把它的名字加进来,别的一行都不用动。
  'Unified video format',
  'Grok video'
])

/**
 * 只有**真出过片**的模型才在这里声明时长。
 *
 * 这条是刻意的:内核对已声明的时长会「吸附到最近的合法值」(`duration-support.ts:39`),
 * 照文档瞎填等于把用户的合法请求改成一个上游会拒的值 —— 比不填更糟。不填不会被拦,
 * 内核把校验推迟到运行时、原样透传。
 *
 * `veo_3_1-fast` 端到端出片且 `detail.input` 回显 4/6/8,同族两个按同参数族推定。
 * 豆包 5 个一次都没成功过(3 个「未找到价格配置」HTTP 429、2 个「上游负载已饱和」HTTP 404),
 * 都不是协议问题,平台补价格配置即通 —— 挂着但不声明参数,真出过片再往这里补。
 */
const UNIFIED_DURATIONS = {
  veo_3_1: [4, 6, 8],
  'veo_3_1-fast': [4, 6, 8],
  'veo_3_1-components': [4, 6, 8],
  // sora 这两条不是实测,是**平台明写的白名单**(`relay_tasks/sora/duration_validate.go:24-45`,
  // 与 `/v1/videos` 共用同一份):不声明的话内核会把用户那个 5 秒原样发过去,提交就被 400。
  // 这与「没验过不声明」不冲突 —— 那条防的是照文档瞎猜,这里的合法集是源码里写死的。
  'sora-2': [4, 8, 12],
  'sora-2-pro': [4, 8, 12]
}

/**
 * sora 在统一入口上**必须带 `size`**,缺了在适配器第一道就被拒
 * (`unified_video/adaptor.go:76-83`:`size is required for sora-2`)。
 *
 * 合法值是平台自己那四个常量(`relay_tasks/sora/handler.go:66-71`),按朝向分两档;
 * 我们这条链路上没有让用户挑清晰度的地方,所以固定给 720p 那一档 —— 与百炼显式发 720P
 * 同一个口径(便宜、快、够用),朝向则跟着用户给的比例走。
 */
const SORA_SIZE_BY_ORIENTATION = { landscape: '1280x720', portrait: '720x1280' }

/**
 * 离线兜底清单。**只在 `/v1/models` 拉不到时才用**(断网、key 失效、站点抖动)。
 *
 * 也顺带当 `provider.models` 的静态种子:provider 定义是注册时同步构造的,拿不到
 * 网络结果,而这个字段的唯一用途是把裸模型名解析到本 provider
 * (`capability-model-ref.ts:51-64`) —— 给个种子比空着好,给错也不会拦住谁:
 * 内核对 `provider/model` 形式只校验 provider 存不存在,模型名一个字都不比
 * (`capability-model-ref.ts:78-87`)。
 */
const UNIFIED_FALLBACK_MODELS = [
  'veo_3_1',
  'veo_3_1-fast',
  'veo_3_1-components',
  'doubao-seedance-1-0-pro-250528',
  'doubao-seedance-1-0-pro-fast-251015',
  'doubao-seedance-1-5-pro-251215',
  'doubao-seedance-2-0-260128',
  'doubao-seedance-2-0-fast-260128',
  // `Unified video format` / `Grok video` 这两类的代表(2026-08-17 补)。种子只影响
  // 「目录拉不到时还能跑哪几条」,给多给少都不改变在线行为。
  'veo3.1',
  'veo3.1-fast',
  'veo3-fast',
  // 只有 `sora-2-pro` 同时挂着 `Unified video format`;裸 `sora-2` 在库里**只有**
  // `OpenAI official video format`,所以它归 soraAdapter,不在这份清单里。
  'sora-2-pro',
  'grok-video-3'
]

/**
 * 可灵 v1 的端点类型:一个模型 id(`kling-video`)三条路径。
 *
 * 文生那条从 2026-08-13 起就在跑;图生那条其实一直能用(`submit` 里给了图就换 action),
 * 但类型名到 2026-08-17 才补上 —— 之前靠 `Text to video` 蹭进池子,类型清单里是缺的。
 * 多图参考那条是新接的,它与前两条最大的差别是**上游版本号不同**(见下面的常量)。
 *
 * `kling-3.0-turbo` 的两个类型(`3.0turbo-文生视频` / `3.0turbo-图生视频`)**不在这里**:
 * 它路径不含 `/v1/`(`/kling/text-to-video/kling-3.0-turbo`),中转层也刻意不解析扁平
 * KlingRequest(`middleware/distributor.go:850-856`),请求体与响应体都是另一套 ——
 * 归 `klingTurboAdapter`,见那边。
 */
const KLING_MULTI_IMAGE_TYPE = 'Multi-image reference to video'
const KLING_ENDPOINT_TYPES = new Set(['Text to video', 'Image to video', KLING_MULTI_IMAGE_TYPE])

/** 提交时用过的 action 才允许拿去查询,别让 submitContext 里的脏值拼出一条不存在的路径。 */
const KLING_POLL_ACTIONS = new Set(['text2video', 'image2video', 'multi-image2video'])

/**
 * 多图参考那条**只收这一个上游版本号**,填别的会被平台本地拒
 * (`relay/channel/task/kling/adaptor.go:1165-1173`,连 distributor 也按它选渠道:
 * `middleware/distributor.go:934-935`)。所以它不能跟单图那条共用 `KLING_UPSTREAM_MODEL`。
 */
const KLING_MULTI_IMAGE_UPSTREAM_MODEL = 'kling-v1-6'

/**
 * 透传给上游的可灵版本号。**与内部模型名(`kling-video`)是两回事**:
 * 内部名由 URL 路径推出、只用来选渠道(`middleware/distributor.go:977-1034`),
 * 这个字段原样转给上游并参与计价(同文件 917-963,视频路由不传时默认就是 `kling-v1`)。
 *
 * 写成显式的 `kling-v1` 而不是靠平台默认:这是真出过片的那个值(见 klingAdapter 注释),
 * 平台以后改默认值也不会把我们的行为一起改掉。想让用户选 v2 系列是另一件事 ——
 * `/v1/models` 里只有 `kling-video` 一条,版本号没有对应的目录项,得另加旋钮。
 */
const KLING_UPSTREAM_MODEL = 'kling-v1'

/** 可灵只有 std / pro 两档,std 是中转层的默认值,也是验过的那档。 */
const KLING_MODE = 'std'

/**
 * 时长:5 与 10 两个合法值(`dto/kling.go:22` 明写「仅支持 5 或 10」)。5 端到端出过片;
 * 10 只有契约没有实测,但声明它是**安全方向**——内核会把 8 秒这类请求吸附到 10,
 * 不声明反而会把 8 原样发给上游被拒。
 */
const KLING_DURATIONS = { 'kling-video': [5, 10] }

/**
 * Vidu 四条路径的端点类型(2026-08-17 从只认文生扩到全部四条)。
 *
 * 字符串是从库里逐字取的(海外站 `models` 表,`JSON_KEYS(endpoints)`),不是照文档抄的 ——
 * `first & last frame` 中间那个 `&` 抄错一个字符就整族认领不到。
 *
 * **Vidu 与别家不同:模式差异不在模型名里,而在这几个类型名里**,同一批模型各认领不同子集:
 *   viduq1        text + img + start-end + ref     viduq3-turbo  text + img + start-end
 *   viduq3-pro    text + img                       viduq2        text + ref(+ 出图)
 *   viduq1-classic / viduq2-turbo   img + start-end(**不能文生**)
 *   vidu2.0       img + start-end + ref(**不能文生**)
 *   viduq2-pro / viduq3 / viduq3-mix   只有 ref(**不能文生**,ref 也强制要图或主体,
 *                                      `relay/channel/task/vidu/adaptor.go:91-94`)
 * 所以选路只能按**这个模型认领了哪几条**来判,不能按名字猜 —— 适配器的 `submit` 因此收
 * `endpointTypes`(骨架从目录里带过来的那份)。
 *
 * `Vidu image generation`(viduq2 的出图)与 `Vidu speech synthesis`(vidu-tts)不在这里:
 * 那是另外两个能力档,不归视频 provider。
 */
const VIDU_ENDPOINT_TYPES = new Set([
  'Vidu text to video',
  'Vidu image to video',
  'Vidu first & last frame',
  'Vidu reference to video'
])

/** Vidu 各模式对应的路径段(`router/relay-router.go:470-477`)。 */
const VIDU_PATHS = {
  text: 'text2video',
  image: 'img2video',
  startEnd: 'start-end2video',
  reference: 'reference2video'
}

/**
 * Vidu 逐模型时长。只写有**明确契约**的两个(`dto/vidu.go:53-56`):
 * `viduq1` 只支持 5,`viduq2` 是 1~10 的整数区间。
 *
 * q3 两个刻意不写:实测只验过 5 秒,写成 `[5]` 会把 8 秒请求吸附到 5(悄悄砍掉用户意图),
 * 写成猜的区间又可能放过上游不收的值。不声明 = 原样透传 + 由上游校验,是这里唯一诚实的选项。
 */
const VIDU_DURATIONS = {
  viduq1: [5],
  viduq2: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
}

/**
 * 海螺(MiniMax)的端点类型。**一个类型带全部模式**:文生 / 图生 / 首尾帧 / 主体参考都是
 * 同一条 `/minimax/v1/video_generation`,靠请求体里有没有 `first_frame_image` /
 * `last_frame_image` / `subject_reference` 区分(`dto/minimax.go:16-29`)——
 * 与 Vidu 那种「一个模式一个类型名」正好相反,所以这里只有一个字符串。
 */
const HAILUO_ENDPOINT_TYPES = new Set(['Hailuo video generation'])

/**
 * 可灵 3.0 turbo 的分辨率。只收 720p / 1080p(`dto/kling_v30_turbo.go:20`),
 * 720p 是平台的默认值也是验过的那档;我们这条链路上没有让用户选分辨率的地方。
 */
const KLING_TURBO_RESOLUTION = '720p'

/** 可灵 3.0 turbo 的图生那条端点类型名(与文生是**两条独立路由**,不是同一条的两种叫法)。 */
const KLING_TURBO_IMAGE_TYPE = '3.0turbo-图生视频'
const KLING_TURBO_ENDPOINT_TYPES = new Set(['3.0turbo-文生视频', KLING_TURBO_IMAGE_TYPE])

/**
 * PixVerse 请求体里的上游版本号。**与目录 id(`pixverse-video`)是两回事**:
 * 选渠道的内部名由路径推出(`pathToInternalModel`),这个字段是给上游的真实模型
 * (白名单 `c1`/`v6`/`v5.6`/`v5.5`/`v5`/`v4.5`/`v4`/`v3.5`)。写成显式的 `v5` ——
 * 那是真出过片的那档;想让用户选版本是另一件事,`/v1/models` 里只有 `pixverse-video` 一条。
 */
const PIXVERSE_UPSTREAM_MODEL = 'v5'

/** PixVerse 的画质档(必填)。360p/540p/720p/1080p,720p 是验过的那档。 */
const PIXVERSE_QUALITY = '720p'

/**
 * PixVerse 的三条出片路径。名字从库里逐字取(海外站 `models` 表,`pixverse-video` 一条模型
 * 挂着五个类型),另外两个 —— `Pix extend video`(给已有视频续写)与
 * `Pix multi-subject (multi-reference)`(多主体)—— 是另一档能力,内核 `video_generate`
 * 没有对应模式,**故意不认领**。
 */
const PIXVERSE_IMAGE_TYPE = 'Pix image to video / video template'
const PIXVERSE_FIRST_LAST_TYPE = 'Pix first & last frame'
const PIXVERSE_ENDPOINT_TYPES = new Set([
  'Pix text to video',
  PIXVERSE_IMAGE_TYPE,
  PIXVERSE_FIRST_LAST_TYPE
])

/** 上传那条被平台卡住时补给用户的一句话,理由见 `pixverseUploadImage` 的注释。 */
const PIXVERSE_UPLOAD_HINT =
  '。PixVerse 的参考图要先过它自己的上传接口,而那条接口在平台侧是**独立一类渠道**' +
  '(`pixverse-upload`),当前令牌的分组够不着 —— 这不是图的问题,换一个视频模型即可;' +
  '它的文生视频是好的。'

/** PixVerse 的任务状态码 → 可读名(`dto/pixverse.go:18-24`)。1 之外都不是成功。 */
const PIXVERSE_STATUS = {
  1: 'succeeded',
  5: 'generating',
  6: 'deleted',
  7: 'moderation_failed',
  8: 'failed'
}

/**
 * 百炼的分辨率档。不填时 dto 会补成 1080P(`dto/ali/bailian/bailian.go:234-238`),
 * 那档更贵更慢(实测 162s/8.56MB vs 720P 的 104s/4.75MB),所以显式发 720P。
 */
const BAILIAN_RESOLUTION = '720P'

/** Grok 视频的分辨率(必填)。只收 480p / 720p,1080p 被平台明确拦掉。 */
const GROK_RESOLUTION = '720p'

/**
 * 海螺逐模型时长:**实测出来的** 6 与 10。
 * 2026-08-13 各提交一发:`duration=7` 与 `duration=4` 都被拒(`invalid duration: 7`),
 * 6 与 10 都收。所以这是完整合法集,声明它能把 8 秒这类请求吸附到 10 而不是原样被拒。
 */
const HAILUO_DURATIONS = {
  'MiniMax-Hailuo-02': [6, 10],
  'MiniMax-Hailuo-2.3': [6, 10],
  'MiniMax-Hailuo-2.3-Fast': [6, 10]
}

/**
 * 宽高比只声明 veo 与可灵都吃的两档。
 *
 * 可灵还支持 `1:1`,但**不能加进来**:内核这个列表是 mode 级的、且对宽高比同样做
 * 「吸附到最近值」(`src/video-generation/normalization.ts:106-125`),而视频能力**没有**
 * 逐模型的宽高比字段(`capabilities.ts:57-84` 只对 maxInputImages/Videos/Audios 做逐模型收窄)。
 * 加了 `1:1` 等于把 veo 的 1:1 请求也放过去撞上游。加进来的代价是所有模型共担,
 * 少一档的代价只是可灵的 1:1 被吸附成 16:9 —— 后者是可降级的。
 */
const ASPECT_RATIOS = ['16:9', '9:16']

/** 默认出图模型。照内核 litellm 槽位的默认值排(`DEFAULT_LITELLM_IMAGE_MODEL` 也是它),实测最快的一档。 */
const IMAGE_DEFAULT_MODEL = 'gpt-image-2'

/** 出图超时。实测云雾出一张 1024×1024 的 seedream 要 12~49 秒,gpt-image-2 约 25 秒。 */
const IMAGE_TIMEOUT_MS = 300_000

/**
 * 走 OpenAI 兼容 `/v1/images/generations` 的端点类型。**这几个字符串是判据,模型 id 不是。**
 *
 * 2026-08-13 真机读 `/v1/models`(477 条)的分布:`image-generation` 12、
 * `images-generations` 4、`dall-e-3` 4、`openai-绘图` 1 —— 共 21 个模型,路径都是同一条。
 * 类型名在平台侧不统一(同一条路径四个名字),但按类型名筛仍比按模型名写死稳:
 * 上新的模型会复用同样的类型名。
 *
 * 不认的例子:`viduq2` 的 `Vidu image generation`(`/ent/v2/reference2image`)、
 * `pixverse-image-template`。它们都带「绘画」tag,但在各自的专属**异步**路径上,
 * 混进这个同步清单就是给用户一个必然失败的选项。
 * MJ 与可灵原来也在这份「不认」名单里,2026-08-17 各给了适配器,归 `IMAGE_ASYNC_ADAPTERS`。
 */
const IMAGE_ENDPOINT_TYPES = new Set([
  'image-generation',
  'images-generations',
  'dall-e-3',
  'openai-绘图'
])

/**
 * 走 `/v1/images/edits` 的端点类型(图生图 / 局部重绘)。同一模型可能只有出图没有编辑。
 *
 * `image-edit` 是 2026-08-17 补的:`grok-imagine-image-2.0` 与 `-quality` 的 `endpoints`
 * 里写着 `{"image-edit":{"path":"/v1/images/edits"}}`,与前三个名字**是同一条路径**。
 */
const IMAGE_EDIT_ENDPOINT_TYPES = new Set([
  'OpenAI image edit',
  'images-edits',
  'openai-编辑',
  'image-edit'
])

/**
 * 「聊天式出图」:图不走 `/v1/images/generations`,而是在 `/v1/chat/completions` 上出。
 *
 * 云雾对 Gemini 图像族只开了 chat 端点(库里 `endpoints` 的 `openai` 那档指向
 * `/v1/chat/completions`),所以它们的端点类型是 `["gemini","openai"]` —— 与全部对话模型同名,
 * **因此 `openai` 不能直接进 `IMAGE_ENDPOINT_TYPES`**,那会把每个对话模型都判成出图模型。
 * 判据三条一起看,见 `isChatImageModel`;产物形状见 `chatImageAssetsFrom`。
 */
const IMAGE_CHAT_ENDPOINT_TYPES = new Set(['openai'])

/** `model_type` 的图像档取值。库里同时有中文与英文旧值(`gpt-image-2-c` 就是 `image`)。 */
const IMAGE_MODEL_TYPES = new Set(['图像', 'image'])

/**
 * 这个模型是不是**只能靠对话端点出图**。三条缺一不可(2026-08-17 拿海外站 478 条量过,
 * 命中正好是 Gemini 图像族那 6 条,零误伤):
 *
 * 1. `model_type` 在图像档 —— 挡住全部对话模型;
 * 2. 端点类型**没有**任何 OpenAI 兼容出图类型 —— 两条路都通的走专用那条(认 `n` 与 `size`);
 * 3. tags 带「绘画」/「绘图」—— 挡住同在图像档的识图类(`kling-image-recognize` 那种)。
 *
 * 与 `src/shared/media-endpoints.ts` 里同名函数是同一份判据,改一处要改两处。
 */
function isChatImageModel(modelType, tags, types) {
  if (!IMAGE_MODEL_TYPES.has(String(modelType ?? '').trim())) {
    return false
  }
  if (hasType(types, IMAGE_ENDPOINT_TYPES)) {
    return false
  }
  if (!hasType(types, IMAGE_CHAT_ENDPOINT_TYPES)) {
    return false
  }
  const t = tags ?? ''
  return t.includes('绘画') || t.includes('绘图')
}

/**
 * 出图离线兜底 + `provider.models` 静态种子。只放**真出过图**的:
 * 2026-08-13 各打一发 1024×1024 都 200 —— 前三个是 gpt-image 系列(b64),
 * seedream 那条走的是「补 response_format 才通」这条新路。
 */
const IMAGE_FALLBACK_MODELS = [
  'gpt-image-2',
  'gpt-image-1.5',
  'gpt-image-1',
  'doubao-seedream-4-0-250828',
  // 2026-08-17 加入:走对话端点那条路,真机文生 + 改图各打过一发(796 KB / 691 KB 的 PNG)。
  'gemini-2.5-flash-image',
  // 2026-08-17 加入:厂商异步那条,各真机出过一张(读数见 references/media-video.md)。
  // `mj_blend` 刻意不进这份 —— 它只做图片混合,当兜底候选会让纯文字出图连吃两记错报。
  'mj_imagine',
  'kling-image',
  'kling-omni-image'
]

/**
 * 目录拉不到时,靠名字认出「这条走对话端点」。
 *
 * 与 `IMAGE_FALLBACK_MODELS` 是同一个取舍:离线兜底是同步的,而端点类型要走网络,
 * 所以这一档只能写名字(视频那侧的 `maxInputImagesByModel` 也是这个形状)。
 * 目录在手时一律按 `isChatImageModel` 判,不看这份 —— 它只兜住目录抖动那一小段。
 */
const IMAGE_CHAT_FALLBACK_MODELS = new Set(['gemini-2.5-flash-image'])

/**
 * 目录拉不到时,靠名字认出「这条走厂商异步出图」以及归哪个适配器。
 *
 * 与上面两份离线兜底同一个取舍(端点类型要走网络,这一档只能写名字),而且同一条纪律:
 * **只放真出过图的**。目录在手时一律按端点类型判(`imageAsyncAdapterFor`),不看这份。
 *
 * 键必须是 `IMAGE_FALLBACK_MODELS` 的子集(先过那道白名单才查这张表),所以 `mj_blend` 不在里面
 * —— 它只做图片混合,当离线兜底候选只会让纯文字出图多吃一记错报。
 */
const IMAGE_ASYNC_FALLBACK_MODELS = new Map([
  ['mj_imagine', 'mj-imagine'],
  ['kling-image', 'kling-image'],
  ['kling-omni-image', 'kling-omni-image']
])

/**
 * MJ 提交体里的 `botType`。两个合法值 `MID_JOURNEY` / `NIJI_JOURNEY`(后者是二次元风),
 * 平台自己的 Lab 默认前者(`web/src/pages/Lab/panels/ImageInputPanel.js:204-206`)。
 * 不做成参数:内核的出图请求里没有「风格」这一档,凭空多一个旋钮没有调用方。
 */
const MJ_BOT_TYPE = 'MID_JOURNEY'

/** MJ blend 的图片张数区间(平台 Lab 的原话:「至少 2 张,最多 9 张」,`ImageInputPanel.js:229`)。 */
const MJ_BLEND_MIN_IMAGES = 2
const MJ_BLEND_MAX_IMAGES = 9

/**
 * MJ blend 的 `dimensions`:上游只给三档朝向,不收像素尺寸
 * (`PORTRAIT=2:3 / SQUARE=1:1 / LANDSCAPE=3:2`,同上 `:237-241`)。
 */
const MJ_BLEND_DIMENSIONS = { portrait: 'PORTRAIT', square: 'SQUARE', landscape: 'LANDSCAPE' }

/**
 * 可灵出图请求体里的 `model_name`:**不能填目录 id**。
 *
 * 2026-08-17 真机:填 `kling-image` 回 `model_name value 'kling-image' is invalid`。
 * 平台价格表列的版本是 v1 / v1-5 / v2 / v2-new / v2-1 / v3
 * (`web/src/components/table/model-pricing/modal/components/ModelPricingTable.js:2250-2261`),
 * 而文生图与图生图的白名单不同(`relay/channel/task/kling/adaptor.go:1494`、`:1500`),
 * **交集是 v1 / v1-5 / v2 / v3** —— 取其中最新的一档,一个名字两条路径都能用。
 * 同一发探针证过它能过 model_name 校验(报的是我故意写错的 aspect_ratio,没建任务)。
 * 与可灵视频那侧的 `KLING_UPSTREAM_MODEL` 是同一个形状:目录 id 只用于选路与计费。
 */
const KLING_IMAGE_UPSTREAM_MODEL = 'kling-v3'

/**
 * omni 那条的 `model_name`:只收 `kling-image-o1` / `kling-v3-omni`,网关本地就校
 * (`relay/channel/task/kling/adaptor.go:756-810`),缺省时它自己补前者
 * (`:2337-2339`)—— 所以显式发前者,与平台默认同口径。两档价格相同(倍率都是 ×1.0)。
 */
const KLING_OMNI_UPSTREAM_MODEL = 'kling-image-o1'

/**
 * 可灵出图的 `aspect_ratio`。**只发这三档**:网关源码里的合法集就是这三个
 * (`relay/channel/task/kling/adaptor.go:1477-1490`),上游还认 4:3 / 3:2 那些,
 * 但没验过的不发(与视频那侧「不声明未验的离散集」同口径)。
 */
const KLING_IMAGE_ASPECT_RATIOS = { portrait: '9:16', square: '1:1', landscape: '16:9' }

/** 可灵出图的 `n` 上限(网关本地校验 1~9,`relay/relay_task_kling.go:322-337`,且按张计费)。 */
const KLING_IMAGE_MAX_COUNT = 9

/**
 * 尺寸清单照内核 litellm 槽位那份原样搬(`LITELLM_SUPPORTED_SIZES`)。
 *
 * 内核会把请求里的 size 吸附到这个列表里的最近值(`image-generation/normalization.ts`),
 * 所以少写一档就是把用户的合法请求改小。沿用被替换者的清单是**不回归**的口径:
 * 我们只验过 1024×1024,但删掉其余档位会让今天能出竖图的用户明天出不了。
 */
const IMAGE_SIZES = [
  '256x256',
  '512x512',
  '1024x1024',
  '1024x1536',
  '1024x1792',
  '1536x1024',
  '1792x1024',
  '2048x2048',
  '2048x1152',
  '3840x2160',
  '2160x3840'
]

/** 默认尺寸:调用方没给 size 时发这个(与 litellm 槽位同口径)。 */
const IMAGE_DEFAULT_SIZE = '1024x1024'

/**
 * 只拿到比例时用哪一档尺寸。三档都在 `IMAGE_SIZES` 里,也正是 gpt-image 系列官方那三档
 * (方 / 横 / 竖),所以不会为了迁就比例发出一个上游没验过的尺寸。
 *
 * **这一段是在修一个真实事故,不是锦上添花。** 内核那侧:我们原来声明
 * `supportsAspectRatio: false`,于是模型只给比例(它比给像素常见得多)时,内核会把比例
 * **反译成尺寸**(`openclaw/src/image-generation/normalization.ts:136-160`),而反译的打分函数
 * 在同比例的候选里取**面积最小**那一档(`src/media-generation/runtime-shared.ts:416` 的
 * `secondary: parsed.area`)—— `IMAGE_SIZES` 的第一档正好是 `256x256`。
 * 2026-08-17 真机:`openclaw infer image generate --aspect-ratio 1:1`(不给 size)出站原文就是
 * `{"model":"gpt-image-1.5",…,"size":"256x256"}`,用户拿到的是张邮票。
 * 处置是照实声明「我们收比例」,自己折成下面这三档,内核就不再反译。
 */
const IMAGE_SIZE_BY_ORIENTATION = {
  square: '1024x1024',
  landscape: '1536x1024',
  portrait: '1024x1536'
}

/**
 * 把比例串折成尺寸。折不出来(没给 / 不认识)时回 undefined,由调用方落到默认尺寸。
 * 5% 容差与 `imageOrientation` 同口径:别把 1024:1080 这种近方比判成竖图。
 */
function imageSizeFromAspectRatio(aspectRatio) {
  const matched = /^(\d+(?:\.\d+)?)\s*[:x×/]\s*(\d+(?:\.\d+)?)$/.exec(trim(aspectRatio) ?? '')
  if (!matched) {
    return undefined
  }
  const width = Number(matched[1])
  const height = Number(matched[2])
  if (!(width > 0) || !(height > 0)) {
    return undefined
  }
  const ratio = width / height
  if (ratio > 1.05) {
    return IMAGE_SIZE_BY_ORIENTATION.landscape
  }
  if (ratio < 0.95) {
    return IMAGE_SIZE_BY_ORIENTATION.portrait
  }
  return IMAGE_SIZE_BY_ORIENTATION.square
}

/** 一次最多几张 / 编辑最多几张参考图:与被替换的 litellm 槽位同口径,不缩水。 */
const IMAGE_MAX_COUNT = 4
const IMAGE_MAX_INPUT_IMAGES = 5

function asObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function trim(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** 登录时写入的云雾供货商槽位。缺了就等于没登录 / 配置没下发。 */
function resolveYunwuCredentials(cfg) {
  const yunwu = asObject(asObject(asObject(cfg)?.models)?.providers)?.[CHAT_PROVIDER_ID]
  const apiKey = trim(yunwu?.apiKey)
  let baseUrl = trim(yunwu?.baseUrl)
  if (!apiKey || !baseUrl) {
    return null
  }
  // providers-store 写的是 `<站点>/v1`,统一接口也挂在 /v1 下,直接拼相对路径即可。
  baseUrl = baseUrl.replace(/\/+$/, '')
  // 厂商专属路由挂在**站点根**而不是 /v1 下(可灵是 `/kling/v1/...`,见
  // `router/relay-router.go:215`),所以顺手把根算出来给那些适配器用。
  const root = baseUrl.replace(/\/v\d+$/, '')
  return { apiKey, baseUrl, root }
}

function authHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 把比例字符串折成朝向。给那些**只认像素尺寸、不认比例**的家用(今天只有 sora)。
 *
 * 与出图那侧的 `imageOrientation` 是一对(那个反过来:只认像素、要折出朝向)。
 * 方图与解析不出来的一律当横屏 —— sora 只有横竖两档,没有方图那一档可选。
 */
function aspectOrientation(aspectRatio) {
  const matched = /^(\d+)\s*:\s*(\d+)$/.exec(trim(aspectRatio) ?? '')
  if (!matched) {
    return 'landscape'
  }
  return Number(matched[2]) > Number(matched[1]) ? 'portrait' : 'landscape'
}

function remainingMs(deadlineAt) {
  return Math.max(1_000, deadlineAt - Date.now())
}

async function fetchJson(url, init, deadlineAt) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), remainingMs(deadlineAt))
  // 调用方给的 signal 必须转接过来:下面那句 `signal: controller.signal` 会把它覆盖掉,
  // 不接就是「传了却没用」——联网搜索那条要靠它响应用户的「停止」。
  const external = init?.signal
  const abortFromExternal = () => controller.abort()
  external?.addEventListener('abort', abortFromExternal, { once: true })
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const text = await res.text()
    let json
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      json = { raw: text }
    }
    return { res, json, text }
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', abortFromExternal)
  }
}

function errorMessage(payload) {
  const obj = asObject(payload)
  if (!obj) {
    return undefined
  }
  if (typeof obj.error === 'string' && obj.error.trim()) {
    return obj.error.trim()
  }
  const err = asObject(obj.error)
  return trim(err?.message) ?? trim(obj.message)
}

function taskIdOf(payload) {
  const obj = asObject(payload)
  return trim(obj?.task_id) ?? trim(obj?.id)
}

function statusOf(payload) {
  return trim(asObject(payload)?.status)?.toLowerCase()
}

function videoUrlOf(payload) {
  const obj = asObject(payload)
  return trim(obj?.video_url) ?? trim(obj?.url)
}

/**
 * 目录缓存。key 是 `baseUrl|apiKey`,换账号自然换桶。
 *
 * 拿不到新结果时**保留上一份好结果当 stale 用**(不是过期即丢):视频这条链路上,
 * 一次目录抖动不该让整个 video_generate 失能。
 */
const catalogCache = new Map()

/**
 * 端点类型 → 认领它的适配器。`ADAPTERS` 在下方定义,这里只在运行时被调用,不存在 TDZ 问题。
 *
 * 端点类型是主判据,但有两家的平台侧是**一个类型挂多种模式**(百炼 happyhorse 的
 * t2v/i2v/r2v/video-edit 共用一条路径、grok 的 `官方格式` 下混着只能图生的
 * `-1.5-preview`),所以适配器可以再声明一个 `claims` 收窄。判据本身不是我们发明的,
 * 见各适配器注释里的平台源码出处;同一份规则在选择器那侧是
 * `shared/media-endpoints.ts` 的 `supportsTextToVideo`,改一处要改两处。
 */
function adapterFor(id, types, tags) {
  return ADAPTERS.find(
    (a) => types.some((t) => a.endpointTypes.has(t)) && (!a.claims || a.claims(id, tags))
  )
}

/** 端点类型命中集合里的任意一个。 */
function hasType(types, wanted) {
  return types.some((t) => wanted.has(t))
}

/**
 * 从 `/v1/models` 现拉,分成三拨:视频里「有适配器认领」的、「是视频但没人认领」的,
 * 以及走 OpenAI 兼容出图端点的。一次请求供视频与出图两个 provider 共用。
 * 失败返回 null,由调用方决定退路。
 */
async function loadCatalog({ baseUrl, apiKey }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS)
  try {
    const res = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    })
    if (!res.ok) {
      return null
    }
    const json = await res.json()
    const rows = Array.isArray(asObject(json)?.data) ? json.data : []
    const claimed = new Map()
    const foreign = new Map()
    const images = new Map()
    for (const row of rows) {
      const id = trim(asObject(row)?.id)
      if (!id) {
        continue
      }
      const types = Array.isArray(row.supported_endpoint_types) ? row.supported_endpoint_types : []
      const tags = trim(row.tags)
      // 只看视频类:model_type 为「音视频」且 tags 含「视频」的才进 foreign 表 ——
      // 那张表只用来在报错时告诉用户「这个模型走的是哪个专属接口」,不必装全量。
      const isVideo = trim(row.model_type) === '音视频' && (tags?.includes('视频') ?? false)
      const adapter = adapterFor(id, types, tags)
      if (adapter) {
        claimed.set(id, { types, tags, adapterId: adapter.id })
      } else if (isVideo) {
        foreign.set(id, { types, tags })
      }
      // 出图与视频彼此独立:同一个模型可以既不是视频、又能出图(反过来也有,
      // 比如 `jimeng_high_aes_general_v21_L` tags 写着「视频生成」却挂在出图端点上)。
      if (hasType(types, IMAGE_ENDPOINT_TYPES)) {
        images.set(id, { types, tags, canEdit: hasType(types, IMAGE_EDIT_ENDPOINT_TYPES) })
      } else if (isChatImageModel(trim(row.model_type), tags, types)) {
        // 对话端点那条路:出图与改图是同一个请求(带不带 `image_url` 而已),所以 canEdit 恒真。
        images.set(id, { types, tags, canEdit: true, viaChat: true })
      } else {
        // 第三条路:厂商专属异步出图(MJ / 可灵)。归属仍由端点类型说,与视频那侧同约定。
        const imageAdapter = imageAsyncAdapterFor(types)
        if (imageAdapter) {
          images.set(id, {
            types,
            tags,
            canEdit: imageAdapter.canEdit === true,
            editOnly: imageAdapter.editOnly === true,
            adapterId: imageAdapter.id
          })
        }
      }
    }
    return { claimed, foreign, images, at: Date.now() }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 带 TTL 与 stale 兜底的目录读取。 */
async function readCatalog(creds) {
  const key = `${creds.baseUrl}|${creds.apiKey}`
  const cached = catalogCache.get(key)
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) {
    return cached
  }
  const fresh = await loadCatalog(creds)
  if (fresh) {
    catalogCache.set(key, fresh)
    return fresh
  }
  return cached ?? null
}

/**
 * 统一异步接口适配器。
 *
 * 实测(2026-08-13,海外站,yw_zhoucongjie 的 auto 令牌):
 *   POST /video/create {model,prompt,aspect_ratio,duration} → {task_id,status:"queued"}
 *   GET  /video/query?id=<task_id> → {status:"completed",video_url:"https://..."}
 *   GET  <video_url> 不带 Authorization → mp4
 */
const unifiedAdapter = {
  id: 'unified',
  endpointTypes: UNIFIED_ENDPOINT_TYPES,
  fallbackModels: UNIFIED_FALLBACK_MODELS,
  verifiedDurations: UNIFIED_DURATIONS,
  async submit({ baseUrl, apiKey, model, prompt, aspectRatio, durationSeconds, deadlineAt }) {
    const ratio = aspectRatio || '16:9'
    const body = {
      model,
      prompt,
      aspect_ratio: ratio,
      duration:
        typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)
          ? Math.round(durationSeconds)
          : 4
    }
    // sora 走的是同一条路、同一个适配器,但多一条必填校验(见 SORA_SIZE_BY_ORIENTATION)。
    // 判据用模型名前缀,与平台那侧一致(`unified_video/adaptor.go:76`:`strings.HasPrefix(model,"sora")`)。
    if (model.toLowerCase().startsWith('sora')) {
      body.size = SORA_SIZE_BY_ORIENTATION[aspectOrientation(ratio)]
    }
    const { res, json, text } = await fetchJson(
      `${baseUrl}/video/create`,
      { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        errorMessage(json) || `云雾视频提交失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    const id = taskIdOf(json)
    if (!id) {
      throw new Error(errorMessage(json) || '云雾视频提交响应缺少 task_id')
    }
    return { taskId: id, submitted: json }
  },
  async poll({ baseUrl, apiKey, taskId, deadlineAt }) {
    const { res, json, text } = await fetchJson(
      `${baseUrl}/video/query?id=${encodeURIComponent(taskId)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        errorMessage(json) || `云雾视频查询失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    return json
  },
  extractUrl: videoUrlOf,
  statusOf,
  errorOf: errorMessage,
  isTerminal(payload) {
    const status = statusOf(payload)
    if (status === 'completed' || videoUrlOf(payload)) {
      return 'ok'
    }
    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      return 'fail'
    }
    return 'pending'
  }
}

/** 可灵的业务错误藏在 HTTP 200 里:`code` 非 0 才是失败,消息在 `message` / `task_status_msg`。 */
function klingError(json) {
  const obj = asObject(json)
  const data = asObject(obj?.data)
  return trim(data?.task_status_msg) ?? trim(obj?.message)
}

/**
 * 可灵文生视频适配器。
 *
 * 契约来源:库里 `models.endpoints`(`kling-video` → `POST /kling/v1/videos/text2video`),
 * 查询走 `router/relay-router.go:285` 那条通配 `GET /kling/v1/:action/:action2/:task_id`。
 * **挂在站点根,不在 `/v1` 下**,所以用 `root` 拼。
 *
 * 与统一接口的三处不同,都是真机量出来的(2026-08-13,海外站 + yw_zhoucongjie 的 auto 令牌):
 *  1. 业务码在体内:HTTP 200 + `{code:0,message:"success",data:{task_id,task_status}}`,
 *     `code` 非 0 才是失败,不能只看 HTTP;
 *  2. 完成态是 `succeed`(不是 `completed` / `succeeded`),url 在
 *     `data.task_result.videos[0].url`,是腾讯云 COS 预签名直链(不带 Authorization 才能下);
 *  3. 慢得多:std 5 秒片实测 **~5.5 分钟**才 `succeed`(统一接口的 veo 约 100 秒)。
 *     所以骨架那 120 次 × 5 秒 = 10 分钟的轮询上限刚够,别再往下调。
 * 一次成功的完整回执还带 `final_unit_deduction:"1"`,可用来核对计费。
 */
const klingAdapter = {
  id: 'kling',
  endpointTypes: KLING_ENDPOINT_TYPES,
  fallbackModels: ['kling-video'],
  verifiedDurations: KLING_DURATIONS,
  // 一个 id 三条路径:1 张走 image2video,2~4 张走 multi-image2video(上限是平台写死的,
  // `kling/adaptor.go:1116-1119`)。认领了多图那条才敢报 4,否则还是 1。
  maxInputImagesFor: (_model, types) => (types?.includes(KLING_MULTI_IMAGE_TYPE) ? 4 : 1),
  async submit({ root, apiKey, prompt, aspectRatio, durationSeconds, inputImages, deadlineAt }) {
    // 图生与文生是**同一个模型 id 的多条路径**(不像百炼那样分成 -t2v / -i2v 两个 id),
    // 按拿到几张参考图换 action。
    const references = allReferenceImages(inputImages)
    const multi = references.length >= 2
    const reference = references[0]
    const action = multi ? 'multi-image2video' : reference ? 'image2video' : 'text2video'
    const body = {
      // 多图那条**只收 `kling-v1-6`**,填别的直接被平台本地拒
      // (`kling/adaptor.go:1165-1173`);另外两条照旧用 v1。
      model_name: multi ? KLING_MULTI_IMAGE_UPSTREAM_MODEL : KLING_UPSTREAM_MODEL,
      prompt,
      mode: KLING_MODE,
      // 只有 5 / 10 两个合法值,内核已按 KLING_DURATIONS 吸附过一轮,这里兜住其余情况。
      // 传数字而不是字符串:验的就是数字,中转层也有专门的浮点分支
      // (`relay/relay_task_kling.go:435-443` 把 float 格式化成串再计价)。
      duration: durationSeconds === 10 ? 10 : 5
    }
    if (multi) {
      // 多图参考没有「首帧」的概念,画面比例定不下来,所以这条路径**照旧要 aspect_ratio**
      // (平台也确实校验它,`kling/adaptor.go:1136-1142`)—— 与单图那条相反。
      body.image_list = references.slice(0, 4).map((image) => ({ image }))
      body.aspect_ratio = aspectRatio || '16:9'
    } else if (reference) {
      // 上游还收一个 `image_tail`(末帧),而且**首帧末帧给一个就行** —— 2026-08-13 探针拿到的
      // 原话是 `image and image_tail can not be empty at the same time`。内核的 imageRoles
      // 里正好有 last_frame,但那条要等有人真用才接,现在只走首帧。
      body.image = reference
    } else {
      // 图生的画面比例由参考图定,`aspect_ratio` 在这条路径上没有意义,不发。
      body.aspect_ratio = aspectRatio || '16:9'
    }
    const { res, json, text } = await fetchJson(
      `${root}/kling/v1/videos/${action}`,
      { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        klingError(json) || `可灵视频提交失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    if (asObject(json)?.code !== 0) {
      throw new Error(klingError(json) || `可灵视频提交被拒: ${text.slice(0, 200)}`)
    }
    const id = trim(asObject(asObject(json)?.data)?.task_id)
    if (!id) {
      throw new Error(klingError(json) || '可灵视频提交响应缺少 task_id')
    }
    return {
      taskId: id,
      submitted: json,
      // 查询要走与提交同一个 action 段(`relay-router.go:285` 那条通配把它原样转给上游),
      // 拿 text2video 的路径查一个 image2video 的任务是查不到的。
      submitContext: { action },
      ignoredAspectRatio: Boolean(reference && !multi && aspectRatio)
    }
  },
  async poll({ root, apiKey, taskId, submitContext, deadlineAt }) {
    const action = KLING_POLL_ACTIONS.has(submitContext?.action)
      ? submitContext.action
      : 'text2video'
    const { res, json, text } = await fetchJson(
      `${root}/kling/v1/videos/${action}/${encodeURIComponent(taskId)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        klingError(json) || `可灵视频查询失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    return json
  },
  extractUrl(payload) {
    const videos = asObject(asObject(asObject(payload)?.data)?.task_result)?.videos
    return Array.isArray(videos) ? trim(asObject(videos[0])?.url) : undefined
  },
  statusOf(payload) {
    return trim(asObject(asObject(payload)?.data)?.task_status)?.toLowerCase()
  },
  errorOf: klingError,
  isTerminal(payload) {
    const status = klingAdapter.statusOf(payload)
    if (status === 'succeed' || klingAdapter.extractUrl(payload)) {
      return 'ok'
    }
    if (status === 'failed') {
      return 'fail'
    }
    return 'pending'
  }
}

/** Vidu 的失败信息:`message` 优先,没有就退回 `err_code`(它至少能查文档)。 */
function viduError(json) {
  return errorMessage(json) ?? trim(asObject(json)?.err_code)
}

/**
 * Vidu 选路:这次请求该打四条路径里的哪一条,以及带几张图。
 *
 * 判据是**这个模型在目录里认领了哪几条**(见 VIDU_ENDPOINT_TYPES 注释),不是名字。
 * 每条路径的图片张数都是平台 dto 里写死的 binding,发错了在提交那一步就被拒:
 *   `text2video`      不收 images(`dto/vidu.go:49-67`)
 *   `img2video`       `binding:"required,len=1"` —— **必须正好 1 张**(`dto/vidu.go:74`)
 *   `start-end2video` `binding:"required,len=2"` —— **必须正好 2 张**,首帧在前(`dto/vidu.go:97`)
 *   `reference2video` images 可多张,但与 subjects 至少有一个非空(`vidu/adaptor.go:91-94`)
 *
 * 拿到的图多于该路径能收的就**截断**(内核只会给一张,多的那种情况来自将来放宽上限);
 * 一张图都没有而模型又不认文生时,这里直接报错 —— 早报一次本地往返,比让上游 400 便宜,
 * 且内核会顺着 fallbacks 往下试。
 */
function viduRoute(model, endpointTypes, inputImages) {
  const claimed = new Set(Array.isArray(endpointTypes) ? endpointTypes : [])
  const references = allReferenceImages(inputImages)
  // 目录拉不到时(离线兜底)`endpointTypes` 是空的。那几个兜底模型都认文生 + 图生,
  // 所以按 2026-08-13 起就在跑的老行为走,不因为「不知道」而失能。
  if (claimed.size === 0) {
    return references.length > 0
      ? { path: VIDU_PATHS.image, images: [references[0]] }
      : { path: VIDU_PATHS.text, images: [] }
  }
  const listed = [...claimed].join(' / ')

  if (references.length === 0) {
    if (!claimed.has('Vidu text to video')) {
      throw new Error(
        `Vidu 模型「${model}」不支持文生视频(它只认 ${listed})。请给一张参考图,` +
          '或改用 viduq3-turbo / viduq3-pro / viduq2 / viduq1 这几个能文生的。'
      )
    }
    return { path: VIDU_PATHS.text, images: [] }
  }
  if (references.length >= 2 && claimed.has('Vidu first & last frame')) {
    return { path: VIDU_PATHS.startEnd, images: references.slice(0, 2) }
  }
  if (claimed.has('Vidu image to video')) {
    return { path: VIDU_PATHS.image, images: [references[0]] }
  }
  if (claimed.has('Vidu reference to video')) {
    return { path: VIDU_PATHS.reference, images: references }
  }
  throw new Error(`Vidu 模型「${model}」不支持以图生视频(它只认 ${listed})。`)
}

/** 把内核给的参考图全折成 URL 字符串(单张那版见 `firstReferenceImage`)。 */
function allReferenceImages(inputImages) {
  const list = Array.isArray(inputImages) ? inputImages : []
  return list.map((item) => firstReferenceImage([item])).filter(Boolean)
}

/**
 * Vidu 文生视频适配器。
 *
 * 契约来源:库里 `models.endpoints`(4 个文生模型都指 `POST /ent/v2/text2video`),
 * 查询路径 `router/relay-router.go:485` 的 `GET /ent/v2/tasks/{id}/creations`。
 * 同样挂在**站点根**,不在 `/v1` 下。
 *
 * 比可灵简单的地方:**请求体里的 `model` 就是选路模型**(`middleware/distributor.go:1642-1658`
 * 直接取它),与目录 id 一致,没有可灵那种「内部名由路径推、上游版本号另写一个字段」的间接层。
 *
 * 真机(2026-08-13,海外站 + yw_zhoucongjie 的 auto 令牌,`viduq3-turbo`,5 秒 16:9):
 *   POST /ent/v2/text2video → 200 `{task_id,type:"text2video",state:"created"}`(**没有 code 包装层**,
 *     失败信号就是 HTTP 状态码,这点与可灵相反)
 *   GET  /ent/v2/tasks/<id>/creations → `state` 走 created → processing → success,
 *     url 在 `creations[0].url`(顶层还有一份等价的 `result_url`)
 *   **76 秒**出片、2.62 MB mp4 —— 比可灵的 5.5 分钟快得多。
 *
 * 轮询回执带 `progress`(0~100),但**内核没有 provider 级的进度上报**:
 * `generateVideo` 的入参里没有任何回调,任务层那句 `Generating video` 是它自己写的
 * (`src/video-generation` 全目录没有 onProgress / reportProgress)。所以这个字段先空着,
 * 不为它自造一条机制。
 */
const viduAdapter = {
  id: 'vidu',
  endpointTypes: VIDU_ENDPOINT_TYPES,
  fallbackModels: ['viduq3-turbo', 'viduq3-pro', 'viduq2', 'viduq1'],
  verifiedDurations: VIDU_DURATIONS,
  // 首尾帧那条**必须正好两张**(`dto/vidu.go:97` 的 `len=2`),所以认领了它的模型报 2。
  // 拿不到类型时(离线兜底)报 1,与 2026-08-13 起就在跑的老行为一致。
  //
  // 参考生(`reference2video`)的 images 在 dto 里没有 len 约束,理论上能多张,但**上限没验过**,
  // 所以不声明 —— 声明一个猜的数字,超出的那部分会在上游 400,比少声明难查。
  maxInputImagesFor: (_model, types) => (types?.includes('Vidu first & last frame') ? 2 : 1),
  async submit({
    root,
    apiKey,
    model,
    prompt,
    aspectRatio,
    durationSeconds,
    inputImages,
    endpointTypes,
    deadlineAt
  }) {
    const { path, images } = viduRoute(model, endpointTypes, inputImages)
    const body = { model, prompt }
    if (images.length > 0) {
      // 图生 / 首尾帧 / 参考生请求体里**都没有** aspect_ratio(`dto/vidu.go:72-113`,
      // 只有文生与参考生有;图生那条比例由图决定),所以只在文生时发。
      body.images = images
      if (path === VIDU_PATHS.reference) {
        body.aspect_ratio = aspectRatio || '16:9'
      }
    } else {
      body.aspect_ratio = aspectRatio || '16:9'
    }
    // 不给就用上游默认(q1/q2 都是 5 秒)。q3 没声明合法值,所以这里可能收到任意数,
    // 原样透传由上游判 —— 见 VIDU_DURATIONS 注释。
    if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)) {
      body.duration = Math.round(durationSeconds)
    }
    const { res, json, text } = await fetchJson(
      `${root}/ent/v2/${path}`,
      { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        viduError(json) || `Vidu 视频提交失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    const id = taskIdOf(json)
    if (!id) {
      throw new Error(viduError(json) || 'Vidu 视频提交响应缺少 task_id')
    }
    // 四条模式共用查询 `/tasks/<id>/creations`,不需要 submitContext。
    return {
      taskId: id,
      submitted: json,
      ignoredAspectRatio: Boolean(
        aspectRatio && (path === VIDU_PATHS.image || path === VIDU_PATHS.startEnd)
      )
    }
  },
  async poll({ root, apiKey, taskId, deadlineAt }) {
    const { res, json, text } = await fetchJson(
      `${root}/ent/v2/tasks/${encodeURIComponent(taskId)}/creations`,
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        viduError(json) || `Vidu 视频查询失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    return json
  },
  extractUrl(payload) {
    const obj = asObject(payload)
    const creations = Array.isArray(obj?.creations) ? obj.creations : []
    return trim(asObject(creations[0])?.url) ?? trim(obj?.result_url)
  },
  statusOf(payload) {
    return trim(asObject(payload)?.state)?.toLowerCase()
  },
  errorOf: viduError,
  isTerminal(payload) {
    const state = viduAdapter.statusOf(payload)
    if (state === 'success' || viduAdapter.extractUrl(payload)) {
      return 'ok'
    }
    if (state === 'failed') {
      return 'fail'
    }
    return 'pending'
  }
}

/**
 * PixVerse 的业务码在体内:`ErrCode` 非 0 才是失败,消息在 `ErrMsg`。
 * 成功时 `ErrMsg` 是 `"success"` / `"Success"`,所以必须先判码再取消息。
 */
function pixverseError(json) {
  const obj = asObject(json)
  if (typeof obj?.ErrCode === 'number' && obj.ErrCode !== 0) {
    return trim(obj.ErrMsg) ?? `ErrCode=${obj.ErrCode}`
  }
  return undefined
}

/**
 * 这个模型是不是「只能图生」。
 *
 * 判据取平台自己的分动作规则(`relay/channel/task/ali/bailain/models.go:21-32`):
 * `-t2v` / `-r2v` / `-video-edit` 各自对应 text_to_video / reference_to_video / video_edit,
 * **其余一律 image_to_video** —— 万相那三个 `wan2.x-i2v*` 正是落在这条 default 上。
 */
function bailianIsImageToVideo(id) {
  const name = trim(id) ?? ''
  if (!name || name.endsWith('-t2v') || name.endsWith('-r2v') || name.endsWith('-video-edit')) {
    return false
  }
  return name.startsWith('wan') || name.includes('-i2v')
}

/**
 * 把内核给的参考图折成一个 URL 字符串。
 *
 * 内核给的是 `{ url? , buffer? , mimeType? }`:http(s) 输入**直通** `{url}`
 * (`openclaw/src/agents/tools/video-generate-tool.ts:591-596`),本地文件 / `file://` / `data:`
 * 则读成 buffer。而平台侧要的是一个 URL 字符串。
 *
 * **buffer 那半边拼 data URI 就行,不必自己起图床** —— 2026-08-13 真机验过:`input.img_url`
 * 塞 `data:image/png;base64,…` 平台收下并建了任务,上游还真解码了(拿 1x1 试的,终态是
 * `image dimensions must be between 240 and 8000 pixels`,顺带得到上游那条 240~8000 像素的约束)。
 */
function firstReferenceImage(inputImages) {
  const list = Array.isArray(inputImages) ? inputImages : []
  for (const item of list) {
    const url = trim(item?.url)
    if (url) {
      return url
    }
    const buffer = item?.buffer
    if (buffer && typeof buffer.toString === 'function') {
      const mime = trim(item?.mimeType) || 'image/png'
      return `data:${mime};base64,${buffer.toString('base64')}`
    }
  }
  return undefined
}

/**
 * 取参考图的**原始资产**(不折成字符串)。
 *
 * PixVerse 要的不是 URL 而是一个数字 `img_id`,得先把图上传换回来,所以它需要 buffer 本身
 * —— 折成 data URI 反而没法当文件传。其余几家用 firstReferenceImage / allReferenceImages 就够。
 */
function referenceAssets(inputImages) {
  const list = Array.isArray(inputImages) ? inputImages : []
  return list.filter((item) => trim(item?.url) || item?.buffer)
}

/**
 * PixVerse 的参考图要先换成数字 `img_id`,再拿它提交 —— 这是它与其余几家最大的形状差:
 * 别家都收一个 URL/base64 字段,它多一个上传往返。
 *
 * 契约来自平台自己的 Lab(`web/src/pages/Lab/shared/labShared.js:631-660`):
 * multipart 打 `/openapi/v2/image/upload`,**本地二进制走 `image` 文件字段、公网图走 `image_url`**
 * —— 它自己的注释写明了为什么优先前者:「避免上游抓取外链失败(防盗链/不可达)」。
 * 回执里的 id 有四种落点(`Resp.img_id` / `img_id` / `Resp.id` / `data.img_id`),照它那样逐个兜。
 *
 * **这一步今天在平台侧不通,而且不是"没配渠道"那么简单**(2026-08-14 查到根因,08-17 复验没变):
 * 上传路由组刻意不挂 `Distribute()`(multipart 进 `ParseMultipartForm` 会破坏 body,
 * `router/relay-router.go:525-539`),所以吃不到智能路由那段「把候选扩展到用户全部可访问分组」,
 * 只用令牌自己绑的分组 —— 我们是 `default`,而唯一那个 PixVerse 渠道只在 `测试 / Pix-1`。
 * 更硬的一条:全站 `pixverse-upload` 调用记录 9 条**无一成功**,选到渠道的那几条报
 * `invalid_api_type` 500(落进了通用 HTTP 中继)。所以平台要动两处才通,我们这侧先接好等着。
 * 下面那句 `PIXVERSE_UPLOAD_HINT` 就是为了让用户看见的是原因而不是一串 503。
 */
async function pixverseUploadImage({ root, apiKey, asset, deadlineAt }) {
  const form = new FormData()
  const url = trim(asset?.url)
  if (asset?.buffer) {
    const mime = trim(asset?.mimeType) || 'image/png'
    const name = trim(asset?.fileName) || `reference.${mime.includes('jpeg') ? 'jpg' : 'png'}`
    form.append('image', new Blob([asset.buffer], { type: mime }), name)
  } else if (url) {
    form.append('image_url', url)
  } else {
    throw new Error('PixVerse 图生视频需要一张参考图')
  }
  // 不能带 authHeaders 那个 application/json:multipart 的 boundary 要交给 fetch 自己写。
  const { res, json, text } = await fetchJson(
    `${root}/openapi/v2/image/upload`,
    { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form },
    deadlineAt
  )
  const failure =
    pixverseError(json) ||
    (res.ok ? undefined : `HTTP ${res.status}: ${text.slice(0, 200)}`)
  if (failure) {
    // 「选不到渠道」是这条路今天的常态,单独说清楚 —— 否则用户看到的只是一句 503,
    // 会以为是自己的图有问题,或者以为整个 PixVerse 都坏了(文生那条其实是好的)。
    const known = /pixverse-upload|invalid_api_type/i.test(failure)
    throw new Error(
      `PixVerse 参考图上传被拒: ${failure}${known ? PIXVERSE_UPLOAD_HINT : ''}`
    )
  }
  const obj = asObject(json)
  const resp = asObject(obj?.Resp)
  const id = resp?.img_id ?? obj?.img_id ?? resp?.id ?? asObject(obj?.data)?.img_id
  if (id == null) {
    throw new Error(`PixVerse 参考图上传响应缺少 img_id: ${text.slice(0, 200)}`)
  }
  return id
}

/**
 * 百炼的失败信息:任务级的在 `output.code` / `output.message`,请求级的在顶层同名字段
 * (`dto/ali/bailian/bailian.go:88-115`)。两层都要看,否则失败时只报得出一句空话。
 */
function bailianError(json) {
  const obj = asObject(json)
  const out = asObject(obj?.output)
  const detail = trim(out?.message) ?? trim(out?.code)
  if (detail) {
    return detail
  }
  const top = trim(obj?.message) ?? trim(obj?.code)
  return top ?? errorMessage(json)
}

/**
 * 海螺的失败判据**只看 `base_resp.status_code`**,不看 HTTP 状态码 —— 见适配器注释里那条 429。
 * 成功时 `status_msg` 是 `"success"`,所以必须先判码再取消息,否则会把成功当失败报出去。
 */
function hailuoError(json) {
  const obj = asObject(json)
  const base = asObject(obj?.base_resp)
  const code = base?.status_code
  if (typeof code === 'number' && code !== 0) {
    return trim(base?.status_msg) ?? `base_resp.status_code=${code}`
  }
  return errorMessage(json)
}

/**
 * 海螺(MiniMax)文生视频适配器。
 *
 * 契约来源:库里 `models.endpoints`(`MiniMax-Hailuo-02` / `-2.3` / `-2.3-Fast` 都指
 * `POST /minimax/v1/video_generation`),查询是 `router/relay-router.go:383` 的
 * `GET /minimax/v1/query/video_generation?task_id=`。同样挂在**站点根**。
 * 选路取请求体的 `model`(`middleware/distributor.go:1627`),与目录 id 一致。
 *
 * 三家里最特别的两点,都是真机量出来的(2026-08-13,`MiniMax-Hailuo-02`,6 秒):
 *
 *  1. **HTTP 状态码不能当失败信号**:`duration=7` 这种参数错回的是 **HTTP 429** +
 *     `{"status":"failed","base_resp":{"status_code":400,"status_msg":"invalid duration: 7"}}`。
 *     429 会让人一路查限流,真正的判据是 `base_resp.status_code != 0`。
 *     (可灵是 200 + 体内 `code`,Vidu 就是 HTTP 码 —— 三家三种形状,别复用。)
 *  2. **官方是三步(提交→查任务拿 file_id→换下载地址),但我们的中转层已经替我们做了第三步**:
 *     `dto/minimax.go` 的 `MergeMinimaxTaskData` 把文件详情并进查询响应,
 *     实测 `status:"Success"` 那一刻 `file.download_url` 已经在里面(85 秒出片、0.47 MB mp4)。
 *     所以这里不需要第四个钩子,骨架不用动。万一哪天合并失效,骨架那句
 *     「完成但没有 video_url」会把它顶出来,不会静默挂住。
 *
 * 比例接不了:请求体只有 `resolution`(512P/768P/1080P),**没有 aspect_ratio**
 * (`dto/minimax.go:16-29`),实测出片 1366×768。而内核的视频能力**只有
 * `supportedDurationSecondsByModel`、没有 `aspectRatiosByModel`**(出图那边才有,
 * `src/image-generation/types.ts:103-110` vs `src/video-generation/types.ts:125-134`),
 * 所以没法只对这家收窄比例。于是收到非 16:9 时把被丢掉的值写进 metadata,
 * 让上层至少能说出「给你的是横屏」——不静默吞掉,也不为它自造机制。
 */
const hailuoAdapter = {
  id: 'hailuo',
  endpointTypes: HAILUO_ENDPOINT_TYPES,
  fallbackModels: ['MiniMax-Hailuo-02', 'MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-2.3-Fast'],
  verifiedDurations: HAILUO_DURATIONS,
  // 首帧图。与别家不同,海螺**不换路径**:同一条 `/minimax/v1/video_generation`,多发一个
  // `first_frame_image` 就是图生(`dto/minimax.go:20`)。末帧(`last_frame_image`)与主体参考
  // (`subject_reference`,S2V-01 那档)也在同一个请求体里,等内核那侧真有两张图的调用方再接。
  maxInputImagesFor: () => 1,
  async submit({
    root,
    apiKey,
    model,
    prompt,
    aspectRatio,
    durationSeconds,
    inputImages,
    deadlineAt
  }) {
    const body = { model, prompt }
    const reference = firstReferenceImage(inputImages)
    if (reference) {
      body.first_frame_image = reference
    } else if (model === 'MiniMax-Hailuo-2.3-Fast') {
      // 平台明写这个模型只做图生,缺图直接 400(`relay/channel/task/minimax/adaptor.go:190-195`)。
      // 在本地先报,省一次往返,也让内核能跳到下一个候选。
      throw new Error(
        `海螺模型「${model}」只支持图生视频,请给一张参考图,或改用 MiniMax-Hailuo-02 / -2.3。`
      )
    }
    if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)) {
      body.duration = Math.round(durationSeconds)
    }
    const { res, json, text } = await fetchJson(
      `${root}/minimax/v1/video_generation`,
      { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) },
      deadlineAt
    )
    const failure = hailuoError(json)
    if (failure) {
      throw new Error(`海螺视频提交失败: ${failure}`)
    }
    if (!res.ok) {
      throw new Error(`海螺视频提交失败 HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    const id = taskIdOf(json)
    if (!id) {
      throw new Error('海螺视频提交响应缺少 task_id')
    }
    const ignoredAspectRatio = aspectRatio && aspectRatio !== '16:9' ? aspectRatio : undefined
    return { taskId: id, submitted: json, ...(ignoredAspectRatio ? { ignoredAspectRatio } : {}) }
  },
  async poll({ root, apiKey, taskId, deadlineAt }) {
    const { res, json, text } = await fetchJson(
      `${root}/minimax/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
      deadlineAt
    )
    const failure = hailuoError(json)
    if (failure) {
      throw new Error(`海螺视频查询失败: ${failure}`)
    }
    if (!res.ok) {
      throw new Error(`海螺视频查询失败 HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    return json
  },
  extractUrl(payload) {
    const file = asObject(asObject(payload)?.file)
    return trim(file?.download_url) ?? trim(file?.backup_download_url)
  },
  statusOf(payload) {
    return trim(asObject(payload)?.status)?.toLowerCase()
  },
  errorOf: hailuoError,
  isTerminal(payload) {
    const status = hailuoAdapter.statusOf(payload)
    if (status === 'success' || hailuoAdapter.extractUrl(payload)) {
      return 'ok'
    }
    if (status === 'failed' || status === 'fail' || status === 'cancelled') {
      return 'fail'
    }
    return 'pending'
  }
}

/**
 * 可灵 3.0 turbo 适配器(与上面的可灵 v1 是**两套协议**,不能复用)。
 *
 * 契约来源:库里 `models.endpoints`(`3.0turbo-文生视频` → `POST /kling/text-to-video/kling-3.0-turbo`,
 * `3.0turbo-图生视频` → `POST /kling/image-to-video/kling-3.0-turbo`),查询各走同名路径加
 * `/:task_id`(`router/relay-router.go:224-227` 四条路由)。
 * 入参校验(`dto/kling_v30_turbo.go:424-444`):`settings.resolution` 只收 720p/1080p、
 * `aspect_ratio` 收 16:9/9:16/1:1、`duration` 是 **3~15 的区间**(没有离散合法集,
 * 所以 `verifiedDurations` 故意不声明 —— 声明离散集会把用户的合法值吸附掉)。
 *
 * 与可灵 v1 的三处不同,都是真机量出来的(2026-08-13,`kling-3.0-turbo`,5 秒 720p 16:9):
 *  1. 参数在 `settings` 子对象里,不是扁平的 `model_name/mode/duration`;
 *  2. **查询响应的 `data` 是数组**(平台自己的 dto 也两种都兼容,
 *     `dto/kling_v30_turbo.go:203-233`)。提交那次 `data` 是对象,所以两种都要认;
 *  3. 完成态字面量是 `succeeded`(可灵 v1 是 `succeed`),url 在 `data[0].outputs[0].url`
 *     而不是 `task_result.videos[0].url`。
 * 实测 108 秒出片、裸下 200 / 7.02 MB;回执还带 `billing:[{amount:"4",charge_type:"unit"}]`。
 */
const klingTurboAdapter = {
  id: 'kling-turbo',
  endpointTypes: KLING_TURBO_ENDPOINT_TYPES,
  fallbackModels: ['kling-3.0-turbo'],
  verifiedDurations: {},
  // 同一个模型 id 两条路径(与可灵 v1 同形)。目录里 `kling-3.0-turbo` 两个类型都挂,
  // 但判据仍取类型而不是名字 —— 上游哪天只留一条时不用改代码。
  maxInputImagesFor: (_model, types) =>
    !types || types.length === 0 || types.includes(KLING_TURBO_IMAGE_TYPE) ? 1 : 0,
  /** 提交回对象、查询回数组,统一取第一条。 */
  item(payload) {
    const data = asObject(payload)?.data
    if (Array.isArray(data)) {
      return asObject(data[0])
    }
    return asObject(data)
  },
  async submit({ root, apiKey, prompt, aspectRatio, durationSeconds, inputImages, deadlineAt }) {
    const reference = firstReferenceImage(inputImages)
    const settings = {
      resolution: KLING_TURBO_RESOLUTION,
      duration:
        typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)
          ? Math.min(15, Math.max(3, Math.round(durationSeconds)))
          : 5
    }
    // 图生的画面比例由首帧图定,和别家一样不发;文生这条平台还会替我们补默认值
    // (`dto/kling_v30_turbo.go:328-333`),但显式发更可控。
    if (!reference) {
      settings.aspect_ratio = aspectRatio || '16:9'
    }
    // 两条路径的**请求体形状不一样**:文生收顶层 `prompt`,图生只收 `contents` 数组,
    // 且里面至少要有一个 `first_frame`(`dto/kling_v30_turbo.go:392-421`)。
    // `contents[].text` 空字符串会被判 400,所以没提示词时干脆不放那一项。
    const body = reference
      ? {
          contents: [
            ...(trim(prompt) ? [{ type: 'prompt', text: prompt }] : []),
            { type: 'first_frame', url: reference }
          ],
          settings
        }
      : { prompt, settings }
    const mode = reference ? 'image-to-video' : 'text-to-video'
    const { res, json, text } = await fetchJson(
      `${root}/kling/${mode}/kling-3.0-turbo`,
      { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        klingError(json) || `可灵 3.0 提交失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    // 与可灵 v1 同一处形状:业务码在体内,HTTP 200 不代表成功。
    if (asObject(json)?.code !== 0) {
      throw new Error(klingError(json) || `可灵 3.0 提交被拒: ${text.slice(0, 200)}`)
    }
    const item = klingTurboAdapter.item(json)
    const id = trim(item?.id) ?? trim(item?.task_id)
    if (!id) {
      throw new Error(klingError(json) || '可灵 3.0 提交响应缺少 task id')
    }
    return {
      taskId: id,
      submitted: json,
      // 查询路径要跟提交那条对上(`router/relay-router.go:226-227` 是两条独立路由)。
      submitContext: { mode },
      ignoredAspectRatio: Boolean(reference && aspectRatio)
    }
  },
  async poll({ root, apiKey, taskId, submitContext, deadlineAt }) {
    const mode = submitContext?.mode === 'image-to-video' ? 'image-to-video' : 'text-to-video'
    const { res, json, text } = await fetchJson(
      `${root}/kling/${mode}/kling-3.0-turbo/${encodeURIComponent(taskId)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        klingError(json) || `可灵 3.0 查询失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    return json
  },
  extractUrl(payload) {
    const item = klingTurboAdapter.item(payload)
    const outputs = Array.isArray(item?.outputs) ? item.outputs : []
    const fromOutputs = trim(asObject(outputs[0])?.url)
    if (fromOutputs) {
      return fromOutputs
    }
    // 官方另有一份 `task_result.videos[]`;实测这条路回的是 outputs,留着兜底不多余。
    const videos = asObject(item?.task_result)?.videos
    return Array.isArray(videos) ? trim(asObject(videos[0])?.url) : undefined
  },
  statusOf(payload) {
    const item = klingTurboAdapter.item(payload)
    return trim(item?.status)?.toLowerCase() ?? trim(item?.task_status)?.toLowerCase()
  },
  errorOf(payload) {
    const item = klingTurboAdapter.item(payload)
    return trim(item?.task_status_msg) ?? trim(item?.message) ?? trim(asObject(payload)?.message)
  },
  isTerminal(payload) {
    const status = klingTurboAdapter.statusOf(payload)
    // 两个字面量都认:平台自己会把 succeeded 归一成 succeed 落它的任务表
    // (`dto/kling_v30_turbo.go:461-468`),而透传给我们的原文是 succeeded。
    if (status === 'succeeded' || status === 'succeed' || klingTurboAdapter.extractUrl(payload)) {
      return 'ok'
    }
    if (status === 'failed' || status === 'error') {
      return 'fail'
    }
    return 'pending'
  }
}

/**
 * PixVerse(拍我 AI)适配器:一个模型 id 三条出片路径,按拿到几张参考图选。
 *
 * 契约来源是库里 `models.endpoints` 与平台的本地必填校验
 * (`relay/channel/task/pixverse/models.go:521-559`),查询三条共用
 * `router/relay-router.go:520` 的 `GET /openapi/v2/video/result/:id`。全挂在**站点根**。
 *
 * | 图 | 路径 | 除 model/prompt/quality/duration 外还要 |
 * |---|---|---|
 * | 0 张 | `/video/text/generate` | `aspect_ratio` |
 * | 1 张 | `/video/img/generate` | `img_id`(或 `img_ids`)|
 * | 2 张 | `/video/transition/generate` | `first_frame_img` + `last_frame_img`,都是正整数 |
 *
 * 后两条要先把图换成数字 id,而那个上传接口今天在平台侧不通 —— 详见 `pixverseUploadImage`。
 *
 * **`Resp.url` 会在还没生成完时就出现,而且那时候下它是 404。** 这是本家最容易踩的坑:
 * 2026-08-13 真机第 12 秒查到 `{"status":5,"url":"https://media.pixverseai.cn/…"}`,
 * 裸下回 **HTTP 404 + application/xml 448B**(对象还没落桶);第 28 秒 `status` 变 1、
 * 同一条 url 才 200 / 3.08 MB。所以**终态判据只能看 `status`,不能看有没有 url** ——
 * 其余几家都用「status 或 url 命中即完成」,这一家必须例外,否则必然下到一个 404。
 * 状态码语义见 `dto/pixverse.go:18-24`:1 成功 / 5 生成中 / 6 已删除 / 7 审核失败 / 8 生成失败。
 *
 * 另一处间接层与可灵 v1 同形:目录 id 是 `pixverse-video`,但**请求体的 `model` 要填上游版本号**
 * (`c1`/`v6`/`v5.6`/`v5.5`/`v5`/`v4.5`/`v4`/`v3.5`,白名单在
 * `relay/channel/task/pixverse/models.go:97-106`);选渠道用的内部名由**路径**推出
 * (同文件 `pathToInternalModel`),与请求体无关。
 */
const pixverseAdapter = {
  id: 'pixverse',
  endpointTypes: PIXVERSE_ENDPOINT_TYPES,
  fallbackModels: ['pixverse-video'],
  verifiedDurations: {},
  /**
   * 首尾帧要两张,图生要一张,都认领不到就是纯文生。
   *
   * 拿不到端点类型时(离线兜底)报 **0** 而不是 1:这一家的图生要先过一个上传接口,
   * 而那条今天在平台侧不通(见 `pixverseUploadImage` 的注释),不知道的时候别把用户领进去。
   */
  maxInputImagesFor: (_model, types) => {
    if (types?.includes(PIXVERSE_FIRST_LAST_TYPE)) {
      return 2
    }
    return types?.includes(PIXVERSE_IMAGE_TYPE) ? 1 : 0
  },
  async submit({ root, apiKey, prompt, aspectRatio, durationSeconds, inputImages, deadlineAt }) {
    // 这一家收的不是 URL 而是数字 id,所以要原始资产(buffer 折成 data URI 就没法当文件传)。
    const assets = referenceAssets(inputImages)
    const transition = assets.length >= 2
    const body = {
      model: PIXVERSE_UPSTREAM_MODEL,
      prompt,
      quality: PIXVERSE_QUALITY,
      duration:
        typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)
          ? Math.max(1, Math.round(durationSeconds))
          : 5
    }
    if (transition) {
      // 首尾帧:两个字段都是**正整数 img_id**,缺一个就 400
      // (`relay/channel/task/pixverse/models.go:545-559`)。两次上传,顺序即首帧、尾帧。
      const [first, last] = await Promise.all(
        assets.slice(0, 2).map((asset) => pixverseUploadImage({ root, apiKey, asset, deadlineAt }))
      )
      body.first_frame_img = first
      body.last_frame_img = last
    } else if (assets.length === 1) {
      body.img_id = await pixverseUploadImage({ root, apiKey, asset: assets[0], deadlineAt })
    } else {
      // 图生 / 首尾帧那两条官方请求体里**没有** aspect_ratio(比例由图定),只有文生要它。
      body.aspect_ratio = aspectRatio || '16:9'
    }
    const segment = transition ? 'transition' : assets.length === 1 ? 'img' : 'text'
    const { res, json, text } = await fetchJson(
      `${root}/openapi/v2/video/${segment}/generate`,
      { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        pixverseError(json) || `PixVerse 提交失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    // 业务码在体内(`ErrCode`),与可灵同形、与 Vidu 相反。
    const failure = pixverseError(json)
    if (failure) {
      throw new Error(`PixVerse 提交被拒: ${failure}`)
    }
    // video_id 是大整数,库里用 json.Number 防精度丢失;我们只当字符串用。
    const raw = asObject(asObject(json)?.Resp)?.video_id
    const id = raw == null ? undefined : String(raw)
    if (!id) {
      throw new Error('PixVerse 提交响应缺少 video_id')
    }
    // 查询路径三条模式共用 `/video/result/<id>`(`relay-router.go:520`),
    // 所以不像可灵那样需要 submitContext。
    return {
      taskId: id,
      submitted: json,
      ignoredAspectRatio: Boolean(assets.length > 0 && aspectRatio)
    }
  },
  async poll({ root, apiKey, taskId, deadlineAt }) {
    const { res, json, text } = await fetchJson(
      `${root}/openapi/v2/video/result/${encodeURIComponent(taskId)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        pixverseError(json) || `PixVerse 查询失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    return json
  },
  extractUrl(payload) {
    return trim(asObject(asObject(payload)?.Resp)?.url)
  },
  statusOf(payload) {
    const code = asObject(asObject(payload)?.Resp)?.status
    return typeof code === 'number' ? (PIXVERSE_STATUS[code] ?? `status_${code}`) : undefined
  },
  errorOf(payload) {
    return pixverseError(payload) ?? PIXVERSE_STATUS[asObject(asObject(payload)?.Resp)?.status]
  },
  isTerminal(payload) {
    const code = asObject(asObject(payload)?.Resp)?.status
    if (code === 1) {
      return 'ok'
    }
    if (code === 6 || code === 7 || code === 8) {
      return 'fail'
    }
    return 'pending'
  }
}

/**
 * 阿里百炼 happyhorse 文生视频适配器。
 *
 * 契约来源:库里 `models.endpoints`(`Happyhorse video` →
 * `POST /alibailian/api/v1/services/aigc/video-generation/video-synthesis`),
 * 查询是 `router/relay-router.go:446` 的 `GET /alibailian/tasks/:task_id`
 * (中转层内部再改写成 `/alibailian/api/v1/tasks/:id`,`ali/bailain/adaptor.go:75-79`)。
 * 挂在**站点根**。请求体是三层的 `{model, input:{prompt}, parameters:{…}}`,
 * 与其他几家的扁平体都不同。
 *
 * **这个端点类型下有四个模型,只有 `-t2v` 能文生**,所以要 `claims` 再收一层 ——
 * 判据是平台自己的 `GetModelAction`(`ali/bailain/models.go:21-32`),i2v 要 `first_frame`、
 * r2v 要 `reference_image`、video-edit 要 `video`,缺了直接被 `Validate` 拒
 * (`dto/ali/bailian/bailian.go:176-211`)。
 *
 * 真机(2026-08-13,`happyhorse-1.0-t2v`,5 秒):
 *  - 提交 → `{request_id, output:{task_id, task_status:"PENDING"}}`;
 *  - 查询 `output.task_status` 走 PENDING → RUNNING → **SUCCEEDED**(**全大写**,
 *    与其他几家的小写不同,取值集见 `dto/ali/bailian/bailian.go:16-21`),url 在 `output.video_url`;
 *  - 默认档 1080P 用 162 秒、8.56 MB;显式 `720P` + `ratio:"9:16"` 用 104 秒、4.75 MB,
 *    回执 `usage` 回显 `SR:720` / `ratio:"9:16"` —— 两个旋钮都真吃。
 *
 * 所以这里**显式发 720P**:dto 里不填就默认 1080P(`bailian.go:234-238`),而 1080P 更贵更慢,
 * 而且我们这条链路上没有让用户选分辨率的地方 —— 与 WorkBuddy 的 VideoGen 默认 720P 同口径。
 * 比例落在 `ratio` 字段(不是 `aspect_ratio`),这是本家独有的字段名。
 */
const bailianAdapter = {
  id: 'bailian',
  // 万相与百炼**同一条路径、同一套状态字面量**,只是端点类型名不同,所以一个适配器带两家
  // (平台侧就是同一个 channel:`relay/channel/task/ali/bailain/models.go` 的 ModelList 里
  // wan2.x 与 happyhorse 并列)。
  endpointTypes: new Set(['Happyhorse video', 'Wan video generation']),
  // 这个端点类型下同时挂着文生与图生,按模型名分:`-t2v` 只能文生,`-i2v` / `wan*` 只能图生
  // (平台自己就是按名字分动作,`ali/bailain/models.go:21-32` 的 `GetModelAction`)。
  // `-r2v`(要 reference_image)与 `-video-edit`(要 video)仍不认领 —— 那两种输入内核这条链
  // 目前给不出来。两种都收进池子是安全的:内核会按能力跳过不合格的候选(见 capabilities 那段)。
  claims: (id) => id.endsWith('-t2v') || bailianIsImageToVideo(id),
  maxInputImagesFor: (model) => (bailianIsImageToVideo(model) ? 1 : 0),
  fallbackModels: ['happyhorse-1.0-t2v'],
  verifiedDurations: {},
  async submit({
    root,
    apiKey,
    model,
    prompt,
    aspectRatio,
    durationSeconds,
    inputImages,
    deadlineAt
  }) {
    const imageToVideo = bailianIsImageToVideo(model)
    const reference = firstReferenceImage(inputImages)
    if (imageToVideo && !reference) {
      // 让内核把这个候选算作失败并跳到下一个 fallback(`video-generation/runtime.ts:348-356`),
      // 比让平台回一句 `img_url_and_model_required` 更好读。
      throw new Error(`${model} 只能图生视频,请给一张参考图`)
    }
    if (!imageToVideo && reference) {
      throw new Error(`${model} 只能文生视频,去掉参考图或换一个图生模型`)
    }
    // 万相是 2~15,百炼(happyhorse)是 3~15 —— 两家不同档,真机各撞过一次
    // (`ali/bailain/adaptor.go:132-147`;非法值回的是 HTTP 429 `duration_out_of_range`)。
    const minDuration = model.startsWith('wan') ? 2 : 3
    const body = {
      model,
      input: {
        prompt,
        // 图生的图就走 `input.img_url`(一个 URL 字符串)。百炼 i2v 的 `Normalize()` 会把它搬进
        // `media[{type:'first_frame'}]`,万相走 `Validate` 的 default 分支直接要这个字段
        // (`dto/ali/bailian/bailian.go:136-154, 212-215`),所以两家写法一致。
        ...(reference ? { img_url: reference } : {})
      },
      parameters: {
        // 区间校验,没有离散合法集,所以不声明 verifiedDurations。
        duration:
          typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)
            ? Math.min(15, Math.max(minDuration, Math.round(durationSeconds)))
            : 5,
        resolution: BAILIAN_RESOLUTION,
        ratio: aspectRatio || '16:9'
      }
    }
    const { res, json, text } = await fetchJson(
      `${root}/alibailian/api/v1/services/aigc/video-generation/video-synthesis`,
      { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        bailianError(json) || `百炼视频提交失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    const id = trim(asObject(asObject(json)?.output)?.task_id)
    if (!id) {
      throw new Error(bailianError(json) || '百炼视频提交响应缺少 task_id')
    }
    return { taskId: id, submitted: json }
  },
  async poll({ root, apiKey, taskId, deadlineAt }) {
    const { res, json, text } = await fetchJson(
      `${root}/alibailian/tasks/${encodeURIComponent(taskId)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        bailianError(json) || `百炼视频查询失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    return json
  },
  extractUrl(payload) {
    return trim(asObject(asObject(payload)?.output)?.video_url)
  },
  statusOf(payload) {
    return trim(asObject(asObject(payload)?.output)?.task_status)?.toLowerCase()
  },
  errorOf: bailianError,
  isTerminal(payload) {
    const status = bailianAdapter.statusOf(payload)
    if (status === 'succeeded' || bailianAdapter.extractUrl(payload)) {
      return 'ok'
    }
    // UNKNOWN 是「任务不存在或状态未知」,当失败报出去比一路轮到超时有用。
    if (status === 'failed' || status === 'canceled' || status === 'unknown') {
      return 'fail'
    }
    return 'pending'
  }
}

/**
 * xAI Grok Imagine 视频适配器(官方原生格式)。
 *
 * 契约来源:库里 `models.endpoints`(`官方格式` → `POST /v1/videos/generations`),
 * 查询是 `router/relay-router.go:106` 的 `GET /v1/videos/:video_id`。**这家挂在 `/v1` 下**,
 * 所以用 `baseUrl` 而不是 `root`(前面几家都在站点根)。
 *
 * 四个字段**缺一不可**,平台在提交前就拦(`relay/channel/task/xaivideo/adaptor.go:84-96`):
 * `model` / `prompt` / `aspect_ratio` / `resolution` / `duration`。`resolution` 只收 480p 与 720p
 * (`1080p` 有专门一条「暂不支持」的拦截,同文件 `:99-101`),`duration` 是 1~15 区间
 * (`constants.go:20-27`,默认 8)—— 又是区间,所以不声明 `verifiedDurations`。
 *
 * `官方格式` 这个类型下有两个模型,`grok-imagine-video-1.5-preview` **只能图生**
 * (`models.go:35-37` 的 `imageOnlyModels`),所以要 `claims` 收一层。用 tags 判而不是照抄
 * 那份写死的名单:库里 preview 那条的 tags 只有「首帧」,正规那条是「视频,首帧,参考图,视频编辑」,
 * 按 tag 分能跟上上游上新。(还有个 `grok-imagine-video-1.5` 的 `endpoints` 是空串,
 * 没有任何端点类型,天然不会被任何适配器认领。)
 *
 * 真机(2026-08-13,`grok-imagine-video`,5 秒 720p 16:9):提交回的是**裸 `{request_id}`**
 * (没有状态、没有包装层),查询回 `{status:"done",progress:100,video:{url,duration},usage}`,
 * 完成态字面量是 `done`(不是 succeeded / completed / success —— 四家四种)。
 * 64 秒出片、裸下 200 / 3.88 MB。轮询早期还见过一次响应体里**连 `status` 都没有**,
 * 所以缺状态一律当 pending,只有 `error` 出现才判失败。
 */
const grokAdapter = {
  id: 'grok',
  endpointTypes: new Set(['官方格式']),
  claims: (id, tags) => (tags ?? '').includes('视频'),
  fallbackModels: ['grok-imagine-video'],
  verifiedDurations: {},
  async submit({ baseUrl, apiKey, model, prompt, aspectRatio, durationSeconds, deadlineAt }) {
    const body = {
      model,
      prompt,
      aspect_ratio: aspectRatio || '16:9',
      resolution: GROK_RESOLUTION,
      duration:
        typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)
          ? Math.min(15, Math.max(1, Math.round(durationSeconds)))
          : 5
    }
    const { res, json, text } = await fetchJson(
      `${baseUrl}/videos/generations`,
      { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        errorMessage(json) || `Grok 视频提交失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    const id = trim(asObject(json)?.request_id) ?? taskIdOf(json)
    if (!id) {
      throw new Error(errorMessage(json) || 'Grok 视频提交响应缺少 request_id')
    }
    return { taskId: id, submitted: json }
  },
  async poll({ baseUrl, apiKey, taskId, deadlineAt }) {
    const { res, json, text } = await fetchJson(
      `${baseUrl}/videos/${encodeURIComponent(taskId)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        errorMessage(json) || `Grok 视频查询失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    return json
  },
  extractUrl(payload) {
    return trim(asObject(asObject(payload)?.video)?.url)
  },
  statusOf,
  errorOf(payload) {
    const err = asObject(asObject(payload)?.error)
    return trim(err?.message) ?? trim(err?.code) ?? errorMessage(payload)
  },
  isTerminal(payload) {
    const status = statusOf(payload)
    if (status === 'done' || grokAdapter.extractUrl(payload)) {
      return 'ok'
    }
    if (
      status === 'failed' ||
      status === 'error' ||
      status === 'cancelled' ||
      asObject(asObject(payload)?.error)
    ) {
      return 'fail'
    }
    return 'pending'
  }
}

/**
 * OpenAI 官方视频接口(`POST /v1/videos`)。sora 全家 + grok 的 OpenAI 兼容两条走这里。
 *
 * 与统一异步那条(`/v1/video/create`)的区别值得说清,两条都能跑 sora,但**不是一回事**:
 * 库里 `sora-2-pro` 同时挂着 `Unified video format` 与 `OpenAI official video format`,
 * 而 `sora-2` / `-hd` / `-landscape` / `-portrait` / `official-sora-2` **只有后者** ——
 * 所以不接这一家,那五条就永远选不到。sora-2-pro 仍留给统一那条(那条的形状是验过的)。
 *
 * 三处形状都来自平台源码,不是文档:
 *  - 请求体 `{model,prompt,size,seconds}`:`sora/adaptor.go:387-415`(JSON 分支,`duration`
 *    是 `seconds` 的兼容名),缺 model 直接 400;`:441-448` 给 sora-2 系列补默认
 *    `size=720x1280`、`seconds=4` —— size 的白名单校验在这条路上是**注释掉的**(`:450-457`),
 *    所以横竖屏两个值都收;
 *  - 完成态与取件:`:799-815`,状态字面量 `queued|pending|processing|in_progress|completed|
 *    failed|cancelled`,成品**不给直链**,只给 `/v1/videos/{id}/content`(要带我们自己的 key);
 *  - grok-videos 那条另有约束:`seconds` 只收 6 或 10、`size` 用 `16:9`/`9:16`
 *    (`:471-489`),所以下面按模型分两支。
 *
 * 2026-08-17 真机:这把 key 对 sora / grok-videos 都没有渠道,提交打到选渠道那步被挡
 * (回「下模型 sora-2-pro 无可用渠道」)—— 路径与模型解析都对得上,出片没法验。
 */
const SORA_DURATIONS = {
  'sora-2': [4, 8, 12],
  'sora-2-hd': [4, 8, 12],
  'sora-2-landscape': [4, 8, 12],
  'sora-2-portrait': [4, 8, 12],
  'official-sora-2': [4, 8, 12],
  // 麒麟泽直连时平台只收这两个值,其余 400(`sora/adaptor.go:481-484`)。
  'grok-videos': [6, 10],
  'grok-imagine-1.0-video': [6, 10]
}

const soraAdapter = {
  id: 'sora',
  endpointTypes: new Set(['OpenAI official video format', 'Grok video (OpenAI format)']),
  fallbackModels: [
    'sora-2',
    'sora-2-hd',
    'sora-2-landscape',
    'sora-2-portrait',
    'official-sora-2',
    'grok-videos'
  ],
  verifiedDurations: SORA_DURATIONS,
  // 官方接口收 `input_reference`,但它要的是**上游能取到的图**;我们手上是内核给的 buffer,
  // 转 data URI 能不能被上游收下没验过,所以先按不收图报(内核会自动跳过这一家)。
  maxInputImagesFor: () => 0,
  async submit({ baseUrl, apiKey, model, prompt, aspectRatio, durationSeconds, deadlineAt }) {
    const isGrok = model.startsWith('grok-')
    const orientation = aspectOrientation(aspectRatio)
    const body = {
      model,
      prompt,
      // grok 那两条按比例串收,sora 按像素串收 —— 同一条路径,两套值域。
      size: isGrok
        ? orientation === 'portrait'
          ? '9:16'
          : '16:9'
        : SORA_SIZE_BY_ORIENTATION[orientation],
      seconds:
        typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)
          ? Math.round(durationSeconds)
          : isGrok
            ? 6
            : 4
    }
    const { res, json, text } = await fetchJson(
      `${baseUrl}/videos`,
      { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        errorMessage(json) || `sora 视频提交失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    const id = taskIdOf(json)
    if (!id) {
      throw new Error(errorMessage(json) || 'sora 视频提交响应缺少 id')
    }
    return { taskId: id, submitted: json }
  },
  async poll({ baseUrl, apiKey, taskId, deadlineAt }) {
    const { res, json, text } = await fetchJson(
      `${baseUrl}/videos/${encodeURIComponent(taskId)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        errorMessage(json) || `sora 视频查询失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    return json
  },
  /** 没有 video_url 这种字段,成品挂在固定路径上,完成之后才拼得出来。 */
  extractUrl(payload, ctx) {
    if (statusOf(payload) !== 'completed') {
      return undefined
    }
    const id = taskIdOf(payload) ?? ctx?.taskId
    return id ? `${ctx?.baseUrl}/videos/${encodeURIComponent(id)}/content` : undefined
  },
  downloadHeaders({ apiKey }) {
    return { Authorization: `Bearer ${apiKey}` }
  },
  statusOf,
  errorOf(payload) {
    return trim(asObject(asObject(payload)?.error)?.message) ?? errorMessage(payload)
  },
  isTerminal(payload) {
    const status = statusOf(payload)
    if (status === 'completed') {
      return 'ok'
    }
    if (status === 'failed' || status === 'cancelled') {
      return 'fail'
    }
    return 'pending'
  }
}

/**
 * Runway。**这一家只有图生**:平台只开了 `/runwayml/v1/image_to_video` 一条路
 * (`router/relay-router.go:330`),`promptImage` 缺了直接 400
 * (`relay/channel/task/runway/adaptor.go:57-60`)。
 *
 * 最要命的一处间接层:**目录 id 是平台拼出来的**。它读请求体的 `model` 与 `duration`,
 * 拼成 `runwayml-<model>-<duration>` 去选渠道和计价(`middleware/distributor.go:1301-1307`,
 * `duration` 缺省补 5)。所以目录里的 `runwayml-gen4_turbo-5` **不能原样发**,
 * 要拆回 `{model:'gen4_turbo', duration:5}` —— 这是继可灵 v1、PixVerse 之后第三家
 * 「目录 id ≠ 上游模型名」,而且是唯一一家**把时长编进模型身份**的:
 * 想要 10 秒就得选 `-10` 那条模型,不是改时长参数。
 *
 * 2026-08-17 真机验的就是这条:发 `{model:'gen4_turbo',duration:5}` 到那条路径,
 * 平台回「下模型 `runwayml-gen4_turbo-5` 无可用渠道」—— 拼名规则与路径都确认无误。
 */
const RUNWAY_RATIOS = {
  // 上游按模型分两套值域(Runway API 的 gen4/gen3a 各自的合法 ratio),这里只取横竖两档。
  gen4_turbo: { landscape: '1280:720', portrait: '720:1280' },
  gen3a_turbo: { landscape: '1280:768', portrait: '768:1280' }
}

/** `runwayml-gen4_turbo-5` → `{ upstream:'gen4_turbo', duration:5 }`。 */
function runwaySplit(model) {
  const matched = /^runwayml-(.+)-(\d+)$/.exec(model)
  if (!matched) {
    throw new Error(`Runway 模型名「${model}」不是 runwayml-<模型>-<时长> 的形状`)
  }
  return { upstream: matched[1], duration: Number(matched[2]) }
}

const runwayAdapter = {
  id: 'runway',
  endpointTypes: new Set(['Runway image to video']),
  fallbackModels: [
    'runwayml-gen4_turbo-5',
    'runwayml-gen4_turbo-10',
    'runwayml-gen3a_turbo-5',
    'runwayml-gen3a_turbo-10'
  ],
  // 时长是模型身份的一部分,所以每条只有一个合法值。声明出来,内核就不会拿别的秒数来撞。
  verifiedDurations: {
    'runwayml-gen4_turbo-5': [5],
    'runwayml-gen4_turbo-10': [10],
    'runwayml-gen3a_turbo-5': [5],
    'runwayml-gen3a_turbo-10': [10]
  },
  maxInputImagesFor: () => 1,
  async submit({ root, apiKey, model, prompt, aspectRatio, inputImages, deadlineAt }) {
    const image = firstReferenceImage(inputImages)
    if (!image) {
      throw new Error(`Runway 只有图生视频这一条路,「${model}」必须给一张参考图`)
    }
    const { upstream, duration } = runwaySplit(model)
    const ratios = RUNWAY_RATIOS[upstream] ?? RUNWAY_RATIOS.gen4_turbo
    const body = {
      model: upstream,
      duration,
      ratio: ratios[aspectOrientation(aspectRatio)],
      promptImage: image,
      ...(prompt ? { promptText: prompt } : {})
    }
    const { res, json, text } = await fetchJson(
      `${root}/runwayml/v1/image_to_video`,
      { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        errorMessage(json) || `Runway 视频提交失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    const id = taskIdOf(json)
    if (!id) {
      throw new Error(errorMessage(json) || 'Runway 视频提交响应缺少 id')
    }
    return { taskId: id, submitted: json }
  },
  async poll({ root, apiKey, taskId, deadlineAt }) {
    const { res, json, text } = await fetchJson(
      `${root}/runwayml/v1/tasks/${encodeURIComponent(taskId)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        errorMessage(json) || `Runway 视频查询失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    return json
  },
  extractUrl(payload) {
    const output = asObject(payload)?.output
    return Array.isArray(output) ? trim(output[0]) : undefined
  },
  statusOf,
  errorOf(payload) {
    const obj = asObject(payload)
    return trim(obj?.failure) ?? trim(obj?.failureCode) ?? errorMessage(payload)
  },
  /** 状态字面量是大写的(`adaptor.go:218-240`),`statusOf` 会转小写。 */
  isTerminal(payload) {
    const status = statusOf(payload)
    if (status === 'succeeded') {
      return 'ok'
    }
    if (status === 'failed' || status === 'cancelled') {
      return 'fail'
    }
    return 'pending'
  }
}

/**
 * Luma。这一家**请求体里没有模型名** —— 模型由路径定死:`/luma/generations` 恒等于
 * `luma_video_api`,`/luma/generations/{id}/extend` 恒等于 `luma_video_extend_api`
 * (`middleware/distributor.go:1264-1271`)。所以目录里那条 `luma_video_api` 只是个记账名,
 * 发出去的报文里不该出现它(发了也无害,dto 里没这个字段,会被忽略)。
 *
 * 视频续写(`extend`)不接:内核这条链路给不出「上一段视频的 id」这种输入。
 *
 * 请求体取平台自己的集成测试范本(`controller/relay_integration_test.go:1476-1485`):
 * `{prompt, aspect_ratio}`。dto 里另有一套 GoAMZ 风格的字段(`user_prompt` / `image_url`
 * / `keyframes`,`dto/luma.go:9-25`),图生要用哪一套没验过,所以先只接文生。
 */
const lumaAdapter = {
  id: 'luma',
  endpointTypes: new Set(['Luma video generation']),
  fallbackModels: ['luma_video_api'],
  verifiedDurations: {},
  maxInputImagesFor: () => 0,
  async submit({ root, apiKey, prompt, aspectRatio, deadlineAt }) {
    const body = { prompt, aspect_ratio: aspectRatio || '16:9' }
    const { res, json, text } = await fetchJson(
      `${root}/luma/generations`,
      { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        errorMessage(json) || `Luma 视频提交失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    const id = taskIdOf(json)
    if (!id) {
      throw new Error(errorMessage(json) || 'Luma 视频提交响应缺少 id')
    }
    return { taskId: id, submitted: json }
  },
  async poll({ root, apiKey, taskId, deadlineAt }) {
    const { res, json, text } = await fetchJson(
      `${root}/luma/generations/${encodeURIComponent(taskId)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        errorMessage(json) || `Luma 视频查询失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    return json
  },
  extractUrl(payload) {
    return trim(asObject(asObject(payload)?.video)?.url)
  },
  /** 状态字段叫 `state`,不叫 `status`(`dto/luma.go:36`、`:61-68`)。 */
  statusOf(payload) {
    return trim(asObject(payload)?.state)?.toLowerCase()
  },
  errorOf: errorMessage,
  isTerminal(payload) {
    const state = lumaAdapter.statusOf(payload)
    if (state === 'completed') {
      return 'ok'
    }
    if (state === 'failed' || state === 'error') {
      return 'fail'
    }
    return 'pending'
  }
}

/**
 * Replicate。路径带模型名(`/replicate/v1/models/{owner}/{name}/predictions`,
 * `router/relay-router.go:349`),请求体是 Replicate 自己的 `{input:{…}}` 包一层
 * (`relay_integration_test.go:1500-1510`)。查询是 `GET /replicate/v1/predictions/{id}`。
 *
 * 端点类型名是逐模型的(`minimax/video-01 (Async)`),所以认领靠 `matchesType`,
 * 见 `isPerModelAsyncType` 的注释。目录里今天三条:`minimax/video-01`、
 * `minimax/video-01-live`、`prunaai/vace-14b`。
 */
const replicateAdapter = {
  id: 'replicate',
  endpointTypes: new Set(),
  matchesType: (type, id) => !id.startsWith('fal-ai/') && isPerModelAsyncType(type, id),
  fallbackModels: ['minimax/video-01', 'minimax/video-01-live'],
  verifiedDurations: {},
  maxInputImagesFor: () => 0,
  async submit({ root, apiKey, model, prompt, deadlineAt }) {
    const { res, json, text } = await fetchJson(
      `${root}/replicate/v1/models/${model}/predictions`,
      {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify({ input: { prompt } })
      },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        errorMessage(json) || `Replicate 视频提交失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    const id = taskIdOf(json)
    if (!id) {
      throw new Error(errorMessage(json) || 'Replicate 视频提交响应缺少 id')
    }
    return { taskId: id, submitted: json }
  },
  async poll({ root, apiKey, taskId, deadlineAt }) {
    const { res, json, text } = await fetchJson(
      `${root}/replicate/v1/predictions/${encodeURIComponent(taskId)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        errorMessage(json) || `Replicate 视频查询失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    return json
  },
  /** `output` 可能是裸字符串,也可能是数组(`replicate/adaptor.go:278-292`)。 */
  extractUrl(payload) {
    const output = asObject(payload)?.output
    if (Array.isArray(output)) {
      return trim(output[0])
    }
    return trim(output)
  },
  statusOf,
  errorOf(payload) {
    const err = asObject(payload)?.error
    return typeof err === 'string' ? trim(err) : errorMessage(payload)
  },
  isTerminal(payload) {
    const status = statusOf(payload)
    if (status === 'succeeded') {
      return 'ok'
    }
    if (status === 'failed' || status === 'canceled' || status === 'cancelled') {
      return 'fail'
    }
    return 'pending'
  }
}

/**
 * fal-ai。提交是 `POST /fal-ai/{模型名去掉 fal-ai/ 前缀}`,平台**从路径里认模型**
 * (`middleware/distributor.go:2101-2119`),请求体是自由 map(`dto/falai.go:4`,
 * `Validate()` 恒过),所以字段是给上游看的。查询是
 * `GET /fal-ai/{模型}/requests/{request_id}`(`falai/adaptor.go:261`)。
 *
 * 目录里今天六条,其中带 `/image-to-video` 的两条**只能图生**(名字里就写着,
 * 与百炼按名字分动作同一个路子),其余四条文生。
 */
const falAdapter = {
  id: 'fal',
  endpointTypes: new Set(),
  matchesType: (type, id) => id.startsWith('fal-ai/') && isPerModelAsyncType(type, id),
  fallbackModels: ['fal-ai/veo3', 'fal-ai/veo3/fast'],
  verifiedDurations: {},
  maxInputImagesFor: (model) => (model.includes('/image-to-video') ? 1 : 0),
  async submit({ root, apiKey, model, prompt, aspectRatio, inputImages, deadlineAt }) {
    const wantsImage = model.includes('/image-to-video')
    const image = firstReferenceImage(inputImages)
    if (wantsImage && !image) {
      throw new Error(`fal 的「${model}」是图生模型,必须给一张参考图`)
    }
    const body = {
      prompt,
      aspect_ratio: aspectRatio || '16:9',
      ...(wantsImage ? { image_url: image } : {})
    }
    const { res, json, text } = await fetchJson(
      `${root}/fal-ai/${model.replace(/^fal-ai\//, '')}`,
      { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        errorMessage(json) || `fal 视频提交失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    const id = trim(asObject(json)?.request_id) ?? taskIdOf(json)
    if (!id) {
      throw new Error(errorMessage(json) || 'fal 视频提交响应缺少 request_id')
    }
    // 查询的 URL 里要带模型名,而轮询那边只拿得到 taskId,所以把模型放进 submitContext。
    return { taskId: id, submitted: json, submitContext: { model } }
  },
  async poll({ root, apiKey, taskId, submitContext, deadlineAt }) {
    const model = trim(submitContext?.model) ?? 'veo3'
    const { res, json, text } = await fetchJson(
      `${root}/fal-ai/${model.replace(/^fal-ai\//, '')}/requests/${encodeURIComponent(taskId)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
      deadlineAt
    )
    if (!res.ok) {
      throw new Error(
        errorMessage(json) || `fal 视频查询失败 HTTP ${res.status}: ${text.slice(0, 200)}`
      )
    }
    return json
  },
  extractUrl(payload) {
    return trim(asObject(asObject(payload)?.video)?.url)
  },
  statusOf,
  errorOf(payload) {
    return trim(asObject(asObject(payload)?.error)?.message) ?? errorMessage(payload)
  },
  /**
   * 这一家**没完成时回状态、完成时回结果**(`falai/adaptor.go:299-319`:有 video 就算成功,
   * 既无 error 又无结果就当还在跑),所以完成判据是「拿到 video」,不是某个状态字面量。
   */
  isTerminal(payload) {
    if (falAdapter.extractUrl(payload)) {
      return 'ok'
    }
    const status = statusOf(payload)
    if (status === 'failed' || asObject(asObject(payload)?.error)) {
      return 'fail'
    }
    return 'pending'
  }
}

/**
 * 后续厂商适配器往这里挂,骨架只认 endpointTypes / fallbackModels / verifiedDurations
 * + submit / poll / extractUrl / isTerminal 这几项(端点类型分不开模式时再加一个 `claims`;
 * 类型名逐模型的加 `matchesType`;成品要带鉴权才下得动的加 `downloadHeaders`)。
 * 加一家不用动骨架。
 *
 * **顺序有意义**:一个模型可能挂多个端点类型(`sora-2-pro` 同时是 `Unified video format`
 * 与 `OpenAI official video format`),`adapterFor` 取第一个命中的。统一那条在前,
 * 因为它的形状是真机验过的。
 */
const ADAPTERS = [
  unifiedAdapter,
  klingAdapter,
  klingTurboAdapter,
  viduAdapter,
  hailuoAdapter,
  pixverseAdapter,
  bailianAdapter,
  grokAdapter,
  soraAdapter,
  runwayAdapter,
  lumaAdapter,
  replicateAdapter,
  falAdapter
]

/**
 * 按 live 目录挑适配器,连同这个模型在目录里认领的**端点类型**一起给出去。
 *
 * 类型要往下带,是因为有的家把「模式」编码在类型名里而不是模型名里(Vidu 的
 * 文生 / 图生 / 首尾帧 / 参考生四条路径),适配器得据此选路。不关心的家忽略即可。
 * 目录拉不到时给空数组 —— 适配器自己决定「不知道」时怎么退。
 *
 * 挑不中时的报错分三种,因为这三种的处置完全不同:目录里有但归别家管(等适配器)、
 * 目录里根本没有(上游下架或这把 key 没权限)、目录拉不到(网络/凭证)。
 * 第一版只有一句「暂不支持」,用户无法判断该等我们还是去换模型。
 */
async function pickAdapter(model, creds) {
  const catalog = await readCatalog(creds)
  // 离线兜底**只在目录拉不到时**生效(断网、凭证失效、站点抖动)。目录拉到了就以它为准,
  // 哪怕结果是"一条统一接口视频模型都没有" —— 那是这个站点/这把 key 的真实情况,
  // 报出来比拿写死的清单去撞上游更有用。
  //
  // (这里曾经有一条"目录里 0 条就退回兜底"的岔路,理由是开发机上视频能力不该凭空消失。
  //  依据是错的:那台开发机指向本地站,而本地站根本打不通模型 —— 要打模型就该打海外线上站。
  //  用错的环境当基准,代码就会长出只为迁就它而存在的分支。)
  if (catalog) {
    const entry = catalog.claimed.get(model)
    const hit = entry ? ADAPTERS.find((a) => a.id === entry.adapterId) : undefined
    if (hit) {
      return { adapter: hit, endpointTypes: entry.types ?? [] }
    }
    const usable = [...catalog.claimed.keys()]
    const foreign = catalog.foreign.get(model)
    if (foreign) {
      throw new Error(
        `模型「${model}」走的是专属视频接口(${foreign.types.join(' / ')}),云雾视频插件还没接这一家。` +
          (usable.length > 0
            ? `当前支持:${usable.join(', ')}`
            : '这个站点目录里也没有已接入的视频模型。')
      )
    }
    throw new Error(
      `这把 key 的模型目录里没有「${model}」(可能已下架或无权限)。` +
        (usable.length > 0
          ? `当前可用的视频模型:${usable.join(', ')}`
          : '这个站点也没有任何已接入的视频模型 —— 开发期常见于把地址指到了本地站,模型要打海外线上站。')
    )
  }
  const offline = ADAPTERS.find((a) => a.fallbackModels.includes(model))
  if (offline) {
    return { adapter: offline, endpointTypes: [] }
  }
  throw new Error(
    `拉取云雾模型目录失败,且「${model}」不在离线兜底清单里。兜底清单:${allFallbackModels().join(', ')}`
  )
}

/** 各家适配器的离线兜底清单并起来。 */
function allFallbackModels() {
  return ADAPTERS.flatMap((a) => a.fallbackModels)
}

/** 只把**验过**的时长交给内核;没验的模型不出现在这张表里(见 UNIFIED_DURATIONS 注释)。 */
function durationByModel() {
  return Object.assign({}, ...ADAPTERS.map((a) => a.verifiedDurations))
}

/**
 * 逐模型的「收几张参考图」——**静态那一份**,只覆盖离线兜底清单里的模型。
 *
 * 它是同步的,而模型目录要走网络,所以这里给不出「按端点类型算出来」的那个答案
 * (同一族里 `viduq1-classic` 认领首尾帧、`viduq3-pro` 不认,张数就不一样)。
 * 真正的答案由下面的 `resolveModelCapabilities` 现算,这份只是它拿不到目录时的底。
 */
function imageToVideoByModel() {
  const table = {}
  for (const adapter of ADAPTERS) {
    for (const model of adapter.fallbackModels) {
      // 没实现图生的家整族给 0;实现了的自己说每个模型收几张(可灵是同一个 id 两条路径,
      // 所以它整族都是 1;百炼要按 -t2v / -i2v 分)。
      table[model] = adapter.maxInputImagesFor?.(model, []) ?? 0
    }
  }
  return table
}

/**
 * 内核的**逐模型能力钩子**:每次请求前它先问一遍这个模型的真实能力,再拿答案去卡参考图张数
 * (`video-generation/runtime.ts:168-192` —— 先 `resolveProviderWithModelCapabilities`,
 * 后 `buildReferenceInputCapabilityFailure`)。返回值与静态声明是 merge 而不是替换,
 * 抛错会被内核吞掉并退回静态声明(`capability-overlays.ts:174-179`),所以这条路是安全的。
 *
 * **为什么非用它不可**:参考图张数在我们这儿不是模型属性,是「模型认领了哪条端点类型」的属性,
 * 而端点类型只有拉过目录才知道。上面那张静态表既拿不到目录、也只覆盖兜底清单里的名字,
 * 于是 2026-08-17 傍晚出过一个死路:Vidu 首尾帧要两张图,`viduRoute` 里那条分支写好了,
 * 但整族声明的是 1 张 —— 内核在到达我们之前就把两张图的请求挡了,那条分支一次都执行不到。
 * 拿内核真代码复验过:`viduq3-turbo` 给两张回
 * `supports at most 1 reference image(s), 2 requested; skipping`。
 *
 * 逐模型表在内核那侧是**后于** mode 级值生效的(`capabilities.ts:68-83` 先读
 * `maxInputImagesByModel[model]` 再覆盖 `maxInputImages`),所以两处都要写,
 * 只改 mode 级会被静态表里那个旧值盖回去。
 */
async function resolveVideoModelCapabilities({ cfg, model }) {
  const creds = resolveYunwuCredentials(cfg)
  const name = trim(model)
  if (!creds || !name) {
    return undefined
  }
  let picked
  try {
    picked = await pickAdapter(name, creds)
  } catch {
    // 目录里没有 / 归还没接的一家 —— 交给静态声明,报错留给 generateVideo 说得更清楚。
    return undefined
  }
  const maxInputImages = picked.adapter.maxInputImagesFor?.(name, picked.endpointTypes) ?? 0
  return {
    imageToVideo: {
      enabled: true,
      maxInputImages,
      maxInputImagesByModel: { [name]: maxInputImages }
    }
  }
}

/**
 * 给内核的 live 目录钩子。形状照 `openclaw/extensions/openrouter/index.ts:366-370`
 * (它也是 `kinds:['video_generation'] + liveCatalog`)。
 *
 * 同一插件对同一 provider 重复注册目录不会冲突,内核会把 staticCatalog / liveCatalog
 * 合并(`plugins/model-catalog-registration.ts:103-127`)—— 所以这份 live 行是叠在
 * `registerVideoGenerationProvider` 自动合成的那份静态行之上的。
 */
async function listVideoModelCatalog(ctx) {
  const creds = resolveYunwuCredentials(ctx?.config)
  if (!creds) {
    return null
  }
  const catalog = await readCatalog(creds)
  // 拉不到才返 null(内核退回 provider.models 合成的静态行);拉到了就照实回,
  // 空数组也是一种事实。
  if (!catalog) {
    return null
  }
  const durations = durationByModel()
  const rows = []
  for (const [model, meta] of catalog.claimed) {
    const row = {
      kind: 'video_generation',
      provider: PROVIDER_ID,
      model,
      source: 'live',
      fetchedAt: catalog.at,
      expiresAt: catalog.at + CATALOG_TTL_MS
    }
    // tags 形如「异步,视频,首尾帧」,直接当标签展示;它也是后面判图生视频的线索。
    if (meta.tags) {
      row.label = `${model}(${meta.tags})`
    }
    if (durations[model]) {
      row.capabilities = { generate: { supportedDurationSeconds: durations[model] } }
    }
    rows.push(row)
  }
  return rows
}

async function downloadVideo(url, deadlineAt, maxBytes, headers) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), remainingMs(deadlineAt))
  try {
    // 默认**不带** Authorization:`video_url` 一般是上游预签名直链,带了反而可能被拒。
    // 例外由适配器自己说(`downloadHeaders`):sora 的成品不给直链,只有**我们站上**的
    // `/v1/videos/{id}/content`(`relay/channel/task/sora/adaptor.go:806`),那条必须带 key。
    const res = await fetch(url, { method: 'GET', signal: controller.signal, headers })
    if (!res.ok) {
      throw new Error(`云雾视频下载失败 HTTP ${res.status}`)
    }
    const mimeType = res.headers.get('content-type')?.trim() || 'video/mp4'
    const ab = await res.arrayBuffer()
    if (ab.byteLength > maxBytes) {
      throw new Error(`云雾视频超过 ${maxBytes} 字节上限`)
    }
    return { buffer: Buffer.from(ab), mimeType, fileName: 'video-1.mp4' }
  } finally {
    clearTimeout(timer)
  }
}

/** 产物体积上限:跟内核的 `agents.defaults.mediaMaxMb` 同一个旋钮,没配就用插件默认。 */
function resolveMaxBytes(cfg) {
  const mb = asObject(asObject(cfg)?.agents)?.defaults?.mediaMaxMb
  if (typeof mb === 'number' && Number.isFinite(mb) && mb > 0) {
    return Math.floor(mb * 1024 * 1024)
  }
  return DEFAULT_MAX_BYTES
}

/**
 * 按魔数认图片类型。
 *
 * 为什么不用内核的 `sniffImageMimeType`:插件是零依赖的 plain ESM(入口会被内核转成
 * CommonJS,复杂别名容易静默加载失败,见文件头),不 import 内核模块。b64 分支拿不到
 * Content-Type,认错类型会让落盘文件扩展名与内容不符。
 */
function sniffImageMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png'
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('latin1').startsWith('GIF8')) {
    return 'image/gif'
  }
  return 'image/png'
}

function imageExtension(mimeType) {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  if (mimeType === 'image/gif') return 'gif'
  return 'png'
}

/** 下载 url 形式的出图产物。与视频同理:预签名直链,带 Authorization 反而可能被拒。 */
async function downloadImage(url, deadlineAt, maxBytes) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), remainingMs(deadlineAt))
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal })
    if (!res.ok) {
      throw new Error(`云雾出图下载失败 HTTP ${res.status}`)
    }
    const ab = await res.arrayBuffer()
    if (ab.byteLength > maxBytes) {
      throw new Error(`云雾出图产物超过 ${maxBytes} 字节上限`)
    }
    const buffer = Buffer.from(ab)
    const headerMime = res.headers.get('content-type')?.split(';')[0]?.trim()
    const mimeType = headerMime?.startsWith('image/') ? headerMime : sniffImageMime(buffer)
    return { buffer, mimeType }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把 `/v1/images/*` 的响应转成内核要的产物数组。
 *
 * 两种响应都吃:`b64_json`(gpt-image / seedream / grok-imagine)与 `url`
 * (qwen-image-3.0 / z-image-turbo,2026-08-13 实测即便显式要 b64 也照样返 url)。
 * 内核自带的解析器只认前者,这也是这个 provider 存在的理由。
 */
async function imageAssetsFrom(payload, deadlineAt, maxBytes) {
  const rows = Array.isArray(asObject(payload)?.data) ? payload.data : []
  const assets = []
  for (const [index, row] of rows.entries()) {
    const entry = asObject(row)
    if (!entry) {
      continue
    }
    const b64 = trim(entry.b64_json)
    let buffer
    let mimeType
    if (b64) {
      buffer = Buffer.from(b64, 'base64')
      mimeType = trim(entry.mime_type) ?? sniffImageMime(buffer)
      if (buffer.length > maxBytes) {
        throw new Error(`云雾出图产物超过 ${maxBytes} 字节上限`)
      }
    } else {
      const url = trim(entry.url)
      if (!url) {
        continue
      }
      const downloaded = await downloadImage(url, deadlineAt, maxBytes)
      buffer = downloaded.buffer
      mimeType = downloaded.mimeType
    }
    const asset = {
      buffer,
      mimeType,
      fileName: `image-${index + 1}.${imageExtension(mimeType)}`
    }
    const revised = trim(entry.revised_prompt)
    if (revised) {
      asset.revisedPrompt = revised
    }
    assets.push(asset)
  }
  return assets
}

/**
 * 出图模型的归属校验,顺带回报**它走哪条路**:`viaChat` 决定发 `/v1/chat/completions`,
 * `adapter` 非空决定走厂商异步那条,都不是就是 OpenAI 兼容的 `/v1/images/generations`。
 * 报错分三种,和视频那侧同一口径:目录里有但不在出图端点上、目录里根本没有、目录拉不到
 * —— 三者的处置完全不同(换模型 / 权限或下架 / 网络)。
 */
async function assertImageModel(model, creds, needEdit) {
  const catalog = await readCatalog(creds)
  if (!catalog) {
    if (IMAGE_FALLBACK_MODELS.includes(model)) {
      return {
        viaChat: IMAGE_CHAT_FALLBACK_MODELS.has(model),
        adapter: imageAsyncAdapterById(IMAGE_ASYNC_FALLBACK_MODELS.get(model))
      }
    }
    throw new Error(
      `拉取云雾模型目录失败,且「${model}」不在出图离线兜底清单里。兜底清单:${IMAGE_FALLBACK_MODELS.join(', ')}`
    )
  }
  const entry = catalog.images.get(model)
  const usable = [...catalog.images.keys()]
  if (!entry) {
    throw new Error(
      `模型「${model}」不在这把 key 的出图端点上(可能已下架、无权限,或它走的是我们还没接的厂商专属出图接口)。` +
        (usable.length > 0 ? `当前可用的出图模型:${usable.join(', ')}` : '这个站点目录里也没有可用的出图模型。')
    )
  }
  if (needEdit && !entry.canEdit) {
    const editable = usable.filter((id) => catalog.images.get(id)?.canEdit)
    throw new Error(
      `模型「${model}」只能文生图,不支持按参考图编辑。` +
        (editable.length > 0 ? `可编辑的模型:${editable.join(', ')}` : '这把 key 没有支持编辑的出图模型。')
    )
  }
  // 反过来的那一半:只做图片混合的模型(mj_blend)接不了「凭一句话出图」。内核这侧没有
  // 逐模型旋钮可以提前跳过它(理由见 mjBlendAdapter 的注释),所以在这里尽早报清楚,
  // 让内核顺着 fallbacks 往下走时只花一次本地往返。
  if (!needEdit && entry.editOnly) {
    const plain = usable.filter((id) => !catalog.images.get(id)?.editOnly)
    throw new Error(
      `模型「${model}」只做图片混合,必须给参考图,接不了纯文字出图。` +
        (plain.length > 0 ? `可以凭一句话出图的模型:${plain.join(', ')}` : '')
    )
  }
  return {
    viaChat: entry.viaChat === true,
    adapter: entry.adapterId ? imageAsyncAdapterById(entry.adapterId) : undefined
  }
}

function buildProvider() {
  return {
    id: PROVIDER_ID,
    label: '云雾视频',
    defaultModel: DEFAULT_MODEL,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    // 静态种子而非权威清单:真正的归属判定在 pickAdapter,按 live 端点类型走。
    models: allFallbackModels(),
    isConfigured: ({ cfg }) => Boolean(resolveYunwuCredentials(cfg)),
    // 参考图张数按 live 目录现算,见函数注释(静态那份只是它拉不到目录时的底)。
    resolveModelCapabilities: resolveVideoModelCapabilities,
    capabilities: {
      generate: {
        maxVideos: 1,
        // 刻意**不给** mode 级 supportedDurationSeconds:内核解析顺序是
        // `modelSpecific ?? caps.supportedDurationSeconds`(`duration-support.ts:39`),
        // 给了它就成了未验模型的兜底,把豆包的请求也吸附到 veo 的 4/6/8 上。
        // 只声明逐模型的那几条,其余模型走运行时校验(原样透传,不吸附)。
        supportedDurationSecondsByModel: durationByModel(),
        supportsAspectRatio: true,
        aspectRatios: ASPECT_RATIOS
      },
      imageToVideo: {
        // 2026-08-13 打开:内核这条链本来就通(`video_generate` 的 `image` / `images` /
        // `imageRoles` 一直在 schema 里),参考图的交付形状也验过了(URL 直通 / buffer 拼 data URI,
        // 见 firstReferenceImage)。已接:百炼/万相(`input.img_url`)、可灵 v1(三条路径按张数
        // 换 action,2~4 张走多图参考)、可灵 3.0 turbo(图生是**另一条路由**,体是 contents 数组)、
        // Vidu(四条路径按端点类型选,见 viduRoute)、海螺(`first_frame_image`,不换路径)、
        // PixVerse(先上传换 img_id,再按张数走 img / transition —— 上传那条渠道今天在平台侧
        // 不通,但请求是对的,见 pixverseUploadImage)。还没接的只剩 sora / Runway / Luma /
        // Replicate / fal-ai 这几家新厂商的图生(它们的 maxInputImagesFor 都报 0)。
        enabled: true,
        maxVideos: 1,
        // 下面这两个都只是**底**:每次请求前 `resolveModelCapabilities` 会按 live 目录
        // 现算一遍并盖掉它们(见 resolveVideoModelCapabilities 的注释)。留着是为了目录
        // 拉不到的那条路 —— 那时候只认得兜底清单里的名字。
        maxInputImages: 1,
        // **逐模型收窄**:只能文生的模型给 0,内核就会在图生请求里跳过它而不是硬试
        // (`video-generation/runtime.ts:185-205` 的 buildReferenceInputCapabilityFailure)。
        // 这是内核给的现成旋钮,比我们自己在 submit 里抛错更早、更省一个往返。
        maxInputImagesByModel: imageToVideoByModel(),
        supportsAspectRatio: true,
        aspectRatios: ASPECT_RATIOS
      },
      videoToVideo: {
        enabled: false
      }
    },
    async generateVideo(req) {
      // 参考**视频**那条(videoToVideo)仍然没接:百炼 `-video-edit` 要一个公网视频 URL,
      // 而内核这条链给不出来。参考图从 2026-08-13 起支持,见 capabilities.imageToVideo。
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error('云雾视频插件当前不支持以视频为输入(video-to-video)')
      }
      const creds = resolveYunwuCredentials(req.cfg)
      if (!creds) {
        throw new Error('云雾视频未配置:models.providers.yunwu 缺少 baseUrl 或 apiKey')
      }
      const model = trim(req.model) || DEFAULT_MODEL
      const { adapter, endpointTypes } = await pickAdapter(model, creds)
      const timeoutMs =
        typeof req.timeoutMs === 'number' && req.timeoutMs > 0 ? req.timeoutMs : DEFAULT_TIMEOUT_MS
      const deadlineAt = Date.now() + timeoutMs
      const maxBytes = (() => {
        const mb = req.cfg?.agents?.defaults?.mediaMaxMb
        if (typeof mb === 'number' && Number.isFinite(mb) && mb > 0) {
          return Math.floor(mb * 1024 * 1024)
        }
        return DEFAULT_MAX_BYTES
      })()

      const { taskId, submitted, ignoredAspectRatio, submitContext } = await adapter.submit({
        baseUrl: creds.baseUrl,
        root: creds.root,
        apiKey: creds.apiKey,
        model,
        prompt: req.prompt,
        aspectRatio: req.aspectRatio,
        durationSeconds: req.durationSeconds,
        inputImages: req.inputImages,
        endpointTypes,
        deadlineAt
      })

      let payload = submitted
      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
        const terminal = adapter.isTerminal(payload)
        if (terminal === 'ok') {
          break
        }
        if (terminal === 'fail') {
          throw new Error(adapter.errorOf(payload) || `云雾视频任务 ${taskId} 失败`)
        }
        if (Date.now() >= deadlineAt) {
          throw new Error(`云雾视频任务 ${taskId} 超时`)
        }
        await sleep(POLL_INTERVAL_MS)
        payload = await adapter.poll({
          baseUrl: creds.baseUrl,
          root: creds.root,
          apiKey: creds.apiKey,
          taskId,
          submitContext,
          deadlineAt
        })
      }

      // 第二个参数是给「成品不在响应体里」的家用的:sora 的成品挂在固定路径
      // `/v1/videos/{id}/content` 上,得拿 baseUrl 与任务号现拼(见 soraAdapter)。
      const videoUrl = adapter.extractUrl(payload, { baseUrl: creds.baseUrl, taskId })
      if (!videoUrl) {
        throw new Error(`云雾视频任务 ${taskId} 完成但没有 video_url`)
      }
      const video = await downloadVideo(
        videoUrl,
        deadlineAt,
        maxBytes,
        adapter.downloadHeaders?.({ baseUrl: creds.baseUrl, apiKey: creds.apiKey })
      )
      return {
        videos: [
          {
            buffer: video.buffer,
            mimeType: video.mimeType,
            fileName: video.fileName
          }
        ],
        model,
        metadata: {
          jobId: taskId,
          videoUrl,
          status: adapter.statusOf(payload) || 'completed',
          adapter: adapter.id,
          // 上游接不了比例时适配器会回报被丢掉的值(目前只有海螺)。内核的视频能力没有
          // aspectRatiosByModel,没法只对一家收窄,所以只能事后说明,不能事前拦。
          ...(ignoredAspectRatio ? { ignoredAspectRatio } : {})
        }
      }
    }
  }
}

/**
 * 记住「这个模型不收 `response_format`」。只活在本次进程:换 key、换上游都该重新试一次,
 * 而不是把一条上游今天的行为腌成永久配置。
 */
const IMAGE_RESPONSE_FORMAT_REJECTORS = new Set()

/**
 * 上游是不是在说「我不认 `response_format` 这个参数」。
 *
 * **判据只看响应体,不看状态码** —— 云雾把这个参数校验错误包在 HTTP **429** 里返回
 * (2026-08-17 实测:`gpt-image-1.5` / `gpt-image-1` 带这个参数就 429
 * `{"error":{"message":"Unknown parameter: 'response_format'.","param":"response_format",
 * "code":"unknown_parameter"}}`),按状态码判会误当成限流去重试,重试多少次都还是这一条。
 * 与可灵把余额不足包进 429 是同一个坑。
 */
function rejectsResponseFormat(payload) {
  const err = asObject(asObject(payload)?.error)
  if (!err) {
    return false
  }
  if (trim(err.param) === 'response_format') {
    return true
  }
  return /unknown\s+parameter[^\n]{0,40}response_format/i.test(String(err.message ?? ''))
}

/**
 * 「先按老口径发 `response_format`,被拒就去掉重发一次」。
 *
 * 为什么不直接一律不发:2026-08-13 实测补上它之后 `doubao-seedream-4-0-250828` /
 * `grok-imagine-image` 才返 b64,不发就返 url、要多下一次(见文件头)。为什么不能一直发:
 * 2026-08-17 实测新一代 `gpt-image-1.5` / `gpt-image-1` **带就必败、不带就 200 返 b64**,
 * 而它俩正是配置里的两级兜底 —— 主用饱和时整条兜底链会被我们自己这个参数打死。
 * 所以两边都要:快路保住,被拒的那一发花 0.6~1.8 秒(参数校验就被挡,不烧算力)。
 */
async function sendImageRequestWithFormatFallback({ model, send }) {
  const skip = IMAGE_RESPONSE_FORMAT_REJECTORS.has(model)
  const first = await send(!skip)
  if (skip || !rejectsResponseFormat(first.json)) {
    return first
  }
  IMAGE_RESPONSE_FORMAT_REJECTORS.add(model)
  return send(false)
}

/** 文生图:`POST /v1/images/generations`。`response_format` 的取舍见上面那个包装。 */
async function postImageGenerate({ creds, model, prompt, count, size, deadlineAt }) {
  return sendImageRequestWithFormatFallback({
    model,
    send: (withResponseFormat) =>
      fetchJson(
        `${creds.baseUrl}/images/generations`,
        {
          method: 'POST',
          headers: authHeaders(creds.apiKey),
          body: JSON.stringify({
            model,
            prompt,
            n: count,
            size,
            ...(withResponseFormat ? { response_format: 'b64_json' } : {})
          })
        },
        deadlineAt
      )
  })
}

/**
 * 图生图 / 局部重绘:`POST /v1/images/edits`,**multipart**。
 *
 * 2026-08-13 实测:multipart + 字段名 `image` → HTTP 200 回 b64_json(1024×1024 约 100 秒)。
 * 内核 litellm 槽位发的是 JSON(`{images:[{image_url:dataUrl}]}`,
 * `extensions/litellm/image-generation-provider.ts:125-136`),那条形状云雾不收 ——
 * 所以「换成我们自己的 provider」这件事在编辑上不是回归,是修好。
 *
 * 多图沿用 OpenAI 的 `image[]` 约定(gpt-image 系列的多参考图编辑)。
 */
async function postImageEdit({ creds, model, prompt, count, size, inputImages, deadlineAt }) {
  // 编辑这条路也过同一个包装:拒收 response_format 是模型的事,与请求是 JSON 还是 multipart 无关。
  return sendImageRequestWithFormatFallback({
    model,
    send: (withResponseFormat) => {
      const form = new FormData()
      form.append('model', model)
      form.append('prompt', prompt)
      form.append('n', String(count))
      form.append('size', size)
      if (withResponseFormat) {
        form.append('response_format', 'b64_json')
      }
      const field = inputImages.length > 1 ? 'image[]' : 'image'
      for (const [index, image] of inputImages.entries()) {
        const mimeType = trim(image.mimeType) ?? sniffImageMime(image.buffer)
        const name = trim(image.fileName) ?? `source-${index + 1}.${imageExtension(mimeType)}`
        form.append(field, new Blob([image.buffer], { type: mimeType }), name)
      }
      // multipart 的 boundary 由 FormData 自己带,不能套 authHeaders(它写死了 Content-Type)。
      return fetchJson(
        `${creds.baseUrl}/images/edits`,
        { method: 'POST', headers: { Authorization: `Bearer ${creds.apiKey}` }, body: form },
        deadlineAt
      )
    }
  })
}

/**
 * 聊天式出图:`POST /v1/chat/completions`,图以 markdown data URI 回在助手正文里。
 *
 * 只给 Gemini 图像族用(判据见 `isChatImageModel`)。两种形状都是 2026-08-17 真机验过的:
 *  - 文生:`content` 直接给字符串 → 8.9 秒回 796,101 B 的 PNG;
 *  - 改图:`content` 给 `[{type:'text'},{type:'image_url'}]`,参考图用 data URI →
 *    10.2 秒回 691,276 B 的 PNG,`prompt_tokens` 288→478 说明图真被读进去了。
 *    平台把 `image_url` 转成 Gemini 的 inlineData:`relay-gemini.go:596-606`。
 *
 * **`n` 与 `size` 这条路上没有对应参数**,一律不发:chat 端点没有这两个字段,自己拼
 * 「请画 4 张」只会得到一张拼贴图。被丢掉的值由调用方回报给用户(`ignoredSize` /
 * `ignoredCount`),与视频那侧海螺丢比例同一个形状 —— 内核的出图能力只有模式级 `maxCount`
 * (`openclaw/src/image-generation/types.ts:91-96` 没有 `maxCountByModel`),没法只对这几条收窄,
 * 所以只能事后说明,不能事前拦。
 */
async function postChatImage({ creds, model, prompt, inputImages, deadlineAt }) {
  const content = [{ type: 'text', text: prompt }]
  for (const image of inputImages) {
    const mimeType = trim(image.mimeType) ?? sniffImageMime(image.buffer)
    content.push({
      type: 'image_url',
      image_url: { url: `data:${mimeType};base64,${image.buffer.toString('base64')}` }
    })
  }
  return fetchJson(
    `${creds.baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: authHeaders(creds.apiKey),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: inputImages.length > 0 ? content : prompt }]
      })
    },
    deadlineAt
  )
}

/** 助手正文里的 markdown data URI。平台就是这么拼的(`relay-gemini.go:1096`、`:1173`)。 */
const CHAT_IMAGE_PATTERN = /!\[[^\]]*\]\(data:(image\/[\w+.-]+);base64,([A-Za-z0-9+/=]+)\)/g

/**
 * 把聊天式出图的响应转成内核要的产物数组,并把图之外的正文原样带出来。
 *
 * 那段正文有用:模型拒绝作图(内容审查、要求补充细节)时**响应是完好的 200**,
 * `finish_reason` 也还是 `stop`,只是没有图 —— 与联网搜索那条「不报错但只给半句话」同形。
 * 所以拿不到图时要把它当报错抛出去,否则用户只看到「没有可用产物」。
 */
function chatImageAssetsFrom(payload, maxBytes) {
  const message = asObject(asObject(asObject(payload)?.choices?.[0])?.message)
  const content = typeof message?.content === 'string' ? message.content : ''
  const assets = []
  for (const [index, match] of [...content.matchAll(CHAT_IMAGE_PATTERN)].entries()) {
    const buffer = Buffer.from(match[2], 'base64')
    if (buffer.length > maxBytes) {
      throw new Error(`云雾出图产物超过 ${maxBytes} 字节上限`)
    }
    const mimeType = match[1].startsWith('image/') ? match[1] : sniffImageMime(buffer)
    assets.push({
      buffer,
      mimeType,
      fileName: `image-${index + 1}.${imageExtension(mimeType)}`
    })
  }
  return { assets, note: content.replace(CHAT_IMAGE_PATTERN, '').trim() }
}

/**
 * 尺寸只取**朝向**。
 *
 * 厂商异步那两家都不收像素尺寸:MJ 只有三档 `dimensions`、可灵只有 `aspect_ratio`。
 * 所以把用户要的 size 折成朝向去用它们现成的旋钮,折不掉的那部分(具体像素)回报成
 * `ignoredSize` —— 与海螺丢比例、对话端点丢 size 同一个形状:事后说明,不事前拦。
 *
 * 5% 的容差是为了别把 1024×1080 这种近方图判成竖图。
 */
function imageOrientation(size) {
  const matched = /^(\d+)\s*[x×]\s*(\d+)$/.exec(trim(size) ?? '')
  if (!matched) {
    return 'square'
  }
  const width = Number(matched[1])
  const height = Number(matched[2])
  if (width > height * 1.05) {
    return 'landscape'
  }
  if (height > width * 1.05) {
    return 'portrait'
  }
  return 'square'
}

/**
 * 参考图交给上游的两种形状。内核给出图 provider 的 `inputImages` 只有 `{buffer, mimeType}`
 * ——**没有 url 字段**(`openclaw/src/image-generation/types.ts:52-57`,与视频那侧的
 * `VideoGenerationSourceAsset` 不同),所以两种都从 buffer 拼。
 *
 *  - MJ 的 `base64Array` 要**带前缀**的 data URI:平台自己的 Lab 就是把上传得到的 data URL
 *    原样塞进去(`buildImageRequest.js:115-119`,uploader 开的是 `base64Mode`);
 *  - 可灵的 `image` / `image_list[].image` 要**裸 base64**:官方契约明确写「不要带
 *    `data:image/png;base64,` 前缀」,平台侧对前缀不做任何处理(整个
 *    `relay/channel/task/kling/` 里搜 `data:image` 零命中),即前缀会原样发给上游。
 */
function imageDataUri(image) {
  const mimeType = trim(image?.mimeType) ?? sniffImageMime(image.buffer)
  return `data:${mimeType};base64,${image.buffer.toString('base64')}`
}

function imageBase64(image) {
  return image.buffer.toString('base64')
}

/**
 * MJ 的失败信息。两种形状都要认:
 *  - 网关自己拒的:`{description, type:"upstream_error", code}`(`controller/relay.go:1067-1071`);
 *  - 轮询到的任务失败:`failReason`(`dto/midjourney.go:60`)。
 */
function mjError(json) {
  const obj = asObject(json)
  return trim(obj?.failReason) ?? trim(obj?.description)
}

/**
 * MJ 提交:`POST {站点根}/mj/submit/<action>`。**挂在站点根,不在 `/v1` 下**
 * (`router/relay-router.go:124`、`:558`、`:562`)。
 *
 * 回执 `{code, description, result, properties}`:**成功码是 1**,而且网关会把 21(任务已存在)
 * 与 22(排队中)也改写成 1(`relay/relay-mj.go:1314-1337`),所以客户端只会看到 1。
 * `result` 就是 task id(`relay/relay-mj.go:916` 拿它当 MjId 落库)。
 * 其余码的含义写在 `relay/relay-mj.go:904-910`:23 队列已满、24 提示词含敏感词。
 */
async function mjSubmit({ root, apiKey, action, body, deadlineAt }) {
  const { res, json, text } = await fetchJson(
    `${root}/mj/submit/${action}`,
    { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) },
    deadlineAt
  )
  if (!res.ok) {
    throw new Error(mjError(json) || `MJ 出图提交失败 HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  if (asObject(json)?.code !== 1) {
    throw new Error(mjError(json) || `MJ 出图提交被拒: ${text.slice(0, 200)}`)
  }
  const taskId = trim(asObject(json)?.result)
  if (!taskId) {
    throw new Error(mjError(json) || 'MJ 出图提交响应缺少 result(task id)')
  }
  return { taskId, submitted: json }
}

/**
 * MJ 轮询:`GET {站点根}/mj/task/<id>/fetch`,**读的是网关本地库**
 * (`relay/relay-mj.go:407-417`),库由后台每 15 秒回源刷一次
 * (`controller/midjourney.go:37-41`)。轮得比 15 秒快只是把发现延迟压小,不会更快出图。
 */
async function mjPoll({ root, apiKey, taskId, deadlineAt }) {
  const { res, json, text } = await fetchJson(
    `${root}/mj/task/${encodeURIComponent(taskId)}/fetch`,
    { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
    deadlineAt
  )
  if (!res.ok) {
    throw new Error(mjError(json) || `MJ 出图查询失败 HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  return json
}

function mjStatusOf(payload) {
  return trim(asObject(payload)?.status)?.toUpperCase()
}

/**
 * MJ 的完成 / 失败判据,与平台自己的 Lab 同一份
 * (`web/src/pages/Lab/capability/pollContracts.js:357-369` 的 `mjContract`:
 * `isSuccess: s === 'SUCCESS'` / `isFailure: s === 'FAILURE'`),再补一条网关内部也在用的
 * `failReason` 非空(`controller/midjourney.go:370`)。
 *
 * **不能拿「有没有 imageUrl」当完成**:未完成时网关也返 imageUrl,只是尾巴上挂了个
 * `?rand=<纳秒>` 用来打穿缓存(`relay/relay-mj.go:151-155`)—— 那时候下它拿到的是半成品
 * 或 404。这正是 PixVerse 那条坑的同款,所以这里只认状态。
 */
function mjTerminal(payload) {
  const status = mjStatusOf(payload)
  if (status === 'SUCCESS') {
    return 'ok'
  }
  if (status === 'FAILURE' || trim(asObject(payload)?.failReason)) {
    return 'fail'
  }
  return 'pending'
}

/**
 * MJ imagine 适配器:`mj_imagine`。
 *
 * 三个「不发」的决定,都有出处:
 *  - **不发 size / 不改 prompt**:MJ 的比例只能靠 prompt 里的 `--ar`,而网关对 `--ar` 不解析
 *    (`relay-mj.go` 里搜 `--ar` 零命中),只在没写 `--v` 时替我们补一个 ` --v 7`
 *    (`relay/relay-mj.go:1063-1075`)。往用户的 prompt 里注入参数是改他的意图,所以不做,
 *    把 size 回报成 `ignoredSize`;
 *  - **不发 n**:imagine 一单只出一张(那张是 2×2 四格拼图,放大要走
 *    `/mj/submit/action`,那是我们刻意不上架的 9 条 MJ 动作),所以 count>1 回报 `ignoredCount`;
 *  - **不发 accountFilter / notifyHook**:内核这条链路上没有对应的调用方。
 *
 * 参考图走 `base64Array`(平台 Lab 的 imagine 分支就收,`buildImageRequest.js:115-119`),
 * 作为 MJ 的图片提示词 —— 所以这个模型也认「按参考图出图」。
 */
const mjImagineAdapter = {
  id: 'mj-imagine',
  endpointTypes: new Set(['MJ imagine']),
  canEdit: true,
  maxInputImages: 4,
  async submit({ root, apiKey, prompt, count, size, inputImages, deadlineAt }) {
    const body = { botType: MJ_BOT_TYPE, prompt }
    if (inputImages.length > 0) {
      body.base64Array = inputImages.slice(0, mjImagineAdapter.maxInputImages).map(imageDataUri)
    }
    const submitted = await mjSubmit({ root, apiKey, action: 'imagine', body, deadlineAt })
    return {
      ...submitted,
      ignoredSize: size,
      ...(count > 1 ? { ignoredCount: count } : {})
    }
  },
  poll: mjPoll,
  extractUrls(payload) {
    const url = trim(asObject(payload)?.imageUrl)
    return url ? [url] : []
  },
  statusOf: mjStatusOf,
  errorOf: mjError,
  isTerminal: mjTerminal
}

/**
 * MJ blend 适配器:`mj_blend`。**只做图片混合,必须给至少 2 张参考图**
 * (平台 Lab 的原话:「至少 2 张,最多 9 张」,`ImageInputPanel.js:229`;网关这侧零校验,
 * 空数组会被上游拒 —— 2026-08-17 探针实测回 `all_retries_failed`)。
 *
 * 它没有 prompt 这一档(上游 blend 就不收),所以文生请求到这里只能报错。内核的出图能力
 * **没有逐模型旋钮**可以让它提前跳过(`image-generation/types.ts:91-129` 只有模式级 `maxCount`
 * 与 geometry 的逐模型尺寸),不像视频那侧能用 `maxInputImagesByModel: 0`。好在内核会
 * 顺着 primary→fallbacks 往下试(`image-generation/runtime.ts:85-173`),所以这一记错报
 * 只花一次本地往返;选择器那侧则标一个「需参考图」把它挑明。
 */
const mjBlendAdapter = {
  id: 'mj-blend',
  endpointTypes: new Set(['MJ blend']),
  canEdit: true,
  editOnly: true,
  minInputImages: MJ_BLEND_MIN_IMAGES,
  maxInputImages: MJ_BLEND_MAX_IMAGES,
  async submit({ root, apiKey, count, size, inputImages, deadlineAt }) {
    if (inputImages.length < MJ_BLEND_MIN_IMAGES) {
      throw new Error(
        `mj_blend 是图片混合,至少要 ${MJ_BLEND_MIN_IMAGES} 张参考图(这次给了 ${inputImages.length} 张)。` +
          '只有一句提示词的话请改用 mj_imagine 或别的出图模型。'
      )
    }
    const body = {
      botType: MJ_BOT_TYPE,
      base64Array: inputImages.slice(0, MJ_BLEND_MAX_IMAGES).map(imageDataUri),
      dimensions: MJ_BLEND_DIMENSIONS[imageOrientation(size)]
    }
    const submitted = await mjSubmit({ root, apiKey, action: 'blend', body, deadlineAt })
    return {
      ...submitted,
      // 朝向已经按 size 折进 dimensions 了,但具体像素上游不收,所以照旧回报。
      ignoredSize: size,
      ...(count > 1 ? { ignoredCount: count } : {})
    }
  },
  poll: mjPoll,
  extractUrls: (payload) => mjImagineAdapter.extractUrls(payload),
  statusOf: mjStatusOf,
  errorOf: mjError,
  isTerminal: mjTerminal
}

/**
 * 可灵出图的失败信息。三处都要认:任务级 `data.task_status_msg`、请求级 `message`,
 * 以及任务被判失败后网关换的那身统一失败体的 `error`
 * (`relay/relay_task_fetch_kling.go:51-56` + `dto/common_error.go:8-12`)。
 */
function klingImageError(json) {
  const obj = asObject(json)
  const data = asObject(obj?.data)
  const failure = obj?.error
  return (
    trim(data?.task_status_msg) ??
    trim(obj?.message) ??
    trim(typeof failure === 'string' ? failure : asObject(failure)?.message)
  )
}

/**
 * 可灵出图提交:`POST {站点根}/kling/v1/images/<action>`(`router/relay-router.go:219`、`:222`)。
 *
 * **业务错误包在 HTTP 429 里** —— 2026-08-17 真机四发探针全是 `429` + 体内 `code:400`
 * (`n` 越界、model_name 非法、aspect_ratio 非法、prompt 缺失)。所以先读体、后看 HTTP 码,
 * 又一次印证「429 不是价格的证据」(判价格只能看回文里有没有那句「未配置价格」)。
 * 成功是 HTTP 200 + `code:0` + `data.task_id`(`relay/channel/task/kling/adaptor.go:2399-2447`)。
 */
async function klingImageSubmit({ root, apiKey, action, body, deadlineAt }) {
  const { res, json, text } = await fetchJson(
    `${root}/kling/v1/images/${action}`,
    { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) },
    deadlineAt
  )
  // **判据只看 `code`,不看有没有 message** —— 成功回执里 `message` 就是字符串 `"success"`
  // (`relay/channel/task/kling/adaptor.go:2399-2447` 原样透传上游那份),拿「有 message」
  // 当失败会把每一次成功提交都判成失败。离线探针第一发就撞在这上面。
  if (!res.ok || asObject(json)?.code !== 0) {
    throw new Error(
      `可灵出图提交被拒: ${klingImageError(json) || `HTTP ${res.status} ${text.slice(0, 200)}`}`
    )
  }
  const taskId = trim(asObject(asObject(json)?.data)?.task_id)
  if (!taskId) {
    throw new Error('可灵出图提交响应缺少 data.task_id')
  }
  return { taskId, submitted: json, submitContext: { action } }
}

/**
 * 可灵出图轮询:**必须走与提交同一个 action 段**
 * (`GET /kling/v1/images/<action>/<task_id>`,`router/relay-router.go:285` 那条通配)。
 * 与可灵视频那侧一模一样的约束,所以同样靠 `submitContext` 把 action 带过来。
 */
async function klingImagePoll({ root, apiKey, taskId, submitContext, deadlineAt }) {
  const action = trim(submitContext?.action) ?? 'generations'
  const { res, json, text } = await fetchJson(
    `${root}/kling/v1/images/${action}/${encodeURIComponent(taskId)}`,
    { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
    deadlineAt
  )
  // 失败态由 isTerminal 认(体里带 task_status/status),这里只拦真的取不到任务。
  if (!res.ok && !asObject(json)) {
    throw new Error(`可灵出图查询失败 HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  return json
}

function klingImageStatusOf(payload) {
  const obj = asObject(payload)
  return (
    trim(asObject(obj?.data)?.task_status)?.toLowerCase() ?? trim(obj?.status)?.toLowerCase()
  )
}

function klingImageUrls(payload) {
  const images = asObject(asObject(asObject(payload)?.data)?.task_result)?.images
  if (!Array.isArray(images)) {
    return []
  }
  return images.map((row) => trim(asObject(row)?.url)).filter(Boolean)
}

/**
 * 可灵出图的完成 / 失败判据。状态字面量与平台自己的 Lab 同一份
 * (`pollContracts.js:265-284` 的 `klingContract`:succeed 成功 / failed 失败),
 * 内部映射表还列了 wait / run / done / fail / pending 这些别名
 * (`controller/tasks/kling/task.go:149-159`)。
 *
 * **只认状态,不拿「有没有 url」当完成**:PixVerse 那条教训(url 先于产物落桶,那时候下是 404)
 * 对出图同样成立。失败还有第二种形状 —— 任务被判失败后查询接口会换成统一失败体,
 * 状态挪到**顶层** `status:"failed"`(`relay/relay_task_fetch_kling.go:51-56`)。
 */
function klingImageTerminal(payload) {
  const status = klingImageStatusOf(payload)
  if (status === 'succeed' || status === 'done') {
    return 'ok'
  }
  if (status === 'failed' || status === 'fail' || status === 'error') {
    return 'fail'
  }
  return 'pending'
}

/**
 * 可灵出图适配器:`kling-image`。
 *
 * 一个 id 三条路径(`Kling image generation` / `Kling multi-image to image` /
 * `Kling image expand`),但只接第一条 `generations` —— 它自己就同时是文生图与图生图
 * (给了 `image` 就按图生图计价,`relay/relay_task_kling.go:307-315`),与可灵视频那侧
 * 「一个 id 两条路径」是同一个形状。多图生图与扩图各要另一套字段
 * (`subject_image_list` / `up_expansion_ratio` 那些,见 `buildImageRequest.js:160-169`),
 * 且都不是「按一句话出图」,先不接。
 *
 * `n` 这条路上**是真的**(1~9,按张计费),所以不回报 ignoredCount;size 只剩朝向可用。
 */
const klingImageAdapter = {
  id: 'kling-image',
  endpointTypes: new Set([
    'Kling image generation',
    'Kling multi-image to image',
    'Kling image expand'
  ]),
  canEdit: true,
  maxInputImages: 1,
  maxCount: KLING_IMAGE_MAX_COUNT,
  async submit({ root, apiKey, prompt, count, size, inputImages, deadlineAt }) {
    const body = {
      model_name: KLING_IMAGE_UPSTREAM_MODEL,
      prompt,
      n: Math.max(1, Math.min(KLING_IMAGE_MAX_COUNT, count)),
      aspect_ratio: KLING_IMAGE_ASPECT_RATIOS[imageOrientation(size)]
    }
    if (inputImages.length > 0) {
      body.image = imageBase64(inputImages[0])
    }
    const submitted = await klingImageSubmit({
      root,
      apiKey,
      action: 'generations',
      body,
      deadlineAt
    })
    return { ...submitted, ignoredSize: size }
  },
  poll: klingImagePoll,
  extractUrls: klingImageUrls,
  statusOf: klingImageStatusOf,
  errorOf: klingImageError,
  isTerminal: klingImageTerminal
}

/**
 * 可灵 omni 出图适配器:`kling-omni-image`,**另一条路径**(`/kling/v1/images/omni-image`)。
 *
 * 与上面那条的差别只在参考图字段:它收 `image_list: [{image}]`(最多与 `element_list`
 * 合计 10 张,`relay/channel/task/kling/adaptor.go:756-810`),而且这条路径上网关的本地校验
 * **是真生效的**(prompt 必填、≤2500 字、model_name 白名单),所以参数错会在提交那一步就回话。
 */
const klingOmniImageAdapter = {
  id: 'kling-omni-image',
  endpointTypes: new Set(['omni-image']),
  canEdit: true,
  maxInputImages: 4,
  maxCount: KLING_IMAGE_MAX_COUNT,
  async submit({ root, apiKey, prompt, count, size, inputImages, deadlineAt }) {
    const body = {
      model_name: KLING_OMNI_UPSTREAM_MODEL,
      prompt,
      n: Math.max(1, Math.min(KLING_IMAGE_MAX_COUNT, count)),
      aspect_ratio: KLING_IMAGE_ASPECT_RATIOS[imageOrientation(size)]
    }
    if (inputImages.length > 0) {
      body.image_list = inputImages
        .slice(0, klingOmniImageAdapter.maxInputImages)
        .map((image) => ({ image: imageBase64(image) }))
    }
    const submitted = await klingImageSubmit({
      root,
      apiKey,
      action: 'omni-image',
      body,
      deadlineAt
    })
    return { ...submitted, ignoredSize: size }
  },
  poll: klingImagePoll,
  extractUrls: klingImageUrls,
  statusOf: klingImageStatusOf,
  errorOf: klingImageError,
  isTerminal: klingImageTerminal
}

/**
 * 厂商专属异步出图的适配器表。归属判据由适配器自己声明(`endpointTypes`),与视频那侧同约定:
 * 新接一家只动它自己那个对象 + 选择器那份 `IMAGE_ASYNC_ENDPOINT_TYPES`。
 *
 * 目录里 MJ 一共 16 条,能「独立出一个作品」的只有下面这两条,其余 14 条 2026-08-17 真机结案:
 *  - 9 条动作(`/mj/submit/action`)+ `mj_modal`:要 `taskId` + `customId`,对**已有任务**后处理
 *  - `mj_describe` 出 4 条文本、`mj_upload` 只换 URL —— 产物不是图
 *  - `mj_video` 提交虽然不要 taskId,但**出来的是图**(回执 `buttons` 是 `U1~U4`,那是 4 格的
 *    放大按钮);MJ 出视频得 imagine → U 选一张 → Animate,后两步都要 taskId。官方也明说
 *    没有文生视频那条路
 *  - `mj_edits`(官方 Editor 的 Retexture):base64Array 与「URL 拼 prompt 开头」两种都试过,
 *    上游一律 `all_retries_failed`
 * 可灵那边同理:多图生图与扩图也是另一档。详见 references/media-video.md 那一节。
 */
const IMAGE_ASYNC_ADAPTERS = [
  mjImagineAdapter,
  mjBlendAdapter,
  klingImageAdapter,
  klingOmniImageAdapter
]

function imageAsyncAdapterFor(types) {
  return IMAGE_ASYNC_ADAPTERS.find((a) => hasType(types, a.endpointTypes))
}

function imageAsyncAdapterById(id) {
  return IMAGE_ASYNC_ADAPTERS.find((a) => a.id === id)
}

/**
 * 厂商异步出图的骨架:提交 → 轮询 → 取 url → 下载。与视频那条同形
 * (`generateVideo` 里那段循环),只是产物可能是多张。
 *
 * 轮询间隔沿用 5 秒:平台自己的 Lab 也是 5 秒(`pollContracts.js:21`、`:359`)。
 * 上限交给 deadline 管 —— 出图默认 300 秒,比视频那条短得多,所以不另设 attempts 上限。
 */
async function generateAsyncImage({ adapter, creds, model, prompt, count, size, inputImages, deadlineAt, maxBytes }) {
  const { taskId, submitted, submitContext, ignoredSize, ignoredCount } = await adapter.submit({
    root: creds.root,
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    model,
    prompt,
    count,
    size,
    inputImages,
    deadlineAt
  })

  let payload = submitted
  for (;;) {
    const terminal = adapter.isTerminal(payload)
    if (terminal === 'ok') {
      break
    }
    if (terminal === 'fail') {
      throw new Error(adapter.errorOf(payload) || `云雾出图任务 ${taskId} 失败`)
    }
    if (Date.now() >= deadlineAt) {
      throw new Error(
        `云雾出图任务 ${taskId} 超时(${adapter.statusOf(payload) || '无状态'})。` +
          '厂商异步出图比同步那档慢得多,可以调大 imageGenerationModel.timeoutMs 再试。'
      )
    }
    await sleep(POLL_INTERVAL_MS)
    payload = await adapter.poll({
      root: creds.root,
      baseUrl: creds.baseUrl,
      apiKey: creds.apiKey,
      taskId,
      submitContext,
      deadlineAt
    })
  }

  const urls = adapter.extractUrls(payload)
  if (urls.length === 0) {
    throw new Error(`云雾出图任务 ${taskId} 完成但没有产物 url`)
  }
  const images = []
  for (const [index, url] of urls.entries()) {
    const downloaded = await downloadImage(url, deadlineAt, maxBytes)
    images.push({
      buffer: downloaded.buffer,
      mimeType: downloaded.mimeType,
      fileName: `image-${index + 1}.${imageExtension(downloaded.mimeType)}`
    })
  }
  return {
    images,
    metadata: {
      jobId: taskId,
      adapter: adapter.id,
      delivery: 'async-url',
      status: adapter.statusOf(payload) || 'succeed',
      imageUrls: urls,
      ...(ignoredSize ? { ignoredSize } : {}),
      ...(ignoredCount ? { ignoredCount } : {})
    }
  }
}

/**
 * 出图 provider。
 *
 * 模型归属有三档,判据全在 `assertImageModel`:
 *  1. OpenAI 兼容出图端点 —— 同步,一次 POST 拿产物;
 *  2. 只在对话端点上出图的 Gemini 图像族(`isChatImageModel` → `postChatImage`);
 *  3. 厂商专属异步出图(MJ / 可灵,`IMAGE_ASYNC_ADAPTERS` → `generateAsyncImage`)。
 *
 * 第三档与视频那条同形(提交 → 轮询 → 下载),所以它才是"按厂商分适配器"的那一层;
 * 前两档不需要分家。可灵的多图生图 / 扩图、MJ 的 9 条动作各是另一条路径,还没接。
 */
function buildImageProvider() {
  return {
    id: IMAGE_PROVIDER_ID,
    label: '云雾出图',
    defaultModel: IMAGE_DEFAULT_MODEL,
    defaultTimeoutMs: IMAGE_TIMEOUT_MS,
    // 静态种子而非权威清单:真正的判定在 assertImageModel,按 live 端点类型走。
    models: IMAGE_FALLBACK_MODELS,
    isConfigured: ({ cfg }) => Boolean(resolveYunwuCredentials(cfg)),
    capabilities: {
      generate: {
        maxCount: IMAGE_MAX_COUNT,
        supportsSize: true,
        // 收比例(自己折成 IMAGE_SIZE_BY_ORIENTATION 那三档)。声明成 false 会让内核把比例
        // 反译成「同比例里面积最小」的尺寸,也就是 256×256 —— 见 IMAGE_SIZE_BY_ORIENTATION。
        supportsAspectRatio: true,
        supportsResolution: false
      },
      edit: {
        enabled: true,
        maxCount: IMAGE_MAX_COUNT,
        maxInputImages: IMAGE_MAX_INPUT_IMAGES,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: false
      },
      // 只给 sizes、**不给 aspectRatios**:给了内核会先把比例吸附到清单里的最近值,
      // 而我们真正只区分横/竖/方三档,清单越长越像在承诺我们并不遵守的精度。
      geometry: { sizes: IMAGE_SIZES }
    },
    async generateImage(req) {
      const creds = resolveYunwuCredentials(req.cfg)
      if (!creds) {
        throw new Error('云雾出图未配置:models.providers.yunwu 缺少 baseUrl 或 apiKey')
      }
      const model = trim(req.model) || IMAGE_DEFAULT_MODEL
      const inputImages = Array.isArray(req.inputImages) ? req.inputImages : []
      const edit = inputImages.length > 0
      const { viaChat, adapter } = await assertImageModel(model, creds, edit)

      const timeoutMs =
        typeof req.timeoutMs === 'number' && req.timeoutMs > 0 ? req.timeoutMs : IMAGE_TIMEOUT_MS
      const deadlineAt = Date.now() + timeoutMs
      const maxBytes = resolveMaxBytes(req.cfg)
      const count = Math.max(
        1,
        Math.min(IMAGE_MAX_COUNT, Math.round(typeof req.count === 'number' ? req.count : 1))
      )
      // 尺寸三级回落:调用方给的像素 → 只给了比例就折成横/竖/方那一档 → 默认方图。
      const size = trim(req.size) || imageSizeFromAspectRatio(req.aspectRatio) || IMAGE_DEFAULT_SIZE

      // 第三条路先分岔:厂商异步那档不是一次 POST 就拿产物,下面那段同步分支对它没有意义。
      if (adapter) {
        const result = await generateAsyncImage({
          adapter,
          creds,
          model,
          prompt: req.prompt,
          count,
          size,
          inputImages,
          deadlineAt,
          maxBytes
        })
        return {
          images: result.images,
          model,
          metadata: { mode: edit ? 'edit' : 'generate', ...result.metadata }
        }
      }

      const { res, json, text } = viaChat
        ? await postChatImage({ creds, model, prompt: req.prompt, inputImages, deadlineAt })
        : edit
        ? await postImageEdit({ creds, model, prompt: req.prompt, count, size, inputImages, deadlineAt })
        : await postImageGenerate({ creds, model, prompt: req.prompt, count, size, deadlineAt })
      const failure = errorMessage(json)
      if (failure) {
        throw new Error(`云雾出图失败: ${failure}`)
      }
      if (!res.ok) {
        throw new Error(`云雾出图失败 HTTP ${res.status}: ${text.slice(0, 200)}`)
      }
      if (viaChat) {
        const { assets, note } = chatImageAssetsFrom(json, maxBytes)
        if (assets.length === 0) {
          // 模型答了话但没给图:把它的原话带出去,这是唯一能说明「为什么没有图」的东西。
          throw new Error(
            note
              ? `云雾出图没有回图,模型只答了话:${note.slice(0, 200)}`
              : `云雾出图返回了 ${res.status} 但没有可用产物: ${text.slice(0, 200)}`
          )
        }
        return {
          images: assets,
          model,
          metadata: {
            mode: edit ? 'edit' : 'generate',
            delivery: 'chat-data-uri',
            // 这条路发不了 size / n,把被丢掉的值如实回报(与海螺丢比例同一形状)。
            ignoredSize: size,
            ...(count > assets.length ? { ignoredCount: count } : {}),
            ...(note ? { note: note.slice(0, 200) } : {})
          }
        }
      }
      const images = await imageAssetsFrom(json, deadlineAt, maxBytes)
      if (images.length === 0) {
        throw new Error(`云雾出图返回了 ${res.status} 但没有可用产物: ${text.slice(0, 200)}`)
      }
      return {
        images,
        model,
        metadata: {
          mode: edit ? 'edit' : 'generate',
          size,
          // 上游把 b64 换成 url 时会走下载分支,记一笔便于排查产物来源。
          delivery: trim(asObject(json)?.data?.[0]?.b64_json) ? 'b64_json' : 'url'
        }
      }
    }
  }
}

/**
 * 出图的 live 目录。与视频同形状(`registerModelCatalogProvider` + `kinds`),
 * 内核会把它叠在 `registerImageGenerationProvider` 自动合成的静态行之上
 * (`plugins/registry.ts:1383-1387`)。
 *
 * 这份也是桌面端选择器的候选来源:哪些模型能选由插件说,免得客户端再复制一份端点判据。
 */
async function listImageModelCatalog(ctx) {
  const creds = resolveYunwuCredentials(ctx?.config)
  if (!creds) {
    return null
  }
  const catalog = await readCatalog(creds)
  if (!catalog) {
    return null
  }
  const rows = []
  for (const [model, meta] of catalog.images) {
    const row = {
      kind: 'image_generation',
      provider: IMAGE_PROVIDER_ID,
      model,
      source: 'live',
      fetchedAt: catalog.at,
      expiresAt: catalog.at + CATALOG_TTL_MS
    }
    const marks = [
      meta.tags,
      meta.canEdit ? '可编辑' : undefined,
      meta.editOnly ? '只能改图' : undefined,
      // 排查时最想知道的就是这条走哪个端点:对话端点那条不认 size / n,
      // 厂商异步那条要提交 + 轮询(慢得多,而且 size 只剩朝向可用)。
      meta.viaChat ? '对话端点' : undefined,
      meta.adapterId ? `异步:${meta.adapterId}` : undefined
    ].filter(Boolean)
    if (marks.length > 0) {
      row.label = `${model}(${marks.join(',')})`
    }
    rows.push(row)
  }
  return rows
}

/**
 * 联网搜索 provider：把「搜索」做成工具，后端是一个**会联网的对话模型**。
 *
 * 为什么是这个形状（2026-08-14 查证）：
 *  - 内核自带 `webSearchProviders` 契约（`plugins/web-provider-types.ts:91-122`），`createTool`
 *    返回的 `{description, parameters, execute}` 全归我们，`web_search` 默认就是开的
 *    （`web-search/runtime.ts:56-68`）。所以这是内核现成的面，不是我们发明的机制。
 *  - 平台侧**没有**任何搜索端点可接（目录里搜索端点 0 个、jina 模型 0 个），但**有**一批把搜索
 *    烙进模型名的对话模型。于是「缺的那个后端」正好由它们补上。
 *  - 好处是主模型不变：用户选的模型哪怕自己不能联网，专家要查资料时照样查得到 —— 只有这一步
 *    交给联网模型，主模型的能力一点不让。这正是本 provider 存在的理由。
 *
 * 不走 `web_search_options` 那条（内核 `params.extra_body` 能原样并进请求体，
 * `agents/embedded-agent-runner/extra-params.ts:762-779`，旋钮是现成的）：真机实测它把
 * 「I'll search for …Here are the search results …」直接拼进助手正文、拿整段提问当搜索词、
 * 返回的是币圈广告，而且消费日志里没记搜索工具的费。留着这段注释是为了别有人再去试一遍。
 */
const SEARCH_PROVIDER_ID = 'yunwu-search'

/**
 * 后端候选的**兜底**清单。正常取值来自配置 `tools.web.search.yunwu.models`，
 * 由桌面端按「用户勾选的对话模型里带联网标记的那些」下发
 * （`config-writer.ts:accountSearchModels`）——带搜索能力的本来就是对话模型，
 * 所以不给搜索单开一档选择器，用户勾了谁查资料就用谁。
 *
 * 这份只在配置还没下发到（老安装、首启时序）时兜底。顺序按 2026-08-14 真机实测排：
 * `gemini-2.5-flash` 2.8 秒答对中文时事、`gemini-3.1-flash-lite` 2.6 秒、
 * `gemini-3-flash-preview` 4.3 秒。三条都在模型广场上架 —— **这是硬要求**，
 * 广场上看得见的才是配好价格正式给用户用的。
 *
 * 曾经用 `deepseek-v3-search` / `qwen3-max-preview-search`，它们能调通也便宜，但
 * `-search` 是平台的**能力后缀**、在 `FormatMatchingModelName` 里会被剥掉
 * （`new-yunwu-api/setting/ratio_setting/model_ratio.go:1841-1844`），
 * 所以广场和 `/v1/models` 里根本不存在这两个名字，属于用户看不见、也没法自己选的东西。
 */
const SEARCH_FALLBACK_MODELS = [
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview'
]

/** 真机最慢的一条（`gemini-3-pro-preview`）要 31 秒，给到 90 秒留余量；超了就换下一个后端。 */
const SEARCH_TIMEOUT_MS = 90_000

/**
 * 429 退避。**这条是真机打出来的**：2026-08-14 连打 `gpt-4o-mini-search-preview`，
 * 间歇回「请求过于频繁」，退避 3 秒重试 1~3 次就能过；不重试的话用户看到的是搜索直接失败。
 * 只对 429 退避，别的错误立刻换下一个后端（那是模型/渠道的问题，等多久都一样）。
 */
const SEARCH_RETRY_ON_429 = 2
const SEARCH_RETRY_DELAY_MS = 3_000

/** 从配置取后端清单；没有（或被写成空）就用兜底那份。 */
function resolveSearchModels(cfg) {
  const scoped = asObject(asObject(asObject(asObject(cfg)?.tools)?.web)?.search)?.yunwu
  const list = Array.isArray(scoped?.models)
    ? scoped.models.map((m) => trim(m)).filter((m) => !!m)
    : []
  return list.length > 0 ? [...new Set(list)] : SEARCH_FALLBACK_MODELS
}

/**
 * 这个模型靠哪种机制联网。**两族的请求形状不一样，传错就是不联网还照样收钱**：
 *
 * - `gemini-*`：云雾在 OpenAI 兼容端点上认一个名为 `googleSearch` 的 function 工具，
 *   收到就翻译成 Gemini 的 Google Search grounding
 *   （`new-yunwu-api/relay/channel/gemini/relay-gemini.go:390-431`）。不传就是普通对话。
 * - 其余（`*-search-preview` / `*-search-api`）：模型自带搜索，**不能**传 googleSearch，
 *   那是 Gemini 专属的约定。
 */
function isGeminiGrounding(model) {
  return String(model ?? '').toLowerCase().startsWith('gemini-')
}

/**
 * 取来源链接。两族给法不同：OpenAI 那族有结构化 `annotations[].url_citation`（带标题），
 * Gemini 把来源写进正文（Google 的 grounding 重定向链接），只能从正文抠。
 */
function extractCitations(message) {
  const msg = asObject(message)
  const out = []
  const annotations = Array.isArray(msg?.annotations) ? msg.annotations : []
  for (const a of annotations) {
    const url = trim(asObject(asObject(a)?.url_citation)?.url)
    if (url) {
      out.push(url)
    }
  }
  const found = String(trim(msg?.content) ?? '').match(/https?:\/\/[^\s)»"'，。、]+/g)
  if (found) {
    out.push(...found)
  }
  return [...new Set(out)]
}

/**
 * 发问的措辞有两条硬约束，都是真机打出来的：
 *
 * 1. **不给否定的出口。** 早先写过「检索不到就直说没有找到」，模型当场就走那条退路
 *    （计费日志显示搜索结果其实已经灌进 prompt 了）。
 * 2. **要来源必须写在 user 消息里。** 同样的要求放进 system，Gemini 那族返回 0 条链接；
 *    放进 user 消息稳定给 2~3 条带标题的来源。
 */
function searchPrompt(query) {
  return `${query}\n\n请基于检索到的网页内容回答，并在每条结论后面附上来源网页的标题与可点击链接。`
}

async function runYunwuSearch({ creds, models, query, signal }) {
  let lastError
  for (const model of models) {
    for (let attempt = 0; attempt <= SEARCH_RETRY_ON_429; attempt++) {
      try {
        const { res, json, text } = await fetchJson(
          `${creds.baseUrl}/chat/completions`,
          {
            method: 'POST',
            headers: authHeaders(creds.apiKey),
            signal,
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: searchPrompt(query) }],
              ...(isGeminiGrounding(model)
                ? { tools: [{ type: 'function', function: { name: 'googleSearch' } }] }
                : {}),
              max_tokens: 1200
            })
          },
          Date.now() + SEARCH_TIMEOUT_MS
        )
        if (res.status === 429 && attempt < SEARCH_RETRY_ON_429) {
          lastError = errorMessage(json) || 'HTTP 429'
          await sleep(SEARCH_RETRY_DELAY_MS)
          continue
        }
        if (!res.ok) {
          lastError = errorMessage(json) || `HTTP ${res.status}: ${text.slice(0, 200)}`
          break
        }
        const message = asObject(asObject(json)?.choices?.[0])?.message
        const answer = trim(message?.content)
        if (!answer) {
          lastError = `模型 ${model} 没有返回正文`
          break
        }
        return { model, answer, citations: extractCitations(message) }
      } catch (err) {
        lastError = String(err)
        break
      }
    }
  }
  throw new Error(lastError ?? '云雾联网搜索没有可用的后端模型')
}

function buildSearchProvider() {
  return {
    id: SEARCH_PROVIDER_ID,
    label: '云雾联网搜索',
    hint: '复用云雾账号,无需另配 key · 后端是带联网的对话模型',
    // 凭据就是云雾自己那把 key,用户不需要再配第二个。requiresCredential 为真时,
    // 有 key 就构成「隐式选中信号」,内核会自动探测到我们这一家
    // (`web-search/runtime.ts:105-125, 191-201`),连 tools.web.search.provider 都不写也能用。
    requiresCredential: true,
    credentialLabel: '云雾 API Key（与对话共用）',
    envVars: [],
    placeholder: 'sk-...',
    signupUrl: 'https://api.openlux.ai',
    autoDetectOrder: 10,
    credentialPath: 'tools.web.search.yunwu.apiKey',
    getCredentialValue: (searchConfig) => asObject(asObject(searchConfig)?.yunwu)?.apiKey,
    setCredentialValue: (target, value) => {
      const scoped = asObject(target?.yunwu) ?? {}
      scoped.apiKey = value
      target.yunwu = scoped
    },
    // 真正的取值口:直接读对话槽位的 key,所以「配过云雾账号」就等于「联网搜索可用」。
    getConfiguredCredentialValue: (config) => resolveYunwuCredentials(config)?.apiKey,
    createTool: (ctx) => {
      const creds = resolveYunwuCredentials(ctx?.config)
      if (!creds) {
        // 返 null = 这一家现在不可用,内核会跳过它而不是让模型撞一个错
        // (`web-search/runtime.ts:482-488`)。
        return null
      }
      // 后端清单在建工具时定一次:createTool 每轮会话都会被调
      // (`web-search/runtime.ts` 按需建),所以用户在设置里改完模型、配置热加载之后,
      // 下一轮就会拿到新清单,不需要重启。
      const models = resolveSearchModels(ctx?.config)
      return {
        description:
          '联网检索最新信息。用于任何需要当前事实的问题(新闻、价格、版本号、今天的日期之后发生的事)。' +
          '返回检索到的正文与来源链接。注意:当前对话模型本身可能不能联网,要查最新信息一律用这个工具,不要凭记忆回答。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['query'],
          properties: {
            query: {
              type: 'string',
              description: '检索词。用完整的一句话描述要查什么,不要只给关键词。'
            }
          }
        },
        execute: async (args, context) => {
          const query = trim(asObject(args)?.query)
          if (!query) {
            return { error: 'missing_query', message: 'web_search 需要一个 query。' }
          }
          const result = await runYunwuSearch({
            creds,
            models,
            query,
            signal: context?.signal
          })
          return {
            query,
            provider: SEARCH_PROVIDER_ID,
            model: result.model,
            results: result.answer,
            citations: result.citations
          }
        }
      }
    }
  }
}

/**
 * # 对话模型的思考开关为什么得在插件里做
 *
 * ## 关思考
 *
 * 2026-08-16 真机:界面把开关关掉、会话记录里 `thinkingLevel:"off"` 也对,但线上收到的是
 * `reasoning_effort:"high"`(openai 方言)/ `enable_thinking:true`(阿里方言)——思考照旧。
 *
 * 根因在内核:`off` 这一档到了 agent runtime 就不再作为 reasoning 选项往下传,而 transport
 * 拿不到值时按 `options?.reasoningEffort ?? options?.reasoning ?? "high"` 兜底
 * (`openclaw/src/agents/openai-transport-stream.ts:3677`)。于是「用户明确要关」与「没指定」
 * 在那一层不可区分,兜底又恰好是最高档。配置层救不了:transport 这条路不读 `thinkingLevelMap`,
 * `reasoningEffortMap` 只能改一个已经解析出来的值。
 *
 * ## 开思考(deepseek 方言)
 *
 * 2026-08-17 真机补的另一半:`glm-5.2` 开着思考发三轮(界面开关 / 直接传 `thinking:"medium"`
 * 两条路都试过),抄本里的分片始终只有 `["text"]`、思考字数 0;同一条链路上
 * `deepseek-v4-flash` 有 283 字思考、`glm-4.5` 也有。
 *
 * 原因是 transport 的方言分支表里**没有 deepseek 这一支**:qwen / qwen-chat-template /
 * together / openrouter 各有分支,其余只在 `compat.supportsReasoningEffort` 为真时补
 * `reasoning_effort`(`openai-transport-stream.ts:4422-4449`)。而 deepseek 方言这批模型
 * 恰好都是 `thinkingEffort:false`,于是「开思考」发出去的是**一个思考参数都没有**的请求,
 * 结果完全取决于上游那一刻的默认——直连实测 `glm-5.2` 默认会思考,可应用这三轮就是没有。
 * (provider 那侧 `openai-completions.ts:725-730` 是有 deepseek 分支的,但对话跑的不是那条路。)
 *
 * 所以开也要显式说:deepseek 方言补 `thinking:{type:"enabled"}`(直连验过它会思考,
 * 且带全套工具时也一样)。qwen 方言内核已经发 `enable_thinking:true`,不用我们插手。
 *
 * ## 只在需要打补丁的那一刻接手
 *
 * 内核用「插件是不是换了函数」判断要不要跳过自己那批 wrapper
 * (`extra-params.ts:1136-1141` 的 `providerWrapperHandled`),被跳过的有 DeepSeek V4、
 * MiMo、Google、OpenAI Responses 四组。所以:
 *   - `deepseek-v4-*`(`extra-params.ts:939-945`)与 MiMo 那批 id(`:1010-1017`)一律让给内核,
 *     它们自己那个 wrapper 连历史里的 `reasoning_content` 都会清,比我们做得多;
 *   - 非 `openai-completions` 的(Google / Responses)原样返回;
 *   - 剩下的只在「关」或「deepseek 方言的开」两种情况才换函数,其它情况一律原样返回。
 */
const CHAT_THINKING_HOOK_ID = 'yunwu-chat-thinking'

/** 去掉 `provider/` 前缀与 `:tag` 后缀,与内核 `normalizeDeepSeekV4CandidateId` 同口径。 */
function normalizeChatModelId(modelId) {
  return String(modelId ?? '')
    .trim()
    .toLowerCase()
    .split(':', 1)[0]
    .split('/')
    .pop()
}

/** 内核自带 DeepSeek V4 思考 wrapper 的判据(`extra-params.ts:939-945`),这两条不用我们插手。 */
function isKernelHandledDeepSeekV4(modelId) {
  const id = normalizeChatModelId(modelId)
  return id === 'deepseek-v4-flash' || id === 'deepseek-v4-pro'
}

/**
 * 内核自带 MiMo wrapper 覆盖的 id(`extra-params.ts:1010-1017`)。
 *
 * 它们的线上格式与 deepseek 同源,内核那条 wrapper 除了发思考参数还管响应侧
 * (mimo-v2-pro / omni 会把正文塞进 `reasoning_content`,靠
 * `createThinkingOnlyFinalTextWrapper` 捞回来)。我们一包就把这些一起顶掉,所以整批让开。
 */
const KERNEL_HANDLED_MIMO_IDS = new Set([
  'mimo-v2-pro',
  'mimo-v2-omni',
  'mimo-v2.5',
  'mimo-v2.5-pro',
  'mimo-v2.6-pro'
])

function isKernelHandledMiMo(modelId) {
  return KERNEL_HANDLED_MIMO_IDS.has(normalizeChatModelId(modelId))
}

/** 内核有自带 wrapper、我们不该插手的模型。 */
function isKernelHandledThinking(modelId) {
  return isKernelHandledDeepSeekV4(modelId) || isKernelHandledMiMo(modelId)
}

/** 按方言把「关」写进请求体。返回描述串用于日志,`null` = 这个方言没得可关。 */
function applyThinkingOff(payload, format) {
  if (format === 'qwen') {
    payload.enable_thinking = false
    delete payload.reasoning_effort
    return 'enable_thinking:false'
  }
  if (format === 'qwen-chat-template') {
    const existing =
      payload.chat_template_kwargs && typeof payload.chat_template_kwargs === 'object'
        ? payload.chat_template_kwargs
        : {}
    payload.chat_template_kwargs = { ...existing, enable_thinking: false }
    delete payload.reasoning_effort
    return 'chat_template_kwargs.enable_thinking:false'
  }
  if (format === 'deepseek') {
    payload.thinking = { type: 'disabled' }
    delete payload.reasoning_effort
    return 'thinking:{disabled}'
  }
  // openai 方言与没标方言的:能做的只有别替用户要思考。内核兜底的 `high` 一定是错的,
  // 删掉等于回到上游默认 —— 实测 deepseek-v4 这类「不传就不思考」的模型由此真关掉。
  if ('reasoning_effort' in payload) {
    delete payload.reasoning_effort
    return 'drop reasoning_effort'
  }
  return null
}

/**
 * 按方言把「开」写进请求体。只有 deepseek 方言需要 —— 见文件上方注释:transport 对这一支
 * 什么都不发,而这批模型又都不吃 `reasoning_effort`,于是开思考等于随上游默认。
 */
function applyThinkingOn(payload, format) {
  if (format !== 'deepseek') {
    return null
  }
  payload.thinking = { type: 'enabled' }
  return 'thinking:{enabled}'
}

/** 这一轮要不要打补丁,以及打哪种。返回 `null` 表示不接手。 */
function thinkingPatchKindOf(thinkingLevel, format) {
  if (thinkingLevel === 'off') {
    return 'off'
  }
  if (thinkingLevel && format === 'deepseek') {
    return 'on'
  }
  return null
}

function wrapChatThinking(ctx) {
  const base = ctx?.streamFn
  if (!base) {
    return base
  }
  // 判断必须在**包装这一刻**做:内核是用「插件有没有换掉 streamFn」来决定要不要跳过自己
  // 那批 wrapper 的(`extra-params.ts:1136-1141`),换了就跳。放到调用时才判等于已经把它
  // 顶掉——2026-08-16 真机踩过这一脚:关思考时线上照旧收到 `reasoning_effort:"high"`。
  if (isKernelHandledThinking(ctx.modelId ?? ctx.model?.id)) {
    return base
  }
  if (ctx.model?.api && ctx.model.api !== 'openai-completions') {
    return base
  }
  const wrapFormat =
    ctx.model?.compat && typeof ctx.model.compat === 'object'
      ? ctx.model.compat.thinkingFormat
      : undefined
  if (!thinkingPatchKindOf(ctx.thinkingLevel, wrapFormat)) {
    return base
  }
  return (model, context, options) => {
    if (model?.api !== 'openai-completions') {
      return base(model, context, options)
    }
    // 方言以调用时拿到的那份 model 为准:包装那一刻的 ctx.model 只用来决定要不要接手。
    const format =
      model?.compat && typeof model.compat === 'object' ? model.compat.thinkingFormat : undefined
    const kind = thinkingPatchKindOf(ctx.thinkingLevel, format)
    if (!kind) {
      return base(model, context, options)
    }
    const originalOnPayload = options?.onPayload
    return base(model, context, {
      ...options,
      // 放在原 onPayload 之后打补丁:外层 wrapper 的 onPayload 会先跑,我们要当最后一个写的人。
      onPayload: async (payload, payloadModel) => {
        const replacement = await originalOnPayload?.(payload, payloadModel)
        const target = replacement && typeof replacement === 'object' ? replacement : payload
        if (target && typeof target === 'object') {
          if (kind === 'off') {
            applyThinkingOff(target, format)
          } else {
            applyThinkingOn(target, format)
          }
        }
        return replacement
      }
    })
  }
}

export default {
  id: PROVIDER_ID,
  name: '云雾媒体生成',
  description:
    '云雾 video_generate(统一异步接口 + 可灵 / Vidu / 海螺专属接口)与 image_generate(OpenAI 兼容出图端点)provider',
  configSchema: { type: 'object', additionalProperties: false, properties: {} },
  register(api) {
    api.registerVideoGenerationProvider(buildProvider())
    api.registerModelCatalogProvider({
      provider: PROVIDER_ID,
      kinds: ['video_generation'],
      liveCatalog: listVideoModelCatalog
    })
    api.registerImageGenerationProvider(buildImageProvider())
    api.registerModelCatalogProvider({
      provider: IMAGE_PROVIDER_ID,
      kinds: ['image_generation'],
      liveCatalog: listImageModelCatalog
    })
    api.registerWebSearchProvider(buildSearchProvider())
    // 钩子挂在对话供货商 `yunwu` 上,但用 hookAliases 而不是同名 provider ——
    // `yunwu` 的模型目录是登录时写进配置的自定义供货商,插件不该去认领它的所有权;
    // 内核找钩子时 id / aliases / hookAliases 三者都算命中
    // (`plugins/provider-hook-runtime.ts:65-76`)。
    api.registerProvider({
      id: CHAT_THINKING_HOOK_ID,
      label: '云雾对话思考兼容',
      hookAliases: ['yunwu'],
      auth: [],
      wrapStreamFn: wrapChatThinking
    })
  }
}
