import { homedir } from 'os'
import { basename, join } from 'path'
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  renameSync,
  statSync,
  writeFileSync
} from 'fs'
import AdmZip from 'adm-zip'
import type { MarketAssetType, MarketInstalledItem, MarketItem } from '@shared/types'
import { getDownloadInfo } from './market-client'

/**
 * 市场资产安装器(第一期:技能)。
 *
 * 技能安装路径 = ~/.openclaw/skills/<slug>/,内核 chokidar 监听该目录自动扫描加载,
 * 无需重启网关。每个安装目录写入 _yunwu_meta.json 标识来源与版本,用于:
 *  - 列出"我方市场安装"的技能(与内核自带/用户手放的技能区分);
 *  - 判断已安装/可更新;卸载时安全删除。
 */

const META_FILE = '_yunwu_meta.json'
const SOURCE_TAG = 'yunwu-market'

/** 本地安装元信息(落盘在每个技能目录下)。 */
export interface InstalledMeta {
  id: number
  type: MarketAssetType
  slug: string
  name: string
  version: string
  installedAt: number
  source: string
  /**
   * 用户在技能市场/本地上传主动装的。这类技能**全局可见**,对应 WorkBuddy 里那批
   * 常驻启用的 builtin 插件技能。与 bundledBy 不互斥:两者都有时按 direct 优先。
   */
  direct?: boolean
  /**
   * 把这个技能带进来的专家 slug。专家捆绑技能**不进全局名录**,只在该专家的会话里
   * 由人设插件注入(见 skill-visibility.ts 的模块头)。空数组表示曾是捆绑技能但
   * 带它进来的专家都卸载了 —— 那是回收的判据。
   */
  bundledBy?: string[]
}

/** ~/.openclaw/skills 根目录(不存在则创建)。 */
function skillsDir(): string {
  const dir = join(homedir(), '.openclaw', 'skills')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 某技能的安装目录。 */
function skillTargetDir(slug: string): string {
  return join(skillsDir(), slug)
}

/** 计算 buffer 的 sha256 十六进制。 */
function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** 判断目录是否直接包含 SKILL.md(大小写不敏感)。 */
function hasSkillMd(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => f.toLowerCase() === 'skill.md')
  } catch {
    return false
  }
}

/** 同步等待(重试退避用)。安装链路是同步语义,不为几百毫秒的退避引入 async 传染。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 删除目录,带内建重试:句柄未释放时 Windows 会短暂 EPERM/EBUSY。 */
function rmDirRobust(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 })
}

/**
 * 把解压好的技能根「原子换入」到 target。
 *
 * 为什么不能用「先 rmSync(target) 再 renameSync」(这是本函数替换掉的旧实现):
 * target 位于内核 chokidar 监听的 skills/ 下,Windows 上 ReadDirectoryChangesW 会持有目录
 * 句柄。此时 RemoveDirectory **成功返回但进入 delete-pending**——目录名仍占着命名空间,
 * 而此后任何 open 都返回 ACCESS_DENIED。于是紧随其后的 rename 撞名失败,留下一个
 * 「看得见、读不动」的僵尸目录,persona 因此读空、专家退化成通用助手。
 * POSIX 下 unlink 立即摘名,没有这个状态,所以旧实现在 mac/Linux 上一直是对的。
 *
 * 改为「改名让位」:先把旧目录 rename 成点号前缀的墓地名。以 FILE_SHARE_DELETE 打开的
 * 句柄(chokidar 即是)不阻止 rename,故这一步能立刻腾出名字;旧目录随后在无人取用的
 * 名字下自然消亡。换入的 rename 再加重试,以吸收杀软/索引器扫描新解压文件造成的瞬时加锁。
 */
function swapIntoPlace(root: string, target: string): void {
  if (existsSync(target)) {
    const grave = join(skillsDir(), `.trash-${basename(target)}-${Date.now()}`)
    try {
      renameSync(target, grave)
      // 墓地清理失败无妨:点号前缀不会被安装列表与内核技能扫描取用,留待启动清扫。
      try {
        rmDirRobust(grave)
      } catch {
        /* 仍被占用,交给 sweepStaleInstallDirs */
      }
    } catch {
      // 让位失败(跨卷、或句柄未带 SHARE_DELETE):退回直接删除 + 重试。
      try {
        rmDirRobust(target)
      } catch {
        /* 两条路都不通,留给下面的换入重试给出可操作的报错 */
      }
    }
  }
  let lastErr: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      renameSync(root, target)
      return
    } catch (err) {
      lastErr = err
      sleepSync(120)
    }
  }
  // 走到这里通常是 target 名字已被一个 delete-pending 目录占住:该状态下连 rename 都会被
  // 拒(rename 需要 open 源目录),且只有持有句柄的进程(内核)退出后才解除,代码内无解,
  // 故给出可操作的提示而不是抛原始 errno。
  const code = (lastErr as NodeJS.ErrnoException)?.code ?? 'UNKNOWN'
  throw new Error(
    `技能目录被占用,无法写入(${code}):${target}。` +
      `请完全退出云雾桌面端(确认内核进程一并结束)后重新安装;若仍失败,请检查杀毒软件。`
  )
}

/**
 * 安装后回读校验:确认 target 内确有非空 SKILL.md。
 *
 * 历史事故:僵尸目录令 rename 失败,而失败被上层吞掉、安装"成功"返回,直到运行时
 * persona 读空才以「专家变成通用助手」的形式暴露——隔着好几层,极难归因。
 * 这里把故障提前到安装这一步暴露成明确错误。
 */
function verifyInstalled(target: string, slug: string): void {
  if (!readSkillMdRaw(target).trim()) {
    throw new Error(`技能「${slug}」安装校验失败:目录内未找到可读的 SKILL.md`)
  }
}

/**
 * 清扫 skills/ 下遗留的临时目录与墓地目录(.tmp-* / .trash-*)。
 * 安装中途崩溃、或墓地目录当时仍被句柄占用,都会留下残骸;启动时句柄多已释放,可安全回收。
 * 只动我方点号前缀的目录,不触碰用户手放/内核自带技能。失败不影响主流程。
 */
export function sweepStaleInstallDirs(): void {
  const root = skillsDir()
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  for (const name of entries) {
    if (!name.startsWith('.tmp-') && !name.startsWith('.trash-')) {
      continue
    }
    try {
      rmDirRobust(join(root, name))
    } catch {
      /* 仍被占用:留到下次启动 */
    }
  }
}

/**
 * 读某目录下的 SKILL.md 原文(大小写不敏感)。读不到返回空串,但**区分原因打日志**:
 * ENOENT 是正常的「未安装」,EPERM/EACCES 则说明目录被占用或处于 delete-pending 的
 * 异常态。二者过去都被静默吞成空串,是僵尸目录长期无从察觉的根因。
 */
function readSkillMdRaw(dir: string): string {
  // 先直读约定文件名:少一次目录枚举,且能拿到更精确的 errno。
  const direct = join(dir, 'SKILL.md')
  try {
    return readFileSync(direct, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.warn(`[skill] 读取 ${direct} 失败(${code}):目录可能被占用或处于删除挂起状态`)
      return ''
    }
  }
  // 直读 ENOENT:可能是大小写不同(skill.md),退回枚举。
  try {
    const f = readdirSync(dir).find((x) => x.toLowerCase() === 'skill.md')
    return f ? readFileSync(join(dir, f), 'utf-8') : ''
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.warn(`[skill] 枚举 ${dir} 失败(${code}):目录可能被占用或处于删除挂起状态`)
    }
    return ''
  }
}

/**
 * 在解压出的临时目录里定位"技能根"(直接含 SKILL.md 的目录)。
 * 兼容两种打包约定:zip 根即技能根 / zip 根下只有一个技能子目录。
 * 找不到时回退临时目录本身(best-effort)。
 */
function locateSkillRoot(tempDir: string): string {
  if (hasSkillMd(tempDir)) {
    return tempDir
  }
  let entries: string[]
  try {
    entries = readdirSync(tempDir)
  } catch {
    return tempDir
  }
  const subDirs = entries.filter((e) => {
    try {
      return statSync(join(tempDir, e)).isDirectory()
    } catch {
      return false
    }
  })
  if (subDirs.length === 1) {
    const only = join(tempDir, subDirs[0])
    if (hasSkillMd(only)) {
      return only
    }
  }
  return tempDir
}

/**
 * 下载市场条目的 zip 制品并原子安装到 `~/.openclaw/skills/<targetSlug>/`。
 *
 * 通用核心(技能与专家 persona 共用):技能直接以自身 slug 安装;专家的 persona 包
 * 以其 personaSkillSlug 安装(metaType='expert' 便于列表/卸载区分来源)。
 * 流程:换取下载 URL → 下载 zip → 校验 sha256 → 解压临时目录 → 定位技能根 →
 * 原子替换到 skills/<targetSlug>/ → 写入安装元信息。返回安装目标目录。
 */
export async function installArtifactToSkills(
  item: MarketItem,
  targetSlug: string,
  metaType: MarketAssetType,
  direct = false
): Promise<string> {
  const info = await getDownloadInfo(item.type, item.slug)

  // 下载 zip。
  let buf: Buffer
  try {
    const resp = await fetch(info.url)
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`)
    }
    buf = Buffer.from(await resp.arrayBuffer())
  } catch (err) {
    throw new Error(`下载失败: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 校验完整性(后端提供 sha256 时)。
  if (info.sha256 && sha256Hex(buf) !== info.sha256) {
    throw new Error('制品校验失败(sha256 不匹配),已中止安装')
  }

  // 解压到临时目录(与目标同卷,便于后续 rename 原子替换)。
  const tempDir = join(skillsDir(), `.tmp-${targetSlug}-${Date.now()}`)
  const target = skillTargetDir(targetSlug)
  // 换入会整目录替换,可见性归属(谁装的、哪些专家带的)必须先取出来再写回去,
  // 否则一次自动更新就会把捆绑技能重新放回全局名录。
  const prev = readSkillMeta(targetSlug)
  try {
    mkdirSync(tempDir, { recursive: true })
    new AdmZip(buf).extractAllTo(tempDir, true)
    const root = locateSkillRoot(tempDir)

    // 替换目标目录(Windows delete-pending 安全,见 swapIntoPlace 注释)。
    swapIntoPlace(root, target)
    verifyInstalled(target, targetSlug)

    // 写入安装元信息。
    const meta: InstalledMeta = {
      id: item.id,
      type: metaType,
      slug: targetSlug,
      name: item.name,
      version: info.version || item.version || '',
      installedAt: Date.now(),
      source: SOURCE_TAG,
      ...(prev?.direct ? { direct: true } : {}),
      ...(prev?.bundledBy ? { bundledBy: prev.bundledBy } : {}),
      ...(direct ? { direct: true } : {})
    }
    writeFileSync(join(target, META_FILE), JSON.stringify(meta, null, 2), 'utf-8')
    return target
  } finally {
    // 清理临时目录(root 若已被 rename 走则 tempDir 可能已空;force 忽略不存在)。
    try {
      rmDirRobust(tempDir)
    } catch {
      /* 残骸交给 sweepStaleInstallDirs,不掩盖 try 块里的真实错误 */
    }
  }
}

/**
 * 下载并安装一个技能条目(薄封装:以条目自身 slug 安装,meta 标记为 skill)。
 *
 * `direct` 区分安装来源,决定这个技能进不进全局技能名录:用户在市场点安装是 direct,
 * 跟着专家装进来的不是(见 skill-visibility.ts)。自动更新走默认值,不会改写既有归属
 * —— 那个判断在 installArtifactToSkills 里按旧 meta 继承。
 */
export async function installSkill(item: MarketItem, direct = false): Promise<void> {
  if (item.type !== 'skill') {
    throw new Error('installSkill 仅接受「技能」类型条目')
  }
  await installArtifactToSkills(item, item.slug, 'skill', direct)
}

/** slug 归一:仅保留字母数字及 . _ -,兜底为 skill。 */
function sanitizeSkillSlug(raw: string): string {
  const s = raw
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'skill'
}

/**
 * 本地直装一个技能(不经下载/对象存储):把 SKILL.md 正文写入 skills/<slug>/,
 * 供「AI 生成技能」落地 —— 内核 chokidar 自动扫描即用。meta 标记 source=yunwu-market
 * 且 generated=true,使其与市场安装项一同出现在「已安装」,并可被安全卸载。
 * 目标已存在则覆盖(支持重新生成)。返回安装目录。
 */
export function installLocalSkill(slug: string, name: string, skillMd: string): string {
  const safe = sanitizeSkillSlug(slug)
  const target = skillTargetDir(safe)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'SKILL.md'), skillMd, 'utf-8')
  const meta: InstalledMeta & { generated?: boolean } = {
    id: 0,
    type: 'skill',
    slug: safe,
    name: name || safe,
    version: '',
    installedAt: Date.now(),
    source: SOURCE_TAG,
    generated: true,
    direct: true
  }
  writeFileSync(join(target, META_FILE), JSON.stringify(meta, null, 2), 'utf-8')
  return target
}

/** 从技能根目录的 SKILL.md frontmatter 解析 name 字段;失败返回空。 */
function parseSkillMdName(dir: string): string {
  const fm = readSkillMdRaw(dir).match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) {
    return ''
  }
  const nm = fm[1].match(/^\s*name\s*:\s*(.+?)\s*$/m)
  return nm ? nm[1].trim().replace(/^["']|["']$/g, '') : ''
}

/**
 * 从本地 zip 安装一个技能(对齐 WorkBuddy「上传技能」)。
 * 读文件 → AdmZip 解压临时目录 → 定位技能根(须含 SKILL.md)→
 * slug 取 frontmatter name 或 zip 文件名归一 → 原子替换到 skills/<slug>/ →
 * 写 meta(source=yunwu-market, local=true)。返回 {slug,name}。
 */
export function installSkillFromLocalZip(filePath: string): {
  slug: string
  name: string
} {
  if (!filePath || !existsSync(filePath)) {
    throw new Error('文件不存在')
  }
  if (!/\.zip$/i.test(filePath)) {
    throw new Error('请选择 .zip 技能包')
  }
  let buf: Buffer
  try {
    buf = readFileSync(filePath)
  } catch (err) {
    throw new Error(`读取文件失败: ${err instanceof Error ? err.message : String(err)}`)
  }
  const fileBase = basename(filePath).replace(/\.zip$/i, '')
  const tmp = join(skillsDir(), `.tmp-upload-${Date.now()}`)
  try {
    mkdirSync(tmp, { recursive: true })
    try {
      new AdmZip(buf).extractAllTo(tmp, true)
    } catch (err) {
      throw new Error(
        `不是有效的 zip 文件: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    const root = locateSkillRoot(tmp)
    if (!hasSkillMd(root)) {
      throw new Error('zip 内未找到 SKILL.md,无法作为技能安装')
    }
    const name = parseSkillMdName(root) || fileBase
    const slug = sanitizeSkillSlug(name || fileBase)
    const target = skillTargetDir(slug)
    swapIntoPlace(root, target)
    verifyInstalled(target, slug)
    const meta: InstalledMeta & { local?: boolean } = {
      id: 0,
      type: 'skill',
      slug,
      name,
      version: '',
      installedAt: Date.now(),
      source: SOURCE_TAG,
      local: true,
      direct: true
    }
    writeFileSync(join(target, META_FILE), JSON.stringify(meta, null, 2), 'utf-8')
    return { slug, name }
  } finally {
    try {
      rmDirRobust(tmp)
    } catch {
      /* 残骸交给 sweepStaleInstallDirs */
    }
  }
}

/**
 * 安全删除一个安装在 skills/<slug> 下的目录:仅删除带我方 meta 的目录,
 * 避免误删用户手放/内核自带技能。技能与专家 persona 共用(卸载复用)。
 * 目标不存在时静默返回(幂等)。
 */
export function removeInstalledSkillDir(slug: string): void {
  const target = skillTargetDir(slug)
  const metaPath = join(target, META_FILE)
  if (!existsSync(target)) {
    return
  }
  if (!existsSync(metaPath)) {
    throw new Error('该目录非由市场安装,拒绝删除')
  }
  rmDirRobust(target)
}

/** 已安装技能的绝对目录(注入 `<location>` 时要给模型绝对路径,内核自己也是这么给的)。 */
export function installedSkillDir(slug: string): string {
  return skillTargetDir(slug)
}

/** 读某个已安装目录的 meta;不存在或损坏返回 null。 */
export function readSkillMeta(slug: string): InstalledMeta | null {
  try {
    const meta = JSON.parse(
      readFileSync(join(skillTargetDir(slug), META_FILE), 'utf-8')
    ) as InstalledMeta
    return meta.source === SOURCE_TAG ? meta : null
  } catch {
    return null
  }
}

/** 局部更新 meta(目录不存在或非我方安装时静默跳过)。 */
export function patchSkillMeta(slug: string, patch: Partial<InstalledMeta>): void {
  const meta = readSkillMeta(slug)
  if (!meta) {
    return
  }
  writeFileSync(
    join(skillTargetDir(slug), META_FILE),
    JSON.stringify({ ...meta, ...patch }, null, 2),
    'utf-8'
  )
}

/** 列出所有由我方安装的目录(含专家 persona 包,按 meta.type 区分)。 */
export function listMarketInstalledMetas(): InstalledMeta[] {
  let entries: string[]
  try {
    entries = readdirSync(skillsDir())
  } catch {
    return []
  }
  const out: InstalledMeta[] = []
  for (const name of entries) {
    if (name.startsWith('.')) {
      continue
    }
    const meta = readSkillMeta(name)
    if (meta) {
      out.push({ ...meta, slug: meta.slug || name })
    }
  }
  return out
}

/**
 * 取 frontmatter 里一个标量字段的值,支持 YAML 的折叠/字面块(`>-`、`|`)与缩进续行。
 *
 * 不能只取冒号后面那一截:本机 122 个技能里大半的 description 写成 `description: >-`
 * 加下面几行缩进正文,只读首行会得到一个字面的 `>-`。注入给模型的卡片里出现这种东西,
 * 它就完全判断不了这个技能是干嘛的 —— 比不给还糟。
 */
function frontmatterValue(fm: string, key: string): string {
  const lines = fm.split(/\r?\n/)
  const idx = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l))
  if (idx < 0) {
    return ''
  }
  const head = lines[idx].slice(lines[idx].indexOf(':') + 1).trim()
  const parts = /^[|>][-+\d]*$/.test(head) ? [] : [head]
  for (let i = idx + 1; i < lines.length; i++) {
    // 顶格的都是下一个键(YAML 的续行必须缩进),遇到就停。
    if (/^\S/.test(lines[i])) {
      break
    }
    parts.push(lines[i].trim())
  }
  return parts
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["']|["']$/g, '')
}

/** 读 SKILL.md frontmatter 里的 name / description(注入技能卡片要用)。读不到返回 null。 */
export function readSkillHeader(slug: string): { name: string; description: string } | null {
  const fm = readSkillMdRaw(skillTargetDir(slug)).match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) {
    return null
  }
  const description = frontmatterValue(fm[1], 'description')
  return description ? { name: frontmatterValue(fm[1], 'name') || slug, description } : null
}

/**
 * 开关「这个技能进不进模型看到的全局技能名录」。
 *
 * 落点是 SKILL.md frontmatter 的 `disable-model-invocation` —— 内核官方字段,
 * 只影响 `<available_skills>` 的展示(`openclaw/src/skills/loading/session.ts:294`、
 * `workspace.ts:1260`),**执行期没有任何拦截**:2026-08-11 真机验过,藏起来的技能
 * 只要在提示词里给出路径,模型照样 read 它的 SKILL.md 并照做。
 *
 * 只动带我方 meta 的目录(内核自带的 docx/pdf/pptx 之类混在同一个目录下,碰不得)。
 * 返回是否真的改了文件,便于调用方只在有变化时打日志。
 */
export function setSkillModelVisible(slug: string, visible: boolean): boolean {
  if (!readSkillMeta(slug)) {
    return false
  }
  const dir = skillTargetDir(slug)
  const raw = readSkillMdRaw(dir)
  const fm = raw.match(/^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---)/)
  if (!fm) {
    return false
  }
  const has = /^\s*disable-model-invocation\s*:/m.test(fm[2])
  if (has === !visible) {
    return false
  }
  const next = visible
    ? raw.replace(/\r?\n[ \t]*disable-model-invocation\s*:[^\r\n]*/, '')
    : raw.replace(fm[0], `${fm[1]}${fm[2]}\ndisable-model-invocation: true${fm[3]}`)
  // 文件名大小写照原样写回:readSkillMdRaw 允许 skill.md,按 SKILL.md 写会多出一份。
  const actual = readdirSync(dir).find((f) => f.toLowerCase() === 'skill.md') ?? 'SKILL.md'
  writeFileSync(join(dir, actual), next, 'utf-8')
  return true
}

/** 卸载技能:仅删除由我方市场安装(带匹配 meta)的目录,避免误删用户手放技能。 */
export function uninstallSkill(type: MarketAssetType, slug: string): void {
  if (type !== 'skill') {
    throw new Error('uninstallSkill 仅接受「技能」类型条目')
  }
  removeInstalledSkillDir(slug)
}

/**
 * 判断某 slug 是否已由市场安装。判据是「SKILL.md 可读且非空」而非仅目录存在:
 * 僵尸目录(delete-pending)下 existsSync 的结果不可靠,而把它判为「未安装」正好能触发
 * 重装自愈——重装走 swapIntoPlace,能越过僵尸目录。
 */
export function isMarketSkillInstalled(slug: string): boolean {
  const target = skillTargetDir(slug)
  return existsSync(join(target, META_FILE)) && Boolean(readSkillMdRaw(target).trim())
}

/**
 * 读取已安装 skills/<slug>/SKILL.md 的正文(去除 YAML frontmatter)。
 * 用于专家播种:把 persona 正文写入任务 agent workspace 的 AGENTS.md 强化角色设定。
 * 找不到或读失败返回空字符串(读失败会在 readSkillMdRaw 里带 errno 告警)。
 */
export function readInstalledSkillMd(slug: string): string {
  const raw = readSkillMdRaw(skillTargetDir(slug))
  // 去掉开头的 --- frontmatter --- 块(若存在),只保留 persona 正文。
  const fm = raw.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return (fm ? raw.slice(fm[0].length) : raw).trim()
}

/**
 * 读取专家团 persona 包里某成员的人设(`skills/<personaSkillSlug>/members/<id>.md`)。
 *
 * 成员人设随团队包一起下发,不是独立安装的技能,所以走这条专门的读法而非 readInstalledSkillMd。
 * memberId 来自服务端 manifest,仍在此做一次路径片段校验:它会被拼进文件路径,放过
 * `../` 就等于让市场数据决定读哪个文件。
 */
export function readInstalledTeamMemberMd(personaSkillSlug: string, memberId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(memberId) || memberId.startsWith('.')) {
    console.warn(`[persona] 成员 id 不合法,拒绝读取:${memberId}`)
    return ''
  }
  const p = join(skillTargetDir(personaSkillSlug), 'members', `${memberId}.md`)
  let raw: string
  try {
    raw = readFileSync(p, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.warn(`[persona] 读取 ${p} 失败(${code})`)
    }
    return ''
  }
  const fm = raw.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return (fm ? raw.slice(fm[0].length) : raw).trim()
}

/**
 * 列出本地已由市场安装的技能(读各目录的 _yunwu_meta.json)。
 *
 * 默认**不含**专家捆绑技能:它们是专家的组成部分,跟着专家装、跟着专家卸,单独列出来
 * 用户会以为自己能用能删(实际它们只在该专家的会话里可见,见 skill-visibility.ts)。
 * WorkBuddy 那边同理,专家插件里的技能不出现在技能列表中。
 * 自动更新要的是「所有能回市场查版本的」,所以那条路径传 includeBundled。
 */
export function listInstalledSkills(
  type: MarketAssetType,
  includeBundled = false
): MarketInstalledItem[] {
  if (type !== 'skill') {
    return []
  }
  const root = skillsDir()
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const out: MarketInstalledItem[] = []
  for (const name of entries) {
    if (name.startsWith('.')) {
      continue
    }
    const metaPath = join(root, name, META_FILE)
    if (!existsSync(metaPath)) {
      continue
    }
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as InstalledMeta
      if (meta.source !== SOURCE_TAG) {
        continue
      }
      // 专家 persona 也以技能形式落在同一目录下(meta.type='expert'),但它是专家的实现细节:
      // 既不该出现在「已安装技能」列表里,也不该被当成市场技能去回查更新(市场里没有它的
      // skill 条目,回查必然报"条目不存在"),故按 meta.type 排除。
      if (meta.type !== 'skill') {
        continue
      }
      if (!includeBundled && !meta.direct && meta.bundledBy?.length) {
        continue
      }
      out.push({
        type: 'skill',
        slug: meta.slug || name,
        name: meta.name || name,
        version: meta.version || '',
        installedAt: meta.installedAt || 0
      })
    } catch {
      /* 损坏的 meta 跳过 */
    }
  }
  return out
}
