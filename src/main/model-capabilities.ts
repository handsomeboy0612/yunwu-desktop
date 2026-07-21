import type { ModelCategory, ModelInfo } from '@shared/types'

/**
 * 从云雾 `/v1/models` 返回的单个模型条目推导能力标记。
 *
 * 设计:能力来源以后端返回的 `tags` / `model_type` 为准(零 App 维护 —— 云雾在 admin
 * 打好 tag 后,客户端不升级也能自动正确)。当后端未打 tag 时,再回退到模型名启发式,
 * 保证老数据/漏标模型也有合理默认。已通过真机抓包验证 tag 语义:
 *  - 「思考」→ 推理模型(流式吐 reasoning_content);
 *  - 「识图/视觉/多模态」→ 图片输入;
 *  - 「工具」→ 工具调用;
 *  - model_type「文本」=chat,「图像/绘画」=image,「视频」=video,「音频/语音」=audio。
 */

/** 云雾 /v1/models data[] 的原始条目(仅取我们关心的字段)。 */
export interface RawModelEntry {
  id?: string
  model_type?: string
  tags?: string
  supported_endpoint_types?: string[]
}

/** 判断字符串是否包含任一关键字。 */
function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n))
}

/** 依据模型名做推理能力启发式(后端无「思考」tag 时的兜底)。 */
function reasoningByName(id: string): boolean {
  const s = id.toLowerCase()
  return (
    /(^|[^a-z])(o1|o3|o4)([^a-z]|$)/.test(s) ||
    /\br1\b/.test(s) ||
    s.includes('thinking') ||
    s.includes('reason') ||
    s.includes('-think') ||
    s.includes('deepseek-r')
  )
}

/** 依据模型名做视觉能力启发式(后端无「识图」tag 时的兜底)。 */
function visionByName(id: string): boolean {
  const s = id.toLowerCase()
  return s.includes('-vl') || s.includes('vision') || s.includes('-vl-') || /\bvl\b/.test(s)
}

/** 从 model_type + endpoints 推导类别。 */
function deriveCategory(modelType: string, endpoints: string[]): ModelCategory {
  const mt = modelType || ''
  const eps = endpoints.join(',')
  if (includesAny(mt, ['图像', '绘画', 'image']) || includesAny(eps, ['image-generation', '生图', '绘画', '图生', '扩图'])) {
    return 'image'
  }
  if (includesAny(mt, ['视频', 'video']) || includesAny(eps, ['video', '视频'])) {
    return 'video'
  }
  if (includesAny(mt, ['音频', '语音', 'audio', 'tts', 'stt', '音乐']) || includesAny(eps, ['tts', 'stt', 'audio', 'speech', '语音'])) {
    return 'audio'
  }
  if (includesAny(mt, ['向量', 'embed']) || includesAny(eps, ['embedding'])) {
    return 'embedding'
  }
  // 文本 / 对话 / 未知 → 默认按对话模型处理。
  return 'chat'
}

/** 把一条原始模型条目推导为带能力的 ModelInfo。 */
export function deriveModelInfo(entry: RawModelEntry): ModelInfo | null {
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  if (!id) {
    return null
  }
  const tags = entry.tags ?? ''
  const modelType = entry.model_type ?? ''
  const endpoints = Array.isArray(entry.supported_endpoint_types) ? entry.supported_endpoint_types : []
  const category = deriveCategory(modelType, endpoints)

  const reasoning =
    category === 'chat' && (includesAny(tags, ['思考', '推理']) || (tags === '' && reasoningByName(id)))
  const vision =
    category === 'chat' &&
    (includesAny(tags, ['识图', '视觉', '多模态', '图像分析']) || (tags === '' && visionByName(id)))
  const tools = category === 'chat' && (includesAny(tags, ['工具', '函数']) || tags === '')

  return { id, reasoning, vision, tools, category }
}

/** 批量推导,过滤无效条目。 */
export function deriveModelInfos(entries: RawModelEntry[]): ModelInfo[] {
  const out: ModelInfo[] = []
  for (const e of entries) {
    const info = deriveModelInfo(e)
    if (info) {
      out.push(info)
    }
  }
  return out
}

/** 从模型 id 兜底推导能力(用于老配置迁移:仅有 id 字符串时)。 */
export function inferModelInfoFromId(id: string): ModelInfo {
  return {
    id,
    reasoning: reasoningByName(id),
    vision: visionByName(id),
    tools: true,
    category: 'chat'
  }
}
