/**
 * Sign-in human check (go-captcha), host half.
 *
 * Ported from the previous shell's `src/main/yunwu-captcha.ts`; the wire
 * contract below was verified there against the console's own
 * `controller/captcha.go` and `captcha_crypto.go`, and has not changed:
 *
 *  - fetch a challenge: `GET /api/go-captcha-data/<type>`
 *      → `{ code: 0, captcha_key, image_base64, ... }`
 *  - submit an answer:  `POST /api/go-captcha-check-data/<type>` (multipart)
 *      key  = captcha_key
 *      data = base64( iv(16) ‖ AES-256-CBC(answer) ), PKCS#7
 *      answer text: click "x1,y1;x2,y2" · slide "x,y" · rotate "angle"
 *      → `{ code: 0, token }`
 *  - key derivation: HMAC-SHA256("new-api-captcha-aes-v1", captcha_key)
 *
 * These two routes are anonymous, which is what lets the whole path be checked
 * on a real launch without an account.
 */

import { createCipheriv, createHmac, randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { asEnvelope, ACCOUNT_TIMEOUT_MS, normalizeBase, requestJson } from './http.ts'

const CAPTCHA_AES_SALT = 'new-api-captcha-aes-v1'

/** Challenge families the console can be configured to serve. */
export type CaptchaType = 'click-text' | 'click-shape' | 'slide-basic' | 'slide-region' | 'rotate'

/** Whether the site demands a human check before sign-in, and which kind. */
export interface CaptchaConfig {
  readonly enabled: boolean
  readonly type: CaptchaType
}

/** One challenge, normalized for the browser to draw. */
export interface CaptchaChallenge {
  readonly key: string
  readonly type: CaptchaType
  readonly imageBase64: string
  readonly imageWidth: number
  readonly imageHeight: number
  readonly thumbBase64?: string
  readonly thumbWidth?: number
  readonly thumbHeight?: number
  readonly thumbSize?: number
  readonly tileX?: number
  readonly tileY?: number
  readonly tileWidth?: number
  readonly tileHeight?: number
}

interface StatusData {
  captcha_login_enabled?: boolean
  captcha_type?: string
}

interface CaptchaDataBody {
  code?: number
  message?: string
  captcha_key?: string
  image_base64?: string
  image_width?: number
  image_height?: number
  thumb_base64?: string
  thumb_width?: number
  thumb_height?: number
  thumb_size?: number
  tile_x?: number
  tile_y?: number
  tile_width?: number
  tile_height?: number
}

/**
 * Read whether sign-in requires a human check.
 *
 * Anything unreadable falls back to "not required, slide-basic": guessing
 * `enabled` high would block sign-in on a site that never asks.
 * @param ctx - host context, for the request language.
 * @param baseUrl - console origin.
 * @param signal - caller cancellation.
 * @returns the switch and the challenge family.
 */
export async function fetchCaptchaConfig(
  ctx: Context,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<CaptchaConfig> {
  const base = normalizeBase(baseUrl)
  const { body } = await requestJson(ctx, `${base}/api/status`, { method: 'GET' }, ACCOUNT_TIMEOUT_MS, signal)
  const envelope = asEnvelope<StatusData>(body)
  const data: StatusData = envelope.data ?? (body as StatusData | undefined) ?? {}
  const type = data.captcha_type
  return {
    enabled: data.captcha_login_enabled === true,
    type: isCaptchaType(type) ? type : 'slide-basic',
  }
}

/**
 * Fetch one challenge.
 * @param ctx - host context, for the request language.
 * @param baseUrl - console origin.
 * @param type - challenge family, from {@link fetchCaptchaConfig}.
 * @param signal - caller cancellation.
 * @returns the normalized challenge.
 * @throws {Error} with the console's own text when it refuses.
 */
export async function fetchCaptcha(
  ctx: Context,
  baseUrl: string,
  type: CaptchaType,
  signal?: AbortSignal,
): Promise<CaptchaChallenge> {
  const base = normalizeBase(baseUrl)
  // Slide challenges take the render size so the gap lands in the coordinate
  // system the browser draws in, which removes a scaling step on that side.
  const query = type.startsWith('slide') ? '?width=300&height=220' : ''
  const { response, body } = await requestJson(
    ctx,
    `${base}/api/go-captcha-data/${type}${query}`,
    { method: 'GET' },
    ACCOUNT_TIMEOUT_MS,
    signal,
  )
  const data = (body ?? {}) as CaptchaDataBody
  if (!response.ok || data.code !== 0 || data.captcha_key === undefined || data.image_base64 === undefined) {
    throw new Error(data.message ?? `获取验证码失败（HTTP ${response.status}）`)
  }
  return {
    key: data.captcha_key,
    type,
    imageBase64: data.image_base64,
    imageWidth: data.image_width ?? 300,
    imageHeight: data.image_height ?? 220,
    ...pick('thumbBase64', data.thumb_base64),
    ...pick('thumbWidth', data.thumb_width),
    ...pick('thumbHeight', data.thumb_height),
    ...pick('thumbSize', data.thumb_size),
    ...pick('tileX', data.tile_x),
    ...pick('tileY', data.tile_y),
    ...pick('tileWidth', data.tile_width),
    ...pick('tileHeight', data.tile_height),
  }
}

/**
 * Submit an answer and exchange it for a one-shot sign-in token.
 *
 * The console deletes the challenge once it has judged it, so a wrong answer
 * means the caller must fetch a fresh one rather than retry this key.
 * @param ctx - host context, for the request language.
 * @param baseUrl - console origin.
 * @param type - challenge family the key belongs to.
 * @param key - `captcha_key` from the challenge.
 * @param answer - plain answer text in this family's format.
 * @param signal - caller cancellation.
 * @returns the token, or an empty string when the answer was rejected.
 */
export async function verifyCaptcha(
  ctx: Context,
  baseUrl: string,
  type: CaptchaType,
  key: string,
  answer: string,
  signal?: AbortSignal,
): Promise<string> {
  const base = normalizeBase(baseUrl)
  if (key === '' || answer === '') throw new Error('验证码答案不完整')
  const form = new FormData()
  form.append('key', key)
  try {
    form.append('data', encryptAnswer(key, answer))
  } catch {
    // Encryption is not supposed to fail, but the console still accepts the
    // plain field, so a broken cipher must not cost the user their sign-in.
    form.append(plainFieldName(type), answer)
  }
  const { response, body } = await requestJson(
    ctx,
    `${base}/api/go-captcha-check-data/${type}`,
    { method: 'POST', body: form },
    ACCOUNT_TIMEOUT_MS,
    signal,
  )
  const data = (body ?? {}) as { code?: number; token?: string }
  if (!response.ok || data.code !== 0 || data.token === undefined) return ''
  return data.token
}

/** Field name the console reads when the answer arrives unencrypted. */
function plainFieldName(type: CaptchaType): 'point' | 'points' | 'angle' {
  if (type === 'rotate') return 'angle'
  if (type === 'click-text' || type === 'click-shape') return 'points'
  return 'point'
}

/** AES-256-CBC over the answer, returned as base64(iv ‖ ciphertext). */
function encryptAnswer(captchaKey: string, plain: string): string {
  const key = createHmac('sha256', CAPTCHA_AES_SALT).update(captchaKey).digest()
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  // Node pads PKCS#7 by default, which is what the console expects.
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, ciphertext]).toString('base64')
}

function isCaptchaType(value: unknown): value is CaptchaType {
  return value === 'click-text' || value === 'click-shape'
    || value === 'slide-basic' || value === 'slide-region' || value === 'rotate'
}

/** Include an optional field only when the console sent it. */
function pick<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : { [key]: value } as Record<K, V>
}
