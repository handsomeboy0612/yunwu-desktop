/**
 * 离线复验「联网」能力标记与搜索后端选取。
 *
 * 直接 import 真实实现（`model-capabilities.ts` 只有 type-only import，Node 24 的类型剥离
 * 能原样跑），不复制判据 —— 测副本等于没测。
 *
 * 数据用真机 `/v1/models` 的快照；没有快照时只跑纯逻辑用例。
 * 用法：node scripts/verify-search-capability.mjs [models.json]
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { deriveModelInfos, inferModelInfoFromId } from '../src/main/model-capabilities.ts'

let pass = 0
let fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) {
    pass++
  } else {
    fail++
    console.log(`  FAIL ${name}\n       期望 ${JSON.stringify(want)}\n       实得 ${JSON.stringify(got)}`)
  }
}

const searchOf = (entry) => deriveModelInfos([entry])[0]?.search
const catOf = (entry) => deriveModelInfos([entry])[0]?.category

console.log('== 判据用例 ==')

// 平台打了「联网」tag 的那一族（真机广场里 6 条，全是 OpenAI 原生搜索模型）
check('gpt-4o-mini-search-preview 带联网 tag', searchOf({ id: 'gpt-4o-mini-search-preview', model_type: '对话', tags: '对话,联网' }), true)
check('gpt-5-search-api 带联网 tag', searchOf({ id: 'gpt-5-search-api', model_type: '对话', tags: '对话,联网' }), true)
// 没打 tag 也要认出来：名字兜底
check('gpt-4o-search-preview 无 tag 靠名字', searchOf({ id: 'gpt-4o-search-preview', model_type: '对话' }), true)

// Gemini 族：tags 齐全但没有「联网」，只能靠名字判 —— 这正是本次改动的核心
check('gemini-2.5-flash（tags 无联网）', searchOf({ id: 'gemini-2.5-flash', model_type: '对话', tags: '对话,识图,工具' }), true)
check('gemini-3-pro-preview', searchOf({ id: 'gemini-3-pro-preview', model_type: '对话', tags: '对话,思考,识图' }), true)
check('gemini-3.1-flash-lite', searchOf({ id: 'gemini-3.1-flash-lite', model_type: '对话', tags: '对话' }), true)

// 平台用的是**两个**词：「联网」标在名字带 search/deepsearch 的变体条目上，
// 「搜索」只标在 OpenAI 的 deep research 那 4 条上（2026-08-14 查库：没有「检索」这个 tag）。
// 判据必须两个都认，少一个就漏掉 deep research 那一族。
check('o3-deep-research 带搜索 tag', searchOf({ id: 'o3-deep-research', model_type: '对话', tags: '对话,思考,搜索' }), true)
check('o4-mini-deep-research 带搜索 tag', searchOf({ id: 'o4-mini-deep-research', model_type: '对话', tags: '对话,思考,搜索' }), true)

// 不该命中的
check('claude-opus-4-6 不联网', searchOf({ id: 'claude-opus-4-6', model_type: '对话', tags: '对话,思考,识图,工具' }), false)
check('deepseek-v4-flash 不联网', searchOf({ id: 'deepseek-v4-flash', model_type: '对话', tags: '对话,工具' }), false)
// 出图的 gemini 不是对话模型，不能因为前缀就被当成搜索后端
check('gemini 出图模型不算联网', searchOf({ id: 'gemini-2.5-flash-image', model_type: '图像', tags: '绘画' }), false)
check('gemini 出图模型类别为 image', catOf({ id: 'gemini-2.5-flash-image', model_type: '图像', tags: '绘画' }), 'image')

// `-search` 是平台的能力后缀、会被 FormatMatchingModelName 剥掉，所以广场与 /v1/models 里
// 都不存在这个名字。这里锁住「即使它冒出来也不当搜索后端」：我们只用广场上架的模型。
check('deepseek-v3-search 不当搜索后端', searchOf({ id: 'deepseek-v3-search', model_type: '对话', tags: '对话' }), false)

// `model_type = '检索'` 是广场左侧那一档的原话，装的是 embedding + rerank。
// 这一档必须在最权威的位置拦下：漏掉它时，tags 只写「重排序」、名字里又没有 bge 的那几条
// 会一路掉到末行判成 chat，混进对话模型选择器（2026-08-14 真机复现过 3 条）。
check('检索类·文本嵌入', catOf({ id: 'text-embedding-3-small', model_type: '检索', tags: '文本嵌入' }), 'embedding')
check('检索类·重排序（名字无 bge）', catOf({ id: 'qwen3-rerank', model_type: '检索', tags: '重排序' }), 'embedding')
check('检索类·重排序（带斜杠命名）', catOf({ id: 'Qwen/Qwen3-Reranker-0.6B', model_type: '检索', tags: '重排序' }), 'embedding')
check('检索类·bce-reranker', catOf({ id: 'netease-youdao/bce-reranker-base_v1', model_type: '检索', tags: '重排序' }), 'embedding')
// model_type 缺失时靠 tags 兜底
check('重排序 tag 兜底（无 model_type）', catOf({ id: 'some-reranker-x', tags: '重排序' }), 'embedding')
// 名字带 search 的向量模型不能被判成能联网
check('text-search-ada-doc-001 不是搜索后端', searchOf({ id: 'text-search-ada-doc-001', model_type: '检索', tags: '文本嵌入' }), false)
// gemini 前缀的向量模型同理：search 判据必须先过 category 这一关
check('gemini-embedding-001 不是搜索后端', searchOf({ id: 'gemini-embedding-001', model_type: '检索', tags: '文本嵌入' }), false)

// 老配置迁移路径
check('inferModelInfoFromId(gemini-2.5-flash)', inferModelInfoFromId('gemini-2.5-flash').search, true)
check('inferModelInfoFromId(claude-opus-4-6)', inferModelInfoFromId('claude-opus-4-6').search, false)
check('inferModelInfoFromId(tts-1) 非对话', inferModelInfoFromId('tts-1').search, false)

// 插件那侧的两个纯函数：与 index.mjs 里的实现保持同一判据（那份是运行时权威）
const isGeminiGrounding = (model) => String(model ?? '').toLowerCase().startsWith('gemini-')
check('gemini 走 grounding', isGeminiGrounding('gemini-2.5-flash'), true)
check('OpenAI 搜索模型不传 googleSearch', isGeminiGrounding('gpt-4o-mini-search-preview'), false)

console.log('\n== 真机快照核对 ==')
const snapshot = process.argv[2] ?? fileURLToPath(new URL('../../.tmp-probe/v1models.json', import.meta.url))
if (existsSync(snapshot)) {
  const raw = JSON.parse(readFileSync(snapshot, 'utf-8'))
  const rows = Array.isArray(raw) ? raw : (raw.data ?? [])
  const infos = deriveModelInfos(rows)
  const chat = infos.filter((m) => m.category === 'chat')
  const searchable = chat.filter((m) => m.search)
  console.log(`  总 ${infos.length} 条，对话 ${chat.length} 条，判为能联网 ${searchable.length} 条`)
  console.log('  命中清单：')
  console.log(searchable.map((m) => `    ${m.id}`).join('\n'))
  const nonChatSearch = infos.filter((m) => m.search && m.category !== 'chat')
  check('非对话模型不得带 search 标记', nonChatSearch.map((m) => m.id), [])
} else {
  console.log(`  跳过（没有快照 ${snapshot}）`)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
