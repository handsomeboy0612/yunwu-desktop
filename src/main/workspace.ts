import { app } from 'electron'
import { homedir } from 'os'
import { isAbsolute, join, resolve, basename, relative } from 'path'
import { mkdirSync, existsSync, statSync, readFileSync, writeFileSync } from 'fs'
import type { ArtifactContent, WorkspaceEntry } from '@shared/types'
import { mediaKindOf } from '@shared/media-directives'
import { parseTaskSessionKey } from '@shared/session-key'

/**
 * 受管工作区目录:默认放在用户「文档」下的 YunwuDesktop。
 *
 * 设计意图(对齐 WorkBuddy 的"默认权限"模型):
 *  - 用户无需手动选目录,agent 默认在这个受管沙箱目录里读写文件;
 *  - 需要处理其它位置的文件时,用 @ 引用把文件带进来,或切换到"完全访问权限";
 *  - 目录首次访问时自动创建。
 */
export function getWorkspaceDir(): string {
  const dir = join(app.getPath('documents'), 'YunwuDesktop')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 从任务 id 解析创建时间。任务 id 形如 `t<13位毫秒时间戳><4位随机>`(见 newTask()),
 * 时间戳直接内嵌其中,无需额外记账即可还原。专家会话等非此格式的 id 返回 null。
 */
function createdAtFromTaskId(taskId: string): Date | null {
  const m = /^t(\d{13})/.exec(taskId)
  if (!m) {
    return null
  }
  const d = new Date(Number(m[1]))
  return Number.isNaN(d.getTime()) ? null : d
}

/** `2026-07-31-16-01-23`(本地时区),与 WorkBuddy 的目录命名格式一致。 */
function timestampDirName(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  )
}

/**
 * 工作空间注册表 + 任务绑定,持久化在 userData/workspaces.json。
 *
 * 两件事分开记:
 *  - `list`:用户**显式**新建或打开过的工作空间,驱动「选择工作空间」菜单里的列表。
 *    不扫描受管根目录 —— 那里还躺着每个任务的一次性时间戳目录,把它们列出来就成了
 *    「历史任务列表」,不是工作空间。WorkBuddy 同样只列显式创建/打开过的:本机
 *    `C:\Users\000\WorkBuddy` 下明明有一堆时间戳目录,它的菜单仍显示「未找到工作空间」。
 *  - `bindings`:任务 id → 它选定的工作空间目录。选择发生在新建任务那一刻,而目录要在
 *    之后每次续聊、打开文件夹、解析产出物时都算得出来,所以必须落盘而不是只存在渲染层。
 */
interface WorkspaceStoreShape {
  version: 1
  list: WorkspaceEntry[]
  bindings: Record<string, string>
}

function workspaceStoreFile(): string {
  return join(app.getPath('userData'), 'workspaces.json')
}

let workspaceStoreCache: WorkspaceStoreShape | null = null

function loadWorkspaceStore(): WorkspaceStoreShape {
  if (workspaceStoreCache) {
    return workspaceStoreCache
  }
  const empty: WorkspaceStoreShape = { version: 1, list: [], bindings: {} }
  try {
    const parsed = JSON.parse(readFileSync(workspaceStoreFile(), 'utf-8')) as Partial<
      WorkspaceStoreShape
    >
    workspaceStoreCache = {
      version: 1,
      list: Array.isArray(parsed.list) ? parsed.list.filter((e) => e && e.path) : [],
      bindings:
        parsed.bindings && typeof parsed.bindings === 'object' ? { ...parsed.bindings } : {}
    }
  } catch {
    workspaceStoreCache = empty
  }
  return workspaceStoreCache
}

function saveWorkspaceStore(store: WorkspaceStoreShape): void {
  workspaceStoreCache = store
  writeFileSync(workspaceStoreFile(), JSON.stringify(store, null, 2), 'utf-8')
}

/** 已知工作空间(目录已被用户删掉的条目顺手剔除,不让菜单里留下点不开的项)。 */
export function listWorkspaces(): WorkspaceEntry[] {
  const store = loadWorkspaceStore()
  const alive = store.list.filter((e) => existsSync(e.path))
  if (alive.length !== store.list.length) {
    saveWorkspaceStore({ ...store, list: alive })
  }
  return [...alive].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

/** 把一个目录登记为工作空间(已登记则只刷新最近使用时间)。 */
export function registerWorkspace(dir: string): WorkspaceEntry {
  const path = resolve(dir)
  const store = loadWorkspaceStore()
  const entry: WorkspaceEntry = {
    path,
    name: basename(path) || path,
    lastUsedAt: Date.now()
  }
  saveWorkspaceStore({
    ...store,
    list: [entry, ...store.list.filter((e) => resolve(e.path) !== path)]
  })
  return entry
}

/**
 * Windows 文件名保留字(不分大小写,带扩展名也算)。新建工作空间要挡住它们,
 * 否则 mkdir 会以一个费解的系统错误失败。
 */
const RESERVED_NAMES =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/**
 * 新建工作空间:在受管根目录下建同名文件夹并登记。
 *
 * 落点与一次性任务目录同一个根 —— 对齐 WorkBuddy 的
 * 「新建任务、工作空间时将自动存放在该路径下」(settings.workspacePath.description),
 * 它那边两者也都直接躺在 `~/WorkBuddy` 下。
 *
 * 校验口径与错误文案照抄它的 `taskStarter.createWorkspaceError.*`。
 */
export function createWorkspace(rawName: string): WorkspaceEntry {
  const name = rawName.trim()
  if (!name) {
    throw new Error('请输入工作空间名称')
  }
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) {
    throw new Error('名称不能包含 < > : " / \\ | ? * 等字符')
  }
  if (/[. ]$/.test(name)) {
    throw new Error('名称不能以“.”或空格结尾')
  }
  if (RESERVED_NAMES.test(name)) {
    throw new Error('该名称是系统保留名,请更换')
  }
  const dir = join(getWorkspaceDir(), name)
  if (existsSync(dir)) {
    throw new Error('同名工作空间已存在,请更换名称')
  }
  mkdirSync(dir, { recursive: true })
  return registerWorkspace(dir)
}

/**
 * 把任务绑到某个工作空间目录。传空即解绑(「不使用工作空间」——回到一次性受管目录)。
 * 幂等:同一任务重复发消息都会走到这里,重复绑定只刷新最近使用时间。
 */
export function bindTaskWorkspace(taskId: string, dir?: string): void {
  const store = loadWorkspaceStore()
  const bindings = { ...store.bindings }
  if (dir && dir.trim()) {
    const path = resolve(dir)
    mkdirSync(path, { recursive: true })
    bindings[taskId] = path
    saveWorkspaceStore({ ...store, bindings })
    registerWorkspace(path)
    return
  }
  if (taskId in bindings) {
    delete bindings[taskId]
    saveWorkspaceStore({ ...store, bindings })
  }
}

/** 该任务绑定的工作空间目录;没绑过(即「不使用工作空间」)返回 null。 */
export function getTaskWorkspaceBinding(taskId: string): string | null {
  const dir = loadWorkspaceStore().bindings[taskId]
  return dir ? dir : null
}

/** 删除任务时清掉它的绑定记录(只去记账,不碰用户的文件夹)。 */
export function clearTaskWorkspaceBinding(taskId: string): void {
  bindTaskWorkspace(taskId, undefined)
}

/**
 * 单个任务的受管工作区目录,也就是写进会话 `spawnedCwd` 的那个目录。
 *
 * 命名对齐 WorkBuddy:`YunwuDesktop/2026-07-31-16-01-23-f510`,按创建时间可读、可排序,
 * 而不是此前不透明的 `agents/t1785484671874f510`。时间从任务 id 内嵌的时间戳还原。
 *
 * 末尾保留 id 的 4 位随机后缀:秒级时间戳理论上可能撞车(同一秒内连开两个任务),
 * 撞车的后果是两个任务共用工作区、文件互相污染。加后缀即可无状态地保证唯一,
 * 且仍保持按时间排序。这是与 WorkBuddy 命名唯一的差异,值这 4 个字符。
 *
 * **存量任务不改名**:一任务一 agent 时代,这个路径被 `agents add --workspace` 写进过
 * openclaw.json,改名会让内核与我们指向两个不同目录(AGENTS.md/产出物全部错位)。
 * 因此只要旧目录还在就一直沿用;只有新建任务才落到新命名。不需要迁移脚本。
 *
 * 参数是**任务 id**,不是承载会话的 agent id —— 新模型下十个任务可能共用 `main`,
 * 拿 agent id 当键会让它们挤进同一个目录,那正是这次改造要消灭的串味。
 *
 * 任务选过工作空间就用那个目录。这一条必须在这里分叉、而不是只在建会话时传一次 cwd:
 * 「打开文件夹」「产出物越权校验」「每轮拼给模型的 [Working directory:]」全都从这个函数取值,
 * 漏掉任何一处,用户就会在自己的项目里干活、却在受管目录里找产物。
 */
export function getTaskWorkspaceDir(taskId: string): string {
  const bound = getTaskWorkspaceBinding(taskId)
  if (bound) {
    mkdirSync(bound, { recursive: true })
    return bound
  }
  return resolveManagedDir(taskId)
}

/**
 * 一个**真 agent** 自己的工作区:常驻专家 `expert-<slug>` 与专家团成员的
 * `AGENTS.md` 人设、`TOOLS.md` 工具规约落在这里,由内核按 agent 发现并注入系统提示。
 *
 * 与 `getTaskWorkspaceDir` 的路径规则相同(两类 id 不会撞),分成两个名字是为了在调用点
 * 就能看出你要的是「这个任务的产出目录」还是「这个 agent 的人设目录」——新模型下
 * 十个任务共用一个 agent,把两者混作一谈就会让所有任务的产出挤进专家的人设目录。
 */
export function getAgentWorkspaceDir(agentId: string): string {
  return resolveManagedDir(agentId)
}

/**
 * 受管目录的统一解析:旧目录还在就沿用(存量不改名),否则按内嵌时间戳落到可读命名,
 * 再不行退回 `agents/<id>`(专家、专家团成员这类没有时间戳的 id 走这条)。
 */
function resolveManagedDir(id: string): string {
  const root = join(app.getPath('documents'), 'YunwuDesktop')
  const legacy = join(root, 'agents', id)
  if (existsSync(legacy)) {
    return legacy
  }
  const createdAt = createdAtFromTaskId(id)
  const dir = createdAt ? join(root, `${timestampDirName(createdAt)}-${id.slice(-4)}`) : legacy
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 取某会话(任务)自己的工作区目录:能解析出任务 id 就用它的独立目录,
 * 否则回退到受管工作区根。用于「打开文件夹」时精准落到本任务的产物目录,
 * 而不是笼统地打开根目录(对齐 WorkBuddy「一次会话一个文件夹」的定位体验)。
 */
export function getSessionWorkspaceDir(sessionKey: string): string {
  const taskId = parseTaskSessionKey(sessionKey)?.taskId
  return taskId ? getTaskWorkspaceDir(taskId) : getWorkspaceDir()
}

/** 本地内核主配置文件路径(与内核默认存储布局一致)。 */
export function openclawConfigFile(): string {
  return join(homedir(), '.openclaw', 'openclaw.json')
}

/**
 * 解析某 agent 在**内核眼里**的 workspace。
 *
 * 引导文件(AGENTS.md / TOOLS.md / MEMORY.md)必须落在这个目录里才会被内核发现并注入
 * 系统提示,所以不能想当然地用我们的受管目录:内核默认 agent `main` 的 workspace 是
 * `~/.openclaw/workspace`(配置没写 workspace 时的内核默认,见 openclaw
 * `src/agents/agent-scope-config.ts`),而它正是现在所有普通任务挂靠的 agent。
 *
 * 我们自己建的专家 agent 在 `agents add` 时把 workspace 写成了受管目录,
 * 所以读配置这一条路对两者都成立,不必分支。
 */
export function resolveKernelWorkspaceDir(agentId: string): string {
  try {
    const raw = readFileSync(openclawConfigFile(), 'utf-8')
    const config = JSON.parse(raw) as {
      agents?: { list?: Array<{ id?: string; workspace?: string }> }
    }
    const hit = config.agents?.list?.find((e) => e?.id === agentId)?.workspace
    if (typeof hit === 'string' && hit.trim()) {
      return hit
    }
  } catch {
    /* 读不到配置就走下面的默认,反正内核也是这么兜的 */
  }
  return agentId === 'main' ? join(homedir(), '.openclaw', 'workspace') : getAgentWorkspaceDir(agentId)
}

/**
 * 把某会话的产出物路径解析成真实本地绝对路径(含越权校验)。
 * 供「在文件夹中显示 / reveal」与前端展示本地路径复用;解析失败会抛错。
 */
export function resolveAgentArtifactPath(sessionKey: string, filePath: string): string {
  return resolveArtifactAbs(sessionKey, filePath)
}

/** 产出物预览大小上限(512KB);超过只返回头部并标记 truncated。 */
const MAX_PREVIEW_BYTES = 512 * 1024

/**
 * 图片预览大小上限。
 *
 * 取内核对**生成图**的上限(DEFAULT_GENERATED_IMAGE_MAX_BYTES = 6MB,见 dist/run-attempt-*.js;
 * 它作为 maxBytes 传给 saveMediaBuffer,盖过媒体库默认的 5MB),内核存得下的图我们就该显示。
 * 一开始按媒体库那 5MB 写,会把合法的大图判成不可预览。
 *
 * 也不能沿用文本那 512KB:实测出一张 1024×1024 的 PNG 就有 916KB,那样一张都显示不出来。
 */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024

/**
 * 内核受管媒体库根目录。
 *
 * 为什么必须放进白名单:`image_generate` 生成的图不落在 agent workspace,而是由内核
 * `saveMediaBuffer` 存进媒体库(`<配置目录>/media/tool-image-generation/<uuid>.png`,
 * 口径见内核 resolveMediaDir = join(resolveConfigDir(), "media"))。只放行 workspace
 * 的话,agent 回复里给的图路径一律会被判成越权,用户点开只能看到「拒绝访问工作区以外的文件」。
 *
 * 放行它不扩大攻击面:这是内核自己写入的受管目录,不是模型能任意指定的位置;
 * 而下面 resolveArtifactAbs 的前缀校验仍然拦住穿越到别处的路径。
 */
function getKernelMediaDir(): string {
  return join(homedir(), '.openclaw', 'media')
}

/** 可文本预览的扩展名(其余按二进制处理,不返回正文)。 */
const TEXT_EXT =
  /\.(md|markdown|txt|json|jsonl|ya?ml|toml|ini|csv|tsv|log|html?|xml|svg|css|scss|less|js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|kt|c|h|cpp|hpp|cs|rb|php|sh|bat|ps1|sql|vue|astro|env|gitignore|dockerfile)$/i

/**
 * 把工具入参里的产出物路径解析成真实绝对路径,并做越权校验。
 * 绝对路径原样;相对路径挂到该任务的工作目录下。解析后必须落在
 * 「该任务工作目录」「承载它的 agent 的内核工作区」「受管工作区根」
 * 或「内核媒体库」之内,否则拒绝(避免被诱导读取任意本地文件)。
 *
 * 为什么要放行 agent 的内核工作区:普通任务改挂 `main` 之后,`MEMORY.md` / `USER.md`
 * 这些内核引导文件落在 `~/.openclaw/workspace`,而模型更新它们时会当成产出物报给界面。
 * 只放行任务目录的话,用户点开只能看到「拒绝访问工作区以外的文件」——2026-08-10 实测。
 * 放行它不扩大攻击面:那是内核按 agent 划定的受管目录,且下面的前缀校验照样拦住穿越。
 */
function resolveArtifactAbs(sessionKey: string, filePath: string): string {
  if (!filePath) {
    throw new Error('文件路径为空')
  }
  const parsed = parseTaskSessionKey(sessionKey)
  const taskDir = parsed ? getTaskWorkspaceDir(parsed.taskId) : ''
  const agentDir = parsed ? resolveKernelWorkspaceDir(parsed.agentId) : ''
  const managedRoot = getWorkspaceDir()
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(taskDir || managedRoot, filePath)

  const within = (root: string): boolean => {
    if (!root) {
      return false
    }
    const rel = relative(root, abs)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }
  if (
    !within(taskDir) &&
    !within(agentDir) &&
    !within(managedRoot) &&
    !within(getKernelMediaDir())
  ) {
    throw new Error('拒绝访问工作区以外的文件')
  }
  return abs
}

/**
 * 批量取产出物文件大小(产出物卡片的副标题要显示 "9.3 KB")。
 *
 * 单独开一个接口而不复用 readAgentArtifact:后者会把整份文件读进内存,
 * 而卡片只需要 stat 出来的字节数,一条消息几份产出物没必要为此读几百 KB 正文。
 * 取不到(已删除/越权)的条目直接跳过,由调用方按"无副标题"渲染,不报错打断。
 */
export function statAgentArtifacts(
  sessionKey: string,
  paths: string[]
): Array<{ path: string; size: number }> {
  const out: Array<{ path: string; size: number }> = []
  for (const p of paths) {
    try {
      const abs = resolveArtifactAbs(sessionKey, p)
      const st = statSync(abs)
      if (st.isFile()) {
        out.push({ path: p, size: st.size })
      }
    } catch {
      /* 单个取不到不影响其余 */
    }
  }
  return out
}

/**
 * 安全读取某会话产出的文件用于预览(对标 WorkBuddy present_files 的右侧预览)。
 *
 * 文本按 TEXT_EXT 白名单返回正文;图片返回 base64 字节,由渲染层转 Blob 展示
 * ——这是 WorkBuddy 的形状:它的 ImagePreviewComponent 接 `file`(Blob)时
 * `URL.createObjectURL` 并在清理时 revoke,内存可控且不必放宽 CSP(我们的
 * img-src 本来就含 blob:)。内核 control-ui 走的是网关上一条带票据的 HTTP 路由
 * (/__openclaw__/assistant-media),那是因为它跑在浏览器里读不到本地文件;
 * 我们是 Electron、与内核同机,这条差异是被它的运行环境逼出来的,不必照搬。
 *
 * 其余二进制既不返回正文也不返回字节,只带 size 让界面渲染成文件卡。
 */
export function readAgentArtifact(sessionKey: string, filePath: string): ArtifactContent {
  const name = basename(filePath) || filePath
  const abs = resolveArtifactAbs(sessionKey, filePath)
  if (!existsSync(abs)) {
    throw new Error('文件不存在(可能已被移动或删除)')
  }
  const st = statSync(abs)
  if (!st.isFile()) {
    throw new Error('目标不是文件')
  }
  const kind = mediaKindOf(name)
  if (kind === 'image') {
    // svg 归在图片扩展名里,但它同时是文本;体积也小,当图渲染即可(浏览器原生认)。
    if (st.size > MAX_IMAGE_BYTES) {
      return {
        name,
        path: filePath,
        abs,
        kind,
        content: '',
        previewable: false,
        truncated: true,
        size: st.size
      }
    }
    return {
      name,
      path: filePath,
      abs,
      kind,
      content: '',
      imageBase64: readFileSync(abs).toString('base64'),
      previewable: true,
      truncated: false,
      size: st.size
    }
  }
  if (!TEXT_EXT.test(name)) {
    return {
      name,
      path: filePath,
      abs,
      kind,
      content: '',
      previewable: false,
      truncated: false,
      size: st.size
    }
  }
  const raw = readFileSync(abs)
  const truncated = raw.length > MAX_PREVIEW_BYTES
  const content = raw.subarray(0, MAX_PREVIEW_BYTES).toString('utf-8')
  return { name, path: filePath, abs, kind, content, previewable: true, truncated, size: st.size }
}
