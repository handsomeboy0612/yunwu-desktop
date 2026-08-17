import { join } from "path";
import { tmpdir } from "os";
import { existsSync, readFileSync, writeFileSync, rmSync } from "fs";
import { runOpenClaw } from "./openclaw-cli";
import { gatewayClient, viaGatewayOrCli } from "./gateway-client";
import {
  getAgentWorkspaceDir,
  openclawConfigFile,
  resolveKernelWorkspaceDir,
} from "./workspace";
import { loadActivation } from "./store";
import { getExpert } from "./market/expert-store";
import {
  readInstalledSkillMd,
  readInstalledTeamMemberMd,
} from "./market/installer";
import { YW_TOOL_PROTOCOL_MD, TOOL_PROTOCOL_MARKER } from "./tool-protocol";
import type { ExpertTeamMember } from "@shared/types";
import {
  persistentExpertAgentId,
  teamMemberAgentId,
} from "@shared/team-roster";
import { teamRosterSection } from "./team-roster-prompt";
import { agentHasSessions, ensureSessionTruth } from "./session-index";

/**
 * agent 生命周期管理。
 *
 * **agent 不再等于任务,也不再等于专家**。任务是「`main` 上的一条 `acp:` 会话」,隔离由
 * 会话条目的 `spawnedCwd` 提供(见 `@shared/session-key`);专家身份由人设插件按会话注入
 * (见 main/persona-bundle.ts)。所以新装的专家、新开的任务都不会往 `agents.list` 写东西,
 * 本模块今天只服务两件事:**存量**任务那些 `expert-<slug>` 条目的兜底与清理。
 *
 * 为什么要这样:内核冷启动的 provider auth 预热是**逐个 agent** 扫的,84 个 agent × 3 个
 * 供货商实测 49.5 秒,期间事件循环被占满,用户看到的就是「点了发送要等半分钟」。
 * agent 数是唯一能降的那个因子,预热本身关不掉。
 *
 * **建 agent 不调 `agents.create`,只往 `agents.list` 写一条**(见 seedAgentAsExpert)。
 * 那个 RPC 替我们做的是「写条目 + 铺 workspace 脚手架」:条目我们本来就要紧接着改一遍
 * (身份、工具、委派名单),脚手架我们本来就要推翻重写。分两步的代价是**两次落盘、
 * 两轮网关热加载**,实测两笔写入间隔 15 秒。合并成一次之后,建一个专家只落一次盘。
 * 这也是 ClawX 的形状:它的 `utils/agent-config.ts:createAgent` 同样是整份配置读改写
 * (`mutateOpenClawConfig`),工作区另行 ensure,全程不碰 `agents.create`。
 * 内核认这种 agent —— 2026-08-10 实测:纯 config.set 追加一条后,网关 `agents.list`
 * 立刻报告它,`sessions.create` / `sessions.patch` 均 ok,agentDir 按内核默认布局解析到
 * `~/.openclaw/agents/<id>/`。现存 50 条里本来就有 41 条(专家团成员)从来没走过那个 RPC。
 *
 * 三条纪律:
 *  - 少写:写 `agents.list` 会顶一轮约 15 秒的网关热加载(实测把紧随其后的
 *    `sessions.create` 堵了 14.5 秒),而且每多一条都会让此后每次冷启动更慢。
 *    所以只在存量任务的 agent 真的缺失时才写(ensureAgent),不做预热式补种;
 *  - 幂等:重复 ensure 同一 agent 不重复播种;跨重启读磁盘 `agents.list` 校正缓存;
 *  - 串行:所有写 ~/.openclaw/openclaw.json 的操作(写入/删除)经单一队列串行执行,
 *    规避并发写同一配置文件导致的竞态/损坏。
 */

/** 已知 agent id 缓存;null 表示尚未从内核初始化。 */
let knownAgents: Set<string> | null = null;

/** 串行队列尾指针:所有 agent 写操作串行链接在其后。 */
let opQueue: Promise<unknown> = Promise.resolve();

/** agent id 白名单:仅允许字母数字及 . _ -,防止拼进 CLI 参数时产生意外。 */
const VALID_AGENT_ID = /^[a-zA-Z0-9._-]+$/;

/**
 * 把一个异步操作排入串行队列,返回其结果 promise。
 * 无论前一个操作成功或失败,队列都会继续推进,避免一次失败卡死后续所有操作。
 */
function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = opQueue.then(op, op);
  opQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 校验 agent id 合法性;非法直接抛错(调用方生成的 taskId 应始终合法)。 */
function assertValidAgentId(agentId: string): void {
  if (!VALID_AGENT_ID.test(agentId)) {
    throw new Error(`非法 agentId:${agentId}`);
  }
}

/**
 * 从内核加载现有 agent id 集合(带缓存);解析失败按空集合处理,由 add 的幂等兜底。
 *
 * 直接读磁盘上的 `agents.list`,不再 spawn `openclaw agents list --json`:
 * 那是一次完整的内核冷启动(实测约 2.9s),而它落在**首条消息的关键路径**上 ——
 * ensureAgent 的第一件事就是等它。数据源是同一份 openclaw.json(CLI 也是读它),
 * 本模块的 upsertAgentEntries / stripAgentSkillFilters 早就这么读了。
 * 万一漏读了某个已存在的 agent,后果也只是重播一次种:upsertAgentEntries 按 id 浅合并,
 * 不会写出重复条目。
 */
async function ensureKnownLoaded(): Promise<Set<string>> {
  if (knownAgents) {
    return knownAgents;
  }
  const set = new Set<string>();
  try {
    const file = openclawConfigFile();
    if (existsSync(file)) {
      const config = JSON.parse(readFileSync(file, "utf-8")) as {
        agents?: { list?: AgentEntry[] };
      };
      for (const a of config.agents?.list ?? []) {
        if (typeof a?.id === "string") {
          set.add(a.id);
        }
      }
    }
  } catch {
    /* 读取失败:留空集合,后续 add 以 already-exists 兜底幂等。 */
  }
  knownAgents = set;
  return set;
}

/**
 * 解析任务 agent 使用的模型(provider/model 形式)。
 * override 非空(专家专属模型,已是内核完整键如 `yunwu/glm-5.1`)时优先使用;
 * 否则回退激活配置的默认模型。均缺失时抛出可读错误。
 */
function resolveAgentModel(override?: string): string {
  if (override) {
    return override;
  }
  const activation = loadActivation();
  if (!activation?.defaultModel) {
    throw new Error("未找到激活配置或默认模型,无法创建任务。请先完成激活。");
  }
  return `yunwu/${activation.defaultModel}`;
}

/**
 * 单条 agents.list 条目(仅列出本模块读改写会触碰的字段;其余字段原样透传保留)。
 * 与内核 AgentConfig 对齐:声明式写入是整体替换,故合并时必须保住所有既有条目与字段。
 */
type AgentEntry = Record<string, unknown> & { id?: string };

/**
 * 读改写 agents.list:按 id 逐条浅合并(不存在则追加),其余条目(main + 所有任务/专家 agent)
 * 原样保留,再整体写回(见 writeAgentList)。
 *
 * **一次调用写 N 条**是这个函数存在的理由:专家团动辄二十来个成员,逐条写就是逐条往返。
 * 走网关后单次往返已降到毫秒级,但一次写入仍比 N 次省,且退回 CLI 时(每次都是一遍内核
 * 冷启动,实测 config 类命令约 2s)差距会重新放大到分钟级,所以这个形状保留。
 *
 * 纪律:
 *  - 只读磁盘上的 openclaw.json 拿现状(与 session-history 一致的纯 fs 读),写交给内核
 *    (避免手写 JSON 与内核 schema 漂移);
 *  - 必须在串行队列内调用(enqueue),防止与创建/删除并发写坏同一配置;
 *  - `agents.list` 变更被内核归类为 kind:"hot",热加载生效、不重启网关。
 */
async function upsertAgentEntries(entries: AgentEntry[]): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  const file = openclawConfigFile();
  if (!existsSync(file)) {
    throw new Error("未找到 openclaw.json,无法写入专家 agent 配置");
  }
  const config = JSON.parse(readFileSync(file, "utf-8")) as {
    agents?: { list?: AgentEntry[] };
  };
  const list = config.agents?.list;
  if (!Array.isArray(list)) {
    throw new Error("openclaw.json 缺少 agents.list,无法写入专家 agent 配置");
  }
  for (const entry of entries) {
    const idx = list.findIndex((e) => e?.id === entry.id);
    if (idx < 0) {
      list.push(entry);
    } else {
      // 浅合并;该条目与其余条目的既有字段原样保留(整体替换的前提)。
      list[idx] = { ...list[idx], ...entry };
    }
  }
  await writeAgentList(list);
}

/**
 * 整体写回 agents.list。
 *
 * 调用方传进来的已是读改写后的全量列表,所以这里就是整体替换——删条目、删字段
 * (见 stripAgentSkillFilters)都依赖这个语义。走 config.set 整份写回时它天然成立:
 * 提交的配置里 agents.list 是什么就是什么。走 config.patch 的年代则要额外声明
 * `replacePaths: ['agents.list']`,否则内核把带 id 的对象数组按 id 合并,删掉的条目会活过来。
 */
async function writeAgentList(
  list: AgentEntry[],
  opts?: { skipWhenDisconnected?: boolean },
): Promise<void> {
  await viaGatewayOrCli(
    "写入 agents.list",
    () =>
      gatewayClient.setConfig((config) => {
        const agents = (config.agents ??= {}) as Record<string, unknown>;
        agents.list = list;
      }),
    () => writeAgentListViaCli(list),
    opts,
  );
}

/** CLI 兜底:经官方 `config set --batch-file` 整体写回(文件传参规避 Windows shell 转义)。 */
async function writeAgentListViaCli(list: AgentEntry[]): Promise<void> {
  const batch = [{ path: "agents.list", value: list }];
  const batchFile = join(tmpdir(), `yunwu-agents-batch-${Date.now()}.json`);
  writeFileSync(batchFile, JSON.stringify(batch), "utf-8");
  try {
    await runOpenClaw([
      "config",
      "set",
      "--batch-file",
      batchFile,
      "--replace",
    ]);
  } finally {
    try {
      rmSync(batchFile);
    } catch {
      /* 清理失败不影响主流程 */
    }
  }
}

/**
 * 一次性迁移:抹掉所有 agents.list 条目上的 skills 白名单(见 buildExpertPatch 的说明)。
 *
 * 新建会话已不再写这个字段,但**存量专家会话**(用户可能正调得顺手、不愿重建)配置里还留着,
 * 不清就永远看不到后装的插件技能。启动时跑,无字段可清则直接返回、不落一次 CLI 写入。
 * 失败只告警:这是能力放开,不该拦住应用启动。
 */
export function stripAgentSkillFilters(): Promise<void> {
  return enqueue(async () => {
    const file = openclawConfigFile();
    if (!existsSync(file)) {
      return;
    }
    try {
      const config = JSON.parse(readFileSync(file, "utf-8")) as {
        agents?: { list?: AgentEntry[] };
      };
      const list = config.agents?.list;
      if (!Array.isArray(list) || !list.some((e) => e && "skills" in e)) {
        return;
      }
      const cleaned = list.map((e) => {
        if (!e || !("skills" in e)) {
          return e;
        }
        const { skills: _drop, ...rest } = e;
        return rest;
      });
      // 这条迁移跑在启动早期,网关多半还没起来;不等建连直接落盘,免得白白拖住整条启动链。
      await writeAgentList(cleaned, { skipWhenDisconnected: true });
      console.log(
        "[agents] 已清除 agents.list 上的 skills 白名单,专家会话可见全部已装技能",
      );
    } catch (err) {
      console.warn("[agents] 清除 skills 白名单失败:", err);
    }
  });
}

/**
 * 一次性迁移:删掉 `agents.list` 里没有任何会话的 `expert-*` 条目。
 *
 * # 为什么要删
 * 专家不再需要 agent(人设改由插件按会话注入,见 main/persona-bundle.ts),但存量安装里
 * 攒着一大堆:本机 84 条中 71 条一次都没被用过。它们不是死重 —— 内核冷启动的 provider auth
 * 预热**逐个 agent** 扫一遍鉴权(`src/agents/model-provider-auth.ts`),84 个 agent × 3 个
 * 供货商实测 `provider auth state pre-warmed in 49490ms`,期间事件循环被占满,用户看到的
 * 就是「点了发送要等半分钟」。删掉没用过的那些,预热才降得下来。
 *
 * # 为什么要分批写
 * 内核有配置体积陡降保护:`previousBytes >= 512 && nextBytes < floor(previousBytes * 0.5)`
 * 就**整批拒写**,报一句和内容无关的 `Config write rejected`(`openclaw/src/config/io.ts`)。
 * 豁免开关 `allowConfigSizeDrop` 整个 `src/gateway` 零命中,走网关的写入永远没有豁免。
 * 本机 `agents.list` 占配置 76%,一次删光就是 39083 → 17785 字节,正好撞线。所以按预算
 * 一轮删一部分,每轮都留在半数以上,下一轮的基准就跟着降,两三轮删完。
 *
 * # 哪些必须留
 * 存量任务的会话键钉在 `agent:expert-<slug>:acp:<taskId>` 上,条目删了内核直接报
 * `Agent "<id>" no longer exists in configuration`,那条任务就废了。判据取该 agent 的
 * 会话存储里有没有条目(纯 fs 读);专家团负责人还活着时,它的成员条目也要一起留 ——
 * 存量任务的名册里写的是成员 agent id,负责人仍会指名道姓 spawn 它们。
 *
 * agent 目录(`~/.openclaw/agents/<id>/`)刻意不删:里面是历史记录,而 `agents.delete`
 * 实测 33 秒一个(要清会话绑定、再把三个目录移进回收站),71 个跑不完。留着不花运行时成本
 * —— 内核只认配置里列出的 agent。
 */
export function pruneUnusedExpertAgents(): Promise<void> {
  return enqueue(async () => {
    try {
      // 判据是「这个专家有没有会话」,所以先确认手里有一份可信的会话真相(网关清单或磁盘上
      // 6.11 的 JSON 库,任一即可)。**两个都没有就整轮不清**:与
      // `market/auto-update.ts:reconcileExperts` 同一个纪律——删除不可逆,而"问不到"与
      // "真的没人用"报出来是同一个空表。少清一次只是下次启动再清,清错一次会废掉存量任务。
      if (!(await ensureSessionTruth())) {
        console.warn("[agents] 取不到会话清单,本轮不清理专家 agent");
        return;
      }
      for (let round = 1; round <= 6; round++) {
        const pruned = await pruneOneRound(round);
        if (pruned === "done") {
          return;
        }
      }
      console.warn(
        "[agents] 清理未使用的专家 agent:轮次用尽仍未删完,下次启动继续",
      );
    } catch (err) {
      // 只是性能优化,不该拦住启动;下次启动还会再试。
      console.warn("[agents] 清理未使用的专家 agent 失败:", err);
    }
  });
}

/** 一轮清理:算出这轮能删多少、写回,返回 done 表示没有可删的了。 */
async function pruneOneRound(round: number): Promise<"done" | "more"> {
  const file = openclawConfigFile();
  if (!existsSync(file)) {
    return "done";
  }
  const raw = readFileSync(file, "utf-8");
  const config = JSON.parse(raw) as { agents?: { list?: AgentEntry[] } };
  const list = config.agents?.list;
  if (!Array.isArray(list)) {
    return "done";
  }

  const doomed = list.filter((e) => isPrunableExpertAgent(e, list));
  if (doomed.length === 0) {
    return "done";
  }

  /**
   * 这轮的体积下限。留 5% 余量:我们按「读进来的源文件重新序列化」估算写入后的体积,
   * 而内核落盘的是它自己拼的那份(会多一个 `meta.lastTouchedAt`),估算不会完全相等。
   */
  const floorBytes = Math.floor(Buffer.byteLength(raw) * 0.55);
  const keep = [...list];
  const removed: string[] = [];
  for (const entry of doomed) {
    const idx = keep.findIndex((e) => e === entry);
    const candidate = keep.filter((_, i) => i !== idx);
    if (estimateConfigBytes(config, candidate) < floorBytes) {
      break;
    }
    keep.splice(idx, 1);
    removed.push(String(entry.id));
  }
  if (removed.length === 0) {
    // 一条都塞不进预算:单条比半份配置还大,不该发生;报出来别静默转圈。
    console.warn(
      "[agents] 清理未使用的专家 agent:体积预算放不下任何一条,已停止",
    );
    return "done";
  }

  await writeAgentList(keep);
  for (const id of removed) {
    knownAgents?.delete(id);
  }
  const rest = doomed.length - removed.length;
  console.log(
    `[agents] 第 ${round} 轮清理:删掉 ${removed.length} 条未使用的专家 agent` +
      (rest > 0 ? `,还剩 ${rest} 条(躲体积陡降保护,下一轮继续)` : ""),
  );
  return rest > 0 ? "more" : "done";
}

/** 把候选列表放回配置里估算落盘体积(口径同内核:2 空格缩进 + 末尾换行)。 */
function estimateConfigBytes(
  config: { agents?: { list?: AgentEntry[] } },
  list: AgentEntry[],
): number {
  const probe = { ...config, agents: { ...(config.agents ?? {}), list } };
  return Buffer.byteLength(`${JSON.stringify(probe, null, 2)}\n`);
}

/** 这条 `expert-*` 条目还有没有人要:自己有会话、或它是某个还有会话的专家团的成员,都要留。 */
function isPrunableExpertAgent(entry: AgentEntry, list: AgentEntry[]): boolean {
  const id = typeof entry?.id === "string" ? entry.id : "";
  if (!id.startsWith("expert-")) {
    // `main` 与用户自建的 agent 一概不碰:这条迁移只负责我们自己造出来的那批。
    return false;
  }
  if (hasStoredSessions(id)) {
    return false;
  }
  for (const other of list) {
    const leader = typeof other?.id === "string" ? other.id : "";
    if (
      leader &&
      leader !== id &&
      id.startsWith(`${leader}-`) &&
      hasStoredSessions(leader)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * 该 agent 的会话库里有没有条目(不认识按「没有」算:从没出现过就是从没跑过)。
 *
 * 口径与 `session-history.ts:listTaskSessionKeys` 同源,都走 `session-index.ts`——
 * 那里说明了为什么不再直接读 `sessions.json`(7.2 起它不是权威口径)。这里保持同步:
 * 调用方是清理判据里的同步谓词,而清理跑在启动链最后一步,索引早已刷新过。
 */
function hasStoredSessions(agentId: string): boolean {
  return agentHasSessions(agentId);
}

/** 委派所需的子 agent 工具名(团队 lead 若设工具白名单,必须放行这两个才能委派)。 */
const SUBAGENT_TOOLS = ["sessions_spawn", "sessions_send"];

/**
 * 由专家清单构造 agents.list 条目 patch(不含委派;委派由 seed 层按需叠加)。
 *  - identity.name(展示名);
 *  - tools.allow(工具白名单;可选 extraTools 合并,如团队 lead 的委派工具)。
 *
 * **刻意不写 skills**:内核对 `agents.list[].skills` 的语义是白名单过滤(条目上只要有这个
 * 键就启用过滤),写上之后该会话就只能看见列出的那几个技能——后装的任何插件能力(PPT、
 * 文档处理等)对专家会话永久不可见,而「让小红书专家把方案做成 PPT」恰恰是最自然的诉求。
 * 对齐 WorkBuddy:专家插件里的 skills 是声明「本插件**贡献**哪些技能」(做加法,进全局池),
 * agent 本身不设限;人设强度由 persona AGENTS.md 承担(见 writePersonaAgentsMd)。
 */
function buildExpertPatch(
  expert: NonNullable<ReturnType<typeof getExpert>>,
  extraTools: string[] = [],
): Record<string, unknown> {
  const m = expert.manifest;
  const patch: Record<string, unknown> = {};
  const displayName = m.displayName || expert.name;
  if (displayName) {
    patch.identity = { name: displayName };
  }
  const tools = Array.isArray(m.tools) ? [...m.tools] : [];
  if (tools.length > 0) {
    // 有白名单时才需并入额外工具(空白名单表示继承默认全集,无需补)。
    const merged = Array.from(new Set([...tools, ...extraTools]));
    patch.tools = { allow: merged };
  }
  return patch;
}

/**
 * 把 persona 正文写入某 agent workspace 的 AGENTS.md(始终注入的引导上下文)。
 * 读到空 persona 时告警而非静默跳过(历史上静默跳过导致会话退化成通用助手、模型不调 ask_user)。
 * trailer 压在人设之后(目前只有专家团的成员名册用它)。
 * 返回 persona 是否可用(内容已一致时也算,那说明本来就是对的)。
 *
 * **内容一致就不写**。这里曾用一个文本标记(`角色覆盖`)判断「是否已注入」,但那是我们自撰
 * 人设的写法 —— 导入的专家人设是给原平台写的英文正文,根本没有这个词,于是判断对它们永远
 * 不成立,每次开会话都白重写一遍同样的 12KB。改成直接比内容,顺带把「内核默认模板覆盖了
 * persona」这种情况一并盖住:不管现场是什么,只要不等于该写的就重写。
 */
function writePersonaAgentsMd(
  agentId: string,
  personaSkillSlug: string,
  trailer = "",
): boolean {
  const persona = readInstalledSkillMd(personaSkillSlug);
  if (!persona) {
    console.warn(
      `[persona] 技能「${personaSkillSlug}」正文为空,未写入 AGENTS.md;` +
        `会话 ${agentId} 可能退化为通用助手。请确认该 persona 技能已安装。`,
    );
    return false;
  }
  const agentsMd = join(getAgentWorkspaceDir(agentId), "AGENTS.md");
  const want = persona + trailer;
  try {
    if (readFileSync(agentsMd, "utf-8") === want) {
      return true;
    }
  } catch {
    /* 读不到(不存在/损坏)按未注入处理,继续重写。 */
  }
  writeFileSync(agentsMd, want, "utf-8");
  return true;
}

/**
 * 内核的「身份仪式」文件,一律删掉(幂等)。
 *
 * BOOTSTRAP.md 是内核的「首次醒来」引导:要求 agent 先自述身份、写 IDENTITY.md / USER.md
 * 再干活。IDENTITY.md 则是内核给 agent 记的名字。两者对云雾都是纯干扰——身份已由 persona
 * 唯一确定,实测它们在场时模型会自取名字(如"小助")、把身份文件当成第一份产出物,
 * 挤掉真正的任务。
 *
 * 都只能删而不能靠配置关掉:
 *  - BOOTSTRAP.md 不在 `skipOptionalBootstrapFiles` 的覆盖范围内,而 `skipBootstrap` 会连
 *    workspace 的 git init 一起跳过,代价更大;
 *  - IDENTITY.md 虽然列在 `skipOptionalBootstrapFiles` 里,但网关的 agents.create 是在
 *    `ensureAgentWorkspace` **之外**另写一遍的(那份 skip 名单管不到它),实测新建即出现。
 *    我们已不再调那个 RPC(见模块头),新建的 agent 不会再有这个文件;这一手留着是为了
 *    早年走过 agents.create 的那批存量 agent —— 它们磁盘上那份还在。
 *
 * 删一次即长期有效:内核重建它们的前提是 workspace state 无 bootstrapSeededAt 且必需引导
 * 文件仍与模板一致,而我们写过 persona / 工具规约后这两条都不再成立。
 */
function dropIdentityRitual(agentId: string): void {
  const dir = resolveKernelWorkspaceDir(agentId);
  for (const name of ["BOOTSTRAP.md", "IDENTITY.md"]) {
    const p = join(dir, name);
    try {
      rmSync(p, { force: true });
    } catch (err) {
      // 删不掉不阻塞会话:只是模型可能多花一轮做自我介绍。
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[bootstrap] 删除 ${p} 失败:${msg}`);
    }
  }
}

/**
 * 去时序化地校正某 agent workspace 的引导文件(每次开跑前调用,幂等)。
 * 合成一处是为了让「注入规约」与「移除内核仪式」永远同时发生,避免将来新增调用点时只做一半。
 */
export function ensureWorkspaceGuides(agentId: string): void {
  ensureToolProtocol(agentId);
  ensureLongTermMemory(agentId);
  dropIdentityRitual(agentId);
}

/**
 * 跨任务共享的长期记忆,只在缺失时播一份空脚手架,之后永不覆盖。
 *
 * 这是照 WorkBuddy 做的:它的工作区根目录就摆着一份 `MEMORY.md`(本机那份记着用户的
 * 硬件配置等长期事实),内容由模型自己随用随写。我们不需要 memory-core 插件,也不需要
 * 嵌入模型 —— 内核把 workspace 根的 `MEMORY.md` 当引导文件直接注入系统提示,
 * 还会额外加一句「durable user preferences and behavior guidance」的说明
 * (见内核 `src/agents/system-prompt.ts`)。
 *
 * 生效范围恰好等于「共用同一个 agent 的那批任务」:普通任务共享 `main` 这一份,
 * 每个专家共享自己那一份。注意 `acp:` 会话拿得到它 —— 内核只对 `subagent:` / `cron:`
 * 两类键做引导文件过滤(`filterBootstrapFilesForSession`),我们的任务键不在其中。
 *
 * 脚手架要短:它每轮都进上下文。
 */
function ensureLongTermMemory(agentId: string): void {
  const memoryMd = join(resolveKernelWorkspaceDir(agentId), "MEMORY.md");
  if (existsSync(memoryMd)) {
    return;
  }
  try {
    writeFileSync(memoryMd, YW_MEMORY_SEED_MD, "utf-8");
  } catch (err) {
    // 写失败不阻塞会话:只是这一轮没有长期记忆可用。
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[memory] 播种 ${agentId} 的 MEMORY.md 失败:${msg}`);
  }
}

const YW_MEMORY_SEED_MD = `# MEMORY.md — 长期记忆

跨任务共用。值得一直记住的事写在这里:用户的称呼与偏好、反复用到的项目背景、
约定好的做法、踩过的坑。

- 只记需要跨任务复用的结论,一次性的过程不要写进来。
- 每条带上日期,便于日后判断是否过期。
- 这份文件每轮都会进上下文,所以要短;过时的条目直接删掉,不要堆叠。

## 关于用户

(还没有记录)

## 约定与偏好

(还没有记录)
`;

/**
 * 确保某 agent workspace 的 TOOLS.md 为「平台工具使用规约」(幂等,去时序化:每次开跑前调用)。
 *
 * 内核 `agents add` 会在 workspace 铺一份默认 TOOLS.md 模板(摄像头/SSH/TTS 示例,对本场景无用
 * 却仍被每轮注入 system),故这里统一覆盖为我们的规约。已含标记则跳过,从而兼顾:
 *  - 内核重启/重新 bootstrap 覆盖回默认模板 → 下次开跑自动重申;
 *  - 用户手动追加的本地备注 → 只要标记还在就不动它。
 *
 * 对所有 agent(普通任务与专家会话)一视同仁:平台 UI 工具是全员共享的,不是专家特权。
 */
function ensureToolProtocol(agentId: string): void {
  const toolsMd = join(resolveKernelWorkspaceDir(agentId), "TOOLS.md");
  try {
    if (
      existsSync(toolsMd) &&
      readFileSync(toolsMd, "utf-8").includes(TOOL_PROTOCOL_MARKER)
    ) {
      return;
    }
  } catch {
    /* 读失败按未注入处理,继续重写。 */
  }
  try {
    writeFileSync(toolsMd, YW_TOOL_PROTOCOL_MD, "utf-8");
  } catch (err) {
    // 写失败不阻塞会话:模型仍可工作,只是少了工具时机引导。
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[tool-protocol] 写入 ${agentId} 的 TOOLS.md 失败:${msg}`);
  }
}

/**
 * 确保某专家会话的 AGENTS.md 与当前人设一致(去时序化:每次开跑前调用,幂等)。
 * 修复「seed 时技能尚未落盘 → 读空 → 留下内核默认模板」的时序脆弱性,
 * 以及内核重启后默认模板覆盖 persona 的情况。内容已一致时 writePersonaAgentsMd 不落盘。
 */
export function reassertExpertPersona(
  agentId: string,
  expertSlug: string,
): void {
  const expert = getExpert(expertSlug);
  if (!expert) {
    return;
  }
  // 专家团要连成员名册一起算:只补人设会把名册抹掉,负责人就此不知道能派给谁。
  const refs = expert.manifest.isTeam ? teamMemberRefs(expert) : [];
  writePersonaAgentsMd(
    agentId,
    expert.manifest.personaSkillSlug,
    legacyTeamRosterSection(refs),
  );
}

/**
 * 一名可委派的团队成员(纯读推导,不含副作用)。
 * `member` / `slug` 二者之一有值,表明人设来自团队包内还是某个独立安装的专家。
 */
interface TeamMemberRef {
  id: string;
  /** 展示名(+职业),用于 identity 与名册的"这是谁"。 */
  label: string;
  /** 一句话说明这名成员干什么,用于名册的"什么时候派他";可能缺失。 */
  purpose?: string;
  member?: ExpertTeamMember;
  slug?: string;
}

/**
 * 一名已准备就绪的团队成员。
 * `entry` 仅在该 agent 尚不存在时给出——已存在的成员不必重写配置,但仍要进 allowAgents。
 */
interface PreparedMember extends TeamMemberRef {
  entry?: AgentEntry;
}

/** 把展示名与职业拼成一句给模型看的说明。 */
function memberLabel(displayName?: string, profession?: string): string {
  const parts = [displayName?.trim(), profession?.trim()].filter(Boolean);
  return parts.length > 1 ? `${parts[0]}(${parts[1]})` : (parts[0] ?? "");
}

/**
 * 判定专家团里哪些成员可被委派,并给出各自的 agent id 与说明(纯读,不写任何文件)。
 *
 * 这里是"谁算团队成员"的唯一判据:名册章节与 allowAgents 都由它推导,两者永远同一份人——
 * 否则名册里会出现一个 spawn 必然被内核拒掉的 id。真正建 agent 的副作用在 prepareMember。
 */
function teamMemberRefs(
  expert: NonNullable<ReturnType<typeof getExpert>>,
): TeamMemberRef[] {
  const m = expert.manifest;
  const refs: TeamMemberRef[] = [];

  for (const member of m.members ?? []) {
    // 人设读不到的成员直接不算成员:委派过去只会得到一个没有角色设定的空 agent。
    if (!readInstalledTeamMemberMd(m.personaSkillSlug, member.id)) {
      continue;
    }
    refs.push({
      id: teamMemberAgentId(expert.slug, member.id),
      label: memberLabel(member.displayName, member.profession) || member.id,
      purpose: member.description,
      member,
    });
  }

  for (const slug of m.memberSlugs ?? []) {
    const sub = getExpert(slug);
    if (!sub) {
      continue;
    }
    // 没有 purpose:引用式成员是我们自撰的专家,展示名与职业本身就说明了职责。
    refs.push({
      id: persistentExpertAgentId(slug),
      label:
        memberLabel(
          sub.manifest.displayName || sub.name,
          sub.manifest.profession,
        ) || slug,
      slug,
    });
  }
  return refs;
}

/**
 * 存量团队任务的名册:成员各有一个常驻 agent,负责人按 id 指名道姓 spawn。
 * 新任务的负责人挂在 `main` 上、按 `label` 自 spawn,那份名册在 persona-bundle 里生成。
 */
function legacyTeamRosterSection(refs: TeamMemberRef[]): string {
  return teamRosterSection(refs, "agentId");
}

/**
 * 构造一条 agents.list 条目,字段对齐内核 `agents add` 的产物。
 *
 * 不写 `agentDir`:留空时内核按 `<状态目录>/agents/<id>/agent` 解析,与 `agents add` 写死的
 * 值是同一个路径。少写一个我们自己拼的绝对路径,就少一处能和内核默认布局漂移的地方。
 */
function buildAgentEntry(
  id: string,
  model: string,
  extra: Record<string, unknown>,
): AgentEntry {
  return { id, name: id, workspace: getAgentWorkspaceDir(id), model, ...extra };
}

/**
 * 铺好某成员的 workspace 与引导文件,返回其待写入 agents.list 的配置条目。
 * 该成员已存在(known)则什么都不做——不重铺,避免覆盖它已产生的上下文。
 *
 * 成员按叶子专家播种(不递归展开其自身的团队),天然把委派深度限制为 1。
 *
 * 刻意不单独建 agent:创建替我们做的只有"写一条配置 + 铺 workspace 脚手架",前者
 * 攒起来一次写更划算(见 upsertAgentEntries),后者我们本来就要推翻重写(ensureWorkspaceGuides
 * 覆盖 TOOLS.md、dropIdentityRitual 删身份仪式文件)。内核铺 bootstrap 文件用的是
 * `flag: "wx"`(仅当缺失才写),所以先把 AGENTS.md 写成人设,之后内核懒初始化 workspace
 * 时不会覆盖它。
 */
function prepareMember(
  ref: TeamMemberRef,
  teamModel: string,
  personaSkillSlug: string,
  known: Set<string>,
): PreparedMember {
  assertValidAgentId(ref.id);
  if (known.has(ref.id)) {
    return ref;
  }

  if (ref.slug) {
    // 引用的独立专家:用它自己的模型与工具白名单,人设取其 persona 包。
    const sub = getExpert(ref.slug)!;
    const entry = buildAgentEntry(
      ref.id,
      resolveAgentModel(sub.manifest.model),
      buildExpertPatch(sub),
    );
    writePersonaAgentsMd(ref.id, sub.manifest.personaSkillSlug);
    ensureWorkspaceGuides(ref.id);
    return { ...ref, entry };
  }

  // 随团队包下发的成员:人设在 members/<id>.md,模型跟随团队负责人(成员没有各自的模型配置)。
  const persona = readInstalledTeamMemberMd(personaSkillSlug, ref.member!.id);
  const entry = buildAgentEntry(ref.id, teamModel, {
    identity: { name: ref.label },
  });
  writeFileSync(
    join(getAgentWorkspaceDir(ref.id), "AGENTS.md"),
    persona,
    "utf-8",
  );
  ensureWorkspaceGuides(ref.id);
  return { ...ref, entry };
}

/** 一个备好待落盘的专家:agents.list 条目,以及配置写完后要补的文件。 */
interface PreparedExpert {
  entries: AgentEntry[];
  /**
   * 配置落盘后再执行。人设与引导文件是纯 fs 操作,放在写入之后,
   * 就不会出现「文件铺好了但配置没写成」这种半截状态。
   */
  finalize: () => void;
}

/**
 * 按专家清单备好该专家的全部 agents.list 条目(纯计算 + 成员目录的 fs 铺设,不写配置):
 *  - 叠合 identity / tools / skills(见 buildExpertPatch)+ persona AGENTS.md;
 *  - 专家团(isTeam):备好各成员的条目,并写入本 agent 的
 *    subagents.allowAgents(委派目标)+ delegationMode;若设了工具白名单,
 *    自动并入 sessions_spawn/sessions_send 以保证委派可用。
 * persona 强度以 AGENTS.md 为主、skills 绑定为辅(两者叠加),对齐 WorkBuddy 的角色注入。
 *
 * 成员有两种来源,都要支持:`members` 是人设随团队包下发的(外部导入的团队全是这种),
 * `memberSlugs` 是引用其它已安装专家的(我们自撰的样板团队)。前者装了团队即成员齐备,
 * 后者会漏掉用户没装的成员——所以优先用前者。
 *
 * **不落盘**是这个函数与 seedAgentAsExpert 分家的理由:补种存量专家时要把 N 个专家的条目
 * 攒成一次写入,否则就是 N 轮网关热加载(每轮实测 15 秒,见 seedInstalledExpertAgents)。
 */
function prepareExpert(
  agentId: string,
  expert: NonNullable<ReturnType<typeof getExpert>>,
  known: Set<string>,
): PreparedExpert {
  const m = expert.manifest;
  const model = resolveAgentModel(m.model);
  const refs = m.isTeam ? teamMemberRefs(expert) : [];
  const isTeam = refs.length > 0;
  const patch = buildExpertPatch(expert, isTeam ? SUBAGENT_TOOLS : []);
  const entries: AgentEntry[] = [];

  if (isTeam) {
    const prepared = refs.map((ref) =>
      prepareMember(ref, model, m.personaSkillSlug, known),
    );
    if (prepared.length > 0) {
      // delegationMode 仅接受 "suggest"|"prefer"(内核 schema);团队 lead 用 prefer 倾向主动委派。
      patch.subagents = {
        allowAgents: prepared.map((p) => p.id),
        delegationMode: "prefer",
      };
      for (const p of prepared) {
        if (p.entry) {
          entries.push(p.entry);
        }
      }
    } else {
      console.warn(
        `[agents] 专家团「${expert.slug}」没有可委派的成员,本次按单体专家播种`,
      );
    }
  }

  entries.push(buildAgentEntry(agentId, model, patch));
  return {
    entries,
    finalize: () => {
      writePersonaAgentsMd(
        agentId,
        m.personaSkillSlug,
        legacyTeamRosterSection(refs),
      );
      // 平台工具规约对普通任务与专家会话一视同仁,故放在专家播种之外统一写入。
      ensureWorkspaceGuides(agentId);
    },
  };
}

/**
 * 把一个专家的条目(连同其团队成员)一次写进 agents.list(无队列,调用方须在 enqueue 内)。
 *
 * 无论多少成员,配置只写一次 —— 而且**专家本体那条也在这一次里**:它不经 `agents.create`
 * 预先建好,整条目连同成员一起提交(见模块头)。成员的 workspace 与引导文件是纯 fs
 * 操作,不花钱;贵的只有那一次配置写入,而它与成员数无关。
 */
async function seedAgentAsExpert(
  agentId: string,
  expert: NonNullable<ReturnType<typeof getExpert>>,
  known: Set<string>,
): Promise<void> {
  const prepared = prepareExpert(agentId, expert, known);
  await upsertAgentEntries(prepared.entries);
  // 配置落盘后才认成员已存在:写失败时下次开会话仍会重试,不会记住一个并不存在的 agent。
  for (const e of prepared.entries) {
    if (e.id) {
      known.add(e.id);
    }
  }
  prepared.finalize();
}

/**
 * 确保某专家的**常驻 agent** 已在内核注册(幂等 + 串行)。
 *
 * **新专家不再走这里**。今天装专家一条配置都不写:人设、专家团名册、成员人设全在人设插件
 * 的数据文件里,会话挂 `main`(见 main/persona-bundle.ts 与 `@shared/team-roster`)。
 * 留着它是为存量任务兜底 —— 那些任务的会话键钉在 `agent:expert-<slug>:acp:<taskId>` 上,
 * 对应的 agent 条目必须还在,否则内核直接报 `Agent "<id>" no longer exists in configuration`。
 * 万一那条被清掉了(用户手工改配置、旧版本残留),这里按专家清单重新播一次种。
 *
 * 代价要知道:它会写 `agents.list`,顶一轮约 15 秒的网关热加载(内核重置模型目录缓存并
 * `await refreshContextWindowCache`,期间不处理别的请求)。所以它只该在兜底时被调到,
 * 不要再拿它做「预热」「补种」那类主动调用。
 *
 * 播种内容:按专家清单写专属 model/tools/identity + persona AGENTS.md,
 * 专家团另写 subagents.allowAgents 委派名单(存量任务的负责人仍按 id 指名道姓 spawn)。
 * 幂等:已存在时不重复播种(避免覆盖用户上下文),但仍去时序化地重申引导文件。
 */
export function ensureAgent(
  agentId: string,
  expertSlug: string,
): Promise<void> {
  assertValidAgentId(agentId);
  return enqueue(async () => {
    const known = await ensureKnownLoaded();
    if (known.has(agentId)) {
      // 已存在:不重复播种(避免覆盖用户上下文),但仍去时序化地重申引导文件——
      // 修复「首次 seed 时技能未落盘 → AGENTS.md 留内核默认模板」及内核重启覆盖的情况。
      reassertExpertPersona(agentId, expertSlug);
      ensureWorkspaceGuides(agentId);
      return;
    }
    const expert = getExpert(expertSlug);
    if (!expert) {
      throw new Error(`未找到已安装专家:${expertSlug}`);
    }
    await seedAgentAsExpert(agentId, expert, known);
  });
}

/**
 * 移除某专家的持久 agent(expert-<slug>)——专家卸载时调用,清理委派目标残留。
 * 容错:agent 可能从未被创建(该专家未作过团队成员),deleteAgent 已吞错。
 */
export function removePersistentExpertAgent(slug: string): Promise<void> {
  return deleteAgent(persistentExpertAgentId(slug));
}

/**
 * 删除 isolated agent 及其 workspace/session(容错:失败不抛,避免阻塞前端移除任务)。
 * 走网关 `agents.delete` 与官方 CLI 同路:`agents delete --force` 自身就是先打这个 RPC,
 * 落盘兜底才是它的第二选择。直接调省掉一次内核冷启动,删除结果也立即对网关内存生效。
 */
export function deleteAgent(agentId: string): Promise<void> {
  assertValidAgentId(agentId);
  return enqueue(async () => {
    try {
      await viaGatewayOrCli(
        `删除 agent ${agentId}`,
        () => gatewayClient.deleteAgent(agentId),
        () => runOpenClaw(["agents", "delete", agentId, "--force"]),
      );
    } catch {
      /* 删除失败容忍:agent 可能本就不存在或被占用,不影响前端移除任务。 */
    } finally {
      knownAgents?.delete(agentId);
    }
  });
}
