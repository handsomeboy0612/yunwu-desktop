/**
 * dsh 写者锁的孤儿回收。
 *
 * 为什么需要它：dsh 用 `<文件>.lock` 兄弟文件串行化跨进程的配置写入
 * （`deepseek-harness/packages/util/atomic-write/src/index.ts:93-118`），而内核把孤儿锁的
 * 回收**明确推给了运维**——那份源码第 86-88 行的原话是 *The contender never removes an
 * existing lock because file age cannot prove that its owner stopped; orphan recovery is an
 * operator action.*
 *
 * 这条对服务端成立，对桌面产品不成立：我们的「运维」是不会去翻
 * `%USERPROFILE%\.dsh\settings.yaml.lock` 的终端用户。所以这个 operator 只能是启动期的我们。
 *
 * 不做的代价是具体的：进程崩在持锁期间之后（任务管理器强杀、断电、更新时被替换掉），
 * 此后**每一次**写配置都要先等满 2 秒的锁超时再失败，而用户看到的只是「保存没反应」。
 *
 * 判据是 pid 存活，不是文件年龄——内核拒绝用年龄是对的，而锁文件里存着 pid，
 * 存活判断比年龄硬。
 */

import { readFile, rm, stat } from 'node:fs/promises'

/** 锁文件内容解析不出 pid 时，多久之后才认定是孤儿。见 `reclaimStaleWriterLock` 的说明。 */
const MALFORMED_LOCK_GRACE_MS = 10_000

/** 一次回收尝试的结果。`held` 是唯一需要拦住启动流程去告诉用户的一种。 */
export type LockReclaimOutcome =
  | { kind: 'absent' }
  | { kind: 'reclaimed'; pid: number | null; reason: 'owner-gone' | 'malformed' }
  | { kind: 'held'; pid: number | null; reason: 'alive' | 'unsignalable' | 'malformed-fresh' }
  | { kind: 'failed'; error: string }

/**
 * 进程是否还活着。**三态，不能折成两态**。
 *
 * `process.kill(pid, 0)` 只探活不投递信号，三种结果含义完全不同：
 *  - 正常返回 → 活着且我们能 signal 它
 *  - `EPERM`  → **活着**，只是我们没权限（别的用户、或提权进程）
 *  - `ESRCH`  → 不存在
 *
 * 仓库里既有的 `openclaw-manager.ts:45-52` 那个 `isAlive` 把 `catch` 一律当"死了"——
 * 用来决定"要不要补一刀 kill"没问题，**用来决定"要不要删别人的锁"就是错的**：
 * 本机实测 `pid 4`（System）返回 `EPERM`，照那个判据会被当成死进程，
 * 于是我们会去删一个活着的写者持有的锁。所以这里单独写一个。
 */
function probeProcess(pid: number): 'alive' | 'unsignalable' | 'gone' {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? 'unsignalable' : 'gone'
  }
}

/** 锁文件第一行就是 pid（内核写的是 `${process.pid}\n`）。取不到合法 pid 返回 null。 */
function parseLockPid(text: string): number | null {
  const pid = Number.parseInt(text.trim().split(/\r?\n/, 1)[0] ?? '', 10)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

/**
 * 检查一个 dsh 数据文件的写者锁，能证明是孤儿就删掉。
 *
 * **只在启动期、挂载 settings 之前调用。** 那一刻我们自己还没写过任何配置，
 * 所以盘上还留着锁只有两种可能：上次崩溃留下的，或者另一个实例正在跑。
 *
 * 三条判据：
 *  - pid 已不存在（`ESRCH`）→ 孤儿，删。
 *  - pid 还活着（正常返回或 `EPERM`）→ **不动**。可能是另一个实例，也可能是 pid 被系统回收
 *    给了别的程序。两种情况都宁可让用户看到一句可读的报错，也不去删一个可能有主的锁。
 *  - 解析不出 pid → 说明进程死在"创建锁"与"写入 pid"之间（内核那次 `writeFile` 是
 *    `wx` 创建 + 写内容一步做的，窗口极小但非零）。这种情况没有 pid 可查，
 *    退回到年龄这一个兜底判据：超过 10 秒才认定是孤儿。这不违背内核那条纪律——
 *    它拒绝的是"用年龄替代所有判断"，而这里是"没有 pid 可查时的最后一档"。
 *
 * 不抛异常：回收失败不该拦住启动，交给调用方决定怎么提示。
 * @param filePath - 被锁保护的数据文件（如 `<DSH_HOME>/settings.yaml`），不是锁文件本身。
 */
export async function reclaimStaleWriterLock(filePath: string): Promise<LockReclaimOutcome> {
  const lockPath = `${filePath}.lock`
  let text: string
  try {
    text = await readFile(lockPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'absent' }
    }
    return { kind: 'failed', error: describe(error) }
  }

  const pid = parseLockPid(text)
  if (pid === null) {
    let ageMs: number
    try {
      ageMs = Date.now() - (await stat(lockPath)).mtimeMs
    } catch (error) {
      return { kind: 'failed', error: describe(error) }
    }
    if (ageMs < MALFORMED_LOCK_GRACE_MS) {
      return { kind: 'held', pid: null, reason: 'malformed-fresh' }
    }
    return remove(lockPath, { pid: null, reason: 'malformed' })
  }

  // 自己的 pid 不该出现在这里（启动期我们还没写过配置）。真出现了也按"活着"处理，
  // 删掉它等于给自己解锁，没有意义。
  if (pid === process.pid) {
    return { kind: 'held', pid, reason: 'alive' }
  }

  const state = probeProcess(pid)
  if (state === 'alive') {
    return { kind: 'held', pid, reason: 'alive' }
  }
  if (state === 'unsignalable') {
    return { kind: 'held', pid, reason: 'unsignalable' }
  }
  return remove(lockPath, { pid, reason: 'owner-gone' })
}

async function remove(
  lockPath: string,
  info: { pid: number | null; reason: 'owner-gone' | 'malformed' },
): Promise<LockReclaimOutcome> {
  try {
    // Windows 上句柄未释放会短暂 EPERM/EBUSY，照 market/installer.ts 的既有做法带重试。
    await rm(lockPath, { force: true, maxRetries: 5, retryDelay: 120 })
    return { kind: 'reclaimed', ...info }
  } catch (error) {
    return { kind: 'failed', error: describe(error) }
  }
}

function describe(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  return code ? `${code}: ${String((error as Error).message ?? error)}` : String(error)
}

/**
 * 把结果翻成一句面向用户的中文。`null` 表示这一档不需要打扰用户。
 *
 * 照仓库既有的 `classifyError`（`openclaw-manager.ts:58`）的口径：说清现象、给可操作的下一步，
 * 不把 errno 甩给用户。
 */
export function describeLockOutcome(outcome: LockReclaimOutcome): string | null {
  switch (outcome.kind) {
    case 'absent':
    case 'reclaimed':
      return null
    case 'held':
      if (outcome.reason === 'malformed-fresh') {
        return '另一个窗口正在保存设置，请稍候再试。'
      }
      return outcome.pid === null
        ? '设置文件被占用，保存可能失败。请重启应用。'
        : `设置文件正被另一个进程占用（PID ${outcome.pid}），保存会失败。`
          + '请关闭重复打开的窗口；若已全部关闭，请重启电脑。'
    case 'failed':
      return `清理设置文件的写入锁失败（${outcome.error}）。保存设置可能失败。`
  }
}
