import { join } from 'path'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { homedir } from 'os'
import type { GatewayEventFrame } from './gateway-client'

/**
 * 网关客户端**懒加载**:它底下挂着 electron 与 ws,在主进程外一 import 就炸。
 * `scripts/verify-history.mjs` 正是在纯 node 里跑这套解析器的(一键校验历史还原),
 * 静态 import 会让它连打包都过不去。不在 Electron 里就直接没有 RPC 这条源,只读磁盘。
 */
async function gateway(): Promise<typeof import('./gateway-client').gatewayClient | null> {
  if (!process.versions.electron) {
    return null
  }
  return (await import('./gateway-client')).gatewayClient
}

/**
 * 会话索引:`sessionKey → sessionId`,以及「某个 agent 有没有会话」。
 *
 * # 为什么要有这一层
 *
 * 我们原来三处直接读 `~/.openclaw/agents/<agentId>/sessions/sessions.json`
 * (枚举任务、定位 jsonl 实录、判断 agent 有没有跑过)。那份 JSON 在内核 2026.7.2 里
 * **不再是权威口径**:`src/config/sessions/store.ts` 与 `store-load.ts` 已不存在,会话库搬进了
 * SQLite,JSON 变成一次性迁移输入(迁完归档成 `sessions.json.migrated.<n>`,见上游
 * `src/config/sessions/artifacts.test.ts`)。继续读它,升级那天这三处会**静默返回空**——
 * 侧栏丢历史任务、专家清理误判"没人在用"而删掉在用的登记。所以口径改成网关 RPC。
 *
 * # 形状照参考实现:一次 list 建表 + 事件增量
 *
 * 内核自带控制台与 ClawX 都是 `sessions.list` 取一次、之后靠 `sessions.changed` 更新,
 * 不是每次现调。我们必须照这个形状,因为**现调太慢**:2026-08-12 真机实测
 * `sessions.list`(24 行、limit 5000)稳定 **1.4~1.6 秒**,连调四次无缓存效应;
 * 而定位实录是切任务的同步路径,今天是 6ms 读盘。每次现调等于把 2026-07 已经修掉的
 * 切任务卡顿放回来(那次正是从 spawn CLI 换成读盘才修好的)。
 *
 * 等价性动手前验过(同一时刻 RPC 与磁盘遍历各取一份):任务键 13 : 13 逐条相同、
 * `sessionId` 无一缺失也无一不一致、13/13 都能按 `<sessionId>.jsonl` 落到实录文件,
 * 响应里 `path=(multiple)`、`hasMore=false` —— 说明它确实跨全部 agent 库,且没被默认的
 * 100 行截断(默认档只回 100 行,所以我们显式给大 limit 并检查 `hasMore`)。
 *
 * # 两条刻意的取舍
 *
 * - **枚举走强制刷新(异步),定位实录走内存表(同步)。** 事件增量只会加不会减,
 *   会话被删时表里会留残条;枚举的三个调用方(孤儿恢复、专家清理、agent 清理)都在
 *   启动链上、都能 await,那就每次强制刷新,拿到的永远是当下真相。定位实录不能异步
 *   (切任务的同步路径),用内存表——残条最坏是给出一个不存在的路径,调用方本来就兜了。
 * - **回落读那份 JSON 的条件是「内存表没命中」,不是「还没刷新过」。** 刚建好、还没广播过
 *   `sessions.changed` 的新会话在表里查不到,而它恰好是用户正在用的那条;按"热没热"切换
 *   会让这种会话读不到实录,而今天的读盘每次都是新鲜的。所以命中不到才读盘,6.11 上行为
 *   与今天一致(代价也一样:今天每次调用本来就在读那份 JSON)。这是过渡桥——7.2 迁移后
 *   文件不在,`existsSync` 落空即视为空表;升完内核把 `legacy*` 两个函数删掉即可,只在这一个文件里。
 */

/** `sessionKey → sessionId`。 */
const index = new Map<string, string>()
let attached = false
/** 上一次成功取回清单的时刻(0 = 从没成功过)。 */
let lastOkAt = 0
/** 正在飞的那次请求,用于合并并发调用。 */
let inflight: Promise<boolean> | null = null

/**
 * 多久之内算新鲜。启动链上三步紧挨着跑(专家对账、孤儿恢复、agent 清理),各刷一次就是
 * 三个 1.5 秒;它们看的是同一份真相,合并成一次。
 */
const FRESH_MS = 5_000

/** 会话键的 agent 段:`agent:<agentId>:...`。 */
function agentIdOf(sessionKey: string): string {
  return /^agent:([^:]+):/.exec(sessionKey)?.[1] ?? ''
}

/** 过渡桥:读某个 agent 的 JSON 会话库(内核 ≤2026.6.11 的布局)。文件不在即空表。 */
function legacyStoreOf(agentId: string): Map<string, string> {
  const out = new Map<string, string>()
  const storePath = join(homedir(), '.openclaw', 'agents', agentId, 'sessions', 'sessions.json')
  if (!existsSync(storePath)) {
    return out
  }
  try {
    // 顶层就是「会话键 → 条目」;历史上也见过包一层 `entries` 的形态,两种都收。
    const raw = JSON.parse(readFileSync(storePath, 'utf-8')) as Record<string, unknown>
    const entries = (raw.entries as Record<string, unknown> | undefined) ?? raw
    for (const [key, value] of Object.entries(entries)) {
      const sessionId = (value as { sessionId?: unknown } | null)?.sessionId
      out.set(key, typeof sessionId === 'string' ? sessionId : '')
    }
  } catch {
    /* 库坏掉当作空 */
  }
  return out
}

/** 过渡桥:走遍全部 agent 的 JSON 会话库,供枚举类读者取并集。 */
function legacyStoreAll(): Map<string, string> {
  const out = new Map<string, string>()
  const agentsRoot = join(homedir(), '.openclaw', 'agents')
  if (!existsSync(agentsRoot)) {
    return out
  }
  let agentDirs: string[]
  try {
    agentDirs = readdirSync(agentsRoot)
  } catch {
    return out
  }
  for (const agentId of agentDirs) {
    for (const [key, sessionId] of legacyStoreOf(agentId)) {
      out.set(key, sessionId)
    }
  }
  return out
}

/**
 * 枚举类读者看到的表:磁盘为底、内存表覆盖在上。
 * 取并集而不是二选一——判"有没有人在用"时,并集偏向"在用",而误判成"没人用"会删掉在用的东西。
 */
function mergedIndex(): Map<string, string> {
  const out = legacyStoreAll()
  for (const [key, sessionId] of index) {
    out.set(key, sessionId)
  }
  return out
}

/**
 * 向网关取一次完整会话清单并替换内存表。
 *
 * 显式给大 `limit`:默认只回 100 行(`SESSIONS_LIST_DEFAULT_LIMIT`),而 `limit` 没有上限
 * (`session-utils.ts:resolveSessionsListLimit` 只做 `max(1, floor)`)。仍然检查 `hasMore`,
 * 被截断就告警——静默少任务比报错难查得多。
 *
 * 失败不清表:网关没连上、启动期排队超时都算失败,此时保留上一次的表(或继续回落 JSON)
 * 比返回空更接近真相。
 */
export async function refreshSessionIndex(): Promise<boolean> {
  if (inflight) {
    return inflight
  }
  if (lastOkAt > 0 && Date.now() - lastOkAt < FRESH_MS) {
    return true
  }
  inflight = fetchSessionList().finally(() => {
    inflight = null
  })
  return inflight
}

async function fetchSessionList(): Promise<boolean> {
  try {
    const client = await gateway()
    if (!client) {
      return false
    }
    const res = await client.request<{
      sessions?: Array<{ key?: unknown; sessionId?: unknown }>
      hasMore?: boolean
      totalCount?: number
    }>('sessions.list', { includeGlobal: false, includeUnknown: false, limit: 5000 })
    const rows = Array.isArray(res?.sessions) ? res.sessions : []
    index.clear()
    for (const row of rows) {
      if (typeof row?.key === 'string' && row.key) {
        index.set(row.key, typeof row.sessionId === 'string' ? row.sessionId : '')
      }
    }
    lastOkAt = Date.now()
    if (res?.hasMore === true) {
      console.warn(
        `[sessions] 清单被截断(取回 ${rows.length} / 共 ${res.totalCount ?? '?'} 条),部分会话不在索引里`
      )
    }
    return true
  } catch (err) {
    // 启动期网关还没连上时这里必然失败(实测三步各一次),所以只在调试级说一句:
    // 此时磁盘上那份 JSON 仍是 6.11 的真相,读者会照旧读到它,不是故障。
    console.log(`[sessions] 暂时取不到会话清单,先用磁盘上的: ${String(err)}`)
    return false
  }
}

/**
 * 有没有一份**可信的会话真相**可用——这才是"能不能做删除类判断"的判据。
 * 两个来源任一成立即可:这次(或刚刚)向网关取到了清单,或者磁盘上还有 6.11 的 JSON 库。
 * 7.2 迁移之后 JSON 不在了,网关又取不到时它才为 false,那时删除类动作必须整轮跳过。
 */
export async function ensureSessionTruth(): Promise<boolean> {
  const ok = await refreshSessionIndex()
  return ok || legacyStoreExists()
}

/** 磁盘上还有没有 6.11 布局的会话库(过渡桥的存在性判断)。 */
function legacyStoreExists(): boolean {
  const agentsRoot = join(homedir(), '.openclaw', 'agents')
  if (!existsSync(agentsRoot)) {
    return false
  }
  try {
    return readdirSync(agentsRoot).some((agentId) =>
      existsSync(join(agentsRoot, agentId, 'sessions', 'sessions.json'))
    )
  } catch {
    return false
  }
}

/**
 * 挂到网关事件流上做增量更新(幂等)。
 * `sessions.changed` 的负载里带 `sessionKey` 与 `sessionId`(内核 `server-chat.ts:438`),
 * 所以新建会话、以及 reset 换了 sessionId 都能就地跟上,不用重新拉清单。
 */
export function attachSessionIndex(): void {
  if (attached) {
    return
  }
  attached = true
  void gateway().then((client) => {
    client?.on('event', (frame: GatewayEventFrame) => {
      if (frame.event !== 'sessions.changed') {
        return
      }
      const payload = (frame.payload ?? {}) as Record<string, unknown>
      const key = payload.sessionKey
      const sessionId = payload.sessionId
      if (typeof key !== 'string' || !key || typeof sessionId !== 'string' || !sessionId) {
        return
      }
      index.set(key, sessionId)
    })
  })
}

/**
 * 某条会话的 sessionId(不认识返回空串)。
 * 内存表优先(reset 换了 id 时它才是新的),没命中才读那一个 agent 的 JSON 库。
 */
export function sessionIdFor(sessionKey: string): string {
  const known = index.get(sessionKey)
  if (known) {
    return known
  }
  const agentId = agentIdOf(sessionKey)
  return (agentId ? legacyStoreOf(agentId).get(sessionKey) : '') ?? ''
}

/** 旧键兜底用:该 agent 任意一条带 sessionId 的会话(一任务一 agent 时代它只有一条)。 */
export function anySessionIdOfAgent(agentId: string): string {
  for (const [key, sessionId] of mergedIndex()) {
    if (sessionId && agentIdOf(key) === agentId) {
      return sessionId
    }
  }
  return ''
}

/** 该 agent 的会话库里有没有条目(判"这个 agent 从没跑过"用)。 */
export function agentHasSessions(agentId: string): boolean {
  for (const key of mergedIndex().keys()) {
    if (agentIdOf(key) === agentId) {
      return true
    }
  }
  return false
}

/** 全部会话键的快照。枚举类调用方先 `refreshSessionIndex()` 再取,拿到的才是当下真相。 */
export function allSessionKeys(): string[] {
  return [...mergedIndex().keys()]
}
