/**
 * prepare-kernel:把本机 OpenClaw 内核运行时产物暂存到 resources/openclaw/,
 * 供 electron-builder 的 extraResources 打进安装包,实现"零安装"(用户无需自行
 * 安装 openclaw)。发布态由 resolveOpenClawLaunch() 以 Electron-as-Node 运行
 * resources/openclaw/openclaw.mjs(已实测 Electron 43 内置 Node 24.17 可跑通)。
 *
 * 内核来源解析顺序:
 *   1. 环境变量 OPENCLAW_SRC(指向 openclaw 包目录);
 *   2. 全局安装:`npm root -g`/openclaw。
 *
 * 只复制运行时必需项(openclaw.mjs / dist / node_modules / skills / package.json /
 * npm-shrinkwrap.json / patches),外加 agents 创建 workspace 时所需的模板子目录
 * (src/agents/templates 与 docs/reference/templates)。其余 docs、src、README 等
 * 非运行时内容一律跳过以控制体积。
 *
 * 注意:agents add 会读取 workspace 模板(AGENTS.md/SOUL.md/... 分布在上述两个目录),
 * 缺失会导致发布态创建 agent 报 "Missing workspace template",因此必须精确纳入。
 *
 * Run: node scripts/prepare-kernel.mjs
 */
import { execSync } from 'node:child_process'
import { existsSync, rmSync, mkdirSync, cpSync } from 'node:fs'
import { join } from 'node:path'

/** 运行时必需的条目(相对内核包根目录)。 */
const INCLUDE = [
  'openclaw.mjs',
  'package.json',
  'npm-shrinkwrap.json',
  'dist',
  'node_modules',
  'skills',
  'patches',
  /** agents add 创建 workspace 时读取的模板文件,分布在以下两个子目录。 */
  join('src', 'agents', 'templates'),
  join('docs', 'reference', 'templates')
]

/** 解析 openclaw 内核包目录;失败抛出可操作错误。 */
function resolveKernelSource() {
  const fromEnv = process.env.OPENCLAW_SRC?.trim()
  if (fromEnv) {
    if (existsSync(join(fromEnv, 'openclaw.mjs'))) {
      return fromEnv
    }
    throw new Error(`OPENCLAW_SRC 无效(缺 openclaw.mjs):${fromEnv}`)
  }
  let globalRoot = ''
  try {
    globalRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim()
  } catch (err) {
    throw new Error(`无法执行 npm root -g:${err instanceof Error ? err.message : String(err)}`)
  }
  const candidate = join(globalRoot, 'openclaw')
  if (existsSync(join(candidate, 'openclaw.mjs'))) {
    return candidate
  }
  throw new Error(
    `未找到全局 openclaw:${candidate}\n请先安装:npm i -g openclaw@latest,或设置 OPENCLAW_SRC 指向内核包目录。`
  )
}

function main() {
  const projectRoot = process.cwd()
  const dest = join(projectRoot, 'resources', 'openclaw')
  const src = resolveKernelSource()

  console.log(`[prepare-kernel] source: ${src}`)
  console.log(`[prepare-kernel] dest:   ${dest}`)

  /** 清理旧产物,保证幂等。 */
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })

  let copied = 0
  for (const item of INCLUDE) {
    const from = join(src, item)
    if (!existsSync(from)) {
      continue
    }
    cpSync(from, join(dest, item), { recursive: true })
    copied += 1
    console.log(`[prepare-kernel] copied ${item}`)
  }

  if (!existsSync(join(dest, 'openclaw.mjs'))) {
    throw new Error('[prepare-kernel] 复制后缺少 openclaw.mjs,内核暂存失败')
  }

  /**
   * agents add 依赖 workspace 模板;AGENTS.md 位于 docs/reference/templates,
   * HEARTBEAT.md 位于 src/agents/templates。任一缺失都会让发布态创建 agent 失败,
   * 故在暂存阶段 fail fast,避免把损坏内核打进安装包。
   */
  const requiredTemplates = [
    join(dest, 'docs', 'reference', 'templates', 'AGENTS.md'),
    join(dest, 'src', 'agents', 'templates', 'HEARTBEAT.md')
  ]
  for (const tpl of requiredTemplates) {
    if (!existsSync(tpl)) {
      throw new Error(
        `[prepare-kernel] 复制后缺少 workspace 模板:${tpl}\n` +
          '源内核可能不含该模板目录,请检查 openclaw 版本或 OPENCLAW_SRC 来源。'
      )
    }
  }

  console.log(`[prepare-kernel] done, ${copied} entries staged.`)
}

main()
