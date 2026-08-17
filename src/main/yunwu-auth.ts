/**
 * 云雾账号密码登录 → 自动换取可用于 /v1 调用的 sk- 令牌。
 *
 * 链路(已核对 new-yunwu-api 路由与控制器):
 *  1. POST /api/user/login {username,password} → 成功返回 {data:{id,...}} 并 Set-Cookie(会话);
 *     若站点开启 Turnstile,会先被中间件拦截并返回验证码相关错误(此时降级到令牌登录)。
 *  2. 带 Cookie + 头 `New-Api-User:<id>` 调 /api/token/:
 *     - 先 GET 列表复用名为「云雾桌面客户端」且已开启智能路由的启用令牌(sk-<key>),避免重复堆积;
 *     - 没有则 POST 创建,AddToken 直接返回 "sk-<key>"。
 *
 * 说明:模型调用一律用 sk- 令牌(计费走云雾),会话只用在两件事上 —— 登录换令牌,
 * 以及给账户菜单取余额。后者是 2026-08 加的:余额只有用户级鉴权的 /api/user/self 给得出来,
 * `sk-` 调它一律被拒,而会话本来就在手上(见 main/account-session.ts 的完整理由)。
 * 会话因此要留下来,加密存盘、只留在主进程,过期就在菜单里提示重新登录 —— 会话失效
 * 只影响那一行余额,sk- 令牌与本地配置照旧,聊天不受影响。
 *
 * 人机验证一律在应用内做(go-captcha 五种模式全部原生渲染,见 renderer/components/Captcha)。
 * 曾经还有一条「内嵌官方登录页」的旁路,2026-08-14 删掉了:两个站实测都只开 go-captcha
 * (`captcha_login_enabled: true` / `captcha_type: click-shape`,`turnstile_check` 均为 false),
 * 那条路一次都走不到,却让登录页上摆着一个「改用网页登录」的入口。后端哪天换了验证方式,
 * 按新方式适配这里即可,不必留一个平时没人走、坏了也没人发现的旁路。
 */

import { saveSessionCookie } from './account-session'

/** 桌面端自动创建/复用的令牌名(用于登录后复用,避免每次登录都新建)。 */
const TOKEN_NAME = '云雾桌面客户端'

/**
 * 建令牌时写死的智能路由模式。
 *
 * 不带智能路由的令牌只能路由到自己绑定的分组(不绑就是 default),出图/出视频/出音频
 * 的渠道大多不在 default 里,专家与专家团调这些模型就会报「无可用渠道」。
 * 云雾侧 distributor 的判据是 routing_priority 非空即把候选分组扩展到用户全部可访问分组,
 * 所以 auto/price/speed/success_rate 任意一种都够用 —— 复用时按"非空"判,不强求等于 auto,
 * 免得把用户自己在控制台改成 price 的那把当成不匹配又新建一把。
 */
const ROUTING_PRIORITY = 'auto'

interface ApiResp<T> {
  success: boolean
  message?: string
  data?: T
}

interface LoginData {
  id: number
  username: string
}

interface TokenItem {
  name?: string
  key?: string
  status?: number
  routing_priority?: string
}

/** 登录结果:换取到的 sk- 令牌 + 规范化后的 baseUrl + 账号信息。 */
export interface LoginResult {
  baseUrl: string
  token: string
  userId: number
  username: string
}

/** 从响应的 Set-Cookie 提炼出可回发的 Cookie 头(仅取每条的 name=value)。 */
function cookieHeaderFrom(resp: Response): string {
  // undici(Electron/Node)支持 getSetCookie();回退到单个 set-cookie。
  const getter = (resp.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie
  const list = typeof getter === 'function' ? getter.call(resp.headers) : []
  const cookies = list.length ? list : [resp.headers.get('set-cookie') ?? '']
  return cookies
    .filter((c) => c)
    .map((c) => c.split(';')[0])
    .join('; ')
}

/** 带会话与 New-Api-User 头的鉴权请求。 */
function authFetch(
  url: string,
  cookie: string,
  userId: number,
  init?: RequestInit
): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'New-Api-User': String(userId),
      ...(init?.headers as Record<string, string> | undefined)
    }
  })
}

/** 从多种可能的分页结构里提炼令牌数组(兼容 items/records/data/裸数组)。 */
function extractItems(data: unknown): TokenItem[] {
  if (Array.isArray(data)) {
    return data as TokenItem[]
  }
  const obj = data as Record<string, unknown> | null
  for (const k of ['items', 'records', 'data', 'list']) {
    if (obj && Array.isArray(obj[k])) {
      return obj[k] as TokenItem[]
    }
  }
  return []
}

/**
 * 复用或创建 sk- 令牌。
 *
 * 老版本建的令牌没有智能路由,出图/出视频会撞「无可用渠道」。这里不去改它
 * (PUT /api/token/ 是整份字段覆盖,漏传一个字段就会把用户在控制台设的
 * 模型限制/IP 白名单等清掉),而是直接新建一把合规的:判据加了智能路由这一条,
 * 旧的那把从此不再命中,新的会命中,所以每个账号最多多出一把,不会每次登录都涨。
 */
async function getOrCreateToken(baseUrl: string, cookie: string, userId: number): Promise<string> {
  // 复用:命中名称匹配、启用(status=1)且已开启智能路由的令牌。
  try {
    const listResp = await authFetch(`${baseUrl}/api/token/?p=1&page_size=100`, cookie, userId)
    const listJson = (await listResp.json()) as ApiResp<unknown>
    if (listResp.ok && listJson.success) {
      const items = extractItems(listJson.data)
      const found = items.find(
        (t) =>
          t?.name === TOKEN_NAME &&
          t?.status === 1 &&
          typeof t?.key === 'string' &&
          t.key &&
          typeof t?.routing_priority === 'string' &&
          t.routing_priority !== ''
      )
      if (found?.key) {
        return `sk-${found.key}`
      }
    }
  } catch {
    /* 复用失败不阻塞:退回创建 */
  }

  // 创建:AddToken 直接返回 "sk-<key>"。无限额度 = 走账户余额;永不过期;
  // 不绑分组(留空落 default),由智能路由在用户全部可访问分组里挑渠道。
  const createResp = await authFetch(`${baseUrl}/api/token/`, cookie, userId, {
    method: 'POST',
    body: JSON.stringify({
      name: TOKEN_NAME,
      unlimited_quota: true,
      expired_time: -1,
      routing_priority: ROUTING_PRIORITY
    })
  })
  const createJson = (await createResp.json()) as ApiResp<string>
  if (!createResp.ok || !createJson.success || typeof createJson.data !== 'string') {
    throw new Error(createJson.message || `创建令牌失败(HTTP ${createResp.status})`)
  }
  return createJson.data
}

/** 一次账号密码登录的产物:会话 cookie + 后端回的身份。 */
interface SessionLogin {
  baseUrl: string
  cookie: string
  userId: number
  username: string
}

/**
 * 账号密码登录,只到「拿到会话」为止。
 *
 * captchaToken:站点开启登录人机验证时,先经 go-captcha 换取的一次性令牌;后端在 login 时强制校验。
 * 失败时抛出可读中文错误;因人机验证被拒会带上 needCaptcha 标记,供渲染层补弹验证层重试。
 */
async function loginForSession(
  baseUrl: string,
  username: string,
  password: string,
  captchaToken?: string
): Promise<SessionLogin> {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (!trimmed) {
    throw new Error('云雾地址不能为空')
  }
  if (!username.trim() || !password) {
    throw new Error('请输入账号与密码')
  }

  let resp: Response
  try {
    resp = await fetch(`${trimmed}/api/user/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.trim(), password, captcha_token: captchaToken ?? '' })
    })
  } catch (err) {
    throw new Error(`无法连接云雾(${trimmed}): ${err instanceof Error ? err.message : String(err)}`)
  }

  const cookie = cookieHeaderFrom(resp)
  const json = (await resp.json().catch(() => ({}))) as ApiResp<LoginData>
  if (!resp.ok || !json.success || !json.data) {
    const msg = json.message || `登录失败(HTTP ${resp.status})`
    // 站点开着人机验证却没带 token:标记出来,让渲染层补弹一次应用内验证层再重试。
    if (/turnstile|验证码|captcha|人机验证/i.test(msg)) {
      const e = new Error(msg) as Error & { needCaptcha?: boolean }
      e.needCaptcha = true
      throw e
    }
    throw new Error(msg)
  }
  if (!cookie) {
    throw new Error('登录未返回会话,请改用「令牌登录」')
  }
  return { baseUrl: trimmed, cookie, userId: json.data.id, username: json.data.username }
}

/**
 * 账号密码登录并换取 sk- 令牌。失败时抛出可读中文错误(含验证码降级提示)。
 *
 * 会话 cookie 顺手加密存盘(供账户菜单取余额),但**不**随返回值出主进程:
 * 它的权限远大于 sk-,渲染层不需要也不该看到(见 account-session.ts)。
 * 存盘失败不影响登录本身 —— 顶多是余额那一行取不到数、提示重新登录。
 */
export async function loginWithPassword(
  baseUrl: string,
  username: string,
  password: string,
  captchaToken?: string
): Promise<LoginResult> {
  const session = await loginForSession(baseUrl, username, password, captchaToken)
  const token = await getOrCreateToken(session.baseUrl, session.cookie, session.userId)
  try {
    saveSessionCookie(session.userId, session.baseUrl, session.cookie)
  } catch (err) {
    console.warn('[account] 会话存盘失败(不影响登录):', err)
  }
  return {
    baseUrl: session.baseUrl,
    token,
    userId: session.userId,
    username: session.username
  }
}


