import { execFile } from 'child_process'
import { createServer } from 'net'
import WebSocket from 'ws'

/**
 * 网关端口的占用探测与清理。
 *
 * 为什么单独成模块:这几个函数不依赖 Electron,可以单测;而且它们回答的是
 * 「该不该 spawn」这个前置问题,和「怎么 spawn」是两件事。
 * 形状对齐 ClawX 的 `electron/gateway/supervisor.ts` + `ws-client.ts`
 * (findExistingGatewayProcess / waitForPortFree / probeGatewayReady)。
 */

/** 探活一次 WS 握手的等待上限。只等 connect.challenge,不做设备签名。 */
const PROBE_TIMEOUT_MS = 3000

/**
 * 探测端口上是否蹲着一个**活的 openclaw 网关**。
 *
 * 判据取内核在建连后主动下发的 `connect.challenge` 事件:它在设备签名之前,
 * 不需要身份也不会改任何状态,是最便宜的「这是不是 openclaw」判据。
 * 只看「端口能连上」不够——任何进程都能占住 18789,连上不等于是网关。
 */
export function probeGatewayReady(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let ws: WebSocket
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`)
    } catch {
      resolve(false)
      return
    }
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      try {
        ws.terminate()
      } catch {
        /* 已关闭 */
      }
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    ws.on('message', (data) => {
      try {
        const frame = JSON.parse(data.toString()) as { type?: string; event?: string }
        if (frame.type === 'event' && frame.event === 'connect.challenge') {
          done(true)
        }
      } catch {
        /* 非 JSON 帧忽略,等超时 */
      }
    })
    ws.on('error', () => done(false))
    ws.on('close', () => done(false))
  })
}

/** 跑一条命令并拿 stdout;失败一律当空字符串,调用方按「查不到」处理。 */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      resolve(err ? '' : stdout)
    })
  })
}

/**
 * 查出正在 LISTEN 该端口的进程 pid。
 *
 * Windows 用 netstat -ano(findstr 交给我们自己过滤,避免本地化输出差异),
 * 其余平台用 lsof。查不到就返回空数组,调用方不能据此断言「端口没被占」。
 */
export async function listeningPids(port: number): Promise<number[]> {
  const pids = new Set<number>()
  if (process.platform === 'win32') {
    const out = await run('netstat', ['-ano', '-p', 'tcp'])
    for (const line of out.split(/\r?\n/)) {
      /** 只认 LISTENING 行,且本地地址端口号精确相等(别把 :18789 匹配成 :187890)。 */
      if (!/LISTENING/i.test(line)) {
        continue
      }
      const m = line.trim().match(/^\S+\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i)
      if (m && Number(m[1]) === port) {
        pids.add(Number(m[2]))
      }
    }
  } else {
    const out = await run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])
    for (const line of out.split(/\r?\n/)) {
      const pid = Number(line.trim())
      if (Number.isFinite(pid) && pid > 0) {
        pids.add(pid)
      }
    }
  }
  pids.delete(process.pid)
  return [...pids]
}

/** 轮询到端口可 bind 为止。返回是否在超时前腾空。 */
export async function waitForPortFree(port: number, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const free = await new Promise<boolean>((resolve) => {
      const srv = createServer()
      srv.once('error', () => resolve(false))
      srv.once('listening', () => srv.close(() => resolve(true)))
      srv.listen(port, '127.0.0.1')
    })
    if (free) {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise((r) => setTimeout(r, 300))
  }
}

/** 终止一批进程(先礼后兵:SIGTERM,给 1.5s,再 SIGKILL)。 */
export async function terminatePids(pids: number[]): Promise<void> {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* 已退出或无权终止 */
    }
  }
  if (pids.length === 0) {
    return
  }
  await new Promise((r) => setTimeout(r, 1500))
  for (const pid of pids) {
    try {
      process.kill(pid, 0)
      process.kill(pid, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
  }
}

/**
 * 子进程输出是否表明「端口已被别人占着」。
 *
 * 内核在这种情况下会打两句(实测 %TEMP%/openclaw 日志):
 *   `Gateway failed to start: gateway already running (pid 20248); lock timeout after 5000ms`
 *   `Port 18789 is already in use.`
 * 这类退出**不该当作崩溃去重启** —— 再 spawn 一次结果完全相同,只会烧 CPU。
 */
export function isPortConflictOutput(text: string): boolean {
  return /gateway already running|is already in use|address already in use|EADDRINUSE/i.test(text)
}

/**
 * 子进程输出是否表明网关已经就绪。
 *
 * 只用来给「本轮启动算不算健康」兜底;主判据仍是 probeGatewayReady 的真实握手,
 * 日志文案变了最多是晚几百毫秒被探针认出来,不会误判成健康。
 */
export function isGatewayReadyOutput(text: string): boolean {
  return /gateway ready|http server listening/i.test(text)
}
