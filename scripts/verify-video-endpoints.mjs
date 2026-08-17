/**
 * 离线复验视频候选池的判据。
 *
 * 出图那侧有 `verify-image-endpoints.mjs`，视频这侧一直靠人盯，于是「插件加了一家、
 * 选择器忘了加」这种静态隐患只能等用户撞见。这个脚本把那条纪律变成检查：
 *
 *  1. **两份判据必须逐字一致** —— 插件里各适配器 `endpointTypes` 的并集，
 *     必须等于 `shared/media-endpoints.ts` 的 `VIDEO_ENDPOINT_TYPES`。
 *     漏加界面 = 接了但选不到；漏删界面 = 选得到但跑不动。
 *  2. 新认领的端点类型确实把对应模型收进池子，且 `supportsTextToVideo` 的收窄没误伤。
 *  3. 拿真机 `/v1/models` 快照跑一遍，打印今天实际的池子（回归基线）。
 *
 * 用法：node scripts/verify-video-endpoints.mjs [models.json]
 * 不给参数就用 `scripts/fixtures/models-sanitized.json`。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  VIDEO_ENDPOINT_TYPES,
  isClaimedVideoModel,
  supportsImageToVideo,
  supportsTextToVideo
} from '../src/shared/media-endpoints.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginPath = `${here}../resources/yunwu-video-plugin/index.mjs`
const source = readFileSync(pluginPath, 'utf8')

let pass = 0
let fail = 0
function check(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++
  } else {
    fail++
    console.log(
      `  FAIL ${name}\n       期望 ${JSON.stringify(want)}\n       实得 ${JSON.stringify(got)}`
    )
  }
}

/**
 * 取 `new Set([...])` 里的端点类型名。
 *
 * 逐项解析而不是「把引号里的东西全抓出来」：清单里的项**可以是常量引用**
 * （类型名同时要给选路逻辑用，摊成字面量就会出现两份字符串），
 * 那种项要回源码里查它的定义。解不开就报错——静默漏掉一条正是这个脚本要防的事。
 */
function setLiteralStrings(body) {
  return body
    .replace(/\/\/[^\n]*/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const quoted = /^['"]([^'"]+)['"]$/.exec(item)
      if (quoted) {
        return quoted[1]
      }
      const def = new RegExp(`const ${item} = ['"]([^'"]+)['"]`).exec(source)
      if (!def) {
        throw new Error(`端点类型清单里有解不开的项：${item}`)
      }
      return def[1]
    })
}

/**
 * 从插件源码里读出**视频适配器**认领的端点类型。
 *
 * 只认 `ADAPTERS` 数组里列的那几个适配器 —— 出图那侧的 `IMAGE_ASYNC_ADAPTERS` 也用
 * 同名字段，按字段名瞎抓会把 MJ / 可灵出图混进来。
 */
function claimedTypesFromPlugin() {
  const arrayMatch = /const ADAPTERS = \[([\s\S]*?)\]/.exec(source)
  if (!arrayMatch) {
    throw new Error('插件里找不到 ADAPTERS 数组')
  }
  const adapterNames = arrayMatch[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const types = []
  for (const name of adapterNames) {
    const block = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\}`).exec(source)
    if (!block) {
      throw new Error(`插件里找不到适配器 ${name}`)
    }
    const field = /endpointTypes:\s*([^\n]+)/.exec(block[1])
    if (!field) {
      throw new Error(`适配器 ${name} 没有声明 endpointTypes`)
    }
    const expr = field[1].trim()
    if (expr.startsWith('new Set(')) {
      // 没有 `[...]` 就是空集合（Replicate / fal-ai 的类型名逐模型，靠 `matchesType` 认，
      // 静态清单本来就该是空的）。
      types.push(...setLiteralStrings(/\[([\s\S]*)\]/.exec(expr)?.[1] ?? ''))
      continue
    }
    // 常量引用：回源码里找它的定义（可能跨多行）。
    const constName = expr.replace(/,$/, '')
    const def = new RegExp(`const ${constName} = new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(source)
    if (!def) {
      throw new Error(`找不到端点类型常量 ${constName}`)
    }
    types.push(...setLiteralStrings(def[1]))
  }
  return types
}

console.log('== 判据两处必须一致 ==')
const pluginTypes = claimedTypesFromPlugin()
check(
  '插件并集 == 选择器 VIDEO_ENDPOINT_TYPES（排序后逐条比）',
  [...pluginTypes].sort(),
  [...VIDEO_ENDPOINT_TYPES].sort()
)
check('插件里没有重复声明同一个端点类型', pluginTypes.length, new Set(pluginTypes).size)

console.log('== 2026-08-17 新认领的两类 ==')
const claims = (types) => types.some((t) => VIDEO_ENDPOINT_TYPES.includes(t))
check('veo3.1（Unified video format）进池', claims(['Unified video format']), true)
check('grok-video-3（Grok video）进池', claims(['Grok video']), true)
check('sora-2-pro（Unified + 官方视频两类）进池', claims(['Unified video format', 'OpenAI official video format']), true)
check('sora-2（只有官方视频那类）也进池了', claims(['openai', 'OpenAI official video format']), true)

console.log('== 2026-08-17 傍晚接的三家新厂商 + 两家逐模型类型 ==')
check('runway 进池', claims(['Runway image to video']), true)
check('luma 进池', claims(['Luma video generation']), true)
check('grok 的 OpenAI 兼容那条进池', claims(['Grok video (OpenAI format)']), true)
// Replicate / fal 的类型名是「模型 id + ' (Async)'」，静态清单里没有，靠构造规则认。
check(
  'replicate：minimax/video-01 (Async) 认得出',
  isClaimedVideoModel('minimax/video-01', ['minimax/video-01 (Async)']),
  true
)
check(
  'fal：fal-ai/veo3/fast (Async) 认得出',
  isClaimedVideoModel('fal-ai/veo3/fast', ['fal-ai/veo3/fast (Async)']),
  true
)
check(
  '别家的模型不会被这条规则误收（类型名与 id 对不上就不算）',
  isClaimedVideoModel('minimax/video-01', ['prunaai/vace-14b (Async)']),
  false
)
check('runway 只能图生', [supportsTextToVideo('runwayml-gen4_turbo-5'), supportsImageToVideo('runwayml-gen4_turbo-5')], [false, true])
check('luma 只文生', [supportsTextToVideo('luma_video_api'), supportsImageToVideo('luma_video_api')], [true, false])
check('fal 的 image-to-video 那两条只能图生', supportsTextToVideo('fal-ai/veo3/fast/image-to-video'), false)
check('fal 的普通那几条能文生', supportsTextToVideo('fal-ai/veo3'), true)

console.log('== Vidu 按端点类型分模式 ==')
// 每一行的类型集都是从库里逐字取的（海外站 models 表，2026-08-17）。
const VIDU_ROWS = {
  viduq1: ['Vidu text to video', 'Vidu image to video', 'Vidu first & last frame', 'Vidu reference to video'],
  'viduq3-turbo': ['Vidu text to video', 'Vidu image to video', 'Vidu first & last frame'],
  'viduq3-pro': ['Vidu text to video', 'Vidu image to video'],
  viduq2: ['Vidu text to video', 'Vidu image generation', 'Vidu reference to video'],
  'viduq1-classic': ['Vidu image to video', 'Vidu first & last frame'],
  'viduq2-turbo': ['Vidu image to video', 'Vidu first & last frame'],
  'vidu2.0': ['Vidu image to video', 'Vidu first & last frame', 'Vidu reference to video'],
  'viduq2-pro': ['Vidu reference to video'],
  viduq3: ['Vidu reference to video'],
  'viduq3-mix': ['Vidu reference to video']
}
const viduMode = (id) => {
  const types = VIDU_ROWS[id]
  const t = supportsTextToVideo(id, '视频', types)
  const i = supportsImageToVideo(id, types)
  return `${t ? '文生' : ''}${i ? '图生' : ''}` || '不进池'
}
check('viduq1 两种都行', viduMode('viduq1'), '文生图生')
check('viduq3-turbo 两种都行', viduMode('viduq3-turbo'), '文生图生')
check('viduq3-pro 两种都行', viduMode('viduq3-pro'), '文生图生')
check('viduq2 文生 + 参考生', viduMode('viduq2'), '文生图生')
check('viduq1-classic 只能图生', viduMode('viduq1-classic'), '图生')
check('viduq2-turbo 只能图生', viduMode('viduq2-turbo'), '图生')
check('vidu2.0 只能图生', viduMode('vidu2.0'), '图生')
check('viduq2-pro 只能参考生（算图生）', viduMode('viduq2-pro'), '图生')
check('viduq3 只能参考生', viduMode('viduq3'), '图生')
check('viduq3-mix 只能参考生', viduMode('viduq3-mix'), '图生')
check('类型缺失时保守当能文生（离线快照）', supportsTextToVideo('viduq3', '视频'), true)
check('Vidu 出图那个类型不进视频池', claims(['Vidu image generation']), false)
check('vidu-tts 不进视频池', claims(['Vidu speech synthesis']), false)

console.log('== 2026-08-17 深夜：可灵三条 + 可灵 3.0 两条 + PixVerse 三条 ==')
// 每一行的类型集同样从库里逐字取（海外站 models 表，2026-08-17）。
const KLING_TYPES = ['Text to video', 'Image to video', 'Multi-image reference to video']
const KLING_TURBO_TYPES = ['3.0turbo-文生视频', '3.0turbo-图生视频']
const PIX_TYPES = [
  'Pix text to video',
  'Pix image to video / video template',
  'Pix first & last frame',
  'Pix extend video',
  'Pix multi-subject (multi-reference)'
]
const mode = (id, types, tags) =>
  `${supportsTextToVideo(id, tags, types) ? '文生' : ''}${supportsImageToVideo(id, types) ? '图生' : ''}` ||
  '不进池'
check('kling-video 两种都行（多图那条也归它）', mode('kling-video', KLING_TYPES), '文生图生')
check('kling-3.0-turbo 两种都行', mode('kling-3.0-turbo', KLING_TURBO_TYPES), '文生图生')
check('pixverse-video 两种都行', mode('pixverse-video', PIX_TYPES), '文生图生')
// 这三条是「另一档能力」，认领了就等于给用户一个跑不动的选项。
check('可灵视频延长不进池', claims(['Video extend']), false)
check('可灵特效不进池', claims(['Video effects']), false)
check('PixVerse 续写不进池', claims(['Pix extend video']), false)
check('PixVerse 多主体不进池', claims(['Pix multi-subject (multi-reference)']), false)
// 只认领图生那条的模型不该被当成文生（今天库里没有这种可灵行，钉住防以后上游改）。
check(
  '只挂图生类型时不算文生',
  supportsImageToVideo('kling-video', ['Image to video']),
  true
)

console.log('== claims 收窄没被新类型带偏 ==')
check('veo3.1 能文生', supportsTextToVideo('veo3.1'), true)
check('veo3.1-components 能文生', supportsTextToVideo('veo3.1-components'), true)
check('grok-video-3 能文生', supportsTextToVideo('grok-video-3'), true)
check('sora-2-pro 能文生', supportsTextToVideo('sora-2-pro'), true)
check('happyhorse-1.0-i2v 只能图生', supportsTextToVideo('happyhorse-1.0-i2v'), false)
check('wan2.6-i2v 只能图生', supportsTextToVideo('wan2.6-i2v'), false)
check(
  'grok-imagine-video-1.5-preview（tags 只有首帧）只能图生',
  supportsTextToVideo('grok-imagine-video-1.5-preview', '首帧'),
  false
)
check('wan2.6-i2v 标为图生', supportsImageToVideo('wan2.6-i2v'), true)
check('veo3.1 不标图生（统一入口的图生还没接）', supportsImageToVideo('veo3.1'), false)
check('MiniMax-Hailuo-2.3-Fast 只能图生（平台强制要首帧）', supportsTextToVideo('MiniMax-Hailuo-2.3-Fast'), false)
check('MiniMax-Hailuo-02 两种都行', supportsTextToVideo('MiniMax-Hailuo-02'), true)
check('海螺整族都收首帧图', supportsImageToVideo('MiniMax-Hailuo-02'), true)

console.log('== 真机快照回归 ==')
const snapshotPath = process.argv[2] ?? `${here}fixtures/models-sanitized.json`
const raw = JSON.parse(readFileSync(snapshotPath, 'utf8'))
const rows = Array.isArray(raw) ? raw : (raw.data ?? [])
// 两池分开报：只能图生的那几条（wan / happyhorse-i2v / 半数 Vidu）不在文生池里，
// 但它们在图生档是选得到的 —— 合成一个数看会以为「接了却选不到」。
const claimed = rows.filter((m) => isClaimedVideoModel(String(m.id), m.supported_endpoint_types ?? []))
const idsOf = (list) => list.map((m) => String(m.id)).sort()
const textPool = idsOf(
  claimed.filter((m) => supportsTextToVideo(String(m.id), m.tags, m.supported_endpoint_types))
)
const imagePool = idsOf(
  claimed.filter((m) => supportsImageToVideo(String(m.id), m.supported_endpoint_types))
)
console.log(`  快照 ${rows.length} 条 → 适配器认领 ${claimed.length} 条`)
console.log(`  文生档 ${textPool.length} 条：${textPool.join(', ')}`)
console.log(`  图生档 ${imagePool.length} 条：${imagePool.join(', ')}`)
check('文生池非空（判据整个失效时会掉到 0）', textPool.length > 0, true)
check('图生池非空', imagePool.length > 0, true)
// 两档都选不到 = 用户看不见。这里钉一份基线：名单只能是**适配器自己的 `claims` 又收窄掉的**
// 那几条（本脚本按端点类型近似判定，够不着 `claims` 那一层，所以它们会漏到这儿）：
//   grok-imagine-video-1.5-preview  tags 只有「首帧」→ grokAdapter.claims 要 tags 含「视频」
//   happyhorse-1.0-r2v / -video-edit  bailianAdapter.claims 只收 `-t2v` 与图生那几个
// 多出别的名字就说明真接了却没人看得见，那时候要去查，不是改这份期望。
check(
  '两档都选不到的，只有被 claims 收窄掉的那三条',
  idsOf(claimed).filter((id) => !textPool.includes(id) && !imagePool.includes(id)),
  ['grok-imagine-video-1.5-preview', 'happyhorse-1.0-r2v', 'happyhorse-1.0-video-edit']
)

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
