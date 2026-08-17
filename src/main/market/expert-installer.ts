import type {
  ExpertManifest,
  ExpertTeamMember,
  InstalledExpert,
  MarketItem,
} from "@shared/types";
import { marketDetail } from "./market-client";
import {
  installArtifactToSkills,
  isMarketSkillInstalled,
  removeInstalledSkillDir,
  installSkill,
} from "./installer";
import {
  loadExperts,
  getExpert,
  upsertExpert,
  removeExpert,
} from "./expert-store";
import { removePersistentExpertAgent } from "../agent-manager";
import { syncPersonaData } from "../persona-bundle";
import { reconcileSkillVisibility } from "./skill-visibility";

/**
 * 专家安装器(第三期:专家)。
 *
 * 专家 = 一个带专属 persona/工具白名单/专属模型/头像的对话角色。落地策略:
 *  - persona zip 制品复用技能安装核心,装入 `~/.openclaw/skills/<personaSkillSlug>`
 *    (内核 chokidar 自动扫描,无需重启);
 *  - 专家清单(职业/模型/工具/头像/快捷提示)登记到本地专家注册表 experts.json;
 *  - 人设刷进人设插件的数据文件(persona-bundle.ts),会话一律挂在 `main` 上。
 *    专家团同理:负责人的名册与成员人设也在那份文件里,成员由负责人自 spawn + label 路由,
 *    没有任何一方需要 `agents.list` 条目(理由见 `@shared/team-roster` 的模块头)。
 *  - persona 包与捆绑技能虽然都落在 `~/.openclaw/skills` 下,但**不进全局技能名录**:
 *    它们随专家走,只在该专家的会话里由人设插件注入(理由与做法见 skill-visibility.ts)。
 */

/** slug 白名单:仅字母数字及 . _ -,防止拼进目录名/CLI 参数时越界。 */
const VALID_SLUG = /^[a-zA-Z0-9._-]+$/;

/** 从原始串生成安全 slug(替换非法字符为 -)。 */
function sanitizeSlug(raw: string): string {
  const s = raw
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "expert";
}

/**
 * 解析并校验专家清单。personaSkillSlug 缺省时用 `expert-<slug>` 兜底,
 * 保证 persona 目录名稳定且不与普通技能 slug 冲突。
 */
function parseManifest(
  item: MarketItem,
  manifestStr: string | undefined,
): ExpertManifest {
  if (!manifestStr) {
    throw new Error("专家缺少 manifest(清单),无法安装");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(manifestStr);
  } catch {
    throw new Error("专家 manifest 不是合法 JSON");
  }
  const m = raw as Partial<ExpertManifest>;
  const personaSkillSlug = sanitizeSlug(
    m.personaSkillSlug || `expert-${item.slug}`,
  );
  if (!VALID_SLUG.test(personaSkillSlug)) {
    throw new Error(`非法 personaSkillSlug:${personaSkillSlug}`);
  }
  return {
    agentId: m.agentId || item.slug,
    profession: m.profession,
    model: m.model,
    tools: Array.isArray(m.tools) ? m.tools : undefined,
    bundledSkills: Array.isArray(m.bundledSkills)
      ? m.bundledSkills.filter(
          (s): s is string => typeof s === "string" && s.length > 0,
        )
      : undefined,
    personaSkillSlug,
    avatar: m.avatar || item.icon,
    displayName: m.displayName || item.name,
    quickPrompts: Array.isArray(m.quickPrompts) ? m.quickPrompts : undefined,
    defaultInitPrompt:
      typeof m.defaultInitPrompt === "string" ? m.defaultInitPrompt : undefined,
    isTeam: !!m.isTeam,
    memberSlugs: Array.isArray(m.memberSlugs) ? m.memberSlugs : undefined,
    members: parseTeamMembers(m.members),
  };
}

/**
 * 校验随包成员名单。
 *
 * id 会被拼成 `members/<id>.md` 去读文件(见 readInstalledTeamMemberMd),所以此处必须挡住
 * 路径穿越与空值 —— manifest 来自服务端,但"服务端数据能决定客户端读哪个文件"这条链本身
 * 就不该成立。名单为空时返回 undefined,让上层按单体专家处理。
 */
function parseTeamMembers(raw: unknown): ExpertTeamMember[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const out = raw.flatMap((x) => {
    const m = x as Partial<ExpertTeamMember>;
    const id = typeof m.id === "string" ? m.id : "";
    if (!VALID_SLUG.test(id)) {
      console.warn(`[expert] 忽略非法成员 id:${id}`);
      return [];
    }
    return [
      {
        id,
        displayName: m.displayName,
        profession: m.profession,
        avatar: m.avatar,
        description: m.description,
      },
    ];
  });
  return out.length > 0 ? out : undefined;
}

/**
 * 安装专家捆绑的市场技能(best-effort):逐个回查技能详情并安装到 skills/<slug>/。
 * 单个技能失败不阻塞专家安装(记录告警);已安装的技能会被重装覆盖(等价升级)。
 */
async function installBundledSkills(slugs: string[]): Promise<void> {
  for (const slug of slugs) {
    try {
      const skillItem = await marketDetail("skill", slug);
      await installSkill(skillItem);
    } catch (err) {
      console.warn(`[expert] 捆绑技能安装失败(跳过) ${slug}:`, err);
    }
  }
}

/**
 * 这份本地登记的专家,人设正文是不是真的还在盘上。
 *
 * **版本号一致不等于装好了。** 2026-08-11 真机上撞到三个专家:`experts.json` 登记完好、
 * `~/.openclaw/skills/<personaSkillSlug>` 却是空目录(其中一个连目录都没建),而
 * `buildPersonaTable` 读不到正文就不登记(persona-bundle.ts),召唤出来是通用助手,
 * 全程没有一句报错。只比版本号的话这种残缺**永远不自愈**——版本对得上,每次启动都跳过。
 * 其中 `promo-creator-team` 的市场制品是完好的(SKILL.md 7869 字节 + 5 名成员),
 * 纯粹是那一次安装没落地,重装即可。
 *
 * 判据只取人设,**刻意不含捆绑技能**:捆绑技能单独下架时 `installBundledSkills` 会
 * best-effort 跳过、永远补不齐,把它算进来就会让这个专家每次开机都重下一遍整包。
 * 而捆绑技能缺失只是少一张注入的技能卡片,不会让角色退化成通用助手。
 */
export function hasPersonaOnDisk(expert: InstalledExpert): boolean {
  return isMarketSkillInstalled(expert.manifest.personaSkillSlug);
}

/**
 * 安装一个专家:取详情拿 manifest → 安装 persona zip 到 skills → 登记注册表。
 * item 来自列表时不含 manifest(后端列表接口省略),故按需回查详情补齐。
 */
export async function installExpert(item: MarketItem): Promise<void> {
  if (item.type !== "expert") {
    throw new Error("installExpert 仅接受「专家」类型条目");
  }
  let manifestStr = item.manifest;
  if (!manifestStr) {
    const detail = await marketDetail("expert", item.slug);
    manifestStr = detail.manifest;
  }
  const manifest = parseManifest(item, manifestStr);

  // persona 包复用技能安装核心,装入 skills/<personaSkillSlug>(meta 标记 expert)。
  await installArtifactToSkills(item, manifest.personaSkillSlug, "expert");

  // 捆绑技能:一并安装该专家自带的市场技能(best-effort,不阻塞专家安装)。
  if (manifest.bundledSkills && manifest.bundledSkills.length > 0) {
    await installBundledSkills(manifest.bundledSkills);
  }

  const installed: InstalledExpert = {
    slug: item.slug,
    name: item.name,
    version: item.version || "",
    // 自动刷新时保留首次召唤时间:它是"我什么时候开始用这个专家",不该被每次静默更新冲掉。
    installedAt: getExpert(item.slug)?.installedAt ?? Date.now(),
    manifest,
  };
  upsertExpert(installed);

  /**
   * 收口要在刷人设**之前**:它给捆绑技能打上归属、把它们藏出全局名录,而人设表要读
   * 这批技能的 frontmatter 拼注入段。顺序反了,这次装的技能这一轮就漏进全局名录。
   */
  reconcileSkillVisibility();

  /**
   * 装专家不建 agent、也不碰主配置:人设(含专家团的成员表与名册)由插件按会话注入,
   * 这里只要把它刷进插件读的那份数据文件。纯文件写,毫秒级 —— 过去这一步是写
   * `agents.list`,要顶一轮约 15 秒的网关热加载,放在安装里用户嫌慢、挪到首条消息前
   * 用户盯着空白等,两头都不讨好。
   */
  syncPersonaData();
}

/**
 * 确保本地专家副本与市场一致——召唤(开新专家会话)前调用。
 *
 * 对齐 WorkBuddy:用户可见动作只有「召唤」,没有"安装"和"更新"两步。人设在服务端改了之后,
 * 存量用户不该靠自己去市场页点更新按钮才拿到最新版(那是把我们的分发缺陷转嫁给用户,
 * 实测就会出现"服务端早已更新、用户机器上人设悄悄过期"的情况)。
 *
 * 降级策略:回查失败(断网/服务端异常)时,本地已有副本就沿用,只告警不打断召唤;
 * 本地也没有才抛错——那种情况下会话根本无法按该专家播种,静默失败更糟。
 *
 * 只影响新会话:存量会话的 AGENTS.md 由 reassertExpertPersona 按 marker 短路保护,
 * 不会被这里的刷新改写。
 */
export async function ensureExpertFresh(slug: string): Promise<void> {
  const local = getExpert(slug);
  let detail: MarketItem;
  try {
    detail = await marketDetail("expert", slug);
  } catch (err) {
    if (local) {
      console.warn(`[expert] 无法回查市场版本,沿用本地副本「${slug}」:`, err);
      return;
    }
    throw err;
  }
  if (local && local.version === (detail.version || "")) {
    if (hasPersonaOnDisk(local)) {
      return;
    }
    console.log(`[expert] 专家「${slug}」人设资产不在盘上,重装自愈`);
  } else {
    console.log(
      `[expert] 专家「${slug}」有新版本(${local?.version || "未安装"} → ${detail.version || "?"}),自动更新`,
    );
  }
  await installExpert(detail);
}

/**
 * 只抹掉本地足迹:人设目录 + 注册表登记。纯文件操作,毫秒级。
 *
 * 从 `uninstallExpert` 里抽出来给启动期的下架对账用(`auto-update.ts`)。那里**不能**走完整
 * 卸载,两个原因都在别处量过:`removePersistentExpertAgent` 走网关 `agents.delete`,实测
 * 每个 33 秒(见本文件下方与 agent-manager.ts 的注释),启动期十几条各跑一次就是几分钟排队;
 * 而收尾的 `reconcileSkillVisibility` / `syncPersonaData` 在启动链里紧跟着自动更新跑
 * (index.ts),逐条各跑一遍纯属重复。
 *
 * 所以**调用方有义务自己收口**:要么随后跑那两步,要么身处会跑它们的启动链里。
 */
export function removeExpertFootprint(slug: string): void {
  const expert = getExpert(slug);
  if (expert) {
    try {
      removeInstalledSkillDir(expert.manifest.personaSkillSlug);
    } catch (err) {
      /**
       * 目录删不掉不许拖住登记。`removeInstalledSkillDir` 只删带我方 META 的目录
       * (保护用户手放与内核自带的技能,那道判据别放宽),而**装漏过的专家人设目录恰恰
       * 没有 META** —— 2026-08-12 真机上 `enterprise-legal-lead` 就是这样:抛出去会让
       * 整轮对账停在这一条上,后面的收口一步都跑不到,而且每次启动都撞死在同一处。
       * 留下的空目录不占运行时成本(没 META 就不算已安装),不值得为它放宽保护。
       */
      console.warn(
        `[expert] 人设目录未能删除(${slug}),仅清理登记:${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  removeExpert(slug);
}

/**
 * 卸载一个专家:删 persona 目录与它带进来的捆绑技能 + 移除持久委派 agent(若曾作团队成员
 * 创建过)+ 移除注册表登记。已由该专家发起的历史任务会话不受影响,但人设与技能都不再注入。
 */
export async function uninstallExpert(slug: string): Promise<void> {
  removeExpertFootprint(slug);
  // 清理可能存在的持久委派 agent(expert-<slug>);从未创建则容错跳过。
  await removePersistentExpertAgent(slug);
  /**
   * 注册表已经没有这个专家了,收口这一步就会把只被它引用的捆绑技能回收掉
   * (还有别的专家在用、或用户自己也装过的会留下)。过去只删人设目录不管技能,
   * 装 41 个专家滚出 135 个技能目录、卸载一个也不见少,就是这么来的。
   */
  reconcileSkillVisibility();
  // 人设表跟着收口,否则卸载后新会话仍会被注入这个专家的人设。
  syncPersonaData();
}

/** 列出本地已安装的专家(富信息:含 manifest,供选择器/会话头部渲染与播种)。 */
export function listInstalledExperts(): InstalledExpert[] {
  return loadExperts();
}
