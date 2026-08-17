/**
 * patch-kernel-reasoning:解除 OpenClaw 内核对「思考流式广播」的回调闸门。
 *
 * 背景
 * ----
 * 内核只有在 `streamReasoning` 为真时才会 `emitAgentEvent({ stream: "thinking" })`,
 * 而该标志被额外卡在 `typeof params.onReasoningStream === "function"` 上。这个回调由
 * **运行入口**提供:Telegram / Mattermost 等渠道集成会传,而所有走 `chat.send` 的表面
 * (webchat、Control UI、纯 WS 客户端、ACP —— 包括我们)都不传。结果就是深度思考永远
 * 无法实时流式,只能在轮末随最终消息整块到达。
 *
 * 上游对此有长期未决的 issue(#48995)与多次未合入的 PR(#47613 / #54821 / #79687 /
 * #87481)。已核实截至 2026.7.1-2(最新稳定版)**仍未修复**,且 `thinking-events`
 * 能力位也不存在,故只能本地打补丁。本脚本所做的改动与上述 PR 一致:
 *   1. `streamReasoning` 不再要求回调存在;
 *   2. `emitReasoningStream` 不再因缺少回调而提前返回;
 *   3. 回调改为可选调用(有就调,没有只广播事件)。
 *
 * 设计
 * ----
 * - **幂等**:已打过的文件会被识别并跳过,可反复执行;
 * - **多目标**:dev 跑的是全局安装的内核,打包用的是 resources/openclaw 副本(且会被
 *   prepare-kernel 覆盖重写),两处都要打;
 * - **失败即报错**:内核升级后若匹配不到目标,立即以非零码退出并说明原因,
 *   避免补丁被静默丢失、思考又变回一次性输出却无人察觉。
 *
 * Run: node scripts/patch-kernel-reasoning.mjs
 */
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 三处改写。`test` 用于判断"是否还需要改",`apply` 执行改写。
 * 全部基于正则,以容忍不同内核版本的细微差异(例如新版 streamReasoning 前半段
 * 变成了 `params.streamReasoningInNonStreamModes === true ? … : …`)。
 */
const EDITS = [
  {
    name: 'streamReasoning 去掉回调条件',
    test: /streamReasoning:\s*[^\n]*?\s*&&\s*typeof params\.onReasoningStream === "function"/,
    apply: (src) =>
      src.replace(
        /(streamReasoning:\s*[^\n]*?)\s*&&\s*typeof params\.onReasoningStream === "function"/,
        '$1'
      )
  },
  {
    name: 'emitReasoningStream 去掉提前返回',
    test: /if \(!state\.streamReasoning \|\| !params\.onReasoningStream\) return;/,
    apply: (src) =>
      src.replace(
        /if \(!state\.streamReasoning \|\| !params\.onReasoningStream\) return;/,
        'if (!state.streamReasoning) return;'
      )
  },
  {
    name: '回调改为可选调用',
    test: /params\.onReasoningStream\(\{ text: trimmed \}\);/,
    apply: (src) =>
      src.replace(
        /params\.onReasoningStream\(\{ text: trimmed \}\);/,
        'params.onReasoningStream?.({ text: trimmed });'
      )
  }
]

/** 解析所有需要打补丁的内核根目录(存在才纳入)。 */
function resolveKernelRoots() {
  const roots = []
  const bundled = join(ROOT, 'resources', 'openclaw')
  if (existsSync(join(bundled, 'openclaw.mjs'))) {
    roots.push({ label: 'resources/openclaw (打包副本)', dir: bundled })
  }
  const fromEnv = process.env.OPENCLAW_SRC?.trim()
  if (fromEnv && existsSync(join(fromEnv, 'openclaw.mjs'))) {
    roots.push({ label: `OPENCLAW_SRC (${fromEnv})`, dir: fromEnv })
  } else {
    try {
      const globalRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim()
      const globalKernel = join(globalRoot, 'openclaw')
      if (existsSync(join(globalKernel, 'openclaw.mjs'))) {
        roots.push({ label: `全局安装 (${globalKernel})`, dir: globalKernel })
      }
    } catch {
      /* 没有全局安装则跳过,不算失败 */
    }
  }
  return roots
}

/**
 * 在某内核根目录下定位承载 emitReasoningStream 的 bundle 文件。
 * 文件名带内容哈希(如 selection-CVIPXpKT.js),每次发版都会变,故按内容特征找。
 */
function findReasoningBundle(kernelDir) {
  const distDir = join(kernelDir, 'dist')
  if (!existsSync(distDir)) {
    return null
  }
  for (const entry of readdirSync(distDir)) {
    if (!entry.endsWith('.js')) {
      continue
    }
    const file = join(distDir, entry)
    let src
    try {
      src = readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    if (src.includes('streamReasoning') && src.includes('emitReasoningStream')) {
      return { file, src }
    }
  }
  return null
}

let failed = false

for (const root of resolveKernelRoots()) {
  const found = findReasoningBundle(root.dir)
  if (!found) {
    console.error(`[patch-kernel] ✗ ${root.label}:未找到包含 emitReasoningStream 的 bundle`)
    failed = true
    continue
  }
  let src = found.src
  const applied = []
  const alreadyOk = []
  for (const edit of EDITS) {
    if (edit.test.test(src)) {
      src = edit.apply(src)
      applied.push(edit.name)
    } else {
      alreadyOk.push(edit.name)
    }
  }
  /**
   * 关键校验:改完之后回调闸门必须彻底消失。若三处都"未命中"却仍能搜到闸门特征,
   * 说明内核换了写法、补丁已失效 —— 必须报错,而不是假装成功。
   */
  const gateGone =
    !/streamReasoning:[^\n]*typeof params\.onReasoningStream === "function"/.test(src) &&
    !/if \(!state\.streamReasoning \|\| !params\.onReasoningStream\) return;/.test(src)
  if (!gateGone) {
    console.error(
      `[patch-kernel] ✗ ${root.label}:改写后仍检测到回调闸门,内核写法可能已变更。\n` +
        `    请人工比对 ${found.file} 中的 streamReasoning / emitReasoningStream,并更新本脚本。`
    )
    failed = true
    continue
  }
  if (applied.length > 0) {
    writeFileSync(found.file, src, 'utf-8')
    console.log(`[patch-kernel] ✓ ${root.label}:已打补丁(${applied.join('、')})`)
  } else {
    console.log(`[patch-kernel] = ${root.label}:已是补丁态,跳过(${alreadyOk.length}/3 项)`)
  }
}

if (failed) {
  console.error(
    '\n[patch-kernel] 补丁未能全部应用。深度思考将退回"轮末一次性输出"。\n' +
      '若刚升级过内核,请按上面提示更新 scripts/patch-kernel-reasoning.mjs 的匹配规则。'
  )
  process.exit(1)
}
