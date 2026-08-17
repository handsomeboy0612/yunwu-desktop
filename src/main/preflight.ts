import { EventEmitter } from 'events'
import net from 'net'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { OPENCLAW_DEFAULT_PORT, OPENCLAW_HANDSHAKE_TIMEOUT_MS } from '@shared/types'
import type {
  PreflightMode,
  PreflightReport,
  PreflightStep,
  PreflightStepId
} from '@shared/types'
import { resolveOpenClawLaunch, runOpenClaw } from './openclaw-cli'
import { openClawManager } from './openclaw-manager'
import { gatewayClient } from './gateway-client'
import { writeOpenClawConfig } from './config-writer'
import { loadActivation } from './store'

/** 各步硬超时(毫秒)。 */
const TIMEOUT = {
  version: 5000,
  gatewayListen: 15000,
  /**
   * 必须**大于** gateway-client 的 CONNECT_TIMEOUT_MS,否则总是这层先超时,传输层那条更具体的
   * 错误(以及它为「网关启动中」做的重连自愈)全被吃掉。所以这里跟着那个常量走,别再写死数字 ——
   * 写死过两次,两次都因为传输层调宽了而重新变成「这层先红」。
   *
   * 冷启动会红是必然、不是偶发:网关端口先监听、后就绪,而 spawn 到 `gateway ready` 实测
   * 18~20 秒,其后还有约 50 秒忙碌期,期间握手排不上处理。根因与量级见
   * OPENCLAW_HANDSHAKE_TIMEOUT_MS 的注释。
   */
  gatewayConnect: OPENCLAW_HANDSHAKE_TIMEOUT_MS + 30000,
  rpcHealth: 8000
}

/** 步骤静态定义(顺序即执行顺序)。 */
const STEP_DEFS: Array<Pick<PreflightStep, 'id' | 'label' | 'level'>> = [
  { id: 'locate-kernel', label: '定位内核', level: 'fatal' },
  { id: 'kernel-version', label: '校验内核版本', level: 'fatal' },
  { id: 'config-ready', label: '检查配置', level: 'recoverable' },
  { id: 'gateway-listen', label: '启动网关', level: 'fatal' },
  { id: 'gateway-connect', label: '连接网关', level: 'fatal' },
  { id: 'rpc-health', label: '网关探活', level: 'fatal' }
]

/** light 模式只跑连通相关步骤(新建任务快速校验)。 */
const LIGHT_STEPS: PreflightStepId[] = ['gateway-connect', 'rpc-health']

/** 给 Promise 加超时;超时以 label 作为错误信息 reject(底层任务可能仍在后台)。 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label)), ms))
  ])
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 单次 TCP 连接探测:端口可连接则视为已监听。 */
function probePort(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' })
    let settled = false
    const done = (result: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      sock.destroy()
      resolve(result)
    }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    setTimeout(() => done(false), timeoutMs)
  })
}

/** 轮询等待端口进入监听,直到超时。 */
async function waitPortListen(port: number, totalMs: number): Promise<boolean> {
  const deadline = Date.now() + totalMs
  while (Date.now() < deadline) {
    if (await probePort(port)) {
      return true
    }
    await delay(500)
  }
  return false
}

/** 校验本地 openclaw.json 是否含必要项。 */
function inspectConfig(): { ok: boolean; error?: string } {
  const cfgPath = join(homedir(), '.openclaw', 'openclaw.json')
  if (!existsSync(cfgPath)) {
    return { ok: false, error: 'openclaw.json 不存在' }
  }
  try {
    const j = JSON.parse(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>
    const gateway = (j.gateway ?? {}) as Record<string, unknown>
    const auth = (gateway.auth ?? {}) as Record<string, unknown>
    const models = (j.models ?? {}) as Record<string, unknown>
    const providers = (models.providers ?? {}) as Record<string, unknown>
    const agents = (j.agents ?? {}) as Record<string, unknown>
    const defaults = (agents.defaults ?? {}) as Record<string, unknown>
    const model = (defaults.model ?? {}) as Record<string, unknown>

    const authNone = auth.mode === 'none'
    const hasProvider = Object.keys(providers).length > 0
    const hasPrimary = typeof model.primary === 'string' && !!model.primary
    if (authNone && hasProvider && hasPrimary) {
      return { ok: true }
    }
    return { ok: false, error: '配置缺少必要项(gateway.auth.mode / provider / model.primary)' }
  } catch {
    return { ok: false, error: 'openclaw.json 解析失败(可能损坏)' }
  }
}

/**
 * 内核自检编排器(单例)。
 *
 * 每步执行前置 running、结束置 ok/warn/fail 并 emit('step', report)。
 * fatal 步失败即停止后续;recoverable(config)失败先尝试用已存激活配置自愈重试一次。
 * 每步硬超时,绝不无限等待(根治"一直思考")。
 */
class Preflight extends EventEmitter {
  private steps: PreflightStep[] = []
  private startedAt = 0

  private report(running: boolean, ok: boolean): PreflightReport {
    return {
      ok,
      running,
      steps: this.steps.map((s) => ({ ...s })),
      startedAt: this.startedAt,
      endedAt: running ? undefined : Date.now()
    }
  }

  private emitStep(running: boolean, ok: boolean): void {
    this.emit('step', this.report(running, ok))
  }

  private patch(id: PreflightStepId, patch: Partial<PreflightStep>): void {
    const s = this.steps.find((x) => x.id === id)
    if (s) {
      Object.assign(s, patch)
    }
  }

  /** 执行一步:包裹计时、running/结果状态与 emit。 */
  private async runStep(
    id: PreflightStepId,
    fn: () => Promise<{ status: 'ok' | 'warn'; hint?: string } | { fail: string; hint?: string }>
  ): Promise<boolean> {
    const start = Date.now()
    this.patch(id, { status: 'running', error: undefined, hint: undefined })
    this.emitStep(true, false)
    try {
      const r = await fn()
      const elapsedMs = Date.now() - start
      if ('fail' in r) {
        this.patch(id, { status: 'fail', elapsedMs, error: r.fail, hint: r.hint })
        this.emitStep(true, false)
        return false
      }
      this.patch(id, { status: r.status, elapsedMs, hint: r.hint })
      this.emitStep(true, false)
      return true
    } catch (e) {
      this.patch(id, { status: 'fail', elapsedMs: Date.now() - start, error: errMsg(e) })
      this.emitStep(true, false)
      return false
    }
  }

  /** 运行自检。full = 完整链;light = 仅连通/RPC。 */
  async run(mode: PreflightMode = 'full'): Promise<PreflightReport> {
    const active = mode === 'light' ? LIGHT_STEPS : STEP_DEFS.map((d) => d.id)
    this.startedAt = Date.now()
    this.steps = STEP_DEFS.filter((d) => active.includes(d.id)).map((d) => ({
      ...d,
      status: 'pending'
    }))
    this.emitStep(true, false)

    for (const def of this.steps) {
      const okStep = await this.execute(def.id)
      if (!okStep && def.level === 'fatal') {
        return this.finish(false)
      }
    }
    const allOk = this.steps.every((s) => s.status === 'ok' || s.status === 'warn')
    return this.finish(allOk)
  }

  private finish(ok: boolean): PreflightReport {
    const rep = this.report(false, ok)
    this.emit('step', rep)
    return rep
  }

  /** 分发单步实现。 */
  private async execute(id: PreflightStepId): Promise<boolean> {
    switch (id) {
      case 'locate-kernel':
        return this.runStep(id, async () => {
          const launch = resolveOpenClawLaunch()
          return {
            status: launch.source === 'path' ? 'warn' : 'ok',
            hint:
              launch.source === 'path'
                ? '使用 PATH 全局 openclaw(开发态);发布态应使用内置内核'
                : `内核来源:${launch.source}`
          }
        })

      case 'kernel-version':
        return this.runStep(id, async () => {
          try {
            const out = await withTimeout(
              runOpenClaw(['--version']),
              TIMEOUT.version,
              '内核版本检查超时'
            )
            const version = out.trim().split(/\r?\n/).pop() || out.trim()
            return { status: 'ok', hint: `版本 ${version}` }
          } catch (e) {
            return {
              fail: errMsg(e),
              hint: '内核无法执行:可能缺失、被安全软件拦截或运行时不兼容'
            }
          }
        })

      case 'config-ready':
        return this.runStep(id, async () => {
          let res = inspectConfig()
          if (!res.ok) {
            /** 自愈:若已激活,用保存的配置重写一次再校验。 */
            const activation = loadActivation()
            if (activation) {
              try {
                await writeOpenClawConfig(activation)
                res = inspectConfig()
              } catch (e) {
                return { fail: `配置自愈失败:${errMsg(e)}`, hint: '请尝试重新激活' }
              }
            }
          }
          return res.ok
            ? { status: 'ok' }
            : { fail: res.error ?? '配置不可用', hint: '请重新激活以写入本地配置' }
        })

      case 'gateway-listen':
        return this.runStep(id, async () => {
          openClawManager.start()
          const listening = await waitPortListen(OPENCLAW_DEFAULT_PORT, TIMEOUT.gatewayListen)
          if (listening) {
            return { status: 'ok', hint: `端口 ${OPENCLAW_DEFAULT_PORT} 已监听` }
          }
          const status = openClawManager.status()
          return {
            fail: status.message || '网关未在预期时间内监听端口',
            hint: '查看内核日志或重试'
          }
        })

      case 'gateway-connect':
        return this.runStep(id, async () => {
          try {
            await withTimeout(gatewayClient.ensureConnected(), TIMEOUT.gatewayConnect, '连接网关超时')
            return { status: 'ok' }
          } catch (e) {
            return { fail: errMsg(e), hint: '无法连接本地网关,请重试' }
          }
        })

      case 'rpc-health':
        return this.runStep(id, async () => {
          try {
            await gatewayClient.request('health', {}, { timeoutMs: TIMEOUT.rpcHealth })
            return { status: 'ok' }
          } catch (e) {
            return { fail: errMsg(e), hint: '网关无响应,请重试' }
          }
        })

      default:
        return true
    }
  }
}

/** 单例:整个主进程共享一个自检编排器。 */
export const preflight = new Preflight()
