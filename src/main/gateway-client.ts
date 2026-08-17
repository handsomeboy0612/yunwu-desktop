import { EventEmitter } from 'events'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import WebSocket, { type RawData } from 'ws'
import { OPENCLAW_DEFAULT_PORT, OPENCLAW_HANDSHAKE_TIMEOUT_MS } from '@shared/types'
import type { AgentEvent, AgentSendResult, ExecOutcome } from '@shared/types'
import {
  editDiffFromDetails,
  execOutcomeFromDetails,
  execOutputFromDetails,
  toolLabel,
  toolStepTitle
} from '@shared/tool-step'
import {
  loadOrCreateDeviceIdentity,
  resetDeviceIdentity,
  signDevicePayload,
  publicKeyRawBase64UrlFromPem,
  buildDeviceAuthPayloadV3
} from './device-identity'
import { openclawConfigFile } from './workspace'

/**
 * 本地 OpenClaw 网关 WebSocket 客户端(单条常驻长连接)。
 *
 * 职责:
 *  - 与 `ws://127.0.0.1:<port>` 建立连接,完成 connect.challenge → 设备签名 → connect 握手;
 *  - 以 req/res(按 id 关联)方式调用网关 RPC 方法(如 health / chat.send);
 *  - 把服务端推送的 event 帧(chat 流式增量 / session.tool 等)通过 'event' 事件转发,
 *    供上层实现 WorkBuddy 式的逐字流式与工具步骤(里程碑 2/3)。
 *
 * 鉴权路线 A:ed25519 设备身份 + 回环自动配对,配合 gateway.auth.mode=none(见 config-writer)。
 */

/**
 * 网关客户端固定身份:模仿官方 CLI。回环 + 设备签名下,内核按官方 CLI 默认
 * (CLI_DEFAULT_OPERATOR_SCOPES,含 admin)授予 scope。
 *
 * 必须申领 operator.admin:sessions.patch(按对话覆盖模型 / 深度思考档位)在内核里被归为
 * admin-only 方法(实测:仅 read/write 会报 "missing scope: operator.admin",带 admin 后放行)。
 * 而 chat.send 不接受 model 参数,故"按对话切模型"只能经 sessions.patch —— admin 是根因所需。
 * 本地内核由桌面端自身拉起并独占,持有 admin 与官方 CLI 一致,非过度授权。
 */
const CLIENT_ID = 'cli'
const CLIENT_MODE = 'cli'
const ROLE = 'operator'
const SCOPES = ['operator.read', 'operator.write', 'operator.admin']

/**
 * 内核派子会话(sessions_spawn / 专家团成员)时,子会话运行时会以**内核自己那份设备身份**
 * (`~/.openclaw/identity/device.json`,与我们 userData 下的身份是两份)连回本机网关,
 * 报的客户端身份固定是 gateway-client/backend。
 */
const KERNEL_BACKEND_CLIENT_ID = 'gateway-client'
const KERNEL_BACKEND_CLIENT_MODE = 'backend'

/** 读内核设备身份的 deviceId;读不到就放弃自动审批(宁可不批,不能批错设备)。 */
function readKernelDeviceId(): string | null {
  try {
    const raw = readFileSync(join(homedir(), '.openclaw', 'identity', 'device.json'), 'utf-8')
    const id = (JSON.parse(raw) as { deviceId?: unknown }).deviceId
    return typeof id === 'string' && id.trim() ? id.trim() : null
  } catch {
    return null
  }
}

/** device.pair.list 返回的待审批项(只声明我们据以判定的字段)。 */
interface PendingDevicePairing {
  requestId?: unknown
  deviceId?: unknown
  clientId?: unknown
  clientMode?: unknown
  role?: unknown
  roles?: unknown
  scopes?: unknown
}

/** 单次 RPC 默认超时(与官方客户端一致)。 */
const REQUEST_TIMEOUT_MS = 30000
/**
 * 改配置 / agent 生命周期的写操作统一放宽超时。
 *
 * 默认 30s 是照官方客户端取的，但那个数只覆盖得住空闲网关。网关启动后有一段很长的繁忙期
 * (技能里记的「报了 ready 之后仍有约 50 秒是忙的」)，实测同一台机器上的一次真实撞车
 * (%TEMP%/openclaw/openclaw-2026-08-05.log)：
 *   `[ws] res agents.create 74380ms` / `[ws] res config.patch 45440ms` / `[ws] res agents.delete 31390ms`
 * 三个都超过 30s。超时**不等于**网关不可达 —— 请求还在网关里跑着，此时退回 CLI 就是给同一份
 * 配置放了第二个写者，正是 `ConfigMutationConflictError: config changed since last load` 的来源。
 *
 * 放宽是安全的：连接真断了会走 handleClose → rejectAllPending 立刻失败，不用等这个超时。
 * 也就是说这个数只用来兜「连着但很慢」，不是用来探活的。
 */
const MUTATION_TIMEOUT_MS = 120000
/**
 * 建立连接(直到 hello-ok)的整体超时。
 *
 * 必须**大于**服务端握手窗口 OPENCLAW_HANDSHAKE_TIMEOUT_MS。网关忙碌期会把我们的 connect 帧
 * 一直压在队列里不处理(它没断线、也没回错,就是排不上),这段时间的上限由服务端那个窗口定;
 * 客户端比它先放弃,就等于把一次本会成功的握手判死。原值 30 秒恰恰卡在这个坑里 —— 服务端
 * 实测能压到 50 秒开外。
 *
 * 代价说清楚:网关真卡死时,ensureConnected 要等满这个数才报错(以前是 30 秒)。可以接受,
 * 因为内核自家客户端压根没有建连截止、只是无限退避重连,ClawX 那边等的是 600 秒;而进程真死了
 * 会走 socket close,不靠这个超时来判。
 */
const CONNECT_TIMEOUT_MS = OPENCLAW_HANDSHAKE_TIMEOUT_MS + 10000
/** 重连退避:初始与上限。初始值偏小以便快速覆盖网关启动就绪窗口。 */
const INITIAL_BACKOFF_MS = 600
const MAX_BACKOFF_MS = 30000

/** 配置写入的乐观并发失败特征:取到哈希后配置又被改过,重取哈希可再试。 */
const CONFIG_STALE = /config changed since last load/i

/**
 * 内核 errorShape 的「现在不行,回头再来」类错误码,与 INVALID_REQUEST(你的请求不对)相对。
 * 实测会落到这个码的至少有:
 *  - 控制面写入限流。内核给 `controlPlaneWrite` 类方法(config.patch / config.apply /
 *    update.run / gateway.restart.request)按设备限了 **3 次 / 60 秒**,且这几个方法共用
 *    同一个桶(我们这版 2026.6.11 的预算 key 只有 deviceId|clientIp)。我们的配置写入已改走
 *    不在名单里的 `config.set`(实测连发 6 次无一被拒),agents.create / update / delete 本就
 *    不在名单里,所以这条如今只可能来自 `gateway.restart.request`。
 *  - `gateway starting; retry shortly`:网关 sidecar 还没起完,握手阶段就被拒。
 * 这两种都不是「内核对这次操作的答复」,退回 CLI 比抛给用户合适。
 */
const UNAVAILABLE = 'UNAVAILABLE'

/**
 * 「结果未知」(超时 / 在途断连)时经网关重试的次数与间隔。
 * 只重试,不换路 —— 换路就是第二个写者,见 viaGatewayOrCli 的说明。
 */
const UNKNOWN_RESULT_RETRIES = 2
const UNKNOWN_RESULT_RETRY_DELAY_MS = 1500

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 网关错误帧结构。 */
export interface GatewayError {
  code?: string
  message?: string
  details?: unknown
  retryable?: boolean
  /** 服务端给的重试建议延迟(毫秒)。仅可重试错误带。 */
  retryAfterMs?: number
}

/**
 * 网关启动未完成时的「可重试拒绝」判据与退避,照抄内核
 * `packages/gateway-protocol/src/startup-unavailable.ts`(它自家客户端与控制台 UI 共用这一份)。
 *
 * 为什么必须原样对齐:网关在 startup sidecars 就绪之前会**主动拒绝 connect 握手**
 * (`server/ws-connection/message-handler.ts` 的 `isStartupPending()` 分支,回
 * UNAVAILABLE + retryable + `details.reason='startup-sidecars'`,随即以 1013 关闭连接)。
 * 这不是「慢」,调大超时永远等不到——必须按它给的延迟重连。
 */
const GATEWAY_STARTUP_UNAVAILABLE_REASON = 'startup-sidecars'
const GATEWAY_STARTUP_RETRY_AFTER_MS = 500
const GATEWAY_STARTUP_RETRY_MIN_MS = 100
const GATEWAY_STARTUP_RETRY_MAX_MS = 2000
/**
 * 「网关启动中」这类等待的总封顶。冷启动实测约 40 秒(20 秒到 ready + 约 20 秒忙碌期),
 * 留足余量但仍会失败,免得网关卡死时无声地等下去。
 *
 * 要比 CONNECT_TIMEOUT_MS 宽:这里管的是「被拒了多少轮」的累计时长,窄于单轮建连预算的话,
 * 封顶会先于建连超时触发,那条重连自愈就白写了。
 */
const MAX_STARTUP_WAIT_MS = CONNECT_TIMEOUT_MS + 60000

/** 是否为「网关正在启动,稍后重试」那条结构化错误。 */
function isRetryableGatewayStartupUnavailable(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false
  }
  const e = err as { code?: unknown; retryable?: unknown; details?: unknown }
  const details = e.details as { reason?: unknown } | null | undefined
  return (
    e.code === 'UNAVAILABLE' &&
    e.retryable === true &&
    typeof details === 'object' &&
    details !== null &&
    details.reason === GATEWAY_STARTUP_UNAVAILABLE_REASON
  )
}

/** 从该错误解析有界重试延迟;不是这条错误则返回 null。 */
function resolveGatewayStartupRetryAfterMs(err: unknown): number | null {
  if (!isRetryableGatewayStartupUnavailable(err)) {
    return null
  }
  const raw = (err as { retryAfterMs?: unknown }).retryAfterMs
  const ms = typeof raw === 'number' && Number.isFinite(raw) ? raw : GATEWAY_STARTUP_RETRY_AFTER_MS
  return Math.min(Math.max(Math.floor(ms), GATEWAY_STARTUP_RETRY_MIN_MS), GATEWAY_STARTUP_RETRY_MAX_MS)
}

/**
 * `chat.history` 返回的一条消息。
 *
 * `content` 是分块数组(`{type:'text'|'thinking'|…}`),不是字符串——取正文要挑 `text` 块,
 * 把 `thinking` 也拼进去会把模型的内心戏当成产出发出去。
 */
export interface ChatHistoryMessage {
  role?: string
  content?: unknown
}

/**
 * `agent.wait` 的回执(内核 `server-methods/agent.ts:2950-2962` 的字段,只列我们用到的)。
 * `timeoutPhase` 在 `status === 'timeout'` 时分辨「还活着」(`gateway_draining`)与
 * 「压根没登记在跑」(`queue`)。
 */
export interface AgentRunWaitResult {
  runId?: string
  status?: 'ok' | 'error' | 'timeout'
  error?: string
  stopReason?: string
  timeoutPhase?: string
  providerStarted?: boolean
}

/** 服务端事件帧(转发给上层用于流式渲染)。 */
export interface GatewayEventFrame {
  type: 'event'
  event: string
  payload?: unknown
  seq?: number
}

interface ResFrame {
  type: 'res'
  id: string
  ok: boolean
  payload?: unknown
  error?: GatewayError
}

/** 内核回传快照时给敏感叶子打的哨兵(内核 `src/config/redact-snapshot.ts`)。 */
const REDACTED_SENTINEL = '__OPENCLAW_REDACTED__'

/**
 * 把 config.get 回传的脱敏叶子按磁盘源文件还原成真值,并顺带深拷贝。
 *
 * config.get 的六种形态**全都脱敏**(实测 raw / parsed / sourceConfig / resolved /
 * runtimeConfig / config 无一例外),本机命中三处:两个供货商的 apiKey 与 gateway.auth.token。
 *
 * 不还原也能写成——内核 `restoreRedactedValues` 会照它自己的磁盘快照补回去。必须还原是因为
 * **客户端的 noop 比对会失准**:我们每次渲染都带着真 Key,与哨兵永远不相等,于是每次启动
 * 都白落一次盘、白顶一轮网关热加载,而那正是启动期最忙、最不该被打扰的窗口。
 *
 * 读不到磁盘就原样返回:代价只是多写一次盘,比猜一个值安全。
 */
function restoreRedactedSecrets(config: Record<string, unknown>): Record<string, unknown> {
  let disk: unknown
  try {
    disk = JSON.parse(readFileSync(openclawConfigFile(), 'utf-8'))
  } catch {
    return structuredClone(config)
  }
  const walk = (node: unknown, source: unknown): unknown => {
    if (node === REDACTED_SENTINEL) {
      return typeof source === 'string' ? source : node
    }
    if (Array.isArray(node)) {
      const src = Array.isArray(source) ? source : []
      return node.map((item, i) => walk(item, src[i]))
    }
    if (node && typeof node === 'object') {
      const src = source && typeof source === 'object' ? (source as Record<string, unknown>) : {}
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        out[key] = walk(value, src[key])
      }
      return out
    }
    return node
  }
  return walk(config, disk) as Record<string, unknown>
}

interface PendingRequest {
  resolve: (payload: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * RPC 等待超时。单独立一个类型,让调用方能按类型而非文案区分「网关没答复」与「网关答复了不行」——
 * 超时是**结果未知**(请求很可能还在网关里跑),不能当成传输失败去走另一条写入路径。
 */
export class GatewayTimeoutError extends Error {
  readonly method: string

  constructor(method: string, timeoutMs: number) {
    super(`调用 ${method} 超时(${timeoutMs}ms 未返回)`)
    this.name = 'GatewayTimeoutError'
    this.method = method
  }
}

/**
 * 连接在请求在途时断开。与超时同属**结果未知**:内核很可能已经把这次写入做完了。
 *
 * 实测过一次:`config.patch` 在途时连接以 close 1000 断开,我们判失败退回 CLI,
 * 而网关那条请求 70.5 秒后 `res ✓` —— 写入其实是成功的,CLI 只是去当了第二个写者。
 */
export class GatewayClosedError extends Error {
  readonly code: number

  constructor(code: number, reason: string) {
    super(`网关连接已断开(code ${code}${reason ? `: ${reason}` : ''})`)
    this.name = 'GatewayClosedError'
    this.code = code
  }
}

/** RPC 失败时抛出的错误,携带网关返回的结构化 code/details。 */
export class GatewayRequestError extends Error {
  readonly code?: string
  readonly details?: unknown
  /** 原样保留:内核判定「可重试」的判据要 code + retryable + details 三者齐全。 */
  readonly retryable?: boolean
  readonly retryAfterMs?: number

  constructor(err: GatewayError) {
    super(err.message ?? err.code ?? 'gateway request failed')
    this.name = 'GatewayRequestError'
    this.code = err.code
    this.details = err.details
    this.retryable = err.retryable
    this.retryAfterMs = err.retryAfterMs
  }
}

class GatewayClient extends EventEmitter {
  private ws: WebSocket | null = null
  private readonly url = `ws://127.0.0.1:${OPENCLAW_DEFAULT_PORT}`
  private idSeq = 0
  private readonly pending = new Map<string, PendingRequest>()

  private connected = false
  private closedByUser = false
  private backoffMs = INITIAL_BACKOFF_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** 下一次重连要用的「网关启动中」延迟;非 null 时压过指数退避,用完即清。 */
  private startupReconnectDelayMs: number | null = null

  /**
   * 本轮建连是否已尝试过「轮换设备身份重新配对」的自愈动作。
   * 防止自愈失败时无限轮换身份;hello-ok 成功后复位,允许后续再次自愈。
   */
  private repairAttempted = false

  /** 进行中的配对对账;避免建连与事件同时触发时重复拉表。 */
  private pairingReconcile: Promise<void> | null = null

  /** 已订阅的会话 key 集合;重连后自动重新订阅,保证事件不丢。 */
  private readonly subscribedKeys = new Set<string>()

  /**
   * 每个会话最近一次成功下发的 sessions.patch 内容(用于跳过重复下发)。
   * 与 configSnapshot 同理:断线期间会话可能被别的写者改过,故重连时一并作废。
   */
  private readonly sessionPatchCache = new Map<string, string>()

  /**
   * 缓存的配置快照(哈希 + 配置本体),来自最近一次 config.get。
   *
   * 为什么要缓存:配置写入强制带 baseHash 做乐观并发校验,而取它的 config.get 实测
   * 要 0.9~1.8 秒——内核把整份配置以 raw / parsed / sourceConfig / resolved / runtimeConfig /
   * config 六种形态一起返回(实测 79KB),我们只用其中一个 hash 和一份配置。每次写前都拉
   * 一遍,等于给每次「保存供货商」凭空加了一整个往返(占总耗时的三分之二)。
   *
   * 内核自己的控制台就是这么做的:把快照哈希记在 `configDraftBaseHash`,写入时直接用,
   * 只在加载时和写入**之后**才 config.get。照做即可。哈希被别人写旧了会得到
   * "config changed since last load",下面既有的重取重试一次就能自愈。
   *
   * 取的是六种形态里的 `resolved`,不是 `config`:内核类型定义写着
   * *Use this for config set/unset operations to avoid leaking runtime defaults into the
   * written config file*,而 `config` 那份还标着 `@deprecated Prefer runtimeConfig`。
   * 差别不只在「会不会漏默认值」——`config` 是运行态形态(比源文件多出约 11KB 内核默认值),
   * 拿它当比对基准会让我们的声明式渲染永远判成「有差异」,于是每次保存供货商、每次启动
   * 都白落一次盘。实测撞过:两笔写入的 reload 日志里改动路径只有 `meta.lastTouchedAt`。
   *
   * 哈希与配置必须同源:重试时要拿新快照重跑 mutate,拿另一份配置去算就会算错。
   * 故两者一起缓存、一起作废。
   */
  private configSnapshot: { hash: string; config: Record<string, unknown> } | null = null
  /** 进行中的 config.get;避免并发写入各拉一份。 */
  private configSnapshotPromise: Promise<{
    hash: string
    config: Record<string, unknown>
  }> | null = null

  /** 建连(直到 hello-ok)的进行中 Promise;避免并发重复连接。 */
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((err: Error) => void) | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  /** 本次建连里第一次看到「网关启动中」的时刻;用于给这类等待单独封顶。 */
  private startupWaitStartedAt: number | null = null

  /** 当前是否已握手完成。供调用方判断「值不值得等建连」(见 viaGatewayOrCli)。 */
  get isConnected(): boolean {
    return this.connected
  }

  /** 确保已连接并完成鉴权;已连接则立即返回。 */
  ensureConnected(): Promise<void> {
    if (this.connected) {
      return Promise.resolve()
    }
    if (this.readyPromise) {
      return this.readyPromise
    }
    this.closedByUser = false
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
      this.connectTimer = setTimeout(() => {
        this.failReady(new Error('连接网关超时(hello-ok 未在预期时间内返回)'))
      }, CONNECT_TIMEOUT_MS)
    })
    this.openSocket()
    return this.readyPromise
  }

  /** 调用一个网关 RPC 方法。会先确保连接就绪。 */
  async request<T = unknown>(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number }
  ): Promise<T> {
    await this.ensureConnected()
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('网关连接不可用')
    }
    const id = `req-${++this.idSeq}`
    const timeoutMs = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new GatewayTimeoutError(method, timeoutMs))
        }
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (payload) => resolve(payload as T),
        reject,
        timer
      })
      ws.send(JSON.stringify({ type: 'req', id, method, params: params ?? {} }))
    })
  }

  /** 订阅某会话的消息/事件(幂等);记录以便重连后重新订阅。 */
  async subscribeSession(key: string): Promise<void> {
    this.subscribedKeys.add(key)
    await this.request('sessions.messages.subscribe', { key })
  }

  /**
   * 向会话发送一条用户消息,触发一轮 agent 运行。返回 runId。
   * opts.thinking:本轮推理档位(off/minimal/low/medium/high/…),内核会依模型能力自动收敛;
   * 非推理模型传高档位也会被安全降级为 off,故可放心传。
   */
  async chatSend(
    sessionKey: string,
    message: string,
    opts?: { thinking?: string }
  ): Promise<AgentSendResult> {
    // 先确保已订阅该会话,避免错过运行开始瞬间的流式事件。
    if (!this.subscribedKeys.has(sessionKey)) {
      await this.subscribeSession(sessionKey)
    }
    const res = await this.request<AgentSendResult>('chat.send', {
      sessionKey,
      message,
      idempotencyKey: randomUUID(),
      ...(opts?.thinking ? { thinking: opts.thinking } : {})
    })
    return res
  }

  /**
   * 问「这一轮到底怎么了」。`agent.wait` 是内核为此准备的方法,不是我们自己造的轮询。
   *
   * 返回值三态(`openclaw/src/gateway/server-methods/agent.ts:2832-2963`):
   *  - `ok` / `error`:终态。终态快照来自网关内存里的 dedupe 记账(`chat:<runId>`,
   *    5 分钟 TTL,`server-constants.ts:26`),**派发阶段失败也写在这里**
   *    (`server-methods/chat.ts:4992-5005` 的 `.catch`)。
   *  - `timeout`:超时内没有终态。`timeoutPhase` 分得清两种情形(`agent.ts:2940-2947`):
   *    `gateway_draining` = 这一轮还挂在 `chatAbortControllers` 里(活着),
   *    `queue` + `providerStarted:false` = 压根没有登记在跑的 run。
   *
   * 真机实测(2026-08-13):健康轮 25 秒未答完时回 `timeout/gateway_draining`;
   * 同一个 idempotencyKey 原样重发回 `in_flight`(内核回放缓存,不会再起一轮,`chat.ts:3351-3357`)。
   */
  async waitRun(runId: string, timeoutMs = 8000): Promise<AgentRunWaitResult> {
    return await this.request<AgentRunWaitResult>(
      'agent.wait',
      { runId, timeoutMs },
      // 网关那侧最多等 timeoutMs,客户端要留出余量,否则先在这边超时、白当成失败。
      { timeoutMs: timeoutMs + 10_000 }
    )
  }

  /**
   * 投一条服务端自己发起的消息,并确认内核**真的起了一轮**;确认失败就重投一次。
   *
   * # 为什么需要它:`chat.send` 的 ack 不等于送到
   *
   * 内核在**派发之前**就 ack(`chat.ts:3612` 的 `respond(true, ackPayload, …)` 在
   * `dispatch` 之前),所以 `chatSend` 正常 resolve 只代表「收下了」。派发阶段抛错走
   * `chat.ts:4968-5012` 的 `.catch`:它把用户消息补进抄本、写一条 `status:'error'` 的
   * dedupe 记账、广播一条 `chat`/`state:'error'` —— 但**调用方这侧一无所知**。
   *
   * 2026-08-13 真机抓到一次:媒体补投拿到 ack、日志照打「已补投」,而那一轮压根没起来
   * (`reply session initialization conflicted`,会话库乐观并发冲突,内核只重试一次就抛,
   * `auto-reply/reply/session.ts:859-863`)。结果是图出在磁盘上、对话里一句话都没有。
   * 当天 5 条补投里丢了 1 条。
   *
   * # 判据取内核的终态,不看文案
   *
   * `agent.wait` 回 `error` 就是这一轮以失败收场 —— 派发失败与运行内失败都在这一档。
   * 两者都值得重投:前者模型根本没看到消息;后者模型看到了但这一轮废了,而我们投的都是
   * 「产物已就绪,请交给用户」这类幂等消息(信封里明写不要再调工具),重投的代价可控。
   *
   * 重投用**新的** idempotencyKey(chatSend 每次自己生成):同 key 重发只会拿回缓存里那条
   * 错误、不会起新一轮(实测回 `in_flight` / 缓存态,`chat.ts:3351-3357`)。
   * 代价是抄本里多一条信封 user 记录 —— 它在历史还原里本来就是隐藏的
   * (`@shared/relay-envelope`),用户看不见。
   *
   * # 退避不是保险,是必需的:立刻重投必然撞同一堵墙(2026-08-13 实测)
   *
   * 那个冲突是**乐观锁的输家**:提交前后比的是整条 session entry 的 `JSON.stringify`
   * (`config/sessions/session-accessor.ts:975-977`),所以那一刻只要有别的写者动过这条会话,
   * 我们就必输。而我们恰恰在最热的时刻投 —— 内核自己那条注定失败的唤醒就在同一两秒里
   * (真机:22:04:38 内核 wake failed → 22:04:40 我们第一投冲突 → 22:04:41 立刻重投**又**冲突)。
   * 同一条会话 30 分钟后再投一次,**第一次就成**。所以冲突是瞬时的,退避能救,
   * 而「立刻再投一次」等于白投。三档递增到 30 秒,总窗口约 45 秒,对后台投递可接受。
   *
   * 一条刻意留下的守卫:用户按「停止」不会被误判成失败 —— 实测中止后 `agent.wait` 回的是
   * `timeout` / `timeoutPhase:'queue'`,不是 `error`,所以不会因为用户叫停而重投一遍。
   */
  async chatSendConfirmed(
    sessionKey: string,
    message: string,
    opts?: { label?: string }
  ): Promise<{ runId?: string; attempts: number; error?: string }> {
    const label = opts?.label ?? 'chat.send'
    const retryDelaysMs = [3_000, 10_000, 30_000]
    let lastError: string | undefined
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
      if (attempt > 0) {
        const delay = retryDelaysMs[attempt - 1]
        console.warn(
          `[gateway] ${label} 那一轮以失败收场,${delay / 1000} 秒后重投(第 ${attempt} 次): ${lastError}`
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
      const sent = await this.chatSend(sessionKey, message)
      const runId = sent?.runId
      if (!runId) {
        // 拿不到 runId 就没法确认,按老行为放过(不会因为多这一层反而少投)。
        return { attempts: attempt + 1 }
      }
      let outcome: AgentRunWaitResult
      try {
        outcome = await this.waitRun(runId)
      } catch (err) {
        // 问不出来不代表没送到,同样放过。
        console.warn(`[gateway] ${label} 确认失败(按已送到处理): ${String(err)}`)
        return { runId, attempts: attempt + 1 }
      }
      if (outcome?.status !== 'error') {
        return { runId, attempts: attempt + 1 }
      }
      lastError = outcome.error ?? 'unknown'
    }
    console.error(`[gateway] ${label} 退避重投 ${retryDelaysMs.length} 次仍失败,这条消息没有被处理: ${lastError}`)
    return { attempts: retryDelaysMs.length + 1, ...(lastError ? { error: lastError } : {}) }
  }

  /**
   * 读一条会话的历史消息(最近 `limit` 条)。
   *
   * 用途是取子会话的最终产出:内核没有「成员产出」这种事件,`subagent_ended` 钩子只带
   * `outcome`(`openclaw/src/plugins/hook-types.ts:821-831`),正文得自己回读。
   * 2026-08-11 真机实测:对 `agent:main:subagent:<uuid>` 调它返回 2 条(任务 + 产出),
   * assistant 那条的 `content` 里 `thinking` 与 `text` 分块并存,只能取 `text`。
   */
  async chatHistory(sessionKey: string, limit = 40): Promise<ChatHistoryMessage[]> {
    const res = await this.request<{ messages?: ChatHistoryMessage[] }>('chat.history', {
      sessionKey,
      limit
    })
    return Array.isArray(res?.messages) ? res.messages : []
  }

  /**
   * 建一条会话条目(sessions.create),键由我们自己给。
   *
   * 这是「一个任务 = 一条会话」的入口,替代过去「一个任务 = 一个 agent」。
   * 键必须形如 `agent:<agentId>:acp:<taskId>` —— `acp:` 前缀是内核允许写 spawnedCwd 的
   * 唯一通行证(见 patchSession 上的说明)。代价是 acp 会话在内核的会话维护里被归为
   * disposable(`isSyntheticSessionMaintenanceKey`),默认 30 天无更新连实录一起被清,
   * 详见 `@shared/session-key` 的模块注释 —— 那不是「不会堆成负担」,是会丢历史任务。
   *
   * 2026-08-09 实测 20~25ms:它只往会话 store 写一条,不碰 `agents.list`,
   * 因此不会触发那轮 15~70 秒的配置热加载 —— 这正是换掉 `agents.create` 的全部理由。
   *
   * 两个字段刻意不传:
   *
   *  - `model`:内核对 `sessions.create` 的模型校验比 `sessions.patch` 严,实测同一个模型串
   *    在 create 里被判 `model not allowed`、在 patch 里却通过。统一交给发消息前那次 patchSession。
   *  - `label`:它在内核里是会话的**唯一句柄**,不是显示用的标题 —— 同一个会话库里重名直接
   *    回 `label already in use: <label>`(见 `src/gateway/sessions-patch.ts`,内核自己的
   *    `/name` 命令也是拿这条报错给用户看的)。把任务标题填进去,两个任务重名就会让
   *    `sessions.create` 整个失败;而所有普通任务现在共用 `main` 一个会话库,重名很常见。
   *    我们的标题存在自己的任务元数据里,不需要内核帮忙记。
   */
  async createSession(sessionKey: string): Promise<void> {
    // 超时给到 120s,不是默认的 30s。平时这调用 20~25ms,但它会**排在**别的活后面:
    // 冷网关的 provider auth 预热(17~32s,事件循环被占满)、或紧邻的 agents.list 热加载
    // (约 15s)。2026-08-10 真机上就撞了 —— 网关 30119ms 才答复,客户端在它答复前 119ms
    // 就按默认 30s 放弃了,报「sessions.create 超时」。这和技能里 agents.delete 放宽超时是同一个坑:
    // 网关没挂、只是忙,判据是耗时不是超时。用 MUTATION_TIMEOUT_MS 与配置写入同档,留足余量。
    await this.request('sessions.create', { key: sessionKey }, { timeoutMs: MUTATION_TIMEOUT_MS })
  }

  /**
   * 删除一条会话(会话条目 + 实录归档)。
   *
   * 实测 1.1~3.5 秒,而删 agent 要 31~56 秒(要清会话绑定、再把三个目录移进回收站)。
   * 参数名是 `key`,不是 `sessionKey` —— 传错内核回 INVALID_REQUEST 而不是静默忽略。
   */
  async deleteSession(sessionKey: string): Promise<void> {
    await this.request('sessions.delete', { key: sessionKey })
    this.sessionPatchCache.delete(sessionKey)
    this.subscribedKeys.delete(sessionKey)
  }

  /**
   * 会话级配置补丁(sessions.patch):按会话持久化模型覆盖 / 推理档位等,立即生效、无需重启内核。
   *  - model:形如 `yunwu/<模型名>`,覆盖该会话使用的模型(不影响其它会话);
   *  - thinkingLevel:off/minimal/low/medium/high 等,控制该会话的深度思考档位。
   *  - spawnedCwd:该会话运行时的工作目录(任务目录),见下方说明。
   * 只传有值的字段,避免误清空既有覆盖。
   */
  async patchSession(
    sessionKey: string,
    patch: {
      model?: string
      thinkingLevel?: string
      reasoningLevel?: string
      spawnedCwd?: string
    }
  ): Promise<void> {
    const body: Record<string, unknown> = { key: sessionKey }
    if (patch.model) {
      body.model = patch.model
    }
    if (patch.thinkingLevel) {
      body.thinkingLevel = patch.thinkingLevel
    }
    // spawnedCwd 决定这一轮 run 的工作目录,是「每个任务一个目录」的落地点:
    // 内核 auto-reply 直接拿它当 run.cwd(`get-reply-run.ts` 里 `cwd: sessionEntry?.spawnedCwd`),
    // 工具工厂再拿 run.cwd 当相对路径的根(`params.cwd ?? params.workspaceDir`)。
    //
    // 两条实测出来的约束:
    // 1. 内核只对 `subagent:*` / `acp:*` 前缀的会话键接受这个字段,普通键直接回
    //    `spawnedCwd is only supported for subagent:* or acp:* sessions`(sessions-patch.ts)。
    // 2. 光设它**不够**。系统提示里宣告的仍是 agent 的 workspace,模型据此给写文件工具
    //    传绝对的 workspace 路径,压根不走相对路径解析——实测文件落在了
    //    `~/.openclaw/workspace`。必须同时在消息头拼 `[Working directory: <abs>]`
    //    (内核自己的 ACP 桥就是这么做的,见 `src/acp/translator.ts`),模型才会改写任务目录。
    if (patch.spawnedCwd) {
      body.spawnedCwd = patch.spawnedCwd
    }
    // reasoningLevel 控制内核「推理展示模式」(reasoningMode),三档互斥:
    //   off    = 不展示;
    //   on     = includeReasoning,思考只随**最终消息**整块下发(session.message 带 thinking 块);
    //   stream = streamReasoning,逐段广播 `stream:"thinking"` 帧。
    // 注意 stream 档在内核里还有一个附加条件:`typeof params.onReasoningStream === "function"`,
    // 即宿主必须接了回调。2026-07-31 实测:网关 chat 路径**没有**接这个回调,把会话 patch 成
    // stream 后仍抓不到任何 thinking 帧,且此时 includeReasoning 也为 false → 思考两头落空。
    // 结论:本内核版本下走网关只能用 'on'(思考随最终消息整块到达,无法实时流)。
    if (patch.reasoningLevel) {
      body.reasoningLevel = patch.reasoningLevel
    }
    /**
     * 值没变就不发。
     *
     * 这个 patch 挂在**每条消息**的前面(见 ipc 的 agent:send),而用户在一轮对话里
     * 几乎不换模型 —— 也就是说绝大多数次调用把同样的三个字段又写了一遍。网关闲时
     * 这是一次几百毫秒的往返,忙时实测 23.5s,而它恰好卡在用户按下发送和第一次 LLM
     * 请求之间。参考实现的纪律是一样的:ClawX 在下发会话/配置补丁前先比对,相同即跳过。
     */
    const signature = JSON.stringify(body)
    if (this.sessionPatchCache.get(sessionKey) === signature) {
      return
    }
    // 同 createSession:忙时实测 23.5s(上面注释),贴着默认 30s 线,冷网关下能顶破。
    // 放宽到 120s,免得首条消息前这次 patch 被误判超时、退回默认模型。
    await this.request('sessions.patch', body, { timeoutMs: MUTATION_TIMEOUT_MS })
    this.sessionPatchCache.set(sessionKey, signature)
  }

  /** 中断会话当前运行。 */
  async abortChat(sessionKey: string): Promise<void> {
    await this.request('chat.abort', { sessionKey })
  }

  /**
   * 删除 agent:配置条目 + 会话绑定 + agentDir/sessionsDir/workspace(移入回收站)。
   *
   * deleteFiles 显式传 true,与官方 CLI `agents delete --force` 一致 —— 该命令自身就是
   * 先打这个 RPC 且写死 `deleteFiles: true`,内核不传时的默认值也是 true。
   */
  async deleteAgent(agentId: string): Promise<void> {
    await this.request(
      'agents.delete',
      { agentId, deleteFiles: true },
      { timeoutMs: MUTATION_TIMEOUT_MS }
    )
    this.invalidateConfigSnapshot()
  }

  /**
   * 读整份配置 → 交给 mutate 就地改 → 整份写回(在网关进程内提交,返回即生效)。
   * 返回是否真的落了盘。形状照 ClawX 的 `electron/gateway/config-delivery.ts:mutateRunningConfig`。
   *
   * 为什么不是 config.patch 的合并补丁:两者共用同一个落盘函数 `commitGatewayConfigWrite`,
   * patch 只是在前面多一步 `applyMergePatch` —— 而那一步的复杂度我们全额付过:删键要补 null
   * 墓碑、数组要逐条声明 `replacePaths`(漏一条就被 `would remove entries from array path(s)`
   * 顶回来,删供货商时还得连子树里的数组一起声明)。更硬的两条是:config.patch 带
   * `controlPlaneWrite` 标记,与 `gateway.restart.request` 等共用一个 3 次 / 60 秒的桶
   * (我们这版 2026.6.11),而 `config.set` 根本不在限流名单里;以及 patch 开头有
   * `if (!snapshot.valid)` 硬门槛,配置一旦坏掉只有 set / apply 救得回来。
   * 实测:连发 6 次 config.set 无一被限流,同一时刻两者落盘耗时相同(4.0~4.3 秒)。
   *
   * 提交的是**源文件形态**(loadConfigSnapshot 取的是 `resolved`,理由见那里)。内核落盘的是
   * `projectSourceOntoRuntimeShape(resolved, config)` 叠上 `createMergePatch(snapshot.config, 提交值)`
   * —— 基底本就是源文件形态,所以内核那 11KB 运行期默认值不会被烙进用户配置。
   * 实测改一个键写回,32500 字符进 32500 字符出,默认值一个都没漏进去。
   *
   * baseHash 是内核强制的乐观并发校验(不传直接拒)。期间被别人改过会得到
   * "config changed since last load":重取快照、拿新快照重算一遍再试;仍撞车则抛给调用方
   * ——连续两次说明真有并发写者,继续盲目重试会盖掉对方的改动。mutate 每轮重跑正是为此:
   * 它改的必须是本次写入所基于的那份快照。
   */
  async setConfig(mutate: (config: Record<string, unknown>) => void): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      const snapshot = await this.loadConfigSnapshot()
      const base = restoreRedactedSecrets(snapshot.config)
      const next = structuredClone(base)
      mutate(next)
      // config.set 没有服务端 noop 短路(config.patch 的 respondConfigPatchNoop 是 patch 独有),
      // 所以比对放在客户端:没差异根本不发请求,比服务端短路还省一个往返。
      if (isDeepStrictEqual(next, base)) {
        return false
      }
      try {
        await this.request(
          'config.set',
          { raw: `${JSON.stringify(next, null, 2)}\n`, baseHash: snapshot.hash },
          { timeoutMs: MUTATION_TIMEOUT_MS }
        )
        // 配置已变,缓存随之作废。顺手在后台补一份新的:下一次写入就能省掉那个往返,
        // 而用户这次的保存不必等它。
        this.invalidateConfigSnapshot()
        void this.loadConfigSnapshot().catch(() => {
          /* 预取失败无妨:下次写入会自己拉 */
        })
        return true
      } catch (err) {
        this.invalidateConfigSnapshot()
        const retryable =
          attempt === 0 && err instanceof GatewayRequestError && CONFIG_STALE.test(err.message)
        if (!retryable) {
          throw err
        }
      }
    }
  }

  /** 丢弃缓存的配置快照。任何可能改动配置的动作之后都要调,包括退回 CLI 落盘的那些。 */
  invalidateConfigSnapshot(): void {
    this.configSnapshot = null
  }

  /** 取配置快照:命中缓存直接返回,否则 config.get(并发调用共用同一次请求)。 */
  private loadConfigSnapshot(): Promise<{ hash: string; config: Record<string, unknown> }> {
    if (this.configSnapshot) {
      return Promise.resolve(this.configSnapshot)
    }
    this.configSnapshotPromise ??= this.request<{
      hash?: string
      valid?: boolean
      resolved?: Record<string, unknown>
    }>('config.get')
      .then((res) => {
        if (!res?.hash) {
          throw new Error('网关未返回配置快照哈希,无法安全写入配置')
        }
        // 配置无效时内核会把 raw / parsed / resolved 一起扣下来只回空对象(见内核
        // redact-snapshot 的 "withholds resolved config for invalid snapshots"),
        // 拿这份空的去整份写回等于清空用户配置。此时抛普通 Error 让 viaGatewayOrCli 退回 CLI
        // ——那条路直接读磁盘上那份坏配置,才有得救。
        if (res.valid === false || !res.resolved || Object.keys(res.resolved).length === 0) {
          throw new Error('网关回传的配置快照不可用于写入(配置无效,内核未回传源配置)')
        }
        const snapshot = { hash: res.hash, config: res.resolved }
        this.configSnapshot = snapshot
        return snapshot
      })
      .finally(() => {
        this.configSnapshotPromise = null
      })
    return this.configSnapshotPromise
  }

  /** 主动关闭连接(用户退出/网关停止时调用),不再自动重连。 */
  close(): void {
    this.closedByUser = true
    this.clearReconnectTimer()
    this.clearConnectTimer()
    this.rejectAllPending(new Error('网关连接已关闭'))
    this.connected = false
    this.readyPromise = null
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
  }

  private openSocket(): void {
    // 已有 socket 在握手或已连上就不再开第二条。此前这里是无条件新建:ensureConnected 在
    // 未连接时总会调过来,于是「connectTimer 到期后 socket 仍在握手」「重连定时器与主动调用
    // 撞上」都会造出一条孤儿连接;孤儿的 close 事件回来照样跑 rejectAllPending,把**新连接上**
    // 的在途请求一起打死 —— 网关日志里几秒内冒出好几个 conn id 就是这么来的。
    const existing = this.ws
    if (existing && (existing.readyState === WebSocket.CONNECTING || existing.readyState === WebSocket.OPEN)) {
      return
    }
    this.clearReconnectTimer()
    const identity = loadOrCreateDeviceIdentity()
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch (err) {
      this.failReady(err instanceof Error ? err : new Error(String(err)))
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.on('open', () => {
      this.emit('debug', 'ws open, waiting for connect.challenge')
    })
    ws.on('message', (data: RawData) => {
      this.handleMessage(identity.publicKeyPem, identity.privateKeyPem, identity.deviceId, data)
    })
    ws.on('close', (code: number, reason: Buffer) => {
      this.handleClose(code, reason.toString(), ws)
    })
    ws.on('error', () => {
      /* 'error' 之后必有 'close',统一在 close 里处理重连 */
    })
  }

  private handleMessage(
    publicKeyPem: string,
    privateKeyPem: string,
    deviceId: string,
    data: RawData
  ): void {
    let frame: unknown
    try {
      frame = JSON.parse(data.toString())
    } catch {
      return
    }
    if (!frame || typeof frame !== 'object') {
      return
    }
    const f = frame as { type?: string; event?: string; id?: string }

    if (f.type === 'event' && f.event === 'connect.challenge') {
      const payload = (frame as { payload?: { nonce?: string } }).payload
      this.sendConnect(publicKeyPem, privateKeyPem, deviceId, payload?.nonce ?? '')
      return
    }

    if (f.type === 'res' && typeof f.id === 'string') {
      this.handleResponse(frame as ResFrame)
      return
    }

    if (f.type === 'event') {
      if (f.event === 'device.pair.requested') {
        void this.reconcileKernelPairing()
      }
      // 排障:设 YUNWU_DEBUG_FRAMES=1 时,打印 chat/agent 原始帧,用于确认思考(reasoning)
      // 到底有没有下发、以及以什么结构下发(排查"深度思考不展示")。
      if (process.env.YUNWU_DEBUG_FRAMES === '1' && (f.event === 'chat' || f.event === 'agent')) {
        try {
          const p = (frame as { payload?: Record<string, unknown> }).payload ?? {}
          const dataObj = (p.data ?? {}) as Record<string, unknown>
          console.log(
            `[frame] event=${f.event} state=${String(p.state ?? '')} stream=${String(p.stream ?? '')}` +
              ` payloadKeys=${Object.keys(p).join(',')}` +
              (p.data ? ` dataKeys=${Object.keys(dataObj).join(',')} dataKind=${String(dataObj.kind ?? '')}` : '') +
              ` raw=${JSON.stringify(frame).slice(0, 600)}`
          )
        } catch {
          // ignore logging failures
        }
      }
      // 转发给上层(chat 增量 / session.tool / session.operation 等,里程碑 2/3 使用)。
      this.emit('event', frame as GatewayEventFrame)
    }
  }

  /** 收到 challenge 后:构造并签名 v3 payload,发送 connect 请求。 */
  private sendConnect(
    publicKeyPem: string,
    privateKeyPem: string,
    deviceId: string,
    nonce: string
  ): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return
    }
    if (!nonce) {
      this.failReady(new Error('网关 connect challenge 缺少 nonce'))
      return
    }
    const platform = process.platform
    const signedAtMs = Date.now()
    const payload = buildDeviceAuthPayloadV3({
      deviceId,
      clientId: CLIENT_ID,
      clientMode: CLIENT_MODE,
      role: ROLE,
      scopes: SCOPES,
      signedAtMs,
      token: null,
      nonce,
      platform,
      deviceFamily: undefined
    })
    const signature = signDevicePayload(privateKeyPem, payload)
    const connectParams = {
      minProtocol: 4,
      maxProtocol: 4,
      client: { id: CLIENT_ID, version: '0.0.0', platform, mode: CLIENT_MODE },
      role: ROLE,
      scopes: SCOPES,
      // 能力声明。网关按 cap 决定给不给你某类事件,**不声明就收不到**:
      //   tool-events → `stream:"tool"` 子流(工具入参/结果的结构化下发)。
      // 内核实现:`hasGatewayClientCap(client.connect.caps, TOOL_EVENTS)` 为真才
      // `registerToolEventRecipient(runId, connId)`;官方 TUI 与 ACP 均声明了它。
      //
      // 之前这里是空数组,于是全程只有 assistant/item/lifecycle 三种帧,`item` 帧里工具入参
      // 只剩一个被截断的 `meta` 字符串 —— 任务清单、diff 预览等"从入参解析"的实时渲染
      // 全部拿不到数据。gateway-client 里那套 toolCallDetails 逻辑其实早就写好了,只是从没收到过帧。
      caps: ['tool-events'] as string[],
      device: {
        id: deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(publicKeyPem),
        signature,
        signedAt: signedAtMs,
        nonce
      }
    }
    const id = `req-${++this.idSeq}`
    // connect 的响应即 hello-ok(type:res, ok:true, payload:hello-ok)。
    this.pending.set(id, {
      resolve: (helloOk) => this.onHelloOk(helloOk),
      reject: (err) => {
        // scope 升级被审批门拒绝时:轮换设备身份并断开,由 close→scheduleReconnect
        // 以全新设备重新配对;不 failReady,让本次 ensureConnected 在 connectTimer 内等待自愈成功。
        if (this.tryRepairPairing(err.message)) {
          try {
            this.ws?.close()
          } catch {
            /* 关闭失败也会由后续超时兜底 */
          }
          return
        }
        /**
         * 网关 startup sidecars 未就绪时会拒掉 connect 握手。这**不是**建连失败,
         * 按内核给的延迟重连即可,让本次 ensureConnected 在 connectTimer 内等到自愈。
         *
         * 形状照内核自家客户端(`packages/gateway-client/src/client.ts` 的
         * `resolveGatewayStartupRetryAfterMs` 分支):记下延迟、以 1013 关连接、直接 return,
         * **不通知上层**。以前这里走 failReady,于是冷启动时自检的「连接网关」必然红叉
         * (那步是 fatal),用户看到的就是「连接网关超时」——而重启一次之所以好了,
         * 是因为上一次留下的网关已经就绪,握手立刻成功。
         */
        const startupRetryAfterMs = resolveGatewayStartupRetryAfterMs(err)
        if (startupRetryAfterMs !== null) {
          if (!this.extendConnectDeadlineForStartup()) {
            this.failReady(new Error('网关启动超过预期时间仍未就绪'))
            return
          }
          this.startupReconnectDelayMs = startupRetryAfterMs
          console.log(`[gateway] 网关仍在启动,${startupRetryAfterMs}ms 后重连握手`)
          try {
            this.ws?.close(1013, 'gateway starting')
          } catch {
            /* 关闭失败也会由后续超时兜底 */
          }
          return
        }
        this.failReady(err)
      },
      timer: setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          this.failReady(new Error('connect 无响应'))
        }
      }, CONNECT_TIMEOUT_MS)
    })
    ws.send(JSON.stringify({ type: 'req', id, method: 'connect', params: connectParams }))
  }

  /**
   * 判断连接失败原因是否为「设备配对 / scope 升级」被拒。
   * 这类失败源于本设备稳定 deviceId 早先按较低 scope 被审批,新版申领更高 scope 触发审批门。
   */
  private isPairingScopeFailure(reason: string): boolean {
    return /pairing required|more scopes than currently approved|scope[- ]?upgrade|not-?paired|role[- ]?upgrade/i.test(
      reason
    )
  }

  /**
   * 针对「配对 / scope 升级被拒」的自愈:轮换本地设备身份(删除身份文件),
   * 使下次连接以全新设备在回环下自动获批当前所需全部 scopes。每轮建连仅尝试一次。
   * 返回 true 表示已发起自愈(调用方应改走重连而非直接失败)。
   */
  private tryRepairPairing(reason: string): boolean {
    if (this.repairAttempted || !this.isPairingScopeFailure(reason)) {
      return false
    }
    this.repairAttempted = true
    resetDeviceIdentity()
    this.emit('debug', `pairing scope changed; rotating device identity to re-pair (${reason})`)
    return true
  }

  /**
   * 放行内核后台客户端自己的配对升级请求。
   *
   * 为什么需要:内核那份设备身份是随功能逐步申领 scope 的——早先只以 `gateway:chat.history`
   * 名义连过,于是只被批了 operator.read;等到派子会话时它要 operator.write(sessions.patch),
   * 就变成 scope-upgrade。而内核对 scope-upgrade 是**硬编码不静默配对**的
   * (`silent: reason === "scope-upgrade" ? false : ...`),回环本地也不例外,于是这条请求
   * 永远躺在 pending 里没人批,子会话每次都被 `gateway closed (1008): pairing required` 打死。
   *
   * 我们自己那套 `resetDeviceIdentity()` 救不了它:轮换的是 userData 下我们的身份文件,
   * 跟内核 `~/.openclaw/identity/device.json` 是两份。
   *
   * 做法照内核自带控制台:它的设备页就是列 pending、点批准,走 device.pair.list /
   * device.pair.approve 这两个 RPC。这两个方法标的是 operator.pairing,但内核在
   * `authorizeGatewayMethod` 里对带 operator.admin 的调用方直接放行,我们已经持有 admin。
   *
   * 注意这**救不回触发升级的那一次连接**:网关是当场 close(1008) 而不是等审批。所以对账
   * 分两处触发——建连时清掉历史积压,收到 `device.pair.requested` 时立刻清掉新的,让失败
   * 收敛成「重试一次即可」而不是「永远起不来」。
   */
  private reconcileKernelPairing(): Promise<void> {
    if (this.pairingReconcile) {
      return this.pairingReconcile
    }
    const run = this.approveKernelPairingRequests().finally(() => {
      this.pairingReconcile = null
    })
    this.pairingReconcile = run
    return run
  }

  private async approveKernelPairingRequests(): Promise<void> {
    const kernelDeviceId = readKernelDeviceId()
    if (!kernelDeviceId) {
      return
    }
    let pending: PendingDevicePairing[]
    try {
      const list = await this.request<{ pending?: PendingDevicePairing[] }>('device.pair.list', {})
      pending = Array.isArray(list?.pending) ? list.pending : []
    } catch (err) {
      this.emit('debug', `device.pair.list failed: ${String(err)}`)
      return
    }
    for (const req of pending) {
      if (!this.isKernelBackendPairing(req, kernelDeviceId)) {
        continue
      }
      try {
        await this.request('device.pair.approve', { requestId: req.requestId })
        this.emit(
          'debug',
          `approved kernel backend pairing request=${String(req.requestId)} scopes=${
            Array.isArray(req.scopes) ? req.scopes.join(',') : ''
          }`
        )
      } catch (err) {
        this.emit('debug', `device.pair.approve failed: ${String(err)}`)
      }
    }
  }

  /**
   * 只认「本机内核后台客户端申领 operator 角色下的 operator.* scope」这一种待审批项。
   * deviceId 必须与内核身份文件逐字相等,别的设备一律不碰——自动审批是安全动作,
   * 判定条件写宽了等于把配对审批门整个拆掉。
   */
  private isKernelBackendPairing(req: PendingDevicePairing, kernelDeviceId: string): boolean {
    if (typeof req.requestId !== 'string' || !req.requestId) {
      return false
    }
    if (req.deviceId !== kernelDeviceId) {
      return false
    }
    if (req.clientId !== KERNEL_BACKEND_CLIENT_ID || req.clientMode !== KERNEL_BACKEND_CLIENT_MODE) {
      return false
    }
    const roles = Array.isArray(req.roles)
      ? req.roles
      : typeof req.role === 'string'
        ? [req.role]
        : []
    if (roles.length === 0 || roles.some((role) => role !== ROLE)) {
      return false
    }
    const scopes = Array.isArray(req.scopes) ? req.scopes : []
    return scopes.every((scope) => typeof scope === 'string' && scope.startsWith('operator.'))
  }

  /** hello-ok:握手成功,进入已连接状态。 */
  private onHelloOk(helloOk: unknown): void {
    this.connected = true
    this.repairAttempted = false
    this.backoffMs = INITIAL_BACKOFF_MS
    this.startupWaitStartedAt = null
    this.clearConnectTimer()
    const resolve = this.readyResolve
    this.readyResolve = null
    this.readyReject = null
    this.readyPromise = null
    this.emit('connected', helloOk)
    resolve?.()
    // 建连即预取配置快照,让首次写入也能省掉那个往返(内核控制台加载时同样先 config.get)。
    void this.loadConfigSnapshot().catch(() => {
      /* 预取失败无妨:写入时会自己拉 */
    })
    // 清掉内核后台客户端积压的配对升级,否则派出去的子会话一律握手失败。
    void this.reconcileKernelPairing()
    // 订阅全局会话事件,拿专家团成员(子会话)的 start/end —— 成员条的状态只能来自这里。
    // 内核自家客户端也是 hello-ok 后立刻订阅(见 dist 的 mcp-cli handleHelloOk)。
    // 副作用是从此会收到所有会话的 session.message,但渲染层按 sessionKey 路由,
    // 子会话的 key 与任务 key 不同,匹配不上自然被忽略,不会串进主会话正文。
    this.request('sessions.subscribe', {}).catch(() => {
      /* 订阅失败只是成员条不亮,不影响主会话;重连后会再订一次 */
    })
    // 重连后重新订阅此前的会话,避免事件断流。
    for (const key of this.subscribedKeys) {
      this.request('sessions.messages.subscribe', { key }).catch(() => {
        /* 重订阅失败会在下次重连再试 */
      })
    }
  }

  private handleResponse(frame: ResFrame): void {
    const p = this.pending.get(frame.id)
    if (!p) {
      return
    }
    this.pending.delete(frame.id)
    clearTimeout(p.timer)
    if (frame.ok) {
      p.resolve(frame.payload)
    } else {
      p.reject(new GatewayRequestError(frame.error ?? { message: '未知网关错误' }))
    }
  }

  private handleClose(code: number, reason: string, socket: WebSocket): void {
    // 只认当前这条连接的关闭事件。孤儿 socket 关掉时既不该清 this.ws,更不该 reject
    // 属于新连接的在途请求。
    if (this.ws && this.ws !== socket) {
      return
    }
    const wasConnected = this.connected
    this.connected = false
    this.ws = null
    // 断线期间配置可能被别的进程改过(我们自己的 CLI 兜底就是一例),缓存不能跨连接沿用。
    this.invalidateConfigSnapshot()
    this.sessionPatchCache.clear()

    if (this.closedByUser) {
      this.rejectAllPending(new Error('网关连接已关闭'))
      return
    }

    if (wasConnected) {
      // 已 hello-ok 后连接中断:进行中的请求如实反馈给上层。注意这**不等于**请求失败——
      // 读类请求(chat.send 等)重发即可,写类请求的结果未知,判据见 GatewayClosedError。
      this.rejectAllPending(new GatewayClosedError(code, reason))
    } else {
      // 尚未 hello-ok:多为网关刚启动尚未就绪。静默丢弃握手请求并重连,
      // 不立即失败 readyPromise —— 由 ensureConnected 的整体 connectTimer 兜底超时。
      // 若关闭原因为配对 / scope 升级被拒,则轮换设备身份,下方 scheduleReconnect 将以新身份重新配对。
      this.tryRepairPairing(reason)
      this.clearPendingQuietly()
    }

    this.emit('disconnected', { code, reason })
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) {
      return
    }
    // 「网关正在启动」用它给的短延迟,且不动指数退避:这类重连预期要连着做好几轮
    // (冷启动实测 20 秒上下),让退避涨上去会把建连拖到远超必要。
    const startupDelay = this.startupReconnectDelayMs
    this.startupReconnectDelayMs = null
    if (startupDelay !== null) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        if (!this.closedByUser && !this.connected) {
          this.openSocket()
        }
      }, startupDelay)
      return
    }
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.closedByUser && !this.connected) {
        this.openSocket()
      }
    }, delay)
  }

  /**
   * 收到「网关启动中」这条可重试拒绝后,把建连截止时间往后推一格。
   *
   * 为什么要推:CONNECT_TIMEOUT_MS 那 30 秒兜的是「网关一声不吭」,而这条拒绝恰恰是**活着并且
   * 在推进**的正面证据(是内核主动答的),不该拿同一个预算去扣它。实测冷启动从 spawn 到
   * `gateway ready` 就要 20 秒,ready 之后还有约 20 秒忙碌期、期间握手会被服务端判 handshake
   * timeout,连起来能超过 30 秒 —— 2026-08-06 23:30 真机上就撞了,报
   * `连接网关超时(hello-ok 未在预期时间内返回)`,首条消息的 sessions.patch 随之回退默认模型。
   * 内核自家客户端压根没有建连总截止,只是无限退避重连;我们保留一个封顶,免得网关真卡死时
   * 无声地等下去。
   *
   * @returns false 表示这类等待已超过总预算,调用方应判定建连失败。
   */
  private extendConnectDeadlineForStartup(): boolean {
    const now = Date.now()
    this.startupWaitStartedAt ??= now
    if (now - this.startupWaitStartedAt > MAX_STARTUP_WAIT_MS) {
      return false
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
    }
    this.connectTimer = setTimeout(() => {
      this.failReady(new Error('连接网关超时(hello-ok 未在预期时间内返回)'))
    }, CONNECT_TIMEOUT_MS)
    return true
  }

  /** 建连失败:拒绝 readyPromise 并触发重连。 */
  private failReady(err: Error): void {
    this.startupWaitStartedAt = null
    this.clearConnectTimer()
    const reject = this.readyReject
    this.readyResolve = null
    this.readyReject = null
    this.readyPromise = null
    reject?.(err)
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  /**
   * 静默清空进行中的请求(仅清定时器,不 reject)。
   * 用于握手阶段(尚未 hello-ok)断线重连:避免握手请求的 reject 回调触发 failReady,
   * 从而让 readyPromise 得以在整体 connectTimer 到期前持续等待重连成功。
   */
  private clearPendingQuietly(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
    }
    this.pending.clear()
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
  }
}

/** 单例:整个主进程共享一个网关客户端。 */
export const gatewayClient = new GatewayClient()

/**
 * 优先经网关改配置,网关不可达时退回 CLI 子进程。
 *
 * 为什么优先网关:内核判断 agent / 会话归属时读的是**网关内存里的** runtime config,
 * 而 CLI 子进程只是写了磁盘上的 openclaw.json,回传到网关内存要过一道 chokidar 监听。
 * 经网关改则提交在同一进程内完成,响应返回即已生效,顺带省掉每次几秒的内核冷启动。
 *
 * 判据取错误类型与内核错误码,不匹配文案:`GatewayRequestError` 说明内核已经**答复过**这次
 * 操作(如 "already exists"、校验不通过),必须原样抛给调用方——退回 CLI 只会重复拿到同一个
 * 答复,还会把配置写坏的苗头掩盖掉。其余错误(连接不可用、握手失败)是传输层问题,
 * 退回 CLI 有意义。介于两者之间的是 UNAVAILABLE(见上):内核收到了,但让你回头再来,
 * 既然另一条路当下就能走通,就直接走。
 *
 * **超时与断连是第三类:结果未知,只能经网关重试,绝不能退回 CLI。**
 * 两者都只说明「没拿到答复」,而不是「没做」——请求很可能还在网关里跑。此时启动 CLI 就等于
 * 让两个进程同时改 openclaw.json。两次真实事故都是这个形状:
 *  - `config.patch` 在网关里跑了 45.4s / 70.5s 最后 `res ✓`,我们却在 30s 判超时、或因连接
 *    以 close 1000 断开而判失败,退回 CLI;CLI 加载完配置正赶上网关落盘,报
 *    `ConfigMutationConflictError: config changed since last load`,整串 CLI stderr 进了聊天气泡。
 *  - 同一窗口的 `agents.create`:CLI 先建好,网关 74s 后才回 `agent "<id>" already exists`。
 *
 * 三个参考实现在这一点上完全一致 —— **只有一个写者**:
 *  - openclaw 自己的 GatewayClient(dist `client-*.js`):close 后 `flushPendingErrors` 全部 reject
 *    再 `scheduleReconnect`,没有第二条写入通道;
 *  - openclaw 控制台 control-ui:`flushPending` + 重连,config.apply/set/patch 失败只置 lastError;
 *  - Claude Code:agent 就是 `.md` 文件、单进程扫目录,压根没有注册表可抢。
 * 我们多出来的这条 CLI 写入路,只在「网关根本没在跑」时才成立(见 skipWhenDisconnected)。
 *
 * skipWhenDisconnected:连接未就绪就直接走 CLI,不等建连。给启动早期的调用方用 ——
 * 那时网关还没起来,等满 CONNECT_TIMEOUT_MS 只是白白拖慢启动;而网关没在跑就压根不存在
 * 「内存配置与磁盘不一致」的竞态,写文件本就是正确做法。
 */
export async function viaGatewayOrCli(
  what: string,
  gateway: () => Promise<unknown>,
  cli: () => Promise<unknown>,
  opts?: { skipWhenDisconnected?: boolean }
): Promise<void> {
  if (!opts?.skipWhenDisconnected || gatewayClient.isConnected) {
    for (let attempt = 0; ; attempt++) {
      try {
        await gateway()
        return
      } catch (err) {
        if (err instanceof GatewayRequestError && err.code !== UNAVAILABLE) {
          throw err
        }
        // 结果未知:重连后经网关再来一次。调用方的写入都是「读当前状态 → 整体写回」,
        // 重放安全;上一次若其实已经成功,这一次就是等值写入(内核走 noop 分支)。
        if (err instanceof GatewayTimeoutError || err instanceof GatewayClosedError) {
          if (attempt >= UNKNOWN_RESULT_RETRIES) {
            throw err
          }
          console.warn(`[gateway] ${what}:${err.message},重连后经网关重试(第 ${attempt + 1} 次)`)
          await delay(UNKNOWN_RESULT_RETRY_DELAY_MS)
          continue
        }
        // 到这里只剩两种:UNAVAILABLE(内核明确答复「现在不行」,没有在途写入),
        // 以及连接压根没建起来。两种都不存在「网关正在写同一份配置」,退 CLI 是安全的。
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[gateway] ${what}:网关不可用(${msg}),退回 CLI`)
        break
      }
    }
  }
  try {
    await cli()
  } finally {
    // CLI 是绕过网关直接改文件的,缓存的快照必然过期(哈希对不上会让下次写入白跑一轮)。
    gatewayClient.invalidateConfigSnapshot()
  }
}

/** 从助手消息体中提取纯文本(content 为数组时取首个 text 片段)。 */
function extractText(message: unknown): string {
  if (!message || typeof message !== 'object') {
    return ''
  }
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    const textPart = content.find(
      (c) => c && typeof c === 'object' && (c as { type?: string }).type === 'text'
    ) as { text?: string } | undefined
    return textPart?.text ?? ''
  }
  return ''
}

/**
 * 从助手消息体中提取深度思考文本(content 数组里 `type:"thinking"` / `type:"reasoning"` 块)。
 *
 * 兜底路径:实测部分模型(如 yunwu/glm-5.1)不会以 `stream:"thinking"` 实时推送思考,
 * 而是把思考作为**最终消息**的内容块下发(`{type:"thinking",thinking:"…"}`)。这里把这些块
 * 拼接出来,供上层在完成态补显「深度思考」折叠块,保证有思考的模型不再丢失思考展示。
 */
function extractThinking(message: unknown): string {
  if (!message || typeof message !== 'object') {
    return ''
  }
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) {
    return ''
  }
  const parts: string[] = []
  for (const c of content) {
    if (!c || typeof c !== 'object') {
      continue
    }
    const block = c as { type?: string; thinking?: unknown; text?: unknown }
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      parts.push(block.thinking)
    } else if (block.type === 'reasoning' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('').trim()
}

/** 从工具标题里尽力提取目标(带扩展名的文件名 / 路径 / 引号内内容)。 */
function extractToolTarget(title: string): string {
  const quoted = title.match(/[`'"]([^`'"]+)[`'"]/)
  if (quoted) {
    return quoted[1]
  }
  const fileLike = title.match(/([\w.\-/\\]+\.[A-Za-z0-9]+)/)
  if (fileLike) {
    return fileLike[1]
  }
  return ''
}

/**
 * 一次工具调用的入参/结果暂存表(键为 toolCallId)。
 *
 * 内核把一次工具调用拆成两条流:
 *  - `stream:'tool'`   phase=start  → `{ name, toolCallId, args }`(**入参只在这里**)
 *                      phase=result → `{ name, toolCallId, isError, result }`
 *  - `stream:'item'`   kind=tool    → `{ itemId, toolCallId, title, status }`(面向 UI,不带入参)
 *
 * UI 需要的东西横跨两条流,所以这里按 toolCallId 暂存 tool 流的内容,
 * 在随后到达的 item 事件上合并。实测顺序是 tool.start → item.start、tool.result → item.end,
 * 因此合并时暂存必然已就位。item 的 end 阶段用完即删,避免长会话里越积越多。
 */
const toolCallDetails = new Map<
  string,
  {
    args?: unknown
    partialArgs?: string
    result?: string
    isError?: boolean
    exec?: ExecOutcome
    diff?: string
  }
>()

/**
 * runId → sessionKey 记账。
 *
 * 内核的 thinking 子流和 tool 子流一样,广播时只带 runId、**不带 sessionKey**
 * (内核实现:`emitAgentEvent({ runId, stream:"thinking", data:{ text, delta } })`),
 * 而渲染层是按 sessionKey 把事件派发到具体任务的。这里在能同时看到两者的帧
 * (chat / item / lifecycle)上记一笔,供 thinking 帧回查归属。
 */
const runSessions = new Map<string, string>()

function rememberRunSession(runId: string | undefined, sessionKey: string | undefined): void {
  if (!runId || !sessionKey) {
    return
  }
  runSessions.set(runId, sessionKey)
  // 正常结束会在 lifecycle end 主动清理;运行被中断时那条 end 不会来,按插入顺序淘汰兜底。
  while (runSessions.size > 64) {
    const oldest = runSessions.keys().next()
    if (oldest.done) {
      break
    }
    runSessions.delete(oldest.value)
  }
}

/**
 * runId → 本轮模型附上的媒体产物路径。
 *
 * 内核把媒体分三处下发,而**只有这一处**在实时路径上到得了我们手里:
 *  - `agent`/`stream:"assistant"` 的 `data.mediaUrls`:本机绝对路径,轮末那一帧带上;
 *  - `session.message` 的模型原话:`MEDIA:` 行还在,但这条我们只用来提思考;
 *  - `chat`/`state:"final"`:文本里的 `MEDIA:` 行**已被内核剥掉**,所以从正文解析必然落空。
 *
 * 真机抓帧(`.tmp-probe/relay-frames.jsonl`)确认过这个顺序:assistant 那帧在 chat final
 * 之前到,所以这里先记一笔、等 final 时一起交给渲染层,媒体产物仍旧只在轮末聚合。
 */
const runMediaPaths = new Map<string, string[]>()

function rememberRunMedia(runId: string | undefined, urls: unknown): void {
  if (!runId || !Array.isArray(urls)) {
    return
  }
  const fresh = urls.filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
  if (!fresh.length) {
    return
  }
  const merged = runMediaPaths.get(runId) ?? []
  for (const url of fresh) {
    if (!merged.includes(url)) {
      merged.push(url)
    }
  }
  runMediaPaths.set(runId, merged)
  while (runMediaPaths.size > 32) {
    const oldest = runMediaPaths.keys().next()
    if (oldest.done) {
      break
    }
    runMediaPaths.delete(oldest.value)
  }
}

/** 从内核工具结果里取纯文本(兼容字符串、{content:[{text}]} 两种形态)。 */
function toolResultText(result: unknown): string {
  if (typeof result === 'string') {
    return result
  }
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content
    if (Array.isArray(content)) {
      return content
        .map((c) =>
          c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
            ? ((c as { text: string }).text)
            : ''
        )
        .join('')
    }
  }
  return ''
}

/**
 * 工具结果对象上的 `details`(命令类工具的退出码 / 耗时 / 完整输出都在这儿,
 * 解析规则与历史还原共用 `@shared/tool-step`,不在两处各写一份)。
 */
function resultDetails(result: unknown): unknown {
  if (!result || typeof result !== 'object') {
    return undefined
  }
  return (result as { details?: unknown }).details
}

/**
 * 生成面向用户的中文工具文案。
 *
 * 文案规则集中在 `@shared/tool-step`,与历史还原(session-history)共用——
 * 否则同一次运行在"运行时"和"重开后"会显示成两种说法。
 * 这里只负责补一个兜底目标:内核偶尔不给结构化入参,只能从原始标题里抠。
 */
function localizeToolTitle(name: string | undefined, title: string, input: unknown): string {
  const localized = toolStepTitle(name ?? '', input, title)
  if (localized !== toolLabel(name ?? '')) {
    return localized
  }
  // 拿到了动作但没拿到目标:从内核原始标题里补一个。
  const target = extractToolTarget(title)
  return target ? `${localized} ${target}` : localized
}

/**
 * 把网关原始事件帧归一化为 AgentEvent;无关事件返回 null。
 *
 * 事件结构来自对真实运行的抓帧:
 *  - `chat` 事件:state=delta(deltaText 增量)/ state=final(结束);
 *  - `agent` 事件 stream=item 且 data.kind=tool:工具步骤(面向 UI,但**不带入参**);
 *  - `agent` 事件 stream=tool:同一次调用的入参与结果,按 toolCallId 合并进上面的步骤;
 *  - `agent` 事件 stream=lifecycle:运行开始/结束。
 */
export function normalizeAgentEvent(frame: GatewayEventFrame): AgentEvent | null {
  const { event } = frame
  const payload = (frame.payload ?? {}) as Record<string, unknown>

  if (event === 'chat') {
    const sessionKey = payload.sessionKey as string | undefined
    if (!sessionKey) {
      return null
    }
    const runId = payload.runId as string | undefined
    rememberRunSession(runId, sessionKey)
    if (payload.state === 'delta') {
      return {
        kind: 'delta',
        sessionKey,
        runId,
        deltaText: (payload.deltaText as string) ?? '',
        text: extractText(payload.message),
        replace: payload.replace === true
      }
    }
    if (payload.state === 'final') {
      const thinking = extractThinking(payload.message)
      const mediaPaths = runId ? runMediaPaths.get(runId) : undefined
      if (runId) {
        runMediaPaths.delete(runId)
      }
      return {
        kind: 'final',
        sessionKey,
        runId,
        text: extractText(payload.message),
        stopReason: payload.stopReason as string | undefined,
        ...(thinking ? { thinking } : {}),
        ...(mediaPaths?.length ? { mediaPaths } : {})
      }
    }
    return null
  }

  if (event === 'agent') {
    const runId = payload.runId as string | undefined
    const stream = payload.stream as string | undefined
    const data = (payload.data ?? {}) as Record<string, unknown>

    // 深度思考流:网关与正文分开,单独经 stream:"thinking" 广播(data.text 累计 / data.delta 增量)。
    //
    // 必须放在 sessionKey 守卫之前:与 tool 流同为 runId 关联的子流,内核广播时**不带
    // sessionKey**(内核实现 `emitAgentEvent({ runId, stream:"thinking", data })`)。
    // 一旦被守卫拦掉,每一帧增量都会丢失,思考就只剩轮末 session.message 那一次性全量,
    // 表现为「不流式、整段一次刷出来」。归属靠 runSessions 回查;极早期帧回查不到就丢弃,
    // 后续帧带的是**累计** text,渲染层会自愈,不会缺字。
    if (stream === 'thinking') {
      const sk =
        (payload.sessionKey as string | undefined) ?? (runId ? runSessions.get(runId) : undefined)
      if (!sk) {
        return null
      }
      return {
        kind: 'thinking',
        sessionKey: sk,
        runId,
        thinkingDelta: typeof data.delta === 'string' ? data.delta : '',
        thinkingText: typeof data.text === 'string' ? data.text : undefined,
        replace: data.replace === true
      }
    }

    // 助手流:正文不从这里取(我们走 chat 的 delta/final,那条有节流与去重),
    // 这里**只**收内核附上的媒体产物路径 —— 出图/出视频那一轮的本机绝对路径只在这条流上。
    // 与 tool 流同理放在 sessionKey 守卫之前,不依赖 sessionKey。
    if (stream === 'assistant') {
      rememberRunMedia(runId, data.mediaUrls)
      return null
    }

    // 工具流:只负责把入参与结果暂存起来(item 流不带这些),不直接产生 UI 事件。
    // 必须放在 sessionKey 守卫之前:内核发这条流时不带 sessionKey(靠 runId 关联),
    // 一旦被守卫提前拦掉,入参就永远拿不到了。这里也用不上 sessionKey。
    if (stream === 'tool') {
      const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : ''
      if (!toolCallId) {
        return null
      }
      const entry = toolCallDetails.get(toolCallId) ?? {}
      if (data.phase === 'start') {
        // 入参优先取结构化字段;不同内核/工具类型字段名不一(args / arguments)。
        if (data.args !== undefined) {
          entry.args = data.args
        } else if (data.arguments !== undefined) {
          entry.args = data.arguments
        }
      }
      // 原生工具(如 update_plan)入参未必走 data.args,而以流式 partialArgs(累积 JSON
      // 串,可能分多帧、非 start 阶段)下发。args 缺席时按最长一份兜底留存,供 item 阶段解析,
      // 否则 evt.input 为空 → 待办清单在「运行时」无法实时落成勾选卡(重开历史才出)。
      if (typeof data.partialArgs === 'string' && data.partialArgs) {
        if (!entry.partialArgs || data.partialArgs.length > entry.partialArgs.length) {
          entry.partialArgs = data.partialArgs
        }
      }
      if (data.phase === 'result') {
        const details = resultDetails(data.result)
        // 命令类工具的输出在 details.aggregated / details.tail;正文那份可能只有一句
        // 「Command still running (…)」,所以优先取结构化的那份,取不到才退回正文。
        const text = execOutputFromDetails(details) ?? toolResultText(data.result)
        // 同一 phase 会被重复广播一次且第二次不带 result,别用空值盖掉已拿到的。
        if (text) {
          entry.result = text
        }
        const exec = execOutcomeFromDetails(details)
        if (exec) {
          entry.exec = exec
        }
        // edit 的真实改动只在 details.diff 里(带行号、带上下文);正文只有一句
        // 「Successfully replaced N block(s) in <path>」,从它认不出改了什么。
        const diff = editDiffFromDetails(details)
        if (diff) {
          entry.diff = diff
        }
        entry.isError = data.isError === true
      }
      toolCallDetails.set(toolCallId, entry)
      // 正常路径靠 item 的 end 阶段回收;运行被中断时那条 end 不会来,条目会残留,
      // 而入参里可能带着整份文件内容。按插入顺序淘汰最老的,给内存兜个底。
      while (toolCallDetails.size > 64) {
        const oldest = toolCallDetails.keys().next()
        if (oldest.done) {
          break
        }
        toolCallDetails.delete(oldest.value)
      }
      return null
    }

    const sessionKey = payload.sessionKey as string | undefined
    if (!sessionKey) {
      return null
    }
    rememberRunSession(runId, sessionKey)

    if (stream === 'item' && data.kind === 'tool') {
      const rawTitle = (data.title as string) ?? (data.name as string) ?? '工具调用'
      const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : ''
      const detail = toolCallId ? toolCallDetails.get(toolCallId) : undefined
      // tool 流暂存的入参:优先结构化 args;缺席时把累积的 partialArgs 解析成对象兜底
      //(不完整的流式片段解析失败则忽略,待更完整的后续帧再补)。
      let detailArgs = detail?.args
      if (detailArgs === undefined && detail?.partialArgs) {
        try {
          detailArgs = JSON.parse(detail.partialArgs)
        } catch {
          detailArgs = undefined
        }
      }
      // 入参优先取 item 自带的(不同内核版本字段名不一),没有则用 tool 流暂存的。
      const input =
        data.input ?? data.args ?? data.arguments ?? data.params ?? data.parameters ?? detailArgs
      const result = detail?.result
      if (data.phase === 'end' && toolCallId) {
        toolCallDetails.delete(toolCallId)
      }
      return {
        kind: 'tool',
        sessionKey,
        runId,
        itemId: (data.itemId as string) ?? '',
        title: localizeToolTitle(data.name as string | undefined, rawTitle, input),
        status: (data.status as string) ?? 'running',
        name: data.name as string | undefined,
        error: data.error as string | undefined,
        ...(input !== undefined ? { input } : {}),
        ...(result ? { result } : {}),
        ...(detail?.exec ? { exec: detail.exec } : {}),
        ...(detail?.diff ? { diff: detail.diff } : {})
      }
    }
    if (stream === 'lifecycle') {
      // 本轮跑完,thinking 帧不会再来,回收归属记账。终态有 end 与 error 两种
      // (后者为上游失败/fallback 链耗尽),都要回收,否则失败轮的记账要等容量淘汰才释放。
      if ((data.phase === 'end' || data.phase === 'error') && runId) {
        runSessions.delete(runId)
      }
      return {
        kind: 'lifecycle',
        sessionKey,
        runId,
        phase: (data.phase as string) ?? '',
        stopReason: data.stopReason as string | undefined,
        aborted: data.aborted === true,
        // 让出与中止在 stopReason 上无法区分(都是 aborted),只有这两个字段能分开。
        yielded: data.yielded === true || data.livenessState === 'paused',
        ...(typeof data.errorMessage === 'string' && data.errorMessage
          ? { errorMessage: data.errorMessage }
          : typeof data.error === 'string' && data.error
            ? { errorMessage: data.error }
            : {})
      }
    }
    return null
  }

  // session.message:内核在一轮运行中把「完整助手消息」下发到这里。
  // 关键:深度思考(thinking 块)仅存在于该事件的消息体里 —— chat 的 state=final
  // 事件会把 thinking 剥离,只留正文(实测抓帧确认)。因此思考展示必须从这里提取。
  // 该事件不带 runId(仅 sessionKey),故发出无 runId 的 thinking 事件,由渲染层归属
  // 当前流式助手消息;仅当模型真的产出思考块时才发,避免空事件。
  if (event === 'session.message') {
    const sessionKey = payload.sessionKey as string | undefined
    if (!sessionKey) {
      return null
    }
    const message = payload.message
    const role =
      message && typeof message === 'object'
        ? (message as { role?: string }).role
        : undefined
    if (role !== 'assistant') {
      return null
    }
    // 中止/失败原因只挂在助手消息体上(实测 lifecycle 事件不带),而这类消息通常正文与思考
    // 皆空、只有 stopReason + errorMessage。优先把它转成带原因的 lifecycle end 事件下发,
    // 否则渲染层只能显示笼统的「回复已中断」,用户无从判断该重试还是环境有问题。
    const errorMessage =
      message && typeof message === 'object'
        ? (message as { errorMessage?: unknown }).errorMessage
        : undefined
    if (typeof errorMessage === 'string' && errorMessage) {
      const stopReason =
        message && typeof message === 'object'
          ? (message as { stopReason?: unknown }).stopReason
          : undefined
      return {
        kind: 'lifecycle',
        sessionKey,
        phase: 'end',
        aborted: stopReason === 'aborted',
        errorMessage,
        ...(typeof stopReason === 'string' ? { stopReason } : {})
      }
    }
    const thinking = extractThinking(message)
    if (!thinking) {
      return null
    }
    // messageId 标识本轮消息:用于把该轮思考段按轮次插入时间线并在重放时去重/更新。
    const messageId =
      (payload.messageId as string | undefined) ??
      (message && typeof message === 'object'
        ? (message as { id?: string }).id
        : undefined)
    return {
      kind: 'thinking',
      sessionKey,
      thinkingDelta: '',
      thinkingText: thinking,
      replace: true,
      ...(messageId ? { messageId } : {})
    }
  }

  if (event === 'sessions.changed') {
    return normalizeMemberEvent(frame)
  }

  return null
}

/** 子会话 key 形如 `agent:<agentId>:subagent:<...>`,兜底从中取成员 agent id。 */
function agentIdFromSessionKey(sessionKey: string): string | undefined {
  return /^agent:([^:]+):/.exec(sessionKey)?.[1]
}

/**
 * 这条子会话是哪位成员。
 *
 * 优先 `label`:今天的负责人**自己 spawn**(不指定 agentId),所有成员的 agentId 都是
 * `main`,只有 label 认得出人(内核把它落在子会话条目上,`sessions.changed` 从条目回读,
 * 2026-08-10 实测拿得到)。存量任务是指名道姓 spawn `expert-<团队>-<成员>`,没有 label,
 * 退回 agentId 正好对上老名册 —— 两种任务共存,所以两条都要留。
 */
function memberKeyOf(label: string | undefined, agentId: string): string {
  return label || agentId
}

/**
 * `sessions.changed` → 成员状态事件。
 *
 * 只认**有父会话**的那些:主会话自己的 start/end 已由 `agent` 流的 lifecycle 承载,
 * 这里再归一化一遍只会与之互相覆盖。父会话字段两个来源都收——内核的生命周期广播给
 * `parentSessionKey`,会话行快照里叫 `spawnedBy`,不同广播路径填的不是同一个。
 */
function normalizeMemberEvent(frame: GatewayEventFrame): AgentEvent | null {
  const payload = (frame.payload ?? {}) as Record<string, unknown>
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined

  const parentSessionKey = str(payload.parentSessionKey) ?? str(payload.spawnedBy)
  const childSessionKey = str(payload.sessionKey)
  if (!parentSessionKey || !childSessionKey) {
    return null
  }
  const agentId = str(payload.agentId) ?? agentIdFromSessionKey(childSessionKey)
  if (!agentId) {
    return null
  }
  const memberKey = memberKeyOf(str(payload.label), agentId)

  const phase = str(payload.phase)
  if (phase === 'start') {
    return { kind: 'member', sessionKey: parentSessionKey, memberKey, status: 'running' }
  }
  if (phase !== 'end') {
    // phase='message' 只表示子会话又落了一条消息,状态没变,忽略以免刷屏。
    return null
  }
  const session = (payload.session ?? {}) as Record<string, unknown>
  const failed =
    payload.abortedLastRun === true ||
    session.abortedLastRun === true ||
    ['failed', 'error', 'terminated', 'killed'].includes(str(session.status) ?? '')
  return {
    kind: 'member',
    sessionKey: parentSessionKey,
    memberKey,
    status: failed ? 'failed' : 'completed'
  }
}
