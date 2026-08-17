import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import type {
  ActivationConfig,
  MediaModelOption,
  MediaSelection,
  ModelInfo
} from '@shared/types'
import {
  AUDIO_MODEL_PREFERENCE,
  IMAGE_MODEL_PREFERENCE,
  PUBLIC_CHAT_MODELS,
  PUBLIC_DEFAULT_MODEL,
  VIDEO_MODEL_PREFERENCE
} from '@shared/public-models'
import {
  IMAGE_ASYNC_ENDPOINT_TYPES,
  IMAGE_EDIT_ENDPOINT_TYPES,
  IMAGE_ENDPOINT_TYPES,
  isChatImageModel,
  isClaimedVideoModel,
  isEditOnlyImageModel,
  supportsImageToVideo,
  supportsTextToVideo,
  TTS_ENDPOINT_TYPES
} from '@shared/media-endpoints'
import {
  alignThinkingCapability,
  deriveModelInfos,
  inferModelInfoFromId,
  type RawModelEntry
} from './model-capabilities'
import { applyProfiles } from './model-profiles'

/**
 * 对话模型清单的归属层:**清单是用户数据,不是 key 的函数。**
 *
 * 只有两层(见 `docs/desktop-media-and-expert-capability-plan.md` 的 P5):
 *
 *  1. 用户自己选——首次登录时从他 key 的可选池里勾,之后在设置→模型页随时增删,存这里;
 *  2. 自定义模型——别家厂商、自带 baseUrl 与独立 Key,归 `providers-store.ts` 管,与这里无关。
 *
 * ## 为什么没有「服务端下发推荐清单」这一层
 *
 * 因为**我们没有公共模型**:桌面端每一次调用都记在用户自己的云雾余额上,由我们替他钦定
 * 一份清单既不省他的钱,也不代表他的 key 真调得通。下发这件事在有公共额度的产品里才成立,
 * 在这里只是凭空多一条会漂移的外部输入。
 *
 * `PUBLIC_CHAT_MODELS` 因此退成纯本地兜底:首启选择器拿它做**预勾选**(且只勾在可选池里
 * 真实存在的),以及该账号还没选过时的临时清单。它不是"推荐",改它不影响任何已选过的用户。
 *
 * ## 为什么按账号存,而不是每次登录按 key 重算
 *
 * 真栽过一次:登录时照单全收 `/v1/models`,把配置从 30KB 推到 124KB;**换账号时新配置
 * 29KB 不到旧的一半,撞上内核的体积骤降保护被整批拒写,人卡在登录页看一句
 * `Config write rejected`**(与账号密码毫无关系)。根因不是"模型多",是清单随外部输入整份
 * 重算 —— 换一把 key 就换一份清单,配置体积因此跳变。
 *
 * 所以清单**按账号分别存**,且**选定即固化**:模型下架或该 key 调不通时只标灰提示、不自动删
 * (自动删又变回"跟着 key 变",而且挑在最坏时机——离线或接口抽风时——全清)。这与市场那侧
 * `reconcileExperts`「快照拿不到就整轮不对账」是同一条纪律。
 */

/**
 * 磁盘上存的媒体模型选择。**每档都可缺**,缺 = 这个账号还没选过这一档
 * (与「选了个空清单」是两件事:后者表示明确不要这个能力)。
 *
 * **只存 id,不存 ModelInfo**:媒体模型没有 reasoning / vision / tools 这些标记可言,
 * 也不再需要落进 `models.providers.<id>.models`(出图与视频都由插件自带清单,见
 * config-writer 的 `resolveImageGeneration`)。展示用的标签由选择器打开时现拉的池子给。
 *
 * 出图与视频是**有序清单**(顺序即 primary → fallbacks,内核 `ToolModelConfig` 的形状);
 * 语音是**单值**,内核 TTS 只有 `messages.tts.providers.openai.model` 一个字段、没有 fallbacks。
 */
type StoredMediaSelection = Partial<MediaSelection>

/** 磁盘上的清单文件结构。 */
interface CatalogFile {
  version: 1
  /** 账号 → 该账号选中的模型。键见 accountKey()。 */
  accounts: Record<string, { chat: ModelInfo[]; updatedAt: number } & StoredMediaSelection>
}

function catalogFile(): string {
  return join(app.getPath('userData'), 'model-catalog.json')
}

function readCatalog(): CatalogFile {
  const file = catalogFile()
  if (!existsSync(file)) {
    return { version: 1, accounts: {} }
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<CatalogFile>
    return {
      version: 1,
      accounts: parsed.accounts && typeof parsed.accounts === 'object' ? parsed.accounts : {}
    }
  } catch {
    return { version: 1, accounts: {} }
  }
}

function writeCatalog(next: CatalogFile): void {
  writeFileSync(catalogFile(), JSON.stringify(next, null, 2), 'utf-8')
}

type AccountEntry = CatalogFile['accounts'][string]

/**
 * 账号维度的存储键:云雾用户 id。
 *
 * 这个键必须选一个**不会变**的字段,否则用户每变一次就丢一次清单。三个候选里只有 id 合格:
 *
 *  - 令牌:会被重新签发(`yunwu-auth.ts:getOrCreateToken` 在旧令牌不合规时会新建一把);
 *  - 用户名:用户可以自己改(后端 `UpdateSelf` 直接接受 Username 写库),还带大小写歧义;
 *  - **用户 id**:`/api/user/login` 返回的 `id`,建令牌那步的 `New-Api-User` 头用的就是它。
 *
 * 早期版本按用户名存,但那时只有测试账号,所以没有做迁移:`loadActivation` 把缺 userId 的
 * 激活态判成未激活,重登一次即落到新键上。少一层回退,换来这里没有任何 undefined 分支。
 */
function accountKey(config: Pick<ActivationConfig, 'userId'>): string {
  return `u${config.userId}`
}

function readEntry(
  catalog: CatalogFile,
  config: Pick<ActivationConfig, 'userId'>
): AccountEntry | undefined {
  return catalog.accounts[accountKey(config)]
}

function writeEntry(
  catalog: CatalogFile,
  config: Pick<ActivationConfig, 'userId'>,
  entry: AccountEntry
): void {
  catalog.accounts[accountKey(config)] = entry
  writeCatalog(catalog)
}

/** 该账号选过的对话模型;从没选过返回 null(与"选了个空清单"要分开)。 */
export function loadSelectedChatModels(config: ActivationConfig): ModelInfo[] | null {
  const entry = readEntry(readCatalog(), config)
  if (!entry || !Array.isArray(entry.chat)) {
    return null
  }
  return applyProfiles(
    entry.chat
      .filter((m) => m && typeof m.id === 'string' && m.category === 'chat')
      // `search` 是后加的能力标记,盘上的老记录没有这一列。缺了就按 id 现推一次:
      // 不补的话「用户早就选了 gemini-2.5-flash」会被当成没有联网后端,白白回落到兜底清单。
      .map((m) =>
        typeof m.search === 'boolean' ? m : { ...m, search: inferModelInfoFromId(m.id).search }
      )
      // 思考声明同理,而且更要紧:它是勾选那一刻的快照,家族表后来改对了也不会回头改盘上
      // 那份。实测撞过 —— `deepseek-v4-flash` 修成"会思考"之后,本机配置里仍是
      // `reasoning:false`,用户拿它对话思考过程压根不解析。所以每次读都按当前表校正一次。
      .map((m) => alignThinkingCapability(m)),
    // 再套一层后台下发的覆盖(第二层,见 model-profiles.ts)。顺序不能反:家族表先把
    // 盘上的老快照校正到当前判断,覆盖层才在这个基线上改它明确表态的那几个字段。
    // 作用域写死 'yunwu':这里读的是云雾账号勾选的清单,自定义供货商的模型不经这条路。
    'yunwu'
  )
}

/** 该账号有没有真的选过。false = 首次登录,该走选择这一步。 */
export function hasChosenChatModels(config: ActivationConfig): boolean {
  const chosen = loadSelectedChatModels(config)
  return Array.isArray(chosen) && chosen.length > 0
}

/**
 * 保存该账号选中的对话模型。
 *
 * 允许存空清单吗——不允许:一个对话模型都没有的话内核连兜底档都排不出来
 * (`resolvePrimary` 返回空串),界面上模型选择器也是空的。界面层已挡住"删到 0",
 * 这里再兜一层,避免任何调用方把用户锁死在没有模型的状态里。
 */
export function saveSelectedChatModels(config: ActivationConfig, chat: ModelInfo[]): ModelInfo[] {
  const cleaned = dedupeById(chat.filter((m) => m && m.id && m.category === 'chat'))
  const kept = cleaned.length > 0 ? cleaned : defaultChatModels()
  const catalog = readCatalog()
  // 合并而不是整条覆盖:同一个账号条目里还挂着媒体模型的选择,
  // 覆盖写会让「改一次对话模型」顺手抹掉用户选的出图 / 视频 / 语音模型。
  writeEntry(catalog, config, {
    ...readEntry(catalog, config),
    chat: kept,
    updatedAt: Date.now()
  })
  return kept
}

/** 该账号选过的媒体模型;没选过的那档返 undefined(与"选了个空清单"要分开)。 */
export function loadSelectedMediaModels(config: ActivationConfig): StoredMediaSelection {
  const entry = readEntry(readCatalog(), config)
  const ids = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) {
      return undefined
    }
    const cleaned = value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    return cleaned.length > 0 ? [...new Set(cleaned)] : undefined
  }
  return {
    image: ids(entry?.image),
    video: ids(entry?.video),
    audio: typeof entry?.audio === 'string' && entry.audio.trim() ? entry.audio.trim() : undefined
  }
}

/**
 * 保存该账号选中的媒体模型。只覆盖传进来的那几档,没传的保持原样。
 *
 * 允许存空吗——允许,而且是有意义的:一个出图模型都不选就是「不要出图能力」,
 * config-writer 会据此不写 `imageGenerationModel`,内核也就不上架 `image_generate`。
 * 这和对话模型不同(那个删到 0 会让内核连兜底档都排不出来,所以那边兜底成默认清单)。
 */
export function saveSelectedMediaModels(
  config: ActivationConfig,
  selection: StoredMediaSelection
): StoredMediaSelection {
  const catalog = readCatalog()
  const prev = readEntry(catalog, config)
  writeEntry(catalog, config, {
    ...prev,
    // 先只选了媒体、还没选过对话模型时给一份兜底:accounts 里的每条记录都必须有 chat,
    // 缺了它下次 loadSelectedChatModels 会拿到 undefined,等于这次媒体选择把账号记录写坏。
    chat: prev?.chat ?? defaultChatModels(),
    ...(selection.image !== undefined ? { image: [...new Set(selection.image)] } : {}),
    ...(selection.video !== undefined ? { video: [...new Set(selection.video)] } : {}),
    ...(selection.audio !== undefined ? { audio: selection.audio } : {}),
    updatedAt: Date.now()
  })
  return loadSelectedMediaModels(config)
}

/** 该账号有没有选过媒体模型。false = 首启引导该多走一步媒体选择。 */
export function hasChosenMediaModels(config: ActivationConfig): boolean {
  const sel = loadSelectedMediaModels(config)
  return sel.image !== undefined || sel.video !== undefined || sel.audio !== undefined
}

/**
 * 该账号此刻生效的媒体模型(选过就用选的,没选过用本地预选)。
 *
 * 这是 config-writer 落盘时的唯一取值口径:「选定即固化」对媒体同样成立 ——
 * 模型下架或这把 key 调不通时只在界面上标灰,不自动改配置(自动改就又变回"跟着 key 变")。
 */
export function resolveAccountMediaModels(config: ActivationConfig): MediaSelection {
  const sel = loadSelectedMediaModels(config)
  return {
    image: sel.image ?? IMAGE_MODEL_PREFERENCE,
    video: sel.video ?? VIDEO_MODEL_PREFERENCE,
    audio: sel.audio ?? AUDIO_MODEL_PREFERENCE
  }
}

function dedupeById(models: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>()
  return models.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
}

/**
 * 本地兜底清单:首启选择器的预勾选来源,以及该账号还没选过时的临时清单。
 *
 * 思考声明不写在那份常量里,而是每次按 id 从家族表推 —— 手抄一份就会与家族表漂移:
 * 真发生过,常量里四条一个 `thinkingLevels` 都没有,于是走兜底清单的用户(还没进过
 * 模型设置页的人)在模型卡片里只看到一个开关,拿不到低/中/高。
 */
export function defaultChatModels(): ModelInfo[] {
  return applyProfiles(
    PUBLIC_CHAT_MODELS.map((m) => {
      const inferred = inferModelInfoFromId(m.id)
      return {
        ...m,
        ...(inferred.thinkingLevels ? { thinkingLevels: inferred.thinkingLevels } : {}),
        ...(inferred.defaultThinkingLevel
          ? { defaultThinkingLevel: inferred.defaultThinkingLevel }
          : {}),
        ...(inferred.canDisableThinking === false ? { canDisableThinking: false } : {}),
        ...(inferred.thinkingEffort === false ? { thinkingEffort: false } : {}),
        ...(inferred.thinkingFormat ? { thinkingFormat: inferred.thinkingFormat } : {})
      }
    }),
    'yunwu'
  )
}

/**
 * 首启选择器该预勾哪几个。
 *
 * 只勾**在这把 key 的可选池里真实存在**的:预勾一个他调不通的模型,等于让他一进主界面
 * 第一句话就吃 404。一个都没命中就不勾,让他自己挑——选择器本来就摆在他面前。
 */
export function presetSelection(pool: ModelInfo[]): ModelInfo[] {
  const available = new Set(pool.map((m) => m.id))
  return defaultChatModels().filter((m) => available.has(m.id))
}

/** 该账号此刻生效的对话模型清单(选过就用选的,没选过用本地兜底)。 */
export function resolveAccountChatModels(config: ActivationConfig): ModelInfo[] {
  return loadSelectedChatModels(config) ?? defaultChatModels()
}

/**
 * 该账号要落进 openclaw.json 的全部模型 —— 现在只有对话模型。
 *
 * 出图模型曾经必须跟着落盘:老的接线走内核 `litellm` 槽位,而
 * `resolveImageGeneration` 是**按 id 在供货商的 models 里找**它们的。2026-08-13 出图改由
 * 自研插件的 `yunwu-image` provider 接(插件自带模型清单、凭证读 `models.providers.yunwu`),
 * 这条依赖没了 —— 与视频那侧从一开始就是同一个形状(视频模型也从不进这份清单)。
 *
 * 顺带解决一个老问题:媒体模型不再需要「留在落盘清单里但不能进对话下拉框」这种双重要求,
 * 也就不存在漏标 category 就污染下拉框的风险。
 */
export function resolveAccountModels(config: ActivationConfig): ModelInfo[] {
  return resolveAccountChatModels(config)
}

/**
 * 按账号补全激活配置的 models / defaultModel。
 *
 * 渲染层不知道该账号选过什么(清单存在主进程),所以登录时它只管把 baseUrl / token /
 * username 递过来,清单在这里定。
 *
 * 默认模型这里是**粘滞**的:传进来的还在清单里就沿用,只有它不在了才回退第一条。
 * 这是给后台路径兜底(启动对齐、模型下架不该悄悄换掉用户的默认模型);用户在选择器里
 * 亲手排出来的顺序由 `applyAccountChatModels` 显式钉成第一条,不走这条粘滞规则。
 */
export function resolveActivation(config: ActivationConfig): ActivationConfig {
  const models = resolveAccountModels(config)
  const chatIds = models.filter((m) => m.category === 'chat').map((m) => m.id)
  const defaultModel = chatIds.includes(config.defaultModel)
    ? config.defaultModel
    : chatIds[0] ?? PUBLIC_DEFAULT_MODEL
  return { ...config, models, defaultModel }
}

/**
 * 拉该 key 此刻真能调的对话模型(首启选择器与设置页「添加模型」的可选池)。
 *
 * **这是判「这个用户能用什么」的唯一权威**:它同时过了授权层(用户组 → 渠道分组)与令牌自身的
 * 模型限制,而云雾库里任何单张表都做不到——`models` 表是展示层、`channels` 是选路层、
 * `GroupPermissions` 是授权层,三层不一致是常态。
 *
 * 只返回对话类:出图那段用户改不了,视频/音频/向量进了对话下拉框就是给用户挖坑
 * (向量模型曾被误判成 chat 还因为带「推理」tag 被优先选作默认模型,实测过)。
 *
 * 按 id 排序返回:`/v1/models` 的原始顺序是乱的(实测前 40 个里全是 tts-1、davinci-002
 * 这类),直接铺给用户看,第一屏没有一个他想要的。
 */
export async function fetchAvailableChatModels(config: ActivationConfig): Promise<ModelInfo[]> {
  const { rows, listed } = await fetchListedModels(config)
  // 套后台覆盖:用户在设置页勾选的那一刻拿到的就该是纠正后的能力,否则勾完还要等下一次
  // 覆盖刷新才对(而清单是"选定即固化"的,勾错的快照会一直留在盘上)。
  return applyProfiles(
    deriveModelInfos(rows).filter((m) => m.category === 'chat' && isListed(m.id, listed)),
    'yunwu'
  ).sort((a, b) => a.id.localeCompare(b.id))
}

/** 拉一次 `/v1/models` 的原始条目。对话池与媒体池共用同一段错误口径。 */
async function fetchRawModels(config: ActivationConfig): Promise<RawModelEntry[]> {
  const base = config.baseUrl.replace(/\/+$/, '')
  let resp: Response
  try {
    resp = await fetch(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${config.token}` }
    })
  } catch (err) {
    throw new Error(`无法连接云雾(${base}): ${err instanceof Error ? err.message : String(err)}`)
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`令牌无效或权限不足(HTTP ${resp.status})`)
  }
  if (!resp.ok) {
    throw new Error(`云雾返回 HTTP ${resp.status}`)
  }
  const json = (await resp.json()) as { data?: RawModelEntry[] }
  return json.data ?? []
}

/**
 * 模型广场此刻上架的模型名。**只有广场上看得见的才配好了价格、才是正式给用户用的**,
 * 所以任何铺给用户挑的池子都要先过这一层。
 *
 * 为什么 `/v1/models` 不够:它只过了「有渠道」与「用户组有权限」两层,**不过 `models` 表的
 * `show_in_square`**。2026-08-14 真机量过:`/v1/models` 481 条、广场 404 条,多出来的 77 条
 * (`gpt-5.5-instant`、`flux-2-pro`、`suno_*_open`、`gemini-2.5-flash-thinking-*` 这类)
 * 用户在定价页根本搜不到,勾了就是拿一个没公开的东西在花钱。
 * 判据链与三层能力模型见 `references/platform-data.md`。
 *
 * 取 `/api/pricing_new` 而不是 `/api/pricing`:前者按用户组过滤,与广场页面所见一致;
 * 后者是全站未过滤的那份(实测 454 vs 404)。带上令牌让它按本账号的分组算。
 *
 * **拉不到时返回 null = 这一轮不过滤**,而不是把池子清空。与市场那侧
 * `reconcileExperts`「快照拿不到就整轮不对账」同一条纪律:接口抽风时宁可多铺几条,
 * 也不能让用户打开选择器发现一个模型都没有。
 */
async function fetchSquareModelNames(config: ActivationConfig): Promise<Set<string> | null> {
  const base = config.baseUrl.replace(/\/+$/, '')
  try {
    const resp = await fetch(`${base}/api/pricing_new`, {
      headers: { Authorization: `Bearer ${config.token}` }
    })
    if (!resp.ok) {
      console.warn(`[models] 拉模型广场清单失败(HTTP ${resp.status}),本轮不按上架过滤`)
      return null
    }
    const json = (await resp.json()) as { data?: { model_name?: string }[] }
    const names = (json.data ?? [])
      .map((m) => (typeof m.model_name === 'string' ? m.model_name.trim() : ''))
      .filter((n) => n.length > 0)
    if (names.length === 0) {
      console.warn('[models] 模型广场清单为空,本轮不按上架过滤')
      return null
    }
    return new Set(names)
  } catch (err) {
    console.warn(
      `[models] 拉模型广场清单出错,本轮不按上架过滤: ${err instanceof Error ? err.message : String(err)}`
    )
    return null
  }
}

/** 拉「这把 key 能调的」与「广场上架的」两份,后者拉不到时返回 null(即不过滤)。 */
async function fetchListedModels(
  config: ActivationConfig
): Promise<{ rows: RawModelEntry[]; listed: Set<string> | null }> {
  const [rows, listed] = await Promise.all([
    fetchRawModels(config),
    fetchSquareModelNames(config)
  ])
  return { rows, listed }
}

function isListed(id: string, listed: Set<string> | null): boolean {
  return listed === null || listed.has(id)
}

function endpointTypesOf(entry: RawModelEntry): string[] {
  return Array.isArray(entry.supported_endpoint_types) ? entry.supported_endpoint_types : []
}

function hitsEndpointType(entry: RawModelEntry, wanted: string[]): boolean {
  return endpointTypesOf(entry).some((t) => wanted.includes(t))
}

/**
 * 拉该 key 此刻能用的媒体模型,分出图 / 视频 / 语音三档(媒体选择器的可选池)。
 *
 * 判据是 `supported_endpoint_types`,不是 tags —— 理由与那份判据本身写在
 * `shared/media-endpoints.ts`:带「绘画」tag 但挂在厂商专属路径上的模型选了必然失败。
 * 端点类型之外还要过一层**模型广场上架**(见 fetchSquareModelNames):没上架的模型
 * 用户在定价页搜不到,不该出现在选择器里。
 *
 * 视频那档筛的是「插件已接入的端点类型」,所以它天然是**能真出片的那些**;上游新增了一家
 * 而插件还没接时,那家不会出现在这里(也不该出现)。
 *
 * 按 id 排序:`/v1/models` 的原始顺序是乱的(实测前 40 个全是 tts-1、davinci-002 这类)。
 */
export async function fetchAvailableMediaModels(config: ActivationConfig): Promise<{
  image: MediaModelOption[]
  video: MediaModelOption[]
  audio: MediaModelOption[]
}> {
  const { rows, listed } = await fetchListedModels(config)
  const image: MediaModelOption[] = []
  const video: MediaModelOption[] = []
  const audio: MediaModelOption[] = []
  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    // 没上架的一律不铺:判据与理由见 fetchSquareModelNames。媒体这侧 2026-08-14 实测
    // 差集为 0 条,所以这层眼下不改变任何东西 —— 留着是为了上游哪天下架一个模型时
    // 界面能跟着收,不必等我们发版。
    if (!id || !isListed(id, listed)) {
      continue
    }
    const tags = typeof row.tags === 'string' && row.tags.trim() ? row.tags.trim() : undefined
    // 出图有两条路:OpenAI 兼容的 `/v1/images/generations`,以及只在对话端点上出图的
    // Gemini 图像族(判据与理由见 `isChatImageModel`)。后者一律能按参考图改图 ——
    // 2026-08-17 真机验过:同一条 chat 请求带 `image_url` 就是编辑,10.2 秒回一张 691 KB 的 PNG。
    const chatImage = isChatImageModel(row.model_type, tags, endpointTypesOf(row))
    // 第三条路是厂商专属的异步出图(MJ / 可灵):提交 → 轮询 → 取 url,插件里一家一个适配器。
    // 这一档**都收参考图**(MJ 走 base64Array 当图片提示词、可灵走 image / image_list),
    // 其中 mj_blend 反过来只能改图 —— 界面上标「需参考图」,别让用户以为凭一句话就能出片。
    const asyncImage = hitsEndpointType(row, IMAGE_ASYNC_ENDPOINT_TYPES)
    if (hitsEndpointType(row, IMAGE_ENDPOINT_TYPES) || chatImage || asyncImage) {
      const editOnly = asyncImage && isEditOnlyImageModel(id)
      image.push({
        id,
        ...(tags ? { tags } : {}),
        ...(chatImage || asyncImage || hitsEndpointType(row, IMAGE_EDIT_ENDPOINT_TYPES)
          ? { canEdit: true }
          : {}),
        ...(editOnly ? { editOnly: true } : {})
      })
    }
    // 端点类型只说明「怎么调」,同一个类型下可能混着文生与图生两种模式,所以再按平台自己的
    // 判据分一次:两边都不占的(百炼 `-r2v` / `-video-edit`)插件还没接,不进池子。
    // 认领判据不能只查静态清单:Replicate 与 fal-ai 的类型名是逐模型的
    // (`minimax/video-01 (Async)`),所以走 `isClaimedVideoModel`。
    if (isClaimedVideoModel(id, endpointTypesOf(row))) {
      // 端点类型也要一起给:Vidu 的模式(文生 / 图生 / 首尾帧 / 参考生)编码在类型名里,
      // 光看 id 分不开(`viduq3-pro` 能文生、`viduq3` 只能参考生)。
      const types = endpointTypesOf(row)
      const textToVideo = supportsTextToVideo(id, tags, types)
      const imageToVideo = supportsImageToVideo(id, types)
      if (textToVideo || imageToVideo) {
        video.push({
          id,
          ...(tags ? { tags } : {}),
          // 只在「只能图生」时标记:两种都行的模型对用户就是普通的视频模型。
          ...(imageToVideo && !textToVideo ? { imageToVideo: true } : {})
        })
      }
    }
    if (hitsEndpointType(row, TTS_ENDPOINT_TYPES)) {
      audio.push({ id, ...(tags ? { tags } : {}) })
    }
  }
  const byId = (a: MediaModelOption, b: MediaModelOption): number => a.id.localeCompare(b.id)
  return { image: image.sort(byId), video: video.sort(byId), audio: audio.sort(byId) }
}

/**
 * 媒体选择器该预勾哪些。与对话同口径:**只勾在可选池里真实存在的**。
 *
 * 一个都没命中时不勾 —— 预勾一个这把 key 调不通的模型,等于让专家第一次出图就吃 404。
 */
export function presetMediaSelection(pool: {
  image: MediaModelOption[]
  video: MediaModelOption[]
  audio: MediaModelOption[]
}): MediaSelection {
  const has = (options: MediaModelOption[], id: string): boolean => options.some((o) => o.id === id)
  return {
    image: IMAGE_MODEL_PREFERENCE.filter((id) => has(pool.image, id)),
    video: VIDEO_MODEL_PREFERENCE.filter((id) => has(pool.video, id)),
    audio: has(pool.audio, AUDIO_MODEL_PREFERENCE) ? AUDIO_MODEL_PREFERENCE : ''
  }
}
