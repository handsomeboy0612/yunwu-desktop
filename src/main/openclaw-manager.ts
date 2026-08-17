import { spawn, execFile, ChildProcess } from 'child_process'
import { existsSync, statSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { EventEmitter } from 'events'
import { resolveOpenClawLaunch, finalizeArgs, type OpenClawLaunch } from './openclaw-cli'
import {
  probeGatewayReady,
  listeningPids,
  waitForPortFree,
  terminatePids,
  isPortConflictOutput,
  isGatewayReadyOutput
} from './gateway-port'
import { getWorkspaceDir } from './workspace'
import { OPENCLAW_DEFAULT_PORT, OPENCLAW_HANDSHAKE_TIMEOUT_MS } from '@shared/types'
import type { GatewayStatus } from '@shared/types'

/** 去除终端 ANSI 颜色/控制转义码,避免把 `[90m` 之类乱码透传到 UI。 */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g
function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '').trim()
}

/** 进程存活不足此值且无任何输出即判为"夭折",触发二次诊断。 */
const EARLY_EXIT_MS = 5000
/** 二次诊断(execFile 重跑)最长等待。 */
const DIAG_TIMEOUT_MS = 5000
/** 健康运行后崩溃的自动重启:最大次数与退避区间。 */
const MAX_RESTARTS = 5
const RESTART_BASE_MS = 1000
const RESTART_MAX_MS = 30000
/**
 * spawn 之后等网关握手就绪的上限。
 * 技能里记的实测值是「启动到 ready 20s+」,冷启动再慢也不该超过这个数。
 */
const READY_TIMEOUT_MS = 90000
/** 就绪探针轮询间隔。 */
const READY_POLL_MS = 500
/** 端口冲突自愈(清端口后重来)的次数上限;超了就不再 spawn,避免又变成死循环。 */
const MAX_PORT_RECOVERIES = 2

/** signal 0 只探活不投递信号:抛错即进程已不存在。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 把 spawn/退出错误归类为面向用户的中文可操作提示。
 * 依据 err.code 与 stderr 关键字判断(参考 WorkBuddy 的错误归类)。
 */
function classifyError(code: string | undefined, stderr: string): string {
  const s = stderr.toLowerCase()
  if (code === 'ENOENT') {
    return '未找到内核可执行文件(可能缺失或被杀毒软件拦截)。请重装应用或检查安全软件。'
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return '启动内核权限不足。请以正常权限运行,或检查文件是否被锁定。'
  }
  if (s.includes('eaddrinuse') || s.includes('address already in use')) {
    return `端口 ${OPENCLAW_DEFAULT_PORT} 已被占用。请关闭占用该端口的程序后重试。`
  }
  if (s.includes('json') && (s.includes('parse') || s.includes('unexpected'))) {
    return '配置文件解析失败(openclaw.json 可能损坏)。将尝试重写配置后重试。'
  }
  if (s.includes('node') && s.includes('version')) {
    return '运行时 Node 版本不兼容。'
  }
  return ''
}

/**
 * 本地 OpenClaw 网关进程管理器。
 *
 * 职责:以子进程方式拉起 / 停止 OpenClaw 网关,跟踪运行状态,并通过 'status'
 * 事件把状态变化推给主进程转发到渲染层。
 *
 * 内核解析走 resolveOpenClawLaunch():发布态用随包内置内核(Electron 当 Node
 * 跑 openclaw.mjs),开发态回退全局 openclaw。启动带 spawn 前探针 + 秒退夭折
 * 二次诊断,便于定位"起不来 / 一直思考"这类问题。
 */
class OpenClawManager extends EventEmitter {
  private child: ChildProcess | null = null
  private readonly port = OPENCLAW_DEFAULT_PORT
  private lastMessage = ''
  /** 用户主动停止标记:区分手动停止与崩溃,避免对手动停止做夭折诊断。 */
  private stoppedByUser = false
  /** 本轮进程是否已产生任何输出(用于夭折判定)。 */
  private sawOutput = false
  /**
   * 本轮进程是否真正就绪过(握手探针成功,或内核打出 ready 行)。
   *
   * 这是重启退避的唯一归零判据。曾经用的是「有没有输出」,而失败的子进程恰恰会
   * 先把错误打出来再退出 —— 于是 restartAttempts 每轮被清零,MAX_RESTARTS 这道闸门
   * 永远合不上。真机上因此连转了近 50 分钟、约 220 次 spawn,把网关的事件循环
   * 拖到 P99 23 秒,一次 config.patch 从 1.9s 变成 31s。
   */
  private ready = false
  /** 崩溃自动重启计数与定时器。 */
  private restartAttempts = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  /** 端口冲突自愈次数(每次成功就绪后归零)。 */
  private portRecoveries = 0
  /** 进行中的启动流程;避免并发 start() 各起一个网关。 */
  private startInFlight: Promise<void> | null = null
  /**
   * 复用的既有网关 pid(我们没 spawn、但探针确认是活网关)。
   *
   * 这种进程多半是上一次应用运行留下的孤儿。既然它能正常服务就不打断它,
   * 但要认领下来,退出时一并回收 —— 不认领正是孤儿越积越多的原因。
   */
  private adoptedPid: number | null = null

  /** PID 文件路径:记录我们拉起的网关进程,便于清理上次残留。 */
  private pidFilePath(): string {
    return join(app.getPath('userData'), 'gateway.pid')
  }

  /** 写入当前网关子进程 PID。 */
  private writePid(pid: number): void {
    try {
      writeFileSync(this.pidFilePath(), String(pid), 'utf-8')
    } catch {
      /* 写 PID 失败不影响运行 */
    }
  }

  /** 删除 PID 文件。 */
  private removePid(): void {
    try {
      rmSync(this.pidFilePath())
    } catch {
      /* 文件不存在忽略 */
    }
  }

  /**
   * 清理上次残留的网关进程:读取 PID 文件,若该进程仍存活则终止,规避端口被占用
   * (EADDRINUSE)。仅针对我们自己写入的 PID;pid 复用概率极低,并已用存活校验兜底。
   */
  private killStalePrevious(): void {
    try {
      const f = this.pidFilePath()
      if (!existsSync(f)) {
        return
      }
      const pid = parseInt(readFileSync(f, 'utf-8').trim(), 10)
      this.removePid()
      if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) {
        return
      }
      /** signal 0 仅探测存活;抛错说明进程已不存在。 */
      try {
        process.kill(pid, 0)
      } catch {
        return
      }
      try {
        process.kill(pid)
      } catch {
        /* 无权终止或已退出,忽略 */
      }
    } catch {
      /* 清理失败不阻塞启动 */
    }
  }

  /** 解析网关工作目录:受管工作区;若不可用则回退到用户主目录。 */
  private resolveCwd(): string {
    try {
      return getWorkspaceDir()
    } catch {
      return process.env.USERPROFILE || process.env.HOME || process.cwd()
    }
  }

  /**
   * spawn 前探针:校验工作目录与内核脚本存在。
   * @returns 错误提示字符串;一切正常返回 null。
   */
  private preSpawnProbe(launch: OpenClawLaunch, cwd: string): string | null {
    try {
      if (!statSync(cwd).isDirectory()) {
        return `工作区路径不是目录:${cwd}`
      }
    } catch {
      return `工作区路径不可用:${cwd}(请检查磁盘/权限)`
    }
    /** bundled / env(script) 分支的脚本路径应存在;PATH 分支交由 spawn 兜底。 */
    if (launch.source !== 'path' && launch.baseArgs[0] && !existsSync(launch.baseArgs[0])) {
      return `内核入口缺失:${launch.baseArgs[0]}`
    }
    return null
  }

  /**
   * 启动网关。已在运行(自己 spawn 的或已认领的)则幂等返回。
   *
   * 返回的是「启动中」的即时快照,不等就绪 —— 与改动前的语义一致,
   * 调用方(preflight)本来就是自己去等端口监听的。
   */
  start(): GatewayStatus {
    /** 认领来的网关没有 close 事件可听,只能在这里补一次存活校验,否则它死了我们也不会重开。 */
    if (this.adoptedPid !== null && !isAlive(this.adoptedPid)) {
      this.adoptedPid = null
      this.ready = false
    }
    if (this.child || this.adoptedPid !== null || this.startInFlight) {
      return this.status()
    }
    this.stoppedByUser = false
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.startInFlight = this.runStartFlow()
      .catch((err) => {
        this.lastMessage = `网关启动失败:${err instanceof Error ? err.message : String(err)}`
        this.emit('status', this.status())
      })
      .finally(() => {
        this.startInFlight = null
      })
    return this.status()
  }

  /**
   * 启动流程:先问「端口上已经有活网关了吗」,再决定认领还是清场重开。
   *
   * 顺序照搬 ClawX 的 `runGatewayStartupSequence`(先 findExistingGateway 再 spawn)。
   * 改动前是无条件 spawn,于是端口被占时每轮都必然失败;而失败的代价不只是白跑一趟,
   * 它会跟正在服务的那个网关抢 CPU 和配置锁。
   */
  private async runStartFlow(): Promise<void> {
    if (this.stoppedByUser) {
      return
    }
    /** 新一轮启动,上一轮的就绪结论作废;markReady 由本轮的探针重新给出。 */
    this.ready = false
    /**
     * 探活必须在清理之前。反过来先杀 pid 再探,有概率探到一个正在退出的网关并把它认领下来。
     * 而能握手的网关本就没有杀的理由 —— 上一轮遗留的那个进程也在正常服务(真机日志里
     * 我们的 RPC 一直是它在应答),打断它只会让正在进行的会话断流。
     */
    if (await probeGatewayReady(this.port)) {
      const pids = await listeningPids(this.port)
      this.adoptedPid = pids[0] ?? null
      this.markReady()
      /** 认领后改记它的 pid:应用崩溃来不及 stop() 时,下次启动仍能靠 pid 文件收掉它。 */
      if (this.adoptedPid !== null) {
        this.writePid(this.adoptedPid)
      }
      this.lastMessage = this.adoptedPid
        ? `复用已在运行的网关(pid ${this.adoptedPid})`
        : '复用已在运行的网关'
      this.emit('status', this.status())
      return
    }

    /** 端口上没有能握手的网关:清掉上次残留的 pid,再看端口还被谁占着。 */
    this.killStalePrevious()
    const holders = await listeningPids(this.port)
    if (holders.length > 0) {
      this.lastMessage = `端口 ${this.port} 被 pid ${holders.join('/')} 占用且不是可用网关,正在清理…`
      this.emit('status', this.status())
      await terminatePids(holders)
      if (!(await waitForPortFree(this.port))) {
        this.lastMessage = `端口 ${this.port} 仍被占用,无法启动网关。请手动结束占用该端口的进程。`
        this.emit('status', this.status())
        return
      }
    }

    if (this.stoppedByUser) {
      return
    }
    this.spawnGateway()
  }

  /** 真正 spawn 一个网关子进程。前置检查与端口清理由 runStartFlow 负责。 */
  private spawnGateway(): void {
    this.sawOutput = false
    this.ready = false

    const launch = resolveOpenClawLaunch()
    const cwd = this.resolveCwd()

    const probeError = this.preSpawnProbe(launch, cwd)
    if (probeError) {
      this.lastMessage = `网关启动前检查失败:${probeError}`
      this.emit('status', this.status())
      return
    }

    const finalArgs = finalizeArgs(launch, ['gateway', '--port', String(this.port)])
    const startedAt = Date.now()
    let child: ChildProcess
    try {
      child = spawn(launch.command, finalArgs, {
        shell: launch.useShell,
        cwd,
        env: {
          ...process.env,
          ...launch.env,
          /**
           * 放宽服务端握手窗口。只在这里注入、不进 launch.env:那份 env 每个 CLI 一次性调用
           * 也会带上,而这个值只对常驻网关这一侧有意义。缘由见 OPENCLAW_HANDSHAKE_TIMEOUT_MS。
           */
          OPENCLAW_HANDSHAKE_TIMEOUT_MS: String(OPENCLAW_HANDSHAKE_TIMEOUT_MS),
          /**
           * 关掉内核的会话库缓存。**不关的话每条会话的第二轮必挂**,报
           * `reply session initialization conflicted for <会话键>`,第三轮起又正常。
           *
           * 内核那道并发闸门比的是「整条会话条目的 JSON 快照」:初始化时用
           * `skipCache: true` 从磁盘读一份算 revision(`session-accessor.ts:1384`),
           * 提交时却走 writer 缓存(`store.ts:620-636`,只用 mtime + 文件大小判新旧)。
           * 第一轮收尾会往条目里补 endedAt / runtimeMs / systemPromptReport 这些字段,
           * 而这批写入在 Windows 上骗过了那两个判据 —— 于是磁盘已新、缓存仍旧,
           * 两次尝试都对不上 revision,直接抛错。内核自己在 `session.ts:404-407`
           * 承认了这个坑(原话:Windows 上 mtime 粒度可能漏掉快速写入),初始化那一侧
           * 因此选了 skipCache,提交那一侧没跟上。
           *
           * 2026-08-16 真机二分:同一条会话第二轮,带缓存必挂(6 次全挂,与思考档位、
           * sessions.patch、我们的插件都无关——逐项关掉都照挂);把这个值置 0 之后
           * 界面与 IPC 两条路径都通(7 → 11,两轮都带思考块)。
           *
           * 代价:会话库每次读都落磁盘。实测 1MB 的库解析在毫秒级,而 `sessions.patch`
           * 本来就要 230ms 上下,这点开销看不出来;换来的是多轮对话不再第二条就断。
           */
          OPENCLAW_SESSION_CACHE_TTL_MS: '0'
        },
        windowsHide: true
      })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      const hint = classifyError(e.code, e.message)
      this.lastMessage = `网关启动失败:${e.message}${hint ? ` — ${hint}` : ''}`
      this.emit('status', this.status())
      return
    }

    this.child = child
    this.lastMessage = `网关启动中…(内核来源:${launch.source})`
    if (child.pid) {
      this.writePid(child.pid)
    }

    /**
     * 本轮进程说过的话。close 时用它判断是不是端口冲突退出 ——
     * 这类退出重启多少次结果都一样,必须走清端口那条路,不能当崩溃重试。
     */
    let transcript = ''
    const onOutput = (chunk: Buffer): void => {
      this.sawOutput = true
      const text = stripAnsi(chunk.toString())
      transcript = (transcript + text).slice(-4000)
      if (isGatewayReadyOutput(text)) {
        this.markReady()
      }
      this.lastMessage = text.slice(-200)
      this.emit('status', this.status())
    }
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onOutput)
    child.on('error', (err) => {
      const e = err as NodeJS.ErrnoException
      const hint = classifyError(e.code, e.message)
      this.lastMessage = `启动失败:${e.message}${hint ? ` — ${hint}` : ''}`
      this.child = null
      this.emit('status', this.status())
    })
    child.on('close', (code) => {
      const uptime = Date.now() - startedAt
      this.child = null
      this.removePid()
      if (this.stoppedByUser) {
        this.lastMessage = `网关已退出(code ${code ?? 'null'})`
        this.emit('status', this.status())
      } else if (isPortConflictOutput(transcript)) {
        /** 端口被别人占着:重开必然同样失败,交回启动流程去认领或清场。 */
        this.recoverFromPortConflict()
      } else if (uptime < EARLY_EXIT_MS && !this.sawOutput) {
        /** 秒退且无输出:很可能启动即失败,重跑一次抓真实 stderr(不自动重启)。 */
        this.lastMessage = `网关秒退(code ${code ?? 'null'}, ${uptime}ms),正在采集诊断…`
        this.emit('status', this.status())
        this.diagnoseEarlyExit(launch, finalArgs, cwd)
      } else {
        /** 运行后异常退出:退避重启。 */
        this.scheduleRestart(code)
      }
    })

    this.emit('status', this.status())
    void this.awaitReady()
  }

  /**
   * spawn 之后用真实握手探针确认就绪。
   *
   * 就绪才是「这轮启动是健康的」的唯一证据,也才有资格把退避计数清零。
   * 探针本身很便宜(连上等一帧 connect.challenge 就断),失败不做任何动作 ——
   * 进程真死了会走 close,不需要探针来判死。
   */
  private async awaitReady(): Promise<void> {
    const child = this.child
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (this.child === child && this.child !== null && !this.ready && Date.now() < deadline) {
      if (await probeGatewayReady(this.port, READY_POLL_MS * 2)) {
        if (this.child === child) {
          this.markReady()
        }
        return
      }
      await new Promise((r) => setTimeout(r, READY_POLL_MS))
    }
  }

  /** 记一次「本轮真的起来了」:清空退避与端口自愈计数。 */
  private markReady(): void {
    if (this.ready) {
      return
    }
    this.ready = true
    this.restartAttempts = 0
    this.portRecoveries = 0
  }

  /**
   * 端口冲突后的自愈:退回启动流程,由它决定认领既有网关还是清掉占用者重开。
   *
   * 必须计次。改动前这条路径走的是无限重启,真机上连转了约 220 次。
   */
  private recoverFromPortConflict(): void {
    if (this.portRecoveries >= MAX_PORT_RECOVERIES) {
      this.lastMessage = `端口 ${this.port} 反复被占用,已停止自动重启。请手动结束占用该端口的进程后重试。`
      this.emit('status', this.status())
      return
    }
    this.portRecoveries += 1
    this.lastMessage = `端口 ${this.port} 被占用,正在接管既有网关…(第 ${this.portRecoveries} 次)`
    this.emit('status', this.status())
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.stoppedByUser && !this.child && !this.startInFlight) {
        this.startInFlight = this.runStartFlow()
          .catch(() => {
            /* 失败信息已写进 lastMessage */
          })
          .finally(() => {
            this.startInFlight = null
          })
      }
    }, RESTART_BASE_MS)
  }

  /**
   * 秒退二次诊断:用同样的命令/参数重跑一次(带 ELECTRON_ENABLE_LOGGING),
   * 捕获 stderr 并归类为可操作提示。仅用于诊断,不接管运行。
   */
  private diagnoseEarlyExit(launch: OpenClawLaunch, finalArgs: string[], cwd: string): void {
    execFile(
      launch.command,
      finalArgs,
      {
        shell: launch.useShell,
        cwd,
        env: { ...process.env, ...launch.env, ELECTRON_ENABLE_LOGGING: '1' },
        timeout: DIAG_TIMEOUT_MS,
        windowsHide: true
      },
      (err, stdout, stderr) => {
        const out = stripAnsi(`${stderr || ''}\n${stdout || ''}`).slice(-500)
        const e = err as NodeJS.ErrnoException | null
        const hint = classifyError(e?.code, stderr || stdout || '')
        this.lastMessage = hint
          ? `网关启动失败:${hint}${out ? `\n详情:${out}` : ''}`
          : `网关启动失败${out ? `:${out}` : '(无输出)'}`
        this.emit('status', this.status())
      }
    )
  }

  /**
   * 异常退出后的退避重启:指数退避,超过上限则停止并提示。
   *
   * 计数只在 markReady() 里归零,所以起不来的网关最多重试 MAX_RESTARTS 次就收手。
   */
  private scheduleRestart(code: number | null): void {
    if (this.restartAttempts >= MAX_RESTARTS) {
      this.lastMessage = `网关多次异常退出(code ${code ?? 'null'}),已停止自动重启,请检查内核`
      this.emit('status', this.status())
      return
    }
    const delayMs = Math.min(RESTART_BASE_MS * 2 ** this.restartAttempts, RESTART_MAX_MS)
    this.restartAttempts += 1
    this.lastMessage = `网关异常退出(code ${code ?? 'null'}),${Math.round(
      delayMs / 1000
    )}s 后自动重启(第 ${this.restartAttempts} 次)`
    this.emit('status', this.status())
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.stoppedByUser && !this.child) {
        this.start()
      }
    }, delayMs)
  }

  /** 停止网关。未运行时为无操作。 */
  stop(): GatewayStatus {
    this.stoppedByUser = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.restartAttempts = 0
    this.portRecoveries = 0
    this.ready = false
    if (this.child) {
      this.child.kill()
      this.child = null
      this.lastMessage = '网关已停止'
    }
    /**
     * 认领来的网关也要收掉。留着它就是下一次启动撞见的那个孤儿 ——
     * 这正是端口冲突循环的源头,不能只管自己 spawn 的那个。
     */
    if (this.adoptedPid !== null) {
      try {
        process.kill(this.adoptedPid)
      } catch {
        /* 已退出或无权终止 */
      }
      this.adoptedPid = null
      this.lastMessage = '网关已停止'
    }
    this.removePid()
    const status = this.status()
    this.emit('status', status)
    return status
  }

  /** 返回当前网关状态快照。 */
  status(): GatewayStatus {
    return {
      running: this.child !== null || this.adoptedPid !== null,
      port: this.port,
      pid: this.child?.pid ?? this.adoptedPid ?? undefined,
      message: this.lastMessage
    }
  }
}

/** 单例:整个主进程共享一个网关管理器。 */
export const openClawManager = new OpenClawManager()
