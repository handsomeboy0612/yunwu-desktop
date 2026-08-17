/**
 * 校验 dsh 写者锁的孤儿回收（`src/main/dsh/settings-lock.ts`）。
 *
 * 两件事：
 *
 * 1. **漂移闸门**：我们的守卫吃死了内核锁协议的三条事实——锁文件叫 `<文件>.lock`、
 *    内容是 `${process.pid}\n`、超时 2000ms。内核哪天改了锁文件名或内容格式，
 *    守卫会**静默失效**（读不到 pid → 走年龄兜底 → 行为退化），不报错。
 *    所以每次跑这个脚本都回内核源码核一遍那三条字面量。
 *
 * 2. **行为判据**：六种锁状态各跑一遍，重点是 `EPERM`（活着但不可 signal）那一档——
 *    仓库既有的 `isAlive` 在这一档会误判成"死了"，从而删掉活写者的锁。
 *
 * 用法：
 *   node scripts/verify-settings-lock.mjs
 *   DSH_ATOMIC_WRITE_SRC=<路径> node scripts/verify-settings-lock.mjs   # 内核源码不在默认位置时
 */
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

let failures = 0
const fail = (msg) => { failures += 1; console.log(`  ✗ ${msg}`) }
const pass = (msg) => { console.log(`  ✓ ${msg}`) }

// ── 1. 漂移闸门：内核的锁协议还是我们假设的那个吗 ────────────────────────────
// 不写死单一路径：今天是同级 checkout，阶段 0 之后会变成依赖。按候选顺序找。
function findAtomicWriteSource() {
  const candidates = [
    process.env.DSH_ATOMIC_WRITE_SRC,
    join(process.cwd(), 'node_modules/@deepseek-ai/dsh-atomic-write/src/index.ts'),
    join(process.cwd(), 'node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js'),
    resolve(process.cwd(), '../deepseek-harness/packages/util/atomic-write/src/index.ts')
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p)) ?? ''
}

console.log('漂移闸门：内核锁协议')
const srcPath = findAtomicWriteSource()
if (!srcPath) {
  fail('找不到内核 atomic-write 源码，三条假设无法核对（设 DSH_ATOMIC_WRITE_SRC 指过去）')
} else {
  const src = readFileSync(srcPath, 'utf8')
  console.log(`  源码: ${srcPath}`)
  const checks = [
    ['锁文件名 = `${filename}.lock`', /const lockPath = `\$\{filename\}\.lock`/],
    ['锁内容 = `${process.pid}\\n`', /writeFile\(\s*lockPath,\s*`\$\{process\.pid\}\\n`/],
    ['超时 2000ms', /LOCK_TIMEOUT_MS\s*=\s*2_?000/],
    // 这句话在 JSDoc 里会换行成 `orphan recovery\n * is an operator action`，
    // 所以词间要容忍换行与注释前缀，不能写成一整串字面量。
    ['内核刻意不夺锁（回收是运维动作）', /orphan recovery[\s*]+is an operator action/]
  ]
  for (const [label, re] of checks) {
    if (re.test(src)) {
      pass(label)
    } else {
      fail(`${label} —— 内核已改，守卫的假设失效，去改 src/main/dsh/settings-lock.ts`)
    }
  }
}

// ── 2. 行为判据 ──────────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'yw-lock-verify-'))
const driver = join(tmp, 'driver.mts')
const bundle = join(tmp, 'entry.mjs')

writeFileSync(
  driver,
  `import { reclaimStaleWriterLock, describeLockOutcome } from ${JSON.stringify(
    join(process.cwd(), 'src/main/dsh/settings-lock.ts').replace(/\\\\/g, '/')
  )}
import { mkdtempSync, writeFileSync, existsSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dir = mkdtempSync(join(tmpdir(), 'dsh-home-'))
const settings = join(dir, 'settings.yaml')
writeFileSync(settings, 'llm-yunwu:\\n  baseURL: https://yunwu.ai/v1\\n')
const lock = settings + '.lock'

/** 造一个锁文件；backdateMs 用来把 mtime 往前挪（模拟"放了很久的孤儿"）。 */
function putLock(content, backdateMs = 0) {
  writeFileSync(lock, content)
  if (backdateMs > 0) {
    const t = (Date.now() - backdateMs) / 1000
    utimesSync(lock, t, t)
  }
}

const cases = []
async function check(name, setup, expectKind, expectReason, expectLockGone) {
  setup()
  const out = await reclaimStaleWriterLock(settings)
  const gone = !existsSync(lock)
  const ok = out.kind === expectKind
    && (expectReason === null || out.reason === expectReason)
    && gone === expectLockGone
  cases.push({ name, ok, got: JSON.stringify(out), gone, msg: describeLockOutcome(out) })
}

// 没有锁
await check('无锁 → absent', () => {}, 'absent', null, true)
// 死 pid：999999 本机实测 ESRCH
await check('死 pid → reclaimed(owner-gone)，锁被删',
  () => putLock('999999\\n'), 'reclaimed', 'owner-gone', true)
// 活 pid：自己
await check('自己的 pid → held(alive)，锁保留',
  () => putLock(String(process.pid) + '\\n'), 'held', 'alive', false)
// EPERM：pid 4 = Windows System，活着但不可 signal。这一档是既有 isAlive 会误判的那个。
await check('pid 4(System, EPERM) → held(unsignalable)，锁保留',
  () => putLock('4\\n'), 'held', 'unsignalable', false)
// 内容解析不出 pid，且很新 → 当作别人正在写，不动
await check('空锁 + 很新 → held(malformed-fresh)，锁保留',
  () => putLock(''), 'held', 'malformed-fresh', false)
// 内容解析不出 pid，且放了很久 → 孤儿
await check('空锁 + 放了 60 秒 → reclaimed(malformed)，锁被删',
  () => putLock('', 60_000), 'reclaimed', 'malformed', true)
// 带尾随空白 / CRLF 的 pid 也要认（Windows 上手改过的锁文件）
await check('CRLF + 空白的死 pid 也认 → reclaimed',
  () => putLock(' 999998 \\r\\n'), 'reclaimed', 'owner-gone', true)

for (const c of cases) {
  console.log((c.ok ? '  \\u2713 ' : '  \\u2717 ') + c.name)
  if (!c.ok) console.log('      实际: ' + c.got + ' 锁已删=' + c.gone)
  if (c.msg) console.log('      提示语: ' + c.msg)
}
process.exit(cases.every((c) => c.ok) ? 0 : 1)
`
)

console.log('\n行为判据：七种锁状态')
try {
  // 走 esbuild 的 JS API:Windows 下 node 不允许直接 spawn npx.cmd。
  const { build } = await import('esbuild')
  await build({
    entryPoints: [driver],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundle,
    logLevel: 'warning'
  })
  execFileSync(process.execPath, [bundle], { stdio: 'inherit' })
} catch {
  failures += 1
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条未通过`)
process.exit(failures === 0 ? 0 : 1)
