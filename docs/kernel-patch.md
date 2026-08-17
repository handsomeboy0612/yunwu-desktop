# 内核补丁与网关能力位（务必先读这页再升级 OpenClaw）

> 2026-07-31 记录，2026-08-14 按隔离试跑的真机结果修订。
> 这里放的是**会被内核升级悄悄冲掉**的改动。升级 OpenClaw 前后请照着「升级检查清单」走一遍。
>
> **真要升级，先读七之二的「硬阻塞」那段**：新内核会直接拒绝我们现在的配置，
> 而且其中有一处不报错却会静默变义。那一段还钉了升级顺序——有一步过去就回不来。

## 一、一句话

在 **2026.6.11（我们在跑的这版）** 上，深度思考的实时流式靠的是**我们自己打的内核补丁**；
工具入参的实时下发靠的是握手里声明 **`caps: ["tool-events"]`**。
两者都不是默认行为，丢了都不会报错，只会「功能悄悄退化」。

> 补丁这条**只对 2026.6.11 成立**。上游在 2026.7.2 里已经把思考流改成无条件广播，
> 升到那个版本之后补丁要删掉而不是重打，详见七之二必做项第 2 条。

## 二、改了哪两处

| # | 改动 | 位置 | 丢失后的症状 |
| --- | --- | --- | --- |
| 1 | 内核补丁：解除思考流的回调闸门 | `scripts/patch-kernel-reasoning.mjs` | 深度思考**彻底消失**（不是退回非流式，是完全没有）※ |
| 2 | 握手声明 `caps: ['tool-events']` | `src/main/gateway-client.ts` connect 载荷 | 收不到 `stream:"tool"`，任务清单/diff 预览等拿不到工具入参 |

※ 已加运行时自检兜底，见第五节，实际会降级成「退回非流式」而不是全损。

---

## 三、内核补丁（第 1 处）

### 为什么需要

内核只有在 `streamReasoning` 为真时才 `emitAgentEvent({ stream: "thinking" })`，
而这个标志被额外卡在一个回调上：

```js
streamReasoning: reasoningMode === "stream" && canShowReasoning
                 && typeof params.onReasoningStream === "function",
```

这个回调由**运行入口**提供。Telegram / Mattermost 等渠道集成会传；
而所有走 `chat.send` 的表面（webchat、Control UI、纯 WS 客户端、ACP——**包括我们**）都不传，
于是恒为 false，思考永远只能在轮末随最终消息整块到达。

**在稳定通道上至今未修**，已核实到 `2026.7.1-2`（npm `latest`）闸门仍在、
`thinking-events` 能力位也不存在。下面这些 issue / PR 是围绕「加一个能力位」这条路的，都没合入；
上游最终换了另一条路解决（`2026.7.2-beta` 起把广播改成无条件，#92738），所以**别再等这几条**：

- issue [#48995](https://github.com/openclaw/openclaw/issues/48995)（长期未决）
- PR [#47613](https://github.com/openclaw/openclaw/pull/47613)、[#54821](https://github.com/openclaw/openclaw/pull/54821)、#79687、[#87481](https://github.com/openclaw/openclaw/pull/87481)（均未合入）

> **教训**：这些 PR 的描述读起来都像「已经支持了」，但那是**提案**不是主干。
> 判断某能力在不在，一律以拉包 grep 实际产物为准，别信 PR 描述。

### 改了什么

共 3 行，全在同一个 bundle 文件里（文件名带内容哈希，每次发版都变，脚本按内容特征定位）：

```js
// 1. 去掉回调条件
- streamReasoning: reasoningMode === "stream" && canShowReasoning && typeof params.onReasoningStream === "function",
+ streamReasoning: reasoningMode === "stream" && canShowReasoning,

// 2. 去掉提前返回
- if (!state.streamReasoning || !params.onReasoningStream) return;
+ if (!state.streamReasoning) return;

// 3. 回调改为可选调用
- params.onReasoningStream({ text: trimmed });
+ params.onReasoningStream?.({ text: trimmed });
```

等价于上游 PR #47613。

### 打到哪、什么时候打

脚本会同时处理**两个**内核目录（缺一不可）：

| 目标 | 用途 | 何时被打 |
| --- | --- | --- |
| 全局安装（`npm root -g`/openclaw） | **dev 跑的是这个**（dev 态 `process.resourcesPath` 指向 Electron 自己的目录，找不到内置内核，回退 PATH） | `predev` 钩子，每次 `npm run dev` |
| `resources/openclaw`（打包副本） | 发布态用这个 | `pack` / `pack:win` 链，在 `prepare-kernel` **之后** |

顺序很重要：`prepare-kernel` 会用全局内核**整个覆盖重写** `resources/openclaw`，
所以补丁必须排在它后面，否则会被冲掉。

```jsonc
"predev":   "node scripts/patch-kernel-reasoning.mjs",
"pack":     "npm run build && npm run prepare-kernel && npm run patch:kernel && electron-builder",
"pack:win": "npm run build && npm run prepare-kernel && npm run patch:kernel && electron-builder --win"
```

脚本特性：**幂等**（已打过就跳过，可反复执行）、**匹配不到即非零退出并报错**（不会静默失效）。

---

## 四、三个开关是一套，别单独改

| 开关 | 位置 | 作用 |
| --- | --- | --- |
| 内核补丁 | `scripts/patch-kernel-reasoning.mjs` | 让内核肯广播 `stream:"thinking"` |
| `reasoningLevel` | `src/main/ipc.ts` 的 `chat.send` 前 patchSession | `stream` = 逐段广播；`on` = 随最终消息整块下发 |
| `thinkingLevel` | 同上，来自 UI 的思考档位 | `off` 时 `canShowReasoning` 为 false，前两者都无效 |

`reasoningLevel` 的两档是**互斥**的：

```
includeReasoning = (reasoningMode === "on")     && canShowReasoning
streamReasoning  = (reasoningMode === "stream") && canShowReasoning   // 补丁后
```

所以**补丁不在却用 `stream`，会导致两者双双为 false，思考彻底拿不到**——比不修还糟。

### 已走过的弯路，别重复

曾以为内核会按 `session.typingMode === "thinking"` 自动装上那个回调
（`reply-usage-state-*.js` 里确有这条规则）。但那条规则属于**渠道自动回复管线**，
我们走的是 **embedded agent 管线**（`gateway-chat-*.js` → `embedded-agent-*.js`），
后者只是原样透传 `params.onReasoningStream`，全链路无人提供。
实测配置生效后仍是 0 帧，该配置已回滚。**别再试。**

---

## 五、运行时自检（兜底）

`src/main/openclaw-cli.ts` 的 `isReasoningStreamPatched()`：启动时扫一次内核 bundle，
闸门还在就自动把 `reasoningLevel` 退回 `on` 并打印告警，
把「思考静默全损」降级成「退回非流式」。结果缓存，不重复读盘。

走 PATH 的开发态直接视为已打补丁（有 `predev` 兜底），避免在启动路径上跑 `npm root -g` 拖慢。

---

## 六、网关能力位（第 2 处）

网关**按 cap 决定发不发某类事件**，不声明就收不到：

```js
const wantsToolEvents = hasGatewayClientCap(client?.connect?.caps, GATEWAY_CLIENT_CAPS.TOOL_EVENTS);
if (connId && wantsToolEvents) context.registerToolEventRecipient(runId, connId);
```

官方 TUI 与 ACP 都带了 `caps: ["tool-events"]`，我们此前一直是 `caps: []`，
于是全程只有 `assistant` / `item` / `lifecycle` 三种帧，`item` 帧里的工具入参
只剩一个被截断的 `meta` 字符串，任何「从入参解析」的实时渲染都拿不到数据。

> **通用做法**：新增任何一类事件前，先在内核里搜 `hasGatewayClientCap(...)`
> 确认它是否 cap 门控，再对照我们 connect 载荷里的 `caps`。
> 当前内核 `GATEWAY_CLIENT_CAPS` 只有 `tool-events` 一项。

---

## 七、升级 OpenClaw 内核时的检查清单

0. **先拿新内核校验一遍现有配置**，这一步能在动任何代码之前挡掉大部分返工：
   照七之二「硬阻塞」那段跑 `--profile <名字> config validate`，把每个
   `Unrecognized key` 逐个查到新路径再动手。**光看 validate 的输出不够**——键名不变
   而语义变了的那种（我们踩到的是 `agents.defaults.models`）它不会报，
   要再对一遍 `doctor --fix` 打印的 legacy key 警告。
1. **先查上游是不是已经原生支持了，再碰补丁脚本。** 这一步必须排在第 2 步前面：
   去目标版本的 `src/agents/embedded-agent-subscribe.ts` 读 `emitReasoningStream` 的函数体，
   看 `emitAgentEvent({ ... stream: "thinking" ... })` **之前还有没有** `state.streamReasoning`
   或 `params.onReasoningStream` 守卫。没有守卫就是已原生支持，**删掉补丁**改走官方路径，
   别两套并存（2026.7.2 起就是这种情况，见七之二必做项第 2 条）。

   > **不要拿 `npm run patch:kernel` 的输出当这一步的判据。** 它在 2026.7.2 上会打印
   > `✓ 已打补丁`、退出码 0，但那是假绿灯：三处特征只剩第 1 处能匹配，另两处搜不到会被
   > 当成「已是补丁态」，最后的 `gateGone` 自检因此也通过。脚本注释里承诺的
   > 「匹配不到即非零退出」只覆盖旧写法，覆盖不到「上游已修」这个方向。
2. 确认第 1 步是「上游还没修」之后，再跑 `npm run patch:kernel`：
   - 输出 `✓ 已打补丁` 或 `= 已是补丁态` → 正常；
   - 输出 `✗ … 未找到` / `✗ … 仍检测到回调闸门` → **内核写法变了**，
     去看 `selection-*.js` 里的 `streamReasoning` / `emitReasoningStream`，
     更新脚本里的 `EDITS` 正则。
3. 核对 `GATEWAY_CLIENT_CAPS` 是否新增了能力位，考虑在 connect 载荷里补声明。
4. 按下一节抓帧复验。

---

## 七之二、2026.7.2 的升级预评估（2026-08-12 静态评估，2026-08-14 隔离试跑修订；仍未升）

**结论先说：现在不能直接升。** 拦路的不是改动面大小，是下面「硬阻塞」那段——
新内核直接拒绝我们现在的配置，得先改 `config-writer.ts` 五处再谈换内核。

对照 ref：`release-publish/10a390ed7fa8-20260802`（`package.json` 写 `2026.7.2`）与
`v2026.7.2-beta.7`（npm 上装得到的同版本 beta，08-14 试跑用的就是它）。
我们在跑的是 `2026.6.11`。改动面 **10504 文件 / 172 万行插入**（`src` 全量，含测试；
`git diff --stat v2026.6.11 v2026.7.2-beta.7 -- src`），所以下面按「我们踩着的地基」逐条查，
不是读 diff。

> 试跑怎么做到零风险的，两个旋钮记下来：内核解析优先级里 **`OPENCLAW_BIN` 排在 PATH 之前**
> （`src/main/openclaw-cli.ts:184-209`），所以能把 dev 指到隔离目录而不动全局安装；
> 内核自己的 **`--profile <名字>`** 会把 `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH`
> 隔离到 `~/.openclaw-<名字>`，所以校验和 `doctor --fix` 都能跑在配置副本上。
> 注意**我们主进程到处硬编码 `homedir()/.openclaw`**，所以 `--profile` 只能隔离内核侧；
> 要连我们的应用一起隔离，那些硬编码得先收口。

**收益**（都是我们正在受的痛）：

| 收益 | 出处 |
| --- | --- |
| 专家团成员产出不再重复投递 | `sessions_spawn` 新增 swarm `collect: true`，会**强制** `expectsCompletionMessage = false`（即根本不播报），负责人改用 `agents_wait` 自己收；配套 `outputSchema` / `groupId`，由 `tools.swarm.enabled` 开关控制。旧版无解，见 `src/main/team-relay.ts` 注释。**但这条不是升级白拿的**，见下方注 |
| 控制面限流 3 次/60 秒共桶 → **30 次/60 秒且每方法一桶** | CHANGELOG *Gateway control-plane rate limiting: use per-method buckets with a 30-per-minute budget* |
| 会话可 pin / archive（不丢抄本）/ restore / rename | CHANGELOG #98510。**可能替代我们那个 `pruneAfter: "3650d"` 的绕法**，值得连带重估 |
| `chat.history` 省略旧消息时会给 `payload.large` / `truncated` 诊断 | CHANGELOG，我们回读成员产出正走这个 RPC |

> **注：swarm 那条收益不是升上去就有的，别把它算进升级预算**（2026-08-14 核实）。
> `resolveSwarmConfig` 的默认值是 `enabled: false`（`agents/swarm-config.ts` 的
> `DEFAULT_SWARM_CONFIG`），要显式开 `tools.swarm.enabled`；而 `collect: true` 的语义是
> 「强制不播报、负责人改用 `agents_wait` 自己收」，也就是我们那 225 行的
> `src/main/team-relay.ts` 要拆掉重写、派活提示词也要跟着改。
> 另有一条准入限制：`collect` 只支持 `runtime="subagent"`，传 `acp` 会抛
> `ToolInputError`（`agents/tools/sessions-spawn-tool.ts:393` 附近）——我们的成员默认就是
> `subagent`（派活提示词没教 `runtime`），所以这条不挡我们，但改造前要确认没人加过。
>
> **升级本身白拿的只有一条**：删掉思考流补丁（见必做项第 2 条）。限流那条我们已用
> `config.set` 绕开，升级只是顺带。

**两条环境事实**（2026-08-14 实测）：

- **想要 swarm 和 Emit-always 就必须跟 beta 通道**。npm 上 `openclaw@latest` 是 `2026.7.1-2`，
  这两样都要 `2026.7.2-beta.*` 起。判法是 `npm view openclaw version` 与
  `npm view openclaw versions --json` 对一眼，别只看 `latest`。
- **开发机的 Node 要 ≥24.15**（新内核 preinstall 会硬拦，本机 24.12 被拒）。
  但这只卡 npm 安装，**不卡运行**——内核实际跑在 Electron 43 内置的 Node 24.17 上
  （`ELECTRON_RUN_AS_NODE=1`）。急着试可以 `npm install --ignore-scripts` 绕过安装检查。

**硬阻塞：新内核直接拒绝我们现在的配置**（2026-08-14 实测，`config validate` 退出码 1）。
这条与下面的「必做项」性质不同——那些是不做会退化，这条是不做**根本起不来**。

复现方法（零风险，跑在配置副本上，内核自带 `--profile` 会把状态目录隔离到 `~/.openclaw-<name>`）：

```powershell
$prof = "$env:USERPROFILE\.openclaw-betatrial"
New-Item -ItemType Directory -Force -Path $prof | Out-Null
Copy-Item "$env:USERPROFILE\.openclaw\openclaw.json" "$prof\openclaw.json"
$env:ELECTRON_RUN_AS_NODE=1
& .\node_modules\electron\dist\electron.exe <新内核>\openclaw.mjs --profile betatrial config validate
```

报出 7 处 `Unrecognized key`。**我们代码要改的五处**，目标路径都是从内核的运行时读取端
或迁移测试的断言反推的，不是猜的：

| 现在写的键 | 改成 | 改哪里 | 内核出处 |
| --- | --- | --- | --- |
| `agents.defaults.imageGenerationModel.{primary,timeoutMs,fallbacks}` | `agents.defaults.mediaModels.image` | `config-writer.ts:197,198,202` | `agents/tools/media-tool-shared.ts:105,146-172`（`applyAgentDefaultModelConfig` 写 `mediaModels[key]`）；旧键在 `config/types.agent-defaults.ts:109` 标 `@deprecated Doctor-only legacy input` |
| `agents.defaults.videoGenerationModel.{primary,timeoutMs,fallbacks}` | `agents.defaults.mediaModels.video` | `config-writer.ts:240,241,242` | 同上 `:115`、`types.agent-defaults.ts:111` |
| `messages.tts.provider`、`messages.tts.providers.openai` | 顶层 `tts.*`（provider 挂 `tts.providers.*`） | `config-writer.ts:287,289` | `doctor/shared/legacy-config-migrate.provider-shapes.test.ts:170` 断言 *Moved messages.tts to top-level tts.*；合法子键见 `config/schema.labels.ts:861-868` |
| `tools.experimental.planTool` | `tools.updatePlan` | `config-writer.ts:508`（`builtinToolPolicyEntries()`） | `doctor/shared/legacy-config-migrations.runtime.retired.test.ts:590` 断言 *Moved tools.experimental.planTool → tools.updatePlan.* |
| `agents.defaults.models`（我们当白名单用） | `agents.defaults.modelPolicy.allow` | `config-writer.ts:931`、构造 `buildAllowlistValue():367`、消费 `:857` | `config/types.agent-defaults.ts:152,154`；doctor 原话 *no longer restricts model overrides* |

**最后那一行是七处里唯一危险的一处，因为它不报错。** 键名和 `Record` 类型都没变，
所以 `config validate` **不会**报它——它只是语义变了：新版 `agents.defaults.models` 是
「每个模型的条目配置」，不再是允许清单。升级后我们那份白名单会静默失效，
表现是用户能选到我们没上架的模型。其余六处都会被 validate 拦在启动前，反而安全。

**还要删一处**：`gateway.controlUi.dangerouslyDisableDeviceAuth`（`config-writer.ts:422,435`）已
retired，doctor 说它会自行保留 pairing-only 访问做补救，我们不写即可。

**一处不用改**：`meta.lastTouchedAt` 是**内核自己写的**，我们代码里那三处命中
（`agent-manager.ts:342`、`config-writer.ts:760`、`gateway-client.ts:378`）全是注释。
doctor 迁移时会清掉，`meta.lastTouchedVersion` 在新版仍合法
（`config/config.meta-timestamp-coercion.test.ts:15-21`）。

**剩下四处我们没写**，是历史存量，`doctor --fix` 能自己处理：
`agents.defaults.memorySearch` → `memory.search`、
`agents.defaults.compaction.reserveTokensFloor` → retired、
`session.idleMinutes` → `session.reset.idleMinutes`、
`skills.workshop.autonomous.enabled`。

### `agents.list` → `agents.entries` 是单向门，决定了升级顺序

读取方向两个都认（`config/agent-roster-provenance.ts` 先取 `entries`、没有再回落 `list`），
所以**光升内核不会立刻坏**。但 `doctor --fix` 会**迁写并落盘**：

```
- agents.entries: Moved agents.list to keyed agents.entries.
Doctor changes: Persisted agents.entries with exactly one explicit default agent.
```

一旦落盘成 `entries`，6.11 就读不回来了，回滚不再是重装旧内核那么简单。**所以顺序只能是：**

1. 先改上表那五处 + 删 `dangerouslyDisableDeviceAuth`（此时仍跑在 6.11 上，可随时停下）
2. 备份 `~/.openclaw/openclaw.json`
3. `doctor --fix` 迁配置（**过了这一步就回不去旧内核**）
4. **换内核与删思考流补丁在同一步做**，别分先后：补丁是打在内核 dist 上的，
   先换后删会被 `predev` / `pack` 抢先在新内核上改掉第 1 处（假绿灯，见必做项第 2 条），
   先删后换则 6.11 会暂时退回非流式思考。同步摘掉 `predev` / `pack` 的钩子、
   `isReasoningStreamPatched()` 自检与 `ipc.ts` 里 `stream` / `on` 的二选一
5. 按第八节抓帧复验，重点是 `thinking` 帧数与 `sessions.changed` 增量（见必做项第 1 条末尾）
6. swarm 作为独立一期做，别和升级混在一起

**必做项**（不做就是功能悄悄退化，与本页第一节同一类风险）：

1. ~~**会话库从 JSON 迁到 SQLite。**~~ **2026-08-12 已做完，先于升级落地**（6.11 / 7.2 通用）。
   背景：`src/config/sessions/store.ts` 与 `store-load.ts` 在 7.2 里**已不存在**，
   `src/config/sessions` 提到 sqlite 的文件 3 → 106，并出现迁移归档命名
   `sessions.json.migrated.2`（`artifacts.test.ts`）。原先 3 处直接读那份 JSON
   （枚举任务键、定位 jsonl 实录、判断 agent 有没有跑过）现在统一走
   `src/main/session-index.ts`：`sessions.list` 建表 + `sessions.changed` 增量，
   照的是内核自带控制台与 ClawX 的形状（口径与取舍写在该文件头注释里）。
   升级那天只需删掉该文件里 `legacy*` 三个函数（过渡桥，`sessions.json` 不在了就自动落空）。

   **真机复验（同日，dev 态）**：孤儿发现经 CDP 调 `tasks:discoverOrphans` 回 13 条、标题都从
   实录读出来了，与动手前 RPC / 磁盘各取一份的 13 : 13 等价性一致；`task:history` 回 2 条消息
   含 thinking 时间线；`npm run verify:history` 在纯 node 下也能还原（走过渡桥那一支）。
   启动期只打一行「暂时取不到会话清单，先用磁盘上的」（网关还没连上），此后调用不再打 ——
   说明 RPC 那一支确实成功。**唯一没验的是 `sessions.changed` 增量**：payload 带
   `sessionKey` / `sessionId` 是从内核 `server-chat.ts:438` 读出来的，但没跑真会话触发过。
   在 6.11 上它不承重（表里没命中会回落读盘），**7.2 上它开始承重，升级时必须补验**。

   两个坑记下来，别重犯：
   - 判据是「**有没有一份可信的会话真相**」（`ensureSessionTruth`），不是「RPC 成不成功」。
     启动链跑在网关连上**之前**（实测三步全失败），按 RPC 结果做判据会让专家清理与 agent 清理
     在 6.11 上整轮跳过 —— 而那时磁盘上那份 JSON 明明还是权威。
   - 网关客户端在 `session-index.ts` 里必须**懒加载**：它底下挂着 electron 与 ws，
     静态 import 会让 `scripts/verify-history.mjs`（纯 node 跑解析器）连打包都过不去。
2. **思考流补丁要整个删掉，不是重写。上游已经修了。**
   （2026-08-14 隔离试跑真机核对，**推翻了本条 08-12 的结论「上游仍然没修」**）

   `emitReasoningStream` 里那句广播已改为**无条件**执行，`streamReasoning` 只再管下面那个渲染回调：

   ```js
   // Emit-always: the thinking stream always reaches the bus and session
   // archive. /reasoning (streamReasoning) gates only the rendering hook below;
   emitAgentEvent({ runId: params.runId, stream: "thinking", data: { text: trimmed, delta } });
   ```

   出处 `src/agents/embedded-agent-subscribe.ts`（v2026.7.2-beta.7），上游 #92738。
   本页第三节那三处改写里，第 2、3 处的闸门**已经不存在**；第 1 处
   （`streamReasoning:` 后面那个 `typeof params.onReasoningStream === "function"`）还在，
   但它现在只决定渲染回调开不开，与 `stream:"thinking"` 帧收不收**已经无关**。

   **顺带一条必须知道的：这次升级里 `patch:kernel` 会给假绿灯。** 实测在 beta 的 dist 上，
   三处只有第 1 处命中并被改写，另两处因搜不到而被当作「已是补丁态」，改完 `gateGone` 自检
   照样通过，脚本打印 `✓ 已打补丁` 且退出码 0。也就是说第七节第 2 步那条判据在这里**不成立**
   ——它不会拦住你，只会让你以为补丁还需要、还生效。要删的东西是一套：
   `scripts/patch-kernel-reasoning.mjs`、`predev` / `pack` 里的钩子、
   `openclaw-cli.ts` 的 `isReasoningStreamPatched()`、以及 `ipc.ts` 里那套
   `stream` / `on` 二选一（之后 `reasoningLevel` 可以恒为 `stream`）。
   删的时机见上面「单向门」那节第 4 步——与换内核同一步做。
3. **能力位从 1 个变 2 个**：`GATEWAY_CLIENT_CAPS` 现在有 `TOOL_EVENTS` 与 **`EXEC_APPROVALS`**
   （`src/acp/server.ts:152` 两个都声明）。按第七节第 3 步决定要不要在 connect 载荷里补。

**不会被升级解决的**：成员回传那条 `chat.send` 要留着——`acpResolution?.kind === "stale"` 直接抛
那句在 7.2 里仍然只有一处、一字未改，所以 `acp:` 键的 direct announce 照旧撞墙。

**其余契约 grep 过都还在**（各一条命中，可原地复查）：`before_prompt_build` /
`before_model_resolve` / `subagent_spawned` 三个钩子、`CONVERSATION_HOOK_NAMES`（会话类钩子仍要
opt-in）、`disable-model-invocation`、`maxSkillsPromptChars`、`supportsSpawnLineage`、
`config.set` 的 `baseHash`、`session.maintenance.pruneAfter`。

## 八、如何验证

```powershell
$env:YUNWU_DEBUG_FRAMES=1; npm run dev
```

发一条会触发多步骤的任务，然后统计帧类型：

```powershell
$f="<terminals>\<shell-id>.txt"
Get-Content $f | Select-String -Pattern 'stream=([a-z]+)' -AllMatches |
  ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } |
  Group-Object | Sort-Object Count -Descending | Format-Table Count,Name
```

**期望**（2026-07-31 实测通过的基线）：

| stream | 期望 | 说明 |
| --- | --- | --- |
| `thinking` | 数十～数百 | 带 `data.text`（累计）+ `data.delta`（增量）。**为 0 说明补丁失效** |
| `tool` | 有，且 `phase` 含 `start` 与 `result` | **完全没有说明 caps 没生效** |
| `assistant` | 有 | 正文增量 |
| `item` / `lifecycle` | 有 | 一直都有，不能用来判断上面两项 |

`update_plan` 的 `result` 帧里应能看到完整 `details.plan`，且多次调用间 `status` 逐步演进
（`pending` → `in_progress` → `completed`）。

---

## 九、用户端不受影响

发布版内核解析优先级：**bundled（`resources/openclaw`）> `OPENCLAW_BIN` > PATH 全局**。
内置内核永远优先，用户机器上装没装过 openclaw、什么版本，都与此无关；
补丁在打包时就烤进了安装包。

「补丁会掉」只发生在**开发机重装/升级全局 openclaw** 时，`predev` 会自动补回。

## 相关文件

- `scripts/patch-kernel-reasoning.mjs` — 补丁脚本
- `src/main/openclaw-cli.ts` — 内核解析（`OPENCLAW_BIN` 覆盖点）+ `isReasoningStreamPatched()`
- `src/main/ipc.ts` — `reasoningLevel` 决策
- `src/main/gateway-client.ts` — connect 载荷的 `caps`
- `src/main/config-writer.ts` — 升级要改的那五处配置键都在这里（见七之二「硬阻塞」）
- `src/main/team-relay.ts` — swarm `collect` 落地时要拆的那 225 行
- `docs/debugging.md` — 抓帧方法、线上日志账号对照、jsonl 结构
