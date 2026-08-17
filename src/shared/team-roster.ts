import type { ExpertManifest, InstalledExpert } from "./types";

/**
 * 专家团成员名册的**唯一**推导处,主进程与渲染层共用。
 *
 * 为什么必须共用:成员的标识是一条跨进程的隐式契约——主进程按它写进负责人人设的委派名册、
 * 按它给人设插件建「label → 成员人设」表;负责人调 `sessions_spawn` 时把它填进 `label`;
 * 渲染层要拿它把「哪位成员在跑」对回成员条上的头像。三处只要有一处算法漂移,成员条就会
 * 永远是灰的(匹配不上),而 bug 表现在 UI、根因在主进程,极难定位。
 *
 * # 为什么成员标识是 label 而不是 agent id
 *
 * 成员曾经每人一个常驻 agent(`expert-<团队>-<成员>`),负责人指名道姓 spawn 它。代价是
 * `agents.list` 里 47 条成员条目,而内核冷启动的 provider auth 预热是逐个 agent 扫的
 * (84 个 agent 实测 49.5 秒,期间事件循环被占满)。改成负责人**自己 spawn**(省略
 * `agentId`)后成员不再需要注册:身份由人设插件按 spawn 的 `label` 注入
 * (见 main/persona-bundle.ts 与 resources/persona-plugin/index.mjs)。
 *
 * label 里带上团队 slug,是为了让插件那张表能拉平成一层:子会话的 key 是
 * `agent:main:subagent:<uuid>`,看不出属于哪个团队,只有 label 是我们自己能定的。
 */

/** 持久专家 agent 的 id 约定:`expert-<slug>`(内核要求 `[a-z0-9][a-z0-9_-]{0,63}`)。 */
export function persistentExpertAgentId(slug: string): string {
  return `expert-${slug.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
}

/** 存量团队任务里成员的委派目标 id:`expert-<团队 slug>-<成员 id>`。 */
export function teamMemberAgentId(teamSlug: string, memberId: string): string {
  return persistentExpertAgentId(`${teamSlug}-${memberId}`);
}

/**
 * 成员的委派标识,即 `sessions_spawn` 的 `label`。
 *
 * 用 `.` 分隔而不是 `-`:团队 slug 与成员 id 里都可能有 `-`,换个分隔符才能一眼看出边界
 * (虽然插件是整串查表、并不切分)。
 */
export function teamMemberLabel(teamSlug: string, memberId: string): string {
  return `${teamSlug}.${memberId}`;
}

/** 成员条上的一位成员。 */
export interface TeamRosterEntry {
  /** 成员标识:`sessions_spawn` 的 `label`,也是 memberRuns 的键。 */
  key: string;
  /**
   * 存量任务里这位成员的 agent id。存量团队任务的负责人挂在自己的 `expert-<slug>` agent 上,
   * 仍按 id 指名道姓 spawn,那些成员事件没有 label —— 成员条要按这个键兜底匹配。
   */
  legacyKey: string;
  /** 姓名(成员条第二行)。 */
  name: string;
  /** 职业/头衔(成员条第一行,加粗)。 */
  profession?: string;
  avatar?: string;
}

/**
 * 推导某个专家团在 UI 上要展示的成员名册。
 *
 * 成员有两种来源,与主进程 `teamMemberRefs` 一一对应:
 *  - `members`:人设随团队包下发(外部导入的团队都是这种);
 *  - `memberSlugs`:引用另外单独安装的专家,未安装的引用要跳过——它派不出去,列出来是误导。
 *
 * 与主进程的一处**有意**差异:这里不校验团队包内是否真有 `members/<id>.md`。那是 fs 读,
 * 渲染层做不到;缺人设的成员只会在被派活时失败,届时成员条照样会显示失败状态。
 */
export function resolveTeamRoster(
  manifest: ExpertManifest,
  teamSlug: string,
  installedExperts: InstalledExpert[],
): TeamRosterEntry[] {
  const roster: TeamRosterEntry[] = [];

  for (const member of manifest.members ?? []) {
    roster.push({
      key: teamMemberLabel(teamSlug, member.id),
      legacyKey: teamMemberAgentId(teamSlug, member.id),
      name: member.displayName?.trim() || member.id,
      profession: member.profession?.trim() || undefined,
      avatar: member.avatar,
    });
  }

  for (const slug of manifest.memberSlugs ?? []) {
    const sub = installedExperts.find((e) => e.slug === slug);
    if (!sub) {
      continue;
    }
    roster.push({
      key: teamMemberLabel(teamSlug, slug),
      legacyKey: persistentExpertAgentId(slug),
      name: sub.manifest.displayName?.trim() || sub.name,
      profession: sub.manifest.profession?.trim() || undefined,
      avatar: sub.manifest.avatar,
    });
  }

  return roster;
}
