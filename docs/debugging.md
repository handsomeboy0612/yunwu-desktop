# 排障速查

> **升级 OpenClaw 内核前，务必先看 [`kernel-patch.md`](./kernel-patch.md)。**
> 深度思考的流式依赖我们自己打的内核补丁，工具入参依赖握手里的 `caps: ["tool-events"]`，
> 两者丢失都不会报错，只会功能悄悄退化。

## 一、线上日志查询：账号对照

排查"某个行为线上到底发生了什么"时，固定用这两个账号取数据。**我们软件和 WorkBuddy 是分开的账号**，别查混：

| 用途                             | user_id    | username         | 备注          |
| -------------------------------- | ---------- | ---------------- | ------------- |
| 我们软件（云雾助手 / yunwu-desktop） | **142394** | `yw_zhoucongjie` |               |
| WorkBuddy（对照组）              | **439044** | `yw_chengjun`    | 显示名 `elina` |

对照组的意义：同一个诉求，先看 WorkBuddy 的报文长什么样，再对比我们的，能很快分清是"上游没给"还是"我们没接住"。

## 二、数据源与查法

走 MCP `api-channel-sql`（只读，仅 SELECT）。先 `list_datasources` 确认可用数据源。

常用三个：

| 数据源         | 类型       | 用途                                            |
| -------------- | ---------- | ----------------------------------------------- |
| `logs`         | mysql      | 最近 3 天消费日志。有 user_id / model_name / is_stream / created_at |
| `detail_logs`  | clickhouse | 详细日志，**含 `request_body` / `response_body`**，按 `log_id` 关联 |
| `logs_archive` | clickhouse | 归档消费日志（超出 3 天查这里）                 |

两步走：先在 `logs` 里定位请求拿到 `id`，再拿这个 `id` 去 `detail_logs` 取报文。

**第一步：定位请求**

```sql
SELECT id, created_at, FROM_UNIXTIME(created_at) AS t,
       model_name, is_stream, use_time, prompt_tokens, completion_tokens, channel_id
FROM logs
WHERE user_id = 142394
ORDER BY created_at DESC
LIMIT 30
```

**第二步：取报文。**`response_body` 可能非常大，先统计特征再决定要不要拉全文，否则很容易把上下文冲爆：

```sql
SELECT log_id,
       length(request_body)  AS req_len,
       length(response_body) AS resp_len,
       countSubstrings(response_body, 'thinking_delta')    AS n_thinking_delta,
       countSubstrings(response_body, 'reasoning_content') AS n_reasoning_content
FROM detail_logs
WHERE log_id = 7639961965
```

要看内容时用 `substring(response_body, 1, 900)` 截一段，别整条 select。

## 三、已验证结论：思考是逐字流式下发的

2026-07-31 查 142394 的请求（log `7639961965` 等）确认：上游返回的是 Anthropic 原生流式事件，思考**逐字**下发，一条请求就有上百片 `thinking_delta`：

```
{"content_block":{"thinking":"","type":"thinking"},"index":0,"type":"content_block_start"}
{"delta":{"thinking":"用","type":"thinking_delta"},"index":0,"type":"content_block_delta"}
{"delta":{"thinking":"户","type":"thinking_delta"},"index":0,"type":"content_block_delta"}
```

注意是 Anthropic 原生字段：`reasoning_content` / `"reasoning"` 计数均为 0。

所以**"深度思考一次性全量刷出来"不是上游的问题**。

### 真正的原因：内核在网关路径下根本不广播思考流（已实测定案）

内核 `selection-CVIPXpKT.js` 里三档互斥：

```js
const reasoningMode = params.reasoningLevel ?? "off";
includeReasoning: reasoningMode === "on"     && canShowReasoning,
streamReasoning:  reasoningMode === "stream" && canShowReasoning
                  && typeof params.onReasoningStream === "function",
```

`stream` 档除了配置，**还要求运行入口传了 `onReasoningStream` 回调**。实测：把会话 patch 成
`reasoningLevel=stream`（`sessions.json` 已确认写入生效）后，全程抓帧仍是 **0 个 thinking 帧**。

原因在于内核有**两条**运行管线，它们各自决定这个回调：

| 管线 | 入口 | `onReasoningStream` 来源 |
| --- | --- | --- |
| 渠道自动回复 | `reply-usage-state-*.js` | 按 `session.typingMode === "thinking"` **自动装上** |
| embedded agent | `gateway-chat-*.js` → `embedded-agent-*.js` | 原样透传调用方 `params`，**全链路无人提供** |

**我们走的是下面那条。** 全文搜索 `gateway-chat-*.js` 没有任何一处出现 `onReasoningStream`，
`embedded-agent-*.js:3108` 只是 `onReasoningStream: params.onReasoningStream` 的透传，
所以 `streamReasoning` 恒为 false。

**上游至今没修。** issue [#48995](https://github.com/openclaw/openclaw/issues/48995) 长期未决，
PR [#47613](https://github.com/openclaw/openclaw/pull/47613)、
[#54821](https://github.com/openclaw/openclaw/pull/54821)、#79687、
[#87481](https://github.com/openclaw/openclaw/pull/87481) 多次尝试均未合入。
已拉取最新稳定版 `2026.7.1-2` 核实：`streamReasoning` 的回调闸门**仍在**，
`thinking-events` 能力位**不存在**（`GATEWAY_CLIENT_CAPS` 只有 `tool-events`）。

> **结论：只能本地打补丁。** `scripts/patch-kernel-reasoning.mjs` 去掉那个闸门
> （改动与 PR #47613 等价，共 3 行），dev（全局安装）与打包副本两处都打，幂等可重复执行，
> 匹配不到就非零退出报错。补丁生效后 `reasoningLevel` 才可用 `stream`（见 `ipc.ts`）。
> **若内核升级导致补丁失效，必须同步把 `reasoningLevel` 改回 `on`**，否则两档都为 false、
> 思考彻底拿不到。

**已走过的弯路，别重复**：曾据上表第一行去配 `session.typingMode = "thinking"`，
指望内核自动装上回调。那条规则只作用于渠道自动回复管线，对 embedded 管线无效，
实测配置生效后仍是 0 帧。该配置已回滚。

另一个教训：搜到的 PR 描述读起来都像"已经支持了"，但那是**提案**不是主干。
判断某能力在不在，以拉包 grep 实际产物为准。

### 收不到 `stream:"tool"` 子流：因为握手没声明 caps（已修）

同一次抓帧（39 帧）里 `stream=` 只出现三种：`assistant`(正文，`dataKeys=text,delta`，带 sessionKey)、
`item`、`lifecycle`。**没有 `tool`，也没有 `thinking`。**

`tool` 缺席的原因不是内核不发，而是**网关按 cap 决定发给谁**：

```js
const wantsToolEvents = hasGatewayClientCap(client?.connect?.caps, GATEWAY_CLIENT_CAPS.TOOL_EVENTS);
if (connId && wantsToolEvents) context.registerToolEventRecipient(runId, connId);
```

官方 TUI 与 ACP 都在 connect 里带了 `caps: ["tool-events"]`，而我们一直是 `caps: []`，
于是工具入参永远收不到。已在 `gateway-client.ts` 的 connect 载荷补上。

> **通用做法**：新增任何一类事件前，先确认它是否 cap 门控——看内核里有没有
> `hasGatewayClientCap(...)` 判断，再对照我们 connect 载荷里的 `caps`。

这意味着工具入参不会以结构化 JSON 实时下发，`item` 帧里只有一个拍平的 `meta` 字符串，例如：

```
"name":"update_plan","meta":"explanation 启动美妆护肤账号冷启动运营方案制定, step 绘制整体运营路径图"
```

所以任何"从入参解析"的实时渲染（待办清单、diff 预览）都拿不到数据。

**解法：回读会话 jsonl 补齐。** 内核会把每次工具调用逐条 append 到
`~/.openclaw/agents/<id>/sessions/<sessionId>.jsonl`，那里有完整结构。
`session-history.ts` 的 `readLatestPlanArgs()` 从后往前扫该文件取最近一次 `update_plan`，
在 `index.ts` 的 `forwardAgentEvent` 里把结果塞回 `evt.input`，渲染层无需改动即可解析。

注意 jsonl 里的字段名是 **`toolCall` / `arguments`**，不是 Anthropic 原生的 `tool_use`，
也不是 OpenAI 的 `tool_calls`（本模型 `modelApi: "openai-completions"`，很容易搜错）：

```json
{"type":"message","message":{"role":"assistant","content":[
  {"type":"thinking","thinking":"…"},
  {"type":"toolCall","id":"toolu_…","name":"update_plan",
   "arguments":{"explanation":"…","plan":[{"status":"completed","step":"账号定位…"}]}}]}}
{"type":"message","message":{"role":"toolResult","toolName":"update_plan",
  "details":{"status":"updated","plan":[{"step":"账号定位…","status":"completed"}]}}}
```

优先取 `toolResult.details`（内核执行后的权威结果，含每步状态），
回退 `toolCall.arguments`（结果尚未落盘时用）。

**通用教训**：`stream:"tool"` / `stream:"thinking"` 这类 runId 关联的子流**不带 sessionKey**，处理时
不能放在 sessionKey 守卫之后，否则会被静默丢弃。新增子流处理前先抓帧确认它带不带 sessionKey
（看 `payloadKeys=`）。

## 四、客户端帧抓取

怀疑"某个事件到底有没有下发、以什么结构下发"时，用环境变量起 app，会打印 `chat` / `agent` 原始帧
（含 `stream`、`payloadKeys`、`dataKeys` 与截断的原始 JSON）：

```powershell
$env:YUNWU_DEBUG_FRAMES=1; npm run dev
```

判读要点：先看 `stream=` 是什么子流，再看 `payloadKeys` 里**有没有 sessionKey**——没有的话就说明它是
runId 关联的子流，处理位置必须在守卫之前。
