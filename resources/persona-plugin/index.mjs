/**
 * 云雾专家人设插件 —— 按**会话**给系统提示词追加专家人设。
 *
 * 两条路由:任务会话按键里的专家段认人(`agent:main:acp:e-<slug>-<taskId>`),
 * 专家团成员的子会话按 spawn 的 `label` 认人(键里没有身份,只能靠事件记账)。
 *
 * 为什么需要它、验证过程与内核依据,见 `src/main/persona-bundle.ts` 的模块头。
 * 这里只记三条改这个文件时必须知道的事:
 *
 * 1. **不要用顶层 await**(含顶层 `await import(...)`)。内核加载插件入口时会把它转成
 *    CommonJS,顶层 await 直接报 `SyntaxError: await is only valid in async functions`,
 *    而且只出现在网关日志里 —— 表现是插件静默不生效(2026-08-10 真机踩过)。
 *    静态 import 是可以的。
 *
 * 2. **manifest 里的 `activation.onCapabilities: ["hook"]` 是这个插件能被加载的前提**,
 *    删了它插件就静默失效(`plugins list` 仍显示 enabled,但网关不会加载)。理由见
 *    `src/main/persona-bundle.ts` 模块头。
 *
 * 3. **这份源码刻意放在 resources 下,而不是写在主进程的模板字符串里。**
 *    electron-vite 用正则找产物里「最后一条 import 语句」来决定 CommonJS 垫片插在哪儿,
 *    它分不清代码和字符串:把带 import 的插件源码塞进模板串,垫片就会落进字符串内部,
 *    主进程模块作用域里的 __dirname 随之消失 —— 表现为 createWindow 抛 ReferenceError、
 *    主窗口整个建不出来(同一天也踩过)。当成文件发就没有这一类问题。
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 人设数据由主进程写在插件目录里(见 persona-bundle.ts 的 syncPersonaData)。 */
const DATA = join(dirname(fileURLToPath(import.meta.url)), 'personas.json')

/**
 * 会走后台任务 + 完成投递的媒体工具。`tts` 不在这里:它是同步返回的,不进任务台账。
 * `music_generate` 我们还没有 provider,先列上——有了也不必再改这里。
 */
const MEDIA_TOOLS = new Set(['image_generate', 'video_generate', 'music_generate'])

/**
 * 媒体工具 → 我们自己那个 provider 的 id(插件注册的,见 resources/yunwu-video-plugin)。
 * 用来纠正模型自己编的前缀,见 before_tool_call 那段。`music_generate` 我们还没有 provider,
 * 不列进来 —— 纠成一个不存在的 provider 只会把报错变得更难懂。
 */
const MEDIA_TOOL_PROVIDERS = {
  image_generate: 'yunwu-image',
  video_generate: 'yunwu-video'
}

/**
 * 媒体任务记账目录(主进程 `media-relay.ts` 监听它)。
 *
 * 放在内核的配置目录下而不是应用 userData:写它的是**内核进程**里的插件,
 * 而内核只认得 `~/.openclaw`;主进程反过来读它没有任何障碍。
 */
const MEDIA_TASK_DIR = join(homedir(), '.openclaw', 'yunwu-media-tasks')

/** 任务工作目录表,同样由主进程写(见 persona-bundle.ts 的 syncTaskWorkspaceData)。 */
const WORKSPACES = join(dirname(fileURLToPath(import.meta.url)), 'workspaces.json')

let cache = { mtime: -1, data: { experts: {}, members: {} } }
let wsCache = { mtime: -1, data: { enabled: true, dataFolderName: '.yunwu-desktop', dirs: {} } }

/** 按 mtime 判断要不要重读:钩子每轮都会调,不能每次解析 400KB。 */
function personas() {
  try {
    const mtime = statSync(DATA).mtimeMs
    if (mtime !== cache.mtime) {
      cache = { mtime, data: JSON.parse(readFileSync(DATA, 'utf8')) }
    }
  } catch {
    // 还没写出来,或正被替换:沿用上一份缓存,拿不到就是空表(等于不注入)。
  }
  return cache.data
}

/** 同上,只是这份小得多(一个任务一行)。 */
function taskWorkspaces() {
  try {
    const mtime = statSync(WORKSPACES).mtimeMs
    if (mtime !== wsCache.mtime) {
      wsCache = { mtime, data: JSON.parse(readFileSync(WORKSPACES, 'utf8')) }
    }
  } catch {
    /* 同 personas():拿不到就当没有,等于不注入项目级记忆 */
  }
  return wsCache.data
}

/**
 * `agent:main:acp:e-<slug>-<taskId>` -> slug。
 *
 * 与 `src/shared/session-key.ts` 的 `taskSessionKey` **同源**,是一处跨进程的隐式契约,
 * 类型系统管不到,改一边必须改另一边。
 *
 * 刻意**只**认带 `e-` 前缀的键:存量专家任务的键是 `agent:expert-<slug>:acp:<taskId>`,
 * 它们的人设已经在那个 agent 的 AGENTS.md 里,再注入一遍就是同一份人设进两次提示词。
 */
function expertSlugOf(sessionKey) {
  const m = /^agent:[^:]+:acp:e-(.+)-[^-]+$/.exec(sessionKey ?? '')
  return m ? m[1] : ''
}

/**
 * `agent:main:acp:<taskId>` / `agent:main:acp:e-<slug>-<taskId>` -> taskId。
 *
 * 与 `src/shared/session-key.ts` 的 `parseTaskSessionKey` 同源,同一处跨进程隐式契约。
 * 认不出来就返回空串 —— 专家团成员的子会话(`agent:main:subagent:<uuid>`)正好落在这里,
 * 它们**刻意不注入**项目级记忆:成员的产出会回到负责人,由负责人统一落一条日志,
 * 几个成员各自往同一个当天日志追加只会写花。
 */
function taskIdOf(sessionKey) {
  const m = /^agent:[^:]+:acp:(.+)$/.exec(sessionKey ?? '')
  if (!m) {
    return ''
  }
  const tail = m[1]
  if (!tail.startsWith('e-')) {
    return tail
  }
  const cut = tail.lastIndexOf('-')
  return cut > 1 ? tail.slice(cut + 1) : ''
}

/**
 * 取 frontmatter 里一个标量字段,支持 YAML 折叠/字面块(`>-`、`|`)与缩进续行。
 *
 * 与主进程 `market/installer.ts:frontmatterValue` 同一份实现。刻意抄一遍而不是共享:
 * 插件是独立发的资源文件,不能 import 主进程模块。只取冒号后那一截会得到字面的 `>-`,
 * 注进卡片里比不给还糟。
 */
function frontmatterValue(fm, key) {
  const lines = fm.split(/\r?\n/)
  const idx = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l))
  if (idx < 0) {
    return ''
  }
  const head = lines[idx].slice(lines[idx].indexOf(':') + 1).trim()
  const parts = /^[|>][-+\d]*$/.test(head) ? [] : [head]
  for (let i = idx + 1; i < lines.length; i++) {
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

/** XML 转义,与内核 `escapeXml` 同口径。 */
function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 注入的项目记忆正文上限,取 WorkBuddy 的 `MAX_MEMORY_CHARS = 8e3`。 */
const MAX_MEMORY_CHARS = 8000

/**
 * 项目级技能:`<工作目录>/<数据目录>/skills/<技能>/SKILL.md`。
 *
 * **内核不会自己发现它们** —— 技能根只有 agent workspace、`~/.openclaw/skills`、
 * `~/.agents/skills` 和配置里的 `skills.load.extraDirs`
 * (`openclaw/src/skills/runtime/refresh.ts:100-117`),没有一条跟 cwd 走;而 extraDirs
 * 是全局配置,为一个工作空间去写它会波及所有会话。所以照我们注入专家技能的老路来:
 * 卡片形状与 `market/skill-visibility.ts:expertSkillsSection` 一致,模型在同一份提示词里
 * 见过内核那份名录,形状一样才认得是同一类东西。
 *
 * 每轮现读不做缓存:一个项目的技能通常个位数,而用户随时可能新增一个,
 * 缓存换来的那点开销远不如"加了技能却要重启才生效"来得贵。
 */
function projectSkillsSection(skillsDir) {
  let entries = []
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch {
    return ''
  }
  const cards = []
  for (const name of entries) {
    try {
      const file = join(skillsDir, name, 'SKILL.md')
      const fm = readFileSync(file, 'utf8').match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/)
      if (!fm) {
        continue
      }
      const description = frontmatterValue(fm[1], 'description')
      if (!description) {
        // 读不出 description 的不给:模型判断不了何时该用,白占提示词(内核同规矩)。
        continue
      }
      cards.push({ name: frontmatterValue(fm[1], 'name') || name, description, location: file })
    } catch {
      /* 单个技能读不出来不影响其余 */
    }
  }
  if (cards.length === 0) {
    return ''
  }
  const lines = [
    '',
    '',
    'The following skills come from the current project workspace and are available only in this project.',
    "Use the read tool to load a skill's file when the task matches its description.",
    '',
    '<available_skills>'
  ]
  for (const card of cards) {
    lines.push('  <skill>')
    lines.push(`    <name>${escapeXml(card.name)}</name>`)
    lines.push(`    <description>${escapeXml(card.description)}</description>`)
    lines.push(`    <location>${escapeXml(card.location)}</location>`)
    lines.push('  </skill>')
  }
  lines.push('</available_skills>')
  return lines.join('\n')
}

/**
 * 项目级记忆 + 项目级技能的注入段。
 *
 * # 为什么只能靠注入
 *
 * 内核的记忆文件是按 **agent 的 workspace** 解析的
 * (`openclaw/src/memory/root-memory-files.ts:12-14`),而 `spawnedWorkspaceDir` 在
 * `chat.send` 这条路上不覆盖 run 的 workspace(只有 `agent` RPC 且带 `spawnedBy` 才覆盖,
 * `server-methods/agent.ts:2717-2724`)。也就是说所有任务共用 `main` 的那份记忆,
 * 换工作空间不会换记忆。想让它跟着走,内核里唯一的原生形状是「一个工作空间一个 agent」,
 * 而那正是我们刚砍掉的东西(预热 ≈ agent 数 × 供货商数)。
 *
 * # 形状照 WorkBuddy,因为它自己也是这么做的
 *
 * 它的项目记忆同样不是内核机制,而是模板变量:`{{ WorkbuddyMemory_1 }}` 是说明,
 * `{{ WorkingMemoryContent }}` 是把 `<memoryDir>/MEMORY.md` 正文塞进系统提示词
 * (asar 里 `packages/workbuddy-server/src/mode/collectors/memory-collector.ts`,
 * 2026-08-12 解包读到原文,注释写着 *workspace memory 使用当前会话 cwd,而不是 homedir*)。
 * 日志由模型自己用编辑工具追加 —— 本机 `C:\Users\000\WorkBuddy` 下 92 个工作空间,
 * 22 个有 `.workbuddy\memory\<日期>.md`,正文是模型口吻的中文工作日志。
 *
 * 它一共三层:云端记忆(我们没有)、用户级 `~/.workbuddy/MEMORY.md`、工作空间记忆。
 * 中间那层我们已经有等价物 —— 内核会把 agent 工作区的 `MEMORY.md` 注进每条会话
 * (`openclaw/src/memory/root-memory-files.ts:12-14` 就是 `<workspaceDir>/MEMORY.md`),
 * 那份天然是跨项目的。但**读得到不等于有人写**:所以下面那句「跨项目偏好写哪儿」是必须的,
 * WorkBuddy 的 reminder 里也有对应的一句(*For cross-project user preferences ...
 * write to ~/{folder}/MEMORY.md instead*)。`agentWorkspaceDir` 来自 `ctx.workspaceDir`。
 */
function workspaceSection(dir, dataFolderName, agentWorkspaceDir) {
  const memoryDir = join(dir, dataFolderName, 'memory')
  const parts = [
    '',
    '<workspace_memory>',
    `本项目的工作空间记忆目录:${memoryDir},作用范围仅限当前项目。`,
    '',
    `- ${memoryDir}\\YYYY-MM-DD.md —— 当天工作日志,**只追加、不覆盖**;目录或文件不存在就先建。`,
    `- ${memoryDir}\\MEMORY.md —— 本项目沉淀下来的长期笔记,控制在 3000 字以内。`,
    ...(agentWorkspaceDir
      ? [
          `- ${join(agentWorkspaceDir, 'MEMORY.md')} —— 跨项目的个人偏好与习惯(与具体项目无关的那些)写这儿,` +
            '它对你的每条会话都生效。'
        ]
      : []),
    '',
    '读:需要本项目的历史背景时,按时间倒序读日志,或读 MEMORY.md;没有历史依赖就不要读。',
    '写(必须遵守):完成一段实质工作后,立刻用编辑工具往当天日志追加一条。实质工作指:',
    '做好或改好一个网站/应用、修复一个缺陷、产出报告或文档、完成重构或架构调整、定下技术方案;',
    '用户讲了本项目的约定或偏好时,同时就地更新 MEMORY.md。',
    '日志只记有跨会话价值的东西,不记搜索结果、临时路径、工具报错。',
    '维护:超过 30 天的日志按主题归并进 MEMORY.md 后删掉。除非用户明确要求,不要写入密钥。',
    '边界:工作空间记忆是补充,不能替代你正常的回复、最终答案,或用户要的交付物。',
    '</workspace_memory>'
  ]

  try {
    const content = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8').trim()
    if (content) {
      parts.push('', '<working_memory_content>', '以下是本项目已有的长期笔记,作为背景使用。', '')
      if (content.length <= MAX_MEMORY_CHARS) {
        parts.push(content)
      } else {
        // 超限时连清理指令一起给,照 WorkBuddy 的 ACTION REQUIRED 分支:
        // 只截断不说话,模型永远不知道自己的笔记已经在膨胀。
        parts.push(
          content.slice(0, MAX_MEMORY_CHARS),
          '... (笔记过长已截断)',
          '',
          `**必须先处理**:${join(memoryDir, 'MEMORY.md')} 已超出注入上限。开始用户的任务之前,`,
          '先把它读全、合并去重(相关条目归并,删掉过时与冗余的),就地重写成简洁有条理的一份,再继续。'
        )
      }
      parts.push('</working_memory_content>')
    }
  } catch {
    /* 没有 MEMORY.md 是常态:第一次在这个项目干活时它还不存在 */
  }

  const skillsDir = join(dir, dataFolderName, 'skills')
  /**
   * 技能沉淀。
   *
   * 门槛与措辞照 WorkBuddy 的 `WorkingMemoryReminderSection`(asar 原文:*After completing a
   * larger multi-step task (15+ tool calls), fixing a tricky error, or discovering a clearly
   * reusable workflow, consider saving the approach as a skill*,外加「用到时发现技能有问题就
   * 顺手改掉」那条)。它那侧交给 `SkillManage` 工具,我们没有对应工具,所以直接给路径与格式
   * 让模型用编辑工具写 —— 反正日志本来也是这么写的。
   *
   * **格式必须说死**:上面 `projectSkillsSection` 要求 frontmatter 里 `name` 与 `description`
   * 齐全,少了 description 那条技能会被静默丢掉(与内核同规矩),模型写完却永远不出现在名录里,
   * 是最难查的那种失败。
   */
  parts.push(
    '',
    '<workspace_skills>',
    `本项目的技能目录:${skillsDir},同样只在当前项目生效。`,
    '',
    '沉淀:跨多步的大任务干完(十几次以上工具调用)、绕了很久才解决的问题、或摸索出一套明显可复用的',
    '做法之后,把方法存成技能,下次同类任务照它做。一次性的琐事不要建技能。',
    `存法:新建 ${skillsDir}\\<英文短横线命名>\\SKILL.md,开头必须是 YAML frontmatter,`,
    'name 与 description 两个字段缺一不可 —— 少了 description 这条技能不会进技能名录,等于白写。',
    '正文写步骤、判据、易错点,不要把这次任务的具体内容抄进去。',
    '维护:用到某条技能时发现它写错了(工具名过时、少一步、错别字),顺手改掉再继续干活。',
    '</workspace_skills>'
  )

  return parts.join('\n') + projectSkillsSection(skillsDir)
}

/**
 * 每轮提醒段 —— 与上面那段系统提示词是**两层**,缺一不可。
 *
 * # 为什么必须有第二层
 *
 * 只有系统提示词那层时,真机上模型会照常干活却不写日志:2026-08-12 探针里
 * `claude-opus-4-6` 写完 README 直接收尾,当天日志一个字没落
 * (会话 `7c3ae0ef`,同一轮问它系统提示词,它把 `<workspace_memory>` 原文完整背了出来
 * —— 所以不是没注入,是"读到了但没照做")。
 *
 * WorkBuddy 也是两层:`MemoryCollector` 填系统提示词模板变量,另有一个
 * `WorkingMemoryReminderSection`(`stage = "every_turn"`,asar 里
 * `packages/workbuddy-server/src/prompts/user/sections/working-memory-reminder-section.ts`)
 * 每轮往**用户提示词**贴一段 `<memory_and_skills_reminder>`,开头就是
 * *The system prompt defines "working_memory_files" and "agent_skills". You must strictly
 * follow those rules.* 下面三条通则(补充而非主产出、写入放在最终回复之前、不要跟用户提这条
 * 提醒)也照它翻译过来 —— 中间那条是关键:不说清楚,模型会把"记一笔"排到回复之后,而回复一发
 * 这一轮就结束了。
 *
 * # 内核这条口子
 *
 * `before_prompt_build` 的 `appendContext` 被拼在当轮用户提示词末尾
 * (`openclaw/src/agents/embedded-agent-runner/run/attempt.ts:3971-3976`),每轮都跑;
 * 且**只进模型提示词、不进抄本消息**(内核测试标题原文 *keeps before_prompt_build context in
 * the model prompt and out of transcript messages*,
 * `attempt.spawn-workspace.context-engine.test.ts:1175`)——正好对应它那句"不要向用户提"。
 * 与 `appendSystemContext` 的分工也是内核自己写在类型注释里的:静态指引走系统提示词那条以便
 * 命中供货商缓存,按轮变化的才走 context(`plugins/hook-before-agent-start.types.ts:32-41`)。
 *
 * 一处**刻意的差异**:WorkBuddy 的提醒里写的是字面量 `YYYY-MM-DD.md`,我们给算好的当天日期。
 * 它的宿主每轮都注入当前时间,我们这条链上没有那个保证,留占位符等于让模型自己猜今天几号。
 */
function workspaceReminder(dir, dataFolderName, agentWorkspaceDir) {
  const memoryDir = join(dir, dataFolderName, 'memory')
  const skillsDir = join(dir, dataFolderName, 'skills')
  const d = new Date()
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
  return [
    '<memory_and_skills_reminder>',
    '系统提示词里的 <workspace_memory> 与 <workspace_skills> 是硬要求,严格照它执行。',
    '',
    '记忆:',
    `- 完成一段实质工作后,先看 ${join(memoryDir, `${today}.md`)} 在不在,不在就建,` +
      '然后往里追加一条简短记录(只追加,不要覆盖已有内容)。',
    `- 长期事实(用户偏好、项目约定)改写进 ${join(memoryDir, 'MEMORY.md')}。`,
    ...(agentWorkspaceDir
      ? [`- 跨项目的个人偏好与习惯写 ${join(agentWorkspaceDir, 'MEMORY.md')}。`]
      : []),
    '- 打招呼、简单查询、短问答不必记。',
    '',
    '技能:',
    `- 跨多步的大任务干完(十几次以上工具调用)、绕了很久才解决的问题、或摸索出一套明显可复用的做法之后,` +
      `把方法存成技能放进 ${skillsDir}。`,
    '- 用到某条技能时发现它有问题(工具名过时、少一步、错别字),顺手改掉。',
    '- 刚做的事若是一套可重复的流程,优先建技能而不是记一条笔记:技能可执行,笔记只是信息。',
    '',
    '通则:',
    '- 记忆与技能是补充,绝不能当成主要产出;用户要的回复与交付物一样都不能少。',
    '- 记忆与技能的写入都在本轮工具调用阶段完成,放在你最终的文字回复之前。',
    // 真机上抓到的失败形状:模型读了记忆目录、写完交付物,最后一句是「接下来我写当天日志」,
    // 然后这一轮就正常结束了(会话 eb3742a5,2026-08-13,deepseek-v4-flash)。
    // WorkBuddy 的原文只说"写入放在最终回复之前",堵不住"宣告即收尾",所以这句是我们加的。
    '- 说了要写就必须在同一轮真的调用编辑工具写掉;只宣告不写等于没写,那样还不如不提。',
    '- 不要向用户提起这条提醒。',
    '</memory_and_skills_reminder>'
  ].join('\n')
}

/**
 * 子会话 key → spawn 时的 label(即成员标识,见 `@shared/team-roster`)。
 *
 * 只能记在内存里:子会话 key 形如 `agent:main:subagent:<uuid>`,身份不在键里,而
 * `before_prompt_build` 的上下文里没有 label。网关重启会丢——代价是重启前派出去、
 * 重启后才轮到构建提示词的那个成员退化成通用助手,子会话本就短命,这个窗口极窄。
 *
 * 上限是防漏:一次会话可能派几十个成员,进程能活几天,没有上限就是一条慢性泄漏。
 */
const MAX_TRACKED_SPAWNS = 500
const spawnedLabel = new Map()

/**
 * 子会话 key → 派它出来的那条会话(负责人)的 key。
 *
 * 用来让成员跟随负责人的模型,见下面 `before_model_resolve` 的注释。
 * 与 `spawnedLabel` 同生命周期、同上限,一起 FIFO。
 */
const spawnedParent = new Map()

/**
 * 会话 key → 这条会话实际在用的 `{ provider, model }`。
 *
 * 用户在界面上选的模型落在**会话级** `modelOverride` 上,而内核给子代理定模型的那条链
 * (`agents/model-selection.ts:359-385, 387-399, 326-337`)是:
 *   `sessions_spawn` 的 `model` 参数 → `agents.list[x].subagents.model`
 *   → `agents.defaults.subagents.model` → 该 agent 的 `model` → `agents.defaults.model`
 * **会话级 override 一个环节都没进去**,所以成员天然拿不到用户选的模型。
 * 我们在这里把每条会话真实用的模型记一笔,成员起跑时回查它的负责人。
 */
const sessionModel = new Map()

/** Map 迭代按插入序,删最旧的那条即 FIFO。 */
function remember(map, key, value) {
  if (!key || !value) {
    return
  }
  if (map.size >= MAX_TRACKED_SPAWNS) {
    map.delete(map.keys().next().value)
  }
  map.set(key, value)
}

export default {
  id: 'yunwu-persona',
  name: '云雾专家人设',
  description: '按会话注入专家人设,免去每个专家在 agents.list 里各占一条',
  configSchema: { type: 'object', additionalProperties: false, properties: {} },
  register(api) {
    /**
     * 记账:负责人自 spawn 时把成员标识放在 `label` 里,只有这个事件看得到它。
     * 不用 `subagent_spawning` —— 那个钩子只在绑频道线程时触发,我们这条路一次都不会调。
     */
    api.on('subagent_spawned', (event, ctx) => {
      const child = event?.childSessionKey
      remember(spawnedLabel, child, String(event?.label ?? ''))
      // 父会话只有这个事件的**上下文**里有(`plugins/hook-types.ts:725-729`),
      // 事件体里没有。拿不到它就无从知道该跟随谁的模型。
      remember(spawnedParent, child, String(ctx?.requesterSessionKey ?? ''))
      return undefined
    })

    /**
     * 让成员跟随负责人选定的模型。
     *
     * 这是**会话类**钩子(`plugins/hook-types.ts:226-234` 的 CONVERSATION_HOOK_NAMES),
     * 非内置插件必须在主配置里显式
     * `plugins.entries.yunwu-persona.hooks.allowConversationAccess = true`,
     * 否则内核直接 return 不注册它(`plugins/registry.ts:2555-2567`)——只在插件诊断里留一条
     * warn,运行时没有任何报错,表现就是这段代码从不执行。同目录的 `before_prompt_build`
     * 不在这张表里,所以它一直不用开这个开关。
     *
     * 返回的是 provider 与 model **两个独立 id**,不是 `provider/model` 合成串
     * (消费点 `agents/embedded-agent-runner/run/setup.ts:98-105`,那里还会各打一行
     * `[hooks] model overridden to …` info 日志,可用来验证本钩子生效)。
     *
     * 只管我们自己派出去的成员:非 spawn 会话、或查不到父会话模型的,一律不插手,
     * 让内核按它原本那条链去解析。
     */
    api.on('before_model_resolve', (_event, ctx) => {
      const parent = spawnedParent.get(String(ctx?.sessionKey ?? ''))
      const inherited = parent ? sessionModel.get(parent) : undefined
      if (!inherited?.model) {
        return undefined
      }
      return {
        modelOverride: inherited.model,
        ...(inherited.provider ? { providerOverride: inherited.provider } : {})
      }
    })

    api.on('before_prompt_build', (_event, ctx) => {
      const key = String(ctx?.sessionKey ?? '')
      // 记下这条会话这一轮真实用的模型,供它将来派出的成员回查。
      // 记在这里而不是 before_model_resolve:那个钩子跑在模型解析**之前**,
      // 此刻 ctx 里的模型还不是最终值。
      if (ctx?.modelId) {
        remember(sessionModel, key, {
          model: String(ctx.modelId),
          provider: ctx.modelProviderId ? String(ctx.modelProviderId) : ''
        })
      }
      const table = personas()
      // 先看是不是成员子会话:它的键里没有专家段,expertSlugOf 认不出来。
      const label = spawnedLabel.get(key)
      const persona = label ? table.members?.[label] : table.experts?.[expertSlugOf(key)]

      /**
       * 项目级记忆与技能:跟着这条会话的工作目录走,与人设各自独立。
       * 通用任务没有人设,但一样要有记忆,所以两段分开算、最后拼在一起。
       */
      let workspace = ''
      let reminder = ''
      const taskId = taskIdOf(key)
      if (taskId) {
        const ws = taskWorkspaces()
        const dir = ws.dirs?.[taskId]
        /**
         * `enabled === false` 是用户在设置里关了「本地技能与记忆沉淀」,整段不注入
         * (人设不受影响)。缺字段按开算:老版本主进程写的表里没有这个键,而这个开关
         * 两端默认都是开的。WorkBuddy 同口径 —— 它的 `disableLocalSkillsMemory`
         * 非布尔值一律回落默认值(asar 里 `app-config-keys.ts`)。
         */
        if (dir && ws.enabled !== false) {
          // ctx.workspaceDir 是 agent 的工作区,那份 MEMORY.md 内核会注进每条会话
          // (`openclaw/src/agents/embedded-agent-runner/run/attempt.ts:3929-3945` 给的字段)。
          const folder = ws.dataFolderName || '.yunwu-desktop'
          const agentWs = ctx?.workspaceDir ? String(ctx.workspaceDir) : ''
          workspace = workspaceSection(dir, folder, agentWs)
          reminder = workspaceReminder(dir, folder, agentWs)
        }
      }

      const text = [persona, workspace].filter(Boolean).join('\n')
      if (!text && !reminder) {
        return undefined
      }
      /**
       * 用 appendSystemContext 而不是 systemPrompt 整段替换:静态人设走这条才能命中
       * 供货商的 prompt 缓存,也保留 main 工作区那份全局 SOUL.md / USER.md。
       * 这个钩子**不需要**开权限——内核只在显式 allowPromptInjection === false 时才拦
       * (`openclaw/src/plugins/registry.ts:2535`);要 opt-in 的是会话类钩子。
       */
      return {
        ...(text ? { appendSystemContext: text } : {}),
        // 每轮提醒走 context 而不是 system:见 workspaceReminder 的注释,
        // 它按轮变(带当天日期)且刻意不进抄本。
        ...(reminder ? { appendContext: reminder } : {})
      }
    })

    /**
     * 把模型自己编的媒体 provider 前缀纠回我们的 provider。
     *
     * 2026-08-13 真机抓到:用户说「帮我画一张图」,模型给 `image_generate` 传了
     * `model: "openai/gpt-image-2"` —— 它凭 `gpt-image-2` 这个名字猜了个 `openai/` 前缀
     * (工具 schema 里那句 `Provider/model override, e.g. qwen/wan2.6-t2v` 教的就是这个形状)。
     * 内核照这个覆盖去解析,于是整发落到内核自带的 openai 槽位,报
     * `OpenAI API key or Codex OAuth missing` —— 而配置里明明是 `yunwu-image/gpt-image-2`、
     * 我们的插件也 loaded。这类失败以前是静默的,是媒体投递补上之后才在对话里现形的。
     *
     * 判据:媒体模型是**用户在选择器里挑的**(见 shared/media-endpoints.ts 那套),
     * 模型不该改 provider;它真想指定某个模型时,把模型名保留、前缀换成我们的即可 ——
     * 若那个模型不在这把 key 的目录里,插件会给出一句明确的「目录里没有 X」,比落到别家好。
     *
     * `before_tool_call` 返回 `{params}` 会被内核采纳(`agents/harness/hook-helpers.ts`
     * 的 `consumeAdjustedParamsForToolCall`:*Hooks should see adjusted tool params when
     * before_tool_call rewrote them*),且它不在 CONVERSATION_HOOK_NAMES 里,不用开权限。
     */
    api.on('before_tool_call', (event) => {
      const want = MEDIA_TOOL_PROVIDERS[String(event?.toolName ?? '')]
      if (!want) {
        return undefined
      }
      const raw = event?.params?.model
      if (typeof raw !== 'string' || !raw.trim()) {
        // 没传就用配置里的主用模型,那正是用户选的,不要插手。
        return undefined
      }
      const bare = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw
      const fixed = `${want}/${bare}`
      if (fixed === raw.trim()) {
        return undefined
      }
      console.warn(`[yunwu-persona] 纠正媒体模型覆盖: ${raw} -> ${fixed}`)
      return { params: { ...event.params, model: fixed } }
    })

    /**
     * 媒体后台任务记账:把「哪条会话在等哪个 taskId」写给主进程。
     *
     * # 为什么需要这一笔
     *
     * 出图 / 出视频在会话里一律走后台任务(`shouldDetachMediaGenerationTask` 只要有
     * sessionKey 就 detach,没有旋钮),完成后由内核把结果**投递**回请求方会话。
     * 而那条投递走的是 `deliverSubagentAnnouncement`
     * (`openclaw/src/agents/tools/media-generate-background-shared.ts:586`)——
     * 与成员播报同一条路,在我们的 `acp:` 会话上必然失败:direct 要过 ACP 解析(我们的会话是
     * `sessions.create` 造的、没有 ACP metadata),steer 要求这一轮还活着(而模型已 yield)。
     * 内核自带的 `tryDeliverMediaGenerationDirect` 兜底也救不了:它第一行就要求有可投递的
     * **消息频道**(同文件 671 行的 `origin.channel` + `to`),桌面端没有频道。
     *
     * 2026-08-13 真机复现:界面里让它画一张图,图真出了(1.5 MB PNG 落在
     * `~/.openclaw/media/tool-image-generation/`),而任务终态是
     * `Required completion delivery failed before reaching the requester`,对话里五分钟后仍然空白。
     * 升级不解:最新 tag 上这三处(媒体投递、`acp stale → throw`、`supportsSpawnLineage`)
     * 与我们这版**逐字相同**。所以补投递这件事只能我们自己做,与 `main/team-relay.ts` 同形。
     *
     * # 为什么记账必须在这里(而不是让插件自己上报)
     *
     * 出片的 provider 就是我们自己的插件,但 `VideoGenerationRequest` / 出图那份请求里
     * **没有 taskId、没有 sessionKey**(`openclaw/src/video-generation/types.ts:62-83`),
     * 它不知道自己在为哪条会话干活。而 `after_tool_call` 的上下文里有 `ctx.sessionKey`,
     * 事件里有工具返回的 `details.taskId`(`plugins/hook-types.ts:612-659`)——
     * 「会话 ↔ 任务」这层映射只有在**提交那一刻**拿得到。
     *
     * 这个钩子不在 `CONVERSATION_HOOK_NAMES` 里(`hook-types.ts:226-234`),
     * 所以不需要 `allowConversationAccess`。
     *
     * # 形状:一任务一文件,主进程处理完即删
     *
     * 不走管道 / socket:主进程要能在**重启后**捡起上次没处理完的(内核与应用不同生命周期),
     * 文件天然满足。剩下的文件就是「还没处理」,启动时扫一遍即补投,这正是产业那套
     * 「push 通知 + 拉取状态」的兜底半边。
     */
    api.on('after_tool_call', (event, ctx) => {
      const tool = String(event?.toolName ?? '')
      if (!MEDIA_TOOLS.has(tool)) {
        return
      }
      const sessionKey = String(ctx?.sessionKey ?? '')
      // 工具返回体形如 `{content:[…], details:{async, status, taskId, runId, …}}`。
      // details 经 `sanitizeToolResult` 仍在(内核紧接着就读 `details.status`)。
      const details = event?.result?.details
      const taskId = String(details?.taskId ?? details?.task?.taskId ?? '')
      if (!sessionKey || !taskId) {
        return
      }
      try {
        mkdirSync(MEDIA_TASK_DIR, { recursive: true })
        // 文件名即 taskId:重复提交(duplicateGuard 会回同一个 taskId)天然覆盖,不会投两遍。
        writeFileSync(
          join(MEDIA_TASK_DIR, `${taskId}.json`),
          JSON.stringify({
            taskId,
            tool,
            sessionKey,
            agentId: String(ctx?.agentId ?? ''),
            runId: String(event?.runId ?? details?.runId ?? ''),
            status: String(details?.status ?? ''),
            existingTask: details?.existingTask === true,
            prompt: typeof event?.params?.prompt === 'string' ? event.params.prompt : '',
            model: typeof event?.params?.model === 'string' ? event.params.model : '',
            recordedAt: Date.now()
          }),
          'utf-8'
        )
      } catch {
        // 记账失败不能影响这一轮工具调用 —— 最坏情况退回主进程启动时的台账清扫。
      }
    })
  }
}
