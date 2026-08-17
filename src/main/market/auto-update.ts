import { fetchMarketSnapshot, marketDetail } from './market-client'
import { installSkill, listInstalledSkills } from './installer'
import {
  listInstalledExperts,
  installExpert,
  hasPersonaOnDisk,
  removeExpertFootprint
} from './expert-installer'
import { listTaskSessionKeys } from '../session-history'
import { ensureSessionTruth } from '../session-index'
import { expertSlugFromSessionKey } from '@shared/session-key'

/**
 * 市场资产自动更新(启动时跑一次)。
 *
 * 对齐 WorkBuddy:它的市场条目带 `autoUpdate: true`,整包从 CDN 同步,用户完全不参与;
 * 用户可见动作只有"召唤/启用",没有"更新"。我们此前是每个条目单独安装 + 版本号比对 +
 * 在市场页亮一个更新按钮,多出一个用户动作,也多出一类失败模式——服务端改了人设/技能,
 * 用户不去点那个按钮就一直用着旧版,且毫无感知。
 *
 * 策略:拿一次市场快照当权威口径,对每条本地登记回答三问——还在不在架、版本是不是最新、
 * 人设资产在不在盘上。任一条不对就重装(安装本身幂等,等价升级);已下架的清掉本地登记。
 * 全程 best-effort —— 自动更新失败只该退回旧版继续可用,绝不能拖慢或拦住启动,
 * 故单条失败只告警继续,整体也不向上抛。
 *
 * 未登录/断网时快照拿不到,专家这一轮整体跳过,与离线可用的诉求一致。
 */
const msgOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * 市场在架专家的权威集合(slug → 版本号);拿不到返回 null,调用方整轮跳过。
 *
 * **一次快照顶掉逐条回查。** 本机 42 条登记原先要发 42 次 `marketDetail`,而快照一次拿回
 * 全部 392 条(331KB,带 ETag,下次启动是 304),每条都带 `version` —— "还在不在架"和
 * "版本是不是最新"两问就地都能答,只有真要重装的那几条才回查详情拿 manifest。
 *
 * **返回 null 的三种情况都不许据以删本地登记**,这比逐条 catch 重要:逐条回查分不清
 * "这条下架了"和"服务端刚好抽了一下"——两种情况报的都是一句错,而删登记是不可逆的。
 * 只有一次成功且完整的快照才是权威口径。
 */
async function fetchExpertShelf(): Promise<Map<string, string> | null> {
  try {
    const snap = await fetchMarketSnapshot('expert')
    // stale = 网络不可达/服务端异常时兜底返回的本地缓存,不是当下的在架事实。
    if (snap.stale) {
      console.log('[market] 市场快照为离线缓存,本轮跳过专家对账')
      return null
    }
    // 静默截断的保险:服务端给了 total 就要求条目数对得上(见 MarketSnapshot.total 的注释)。
    if (typeof snap.total === 'number' && snap.items.length !== snap.total) {
      console.warn(
        `[market] 市场快照不完整(${snap.items.length}/${snap.total}),本轮跳过专家对账`
      )
      return null
    }
    return new Map(snap.items.map((i) => [i.slug, i.version || '']))
  } catch (err) {
    // 未登录、断网、服务端异常都走到这里。
    console.log(`[market] 跳过专家对账:${msgOf(err)}`)
    return null
  }
}

/**
 * 有过任务会话的专家 slug(跨所有 agent 的会话库)。
 *
 * 判据与 `agent-manager.ts:pruneUnusedExpertAgents` 同源:"这个专家有没有被真用过"只认
 * 会话存储,不认注册表。`listTaskSessionKeys` 用的是产品自己的键解析器,三种键型都认
 * (含存量的 `agent:expert-<slug>:acp:<taskId>`),别在这里另写一套正则。
 */
async function expertSlugsWithTasks(): Promise<Set<string> | null> {
  if (!(await ensureSessionTruth())) {
    // 拿不到可信的会话真相时返回 null,由调用方整轮跳过清理。与"快照拿不到就不对账"同一个
    // 理由:空表既可能是"真没人用"也可能是"这次没问到",而删登记不可逆。
    // 注意判据是"有没有真相"而不是"RPC 成没成功"——启动期网关常常还没连上,
    // 而那时磁盘上那份 JSON 仍是权威(6.11),照旧清理才是对的。
    return null
  }
  const used = new Set<string>()
  for (const key of await listTaskSessionKeys()) {
    const slug = expertSlugFromSessionKey(key)
    if (slug) {
      used.add(slug)
    }
  }
  return used
}

/**
 * 专家对账:下架的清掉、过期或装漏的重装。
 *
 * # 为什么下架的要直接清掉
 *
 * WorkBuddy 那边**没有"已安装专家"这个列表**:它的 `installed_plugins.json` 里 32 条全是
 * `@workbuddy-builtin` 的内置播种,`experts` / `cb_teams_marketplace` 的一条都没有。专家市场
 * 是一个 `type: directory` + `autoUpdate: true` 的本地目录、manifest 由扫目录自动生成,召唤是
 * 按会话 `switchPlugins`(non-persistent)。上游删掉一个专家,下次同步目录里就没了,
 * **没有东西可以悬空**(2026-08-12 读 `C:\Users\000\.workbuddy\plugins\` 三份状态文件核对)。
 * 我们这套"逐条安装 + 本地注册表"是自己的形状,残留也就成了我们独有的问题,它那边没有
 * "已下线"状态可抄——所以要复现的结果是**列表里只有市场上真实存在的东西,用户不用管**,
 * 而不是新造一个用户要去处理的状态。
 *
 * 真机代价也量过(2026-08-12):本机 42 条登记里 12 条已不在架,其中 10 条人设还能用、
 * 2 条早就坏了,5 条与"新 slug"版本同名重复(市场做过一次 slug 迁移)。而这 12 条
 * **没有一条有过任务会话**,清掉零历史损失。
 *
 * # 有任务在用的不清
 *
 * 清登记本身不动会话,但人设就不再注入了,那条历史任务会退化成通用助手。所以保留并只打一行
 * 日志:它从此不再更新,是明知的敞口(与 `pruneUnusedExpertAgents` 留下"有会话的专家 agent"
 * 是同一个取舍)。
 *
 * # slug 迁移刻意不自动跟
 *
 * 市场那次迁移(负责人 agent id → 插件包名)让 6 条旧 slug 有了新 slug 对应物,但把旧的自动
 * 换成新的需要一份可靠映射,而按显示名匹配是不可靠的——真机上 `ai-content-creator-team-lead`
 * 就匹配不到同名新条目。清掉之后用户在市场页重新召唤即可(在架 392 条),比自动装一个
 * 猜出来的条目安全。
 */
async function reconcileExperts(shelf: Map<string, string>): Promise<number> {
  const inUse = await expertSlugsWithTasks()
  let updated = 0
  let removed = 0

  for (const local of listInstalledExperts()) {
    const shelfVersion = shelf.get(local.slug)

    if (shelfVersion === undefined) {
      if (inUse === null) {
        console.log(`[market] 专家「${local.slug}」已下架,但取不到会话清单,本轮不清理`)
        continue
      }
      if (inUse.has(local.slug)) {
        console.log(`[market] 专家「${local.slug}」已下架但仍有任务在用,保留本地副本(不再更新)`)
        continue
      }
      try {
        // 收口(reconcileSkillVisibility / syncPersonaData)由启动链紧接着做,见 index.ts。
        removeExpertFootprint(local.slug)
        removed++
        console.log(`[market] 专家「${local.slug}」已下架且无任务在用,已清理本地登记`)
      } catch (err) {
        // 单条清理失败不许拖停整轮:抛出去会连带停掉后面的收口与 agent 清理
        // (2026-08-12 真机上就这么中断过一次,见 removeExpertFootprint 的注释)。
        console.warn(`[market] 专家「${local.slug}」下架清理失败:${msgOf(err)}`)
      }
      continue
    }

    // 版本一致还要看资产在不在盘上:装漏过的专家版本号是对的,只比版本永远不自愈
    // (理由与真机证据见 expert-installer.ts:hasPersonaOnDisk)。
    const intact = hasPersonaOnDisk(local)
    if (local.version === shelfVersion && intact) {
      continue
    }
    try {
      // 快照不带 manifest(longtext,服务端刻意省略),真要装才回查详情。
      const detail = await marketDetail('expert', local.slug)
      await installExpert(detail)
      updated++
      console.log(
        intact
          ? `[market] 专家「${local.slug}」已更新:${local.version || '?'} → ${detail.version || '?'}`
          : `[market] 专家「${local.slug}」人设资产缺失,已重装自愈`
      )
    } catch (err) {
      // 只打消息不打栈:离线、服务端异常都会走到这里,是预期分支,栈没有信息量。
      console.warn(`[market] 专家「${local.slug}」自动更新跳过:${msgOf(err)}`)
    }
  }

  if (removed > 0) {
    console.log(`[market] 下架条目清理完成,共 ${removed} 条`)
  }
  return updated
}

export async function autoUpdateMarketAssets(): Promise<void> {
  let updated = 0

  const shelf = await fetchExpertShelf()
  if (shelf) {
    updated += await reconcileExperts(shelf)
  }

  // 带上捆绑技能:它们不在 UI 列表里,但一样要跟市场保持同版本。
  for (const local of listInstalledSkills('skill', true)) {
    // 本地生成的技能(AI 生成/本地 zip 导入)没有市场来源,回查必然 404,直接跳过。
    if (!local.version) {
      continue
    }
    try {
      const detail = await marketDetail('skill', local.slug)
      if (local.version === (detail.version || '')) {
        continue
      }
      await installSkill(detail)
      updated++
      console.log(
        `[market] 技能「${local.slug}」已更新:${local.version} → ${detail.version || '?'}`
      )
    } catch (err) {
      console.warn(`[market] 技能「${local.slug}」自动更新跳过:${msgOf(err)}`)
    }
  }

  if (updated > 0) {
    console.log(`[market] 自动更新完成,共 ${updated} 项`)
  }
}
