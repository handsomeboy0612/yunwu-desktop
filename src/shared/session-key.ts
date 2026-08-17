/**
 * 任务会话键的构造与解析。
 *
 * # 为什么是 `agent:<agentId>:acp:<taskId>`
 *
 * 一个任务过去等于一个内核 agent,新建要 `agents.create`、删除要 `agents.delete`,
 * 而这两个都会改 `agents.list` —— 那是 hot 类配置路径,每写一次就触发一轮网关热加载,
 * 实测新建堵 15~70 秒、删除 31~56 秒。任务本身却只需要两样东西:一份独立的对话上下文,
 * 和一个不与别的任务串味的工作目录。这两样内核在**会话**这一层就给得起:
 *
 *  - 独立上下文:一个 agent 下可以挂任意多条会话,键由调用方自己给(`sessions.create`);
 *  - 独立工作目录:会话条目上的 `spawnedCwd` 就是那一轮 run 的 cwd。
 *
 * 于是任务降级成「共享 agent 上的一条会话」。2026-08-09 实测建一条 20~25ms、删一条 1.1~3.5s。
 *
 * # 为什么专家也挂在 `main` 上,身份编进键里
 *
 * 专家一度各有一个常驻 `expert-<slug>` agent,人设靠该 agent 工作区的 `AGENTS.md` 注入。
 * 代价是每个专家、每个专家团成员都要在 `agents.list` 里占一条,而内核冷启动的
 * provider auth 预热是**逐个 agent** 跑一遍鉴权发现扫描
 * (`src/agents/model-provider-auth.ts:buildCurrentProviderAuthStateSnapshot`),
 * 成本 ≈ agent 数 × 供货商数 —— 本机 84 个 agent 时实测 `pre-warmed in 49490ms`。
 *
 * WorkBuddy 没有这个包袱:它的专家是插件,不进全局 agent 注册表。openclaw 有对应的口子,
 * 就是 `before_prompt_build` 钩子——同一个 agent 上,不同会话可以拿到不同的系统提示词
 * (2026-08-10 实测,见 persona-bundle.ts)。所以人设改由插件按会话注入,
 * agent 只留内核默认的 `main` 一个。
 *
 * 插件在钩子里只拿得到 `sessionKey`,所以「这条会话是哪个专家」必须由键自己说清楚:
 * 专家任务的第四段是 `e-<slug>-<taskId>`。分隔靠**最后一个连字符**——taskId 形如
 * `t<毫秒><4 位 base36>`,只有字母数字;slug 已被 `persistentExpertAgentId` 同款规则
 * 限制在 `[a-zA-Z0-9._-]`,可能含连字符但一定在左边。刻意不引入 `~` 之类的字符:
 * 键会进内核会话库与实录文件名,只用已经验证过的字母数字与连字符最稳。
 *
 * `acp:` 这一段不是随便取的,它是内核的准入条件:`sessions.patch` 只对
 * `subagent:*` / `acp:*` 前缀的键接受 `spawnedCwd`,普通键直接回
 * `spawnedCwd is only supported for subagent:* or acp:* sessions`
 * (见内核 `src/gateway/sessions-patch.ts`)。
 *
 * **这个前缀带一个未处置的代价**:内核的会话维护把 `acp:` 归为 disposable
 * (`config/sessions/store-maintenance.ts:253` 的 `isSyntheticSessionMaintenanceKey`),
 * 默认 30 天无更新就删 store 条目并清掉实录(`:178`,`pruneAfter`),另有 500 条 cap。
 * 一个月没打开的任务会连历史一起消失 —— 早先注释把这写成「过期自动清」的好处,是看反了。
 * 要保就得调 `session.maintenance.pruneAfter` / `maxEntries`,或我们自己另存任务索引。
 *
 * # 旧键还要认
 *
 * 存量任务的键是 `agent:<taskId>:main`(一任务一 agent 时代)。它们的实录、工作目录
 * 都还在原处,解析必须继续认,否则用户打开历史任务会看到空白。旧键下 agentId 就是 taskId。
 */

/** 普通任务挂靠的共享 agent —— 内核默认 agent,一定存在,无需我们创建。 */
export const DEFAULT_TASK_AGENT_ID = 'main'

export interface ParsedTaskSessionKey {
  /** 承载这条会话的内核 agent id(`main`;存量专家任务是 `expert-<slug>`,旧键下等于 taskId)。 */
  agentId: string
  /** 任务 id,也是任务目录与本地元数据的主键。 */
  taskId: string
  /** 这条会话属于哪个专家(通用助手任务为 undefined)。 */
  expertSlug?: string
  /** true = 一任务一 agent 时代的旧键 `agent:<taskId>:main`。 */
  legacy: boolean
}

/** 专家任务在第四段上的前缀,见模块头「身份编进键里」。 */
const EXPERT_SEGMENT_PREFIX = 'e-'

/**
 * 组装任务会话键。给了 expertSlug 就把专家身份编进第四段,插件靠它认人设。
 */
export function taskSessionKey(agentId: string, taskId: string, expertSlug?: string): string {
  const tail = expertSlug ? `${EXPERT_SEGMENT_PREFIX}${expertSlug}-${taskId}` : taskId
  return `agent:${agentId}:acp:${tail}`
}

/**
 * 解析任务会话键,三种格式都认:
 *  - `agent:main:acp:e-<slug>-<taskId>` —— 今天的专家任务;
 *  - `agent:main:acp:<taskId>` —— 今天的通用任务,以及**存量专家任务**
 *    `agent:expert-<slug>:acp:<taskId>`(专家身份从 agentId 反推,会话仍留在原 agent 上);
 *  - `agent:<taskId>:main` —— 一任务一 agent 时代的旧键。
 * 不是任务会话(如子会话 `...:subagent:...`)返回 null。
 */
export function parseTaskSessionKey(sessionKey: string): ParsedTaskSessionKey | null {
  const acp = /^agent:([^:]+):acp:(.+)$/.exec(sessionKey)
  if (acp) {
    const agentId = acp[1]
    const tail = acp[2]
    if (tail.startsWith(EXPERT_SEGMENT_PREFIX)) {
      // 按最后一个连字符切:taskId 只含字母数字,连字符只可能来自 slug。
      const cut = tail.lastIndexOf('-')
      if (cut > EXPERT_SEGMENT_PREFIX.length - 1) {
        return {
          agentId,
          taskId: tail.slice(cut + 1),
          expertSlug: tail.slice(EXPERT_SEGMENT_PREFIX.length, cut),
          legacy: false
        }
      }
    }
    // 存量专家任务:身份在 agentId 上(`expert-<slug>`),会话不迁移。
    const hosted = /^expert-(.+)$/.exec(agentId)
    return {
      agentId,
      taskId: tail,
      ...(hosted ? { expertSlug: hosted[1] } : {}),
      legacy: false
    }
  }
  const legacy = /^agent:([^:]+):main$/.exec(sessionKey)
  if (legacy) {
    return { agentId: legacy[1], taskId: legacy[1], legacy: true }
  }
  return null
}

/** 只取专家 slug(通用任务返回空串)。 */
export function expertSlugFromSessionKey(sessionKey: string): string {
  return parseTaskSessionKey(sessionKey)?.expertSlug ?? ''
}

/**
 * 只取任务 id —— 任务目录、本地元数据、产出物定位都以它为准。
 * 解析不出来时返回空串,由调用方回退到受管工作区根。
 */
export function taskIdFromSessionKey(sessionKey: string): string {
  return parseTaskSessionKey(sessionKey)?.taskId ?? ''
}

/**
 * 只取承载会话的 agent id。
 *
 * 注意它与 taskId 在新键下**不是同一个东西**:十个任务可能共用 `main`。
 * 凡是「这个任务自己的东西」(目录、实录、元数据)一律用 taskId,别用这个。
 */
export function agentIdFromSessionKey(sessionKey: string): string {
  return parseTaskSessionKey(sessionKey)?.agentId ?? ''
}

/**
 * 每轮消息都要拼在正文前面的工作目录声明。
 *
 * 光设 `spawnedCwd` 不够:系统提示里宣告的仍是 agent 的 workspace,模型据此给写文件
 * 工具传绝对的 workspace 路径,相对路径解析压根没被触发 —— 2026-08-09 实测,不加这行
 * 时文件落在了 `~/.openclaw/workspace`,加上之后 10 秒落进任务目录。
 *
 * 格式抄内核自己的 ACP 桥(`src/acp/translator.ts`),它就是靠这一行把模型引到目标目录的;
 * 它也是**每轮**都拼,不是只在首条消息 —— 上下文一长,首条里的目录会被模型忘掉。
 */
export function withWorkingDirectory(message: string, cwd: string): string {
  return cwd ? `[Working directory: ${cwd}]\n\n${message}` : message
}

/**
 * 上面那行的逆操作,历史还原用。
 *
 * 它是我们每轮替用户加的运行时上下文,不是用户打的字:实时气泡里从来没有它,回看历史时
 * 也不该有。不剥的两个后果都真实存在:每条用户气泡顶着一行本机绝对路径,而孤儿任务恢复
 * 拿首条消息前 20 字当标题(`ipc.ts` 的 `tasks:orphans`),标题会变成 `[Working directory: `。
 *
 * 只认行首、且必须以 `]` + 空行收尾,与生成端逐字对应;匹配不上就原样返回(路径里带 `]`
 * 也不会出错,贪婪匹配落在该行最后一个 `]` 上)。
 */
export function stripWorkingDirectory(message: string): string {
  return message.replace(/^\[Working directory: [^\n]*\]\n\n/, '')
}
