/**
 * 离线复验「已选模型清单的顺序」。
 *
 * 为什么值得一份脚本：清单第一条会被写成内核兜底档
 * （`resolvePrimary` → `agents.defaults.model.primary`，`config-writer.ts:274`），
 * 也决定对话框下拉的先后 —— 顺序错了不报任何错，只是默认模型悄悄换了人。
 * 拖动排序上线后这条风险更大：一次 dragenter 会连发很多下，边界算错就是静默乱序。
 *
 * 走 esbuild 打包再 import，跑的是**组件真正用的那份实现**（`lib/model-order.ts`），
 * 不是脚本里抄的一份副本。
 *
 * 用法：node scripts/verify-model-order.mjs
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'yw-order-'))
const src = join(root, 'src/renderer/src/lib/model-order.ts').replace(/\\/g, '/')
writeFileSync(join(work, 'entry.ts'), `export { moveBefore, togglePicked } from '${src}'\n`)

const bundle = join(work, 'bundle.mjs')
const esbuild = await import('esbuild')
await esbuild.build({
  entryPoints: [join(work, 'entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  logLevel: 'warning'
})
const { moveBefore, togglePicked } = await import(pathToFileURL(bundle).href)

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

const base = ['a', 'b', 'c', 'd']

console.log('== 拖动换位 ==')
check('拖到最前面（换默认模型）', moveBefore(base, 'c', 'a'), ['c', 'a', 'b', 'd'])
check('往前挪一格', moveBefore(base, 'c', 'b'), ['a', 'c', 'b', 'd'])
check('往后挪到末位', moveBefore(base, 'a', 'd'), ['b', 'c', 'd', 'a'])
check('拖到自己身上不动', moveBefore(base, 'b', 'b'), base)
check('不认识的 id 不动', moveBefore(base, 'zz', 'a'), base)
check('目标不认识也不动', moveBefore(base, 'a', 'zz'), base)
check('原数组不被改写', base, ['a', 'b', 'c', 'd'])
// dragenter 会连发：没变化时必须返回同一个引用，否则每一下都触发重渲染。
check('无变化时返回同一引用', moveBefore(base, 'b', 'b') === base, true)
// 两个元素时「拖到对方位置」就是互换，来回两次回到原序。
check('两两互换', moveBefore(['a', 'b'], 'b', 'a'), ['b', 'a'])
check('再换一次回原序', moveBefore(moveBefore(['a', 'b'], 'b', 'a'), 'b', 'a'), ['a', 'b'])

console.log('\n== 勾选与取消 ==')
check('新勾的追加到末尾', togglePicked(base, 'e'), ['a', 'b', 'c', 'd', 'e'])
check('取消就摘掉', togglePicked(base, 'b'), ['a', 'c', 'd'])
check('取消默认模型则第二条顶上', togglePicked(base, 'a')[0], 'b')
check('取消再勾回到末尾', togglePicked(togglePicked(base, 'a'), 'a'), ['b', 'c', 'd', 'a'])
check('空清单勾一个', togglePicked([], 'a'), ['a'])
// 「随手加一个模型不许换掉默认模型」——这条是顺序语义的立命之处。
check('追加不动第一条', togglePicked(base, 'zzz')[0], 'a')

console.log('\n== 拖动与勾选混着来 ==')
{
  let o = base
  o = togglePicked(o, 'e') // 新勾 e → 末尾
  o = moveBefore(o, 'e', 'a') // 拖 e 到最前 → 默认模型变 e
  check('新勾的能被拖成默认', o, ['e', 'a', 'b', 'c', 'd'])
  o = togglePicked(o, 'e') // 又取消 e
  check('取消后默认回到 a', o, ['a', 'b', 'c', 'd'])
}

rmSync(work, { recursive: true, force: true })
console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 过 / ${fail} 挂`)
process.exit(fail === 0 ? 0 : 1)
