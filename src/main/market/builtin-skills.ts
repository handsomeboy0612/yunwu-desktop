import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * 内置引导技能播种。
 *
 * 对齐 WorkBuddy:市场「添加技能 → 查找技能 / 创建技能」并不是弹窗,而是开一个新对话、
 * 让 agent 用内置的 find-skills / skill-creator 技能来完成。为此需要在本地技能目录
 * (~/.openclaw/skills/<slug>/SKILL.md)预置这两个引导技能,内核 chokidar 扫描后即可
 * 被模型按描述自动匹配调用。
 *
 * 播种策略:
 *  - 目录不存在 → 直接写入;
 *  - 已存在且是我方旧版本(_yunwu_builtin.json 记录 version 落后)→ 覆盖更新;
 *  - 已存在且无我方标记(疑似用户自建同名)→ 不动,避免覆盖用户改动。
 */

const BUILTIN_MARK = '_yunwu_builtin.json'

interface BuiltinSpec {
  slug: string
  version: number
  skillMd: string
}

function skillsDir(): string {
  const dir = join(homedir(), '.openclaw', 'skills')
  mkdirSync(dir, { recursive: true })
  return dir
}

const FIND_SKILLS_MD = `---
name: find-skills
description: 当用户需要"查找/寻找/搜索并自动安装某个能力(skill)"时使用。根据用户用自然语言描述的需求,帮助其在技能市场中定位最合适的技能,并引导完成安装。
---

# find-skills(查找并安装技能)

## 何时使用
用户说出类似"请帮我查找并自动安装能……的 skill""有没有能做……的技能"时启用本技能。

## 工作流程
1. 明确需求:若用户的「……」为空或含糊,先用一句话追问其想解决的具体任务(输入是什么、期望产出是什么)。
2. 归纳能力关键词:把需求提炼成 2~4 个能力关键词(如"网页抓取""Excel 清洗""周报生成")。
3. 在「专家·技能·连接器」市场中按关键词为用户推荐 1~3 个最匹配的技能,说明各自适用场景与差异。
4. 引导安装:告诉用户在市场对应卡片点击「+」即可安装;安装后技能会出现在"我安装的"里,可在对话中直接调用。
5. 若市场没有匹配项,提示可改用 skill-creator 按需现场创建一个技能。

## 注意
- 不要臆造并不存在的技能名;只推荐确实能覆盖需求的能力。
- 保持简洁:先给结论(推荐哪个),再给理由。
`

const SKILL_CREATOR_MD = `---
name: skill-creator
description: 当用户需要"创建/制作/生成一个新的能力(skill)"来固化某类可复用的工作流程时使用。根据自然语言需求产出规范的 SKILL.md 并落地为一个可用技能。
---

# skill-creator(创建技能)

## 何时使用
用户说出类似"请帮我创建一个可以实现……的 skill""把这个流程做成一个技能"时启用本技能。

## 什么是技能
一个技能 = 一个目录,内含 SKILL.md。SKILL.md 顶部是 YAML frontmatter(name、description),正文是给 agent 的操作说明(何时用、步骤、注意事项、示例)。description 决定该技能何时被自动匹配,务必写清"触发场景 + 能力"。

## 工作流程
1. 澄清需求:确认要固化的任务、典型输入与期望产出、可复用的步骤。
2. 起草 SKILL.md:
   - name:短横线命名(如 weekly-report)。
   - description:一句话写清"当用户需要……时使用",覆盖触发关键词。
   - 正文:分「何时使用 / 工作流程 / 注意事项 / 示例」小节,步骤可执行、可复现。
3. 与用户确认草稿,按反馈修订。
4. 落地安装:将该技能保存到 ~/.openclaw/skills/<name>/SKILL.md;如具备文件写入能力则直接创建,否则把完整 SKILL.md 内容交给用户,由其在市场「添加技能 → 上传技能」导入。
5. 安装后提示用户可在新对话中直接触发验证。

## 注意
- description 是被自动调用的关键,宁可具体不要笼统。
- 步骤要以"可被另一个 agent 照做"的粒度书写。
`

const BUILTINS: BuiltinSpec[] = [
  { slug: 'find-skills', version: 1, skillMd: FIND_SKILLS_MD },
  { slug: 'skill-creator', version: 1, skillMd: SKILL_CREATOR_MD }
]

/** 读取目录内我方内置标记版本;非我方内置或无标记返回 -1。 */
function readBuiltinVersion(dir: string): number {
  try {
    const raw = readFileSync(join(dir, BUILTIN_MARK), 'utf-8')
    const v = JSON.parse(raw)?.version
    return typeof v === 'number' ? v : -1
  } catch {
    return -1
  }
}

/** 判断某目录是否是"用户自建同名技能"(存在 SKILL.md 但没有我方内置标记)。 */
function isForeignSkill(dir: string): boolean {
  return existsSync(join(dir, 'SKILL.md')) && !existsSync(join(dir, BUILTIN_MARK))
}

function writeBuiltin(spec: BuiltinSpec): void {
  const dir = join(skillsDir(), spec.slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), spec.skillMd, 'utf-8')
  writeFileSync(
    join(dir, BUILTIN_MARK),
    JSON.stringify({ builtin: true, version: spec.version, seededAt: Date.now() }, null, 2),
    'utf-8'
  )
}

/** 启动时调用:幂等播种内置引导技能。失败不抛出,避免影响主流程启动。 */
export function seedBuiltinSkills(): void {
  for (const spec of BUILTINS) {
    try {
      const dir = join(skillsDir(), spec.slug)
      if (!existsSync(dir)) {
        writeBuiltin(spec)
        continue
      }
      if (isForeignSkill(dir)) {
        continue
      }
      if (readBuiltinVersion(dir) < spec.version) {
        writeBuiltin(spec)
      }
    } catch {
      // 单个技能播种失败不影响其他及启动
    }
  }
}
