/**
 * 离线复验出图候选池的判据。
 *
 * 直接 import 真实实现（`src/shared/media-endpoints.ts` 没有任何运行时 import，
 * Node 24 的类型剥离能原样跑），不复制判据 —— 测副本等于没测。
 *
 * 覆盖三件 2026-08-17 的改动：
 *  1. `image-edit` 补进编辑端点类型（grok 那两条明明能改图却没被标可编辑）；
 *  2. `isChatImageModel`：只在对话端点上出图的 Gemini 图像族也要进池子；
 *  3. `IMAGE_ASYNC_ENDPOINT_TYPES`：MJ / 可灵那档厂商异步出图也要进池子，
 *     且**界面认出来的每一条，插件里必须真有适配器**（不然选得到、跑不动）。
 *
 * 数据用真机 `/v1/models` 快照；没有快照时只跑纯逻辑用例。
 * 用法：node scripts/verify-image-endpoints.mjs [models.json]
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  IMAGE_ASYNC_ENDPOINT_TYPES,
  IMAGE_EDIT_ENDPOINT_TYPES,
  IMAGE_ENDPOINT_TYPES,
  isChatImageModel,
  isEditOnlyImageModel
} from '../src/shared/media-endpoints.ts'

/** 插件里真有适配器的那四条（`resources/yunwu-video-plugin/index.mjs:IMAGE_ASYNC_ADAPTERS`）。 */
const ASYNC_ADAPTER_IDS = ['mj_imagine', 'mj_blend', 'kling-image', 'kling-omni-image']

let pass = 0
let fail = 0
function check(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++
  } else {
    fail++
    console.log(`  FAIL ${name}\n       期望 ${JSON.stringify(want)}\n       实得 ${JSON.stringify(got)}`)
  }
}

console.log('== 聊天式出图判据 ==')

// Gemini 图像族：云雾只给它们开了对话端点，图以 markdown data URI 回在正文里
const gem = (id, tags = '绘画') => isChatImageModel('图像', tags, ['gemini', 'openai'])
check('gemini-2.5-flash-image', gem('gemini-2.5-flash-image'), true)
check('gemini-3-pro-image', gem('gemini-3-pro-image'), true)
check('gemini-3.1-flash-lite-image（tags 写的是绘图）', gem('gemini-3.1-flash-lite-image', '绘图'), true)

// 不该命中的（每一条都对应一个真实的误伤风险）
check('对话模型不能因为端点是 openai 就被当出图', isChatImageModel('对话', '对话,识图', ['openai']), false)
check('对话模型（无 tags）同理', isChatImageModel('对话', undefined, ['openai', 'gemini']), false)
check('两条路都通时走专用出图端点', isChatImageModel('图像', '绘画', ['openai', 'image-generation']), false)
check('图像档但是识图（kling-image-recognize）', isChatImageModel('图像', '异步,识图', ['Image recognition']), false)
check('图像档 + 对话端点但 tags 不带绘画/绘图', isChatImageModel('图像', '异步', ['openai']), false)
check('厂商专属出图路径不算（kling-image）', isChatImageModel('图像', '绘画,异步', ['Kling image generation']), false)
check('MJ 不算（mj_imagine）', isChatImageModel('图像', '绘画,异步', ['MJ imagine']), false)
check('model_type 缺失时不猜', isChatImageModel(undefined, '绘画', ['openai']), false)
check('英文旧值 image 也认（gpt-image-2-c 那档）', isChatImageModel('image', '绘图', ['openai']), true)
check('端点类型为空数组', isChatImageModel('图像', '绘画', []), false)

console.log('== 厂商异步出图判据 ==')
// 异步那档靠专属端点类型名认，与对话那档互斥（上面 47-48 行已从反面钉过）
check('MJ 两条在异步清单里', [
  IMAGE_ASYNC_ENDPOINT_TYPES.includes('MJ imagine'),
  IMAGE_ASYNC_ENDPOINT_TYPES.includes('MJ blend')
], [true, true])
check('可灵出图在异步清单里', IMAGE_ASYNC_ENDPOINT_TYPES.includes('Kling image generation'), true)
// 异步那些名字不能混进直连出图清单：它们的路径不在 /v1 下，走的是提交+轮询
check(
  '异步端点类型没混进直连出图清单',
  IMAGE_ASYNC_ENDPOINT_TYPES.filter((t) => IMAGE_ENDPOINT_TYPES.includes(t)),
  []
)
check('只有 mj_blend 是 editOnly', [
  isEditOnlyImageModel('mj_blend'),
  isEditOnlyImageModel('mj_imagine'),
  isEditOnlyImageModel('kling-image')
], [true, false, false])

console.log('== 编辑端点类型 ==')
check('image-edit 在编辑清单里', IMAGE_EDIT_ENDPOINT_TYPES.includes('image-edit'), true)
check('原有三个名字没丢', [
  IMAGE_EDIT_ENDPOINT_TYPES.includes('OpenAI image edit'),
  IMAGE_EDIT_ENDPOINT_TYPES.includes('images-edits'),
  IMAGE_EDIT_ENDPOINT_TYPES.includes('openai-编辑')
], [true, true, true])
// `image-edit` 不能混进出图清单：它是 /v1/images/edits，不出图
check('image-edit 不在出图清单里', IMAGE_ENDPOINT_TYPES.includes('image-edit'), false)

console.log('\n== 真机快照核对 ==')
const snapshot = process.argv[2] ?? fileURLToPath(new URL('../../.tmp-probe/v1models.json', import.meta.url))
if (existsSync(snapshot)) {
  const raw = JSON.parse(readFileSync(snapshot, 'utf-8'))
  const rows = Array.isArray(raw) ? raw : (raw.data ?? [])
  // 这四行与 `main/model-catalog.ts:fetchAvailableMediaModels` 的出图那档同形（判据函数本身
  // 是 import 进来的真代码，这里只是把它套在快照上）。
  const types = (r) => (Array.isArray(r.supported_endpoint_types) ? r.supported_endpoint_types : [])
  const direct = rows.filter((r) => types(r).some((t) => IMAGE_ENDPOINT_TYPES.includes(t)))
  const chat = rows.filter((r) => isChatImageModel(r.model_type, r.tags, types(r)))
  const vendorAsync = rows.filter(
    (r) =>
      !direct.some((d) => d.id === r.id) &&
      types(r).some((t) => IMAGE_ASYNC_ENDPOINT_TYPES.includes(t))
  )
  const editable = [
    ...direct.filter((r) => types(r).some((t) => IMAGE_EDIT_ENDPOINT_TYPES.includes(t))),
    ...chat,
    ...vendorAsync
  ]
  console.log(
    `  快照 ${rows.length} 条：专用出图端点 ${direct.length} 条 + 对话端点 ${chat.length} 条` +
      ` + 厂商异步 ${vendorAsync.length} 条 = 池子 ${direct.length + chat.length + vendorAsync.length} 条`
  )
  console.log(`  其中可编辑 ${editable.length} 条`)
  console.log('  对话端点那档：')
  console.log(chat.map((r) => `    ${r.id}  [${types(r).join(' | ')}]`).join('\n'))
  console.log('  厂商异步那档：')
  console.log(
    vendorAsync
      .map((r) => `    ${r.id}${isEditOnlyImageModel(r.id) ? '（只改图）' : ''}  [${types(r).join(' | ')}]`)
      .join('\n')
  )
  check('三档互不重叠', [
    direct.filter((d) => chat.some((c) => c.id === d.id)).map((r) => r.id),
    direct.filter((d) => vendorAsync.some((a) => a.id === d.id)).map((r) => r.id),
    chat.filter((c) => vendorAsync.some((a) => a.id === c.id)).map((r) => r.id)
  ], [[], [], []])
  check('对话端点那档全部是图像档', chat.filter((r) => !['图像', 'image'].includes(r.model_type)).map((r) => r.id), [])
  // 这条最要紧：界面凭端点类型认，插件凭适配器跑。多认出一条就是「选得到、跑不动」。
  check(
    '异步那档每一条插件里都有适配器',
    vendorAsync.map((r) => r.id).filter((id) => !ASYNC_ADAPTER_IDS.includes(id)),
    []
  )
  check(
    '四个适配器在快照里都能被认出来',
    ASYNC_ADAPTER_IDS.filter((id) => rows.some((r) => r.id === id) && !vendorAsync.some((r) => r.id === id)),
    []
  )
  // grok 那两条是这次补 `image-edit` 才被认出来的，锁住它们
  for (const id of ['grok-imagine-image-2.0', 'grok-imagine-image-quality']) {
    if (rows.some((r) => r.id === id)) {
      check(`${id} 判为可编辑`, editable.some((r) => r.id === id), true)
    }
  }
} else {
  console.log(`  跳过（没有快照 ${snapshot}）`)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail === 0 ? 0 : 1
