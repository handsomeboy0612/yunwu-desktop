import type { ValidateResult } from '@shared/types'
import { deriveModelInfos, type RawModelEntry } from './model-capabilities'

/**
 * 校验云雾 baseUrl + token 是否可用,并返回该令牌可访问的模型列表。
 *
 * 复用云雾的 OpenAI 兼容端点 `GET /v1/models`(new-api 原生支持),因此
 * MVP 阶段无需在云雾后端新增任何接口,桌面客户端即可独立完成激活校验。
 *
 * 失败时抛出可读错误:网络错误、401(令牌无效)、以及其它非 2xx 状态分别提示。
 */
export async function validateToken(baseUrl: string, token: string): Promise<ValidateResult> {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (!trimmed) {
    throw new Error('云雾地址不能为空')
  }
  if (!token.trim()) {
    throw new Error('令牌不能为空')
  }

  const url = `${trimmed}/v1/models`
  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    })
  } catch (err) {
    throw new Error(`无法连接云雾(${trimmed}): ${err instanceof Error ? err.message : String(err)}`)
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`令牌无效或权限不足(HTTP ${resp.status})`)
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`云雾返回 HTTP ${resp.status}: ${body.slice(0, 200)}`)
  }

  // 保留完整条目(id/model_type/tags/supported_endpoint_types),据此推导每个模型的能力标记
  // (思考/识图/工具/类别),而非仅取 id —— 这是"零安装自动开启思考"的数据源。
  const json = (await resp.json()) as { data?: RawModelEntry[] }
  const models = deriveModelInfos(json.data ?? [])

  if (models.length === 0) {
    throw new Error('该令牌下没有可用模型,请检查云雾令牌配置')
  }
  return { models }
}
