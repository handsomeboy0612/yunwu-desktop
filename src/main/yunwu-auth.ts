/**
 * 云雾账号密码登录 → 自动换取可用于 /v1 调用的 sk- 令牌。
 *
 * 链路(已核对 new-yunwu-api 路由与控制器):
 *  1. POST /api/user/login {username,password} → 成功返回 {data:{id,...}} 并 Set-Cookie(会话);
 *     若站点开启 Turnstile,会先被中间件拦截并返回验证码相关错误(此时降级到令牌登录)。
 *  2. 带 Cookie + 头 `New-Api-User:<id>` 调 /api/token/:
 *     - 先 GET 列表复用名为「云雾桌面客户端」的启用令牌(sk-<key>),避免重复堆积;
 *     - 没有则 POST 创建,AddToken 直接返回 "sk-<key>"。
 *
 * 说明:桌面端只在"登录换取令牌"这一步用会话;后续模型调用一律用 sk- 令牌(计费走云雾),
 * 不长期持有会话 cookie,规避会话过期/多设备下线带来的复杂度。
 */

import { BrowserWindow } from 'electron'

/** 桌面端自动创建/复用的令牌名(用于登录后复用,避免每次登录都新建)。 */
const TOKEN_NAME = '云雾桌面客户端'

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

/** 复用或创建 sk- 令牌。 */
async function getOrCreateToken(baseUrl: string, cookie: string, userId: number): Promise<string> {
  // 复用:命中名称匹配且启用(status=1)的令牌。
  try {
    const listResp = await authFetch(`${baseUrl}/api/token/?p=1&page_size=100`, cookie, userId)
    const listJson = (await listResp.json()) as ApiResp<unknown>
    if (listResp.ok && listJson.success) {
      const items = extractItems(listJson.data)
      const found = items.find(
        (t) => t?.name === TOKEN_NAME && t?.status === 1 && typeof t?.key === 'string' && t.key
      )
      if (found?.key) {
        return `sk-${found.key}`
      }
    }
  } catch {
    /* 复用失败不阻塞:退回创建 */
  }

  // 创建:AddToken 直接返回 "sk-<key>"。无限额度 = 走账户余额;永不过期。
  const createResp = await authFetch(`${baseUrl}/api/token/`, cookie, userId, {
    method: 'POST',
    body: JSON.stringify({ name: TOKEN_NAME, unlimited_quota: true, expired_time: -1 })
  })
  const createJson = (await createResp.json()) as ApiResp<string>
  if (!createResp.ok || !createJson.success || typeof createJson.data !== 'string') {
    throw new Error(createJson.message || `创建令牌失败(HTTP ${createResp.status})`)
  }
  return createJson.data
}

/**
 * 账号密码登录并换取 sk- 令牌。失败时抛出可读中文错误(含验证码降级提示)。
 * captchaToken:站点开启登录人机验证时,先经 go-captcha 换取的一次性令牌;后端在 login 时强制校验。
 */
export async function loginWithPassword(
  baseUrl: string,
  username: string,
  password: string,
  captchaToken?: string
): Promise<LoginResult> {
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
    // 站点开启人机验证/验证码时:直连 API 无法通过,提示改用「网页登录」(webview 内完成验证)。
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

  const token = await getOrCreateToken(trimmed, cookie, json.data.id)
  return { baseUrl: trimmed, token, userId: json.data.id, username: json.data.username }
}

/**
 * 网页登录(应对站点开启人机验证/验证码):打开内嵌窗口加载云雾登录页,
 * 用户在窗口内完成账号密码 + 人机验证登录;前端登录成功会 `localStorage.setItem('user', ...)`
 * (已核对 new-api 前端契约)。据此判定登录成功,读取会话 cookie + 用户 id,换取 sk- 令牌。
 *
 * 这是"真正的账号登录":无需在应用内复刻验证码,全部交给官方登录页,零维护、零风险。
 */
export function loginViaWebview(baseUrl: string): Promise<LoginResult> {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (!trimmed) {
    return Promise.reject(new Error('云雾地址不能为空'))
  }

  return new Promise<LoginResult>((resolve, reject) => {
    const win = new BrowserWindow({
      width: 480,
      height: 680,
      title: '登录云雾',
      autoHideMenuBar: true,
      webPreferences: {
        // 独立分区:与应用其它会话隔离,仅用于本次登录取 cookie。
        partition: 'yunwu-login',
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearInterval(timer)
      fn()
      if (!win.isDestroyed()) {
        win.close()
      }
    }

    // 轮询前端 localStorage 的 user(登录成功后由前端写入,含 id/username)。
    const timer = setInterval(() => {
      if (win.isDestroyed()) {
        return
      }
      win.webContents
        .executeJavaScript('window.localStorage.getItem("user")', true)
        .then(async (raw) => {
          if (!raw || typeof raw !== 'string') {
            return
          }
          let user: { id?: number; username?: string }
          try {
            user = JSON.parse(raw)
          } catch {
            return
          }
          if (typeof user.id !== 'number') {
            return
          }
          // 命中登录成功:取会话 cookie + id 换取 sk- 令牌。
          try {
            const cookies = await win.webContents.session.cookies.get({ url: trimmed })
            const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
            const token = await getOrCreateToken(trimmed, cookieHeader, user.id)
            finish(() => resolve({ baseUrl: trimmed, token, userId: user.id as number, username: user.username ?? '' }))
          } catch (err) {
            finish(() => reject(err instanceof Error ? err : new Error(String(err))))
          }
        })
        .catch(() => {
          /* 页面切换瞬间脚本执行失败可忽略,下次轮询重试 */
        })
    }, 700)

    // 兜底超时(3 分钟),避免窗口长期驻留。
    const timeout = setTimeout(() => {
      finish(() => reject(new Error('登录超时,请重试')))
    }, 180000)

    win.on('closed', () => {
      clearTimeout(timeout)
      if (!settled) {
        settled = true
        clearInterval(timer)
        reject(new Error('登录窗口已关闭'))
      }
    })

    void win.loadURL(`${trimmed}/login`)
  })
}
