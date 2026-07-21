/**
 * 云雾登录人机验证码(go-captcha)桌面端对接。
 *
 * 为什么放在主进程:渲染层是独立源(file:///localhost),直接 fetch 云雾的验证码接口会被
 * CORS 拦截;主进程用 Node fetch 无同源限制。渲染层只负责显示图片、收集点击/滑动坐标。
 *
 * 契约(已核对 new-yunwu-api/controller/captcha.go 与 captcha_crypto.go):
 *  - 取题 GET /api/go-captcha-data/<type>  → { code:0, captcha_key, image_base64, image_width, ... }
 *  - 校验 POST /api/go-captcha-check-data/<type>(multipart):
 *      key   = captcha_key
 *      data  = base64( iv(16) ‖ AES-256-CBC(answer) ),PKCS#7;后端也兼容明文 point/points/angle
 *      答案格式:点选 "x1,y1;x2,y2";滑块 "x,y";旋转 "angle"
 *    → { code:0, token }
 *  - 密钥派生:aesKey = HMAC-SHA256("new-api-captcha-aes-v1", captcha_key)(32 字节)
 */

import { createHmac, createCipheriv, randomBytes } from 'crypto'
import type { CaptchaChallenge, CaptchaConfig, CaptchaType } from '@shared/types'

const CAPTCHA_AES_SALT = 'new-api-captcha-aes-v1'

/** 归一化 baseUrl(去尾部斜杠)。 */
function normalizeBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (!trimmed) {
    throw new Error('云雾地址不能为空')
  }
  return trimmed
}

/** 取题接口后缀:slide-region 复用 slide-basic 的资源尺寸参数。 */
function dataPath(type: CaptchaType): string {
  return type
}

/** 校验答案的明文字段名(仅在 data 加密不可用时才会用到;此处始终走 data)。 */
function answerFieldName(type: CaptchaType): 'point' | 'points' | 'angle' {
  if (type === 'rotate') {
    return 'angle'
  }
  if (type === 'click-text' || type === 'click-shape') {
    return 'points'
  }
  return 'point'
}

/** HMAC-SHA256(salt, captchaKey) 派生 32 字节 AES 密钥。 */
function deriveAesKey(captchaKey: string): Buffer {
  return createHmac('sha256', CAPTCHA_AES_SALT).update(captchaKey).digest()
}

/** AES-256-CBC 加密答案,返回 base64(iv ‖ ciphertext)。Node 默认 PKCS#7 填充,与后端一致。 */
function encryptAnswer(captchaKey: string, plain: string): string {
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', deriveAesKey(captchaKey), iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, ciphertext]).toString('base64')
}

interface StatusData {
  captcha_login_enabled?: boolean
  captcha_type?: string
}

/** 读取站点登录验证码开关与类型。异常/字段缺失时按"未开启 + slide-basic"保守返回。 */
export async function fetchCaptchaConfig(baseUrl: string): Promise<CaptchaConfig> {
  const base = normalizeBase(baseUrl)
  const resp = await fetch(`${base}/api/status`)
  const json = (await resp.json().catch(() => ({}))) as { data?: StatusData } & StatusData
  const data: StatusData = json.data ?? json
  const type = (data.captcha_type as CaptchaType) || 'slide-basic'
  return { enabled: data.captcha_login_enabled === true, type }
}

interface CaptchaDataResp {
  code: number
  message?: string
  captcha_key?: string
  image_base64?: string
  image_width?: number
  image_height?: number
  thumb_base64?: string
  thumb_width?: number
  thumb_height?: number
  tile_x?: number
  tile_y?: number
  tile_width?: number
  tile_height?: number
}

/** 取一道验证码题并规范化为 CaptchaChallenge。 */
export async function fetchCaptcha(baseUrl: string, type: CaptchaType): Promise<CaptchaChallenge> {
  const base = normalizeBase(baseUrl)
  // 滑块需要把渲染尺寸传给后端,让缺口落在真实坐标系,免去前端缩放换算。
  const query = type.startsWith('slide') ? '?width=300&height=220' : ''
  const resp = await fetch(`${base}/api/go-captcha-data/${dataPath(type)}${query}`)
  const body = (await resp.json().catch(() => ({}))) as CaptchaDataResp
  if (!resp.ok || body.code !== 0 || !body.captcha_key || !body.image_base64) {
    throw new Error(body.message || `获取验证码失败(HTTP ${resp.status})`)
  }
  return {
    key: body.captcha_key,
    type,
    imageBase64: body.image_base64,
    imageWidth: body.image_width ?? 300,
    imageHeight: body.image_height ?? 220,
    thumbBase64: body.thumb_base64,
    thumbWidth: body.thumb_width,
    thumbHeight: body.thumb_height,
    tileX: body.tile_x,
    tileY: body.tile_y,
    tileWidth: body.tile_width,
    tileHeight: body.tile_height
  }
}

interface CaptchaCheckResp {
  code: number
  message?: string
  token?: string
}

/**
 * 提交答案换取一次性 captcha_token。answer 为明文(点选/滑块/旋转格式),内部 AES 加密后以 data 字段提交。
 * 校验失败(code!=0)返回空 token,由调用方决定重取或回落网页登录。
 */
export async function verifyCaptcha(
  baseUrl: string,
  type: CaptchaType,
  key: string,
  answer: string
): Promise<string> {
  const base = normalizeBase(baseUrl)
  if (!key || !answer) {
    throw new Error('验证码答案不完整')
  }
  const form = new FormData()
  form.append('key', key)
  try {
    form.append('data', encryptAnswer(key, answer))
  } catch {
    // 极端情况下加密失败:回落明文字段(后端同样支持)。
    form.append(answerFieldName(type), answer)
  }
  const resp = await fetch(`${base}/api/go-captcha-check-data/${dataPath(type)}`, {
    method: 'POST',
    body: form
  })
  const body = (await resp.json().catch(() => ({}))) as CaptchaCheckResp
  if (!resp.ok || body.code !== 0 || !body.token) {
    return ''
  }
  return body.token
}
