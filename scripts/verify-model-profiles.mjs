/**
 * 离线复验「后台下发的模型参数覆盖层」的合并顺序与契约校验。
 *
 * 这一层的错全是**静默**的：界面上少一个档位、请求体里多一个上游拒收的参数，没有任何报错。
 * 所以必须有一份不碰网络、不碰磁盘的回归脚本，锁住四件事：
 *   1. 优先级：覆盖 > 家族表 > tags > 名字启发式；
 *   2. 空值不覆盖（字段缺失 ≠ 覆盖成 false）；
 *   3. 非法数据整条丢弃（照 WorkBuddy 的 isValidLocalCustomModel，内容一律不可信）；
 *   4. 灰度开关关掉 = 整份远端配置作废；作用域不同名不连坐。
 *
 * 实现走 esbuild 打包再 import：`model-profiles.ts` 依赖 `@shared/types` 的运行时常量
 * 与 electron 的 app（经 market-client），Node 的类型剥离两样都过不了。electron 用桩替掉，
 * 因为本脚本只跑纯逻辑，一次都不该读磁盘。
 *
 * 用法：node scripts/verify-model-profiles.mjs
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'yw-profiles-'))

// electron 桩：只要能 import 通即可。userData 指向临时目录，万一真有人写盘也不会污染本机。
writeFileSync(
  join(work, 'electron-stub.mjs'),
  `export const app = { isPackaged: false, getPath: () => ${JSON.stringify(work)} }\n`
)
// 入口：把两层的入口一起导出，好在同一个包里断言「合并顺序」。
writeFileSync(
  join(work, 'entry.ts'),
  [
    `export { applyProfile, profileOf, __setModelProfilesForTest } from '${join(root, 'src/main/model-profiles.ts').replace(/\\/g, '/')}'`,
    `export { alignThinkingCapability, inferModelInfoFromId } from '${join(root, 'src/main/model-capabilities.ts').replace(/\\/g, '/')}'`
  ].join('\n')
)

const bundle = join(work, 'bundle.mjs')
// 用 esbuild 的 JS API 而不是 npx：Windows 上 spawn npx 要 shell、报错还只给一个 undefined。
const esbuild = await import('esbuild')
await esbuild.build({
  entryPoints: [join(work, 'entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  tsconfig: join(root, 'tsconfig.node.json'),
  alias: { electron: join(work, 'electron-stub.mjs') },
  outfile: bundle,
  logLevel: 'warning'
})

const { applyProfile, profileOf, __setModelProfilesForTest, alignThinkingCapability } = await import(
  pathToFileURL(bundle).href
)

let pass = 0
let fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) {
    pass++
  } else {
    fail++
    console.log(
      `  FAIL ${name}\n       期望 ${JSON.stringify(want)}\n       实得 ${JSON.stringify(got)}`
    )
  }
}

/** 家族表这一层的判断（覆盖层要么改它、要么原样留着）。 */
const family = (id) => alignThinkingCapability({ id, category: 'chat', reasoning: true })

console.log('== 家族表基线（覆盖层为空时）==')
__setModelProfilesForTest([])
check('glm-4.5 档位不可控', family('glm-4.5').thinkingEffort, false)
check('glm-4.5 方言 qwen', family('glm-4.5').thinkingFormat, 'qwen')
check('deepseek-v4-flash 方言 deepseek', family('deepseek-v4-flash').thinkingFormat, 'deepseek')
// 三档而非四档：平台 relay-claude.go 的 switch 只认 low/medium/high（见家族表注释）。
check('claude-opus-4-6 有三档', family('claude-opus-4-6').thinkingLevels, ['low', 'medium', 'high'])
check('覆盖层为空时 profileOf 返 null', profileOf('yunwu', 'glm-4.5'), null)

console.log('\n== 覆盖生效：档位与方言 ==')
__setModelProfilesForTest([
  {
    model_name: 'glm-4.7',
    provider_scope: 'yunwu',
    category: 'chat',
    reasoning: true,
    thinking_levels: ['low', 'medium', 'high'],
    default_thinking_level: 'medium',
    can_disable_thinking: true,
    thinking_format: 'qwen'
  }
])
{
  const got = applyProfile(family('glm-4.7'), 'yunwu')
  check('glm-4.7 拿到下发的三档', got.thinkingLevels, ['low', 'medium', 'high'])
  check('glm-4.7 默认档 medium', got.defaultThinkingLevel, 'medium')
  check('glm-4.7 可关思考', got.canDisableThinking, true)
  check('glm-4.7 方言 qwen', got.thinkingFormat, 'qwen')
  // 作用域隔离：本机现成的反例是自建供货商 cm-deepseek-v4-flash 下的同名模型。
  check('同名不同家不被连坐', applyProfile(family('glm-4.7'), 'cm-zhipu').thinkingLevels, undefined)
}

console.log('\n== 空值不覆盖 ==')
__setModelProfilesForTest([
  { model_name: 'claude-opus-4-6', provider_scope: 'yunwu', category: 'chat', thinking_format: 'openai' }
])
{
  const got = applyProfile(family('claude-opus-4-6'), 'yunwu')
  check('只给方言不动档位', got.thinkingLevels, ['low', 'medium', 'high'])
  check('只给方言不动 reasoning', got.reasoning, true)
  check('方言被覆盖成 openai', got.thinkingFormat, 'openai')
}

console.log('\n== 覆盖成不会思考：连带清空细节 ==')
__setModelProfilesForTest([
  { model_name: 'qwq-32b', provider_scope: 'yunwu', category: 'chat', reasoning: false }
])
{
  const got = applyProfile(
    { id: 'qwq-32b', category: 'chat', reasoning: true, thinkingLevels: ['low'], thinkingFormat: 'qwen' },
    'yunwu'
  )
  check('reasoning 覆盖成 false', got.reasoning, false)
  check('档位被清空', got.thinkingLevels, undefined)
  check('方言被清空', got.thinkingFormat, undefined)
}

console.log('\n== 非法数据整条丢弃 ==')
const rejected = [
  ['认不出的档位', { model_name: 'a', provider_scope: 'yunwu', thinking_levels: ['ultra'] }],
  ['档位里混了脏值', { model_name: 'a', provider_scope: 'yunwu', thinking_levels: ['low', 'ultra'] }],
  ['默认档不在档位里', { model_name: 'a', provider_scope: 'yunwu', thinking_levels: ['low'], default_thinking_level: 'high' }],
  ['默认档本身非法', { model_name: 'a', provider_scope: 'yunwu', default_thinking_level: 'ultra' }],
  ['方言不在内核清单里', { model_name: 'a', provider_scope: 'yunwu', thinking_format: 'anthropic' }],
  ['档位不可控却配了档位', { model_name: 'a', provider_scope: 'yunwu', thinking_effort: false, thinking_levels: ['low'] }],
  ['档位不是数组', { model_name: 'a', provider_scope: 'yunwu', thinking_levels: 'low' }],
  ['模型名空', { model_name: '   ', provider_scope: 'yunwu', reasoning: true }],
  ['作用域空', { model_name: 'a', provider_scope: '', reasoning: true }],
  ['非对话类别本期不消费', { model_name: 'a', provider_scope: 'yunwu', category: 'video', reasoning: true }],
  ['一个字段都没表态', { model_name: 'a', provider_scope: 'yunwu' }]
]
for (const [name, item] of rejected) {
  __setModelProfilesForTest([item])
  check(name, profileOf('yunwu', String(item.model_name).trim() || 'a'), null)
}
// 一条坏的不该带走同批里的好条目
__setModelProfilesForTest([
  { model_name: 'bad', provider_scope: 'yunwu', thinking_levels: ['ultra'] },
  { model_name: 'good', provider_scope: 'yunwu', reasoning: true, thinking_levels: ['high'] }
])
check('坏条目不连坐好条目', profileOf('yunwu', 'good')?.thinkingLevels, ['high'])
check('坏条目自己被丢弃', profileOf('yunwu', 'bad'), null)

console.log('\n== 灰度开关关掉 = 整份作废 ==')
__setModelProfilesForTest(
  [{ model_name: 'glm-4.7', provider_scope: 'yunwu', reasoning: true, thinking_levels: ['high'] }],
  false
)
check('rollout 关闭时无覆盖', profileOf('yunwu', 'glm-4.7'), null)
check('rollout 关闭时回落家族表', applyProfile(family('glm-4.7'), 'yunwu').thinkingEffort, false)

console.log('\n== 档位不可控时清掉档位声明 ==')
__setModelProfilesForTest([
  { model_name: 'grok-4', provider_scope: 'yunwu', reasoning: true, thinking_effort: false }
])
{
  const got = applyProfile(
    { id: 'grok-4', category: 'chat', reasoning: true, thinkingLevels: ['low', 'high'], defaultThinkingLevel: 'high' },
    'yunwu'
  )
  check('档位声明被清掉', got.thinkingLevels, undefined)
  check('默认档被清掉', got.defaultThinkingLevel, undefined)
  check('thinkingEffort 落成 false', got.thinkingEffort, false)
}

rmSync(work, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
