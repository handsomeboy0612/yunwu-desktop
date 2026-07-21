import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import crypto from 'node:crypto'

/**
 * 本地设备身份(ed25519),用于 OpenClaw 网关的设备鉴权握手(路 A)。
 *
 * 实现严格对齐 OpenClaw 官方 `device-identity` 与 `buildDeviceAuthPayloadV3`:
 *  - 密钥类型 ed25519;公钥导出 SPKI PEM,私钥导出 PKCS8 PEM;
 *  - deviceId = sha256(原始 32 字节公钥) 的十六进制;
 *  - 连接时用私钥对 v3 payload 签名(base64url),网关据此在回环自动配对并授予 scopes。
 *
 * 任何字段/拼接顺序偏差都会导致 DEVICE_AUTH_SIGNATURE_INVALID,故与官方逐字节一致。
 */
export interface DeviceIdentity {
  deviceId: string
  publicKeyPem: string
  privateKeyPem: string
}

/** ed25519 SPKI 公钥前缀(12 字节),用于从 DER 中裁出原始 32 字节公钥。 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/** 持久化的身份文件结构(version:1)。 */
interface StoredIdentity {
  version: 1
  deviceId: string
  publicKeyPem: string
  privateKeyPem: string
  createdAtMs: number
}

/** base64url 编码(无填充),与 OpenClaw device-identity 保持一致。 */
function base64Url(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

/** 从 SPKI PEM 公钥中导出原始 32 字节 ed25519 公钥。 */
function rawPublicKey(publicKeyPem: string): Buffer {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length)
  }
  return spki
}

/** 计算稳定 deviceId = sha256(原始公钥) 十六进制。 */
function fingerprint(publicKeyPem: string): string {
  return crypto.createHash('sha256').update(rawPublicKey(publicKeyPem)).digest('hex')
}

/** 生成一份新的 ed25519 设备身份。 */
function generateIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  return { deviceId: fingerprint(publicKeyPem), publicKeyPem, privateKeyPem }
}

/** 身份文件路径:用户数据目录下 device-identity.json(与 OpenClaw 自身身份隔离)。 */
function identityFile(): string {
  return join(app.getPath('userData'), 'device-identity.json')
}

/** 校验存储的密钥对是否自洽(签名/验签自检)。 */
function keyPairMatches(publicKeyPem: string, privateKeyPem: string): boolean {
  try {
    const payload = Buffer.from('yunwu-device-identity-self-check', 'utf8')
    const signature = crypto.sign(null, payload, crypto.createPrivateKey(privateKeyPem))
    return crypto.verify(null, payload, crypto.createPublicKey(publicKeyPem), signature)
  } catch {
    return false
  }
}

/**
 * 读取已持久化的设备身份;无效或不存在时生成并写入新的身份。
 * deviceId 以公钥指纹为准(即使文件中记录漂移也以派生值为准)。
 */
export function loadOrCreateDeviceIdentity(): DeviceIdentity {
  const file = identityFile()
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<StoredIdentity>
      if (
        parsed &&
        typeof parsed.publicKeyPem === 'string' &&
        typeof parsed.privateKeyPem === 'string' &&
        keyPairMatches(parsed.publicKeyPem, parsed.privateKeyPem)
      ) {
        return {
          deviceId: fingerprint(parsed.publicKeyPem),
          publicKeyPem: parsed.publicKeyPem,
          privateKeyPem: parsed.privateKeyPem
        }
      }
    }
  } catch {
    /* 解析失败则重建 */
  }

  const identity = generateIdentity()
  const stored: StoredIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: Date.now()
  }
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(stored, null, 2), 'utf-8')
  } catch {
    /* 写入失败不影响本次连接(仅下次需重新生成) */
  }
  return identity
}

/** 用 PEM ed25519 私钥对 UTF-8 payload 签名,返回 base64url 字节。 */
export function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem)
  return base64Url(crypto.sign(null, Buffer.from(payload, 'utf8'), key))
}

/** 把 PEM 公钥导出为规范的原始 base64url 字节(连接时作为 device.publicKey)。 */
export function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return base64Url(rawPublicKey(publicKeyPem))
}

/** 规范化设备元数据:去空白 + 转小写(仅 A-Z),与官方 normalizeDeviceMetadataForAuth 一致。 */
export function normalizeDeviceMetadataForAuth(value?: string | null): string {
  if (typeof value !== 'string') {
    return ''
  }
  const trimmed = value.trim()
  return trimmed ? trimmed.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)) : ''
}

/** v3 设备鉴权 payload 参数。 */
export interface DeviceAuthPayloadV3Params {
  deviceId: string
  clientId: string
  clientMode: string
  role: string
  scopes: string[]
  signedAtMs: number
  token?: string | null
  nonce: string
  platform?: string | null
  deviceFamily?: string | null
}

/** 构造 v3 payload 字符串(与 OpenClaw buildDeviceAuthPayloadV3 逐字节一致)。 */
export function buildDeviceAuthPayloadV3(p: DeviceAuthPayloadV3Params): string {
  return [
    'v3',
    p.deviceId,
    p.clientId,
    p.clientMode,
    p.role,
    p.scopes.join(','),
    String(p.signedAtMs),
    p.token ?? '',
    p.nonce,
    normalizeDeviceMetadataForAuth(p.platform),
    normalizeDeviceMetadataForAuth(p.deviceFamily)
  ].join('|')
}
