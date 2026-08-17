import type {
  DesktopScenario,
  DesktopScenarioKind,
  DesktopScene,
  MarketAssetType,
  MarketItem,
  MarketSnapshot,
  ScenarioArtifact
} from '@shared/types'
import { app } from 'electron'
import { loadActivation } from '../store'
import {
  buildDesktopConfigCacheKey,
  buildSnapshotCacheKey,
  getCachedList,
  setCachedList
} from './market-cache'

/**
 * 本地 Agent 市场客户端:以云雾 sk- 令牌调用 admin-server 的
 * `/api/desktop-market/*` 接口(TokenAuth 鉴权,与调模型同一凭据)。
 *
 * base URL 解析优先级:
 *  1. 环境变量 YUNWU_MARKET_BASE_URL(私有化/联调覆盖,最高优先级);
 *  2. 开发期(未打包)默认指向本地客服后端 admin-server:localhost:3000(市场路由所在,
 *     与 admin-cloud dev 代理默认目标一致)—— 用户端 new-yunwu-api(登录/模型,默认 3001)
 *     没有 /api/desktop-market/* 路由;两者同库,令牌互通;端口不同用 YUNWU_MARKET_BASE_URL 覆盖;
 *  3. 生产(已打包):激活配置里的 baseUrl(默认 https://yunwu.ai)——若把 admin-server
 *     反代到同域 /api 下即可直接命中;独立部署时用 env 指向 admin-server 公网地址。
 */
export function marketBaseUrl(): string {
  const envBase = process.env.YUNWU_MARKET_BASE_URL?.trim()
  if (envBase) {
    return envBase.replace(/\/+$/, '')
  }
  // 开发期默认走本地 admin-server:3000(env 未显式指定时);env 始终可覆盖。
  if (!app.isPackaged) {
    return 'http://localhost:3000'
  }
  const act = loadActivation()
  const base = act?.baseUrl?.trim() || 'https://yunwu.ai'
  return base.replace(/\/+$/, '')
}

/**
 * 市场(与反馈)鉴权用的令牌。默认就是激活令牌 —— 生产是同站同库,本来是同一把。
 *
 * `YUNWU_MARKET_TOKEN` 可单独覆盖,与上面的 `YUNWU_MARKET_BASE_URL` 同口径(env 最高优先级)。
 * 开发期需要它:模型与登录打海外线上站(见 `Activate.tsx` 的 dev 默认地址,本地站没有承载渠道、
 * 模型一律打不通),而市场挂在本地 admin-server 上,两边的 `tokens` 表不是同一个库
 * (本地 `jishu_test` vs 海外站),线上令牌过不了这边的 `TokenAuth`。
 * 拿一把本地站(localhost:3001)的 sk- 令牌塞进这个 env 即可。
 */
export function requireToken(): string {
  const envToken = process.env.YUNWU_MARKET_TOKEN?.trim()
  if (envToken) {
    return envToken
  }
  const act = loadActivation()
  if (!act?.token) {
    throw new Error('未登录云雾账号,无法访问市场')
  }
  return act.token
}

/** 统一的鉴权请求:带 Bearer sk- 令牌,解析 {success,message,data} 信封。 */
async function marketFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = requireToken()
  const url = `${marketBaseUrl()}${path}`
  let resp: Response
  try {
    resp = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init?.headers as Record<string, string> | undefined)
      }
    })
  } catch (err) {
    throw new Error(`无法连接市场服务: ${err instanceof Error ? err.message : String(err)}`)
  }
  const json = (await resp.json().catch(() => ({}))) as {
    success?: boolean
    message?: string
    data?: T
  }
  if (!resp.ok || !json.success) {
    throw new Error(json.message || `市场服务返回 HTTP ${resp.status}`)
  }
  return json.data as T
}

/**
 * 带 ETag 协商 + 离线兜底缓存的鉴权 GET:
 *  1. 携带上次响应 ETag 发 If-None-Match;服务端 304 → 复用缓存(省流量);
 *  2. 200 成功 → 更新缓存(含新 ETag)并返回最新;
 *  3. 网络不可达 / 服务端异常 → 若有缓存则降级返回并标记 stale,否则抛错。
 * 服务端未下发 ETag 也不影响:If-None-Match 被忽略即恒 200,缓存照常更新,离线兜底仍生效。
 */
async function cachedGet<T>(path: string, cacheKey: string): Promise<{ data: T; stale: boolean }> {
  const token = requireToken()
  const cached = getCachedList<T>(cacheKey)

  let resp: Response
  try {
    resp = await fetch(`${marketBaseUrl()}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(cached?.etag ? { 'If-None-Match': cached.etag } : {})
      }
    })
  } catch {
    // 网络不可达:有缓存则离线兜底,否则抛出可读错误。
    if (cached) {
      return { data: cached.data, stale: true }
    }
    throw new Error('无法连接市场服务,且无本地缓存可用')
  }

  // 服务端判定未变更:直接复用缓存正文。
  if (resp.status === 304 && cached) {
    return { data: cached.data, stale: false }
  }

  const json = (await resp.json().catch(() => ({}))) as {
    success?: boolean
    message?: string
    data?: T
  }
  if (!resp.ok || !json.success || json.data === undefined || json.data === null) {
    // 服务端异常:优先降级返回缓存,避免市场页白屏。
    if (cached) {
      return { data: cached.data, stale: true }
    }
    throw new Error(json.message || `市场服务返回 HTTP ${resp.status}`)
  }

  const etag = resp.headers.get('etag') || undefined
  setCachedList<T>(cacheKey, { etag, data: json.data, ts: Date.now() })
  return { data: json.data, stale: false }
}

/**
 * 拉取某类型的全量市场快照:一次请求拿全「已上架条目 + 可见分类」。
 *
 * 取代此前「翻页拉全再拼接」:目录本身很小(去掉 manifest 后专家约 80KB),分页除了把静默截断的
 * 风险留给客户端别无好处——只拉第一页时用户看到的是"市场里就这么多",没有任何报错。关键词与
 * 分类过滤改在本地做,切 chip 是瞬时的。manifest 仍由 marketDetail 按需取。
 *
 * 需要 admin-server 提供 /api/desktop-market/snapshot(旧版服务端没有该路由,会走离线兜底或报错),
 * 所以服务端要先于桌面端发布。
 */
export async function fetchMarketSnapshot(type: MarketAssetType): Promise<MarketSnapshot> {
  const key = buildSnapshotCacheKey(type, requireToken(), marketBaseUrl())
  const res = await cachedGet<MarketSnapshot>(
    `/api/desktop-market/snapshot?type=${encodeURIComponent(type)}`,
    key
  )
  return res.stale ? { ...res.data, stale: true } : res.data
}

/** 拉取精选场景(已上架),供桌面端首页场景卡渲染。失败/离线时上层容错为空。 */
/**
 * 拉取精选场景卡与首页案例(已上架)。失败/离线时上层容错为空。
 *
 * 服务端一次返回全部、不分页(同 listScenes)。原先这里带 page_size=50,案例导到 126 条之后
 * 每个场景只够覆盖前三四条,首页那行一屏 5 张凑不齐 —— 而静默截断不报错。
 */
export async function listScenarios(kind?: DesktopScenarioKind): Promise<DesktopScenario[]> {
  const query = kind ? `?kind=${encodeURIComponent(kind)}` : ''
  const res = await marketFetch<{ items?: DesktopScenario[] }>(
    `/api/desktop-market/scenarios${query}`
  )
  return res.items ?? []
}

/**
 * 换一条案例产物的预览直链(HTML / 视频)。
 *
 * 服务端存的是对象存储的 key,签出来的 URL 有效期取存储配置(默认 24h),所以这个调用
 * 必须发生在「打开弹窗」那一刻,不能跟着列表一起缓存 —— 过期的直链不会报错,
 * iframe 就是一片空白。link 类没有可签的产物,服务端会直接回失败。
 */
export async function scenarioArtifact(id: number): Promise<ScenarioArtifact> {
  return marketFetch<ScenarioArtifact>(`/api/desktop-market/scenarios/${id}/artifact`)
}

/**
 * 拉取首页场景(已上架),供输入框上方那行胶囊渲染。失败/离线时上层容错为空。
 *
 * 服务端一次返回全部、不分页(见 model.ListVisibleDesktopScenes 的注释),
 * 故这里不带 page_size —— 目录本身很小,分页只会把静默截断的风险留给客户端。
 */
export async function listScenes(): Promise<DesktopScene[]> {
  const res = await marketFetch<{ items?: DesktopScene[] }>('/api/desktop-market/scenes')
  return res.items ?? []
}

/**
 * 拉桌面端产品配置(目前只有模型参数覆盖层)。
 *
 * 刻意做成「一份产品配置」而不是「模型参数列表」,对齐 WorkBuddy 的 `getProductConfiguration`:
 * 将来加媒体参数、加别的客户端旋钮都往这个响应里挂,不必再开一条路、客户端也不必再多一次请求。
 * 与市场同一把 sk- 令牌、同一个 admin-server,所以走上面那套 cachedGet(ETag + 离线兜底)。
 */
export async function fetchDesktopConfig<T>(): Promise<T> {
  const key = buildDesktopConfigCacheKey(requireToken(), marketBaseUrl())
  const res = await cachedGet<T>('/api/desktop-config', key)
  return res.data
}

/**
 * 只读磁盘缓存里的产品配置,**不打网络**(启动期用)。
 *
 * 未登录 / 没缓存都返回 undefined —— 调用方据此当作「没有覆盖层」,回落客户端家族表。
 */
export function readCachedDesktopConfig<T>(): T | undefined {
  try {
    const key = buildDesktopConfigCacheKey(requireToken(), marketBaseUrl())
    return getCachedList<T>(key)?.data
  } catch {
    return undefined
  }
}

/** 取单个条目详情(含 manifest,连接器/专家安装时需要)。 */
export function marketDetail(type: MarketAssetType, slug: string): Promise<MarketItem> {
  return marketFetch<MarketItem>(
    `/api/desktop-market/items/${encodeURIComponent(type)}/${encodeURIComponent(slug)}`
  )
}

/** 换取 zip 制品的预签名下载信息。 */
export function getDownloadInfo(
  type: MarketAssetType,
  slug: string
): Promise<{ url: string; sha256: string; size: number; version: string }> {
  return marketFetch(
    `/api/desktop-market/items/${encodeURIComponent(type)}/${encodeURIComponent(slug)}/download-url`,
    { method: 'POST' }
  )
}
