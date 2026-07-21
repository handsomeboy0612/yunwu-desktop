import { EventEmitter } from 'events'
import { randomUUID } from 'node:crypto'
import WebSocket, { type RawData } from 'ws'
import { OPENCLAW_DEFAULT_PORT } from '@shared/types'
import type { AgentEvent, AgentSendResult } from '@shared/types'
import {
  loadOrCreateDeviceIdentity,
  signDevicePayload,
  publicKeyRawBase64UrlFromPem,
  buildDeviceAuthPayloadV3
} from './device-identity'

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

/** 单次 RPC 默认超时(与官方客户端一致)。 */
const REQUEST_TIMEOUT_MS = 30000
/** 建立连接(直到 hello-ok)的整体超时;需覆盖网关冷启动就绪耗时。 */
const CONNECT_TIMEOUT_MS = 30000
/** 重连退避:初始与上限。初始值偏小以便快速覆盖网关启动就绪窗口。 */
const INITIAL_BACKOFF_MS = 600
const MAX_BACKOFF_MS = 30000

/** 网关错误帧结构。 */
export interface GatewayError {
  code?: string
  message?: string
  details?: unknown
  retryable?: boolean
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

interface PendingRequest {
  resolve: (payload: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** RPC 失败时抛出的错误,携带网关返回的结构化 code/details。 */
export class GatewayRequestError extends Error {
  readonly code?: string
  readonly details?: unknown

  constructor(err: GatewayError) {
    super(err.message ?? err.code ?? 'gateway request failed')
    this.name = 'GatewayRequestError'
    this.code = err.code
    this.details = err.details
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

  /** 已订阅的会话 key 集合;重连后自动重新订阅,保证事件不丢。 */
  private readonly subscribedKeys = new Set<string>()

  /** 建连(直到 hello-ok)的进行中 Promise;避免并发重复连接。 */
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((err: Error) => void) | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null

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
          reject(new Error(`调用 ${method} 超时`))
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
   * 会话级配置补丁(sessions.patch):按会话持久化模型覆盖 / 推理档位等,立即生效、无需重启内核。
   *  - model:形如 `yunwu/<模型名>`,覆盖该会话使用的模型(不影响其它会话);
   *  - thinkingLevel:off/minimal/low/medium/high 等,控制该会话的深度思考档位。
   * 只传有值的字段,避免误清空既有覆盖。
   */
  async patchSession(
    sessionKey: string,
    patch: { model?: string; thinkingLevel?: string }
  ): Promise<void> {
    const body: Record<string, unknown> = { key: sessionKey }
    if (patch.model) {
      body.model = patch.model
    }
    if (patch.thinkingLevel) {
      body.thinkingLevel = patch.thinkingLevel
    }
    await this.request('sessions.patch', body)
  }

  /** 中断会话当前运行。 */
  async abortChat(sessionKey: string): Promise<void> {
    await this.request('chat.abort', { sessionKey })
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
      this.handleClose(code, reason.toString())
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
      caps: [] as string[],
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
      reject: (err) => this.failReady(err),
      timer: setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          this.failReady(new Error('connect 无响应'))
        }
      }, CONNECT_TIMEOUT_MS)
    })
    ws.send(JSON.stringify({ type: 'req', id, method: 'connect', params: connectParams }))
  }

  /** hello-ok:握手成功,进入已连接状态。 */
  private onHelloOk(helloOk: unknown): void {
    this.connected = true
    this.backoffMs = INITIAL_BACKOFF_MS
    this.clearConnectTimer()
    const resolve = this.readyResolve
    this.readyResolve = null
    this.readyReject = null
    this.readyPromise = null
    this.emit('connected', helloOk)
    resolve?.()
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

  private handleClose(code: number, reason: string): void {
    const wasConnected = this.connected
    this.connected = false
    this.ws = null

    if (this.closedByUser) {
      this.rejectAllPending(new Error('网关连接已关闭'))
      return
    }

    if (wasConnected) {
      // 已 hello-ok 后连接中断:进行中的请求(如 chat.send)确实失败,如实反馈给上层。
      this.rejectAllPending(
        new Error(`网关连接已断开(code ${code}${reason ? `: ${reason}` : ''})`)
      )
    } else {
      // 尚未 hello-ok:多为网关刚启动尚未就绪。静默丢弃握手请求并重连,
      // 不立即失败 readyPromise —— 由 ensureConnected 的整体 connectTimer 兜底超时。
      this.clearPendingQuietly()
    }

    this.emit('disconnected', { code, reason })
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) {
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

  /** 建连失败:拒绝 readyPromise 并触发重连。 */
  private failReady(err: Error): void {
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

/** 依据工具名(优先)或标题关键字推断中文动词;未知返回空串。 */
function toolVerb(name: string | undefined, title: string): string {
  const key = `${name ?? ''} ${title}`.toLowerCase()
  if (/\b(write|create|save)\b|write_file|create_file/.test(key)) {
    return '写入文件'
  }
  if (/\b(edit|patch|replace|modify)\b|apply_patch|str_replace/.test(key)) {
    return '编辑文件'
  }
  if (/\b(read|cat|open)\b|read_file|fs_read/.test(key)) {
    return '读取文件'
  }
  if (/\b(bash|shell|exec|run|command|terminal)\b|run_command/.test(key)) {
    return '执行命令'
  }
  if (/\b(grep|glob|search|find)\b/.test(key)) {
    return '搜索'
  }
  if (/\b(ls|list|dir)\b|list_dir/.test(key)) {
    return '列目录'
  }
  if (/\b(web|fetch|browser|http|url)\b/.test(key)) {
    return '访问网页'
  }
  if (/\btodo\b|task_list/.test(key)) {
    return '更新任务清单'
  }
  return ''
}

/** 生成面向用户的中文工具文案;未知工具保留原始标题。 */
function localizeToolTitle(name: string | undefined, title: string): string {
  const verb = toolVerb(name, title)
  if (!verb) {
    return title
  }
  const target = extractToolTarget(title)
  return target ? `${verb} · ${target}` : verb
}

/**
 * 把网关原始事件帧归一化为 AgentEvent;无关事件返回 null。
 *
 * 事件结构来自对真实运行的抓帧:
 *  - `chat` 事件:state=delta(deltaText 增量)/ state=final(结束);
 *  - `agent` 事件 stream=item 且 data.kind=tool:工具步骤;
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
      return {
        kind: 'final',
        sessionKey,
        runId,
        text: extractText(payload.message),
        stopReason: payload.stopReason as string | undefined
      }
    }
    return null
  }

  if (event === 'agent') {
    const sessionKey = payload.sessionKey as string | undefined
    if (!sessionKey) {
      return null
    }
    const runId = payload.runId as string | undefined
    const stream = payload.stream as string | undefined
    const data = (payload.data ?? {}) as Record<string, unknown>

    if (stream === 'item' && data.kind === 'tool') {
      const rawTitle = (data.title as string) ?? (data.name as string) ?? '工具调用'
      return {
        kind: 'tool',
        sessionKey,
        runId,
        itemId: (data.itemId as string) ?? '',
        title: localizeToolTitle(data.name as string | undefined, rawTitle),
        status: (data.status as string) ?? 'running',
        name: data.name as string | undefined,
        error: data.error as string | undefined
      }
    }
    // 深度思考流:网关与正文分开,单独经 stream:"thinking" 广播(data.text 累计 / data.delta 增量)。
    if (stream === 'thinking') {
      return {
        kind: 'thinking',
        sessionKey,
        runId,
        thinkingDelta: typeof data.delta === 'string' ? data.delta : '',
        thinkingText: typeof data.text === 'string' ? data.text : undefined,
        replace: data.replace === true
      }
    }
    if (stream === 'lifecycle') {
      return {
        kind: 'lifecycle',
        sessionKey,
        runId,
        phase: (data.phase as string) ?? '',
        stopReason: data.stopReason as string | undefined,
        aborted: data.aborted === true
      }
    }
    return null
  }

  return null
}
