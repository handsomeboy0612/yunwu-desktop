import { spawn, execFile, ChildProcess } from 'child_process'
import { existsSync, statSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { EventEmitter } from 'events'
import { resolveOpenClawLaunch, finalizeArgs, type OpenClawLaunch } from './openclaw-cli'
import { getWorkspaceDir } from './workspace'
import { OPENCLAW_DEFAULT_PORT } from '@shared/types'
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
  /** 崩溃自动重启计数与定时器。 */
  private restartAttempts = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null

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

  /** 启动网关。若已在运行则直接返回当前状态(幂等)。 */
  start(): GatewayStatus {
    if (this.child) {
      return this.status()
    }
    this.stoppedByUser = false
    this.sawOutput = false
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    /** 启动前清理上次残留的网关进程,避免端口占用。 */
    this.killStalePrevious()

    const launch = resolveOpenClawLaunch()
    const cwd = this.resolveCwd()

    const probeError = this.preSpawnProbe(launch, cwd)
    if (probeError) {
      this.lastMessage = `网关启动前检查失败:${probeError}`
      const status = this.status()
      this.emit('status', status)
      return status
    }

    const finalArgs = finalizeArgs(launch, ['gateway', '--port', String(this.port)])
    const startedAt = Date.now()
    let child: ChildProcess
    try {
      child = spawn(launch.command, finalArgs, {
        shell: launch.useShell,
        cwd,
        env: { ...process.env, ...launch.env },
        windowsHide: true
      })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      const hint = classifyError(e.code, e.message)
      this.lastMessage = `网关启动失败:${e.message}${hint ? ` — ${hint}` : ''}`
      const status = this.status()
      this.emit('status', status)
      return status
    }

    this.child = child
    this.lastMessage = `网关启动中…(内核来源:${launch.source})`
    if (child.pid) {
      this.writePid(child.pid)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      this.sawOutput = true
      /** 已产生输出视为健康运行,重置崩溃重启计数。 */
      this.restartAttempts = 0
      this.lastMessage = stripAnsi(chunk.toString()).slice(-200)
      this.emit('status', this.status())
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.sawOutput = true
      this.lastMessage = stripAnsi(chunk.toString()).slice(-200)
      this.emit('status', this.status())
    })
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
      } else if (uptime < EARLY_EXIT_MS && !this.sawOutput) {
        /** 秒退且无输出:很可能启动即失败,重跑一次抓真实 stderr(不自动重启)。 */
        this.lastMessage = `网关秒退(code ${code ?? 'null'}, ${uptime}ms),正在采集诊断…`
        this.emit('status', this.status())
        this.diagnoseEarlyExit(launch, finalArgs, cwd)
      } else {
        /** 健康运行后异常退出:退避重启。 */
        this.scheduleRestart(code)
      }
    })

    const status = this.status()
    this.emit('status', status)
    return status
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
   * 健康运行后崩溃的退避重启:指数退避,超过上限则停止并提示。
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
    if (this.child) {
      this.child.kill()
      this.child = null
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
      running: this.child !== null,
      port: this.port,
      pid: this.child?.pid,
      message: this.lastMessage
    }
  }
}

/** 单例:整个主进程共享一个网关管理器。 */
export const openClawManager = new OpenClawManager()
