import type { AccountBalance, AccountSnapshot } from '@shared/types'
import { clearSessionCookie, loadSessionCookie } from './account-session'
import { loadActivation } from './store'

/**
 * 账户余额取数:唯一的出入口在 `getAccountSnapshot`,渲染层只认它的返回值。
 *
 * ## 为什么走会话 cookie 而不是 sk- 令牌
 * 余额是**用户级**数据,只有 `GET /api/user/self` 给得出来,而它挂在 `UserAuthOrApiKey` 上,
 * `sk-` 调过去一律被拒。桌面端建的令牌又是 `unlimited_quota: true`,
 * 所以 `/dashboard/billing/subscription` 那类按令牌额度算的接口也回不出真实余额
 * (无限额度会被后端渲染成一个巨大的假数)。会话是我们登录时本来就拿到的,
 * 与 `/api/token/` 同一把锁 —— 后者我们登录时天天在调,所以这条路是现成能力,不需要后端加接口。
 *
 * ## 四种结果各自意味着什么(渲染层据此显示,**任何一种都不显示 0**)
 *  - `ok`          取到新数;
 *  - `stale`       这次没取到(网络/站点抖动),但手上有上次的值 → 显示旧值并标注可能过期;
 *  - `expired`     会话过期或从未存过(老版本升级上来的用户)→ 提示重新登录,只为刷余额;
 *  - `unavailable` 没有可显示的值,且原因不是过期(如首次取数就失败、账号被封禁)。
 *
 * 「取不到就显示 0」是这里最要避免的事:0 会被用户读成「我的钱没了」,
 * 而余额恰好是最容易让人误判的一格。照 WorkBuddy 的做法,取不到就退回旧值或明说取不到。
 *
 * ## 缓存
 * 只放内存,不落盘。落盘能让重启后瞬间画出数字,代价是可能画出昨天的余额;
 * 余额这一格宁可空着等一次请求(几百毫秒),也不要显示一个看着像真的旧数。
 */

/** 取数节流窗口:窗口内重复索取直接给缓存(菜单开合 + 窗口聚焦会连着触发)。 */
const FRESH_TTL_MS = 30_000

/** 站点货币配置的缓存时长:它几乎不变,没必要每次取余额都跟着拉一遍。 */
const STATUS_TTL_MS = 10 * 60_000

/** 单次请求超时:菜单是点开就要出数的地方,吊着不如快点退回「取不到」。 */
const TIMEOUT_MS = 8_000

interface ApiResp<T> {
  success: boolean
  message?: string
  data?: T
}

/** /api/user/self 里我们要用的字段(字段名见 new-yunwu-api/model/user.go)。 */
interface SelfData {
  id: number
  username: string
  display_name?: string
  quota: number
  used_quota: number
  request_count?: number
  group?: string
  status?: number
}

/** 站点额度展示口径,对齐 web 的 renderQuota / getCurrencyConfig。 */
interface CurrencyConfig {
  /** 1 单位货币 = 多少 quota。 */
  quotaPerUnit: number
  /** 货币符号;TOKENS 模式为空串(直接显示 quota 原值)。 */
  symbol: string
  /** 相对美元的汇率(USD=1,CNY 取站点 usd_exchange_rate)。 */
  rate: number
  /** TOKENS 模式:不换算、不加符号。 */
  tokens: boolean
}

const DEFAULT_CURRENCY: CurrencyConfig = {
  quotaPerUnit: 500_000,
  symbol: '$',
  rate: 1,
  tokens: false
}

let currencyCache: { config: CurrencyConfig; at: number } | null = null
let balanceCache: AccountBalance | null = null
/** 进行中的请求:菜单开合与窗口聚焦可能同时触发,合并成一次。 */
let inFlight: Promise<AccountSnapshot> | null = null

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(TIMEOUT_MS)
}

/**
 * 读站点货币配置(公开接口,不需要鉴权)。
 *
 * 拉不到就用默认口径 —— 云雾两站实测都是 quota_per_unit=500000 / USD,
 * 拿默认值算出来的数在绝大多数情况下就是对的;为一个几乎不变的配置把余额整格废掉不值。
 */
async function getCurrencyConfig(baseUrl: string): Promise<CurrencyConfig> {
  if (currencyCache && Date.now() - currencyCache.at < STATUS_TTL_MS) {
    return currencyCache.config
  }
  try {
    const resp = await fetch(`${baseUrl}/api/status`, { signal: timeoutSignal() })
    const json = (await resp.json()) as ApiResp<Record<string, unknown>>
    if (!resp.ok || !json.success || !json.data) {
      return currencyCache?.config ?? DEFAULT_CURRENCY
    }
    const d = json.data
    const perUnit = Number(d.quota_per_unit)
    const type = String(d.currency_type ?? 'USD').toUpperCase()
    const config: CurrencyConfig = {
      quotaPerUnit: Number.isFinite(perUnit) && perUnit > 0 ? perUnit : DEFAULT_CURRENCY.quotaPerUnit,
      symbol: '$',
      rate: 1,
      tokens: type === 'TOKENS'
    }
    if (type === 'CNY') {
      config.symbol = '¥'
      config.rate = Number(d.usd_exchange_rate) || 1
    } else if (type === 'CUSTOM') {
      config.symbol = String(d.custom_currency_symbol ?? '¤')
      config.rate = Number(d.custom_currency_exchange_rate) || 1
    } else if (config.tokens) {
      config.symbol = ''
    }
    currencyCache = { config, at: Date.now() }
    return config
  } catch {
    return currencyCache?.config ?? DEFAULT_CURRENCY
  }
}

/** 把 quota 整数按站点口径渲染成可读金额(对齐 web 的 renderQuota)。 */
function renderQuota(quota: number, currency: CurrencyConfig, digits = 2): string {
  if (currency.tokens) {
    return String(Math.round(quota))
  }
  const value = (quota / currency.quotaPerUnit) * currency.rate
  return currency.symbol + value.toFixed(digits)
}

/** 会话被后端否掉时的措辞判定:200 + success:false 也可能是「未登录」。 */
function looksExpired(message: string): boolean {
  return /无权|未登录|登录已过期|access token|token 无效/i.test(message)
}

/**
 * 取一次账户快照。
 *
 * force=false 时命中 30 秒节流窗口就直接给缓存(菜单反复开合不会连打后端);
 * force=true 是用户点了刷新,必须真去问一次。
 */
export function getAccountSnapshot(force = false): Promise<AccountSnapshot> {
  if (!force && balanceCache && Date.now() - balanceCache.fetchedAt < FRESH_TTL_MS) {
    return Promise.resolve({ status: 'ok', balance: balanceCache })
  }
  if (inFlight) {
    return inFlight
  }
  inFlight = fetchSnapshot().finally(() => {
    inFlight = null
  })
  return inFlight
}

/** 缓存里的上次值(可能为 null),供退回旧值用。 */
function staleOr(status: 'stale' | 'unavailable', message: string): AccountSnapshot {
  if (balanceCache) {
    return { status: 'stale', balance: balanceCache, message }
  }
  return { status, balance: null, message }
}

async function fetchSnapshot(): Promise<AccountSnapshot> {
  const act = loadActivation()
  if (!act) {
    return { status: 'unavailable', balance: null, message: '尚未登录云雾账号' }
  }
  const baseUrl = act.baseUrl.replace(/\/+$/, '')
  const cookie = loadSessionCookie(act.userId, baseUrl)
  if (!cookie) {
    // 老版本升级上来的用户手上没有会话(那时登录完就丢),重登一次即可。
    return { status: 'expired', balance: balanceCache, message: '需要重新登录才能查看余额' }
  }

  // 货币口径与账户数据并发发出。省的是**货币缓存过期后的那一次**(两条各约 200ms 的往返,
  // 串起来要 400ms);冷启动的第一次省不下多少 —— 实测串行 787ms、并发 796ms,
  // 那一次的成本在建连(TLS)而不在排队。getCurrencyConfig 自己吞异常,提前发起不会多打后端。
  const currencyPromise = getCurrencyConfig(baseUrl)

  let resp: Response
  try {
    resp = await fetch(`${baseUrl}/api/user/self`, {
      headers: { Cookie: cookie, 'New-Api-User': String(act.userId) },
      signal: timeoutSignal()
    })
  } catch (err) {
    return staleOr('unavailable', `连接云雾失败:${err instanceof Error ? err.message : String(err)}`)
  }

  // 会话失效走 401(实测无效 cookie 与不带凭据都是 401)。清掉死凭据,免得每次开菜单
  // 都拿它再打一次后端;下次进来就是「没有会话」那条路,同样提示重新登录。
  if (resp.status === 401) {
    clearSessionCookie()
    return { status: 'expired', balance: balanceCache, message: '登录已过期,重新登录即可查看余额' }
  }
  let json: ApiResp<SelfData>
  try {
    json = (await resp.json()) as ApiResp<SelfData>
  } catch {
    return staleOr('unavailable', `云雾返回异常(HTTP ${resp.status})`)
  }
  if (!resp.ok || !json.success || !json.data) {
    const msg = json.message || `获取账户信息失败(HTTP ${resp.status})`
    if (looksExpired(msg)) {
      clearSessionCookie()
      return { status: 'expired', balance: balanceCache, message: msg }
    }
    return staleOr('unavailable', msg)
  }

  const self = json.data
  const currency = await currencyPromise
  const quota = Number(self.quota) || 0
  const balance: AccountBalance = {
    quota,
    display: renderQuota(quota, currency),
    // 「不足一个货币单位」当偏低(本站 1 单位 = $1);TOKENS 站点没有货币单位,不判。
    // WorkBuddy 那边是写死的 100 积分,我们按 quota_per_unit 折算,
    // 免得站点哪天改了口径、这条阈值悄悄失去意义。
    low: !currency.tokens && quota < currency.quotaPerUnit,
    usedDisplay: renderQuota(Number(self.used_quota) || 0, currency),
    group: self.group ?? '',
    username: self.username || act.username || '',
    userId: self.id || act.userId,
    requestCount: Number(self.request_count) || 0,
    fetchedAt: Date.now()
  }
  balanceCache = balance
  return { status: 'ok', balance }
}

/**
 * 本地还有没有这个账号的会话。**纯本地判断**(一次小文件读),不打网络。
 *
 * 启动时用它决定先去登录页还是主页面:没有会话是**确定**取不到余额的
 * (老版本升级上来、或上次 401 之后我们清掉了死凭据),不必为这个确定的答案等一次往返;
 * 有会话则先进主页面,再由后台那次取数去问服务端认不认(改过密码会提前作废)。
 */
export function hasStoredSession(): boolean {
  const act = loadActivation()
  if (!act) {
    return false
  }
  return loadSessionCookie(act.userId, act.baseUrl.replace(/\/+$/, '')) !== ''
}

/** 丢掉内存里的余额缓存(退出登录时调,免得下一个账号先看到上一个账号的数)。 */
export function resetAccountCache(): void {
  balanceCache = null
}
