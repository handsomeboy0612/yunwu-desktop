/**
 * 媒体候选池的判据:云雾 `/v1/models` 每条带的 `supported_endpoint_types`。
 *
 * ## 为什么按端点类型筛,不按模型名 / tag 筛
 *
 * tag 说的是「产出什么」,端点类型说的是「怎么调」,而我们能不能驱动它取决于后者。
 * 2026-08-13 真机读 477 条模型量过:`kling-image`、`viduq2`(Vidu image generation)、
 * `pixverse-image-template`、`mj_*` 全都带「绘画」tag,但各自挂在
 * `/kling/v1/images/generations`、`/ent/v2/reference2image` 这些专属路径上 ——
 * 按 tag 铺给用户选,选中即必然失败。按端点类型筛还有一个好处:上游上新模型时,
 * 只要它复用同样的端点类型名就自动出现在候选里,客户端不用发版。
 *
 * 上面那句「选中即必然失败」对 MJ 与可灵**已经不成立了**:2026-08-17 给它们各写了异步适配器,
 * 所以它们的端点类型名进了 `IMAGE_ASYNC_ENDPOINT_TYPES`。判据没变,变的是我们接了哪些 ——
 * 这正是「按类型名筛」的意义:接一家就把那家的类型名加进来,别的一行都不用动。
 * Vidu 与 PixVerse 的出图路径今天仍然没接,故意不在清单里。
 *
 * ## 与插件里那份的关系(改一处要改两处)
 *
 * `resources/yunwu-video-plugin/index.mjs` 里有同名的判据(`IMAGE_ENDPOINT_TYPES` /
 * 各适配器自己的 `endpointTypes`),那份是**运行时权威**——真正决定一次调用能不能成的是它。
 * 这份只用来铺选择器。两份必须一致:**给插件新接一家厂商适配器时,把它的端点类型名也加进
 * 这里的 `VIDEO_ENDPOINT_TYPES`**,否则新支持的模型在界面上选不到(反过来漏删则会让用户
 * 选到一个插件还没接的模型,调用时吃插件那句「还没接这一家」)。
 *
 * 为什么不做成单一来源:插件是被内核加载的独立扩展(入口还会被转成 CommonJS),
 * 主进程 import 它要么受打包器改写 dynamic import 的影响,要么得把判据挪进插件包里
 * 再由两边分别加载 —— 两条都比「两处常量 + 互相点名」更容易出静默故障。
 */

/**
 * 走 OpenAI 兼容 `/v1/images/generations` 的端点类型。2026-08-17 实测命中 23 个模型
 * (2026-08-13 是 21 个,上游上新自动进来的,没发版 —— 这正是按类型名筛而非按模型名写死的收益)。
 *
 * 出图另有两条路:只在对话端点上出图的 Gemini 图像族(`isChatImageModel`,6 条),
 * 以及厂商专属的异步出图(`IMAGE_ASYNC_ENDPOINT_TYPES`,MJ 2 条 + 可灵 2 条)。
 * 三档合起来 23 + 6 + 4 = 33 条,正好是广场图像档里「该当模型挑」的全部。
 */
export const IMAGE_ENDPOINT_TYPES = [
  'image-generation',
  'images-generations',
  'dall-e-3',
  'openai-绘图'
]

/**
 * 走 `/v1/images/edits` 的端点类型(图生图 / 局部重绘)。只用来在选择器里标一个「可编辑」。
 *
 * `image-edit` 是 2026-08-17 补的:`grok-imagine-image-2.0` 与 `-quality` 的 `endpoints`
 * 里写着 `{"image-edit":{"path":"/v1/images/edits"}}`(海外站 `models` 表),
 * 与上面三个名字**是同一条路径**,只是平台又起了个新名。漏了它的后果是这两条明明能改图,
 * 界面上不标「可编辑」、插件运行时还会拒掉编辑请求。
 */
export const IMAGE_EDIT_ENDPOINT_TYPES = [
  'OpenAI image edit',
  'images-edits',
  'openai-编辑',
  'image-edit'
]

/**
 * 「聊天式出图」:图不走 `/v1/images/generations`,而是在 `/v1/chat/completions` 上出。
 *
 * 云雾对 Gemini 图像族(`gemini-3-pro-image`、`gemini-2.5-flash-image` 这些)只开了
 * chat 端点:库里 `endpoints` 是 `{"openai":{"path":"/v1/chat/completions"},
 * "gemini":{"path":"/v1beta/models/{model}:generateContent"}}`,所以它们的
 * `supported_endpoint_types` 是 `["gemini","openai"]` —— 与全部对话模型同名。
 * 图以 markdown data URI 塞在助手正文里(`![image](data:image/png;base64,…)`,
 * 平台侧 `new-yunwu-api/relay/channel/gemini/relay-gemini.go:1096`、`:1173`)。
 *
 * **所以 `openai` 这个类型名不能直接进 `IMAGE_ENDPOINT_TYPES`**,那会把每个对话模型
 * 都判成出图模型。判据要三条一起看,见 `isChatImageModel`。
 */
export const IMAGE_CHAT_ENDPOINT_TYPES = ['openai']

/**
 * 出图的**第三条路**:厂商专属的异步出图接口(提交 → 轮询 → 取 url)。
 *
 * 这些类型名在插件里各对应一个适配器(`IMAGE_ASYNC_ADAPTERS`),**改一处要改两处**:
 * 漏加这里会让明明接好的模型在界面上选不到,漏删则让用户选到一个插件还没接的模型。
 *
 * | 类型名 | 模型 | 路径 |
 * |---|---|---|
 * | `MJ imagine` | `mj_imagine` | `POST /mj/submit/imagine` → `GET /mj/task/{id}/fetch` |
 * | `MJ blend` | `mj_blend` | `POST /mj/submit/blend`(**只做图片混合,至少 2 张图**) |
 * | `Kling image generation` 等三条 | `kling-image` | `POST /kling/v1/images/generations` |
 * | `omni-image` | `kling-omni-image` | `POST /kling/v1/images/omni-image` |
 *
 * 同族里**故意不接**的(目录里 MJ 共 16 条,这里只认 2 条,其余 14 条 2026-08-17 真机结案):
 * MJ 的 9 条动作(`/mj/submit/action`,对已有任务做放大 / 变体 / 局部重绘)+ `mj_modal`(动作的
 * 第二步)都要 `taskId`;`mj_describe` 出 4 条文本、`mj_upload` 只换 URL,产物不是图;
 * `mj_video` 提交不要 taskId 但**出来的是图**(回执 `buttons` 是 `U1~U4`),出视频还得再走
 * U + Animate 两个动作;`mj_edits` 上游两种交图方式都拒。可灵的多图生图与扩图同理。
 * 它们都不是「按一句话出一张图」,不该出现在出图档里 —— 详见 references/media-video.md。
 */
export const IMAGE_ASYNC_ENDPOINT_TYPES = [
  'MJ imagine',
  'MJ blend',
  'Kling image generation',
  'Kling multi-image to image',
  'Kling image expand',
  'omni-image'
]

/**
 * 异步出图里**只能改图**的那些(必须给参考图,接不了纯文字出图)。
 *
 * 今天只有 MJ blend 一条:上游 blend 就不收 prompt,只收 2~9 张图
 * (`new-yunwu-api/web/src/pages/Lab/panels/ImageInputPanel.js:229`)。
 * 与插件里 `mjBlendAdapter.editOnly` 是同一份判据,改一处要改两处。
 *
 * 内核的出图能力**没有**逐模型旋钮可以让它在纯文字请求里被跳过(`image-generation/types.ts`
 * 只有模式级 `maxCount` 与 geometry 的逐模型尺寸),所以这条只能靠界面标出来 + 插件里早报错,
 * 与视频那侧能用 `maxInputImagesByModel: 0` 让内核自己跳不同。
 */
export function isEditOnlyImageModel(id: string): boolean {
  return id === 'mj_blend'
}

/** `model_type` 的图像档取值。库里同时有中文与英文旧值(`gpt-image-2-c` 就是 `image`)。 */
const IMAGE_MODEL_TYPES = ['图像', 'image']

/**
 * 这个模型是不是**只能靠对话端点出图**。
 *
 * 三条缺一不可(2026-08-17 拿海外站 478 条真机量过,命中正好是 Gemini 图像族那 6 条,
 * 零误伤 —— 没有别的图像档模型走 chat 端点,也没有非图像档的模型带绘画 tag 走 chat 端点):
 *
 * 1. `model_type` 在图像档 —— 挡住全部对话模型;
 * 2. 端点类型**没有**任何 OpenAI 兼容出图类型 —— 两条路都通的模型走专用那条
 *    (同步、认 `n` 与 `size`,比 chat 那条能力全);
 * 3. tags 带「绘画」/「绘图」—— 挡住同在图像档的识图类
 *    (`kling-image-recognize` 那种;它今天靠专属端点类型就被挡住了,但这条更靠得住)。
 *
 * 与插件里同名函数是同一份判据,改一处要改两处(理由见文件头)。
 */
export function isChatImageModel(
  modelType: string | undefined,
  tags: string | undefined,
  endpointTypes: readonly string[]
): boolean {
  if (!IMAGE_MODEL_TYPES.includes((modelType ?? '').trim())) {
    return false
  }
  if (endpointTypes.some((t) => IMAGE_ENDPOINT_TYPES.includes(t))) {
    return false
  }
  if (!endpointTypes.some((t) => IMAGE_CHAT_ENDPOINT_TYPES.includes(t))) {
    return false
  }
  const t = tags ?? ''
  return t.includes('绘画') || t.includes('绘图')
}

/**
 * 插件已接入的视频端点类型 = 各适配器 `endpointTypes` 的并集。
 *
 * 统一异步接口 3 类 + 可灵 v1 + 可灵 3.0 turbo + Vidu 文生 + 海螺 + PixVerse + 百炼 + 万相 + grok。
 *
 * **`Wan video generation` 是 2026-08-13 补的图生那一档**:万相与百炼是同一条路径、同一套状态
 * 字面量,所以由同一个适配器带(见插件里 `bailianAdapter` 的注释)。
 *
 * 2026-08-17 把各家的图生路径补齐了(可灵三条 / 可灵 3.0 turbo 两条 / Vidu 四条 / PixVerse 三条)。
 * **仍然故意不在这里的**是「另一档能力」:视频续写、特效、数字人、对口型、多主体、视频编辑 ——
 * 内核 `video_generate` 没有对应模式,铺出来选中即必然失败。
 */
export const VIDEO_ENDPOINT_TYPES = [
  'OpenAI video format',
  'Doubao video',
  'Doubao video (Async)',
  // 与上面三个是**同一条路**(`/v1/video/create`),平台另起的两个类型名,2026-08-17 补。
  // 出处见插件里 `UNIFIED_ENDPOINT_TYPES` 的注释(库里的 endpoints.path + 那个入口适配器
  // 本来就是 VEO/Sora2/Grok 三家共用 + 封堵名单里没有它们)。
  'Unified video format',
  'Grok video',
  // 可灵 v1 一个 id 三条路径。`Image to video` 其实一直能用(插件里给了图就换 action),
  // 只是类型名到 2026-08-17 才补;`Multi-image reference to video` 是当天新接的。
  'Text to video',
  'Image to video',
  'Multi-image reference to video',
  // 可灵 3.0 turbo 的图生是**另一条路由**(`/kling/image-to-video/kling-3.0-turbo`),
  // 与文生那条不是同一个端点的两种叫法,所以两个名字都要在。
  '3.0turbo-文生视频',
  '3.0turbo-图生视频',
  // Vidu 四条路径 2026-08-17 全接了。它是**唯一把模式编码在端点类型里**的一家:
  // 同一批模型各认领不同子集,所以下面两个判据对 vidu 必须看类型、不能看名字。
  'Vidu text to video',
  'Vidu image to video',
  'Vidu first & last frame',
  'Vidu reference to video',
  'Hailuo video generation',
  // PixVerse 也是一个 id 多条路径。另外两条(`Pix extend video` 给已有视频续写、
  // `Pix multi-subject (multi-reference)` 多主体)是另一档能力,内核没有对应模式,不认领。
  'Pix text to video',
  'Pix image to video / video template',
  'Pix first & last frame',
  'Happyhorse video',
  'Wan video generation',
  '官方格式',
  // 2026-08-17 接的三家新厂商。前两个都挂在 `/v1/videos`(sora 全家 + grok 的 OpenAI 兼容),
  // 与统一异步那条是**两条路**:`sora-2` / `-hd` / `-landscape` / `-portrait` /
  // `official-sora-2` 只有 `OpenAI official video format`,不接就永远选不到。
  'OpenAI official video format',
  'Grok video (OpenAI format)',
  // Runway 只开了图生一条路(`/runwayml/v1/image_to_video`),所以它只出现在图生档。
  'Runway image to video',
  'Luma video generation'
]

/**
 * Replicate 与 fal-ai 的端点类型名是**逐模型**的,写不进上面那张静态表。
 *
 * 库里这两家共 9 条,类型名一律是「模型 id + ` (Async)`」:`minimax/video-01 (Async)`、
 * `fal-ai/veo3/fast (Async)`。所以判据只能是这条构造规则本身 —— 与插件里的
 * `isPerModelAsyncType` 是同一份,改一处要改两处(理由见文件头)。
 */
export function isPerModelAsyncType(type: string, id: string): boolean {
  return type === `${id} (Async)`
}

/** 这个模型是不是被视频插件认领了(静态类型名 + 逐模型的异步类型名两种都算)。 */
export function isClaimedVideoModel(id: string, types: readonly string[]): boolean {
  return types.some((t) => VIDEO_ENDPOINT_TYPES.includes(t) || isPerModelAsyncType(t, id))
}

/**
 * 端点类型不够用的两处例外:同一个端点类型下混着**不能文生**的模型。
 *
 * 端点类型仍是主判据(见文件头),但这两家的平台侧就是一个类型带多种模式,所以要再收一层。
 * 两条规则都不是我们发明的,是平台自己的判据:
 *
 * - `Happyhorse video` 一个类型挂着 t2v / i2v / r2v / video-edit **四个模型**,
 *   路径也是同一条。平台按**模型名**分动作:`GetModelAction` 只把 `*-t2v` 归为
 *   `text_to_video`,其余要 `first_frame` / `reference_image` / `video`
 *   (`new-yunwu-api/relay/channel/task/ali/bailain/models.go:21-32`,
 *   必填校验在 `dto/ali/bailian/bailian.go:176-211`)。
 * - `官方格式`(grok)下有两个模型,`grok-imagine-video-1.5-preview` **只能图生**
 *   (`relay/channel/task/xaivideo/models.go:35-37` 的 `imageOnlyModels`,缺 image 直接 400)。
 *   它在库里的 tags 恰好只有「首帧」而没有「视频」,所以按 tag 就能分开
 *   —— 比照抄那份写死的名单更能跟上上游上新。
 *
 * 这个函数**与插件里各适配器的 `claims` 是同一份判据**,改一处要改两处(理由见文件头)。
 */
export function supportsTextToVideo(
  id: string,
  tags?: string,
  types: readonly string[] = []
): boolean {
  if (id.startsWith('vidu')) {
    // Vidu 的模式在端点类型里,不在名字里(`viduq3-pro` 能文生、`viduq3` 只能参考生,
    // 名字看不出差别)。类型缺失时(离线 / 老快照)保守当能文生 —— 与插件里 `viduRoute`
    // 「不知道就按老行为走」同一个退路。
    return types.length === 0 || types.includes('Vidu text to video')
  }
  if (id.startsWith('happyhorse-')) {
    return id.endsWith('-t2v')
  }
  if (id.startsWith('wan')) {
    // 万相在架的三个都是 `*-i2v*`,只能图生(平台的 `GetModelAction` 把非 t2v/r2v/edit
    // 一律归为 image_to_video)。将来上游若上一个万相文生模型,它会走这条 false 分支被漏掉
    // —— 所以判据跟着名字走:带 `-i2v` 的才判成只能图生。
    return !id.includes('-i2v')
  }
  if (id.startsWith('grok-imagine-video')) {
    return (tags ?? '').includes('视频')
  }
  if (id.startsWith('runwayml-')) {
    // Runway 在平台上**只开了图生一条路**(`router/relay-router.go:330` 只有
    // `/runwayml/v1/image_to_video`),`promptImage` 缺了直接 400。
    return false
  }
  if (id.startsWith('fal-ai/')) {
    return !id.includes('/image-to-video')
  }
  if (id === 'MiniMax-Hailuo-2.3-Fast') {
    // 平台单点硬编码:这个模型缺 `first_frame_image` 直接 400
    // (`relay/channel/task/minimax/adaptor.go:190-195`)。名字与 tags 都看不出来,
    // 只能照抄这一条 —— 同族的 -02 / -2.3 两种模式都行,不受影响。
    return false
  }
  return true
}

/**
 * 端点类型自己就说明「这条路要图」的那些 —— 平台为图生**单独开了一条路由**,
 * 于是模型认领了它就等于宣布自己能图生,不用按名字猜。
 *
 * 与插件里各适配器 `endpointTypes` 中的图生那几条同源,改一处要改两处(理由见文件头)。
 * 不在这里的三家(Runway / fal-ai / 海螺)是因为平台那侧就没把模式编进类型名。
 */
const IMAGE_DRIVEN_VIDEO_TYPES = [
  'Image to video',
  'Multi-image reference to video',
  '3.0turbo-图生视频',
  'Vidu image to video',
  'Vidu first & last frame',
  'Vidu reference to video',
  'Pix image to video / video template',
  'Pix first & last frame',
  'Runway image to video'
]

/**
 * 这个模型**能不能图生视频**(选择器用来标一行「图生」,与上面那条是一对)。
 *
 * 与插件里各适配器的 `maxInputImagesFor` / `viduRoute` / `bailianIsImageToVideo` 是同一份判据,
 * 改一处要改两处。判法分两层是因为平台自己就是这么分的:开了独立路由的看端点类型,
 * 没开的(百炼/万相/海螺/fal)看模型名。
 */
export function supportsImageToVideo(id: string, types: readonly string[] = []): boolean {
  // 先看类型:凡是平台**单独开了一条要图的路由**的,类型名自己就说明了这件事,
  // 不用按模型名猜。这份名单与插件里各适配器 `endpointTypes` 里的图生那几条同源。
  if (types.some((t) => IMAGE_DRIVEN_VIDEO_TYPES.includes(t))) {
    return true
  }
  // 剩下三家的模式**不在类型里**,只能按名字分 —— 平台自己也是这么分的。
  if (id.startsWith('runwayml-')) {
    // 与 supportsTextToVideo 那条是一对:Runway 只能图生。
    return true
  }
  if (id.startsWith('fal-ai/')) {
    return id.includes('/image-to-video')
  }
  if (id.startsWith('MiniMax-Hailuo')) {
    // 海螺三个都收 `first_frame_image`,不换路径(`dto/minimax.go:20`)。
    return true
  }
  if (id.endsWith('-t2v') || id.endsWith('-r2v') || id.endsWith('-video-edit')) {
    return false
  }
  return id.startsWith('wan') || id.includes('-i2v')
}

/**
 * 走 OpenAI 兼容 `/v1/audio/speech` 的端点类型。实测命中 5 个:
 * `tts-1` / `tts-1-hd` / `tts-1-1106` / `tts-1-hd-1106` / `gpt-4o-mini-tts`。
 *
 * 其余带「音频」tag 的都不是这条路:`Sync speech` / `Async speech` 是厂商专属语音合成,
 * `Speech to text` 是转录(内核这侧没有消费方),`Suno music generation` 归 music_generate。
 */
export const TTS_ENDPOINT_TYPES = ['Text to speech']
