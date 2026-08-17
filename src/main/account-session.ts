import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { decryptSecret, encryptSecret } from './secret-box'

/**
 * 云雾**会话 cookie** 的落盘处,与 activation.json 分开放。
 *
 * 为什么要存它:账户余额只有用户级鉴权的 `GET /api/user/self` 给得出来
 * ——`sk-` 令牌调它一律被拒(实测回「无权进行此操作，access token 无效」),
 * 而登录时后端本来就 Set-Cookie 给了我们一张 30 天的会话(`setupLogin` 的 MaxAge)。
 * 这张 cookie 与 `/api/token/` 用的是同一把锁(两者都挂 `UserAuthOrApiKey`),
 * 而那条路我们登录时天天在走,所以拿它换余额是现成能力,不需要后端加接口。
 *
 * 为什么单独一个文件、而不是塞进 activation.json:
 *  1. `saveActivation` 是**整份覆盖写**,而渲染层递上来的 ActivationConfig 里不可能有 cookie
 *     ——放一起的话,登录后紧跟的那次 `yunwu:activate` 会静默把它冲掉;
 *  2. ActivationConfig 是跨 IPC 的共享类型,cookie 一旦挂上去就会随激活态发给渲染层。
 *     会话的权限远大于 `sk-`(能建令牌、兑换充值、划转提现、甚至删号),不该出主进程。
 *
 * 落盘一律加密(safeStorage);钥匙串不可用时降级明文,与 API Key 同口径。
 * 按 `userId + baseUrl` 记账并在读取时核对:换账号或换站点后残留的旧会话绝不会被拿去用。
 */
interface StoredSession {
  /** 会话归属的云雾用户 id。与当前激活态不一致时视为无效。 */
  userId: number
  /** 会话归属的站点(规范化后的 baseUrl)。 */
  baseUrl: string
  /** 密文(或降级明文)的 Cookie 头,形如 `session=...`。 */
  cookie: string
  /** 写入时刻,用于日志与「会话多久没刷新过」的判断。 */
  savedAt: number
}

function sessionFile(): string {
  return join(app.getPath('userData'), 'account-session.json')
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

/** 保存会话 cookie(覆盖写)。cookie 为空时等价于清除。 */
export function saveSessionCookie(userId: number, baseUrl: string, cookie: string): void {
  if (!cookie) {
    clearSessionCookie()
    return
  }
  const stored: StoredSession = {
    userId,
    baseUrl: normalizeBase(baseUrl),
    cookie: encryptSecret(cookie),
    savedAt: Date.now()
  }
  writeFileSync(sessionFile(), JSON.stringify(stored, null, 2), 'utf-8')
}

/**
 * 读取当前账号可用的会话 cookie;没有、解不开、或归属对不上都返回空串。
 *
 * 归属对不上就当没有(而不是清掉文件):清除留给显式的退出登录,
 * 免得「同一台机器两个账号来回切」变成互相把对方的会话删掉。
 */
export function loadSessionCookie(userId: number, baseUrl: string): string {
  const file = sessionFile()
  if (!existsSync(file)) {
    return ''
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as StoredSession
    if (parsed.userId !== userId || parsed.baseUrl !== normalizeBase(baseUrl)) {
      return ''
    }
    return decryptSecret(parsed.cookie ?? '')
  } catch {
    return ''
  }
}

/** 清除会话 cookie(退出登录、或后端明确告知会话已失效时)。 */
export function clearSessionCookie(): void {
  const file = sessionFile()
  if (existsSync(file)) {
    rmSync(file)
  }
}
