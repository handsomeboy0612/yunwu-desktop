import { safeStorage } from 'electron'

/**
 * 落盘密文的统一出入口:Electron safeStorage(操作系统钥匙串)。
 *
 * 从 providers-store 抽出来的,供货商 API Key 与云雾会话 cookie 共用同一套编码,
 * 所以 `ENC_PREFIX` 必须保持不变 —— 改了它,已装用户磁盘上的密文就全解不开了。
 *
 * 钥匙串不可用(部分 Linux 桌面无 keyring)时降级明文,靠前缀区分两者。
 */
const ENC_PREFIX = 'enc:v1:'

/** 加密;safeStorage 不可用时降级为明文(仍可用)。 */
export function encryptSecret(plain: string): string {
  if (!plain) {
    return ''
  }
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
    }
  } catch {
    /* 加密失败降级明文 */
  }
  return plain
}

/**
 * 解密;非密文(降级明文)原样返回。
 *
 * 解密失败返回空串而不是抛错 —— 调用方据「空」走各自的兜底(供货商保留磁盘旧值、
 * 会话 cookie 当作已失效要求重登),这比让一次偶发的钥匙串读取失败冒到界面上更稳。
 */
export function decryptSecret(stored: string): string {
  if (!stored) {
    return ''
  }
  if (stored.startsWith(ENC_PREFIX)) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
    } catch {
      return ''
    }
  }
  return stored
}
