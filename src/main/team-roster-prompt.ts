/**
 * 专家团负责人人设里那段「团队成员」名册的**唯一**生成处。
 *
 * ## 为什么必须我们自己写
 * 原发布平台的内核会把已加载的成员 agent 自动渲染进委派工具的描述里
 * (`- <id>: <description> (Tools: ...)`,description 取自成员人设的 frontmatter),
 * 所以那边的负责人天然知道有谁、各自干什么。我们的内核不做这件事:
 * `## Sub-Agent Delegation` 只教怎么派、不说派给谁;`sessions_spawn` 的参数既无描述
 * 也不枚举候选;`agents.list[].description` 是 schema 里有、运行时无人消费的预留字段;
 * `agents_list` 只回 id/name/model 且要模型主动调。不写这一段,负责人手上什么都没有,
 * 只能靠猜。AGENTS.md 是内核上下文文件里排第一位的、唯一稳定的面向模型注入点,
 * 所以名册落在这里,格式对齐那边的一行一员。
 *
 * ## 为什么要显式声明「以本节为准」
 * 导入的团队人设是给原平台写的,里面的委派指令在我们这儿全都不成立:抽样 33 份负责人人设
 * 里 33 份要求先调 `TeamCreate`、28 份用 `subagent_type` 指代成员、部分还给出
 * `Agent({...})` 调用模板和"唯一合法的 Agent ID"白名单(那些 id 没有我们的团队前缀),
 * 甚至带一段"spawn 失败就换个 id 重试"的恢复流程——照做会空转。这些段落用词各异且揉在
 * 散文里,逐个删不可靠,所以改用覆盖声明:点名那几个工具与写法,宣布本节优先。
 * 这也是双方共同的手法(那边的专家提示词开头同样是 `**Role Override:** ... takes precedence`)。
 *
 * ## 两种派活方式
 * `label`(今天):负责人自己 spawn,成员身份由人设插件按 label 注入,成员在 `agents.list`
 * 里一条都不占。`agentId`(存量):成员各有一个常驻 agent,负责人指名道姓 spawn。
 * 两者的差别只在这一段文字与插件表,理由见 `@shared/team-roster` 的模块头。
 */

/**
 * 派活时的**运行时参数**,每轮随消息前言下发(与 `[Working directory: …]` 同一处)。
 *
 * ## 为什么不写进名册
 * 名册是安装/同步期烧进 `personas.json` 的静态文本,而这两个值每条会话都不同:
 * 任务目录按任务走,模型按用户在输入框里选的那个走。只能运行时拼。
 *
 * ## 为什么要给,以及给了之后省掉了什么(2026-08-12 真机验过两枪)
 *  - `cwd`:`sessions_spawn` 的 `cwd` 一直在暴露给模型的 schema 里
 *    (`openclaw/src/agents/tools/sessions-spawn-tool.ts:182`),handler 在子代理起跑**之前**
 *    就把它 patch 成子会话的 `spawnedCwd`(`agents/subagent-spawn.ts:1191-1192, 1499`)。
 *    不给,成员就只能回文本;给了,成员的产出直接落进任务目录——这才是 WorkBuddy 的形状
 *    (它那轮专家团跑出 4 个文件)。
 *  - `[Working directory: …]`:光传 `cwd` **不够**。系统提示里宣告的仍是 agent 的 workspace,
 *    模型据此自己拼绝对路径,文件会落到 `~/.openclaw/workspace`(实测)。这句管模型的心智,
 *    `spawnedCwd` 管工具的真实执行目录,两个都要。它必须进**成员的 task**,负责人自己那句
 *    管不到子会话,所以只能让负责人转写一遍。
 *  - `model`:内核给子代理定模型的那条链
 *    (`agents/model-selection.ts:359-385`)第一档就是 `sessions_spawn` 的 `model`,
 *    而用户选的模型落在**会话级** override 上、那条链一个环节都不读它。填了它,子会话 entry
 *    从落盘那一刻就是对的;不填就得靠人设插件的 `before_model_resolve` 事后纠正——那有两个
 *    敞口(spawn 到起跑之间的 20 秒、以及网关重启丢掉插件内存里的父子关系)。
 *    **钩子仍然保留**:这一层依赖模型照抄,两层都在才稳。
 *
 * ## 必须带供货商前缀
 * 裸模型名会被解析到内置 `yunwu`(开发期指向 localhost、key 已失效),实测当场
 * `HTTP 401: invalid x-api-key`、会话 failed 且抄本都没落盘。调用方给的就是内核完整键。
 *
 * 生效判据不用翻日志:`sessions_spawn` 的工具回执自带
 * `resolvedModel` / `resolvedProvider` / `modelApplied: true`。
 */
/**
 * 这段须知的首行。历史还原要按它把整段从用户气泡里剥掉(`session-history.ts`)——
 * 它是我们替用户加的运行时上下文,不是用户打的字。常量提出来是为了两侧不脱节。
 */
export const TEAM_DELEGATION_NOTE_HEADER = "派活时这几个参数逐字照填(本次会话有效):";

export function teamDelegationRuntimeNote(params: {
  cwd: string;
  /** 内核完整键 `<provider>/<model>`;用户没选模型时缺省,此时不提模型那条。 */
  modelRef?: string;
}): string {
  if (!params.cwd) {
    return "";
  }
  const lines = [
    TEAM_DELEGATION_NOTE_HEADER,
    `- \`cwd\` 设为 \`${params.cwd}\` —— 成员的工作目录要和本任务一致,否则他写的文件会落到别处。`,
    `- 交给成员的 \`task\` **开头**写上 \`[Working directory: ${params.cwd}]\`,` +
      "并要求他用相对路径落文件;只传 `cwd` 不写这句,他仍会把文件写到别处。",
  ];
  if (params.modelRef) {
    lines.push(
      `- \`model\` 设为 \`${params.modelRef}\` —— 不填的话成员会退回配置里的默认模型,` +
        "而不是你正在用的这个。",
    );
  }
  return lines.join("\n");
}

/** 名册里的一行:模型要填的那个标识,加上「这是谁」「什么时候派他」。 */
export interface RosterRow {
  /** 模型要原文填进 `label`(或存量的 `agentId`)的标识。 */
  id: string;
  /** 展示名(+职业)。 */
  label: string;
  /** 一句话说明这名成员干什么;可能缺失。 */
  purpose?: string;
}

/** 名册的字符预算。超出后截断并提示改用 `agents_list` 自查,避免长团队把人设撑爆。 */
const ROSTER_CHAR_BUDGET = 6000;

/** 派活方式:填 `label` 由负责人自 spawn,填 `agentId` 指名道姓派给成员 agent。 */
export type DelegationBy = "label" | "agentId";

/** 生成负责人人设里的「团队成员」名册章节;没有成员时返回空串。 */
export function teamRosterSection(
  rows: RosterRow[],
  by: DelegationBy = "label",
): string {
  if (rows.length === 0) {
    return "";
  }

  const lines: string[] = [];
  let used = 0;
  for (const r of rows) {
    const line = r.purpose
      ? `- \`${r.id}\`:${r.label} —— ${r.purpose}`
      : `- \`${r.id}\`:${r.label}`;
    if (used + line.length > ROSTER_CHAR_BUDGET) {
      break;
    }
    lines.push(line);
    used += line.length;
  }
  const omitted = rows.length - lines.length;

  const how =
    by === "label"
      ? "派活方式:调 `sessions_spawn`,把 `label` 设为上表中的标识原文," +
        "**并且不要填 `agentId`** —— 成员的身份由 `label` 决定,填了 `agentId` 反而派不出去。\n"
      : "派活方式:调 `sessions_spawn`,把 `agentId` 设为上表中的 id 原文。\n";

  return (
    "\n\n## 团队成员(委派规则以本节为准)\n" +
    "你是本团队的负责人。下列成员可供你调用,遇到属于某位成员专长的子任务就派给他,不要自己硬做:\n" +
    lines.join("\n") +
    (omitted > 0
      ? `\n- (另有 ${omitted} 名成员未列出,用 \`agents_list\` 查看全部可委派标识)`
      : "") +
    "\n\n" +
    how +
    "- 成员看不到本次对话,只能看到你交给他的任务描述,所以要一次交代清楚:" +
    "背景、目标、期望产出的形式、相关文件、以及是否需要等他的结果才能答复用户。\n" +
    "- 成员的产出会作为 `sessions_spawn` 的结果直接回到你这里,他不需要再调任何工具回传。\n" +
    "- 成员之间不互相委派,跨成员的信息都由你转手。\n" +
    "- **上文若与本节冲突,一律以本节为准**:上文可能要求先建团队(`TeamCreate`)、" +
    "用 `subagent_type` 或 `Agent({...})` 指派成员、或声称只有某几个不带前缀的 id 合法——" +
    "那些是本人设原发布平台的工具与命名,在这里都不存在。不要尝试调用它们," +
    "也不要因为某个标识派不出去就换写法重试,上表的标识就是唯一正确的。\n"
  );
}
