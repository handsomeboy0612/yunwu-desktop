import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import type {
  ConnectorManifest,
  MarketInstalledItem,
  MarketInstallOptions,
  MarketItem
} from '@shared/types'
import { runOpenClaw } from '../openclaw-cli'
import { marketDetail } from './market-client'

/**
 * 连接器(MCP)安装器。
 *
 * 连接器无 zip 制品,靠 manifest 提供 MCP 配置。安装 = 把 server 对象写入内核
 * `mcp.servers.<name>`(`openclaw mcp set`)并 `mcp reload` 生效;token 型鉴权在安装时
 * 把用户令牌注入 headers/env;oauth 型安装后尽力触发 `mcp login`。
 *
 * MCP 配置落在内核 openclaw.json(非我方目录,不带 meta),故用 userData 下的
 * market-connectors.json 单独登记「由市场安装」的连接器,用于安装态展示与卸载。
 */

/** 本地连接器登记项。 */
interface ConnectorRegistryItem {
  slug: string
  mcpName: string
  name: string
  version: string
  installedAt: number
}

function registryFile(): string {
  return join(app.getPath('userData'), 'market-connectors.json')
}

function loadRegistry(): ConnectorRegistryItem[] {
  const file = registryFile()
  if (!existsSync(file)) {
    return []
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    return Array.isArray(raw) ? (raw as ConnectorRegistryItem[]) : []
  } catch {
    return []
  }
}

function saveRegistry(list: ConnectorRegistryItem[]): void {
  writeFileSync(registryFile(), JSON.stringify(list, null, 2), 'utf-8')
}

/** 解析并校验连接器 manifest。 */
function parseManifest(raw: string | undefined): ConnectorManifest {
  if (!raw) {
    throw new Error('连接器缺少 manifest(MCP 配置)')
  }
  let m: ConnectorManifest
  try {
    m = JSON.parse(raw) as ConnectorManifest
  } catch {
    throw new Error('连接器 manifest 不是合法 JSON')
  }
  if (!m.mcpName || typeof m.mcpName !== 'string') {
    throw new Error('连接器 manifest 缺少 mcpName')
  }
  if (!m.server || typeof m.server !== 'object') {
    throw new Error('连接器 manifest 缺少 server 配置')
  }
  return m
}

/**
 * 把用户令牌注入 server 配置。
 * inject 缺省推断:含 url(http 传输)→ header;否则(stdio)→ env。
 */
function injectToken(server: Record<string, unknown>, manifest: ConnectorManifest, token: string): void {
  const auth = manifest.auth
  const key = auth?.key
  if (!key) {
    throw new Error('该连接器声明了 token 鉴权但未指定注入字段名(auth.key)')
  }
  const value = (auth?.prefix ?? '') + token
  const inject = auth?.inject ?? ('url' in server ? 'header' : 'env')
  if (inject === 'header') {
    const headers = { ...((server.headers as Record<string, string>) ?? {}) }
    headers[key] = value
    server.headers = headers
  } else {
    const env = { ...((server.env as Record<string, string>) ?? {}) }
    env[key] = value
    server.env = env
  }
}

/**
 * 安装连接器:拉详情取 manifest → 组装 server(必要时注入 token)→ `mcp set` →
 * (oauth 尽力 `mcp login`)→ `mcp reload` → 本地登记。
 */
export async function installConnector(item: MarketItem, opts?: MarketInstallOptions): Promise<void> {
  if (item.type !== 'connector') {
    throw new Error('该条目不是连接器类型')
  }
  // 列表接口省略了 manifest,安装前取详情拿完整 manifest。
  const detail = item.manifest ? item : await marketDetail('connector', item.slug)
  const manifest = parseManifest(detail.manifest)

  // 深拷贝,避免污染入参;token 型注入用户令牌。
  const server: Record<string, unknown> = JSON.parse(JSON.stringify(manifest.server))
  const mode = manifest.auth?.mode ?? 'none'
  if (mode === 'token') {
    if (!opts?.token) {
      throw new Error('该连接器需要令牌,请先填写')
    }
    injectToken(server, manifest, opts.token)
  }

  await runOpenClaw(['mcp', 'set', manifest.mcpName, JSON.stringify(server)])

  if (mode === 'oauth') {
    // 尽力触发 OAuth 授权(可能弹浏览器);失败不阻断安装(server 已保存,授权后即可用)。
    try {
      await runOpenClaw(['mcp', 'login', manifest.mcpName])
    } catch (err) {
      console.warn('[connector] mcp login 失败(可稍后在连接器内重试授权):', err)
    }
  }

  await runOpenClaw(['mcp', 'reload'])

  const next = loadRegistry().filter((r) => r.slug !== item.slug)
  next.push({
    slug: item.slug,
    mcpName: manifest.mcpName,
    name: item.name,
    version: detail.version || item.version || '',
    installedAt: Date.now()
  })
  saveRegistry(next)
}

/** 卸载连接器:`mcp unset` + reload,并移除本地登记。 */
export async function uninstallConnector(slug: string): Promise<void> {
  const reg = loadRegistry()
  const found = reg.find((r) => r.slug === slug)
  if (!found) {
    return
  }
  try {
    await runOpenClaw(['mcp', 'unset', found.mcpName])
    await runOpenClaw(['mcp', 'reload'])
  } catch (err) {
    // 内核侧移除失败也要清理本地登记,避免残留幽灵条目;抛出让上层提示。
    saveRegistry(reg.filter((r) => r.slug !== slug))
    throw err
  }
  saveRegistry(reg.filter((r) => r.slug !== slug))
}

/** 列出本地已安装连接器。 */
export function listInstalledConnectors(): MarketInstalledItem[] {
  return loadRegistry().map((r) => ({
    type: 'connector' as const,
    slug: r.slug,
    name: r.name,
    version: r.version,
    installedAt: r.installedAt
  }))
}
