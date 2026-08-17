import { join } from 'path'
import { loadExperts } from './expert-store'
import {
  installedSkillDir,
  listMarketInstalledMetas,
  patchSkillMeta,
  readSkillHeader,
  removeInstalledSkillDir,
  setSkillModelVisible
} from './installer'

/**
 * 技能随专家走(对齐 WorkBuddy 的会话级插件启用)。
 *
 * # 为什么要这层
 *
 * 我们同步的是 WorkBuddy 专家中心的资产,但落地方式跟它反了:它的全局技能目录
 * `C:\Users\000\.workbuddy\skills` 是**空的**(2026-08-11 实测 0 个目录),技能全部待在
 * 专家插件包里,召唤专家时才 `switchPlugins ... (non-persistent)` 把那一个专家的
 * agent + 技能加载进这条会话的进程 —— 实测一次会话共 65~67 个技能,其中只有 4~5 个
 * 来自被召唤的那个专家,别的专家的技能一个都不在。而我们把每个专家的捆绑技能都平铺进
 * `~/.openclaw/skills`,本机 41 个专家滚成了 135 个目录,于是**每条会话**都要背着全部
 * 专家的技能名录:内核在 18000 字符的预算里塞不下,自己降级成「只有名字、没有描述」
 * 还丢掉一部分,模型只能靠技能名猜用途。装得越多越糟,是单调恶化的。
 *
 * **那个 18000 是可配的默认值,不是硬墙**(`skills.limits.maxSkillsPromptChars` /
 * `agents.list[].skillsLimits.maxSkillsPromptChars`,见内核
 * `skills/loading/workspace.ts:197-254`;之上还有一层 `maxSkillsInPrompt` 默认 150)。
 * 不走调大预算这条路,是因为要复现的结果不是「名录很长但塞得下」而是「名录里只有该
 * 出现的东西」:135 条完整描述每轮都进提示词约 60KB+,更贵,而且模型要在 135 个候选里
 * 挑,误选概率更大。旋钮记在这里备查。
 *
 * # 为什么是这个做法
 *
 * openclaw 没有会话级的技能白名单:`agents.list[].skills` 是 agent 级的,而我们所有
 * 专家都挤在 `main` 上;`chat.send` 与 `sessions.patch` 的参数表里都没有任何 skills
 * 字段;插件的 39 个钩子里也没有技能名录构建期的钩子。给每个专家配一个 agent 倒是
 * 内核原生的,但那正是上一轮刚拆掉的东西(冷启动预热 = agent 数 × 供货商数,
 * 84 个 agent 时 26~32 秒)。
 *
 * 所以用内核给的两件东西拼出同样的结果:
 *  - 捆绑技能与专家人设包一律标 `disable-model-invocation`,退出全局名录(内核官方字段);
 *  - 该专家会话里,由人设插件把它自己的技能以「名字 + 描述 + 路径」注入系统提示词
 *    (`before_prompt_build`,见 persona-bundle.ts)。
 *
 * 2026-08-11 真机验过这条链:被标记的技能不在内核名录里(轨迹 `systemPromptReport`
 * 65 条中无它),模型仍自己决定用它、`read` 了那份 SKILL.md 并照它执行 —— 内核对
 * `disable-model-invocation` **只做展示过滤,执行期零拦截**。
 *
 * # 归属判定
 *
 * | meta | 结果 |
 * |---|---|
 * | `direct: true`(用户在市场/本地主动装的) | 全局可见,永不回收 —— 对应 WorkBuddy 那批常驻 builtin 插件技能 |
 * | `bundledBy` 非空(还有专家在引用) | 藏出全局名录,由该专家的会话注入 |
 * | `bundledBy` 空数组(带它来的专家都卸载了) | 回收目录 |
 * | 两者都没有 | 用户自己放的/老版本装的,不动 |
 *
 * `bundledBy` 是数组而不是布尔:本机就有一个技能被两个专家共用
 * (`web-research-digest` ← copywriter / xiaohongshu-ops),按引用计数才不会
 * 卸掉一个专家就把另一个专家的技能删了。
 */

/** 注入给模型的一张技能卡片(字段照内核 `<available_skills>` 的形状)。 */
export interface SkillCard {
  name: string
  description: string
  location: string
}

/** 收口结果,只用于日志。 */
interface ReconcileStats {
  hidden: number
  revealed: number
  removed: string[]
}

/**
 * 依据当前已安装专家,把每个技能的可见性与归属重新算一遍,并回收无人引用的捆绑技能。
 *
 * 幂等,启动时与装/卸专家后各跑一次。全程只碰带我方 meta 的目录 —— 内核自带的
 * docx/pdf/pptx/xlsx 也躺在同一个目录下,它们没有 meta,一律不动。
 * 单个技能失败只告警:这是可见性收口,不该拦住启动或安装。
 */
export function reconcileSkillVisibility(): void {
  const refs = new Map<string, string[]>()
  for (const expert of loadExperts()) {
    for (const slug of expert.manifest.bundledSkills ?? []) {
      refs.set(slug, [...(refs.get(slug) ?? []), expert.slug])
    }
  }

  const stats: ReconcileStats = { hidden: 0, revealed: 0, removed: [] }
  for (const meta of listMarketInstalledMetas()) {
    const slug = meta.slug
    try {
      // 专家人设包根本不是技能,是我们给插件读的正文,永远不该出现在模型的技能名录里。
      if (meta.type === 'expert') {
        if (setSkillModelVisible(slug, false)) {
          stats.hidden++
        }
        continue
      }

      const owners = refs.get(slug)
      if (meta.direct) {
        // 用户主动装过就永远全局可见,哪怕它同时也是某个专家的捆绑技能。
        if (setSkillModelVisible(slug, true)) {
          stats.revealed++
        }
        if (owners) {
          patchSkillMeta(slug, { bundledBy: owners })
        }
        continue
      }

      if (owners && owners.length > 0) {
        patchSkillMeta(slug, { bundledBy: owners })
        if (setSkillModelVisible(slug, false)) {
          stats.hidden++
        }
        continue
      }

      if (meta.bundledBy) {
        // 曾经是捆绑技能,带它来的专家都卸载了 —— 这正是过去只删人设目录留下的泄漏。
        removeInstalledSkillDir(slug)
        stats.removed.push(slug)
      }
    } catch (err) {
      console.warn(`[skills] 收口技能「${slug}」失败:`, err)
    }
  }

  if (stats.hidden || stats.revealed || stats.removed.length) {
    console.log(
      `[skills] 可见性收口:藏起 ${stats.hidden} 个、放开 ${stats.revealed} 个、回收 ${stats.removed.length} 个` +
        (stats.removed.length ? `(${stats.removed.join('、')})` : '')
    )
  }
}

/**
 * 某个专家自己的技能卡片。
 *
 * 读不出 description 的直接不给 —— 内核自己也是这条规矩(缺 description 的技能在加载期
 * 就被判无效),给一张只有名字的卡片,模型既判断不了何时该用,又白占提示词。
 */
function expertSkillCards(bundledSkills: string[] | undefined): SkillCard[] {
  const cards: SkillCard[] = []
  for (const slug of bundledSkills ?? []) {
    const header = readSkillHeader(slug)
    if (!header) {
      continue
    }
    cards.push({
      name: header.name,
      description: header.description,
      // 指到 SKILL.md 本身而不是目录:2026-08-11 那次真机验证给的就是这个形状,
      // 模型直接 read 这条路径就拿到了正文。
      location: join(installedSkillDir(slug), 'SKILL.md')
    })
  }
  return cards
}

/** XML 转义,与内核 `escapeXml` 同口径(技能描述里带 & < > 的不少)。 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 专家自带技能的注入段,接在人设正文后面。没有可注入的技能时返回空串。
 *
 * 措辞与结构照抄内核的 `formatSkillsForPrompt`
 * (`openclaw/src/skills/loading/skill-contract.ts:34`):模型在同一份系统提示词里
 * 已经见过内核那份全局名录,形状一样它才认得这是同一类东西。区别只有开头那句
 * —— 点明这批是分配给这个角色的,免得它把专属技能当成谁都能用的通用工具箱。
 *
 * 专家团成员(子会话)走的是同一段,2026-08-11 真机验过四名成员各拿到自己那份。
 * **卡片里的绝对路径能不能被 read,取决于两个开关都关着**:`tools.fs.workspaceOnly`
 * 与 sandbox。开了任一个,`~/.openclaw/skills/...` 就会被判 `Path escapes sandbox root`,
 * 卡片变成一张废纸(内核在 `skills/loading/workspace.ts:851` 的注释里说的正是这个坑)。
 * 将来真要开沙箱,这里得改成把技能正文直接注进提示词,而不是给路径。
 */
export function expertSkillsSection(bundledSkills: string[] | undefined): string {
  const cards = expertSkillCards(bundledSkills)
  if (cards.length === 0) {
    return ''
  }
  const lines = [
    '\n\nThe following skills are assigned to you specifically for this role.',
    "Use the read tool to load a skill's file when the task matches its description.",
    'When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.',
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
