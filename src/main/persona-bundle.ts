import { app } from "electron";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runOpenClaw } from "./openclaw-cli";
import { getExpert, loadExperts } from "./market/expert-store";
import {
  readInstalledSkillMd,
  readInstalledTeamMemberMd,
} from "./market/installer";
import { expertSkillsSection } from "./market/skill-visibility";
import { teamRosterSection, type RosterRow } from "./team-roster-prompt";
import { teamMemberLabel } from "@shared/team-roster";
import { WORKSPACE_DATA_FOLDER } from "@shared/workspace-data";
import { loadPrefs } from "./prefs";
import type { InstalledExpert } from "@shared/types";

/**
 * 专家人设的注入通道:一个内核插件,按**会话**给系统提示词追加人设。
 *
 * # 为什么不是「一个专家一个 agent」
 *
 * 那是我们原来的做法:专家各有一个常驻 `expert-<slug>` agent,人设写进它工作区的
 * AGENTS.md。功能上没问题,代价在冷启动——内核的 provider auth 预热是**逐个 agent**
 * 跑一遍鉴权发现扫描(`openclaw/src/agents/model-provider-auth.ts:
 * buildCurrentProviderAuthStateSnapshot`,注释原文 *Warm one entry per configured
 * agent*),成本 ≈ agent 数 × 供货商数。本机 84 个 agent × 3 个供货商时实测
 * `provider auth state pre-warmed in 49490ms`,而这段时间网关事件循环是被占满的,
 * 用户那边的表现就是「点了发送要等半分钟」。这个预热**关不掉**:生产路径
 * (`server.impl.ts`)不传 `enabled`,判断是 `params.providerAuthPrewarm?.enabled !== false`,
 * 没有配置项也没有环境变量。要降只能降 agent 数。
 *
 * # 参考实现怎么做的
 *
 * WorkBuddy 的专家是**插件**,不进全局 agent 注册表,所以它没有这个包袱。
 * openclaw 有形状对得上的口子,照它做即可:`before_prompt_build` 钩子拿得到
 * `ctx.sessionKey`,返回 `appendSystemContext` 就能只改这一条会话的系统提示词。
 *
 * # 专家团的成员也一样,靠 label 路由
 *
 * 成员曾经每人一个 agent(47 条,占了预热成本的一大半)。改成负责人**自己 spawn**
 * (省略 `agentId`,内核 `subagent-spawn.ts:1189`)后成员不必注册:
 *  - 名册里让负责人填 `label`(见 team-roster-prompt.ts),label 形如 `<团队>.<成员>`;
 *  - 插件在 `subagent_spawned` 事件里把 `childSessionKey → label` 记一笔,
 *    子会话的 `before_prompt_build` 触发时回查,注入对应成员人设。
 * 为什么必须记账:子会话 key 是 `agent:main:subagent:<uuid>`,里面没有任何身份信息。
 * 为什么不是 `subagent_spawning`:内核 core 的 spawn 路径**从不发这个事件**,它已被标
 * `@deprecated`(`plugins/hooks.ts:1458`,`src/agents` 内 `runSubagentSpawning(` 零命中),
 * 只留给直接调 hook runner 的老插件 —— 2026-08-10 第一版记错了钩子,表现是 label 查不到、
 * 注入静默失效。(早先这里归因成「只在 `threadRequested: true` 时触发」,那是从一次观测
 * 倒推的机制,2026-08-11 回查源码纠正。)
 *
 * 2026-08-10 动手前验过两轮真机(见 align-with-claude-and-workbuddy 技能):
 *  - 同一个 `main` agent 上两条并发会话,只有目标那条的 systemPrompt 变长;
 *  - 拿真专家人设对比「它自己的 agent」与「main + 注入」,身份自述几乎逐字一致,
 *    没有退回内核默认的通用助理。多出来的是 main 工作区的 SOUL.md / USER.md /
 *    MEMORY.md —— 而 WorkBuddy 本来就是根目录一份全局共享,这是对齐不是回归。
 *
 * # 两条容易踩空的内核事实
 *
 *  - **`before_prompt_build` 不需要开权限**:内核只在显式
 *    `plugins.entries.<id>.hooks.allowPromptInjection === false` 时才拦
 *    (`openclaw/src/plugins/registry.ts:2535`),默认放行。要显式 opt-in 的是
 *    *会话类*钩子(`llm_input` / `before_model_resolve` 等,见同文件 2555 行的
 *    `isConversationHookName` 分支),我们一个都没用,所以主配置里不必写权限。
 *  - **插件包的 JS 入口只从 `package.json` 的 `openclaw.extensions` 读**
 *    (`openclaw/src/plugins/manifest.ts:2026`),manifest 文件名只认
 *    `openclaw.plugin.json`(同文件 26 行),且 `id` 与 `configSchema` 缺一不可
 *    (1750 / 1754 行)—— 缺了报的是 `plugin manifest requires configSchema`,
 *    看不出是哪个插件,排查很费时间。
 *  - **入口不能用顶层 await**:内核加载时会把它转成 CommonJS。插件加载失败只写网关日志、
 *    对客户端完全静默(实测表现是「装好了但人设一个都不注入」),所以改插件后一定要回查
 *    `%TEMP%/openclaw/openclaw-<date>.log` 里有没有 `[plugins] yunwu-persona failed to load`。
 *  - **manifest 必须写 `activation.onCapabilities: ["hook"]`**,否则插件根本不会被加载。
 *    网关只加载「启动计划」里的插件,纯钩子插件进这份计划的唯一入口是
 *    `canStartExplicitHookPlugin`,它要求 manifest 声明 hook 能力(或主配置里给
 *    `plugins.entries.<id>.hooks` 写显式策略)——见
 *    `openclaw/src/plugins/gateway-startup-plugin-ids.ts:1709 hasHookRuntimeStartupIntent`。
 *    agent 运行时那份注册表也是**按这份启动清单收窄**的
 *    (`openclaw/src/agents/runtime-plugins.ts` 的 `onlyPluginIds`),所以漏了这条,
 *    连跑会话时都不会补加载。
 *    症状极隐蔽:`plugins list` 显示 enabled、`plugins inspect` 显示 loaded、
 *    日志里没有任何报错,但网关启动那行 `http server listening (N plugins: ...)`
 *    的名单里没有它,`register()` 一次都不执行(2026-08-10 真机排查了一轮才定位)。
 *
 * 走 `plugins install` 而不是直接把目录塞进 extensions,理由与 ui-tools-bundle 同:
 * 直接塞进去会被判「untracked local code」。人设数据(personas.json)是就地更新的,
 * 不重装、不碰主配置。
 */

/** 插件 id 即目录名(内核按目录名注册)。 */
const PLUGIN_ID = "yunwu-persona";

/** 插件包根目录:内核的 global 插件根(`<configDir>/extensions`)。 */
export function personaBundleDir(): string {
  return join(homedir(), ".openclaw", "extensions", PLUGIN_ID);
}

/** 人设数据文件名。插件每次钩子触发时按 mtime 判断要不要重读。 */
const DATA_FILE = "personas.json";

/** 任务工作目录表的文件名(同目录第二份数据文件,插件同样按 mtime 重读)。 */
const WORKSPACE_DATA_FILE = "workspaces.json";

/**
 * 表里最多留多少个任务。
 *
 * 这份表是**派生数据**:每次 ensureSession 都会把当前任务重新写进来,丢了也只是
 * 下一条消息前自动补上。上限是防它随任务数无限长——一条约 100 字节,500 条足够
 * 覆盖近期在聊的任务,更老的任务一发消息就会重新入表。
 */
const MAX_TRACKED_TASK_DIRS = 500;

/** 插件包要落地的文件(源码在 resources 下,当资源发,见 index.mjs 的模块头)。 */
const BUNDLE_FILES = ["index.mjs", "package.json", "openclaw.plugin.json"];

/**
 * 插件源码目录。
 *
 * 打包后在 `process.resourcesPath/persona-plugin`(与内核 `resources/openclaw` 同一个约定,
 * 见 openclaw-cli.ts:bundledKernelEntry);开发期 `process.resourcesPath` 指向 Electron 自己的
 * resources,所以回退到仓库里那份。
 */
function pluginSourceDir(): string {
  const packaged = join(process.resourcesPath ?? "", "persona-plugin");
  if (existsSync(join(packaged, "index.mjs"))) {
    return packaged;
  }
  return join(app.getAppPath(), "resources", "persona-plugin");
}

/** 内容一致就不写:manifest 的 mtime 会被内核注册表拿去判新旧。 */
function writeIfChanged(path: string, content: string): boolean {
  try {
    if (readFileSync(path, "utf-8") === content) {
      return false;
    }
  } catch {
    /* 读不到就是没有,照写 */
  }
  writeFileSync(path, content, "utf-8");
  return true;
}

/** 把插件三个文件拷进 `dir`,返回是否有文件发生变化(变了要重装)。 */
function writeBundleFiles(dir: string): boolean {
  const src = pluginSourceDir();
  mkdirSync(dir, { recursive: true });
  let changed = false;
  for (const name of BUNDLE_FILES) {
    // 逐字节照搬,不做模板替换:插件源码就是源码,任何改写都会让日志里的行号对不上。
    changed =
      writeIfChanged(join(dir, name), readFileSync(join(src, name), "utf-8")) ||
      changed;
  }
  return changed;
}

/** 人设表:插件读的那份数据。 */
interface PersonaTable {
  /** 专家 slug → 人设正文(专家团负责人的正文末尾带成员名册)。 */
  experts: Record<string, string>;
  /** `sessions_spawn` 的 label → 成员人设正文(见 `@shared/team-roster` 的 label 约定)。 */
  members: Record<string, string>;
}

/**
 * 备好某个专家团的负责人名册与成员人设。
 *
 * 成员两种来源都要收:`members` 是人设随团队包下发的(外部导入的团队全是这种),
 * `memberSlugs` 是引用其它已安装专家的(我们自撰的样板团队)。读不到人设的成员直接不算成员
 * —— 派过去只会得到一个没有角色设定的空会话,列在名册里是误导。
 */
function collectTeam(
  expert: InstalledExpert,
  members: Record<string, string>,
): { rows: RosterRow[] } {
  const m = expert.manifest;
  const rows: RosterRow[] = [];
  // 团队的捆绑技能是整包一起下发的,成员也要拿到:WorkBuddy 那边一个专家插件被激活,
  // 它带的技能对这条会话里的所有角色都在。
  const skills = expertSkillsSection(m.bundledSkills);

  for (const member of m.members ?? []) {
    const persona = readInstalledTeamMemberMd(m.personaSkillSlug, member.id);
    if (!persona) {
      continue;
    }
    const label = teamMemberLabel(expert.slug, member.id);
    members[label] = persona + skills;
    rows.push({
      id: label,
      label: memberDisplay(member.displayName, member.profession) || member.id,
      purpose: member.description,
    });
  }

  for (const slug of m.memberSlugs ?? []) {
    const sub = getExpert(slug);
    if (!sub) {
      continue;
    }
    const persona = readInstalledSkillMd(sub.manifest.personaSkillSlug);
    if (!persona) {
      continue;
    }
    const label = teamMemberLabel(expert.slug, slug);
    // 引用式成员本身就是个已安装专家,带的是它自己那份技能,不是团队包里的。
    members[label] = persona + expertSkillsSection(sub.manifest.bundledSkills);
    // 没有 purpose:引用式成员是我们自撰的专家,展示名与职业本身就说明了职责。
    rows.push({
      id: label,
      label:
        memberDisplay(
          sub.manifest.displayName || sub.name,
          sub.manifest.profession,
        ) || slug,
    });
  }

  return { rows };
}

/** 把展示名与职业拼成一句给模型看的说明。 */
function memberDisplay(displayName?: string, profession?: string): string {
  const parts = [displayName?.trim(), profession?.trim()].filter(Boolean);
  return parts.length > 1 ? `${parts[0]}(${parts[1]})` : (parts[0] ?? "");
}

/**
 * 由已安装专家推导人设表。
 *
 * 单体专家与专家团负责人都收,区别只在负责人的正文末尾要接一段成员名册
 * (那是唯一稳定的面向模型注入点,理由见 team-roster-prompt.ts 的模块头)。
 *
 * 刻意不带 `identity.name` / `tools.allow` / 专属模型:
 *  - 本机 39 个已安装专家里,声明 `tools` 白名单的**零个**、声明专属模型的**零个**,
 *    所以这两样在实际资产上没有对应物;
 *  - `identity.name` 只影响内核日志里的显示名,模型看到的身份来自人设正文。
 * 将来真有专家要限工具或钉模型,得另找落点(工具白名单是 agent 级的,会话级没有对应字段),
 * 不要顺手把 agent 加回来。
 */
function buildPersonaTable(): PersonaTable {
  const experts: Record<string, string> = {};
  const members: Record<string, string> = {};
  for (const expert of loadExperts()) {
    const body = readInstalledSkillMd(expert.manifest.personaSkillSlug);
    if (!body) {
      // 人设读不到就不登记:注入空串等于让会话退化成通用助手,而且没有任何日志痕迹。
      console.warn(
        `[persona] 专家「${expert.slug}」的人设技能「${expert.manifest.personaSkillSlug}」正文为空,未登记`,
      );
      continue;
    }
    // 捆绑技能已被收口出全局名录(skill-visibility.ts),这里是它们唯一的露面机会。
    const persona = body + expertSkillsSection(expert.manifest.bundledSkills);
    if (!expert.manifest.isTeam) {
      experts[expert.slug] = persona;
      continue;
    }
    const { rows } = collectTeam(expert, members);
    if (rows.length === 0) {
      // 一个成员都读不到:按单体专家登记,负责人自己把活干完,别给它一张空名册。
      console.warn(
        `[persona] 专家团「${expert.slug}」没有可委派的成员,按单体专家登记`,
      );
      experts[expert.slug] = persona;
      continue;
    }
    experts[expert.slug] = persona + teamRosterSection(rows, "label");
  }
  return { experts, members };
}

/**
 * 刷新人设数据文件(幂等,内容不变不落盘)。
 * 装/卸专家、人设热更新、启动时都要调一次——插件只读这份文件,不认别的来源。
 */
export function syncPersonaData(): void {
  const dir = personaBundleDir();
  try {
    mkdirSync(dir, { recursive: true });
    const content = `${JSON.stringify(buildPersonaTable(), null, 2)}\n`;
    writeIfChanged(join(dir, DATA_FILE), content);
  } catch (err) {
    // 写不出来只影响新会话的人设,不该拦住启动;下一次 ensureSession 还会再试。
    console.warn("[persona] 刷新人设数据失败:", err);
  }
}

/**
 * 记下「这个任务这一轮的工作目录」,供插件按会话注入项目级记忆与技能。
 *
 * # 为什么要这张表
 *
 * 项目级记忆要跟着工作目录走,而插件在 `before_prompt_build` 里只拿得到
 * `ctx.sessionKey` 与 `ctx.workspaceDir` —— 后者是**agent 的工作区**
 * (所有任务共用的 `~/.openclaw/workspace`),不是这条会话的 `spawnedCwd`,
 * 上下文里也没有 cwd 字段(`openclaw/src/agents/embedded-agent-runner/run/attempt.ts:3929-3945`)。
 * 所以「会话 → 工作目录」这层映射只能由我们自己递过去,与 personas.json 同一个套路。
 *
 * # 为什么不是只记「选过工作空间」的任务
 *
 * WorkBuddy 每个任务都有 workDir(没选工作空间时就是它自己那个时间戳目录),记忆一律落在
 * `<workDir>\.workbuddy\memory`。本机 92 个工作空间里 22 个有记忆,大半正是时间戳任务目录。
 * 所以这里传的是 `getTaskWorkspaceDir` 的结果 —— 绑了工作空间就是工作空间,没绑就是那个
 * 一次性目录,两种情况都有记忆,换工作空间自然就换记忆。
 *
 * # 开关一起写在这份表里
 *
 * 「本地技能与记忆沉淀」关掉后整段不注入,而插件读不到我们的偏好文件,只能随这份表递过去。
 * 本接口每次发消息都会走,所以用户拨完开关下一条消息就是新值 —— 与 WorkBuddy 的
 * 「下一轮 prompt 渲染生效、无需重启」同口径(asar 里 adapter 的
 * `saveLocalSkillsMemoryEnabled` 注释原文)。
 */
/**
 * 建好工作空间里的数据目录,并给它一份把自己整个忽略掉的 `.gitignore`。
 *
 * # 为什么要这一步
 *
 * 工作空间可以是用户自己的真实项目目录(「打开本地文件夹」那条路),而记忆日志与项目级技能
 * 都写在里面。不管的话 `.yunwu-desktop/` 会作为未跟踪文件出现在 `git status` 里,
 * 提交前要用户自己去分辨、去忽略——那是我们塞给他的活。
 *
 * **WorkBuddy 没有这一步,但它也没暴露过这个问题**:2026-08-12 扫它本机 93 个工作空间,
 * 是 git 仓库的 0 个(全是它自己建的时间戳目录),点目录里带 `.gitignore` 的也是 0 个。
 * 所以这条是我们的场景比它多出来的一块,不是它做了我们没跟。
 *
 * 已存在就不覆盖:用户可能想让这些文件进版本库(团队共享项目约定是合理诉求),
 * 他删掉或改写这份 `.gitignore` 之后,我们不该每发一条消息就给他改回来。
 */
function ensureWorkspaceDataDir(dir: string): void {
  try {
    const dataDir = join(dir, WORKSPACE_DATA_FOLDER);
    const ignore = join(dataDir, ".gitignore");
    if (existsSync(ignore)) {
      return;
    }
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(ignore, "# 云雾助手的项目记忆与技能,默认不进版本库\n*\n", "utf-8");
  } catch {
    /* 目录只读、盘满之类都不该拦住发消息:没有它只是 git 里多几行未跟踪文件 */
  }
}

export function syncTaskWorkspaceData(taskId: string, dir: string): void {
  if (!taskId || !dir) {
    return;
  }
  const file = join(personaBundleDir(), WORKSPACE_DATA_FILE);
  try {
    mkdirSync(personaBundleDir(), { recursive: true });
    let dirs: Record<string, string> = {};
    try {
      const prev = JSON.parse(readFileSync(file, "utf-8")) as {
        dirs?: Record<string, string>;
      };
      dirs = prev.dirs && typeof prev.dirs === "object" ? prev.dirs : {};
    } catch {
      /* 没有或坏了都从空表重建,这份数据是派生的 */
    }
    // 先删再写:JSON 的字符串键按插入序序列化,重写一遍就把这个任务顶到末尾,
    // 于是下面按序砍掉的一定是最久没用过的那些。
    delete dirs[taskId];
    dirs[taskId] = dir;
    const keys = Object.keys(dirs);
    for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_TRACKED_TASK_DIRS))) {
      delete dirs[stale];
    }
    const enabled = loadPrefs().localSkillsMemoryEnabled;
    if (enabled) {
      ensureWorkspaceDataDir(dir);
    }
    writeIfChanged(
      file,
      `${JSON.stringify({ enabled, dataFolderName: WORKSPACE_DATA_FOLDER, dirs }, null, 2)}\n`,
    );
  } catch (err) {
    // 写不出来只是这一轮不注入项目级记忆,不该拦住发消息。
    console.warn("[persona] 刷新任务工作目录表失败:", err);
  }
}

/**
 * 落地 / 更新人设插件包。
 *
 * 已装且入口未变就只刷数据;入口或 manifest 变了(或压根没装)才走一次官方安装。
 * 首次安装当次网关可能还没加载到它(CLI 自己也提示 "Restart the gateway to load plugins"),
 * 下次启动即生效 —— 所以安装要在启动早期做,别等到用户点专家的那一刻。
 */
export async function syncPersonaBundle(): Promise<void> {
  const installed = personaBundleDir();
  const needsInstall = !existsSync(join(installed, "openclaw.plugin.json"));
  const changed = writeBundleFiles(installed);

  if (needsInstall || changed) {
    // 安装源必须是另一个目录:`plugins install` 是「从源目录拷进 extensions」。
    const stage = join(tmpdir(), "yunwu-persona-install");
    const stageBundle = join(stage, PLUGIN_ID);
    try {
      rmSync(stage, { recursive: true, force: true });
      writeBundleFiles(stageBundle);
      await runOpenClaw(["plugins", "install", stageBundle, "--force"]);
    } catch (err) {
      console.warn(
        "[persona] 安装人设插件失败,专家人设可能要到下次启动才生效:",
        err,
      );
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }

  /**
   * 数据文件必须在安装**之后**写:`plugins install --force` 是整目录覆盖,
   * 而安装源里没有 personas.json —— 先写就会被这一步抹掉(2026-08-10 真机踩到,
   * 表现是插件装好了但一个人设都注入不了,且没有任何报错)。
   */
  syncPersonaData();
}
