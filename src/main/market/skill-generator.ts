import type { AiSkillDraft, MarketItem } from '@shared/types'
import { marketItemDesc } from '@shared/types'
import { loadActivation } from '../store'
import { fetchMarketSnapshot } from './market-client'
import { installLocalSkill } from './installer'

/**
 * AI 辅助技能(对齐 WorkBuddy「描述需求 → 自动查找/创建技能」)。
 *
 * 复用桌面端已有云雾 OpenAI 兼容通道:以激活配置的 baseUrl + sk- 令牌 + 默认模型,
 * 发一次性 `POST /v1/chat/completions`(不走 agent 会话、不经对象存储)。
 *  - findSkills:把需求 + 市场技能清单喂给模型,返回按匹配度排序的技能 slug;
 *  - generateSkill:让模型产出合法 SKILL.md 草稿供预览;
 *  - installGeneratedSkill:把草稿本地直装到 ~/.openclaw/skills/<slug>/。
 */

/** 一次性对话补全:返回助手回复正文。失败抛可读错误。 */
async function chatCompletion(system: string, user: string, maxTokens = 2048): Promise<string> {
  const act = loadActivation()
  if (!act?.token || !act?.baseUrl) {
    throw new Error('未登录云雾账号,无法调用模型')
  }
  if (!act.defaultModel) {
    throw new Error('未配置默认模型,无法调用模型')
  }
  const base = act.baseUrl.replace(/\/+$/, '')
  let resp: Response
  try {
    resp = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${act.token}`
      },
      body: JSON.stringify({
        model: act.defaultModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        temperature: 0.3,
        max_tokens: maxTokens,
        stream: false
      })
    })
  } catch (err) {
    throw new Error(`无法连接模型服务: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`模型服务返回 HTTP ${resp.status}: ${body.slice(0, 200)}`)
  }
  const json = (await resp.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = json.choices?.[0]?.message?.content?.trim()
  if (!content) {
    throw new Error('模型未返回有效内容')
  }
  return content
}

/** 从模型回复里抽取 JSON(容忍 ```json 代码围栏与前后噪声)。 */
function extractJson<T>(raw: string): T {
  let s = raw.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) {
    s = fence[1].trim()
  }
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start >= 0 && end > start) {
    s = s.slice(start, end + 1)
  }
  return JSON.parse(s) as T
}

/** slug 归一:小写、非字母数字折叠为连字符。 */
function toSlug(raw: string): string {
  const s = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s.slice(0, 60) || 'skill'
}

/**
 * 按自然语言需求,从市场已上架技能里挑出最匹配的若干条,返回其 slug(按相关度排序)。
 * 市场为空或模型无匹配时返回空数组(上层回退为普通关键词搜索/提示创建)。
 */
export async function findSkills(need: string): Promise<string[]> {
  const query = need.trim()
  if (!query) {
    return []
  }
  let items: MarketItem[] = []
  try {
    // 用全量快照而非分页:技能条数会随捆绑技能导入涨到数百,分页取第一页会让靠后的技能
    // 永远进不了候选清单——检索"找不到"和"没有这个技能"在用户看来是一回事,很难发现。
    const snap = await fetchMarketSnapshot('skill')
    items = snap.items ?? []
  } catch {
    return []
  }
  if (items.length === 0) {
    return []
  }
  const catalog = items
    .map((it) => {
      const desc = marketItemDesc(it)
      return `- ${it.slug}: ${it.name}${desc ? ` —— ${desc}` : ''}`
    })
    .join('\n')
  const system =
    '你是技能市场检索助手。用户会用自然语言描述想要 AI 具备的能力,你需要从给定技能清单中挑出最相关的条目。' +
    '只能从清单里选择,不要臆造 slug。按相关度从高到低排序,最多返回 6 条。' +
    '严格只输出 JSON:{"slugs": ["slug1", "slug2"]},无匹配则 {"slugs": []}。'
  const user = `需求:${query}\n\n可选技能清单:\n${catalog}`
  let out: { slugs?: unknown }
  try {
    out = extractJson<{ slugs?: unknown }>(await chatCompletion(system, user, 512))
  } catch {
    return []
  }
  const valid = new Set(items.map((it) => it.slug))
  const slugs = Array.isArray(out.slugs) ? out.slugs : []
  return slugs
    .filter((s): s is string => typeof s === 'string' && valid.has(s))
    .slice(0, 6)
}

/**
 * 按自然语言需求生成一份技能草稿(合法 SKILL.md + slug/名称/简介),供预览确认后本地安装。
 * 不落盘;安装由 installGeneratedSkill 完成。
 */
export async function generateSkill(need: string): Promise<AiSkillDraft> {
  const query = need.trim()
  if (!query) {
    throw new Error('请先描述你想要的能力')
  }
  const system =
    '你是 Agent 技能作者,精通 OpenClaw / Claude Agent Skills 规范。根据用户需求,产出一个可直接使用的技能包定义。' +
    'SKILL.md 必须包含 YAML frontmatter(name、description 两个字段),正文用中文,含:能力说明、使用步骤、注意事项、示例。' +
    '步骤要具体可执行、贴近真实工作流,不要空话。' +
    '严格只输出 JSON,形如:' +
    '{"slug":"kebab-case-英文短横线","name":"中文技能名","description":"一句话简介","skillMd":"---\\nname: ...\\ndescription: ...\\n---\\n正文..."}。' +
    'skillMd 内的换行用 \\n 转义,确保是合法 JSON 字符串。'
  const user = `需求:${query}`
  const draft = extractJson<Partial<AiSkillDraft>>(await chatCompletion(system, user, 3000))
  if (!draft.skillMd || typeof draft.skillMd !== 'string') {
    throw new Error('模型未生成有效的 SKILL.md')
  }
  const name = (draft.name || query.slice(0, 20)).trim()
  const slug = toSlug(draft.slug || name || query)
  return {
    slug,
    name,
    description: (draft.description || '').trim(),
    skillMd: draft.skillMd.trim()
  }
}

/** 把已确认(可能被用户编辑过)的技能草稿本地直装。 */
export function installGeneratedSkill(draft: AiSkillDraft): void {
  if (!draft?.skillMd?.trim()) {
    throw new Error('技能内容为空,无法安装')
  }
  installLocalSkill(toSlug(draft.slug || draft.name || 'skill'), draft.name || draft.slug, draft.skillMd)
}
