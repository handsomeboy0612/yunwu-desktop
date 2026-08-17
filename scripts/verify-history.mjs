/**
 * 校验历史还原:用真实的内核 session jsonl 跑一遍 session-history 解析器,
 * 打印还原出的「执行过程」结构(步骤顺序 / 状态 / diff 行数 / 问答卡 / 正文偏移)。
 *
 * 这个解析器依赖内核落盘 jsonl 的形状(toolCall 块、role:'toolResult' 消息、
 * toolCallId 配对),内核升级后格式一变就会静默还原不出东西——所以留一个能一键跑的检查。
 *
 * 用法:
 *   npm run verify:history            # 自动挑最近改动的 agent
 *   npm run verify:history -- <agentId>
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, readdirSync, rmSync, statSync, existsSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

/** 挑一个最近有会话记录的 agent(按 sessions 目录的修改时间)。 */
function newestAgentId() {
  const root = join(homedir(), '.openclaw', 'agents')
  if (!existsSync(root)) {
    return ''
  }
  let best = { id: '', mtime: 0 }
  for (const id of readdirSync(root)) {
    const dir = join(root, id, 'sessions')
    if (!existsSync(dir)) {
      continue
    }
    const mtime = statSync(dir).mtimeMs
    if (mtime > best.mtime) {
      best = { id, mtime }
    }
  }
  return best.id
}

const agentId = process.argv[2] || newestAgentId()
if (!agentId) {
  console.error('找不到任何带会话记录的 agent')
  process.exit(1)
}

// 解析器是 TS 且用了 @shared 别名,先用项目自带的 esbuild 打成单文件再跑。
const tmp = mkdtempSync(join(tmpdir(), 'yw-verify-'))
const bundle = join(tmp, 'entry.mjs')
const driver = join(tmp, 'driver.mts')
const { writeFileSync } = await import('fs')
writeFileSync(
  driver,
  `import { readSessionHistory } from ${JSON.stringify(join(process.cwd(), 'src/main/session-history.ts').replace(/\\/g, '/'))}
const msgs = await readSessionHistory(process.argv[2])
console.log('消息数 ' + msgs.length)
for (const [i, m] of msgs.entries()) {
  const extra = [
    m.timeline ? '时间线' + m.timeline.length + '项' : '',
    m.plan ? '清单' + m.plan.length + '步' : '',
    m.artifacts ? '产物' + m.artifacts.length + '个' : ''
  ].filter(Boolean).join(' ')
  console.log('#' + i + ' ' + m.role + ' 正文' + m.content.length + '字 ' + extra)
  for (const it of m.timeline ?? []) {
    if (it.kind === 'tool') {
      const stats = it.stats ? ' +' + it.stats.added + ' -' + it.stats.removed : ''
      const prev = it.preview ? ' preview=' + it.preview.length + '字' : ''
      console.log('    @' + it.at + ' [tool ' + it.status + '] ' + it.title + stats + prev)
    } else if (it.kind === 'thinking') {
      console.log('    @' + it.at + ' [thinking] ' + it.text.slice(0, 40).replace(/\\n/g, ' ') + '…')
    } else if (it.kind === 'ask') {
      const ans = (it.answers ?? []).map((a) => a.header + '=' + a.selected.join('/')).join(', ')
      console.log('    @' + it.at + ' [ask ' + it.status + '] ' + it.questions.length + '题 → ' + ans)
    } else if (it.kind === 'widget') {
      console.log('    @' + it.at + ' [widget] ' + it.title + ' svg=' + it.code.length + '字')
    } else {
      console.log('    @' + it.at + ' [plan] ' + it.steps.length + '步')
    }
  }
  if (m.role === 'assistant' && m.timeline?.length) {
    const lastAt = Math.max(...m.timeline.map((t) => t.at ?? 0))
    console.log('    最终回答段 = 正文[' + lastAt + '..] 共 ' + (m.content.length - lastAt) + ' 字')
  }
}
`
)

try {
  // 走 esbuild 的 JS API:Windows 下 node 不允许直接 spawn npx.cmd。
  const { build } = await import('esbuild')
  await build({
    entryPoints: [driver],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundle,
    alias: { '@shared': join(process.cwd(), 'src/shared') },
    // 解析器如今会传递依赖网关客户端(会话索引优先问网关要清单),它底下的 ws 是 CJS,
    // 打成 ESM 后 `require('events')` 会抛「Dynamic require not supported」。
    banner: {
      js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);"
    },
    logLevel: 'warning'
  })
  console.log(`agent: ${agentId}`)
  execFileSync(process.execPath, [bundle, agentId], { stdio: 'inherit' })
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
