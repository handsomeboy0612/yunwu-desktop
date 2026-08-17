/**
 * patch-kernel-toolcalls:上游不回 finish_reason 时,别把已经收全的工具调用丢掉。
 *
 * 背景
 * ----
 * openlux 的自建通道跑 deepseek-v4-flash 时,SSE 每一块的 finish_reason 都是空串 `""`,
 * `[DONE]` 之前也没有终止块(2026-08-17 用 .tmp-probe/tee-fetch.cjs 抄下三发原始字节核实,
 * 三发都带完整的 image_generate 调用:name、id、完整 JSON 参数俱全)。
 *
 * 内核 `openai-transport-stream` 收尾时:
 *   1. `choice.finish_reason` 恒为假 → never 进 mapOpenAIStopReason,`output.stopReason`
 *      停在初值 `"stop"`,`sawStopFinishReason` 也停在 false;
 *   2. 那条救回逻辑要求 `sawStopFinishReason` 为真,救不到;
 *   3. 于是最后一行把 toolCall 块**整块过滤掉** —— 这一轮只剩思考,内核判定
 *      reasoning-only 并重试两次,两次同样被丢,最后放弃、改成一句普通回答。
 *
 * 用户看到的就是「让它生图,它说『我来生成这张图』然后什么都没有」。
 *
 * 改法照内核自己的 responses 分支
 * ------------------------------
 * 同一份文件里,responses 那条路的写法是:
 *   `if (output.content.some(b => b.type === "toolCall") && output.stopReason === "stop")`
 *   `  output.stopReason = "toolUse";`
 * 既不要求见过 finish_reason,也不要求这轮没有正文。本补丁把 completions 分支对齐成同一条
 * 规则,不是自己发明判据。
 *
 * 保留的安全边界:最后那行过滤照旧。stopReason 是 `maxTokens` / 内容过滤 / 报错时,
 * 参数可能被截断在 JSON 中途,这种工具调用仍然该丢 —— 只有 `"stop"`(含"上游一个字都没说"
 * 这个初值)才转成 toolUse。
 *
 * 设计与 patch-kernel-reasoning 一致:幂等、多目标(dev 用全局安装,打包用 resources/openclaw)、
 * 匹配不到立即非零退出,避免补丁被静默丢掉后又变回"生图不出图"却无人察觉。
 *
 * Run: node scripts/patch-kernel-toolcalls.mjs
 */
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 打完补丁后应有的样子;用它判断是否已是补丁态。 */
const PATCHED = /if \(output\.stopReason === "stop" && hasToolCalls\) output\.stopReason = "toolUse";/

const EDIT = {
  name: '缺 finish_reason 时保留工具调用',
  test: /if \(sawStopFinishReason && output\.stopReason === "stop" && hasToolCalls && !hasVisibleText\) output\.stopReason = "toolUse";/,
  apply: (src) =>
    src.replace(
      /if \(sawStopFinishReason && output\.stopReason === "stop" && hasToolCalls && !hasVisibleText\) output\.stopReason = "toolUse";/,
      'if (output.stopReason === "stop" && hasToolCalls) output.stopReason = "toolUse";'
    )
}

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
 * 定位承载 completions 收尾逻辑的 bundle。文件名带内容哈希(如
 * openai-transport-stream-Dj78Cdnf.js),每次发版都变,故按内容特征找。
 */
function findTransportBundle(kernelDir) {
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
    if (src.includes('sawStopFinishReason') && src.includes('hasVisibleText')) {
      return { file, src }
    }
  }
  return null
}

let failed = false

for (const root of resolveKernelRoots()) {
  const found = findTransportBundle(root.dir)
  if (!found) {
    console.error(`[patch-toolcalls] ✗ ${root.label}:未找到含 sawStopFinishReason 的 bundle`)
    failed = true
    continue
  }
  if (PATCHED.test(found.src)) {
    console.log(`[patch-toolcalls] = ${root.label}:已是补丁态,跳过`)
    continue
  }
  if (!EDIT.test.test(found.src)) {
    console.error(
      `[patch-toolcalls] ✗ ${root.label}:既不是补丁态也匹配不到目标,内核写法可能已变更。\n` +
        `    请人工比对 ${found.file} 中 hasToolCalls / hasVisibleText 那几行,并更新本脚本。`
    )
    failed = true
    continue
  }
  const src = EDIT.apply(found.src)
  if (!PATCHED.test(src)) {
    console.error(`[patch-toolcalls] ✗ ${root.label}:改写后未出现预期特征,已放弃写盘`)
    failed = true
    continue
  }
  writeFileSync(found.file, src, 'utf-8')
  console.log(`[patch-toolcalls] ✓ ${root.label}:已打补丁(${EDIT.name})`)
}

if (failed) {
  console.error(
    '\n[patch-toolcalls] 补丁未能全部应用。上游不回 finish_reason 的通道会继续丢工具调用,\n' +
      '表现为「让它生图/搜索,它只说一句话就结束」。若刚升级过内核,请按上面提示更新匹配规则。'
  )
  process.exit(1)
}
