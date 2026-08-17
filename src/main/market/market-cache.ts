import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { MarketAssetType } from '@shared/types'

/**
 * 本地 Agent 市场 GET 响应的持久缓存(userData/market-list-cache.json)。
 *
 * 目标:
 *  - 版本/ETag 协商:携带上次响应的 ETag 发 If-None-Match;服务端 304 时复用缓存,省流量;
 *  - 离线兜底:网络不可达或服务端异常时,降级返回最近一次成功的缓存(标记 stale),
 *    让市场页在断网时仍可浏览已缓存内容,而非白屏报错。
 *
 * 隔离:缓存键含账号指纹(令牌尾段)与 baseUrl,避免多账号/多环境串数据。
 */

/** 单条缓存:etag(可选,服务端未下发时为空)、数据体、写入时间戳。 */
export interface CacheEntry<T> {
  etag?: string
  data: T
  ts: number
}

type CacheMap = Record<string, CacheEntry<unknown>>

/** 缓存文件路径(用户数据目录)。 */
function cacheFile(): string {
  return join(app.getPath('userData'), 'market-list-cache.json')
}

/** 读取整份缓存映射;不存在或损坏按空处理(缓存不可信不应阻塞主流程)。 */
function loadCacheMap(): CacheMap {
  const file = cacheFile()
  if (!existsSync(file)) {
    return {}
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    return parsed && typeof parsed === 'object' ? (parsed as CacheMap) : {}
  } catch {
    return {}
  }
}

/** 覆盖写整份缓存映射(写失败静默:缓存尽力而为,不影响功能)。 */
function saveCacheMap(map: CacheMap): void {
  try {
    writeFileSync(cacheFile(), JSON.stringify(map), 'utf-8')
  } catch {
    /* 缓存写入失败容忍 */
  }
}

/**
 * 构造缓存键:账号指纹 + baseUrl + 资产类型。
 * 指纹用令牌尾 8 位(足够区分账号,又不落盘完整令牌)。
 */
export function buildSnapshotCacheKey(
  type: MarketAssetType,
  token: string,
  baseUrl: string
): string {
  return ['snapshot', token.slice(-8), baseUrl, type].join('|')
}

/**
 * 桌面端产品配置(`/api/desktop-config`)的缓存键。
 *
 * 与市场快照同一套键规则(账号指纹 + baseUrl):模型参数覆盖是**按令牌**取的,
 * 换账号/换环境不能串用 —— 两个账号能看到的模型本来就不同。
 */
export function buildDesktopConfigCacheKey(token: string, baseUrl: string): string {
  return ['desktop-config', token.slice(-8), baseUrl].join('|')
}

/** 取某键的缓存条目(无则 undefined)。 */
export function getCachedList<T>(key: string): CacheEntry<T> | undefined {
  return loadCacheMap()[key] as CacheEntry<T> | undefined
}

/** 写入某键的缓存条目(读改写单文件)。 */
export function setCachedList<T>(key: string, entry: CacheEntry<T>): void {
  const map = loadCacheMap()
  map[key] = entry
  saveCacheMap(map)
}
