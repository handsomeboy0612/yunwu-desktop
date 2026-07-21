import { runOpenClaw } from './openclaw-cli'
import { getAgentWorkspaceDir } from './workspace'
import { loadActivation } from './store'

/**
 * isolated agent 生命周期管理。
 *
 * 设计目标(路径B:OpenClaw 原生 multi-agent):每个任务组映射一个独立 agent,
 * 拥有独立 workspace 与 session store,天然隔离上下文与文件,互不串扰。
 *
 * 三条纪律:
 *  - 惰性:仅在任务首次发消息时创建 agent,避免空任务污染内核 config;
 *  - 幂等:重复 ensure 同一 agent 不重复创建;跨重启用 `agents list` 校正缓存,
 *    并以内核 "already exists" 报错兜底;
 *  - 串行:所有写 ~/.openclaw/openclaw.json 的操作(add/delete)经单一队列串行执行,
 *    规避并发写同一配置文件导致的竞态/损坏。
 */

/** 已知 agent id 缓存;null 表示尚未从内核初始化。 */
let knownAgents: Set<string> | null = null

/** 串行队列尾指针:所有 agent 写操作串行链接在其后。 */
let opQueue: Promise<unknown> = Promise.resolve()

/** 内核报告 agent 已存在时的错误特征(用于幂等兜底)。 */
const ALREADY_EXISTS = /already exists/i

/** agent id 白名单:仅允许字母数字及 . _ -,防止拼进 CLI 参数时产生意外。 */
const VALID_AGENT_ID = /^[a-zA-Z0-9._-]+$/

/**
 * 把一个异步操作排入串行队列,返回其结果 promise。
 * 无论前一个操作成功或失败,队列都会继续推进,避免一次失败卡死后续所有操作。
 */
function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = opQueue.then(op, op)
  opQueue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** 校验 agent id 合法性;非法直接抛错(调用方生成的 taskId 应始终合法)。 */
function assertValidAgentId(agentId: string): void {
  if (!VALID_AGENT_ID.test(agentId)) {
    throw new Error(`非法 agentId:${agentId}`)
  }
}

/** 从内核加载现有 agent id 集合(带缓存);解析失败按空集合处理,由 add 的幂等兜底。 */
async function ensureKnownLoaded(): Promise<Set<string>> {
  if (knownAgents) {
    return knownAgents
  }
  const set = new Set<string>()
  try {
    const out = await runOpenClaw(['agents', 'list', '--json'])
    const arr = JSON.parse(out) as Array<{ id?: string }>
    for (const a of arr) {
      if (a?.id) {
        set.add(a.id)
      }
    }
  } catch {
    /* 列举失败:留空集合,后续 add 以 already-exists 兜底幂等。 */
  }
  knownAgents = set
  return set
}

/** 解析任务 agent 使用的模型(provider/model 形式);未激活时抛出可读错误。 */
function resolveAgentModel(): string {
  const activation = loadActivation()
  if (!activation?.defaultModel) {
    throw new Error('未找到激活配置或默认模型,无法创建任务。请先完成激活。')
  }
  return `yunwu/${activation.defaultModel}`
}

/**
 * 确保指定 isolated agent 已在内核注册(惰性 + 幂等 + 串行)。
 * 首次对某任务发消息前调用:为其创建独立 workspace 与 session store。
 */
export function ensureAgent(agentId: string): Promise<void> {
  assertValidAgentId(agentId)
  return enqueue(async () => {
    const known = await ensureKnownLoaded()
    if (known.has(agentId)) {
      return
    }
    const workspace = getAgentWorkspaceDir(agentId)
    const model = resolveAgentModel()
    try {
      await runOpenClaw([
        'agents',
        'add',
        agentId,
        '--workspace',
        workspace,
        '--model',
        model,
        '--non-interactive'
      ])
      known.add(agentId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (ALREADY_EXISTS.test(msg)) {
        /** 内核已有该 agent(上次会话遗留):视为成功,补记缓存。 */
        known.add(agentId)
        return
      }
      throw err
    }
  })
}

/**
 * 列出所有任务 agent 的 id(taskId 约定以 't' 开头,排除内核默认 main)。
 * 用于启动时把"内核已存在但本地未记录"的孤儿 agent 恢复为任务。
 */
export async function listTaskAgentIds(): Promise<string[]> {
  const known = await ensureKnownLoaded()
  return [...known].filter((id) => id !== 'main' && id.startsWith('t'))
}

/**
 * 删除 isolated agent 及其 workspace/session(容错:失败不抛,避免阻塞前端移除任务)。
 */
export function deleteAgent(agentId: string): Promise<void> {
  assertValidAgentId(agentId)
  return enqueue(async () => {
    try {
      await runOpenClaw(['agents', 'delete', agentId, '--force'])
    } catch {
      /* 删除失败容忍:agent 可能本就不存在或被占用,不影响前端移除任务。 */
    } finally {
      knownAgents?.delete(agentId)
    }
  })
}
