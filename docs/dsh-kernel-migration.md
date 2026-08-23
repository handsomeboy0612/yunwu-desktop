# 换内核：从 openclaw 到 DeepSeek Harness

> 分支 `feature/dsh-kernel`（三个仓库同名）。基线是 `0a990099`（桌面端）、
> `a1c97c2`（admin-server）、`9ad9795`（admin-cloud），随时可回退对照行为。

## 三个前置问题的答案

**内核是 `deepseek-harness`。** `deepseek-harness-desktop` 是外壳，两者不是一回事、
也不是 fork 关系：desktop 仓库用 git 子模块引内核（`.gitmodules` → `deepseek-ai/deepseek-harness`），
`upstream.json` 把它锁在 commit `47f9438`（源码版本 `0.1.0-rc.5`，运行时包 `0.1.0-rc.6`），
自己只加一个 Cordis 插件 `dsh-plugin-desktop`。

**"用它的外壳还是用 Electron"是个误解——它的外壳就是 Electron**
（`dsh-plugin-desktop/package.json` 的 `electron` 是 `43.4.0`）。真正的选择是
"我们现有那套 Electron 壳"对"它这套"。**结论：用它的，理由见下面「外壳选型」。**

**许可证这道闸门是绿的。** 内核与外壳都是 MIT（`Copyright (c) 2026 DeepSeek` /
`Copyright (c) 2026 Anywhere Labs`），商用、改动、改品牌、闭源分发都允许。义务只有一条：
随分发附版权声明与许可证原文，内核那份 15.8 KB 的 `THIRD_PARTY_NOTICES.md` 也要一起带。

## 家底：我们自己写了多少，以及它们各自的命运

不含随包 vendored 的 openclaw 内核（那是 30,268 个文件 / 275.6 MB，整体删除）。

### 可以整体搬过去（约 2,400 行）

前提是新内核同样接受「OpenAI 兼容 baseUrl + Bearer sk-」这个形状。
**这个前提已经在真机上验过**：`settings.yaml` 里把 `llm-deepseek.baseURL` 指向
`https://api.openlux.ai/v1`，真对话跑通，69 tok/s。

| 模块 | 行数 | 为什么能搬 |
|---|---|---|
| `yunwu-auth.ts` | 245 | 纯 `fetch`，零内核引用（唯一 import 是 `./account-session`） |
| `yunwu-captcha.ts` + `Captcha.tsx` | 157 + 322 | go-captcha 五种模式原生渲染，纯 fetch + Node crypto |
| `account-session.ts` | 87 | 只依赖 `app.getPath('userData')` 与 `secret-box` |
| `yunwu-account.ts` | 254 | 余额四档降级，纯 fetch |
| `yunwu-client.ts` | 50 | 令牌校验 `GET /v1/models` |
| `store.ts` / `secret-box.ts` | 106 / 47 | 纯 fs / Electron safeStorage |
| `model-catalog.ts` | 545 | 只打云雾 `/v1/models` 与 `/api/pricing_new` |
| `model-capabilities.ts` | 884 | 纯函数，输入 `RawModelEntry` 输出 `ModelInfo` |

`model-capabilities.ts` 有个例外要注意：**判据可留，输出的取值域要重新映射**。
它输出的 `ThinkingFormat` 七种方言与 `thinkingLevels` 五档是照 openclaw 的
`compat.thinkingFormat` / `thinkingLevelMap` 设计的，dsh 怎么表达思考档位是阶段 2 的验证点。

### 必须重写

| 模块 | 行数 | 重写什么 |
|---|---|---|
| `config-writer.ts` | 1,331 | 全文，但**重写后会短得多**。写的 12 类键（`models.providers`、`agents.defaults.models`、`agents.defaults.model.primary`、`agents.defaults.{image,video}GenerationModel`、`messages.tts.providers.openai`、`tools.web.search.*`、`tools.deny`、`tools.experimental.planTool`、`plugins.entries.*`、`session.maintenance.*`、`agents.defaults.skipOptionalBootstrapFiles`、`gateway.*`）全是 openclaw schema 专属；dsh 那边是 `settings.yaml` 的 namespace 分段 + `cordis.yml` / `cordis.patch.yml` + `.credentials.yaml`。**其中约 430 行（baseHash 取值、体积骤降保护、渲染队列分槽、自写抑制）是绕路，直接归零** —— 已在真机验过，见阶段 1 |
| `gateway-client.ts` | 1,941 | 15 个网关 RPC（`config.set` / `config.get` / `sessions.*` / `chat.*` / `device.pair.*` / `agents.delete`）+ ed25519 设备鉴权握手。dsh 是同进程 + loopback HTTP/WS，协议不同 |
| `yunwu-video-plugin/index.mjs` | 4,219 | 13 个视频适配器 + 3 条出图路径 + 4 个异步出图适配器 + 搜索 provider + 对话流包装，6 个 openclaw `register*` 扩展点 |
| `persona-plugin/index.mjs` | 667 | 5 个 openclaw 钩子。**大部分应当消失**，见下节 |
| `market/` | 2,271 | 10 个文件。市场接口可留，但制品安装的落点从 `~/.openclaw/skills/<slug>` 变成 dsh 的 preset 目录 |
| 专家 / 专家团 | 1,991 | 7 个文件。**大部分应当消失**，见下节 |
| 技能 | 1,208 | 4 个文件。同上 |

### 应当消失，而不是移植

这是换内核最大的一笔收益。下面每一条都是我们被 openclaw 逼出来的绕路，
dsh 有一等公民的做法（大部分我已在真机上验过）。

| 我们现在有什么 | 行数 | dsh 的一等公民做法 | 验证状态 |
|---|---|---|---|
| `team-relay.ts`：内核 direct/steer 两条投递路对 `acp:` 会话键必然失败，所以自己用 `chat.send` 投 `<teammate-message>` | 268 | `dsh-tool-subagent` 的产出直接作为工具结果回到队长 | **已验**：队长收到并汇总了两名成员的产出 |
| 每个成员约 9 千字符的重复上下文（内核那条播报会迟到落地，v2026.6.11 无解） | — | `reported` 位 + first-wins settlement：任一方 `kill`/`read`/`wait` 认领终态，另一条通告就不发 | **已验**（机制级，不只是"未复现"）：调过 `wait` 后 `reported=true`、投递 0 条 |
| `skill-visibility.ts`：`disable-model-invocation` 藏起全部市场技能 + 按专家注入提示词 | 212 | `ctx.tools.restrict({allow/deny})` 按 scope 收窄，子代理由 `applyChildComposition` 装上 | **已验**：内核 `core/tools/tests/scoped.spec.ts` 27 项全绿，含"过滤祖先 scope 继承来的工具" |
| 成员人设注入要等约 7 秒（`subagent_spawned` 记账 → 子会话 `before_prompt_build` 才触发） | — | `applyChildComposition` 在子代理创建窗口里**同步**装 `deployment:persona` section | **已验**（`subagent/src/child-agent.ts:163-174`） |
| 媒体投递那一整套：`after_tool_call` 记账落盘 + `fs.watch` + 启动全量扫 + 30 秒慢清扫 + `chat.send` 补投 + `agent.wait` 确认 + `3s/10s/30s` 退避重投 | ~400 | `ctx.jobs.onJobDone` → 闲的 owner `followup()` 开一轮、忙的 `inject()` 等在 next-step 收件箱 | **已验**：idle→`followup=1`；busy 且两任务同时完→`inject=2`（只花一步） |
| `duplicateGuard` 按「工具+provider」锁死，同时只能跑一个视频任务 | ~40 | `maxConcurrentJobsPerOwner` 配置项，默认 10 | **已验**：第 11 个被拒，报错还教模型用 `job_kill` |
| `persona-plugin` 的 `before_prompt_build` 按 sessionKey 注入人设 | ~200 | `dsh-persona` 插件，`complete: true` 直接接管系统提示词 | **已验**：身份被接管，输入 token 从 7.9K 降到 116 |
| `persona-plugin` 的 `before_model_resolve`：成员跟随队长模型的兜底钩子 | ~30 | 成员不设 `agentOptions` 时原生继承 | **已验** |
| `team-roster-prompt.ts` 里 `[Working directory: …]` 那句 + `cwd` 双管 | 151 | 子会话原生继承 cwd | **已验** |
| **每次写配置前 `config.get` 取 baseHash** | — | dsh 的 `expectedRevision` 是**可选**参数，不传就不检查 | **已验**：openclaw 上这一步白花 0.9~3.2 秒；dsh 上三个 namespace 并发写全程 **36ms** |
| `setConfigBatchStepwise` + `SIZE_DROP_SAFE_RATIO` 体积骤降保护 | ~250 | dsh 按 namespace 写**叶级 diff**，压根没有「整份配置体积」这个概念 | **已验**（`settings-file/src/index.ts:81-92` 的 `patchNode`） |
| `renderQueue` 串行 + 分槽合并 | ~60 | 内核自带一条串行操作链，watcher 重载与文档写入一次一个、按队列顺序 | **已验**（`settings-file/src/index.ts:126, 192-197`） |
| 自写抑制（忽略自己那次落盘触发的回传） | — | `this.text` 缓存最后一次成功持久化的原文，watcher 事件内容相等即 no-op | **已验**：`does not republish its own persisted write` |
| `removeStale{Image,Video}GenerationModel` / `removeStaleTtsProvider` / `removeLegacyUiToolsMcpEntry` | ~120 | dsh 有明确的删除路径：`replace` 整段重置（缺的键回落 base + schema 默认）、`mutate` 的 `unset` 按路径删 | 形状已确认，逐条对照留到阶段 2 |
| `openclaw-manager.ts` + `gateway-port.ts` + `preflight.ts`：spawn 进程、端口自愈、6 步自检、5 次重启退避 | 1,030 | **内核跑在 Electron 主进程内**，没有子进程、没有端口、没有握手 | 架构事实，已读源码确认 |
| `agent-manager.ts`：79 个 agent 的包袱（专家各占一个 agent） | 941 | 专家 = agent preset，不进全局注册表 | **已验**（`kumo-test` / `kumo-team`） |
| `scripts/patch-kernel-reasoning.mjs` + `ipc.ts` 的运行时自检 | — | 直接打内核 dist 补丁去掉 `onReasoningStream` 闸门。换内核后重新评估 | 待确认 |

粗算：**约 3,840 行是纯粹为绕开 openclaw 而存在的，换内核后应当归零**
（其中媒体投递那 ~400 行与并发锁那 ~40 行是 2026-08-17 阶段 4 闸门验完后新确认可归零的）。

### 必须从零新建

| 能力 | 为什么是从零 |
|---|---|
| **媒体生成** | 195 个已装 dsh 包里，出图 / 视频 / 语音 / TTS **一个都没有**。规模：13 个视频适配器（文生档 19 条 / 图生档 18 条）、出图池 33 条（23 条走 OpenAI 兼容端点 + 6 条 Gemini 族走对话端点 + 4 条厂商异步，其中 17 条可改图）、TTS 5 条、搜索 provider 一个。**这是本次最大的一笔成本**，而且它依赖内核能力，不只是重写代码，见阶段 4 |
| **账号体系的 dsh 侧落点** | dsh 没有任何账号概念（`dsh-credentials` 只是 API key 存取，`dsh-token-meter` 是 token 计数，`dsh-anonymous-user-id` 是遥测 ID）。登录页、余额行、会话过期回登录页这些要作为新插件挂进 dsh 的 slot |
| **连接器界面** | dsh 有能力（`dsh-mcp-client`）无界面 |

## 外壳选型：用它的

`dsh-plugin-desktop` 只有 **39 个文件 / 5,766 行**，却已经带了这些我们否则要自己写或已经写了的东西：

| 它带的 | 我们现在的对应物 |
|---|---|
| 内核跑在 Electron 主进程内，loopback HTTP/WS 供 UI | `openclaw-manager.ts` spawn 子进程 + `gateway-port.ts` 端口自愈 + `preflight.ts` 6 步自检，共 1,030 行 |
| `profile-manager.ts` / `profile.ts` 多配置档与 generation 生命周期 | 无 |
| `updates.ts` / `update-checker.ts` / `update-download.ts` 自动更新 | 有，但要重接 |
| `electron-runtime.ts` 托盘、窗口、`window-chrome.ts` / `window-options.ts` | 有，`App.tsx` 里的自绘标题栏 |
| `windows-pwsh-sandbox.ts` / `windows-acl-runner.ts` / `windows-volume-diagnostics.ts` | 无 |
| `pnpm.ts` 插件安装 | `plugins install --force` spawn CLI 三处 |
| `desktop-terminal.ts` | 无 |

最关键的一条不是省代码，是**去掉一整类 bug**：我们撞过的
`Agent "<id>" no longer exists` 那条竞态，根因就是 spawn CLI 改配置、网关读到旧值。
内核在主进程内之后这条路不存在了。

**品牌触点清单（2026-08-17 逐处查证，不是三处，是七处，且有两处在内核里）**：

原先写的「改三处」是照 `package.json` 推的，实际逐处搜过之后是这样：

| # | 位置 | 内容 | 能不能从外部覆盖 |
|---|---|---|---|
| 1 | `dsh-plugin-desktop/package.json` `build.*` | `appId` = `ai.deepseek.dsh.desktop`、`productName` = `DSH Desktop`、`nsis.shortcutName`、`artifactName` | 能 —— electron-builder 配置归打包方，我们自己写 |
| 2 | `src/main.ts:47` | `PRODUCT_NAME = 'DSH Desktop'`，喂给 `app.setName()`，**决定 userData 目录名** | 不能，模块级常量 |
| 3 | `src/main.ts:165` | `app.setAppUserModelId('ai.deepseek.dsh.desktop')`（Windows 任务栏归组） | 不能 |
| 4 | `src/index.ts:171-172` | `productName: 'DSH Desktop'`、`windowTitle: 'DeepSeek Harness Desktop'`，写在 `...config` 展开**之后** | **不能**，展开在前所以 cordis 配置压不住它 |
| 5 | `src/update-checker.ts:4`、`src/update-download.ts:13-14` | 三个 `https://www.dshdesktop.cn/...` 端点（版本 + mac/win 下载） | **能，而且不用改代码** —— 见下面「更新端点」 |
| 6 | `build/tray-icon.svg` + `scripts/generate-tray-icons.mjs:13-16` | 托盘图标，且脚本对品牌蓝 `#4D6BFE` 有断言，换色不改脚本会构建失败 | 不能 |
| 7 | 内核 `client/ui-primitives/src/BrandWordmark.tsx` | DeepSeek Harness 字标 SVG，被 `ui-sidebar/src/client/SidebarRoot.tsx:140` **硬导入**，logo 行不是槽位 | **未定，见下面「字标是唯一一处真冲突」** |

还有两处小尾巴：内核 `client/ui-settings-models/src/onboarding-copy.ts` 的内测声明文案提到
DeepSeek Harness；网页 `<title>DeepSeek Harness</title>` 是运行时生成的（`packages/client/web`
的 `DocumentTitle`），高级模式下原生标题栏走的是第 4 条那个 `windowTitle`，所以影响面小。

**更新端点这条比原先估的便宜。** `cordis.patch.yml` 显示外壳是**五个可分别组合的插件**
（`desktop-shell` / `-terminal` / `-pnpm` / `-profiles` / `-updates`），三个硬编码端点全在
`desktop-updates` 那一条底下（`updates.ts` 257 + `update-checker.ts` 197 +
`update-download.ts` 316 = 770 行）。**不插入这一条即可**，不必为了改更新地址去动它的代码。
但「照原样发布会让我们的用户去 anywhere-labs 检查更新」这个风险不变，**仍是发布前的硬闸门**。

第 8 条：Windows 代码签名，`scripts/package-win.ts` 支持 PFX（`win_csc_link`），接我们的证书。

**风险要写清**：外壳是社区维护的单点依赖，内核锁在 `0.1.0-rc.5` —— rc 意味着接口还会变
（内核自己的内测声明就写着「核心插件与基础 API 会在接下来一段时间快速迭代」）。
应对是 fork 而不是 submodule 跟随，升级由我们自己决定时机，每次升级前 diff 内核的
配置层与 subagent 相关目录。

## UI 铁律：内核有的就用内核的

**用户 2026-08-17 定的原则，优先级高于本文档其它一切界面判断：
侧栏、布局、聊天区这些一律用内核的，我们只往上加专家、技能、连接器。
凡是内核已经有的，就用内核的，不自写、不为了形似去改它的结构。**

（本节上一版写过「我们本来就要自写侧栏，所以内核字标那条不是问题」——**那句是错的，已删**。
不自写侧栏，字标那条因此重新变成待决项，见品牌触点第 7 条。）

现有渲染层 **34 个 ts/tsx = 15,656 行**，外加 `styles.css` 10,257 行。
其中 `Workspace.tsx` 一个文件 6,687 行（占 ts/tsx 的 43%），加 `Composer.tsx` 1,670 行
与四个聊天组件，聊天主界面共约 **8,836 行，占 56%**。按上面这条原则，这 8,836 行
**绝大部分不是重写，是删掉换成内核的**。

### 真机名录：默认外壳已经挂了 39 个浏览器插件（2026-08-17 实测）

原先这一节是照包名清单推的，推错了一次：`dsh-plugin-desktop/package.json` 的依赖清单里
只有 14 个 `dsh-client-ui-*`，据此我判断专家 / 技能 / 专家团的界面「内核有但外壳没挂」。
**依赖清单不是挂载名录。** 真正的名录在 `packages/bundle/web-app/cordis.patch.yml`，
外壳的 `cordis.patch.yml` 只是往上**追加**五行桌面插件，一条都没删。

取真机证据的办法（结论会过期，记怎么取）：起进程 → 找它 loopback 端口 →
拉根 HTML，浏览器插件名录就内联在 `window.__DSH_BOOT__` 里。实测 **39 条**，我们要的全在：

| 我们要的 | 内核的包 | 默认挂了吗 |
|---|---|---|
| 专家 | `dsh-client-ui-agent-preset` | **已挂** |
| 技能 | `dsh-client-ui-skill` | **已挂** |
| 专家团 | `dsh-client-ui-subagent` | **已挂** |
| 连接器 / 插件 | `dsh-client-ui-settings-plugins` + `-settings-plugin-inventory` | **已挂** |
| 聊天时间线 / 侧栏 / 布局 | `-conversation` / `-sidebar` / `-layout` | 已挂 |
| 产物 | `-deliverables` | 已挂 |
| 任务 | `-jobs` | 已挂 |
| 项目 | `-workspace` | 已挂 |
| 自动化 | `-plan` / `-goal` / `-workflow-run` | 已挂 |
| 设置 | `-settings` / `-settings-general` / `-settings-models` / `-settings-plugins` | 已挂 |
| 模型选择 | `-model-selection` | 已挂 |
| 主题 | `-theme` | 已挂 |
| 追踪 / 问答卡 / 权限档 / 消息反馈 | `-trajectory` / `-user-questions` / `-permission-presets` / `-message-feedback` | 已挂 |

**所以「把专家·技能·连接器加上去」加的不是界面，是我们自己的内容 —— 连接器除外。**
连接器是这份名录里唯一一处真的缺东西，而且缺的不止一行组合，详见下一节。

### 专家与技能的落点：agent preset 目录（内核原生形状）

出厂四个档 `standard` / `minimal` / `cordis` / `code`，在
`apps/cli/config/agent-presets/<id>/`。`cordis` 那个是完整样板，直接对上我们
「专家 = 人设 + 技能 + 工具集」：

| 我们的概念 | 内核里是什么 | `path:line` |
|---|---|---|
| 专家的显示名 / 简介 / 排序 | `preset.yml` 的 `name` / `description` / `order`，**`name` 原生支持中文**（出厂那个就叫「创造模式」）| `agent-presets/cordis/preset.yml:1-3` |
| 专家人设 | `agent.cordis.yml` 里一行 `@deepseek-ai/dsh-persona`，`{{model}}` / `{{cwd}}` 会插值 | `agent-presets/cordis/agent.cordis.yml:17-29` |
| **技能跟着专家走** | `skill-filesystem` 的 `customSkillDirs` 指向**档目录内部**的 `skills/`，配 `tool-skill` 给出目录与加载器 | 同上 `:255-262` |
| 专家能用哪些工具 | 就是这份 `agent.cordis.yml` 的行；宿主层把工具整批 `disabled`，每个会话挂一个档 | `bundle/web-app/cordis.patch.yml:276-425` |

内核自己写了为什么技能要跟着档走（`:248-254`）：*a preset is the unit that gets copied and edited*。
这条正好是我们专家市场要的分发单位——市场装的东西从「往 `~/.openclaw/skills/` 塞文件 +
改 frontmatter 控可见性」变成「写一个 preset 目录」，`skill-visibility.ts` 那 212 行的
frontmatter 手术随之消失。

出厂档是只读的（`system` 信任，升级会覆盖），用户/市场装的写在
`$DSH_HOME/.agent-presets/<id>/`，名录会报每个档的真实路径。

#### 这条链已在真机上走通（2026-08-17，`DeepSeek-V4-Flash` 经 `api.openlux.ai`）

拿 `standard` 整目录拷成 `yw-finance`（内核自己的规矩：**创作即复制**，
`copy(from, id, name?)` 是唯一的创作写入，服务从不接受调用方给的组装文本），
只改三处：persona 换成带代号 `KUMO-FIN-3` 的中文人设、`skill-filesystem` 加
`customSkillDirs` 指向档内 `skills/`、放一个 `yw-invoice-redflush` 技能，
正文里埋一句校验口令。四条判据逐条对上：

| 判据 | 真机结果 |
|---|---|
| 发现 | preset 目录是在**应用已经跑起来之后**才写到盘上的，选择器里立刻出现「云雾财务专家」并显示我们写的中文描述 —— 实证了 README 那句「发现过程不做缓存」，**不用重启** |
| 人格接管 | 模型第一句「我是「云雾财务专家」，代号 KUMO-FIN-3，只负责发票与红冲相关的工作。」，原文出自 persona 行 |
| 自带技能进名录 | 该会话多出第三段上下文注入 `skill-catalog`，正文是 `<available_skills> yw-invoice-redflush: <完整描述>` |
| 技能真能加载 | 轨迹页 `TOOL skill {"name":"yw-invoice-redflush"} → <skill_content name="yw-invoice-redflush"> <skill_resources> Base directory for…` |
| **兄弟档看不到** | 同一台机器、同一模型、同一份 `DSH_HOME`，隔九分钟另开一条 `标准模式` 会话：上下文注入**只有两段**（`AGENTS.md/CLAUDE.md` + `system-prompt`），**根本没有 `skill-catalog` 这一段**，`yw-invoice-redflush` 全文不出现 |

最后一行就是结论：**会话级技能作用域是内核原生的，不用我们拼。** openclaw 上我们靠
`disable-model-invocation` + `before_prompt_build` 才拼出同样的结果
（见技能册「技能随专家走」），那 212 行 `skill-visibility.ts` 到这里整件事消失。

**三条会误判的观察，记下来省得下次重查：**

- **`Error: unknown tool ""` 不是配错，也不是模型抽风 —— 是中转的分片写法和内核对不上，
  必现。** 详见下面「中转分片错位」一节。判这个只能看轨迹页的两行，
  对话页把失败和成功渲染成挨着的两块，看着像一次失败。
- **新会话不记忆上次选的档**，回到部署默认值 `standard`
  （`bundle/web-app/cordis.patch.yml:424`）。默认值是用户设置
  `agent-presets.default`，要改默认专家改它。
- **代际只以 `agent.cordis.yml` 为键。** 改旁边的 `SKILL.md` **不会**送达新会话，
  要等组装文件本身变动或进程重启（README「已知限制」第三条）。
  技能全部重写那一轮会反复踩这个 —— 改完技能顺手 `touch` 一下组装文件。

**那次 `已重试模型请求（2/2）` 是外部的，根因已定位到具体渠道**：`llm/retry` 事件里两次失败是
`DeepSeek stream idle timeout after 300000ms`（`TIMEOUT`）和
`model returned a completed response with no content`（`EMPTY_RESPONSE`），跟上下文长度无关。
原样重打一遍就通了（3 步 3m46s，口令原样答出）。

查 `yw_zhoucongjie` 当天 3 小时的消费日志（`run_query__openlux_log`，按 `channel_id` 聚合），
坐实是**渠道池里有坏成员，而且坏的恰好排在最前**：

| 渠道 | 名称 | 优先级 | 上游 | 请求 | 平均耗时 | 最长 |
|---|---|---|---|---|---|---|
| 5976 | PICO-开源-0.3对私 | **294（最高）** | `142.0.143.129:3000` | 30 | **107.7s** | **812s** |
| 6111 | PICO-开源-0.5稳定 | 289 | 同上 | 5 | — | **5/5 全 429** |
| 6023 | dataeyes-glm*0.45 | 286 | `cloud.dataeyes.ai` | 3 | 13.0s | 23s |
| 6264 | ominiai-glm-5.2*45折 | 285 | `api.ominiai.cn` | 7 | 38.1s | 153s |
| 5978 | PICO-deepseek-v4-flash-0731 | 220 | `142.0.143.129:3000` | 2 | 47.5s | 65s |
| 6083 | dataeyes-deepseek*0.65 | 220 | `cloud.dataeyes.ai` | 1 | 350s | 350s |

服务端自己记下了 812 秒的请求，所以不是客户端错觉。6111 与 6083 的 `test_time` 为 0，
健康检查从未跑过。**排查期的经验教训：撞到超时先查这张表再怀疑代码**
——同一个探针脚本一小时内跑出过 38s / 2.9s / 90s 超时三种结果，差别只是落到哪条渠道。

#### 中转分片错位：`unknown tool ""` 与空 callId 同一个根因（2026-08-17 查实）

**必现，不是噪声。** 三条会话逐一挖出 `tool/call` 事件，第一步全是 `name: ""` → `UNKNOWN_TOOL`，
换成 `todo_write` 也一样：

| 会话 | 第 1 步 | 第 2 步（模型自纠） |
|---|---|---|
| 32abde65 | callId 正常，name `""` | callId **空**，name `skill` |
| 4df8b516 | callId 正常，name `""` | callId **空**，name `todo_write` |
| f86719e3 | callId 正常，name `""` | callId 正常，name `skill` |

直接打中转看原始 SSE（`https://api.openlux.ai/v1`，`deepseek-v4-flash`，带一个 `skill` 工具定义），
分片长这样：

```
delta #0: []
delta #1: [{"id":"call_00_mdyGbDPV…","type":"function","function":{"name":"skill","arguments":""},"index":0}]
delta #2: [{"function":{"name":"","arguments":"{"},"index":0}]
```

首片带齐 `id` 和 `name`（合规）；续片**省略 `id`**（也合规），但**带了 `"name": ""`**
—— OpenAI 的约定是续片不带 `name`，发空串不合规。内核这边
`llm-deepseek/src/translate.ts:159-160` 判的是 `!== undefined` 而不是真假：

```ts
if (call.id !== undefined) block.callId = call.id
if (call.function?.name !== undefined) block.name = call.function.name
```

于是空串照样赋值，把首片的 `skill` 冲成 `""`。首片给 `id`、续片不给 → callId 活下来；
反过来某些轮首片没给 `id`，`CallId(block.callId ?? '')` 就落成空串。表里两种形状都齐了。

**两个后果轻重差得远：**

- `unknown tool ""` —— 每次调工具白费一步，模型自己纠回来。纯浪费，能忍。
- **空 callId —— 整条会话重载时读不出来。** `core/session/src/index.ts` 校验
  `tool/result` 必须有非空 `source.callId`，写的时候不拦、读的时候拒收，
  于是会话永久打不开。上表三条里已经死了两条。

**解法：换适配器，不打补丁，也不用等中转。** 内核带了**两个** OpenAI 兼容适配器，
我们默认用的 `llm-deepseek` 是严格的那个，旁边的 `llm-pi-ai` 在同一位置本来就是宽容写法：

```ts
// llm-pi-ai/src/stream.ts:168-169
id: CallId(known?.id ?? ''),
...known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {},
```

`known.name.length > 0` 显式挡空串。更要紧的是它的 id/name 在 `toolcall_start` 时
从 partial 一次取定（`toolIds` map），后续 delta 只贡献 arguments，
**续片的空 name 结构上就没有写入路径**。上面两种坏形状它都不会中招。

`llm-pi-ai` 已经挂在 base bundle 里，dormant 状态——零路由，直到 `settings.yaml`
给出 provider profile 才热注册。base 的注释把用法写死了：

> mounted dormant … then those routes register live … **Supplying those profiles is
> exactly what the web Models page does.** Which adapters exist is composition;
> which providers run is the user's settings document.

所以这是一段用户设置，不是改代码，写进 `$DSH_HOME/settings.yaml` 即可（热重载，免重启）：

```yaml
llm-pi-ai:
  providers:
    openlux:
      displayName: OpenLux
      apiKeyEnv: OPENLUX_API_KEY
      api: openai-completions          # 目录里没有的路由必须自报协议
      baseURL: https://api.openlux.ai/v1
      streamIdleTimeoutMs: 90000       # 顺手治渠道挂死拖满 300s
      models:
        - { id: deepseek-v4-pro,   name: OpenLux V4-Pro }
        - { id: deepseek-v4-flash, name: OpenLux V4-Flash }
```

**真机复验（2026-08-17）：** 写入后 6 秒内选择器从 2 个模型变 4 个，没重启；
两个模型各跑一次 MCP 工具调用，**首次即成，`unknown tool ""` 一次都没再出现**：

| 模型 | 结果 | 用时 / 首 token |
|---|---|---|
| OpenLux V4-Pro | `mcp__ywprobe__ping · hello` → 口令 TOPAZ-9 | 9s / 5.2s |
| OpenLux V4-Flash | `mcp__ywprobe__ping · second` → 口令 TOPAZ-9（带备注） | 9s / 5.3s |

对照组是同一个探针在 `llm-deepseek` 下必现卡第一步。

**出厂默认落在组合层，不落在用户设置。** 上面那段 YAML 只适合手验：它写在用户的
`settings.yaml` 里，重装即失，也不该由用户来维护。产品形态是把同一份内容作为
`llm-pi-ai` 的**组合基座**写进 `dsh/dsh-plugin-desktop/cordis.patch.yml`
（`- id: llm-pi-ai` + `config:`，patch 格式本来就支持改已存在条目的配置，
同文件里 `web-runtime` 那条就是先例）。理由是这条路由里没有一个字段是「每个用户不同」的：
端点是我们自己的服务，`apiKeyEnv` 是**引用**不是密钥，真正的令牌在登录时进凭据库。

分层语义在 `settings/src/index.ts:290-305`（`mergeLayers`），三条都用得上：

- **普通对象递归合并** → 模型页改任何一个字段都能盖住出厂值，逐键生效。
- **数组整体替换** → 阶段 2 从 admin-server 拉下来的目录写进用户层的 `models`，
  会把出厂那两条**整体顶掉**，不会和它们混在一起。
- **稀疏 patch 擦不掉下层的键**（注释原话）→ 出厂路由删不掉。

最后这条本来是我判断的一个坑：以为界面会给出厂路由一个按了不生效的「删除」。
**真机验下来是我想错了，内核处理得比预想干净**——同一条 `openlux` 路由，
来自用户层时卡片是「编辑 + 删除」，改成来自组合基座后**删除按钮直接消失**，
只剩「编辑」，跟内置的 DeepSeek 一模一样。判据是用户层有没有这一条，
不是路由在不在 pi-ai 的内置目录里。所以出厂路由天然呈现为内置提供方，可改不可删，
正是产品该有的姿态。

组合层供给的复验（`settings.yaml` 里已无 `llm-pi-ai:` 段）：重启后选择器里两个 OpenLux 模型
都在，`mcp__ywprobe__ping` 一次调通，11s。测试 297 passed / 4 failed，那 4 个是
Windows 上跑 macOS 应用包校验的既有失败，暂存改动后对照跑数字完全一致。

`llm-deepseek` 留着不动——它对官方直连仍是对的。中转那两条（续片不该发 `name` 空串、
首片必须带 `id`）仍值得报过去，修了对所有客户端都好，但**不再阻断我们**，
优先级降到「有空再说」。

顺带记一条教训：这一处差点就去打 yarn `patch:` 了。`dsh/package.json` 的 `resolutions`
里确实挂着两个先例（`app-builder-lib`、`dsh-sandbox-windows-acl`），路是通的——
正因为通，才容易在内核明明留了旋钮的时候直接上手改，给每次跟上游同步埋刺。

#### GUI 探针手法（这套东西验界面只能这么验，记方法不记文件）

无头那条 `dsh --profile headless` **挂不了 preset** —— 它是平铺组装，
`--dump-config` 里没有 `agent-presets` 行，技能和 persona 直接写在 profile 里。
preset 只活在 web-app 那套组装里，也就是我们的壳。所以专家相关的东西**只能驱动 GUI 验**：

- Electron 收 `--remote-debugging-port=9333`，`http://127.0.0.1:9333/json/list` 拿到页面
  target 的 WebSocket 地址。Node 24 自带全局 `WebSocket`，**不需要装任何包**就能说 CDP。
- **`Runtime.evaluate` 里的 `el.click()` 对 preset 选择器无效** —— 这类 `role="option"`
  的菜单监听 pointerdown。要用 `Input.dispatchMouseEvent` 的
  `mouseMoved` → `mousePressed` → `mouseReleased` 按坐标点，那条路径跟真鼠标同一个入口。
  输入用 `Input.insertText`，发送用 `Input.dispatchKeyEvent` 的 Enter。
- **判断有没有点中要隔一拍再读**：点完立刻查选择器标签会读到旧值，
  我因此误判过一次「没选上」，其实已经选上了。
- **会话日志能直接解，别只靠轨迹页**：`$DSH_HOME/sessions/**/session.jsonl.zstd`
  是**一次 flush 一个 zstd 帧、首尾相接拼起来的**。`zstdDecompressSync` 和流式
  `createZstdDecompress` 都在第一帧结束就停（31.6 KB 压缩只解出 223 字符的 `session` 头），
  看着像格式怪，其实只是没喂后面的帧。按魔数 `28 b5 2f fd` 切开、逐帧解、把结果拼起来，
  就是完整的 JSONL，每行一个带 `seq` 和 `type` 的事件。
  这条是查上面那个分片错位的唯一途径 —— 轨迹页只渲染人看的摘要，
  `tool/call` 里的 `callId` 和 `name` 到底是不是空串，只有原始事件里看得到。

### 侧栏能往哪儿加：三个具名槽位

`ui-sidebar/src/client/SidebarRoot.tsx` 自己只管列几何与折叠动画，内容归注册方：

| 槽位 | 位置 | `path:line` |
|---|---|---|
| `sidebar.workspaces` | New Session 按钮到底栏之间**整块浏览区**（今天由 `ui-workspace` 的 `WorkspaceBrowser` 占着）| `SidebarRoot.tsx:175` |
| `sidebar.footer.action` | 底栏动作区，叠在设置之上 | `:184` |
| `sidebar.settings` | 钉在最底的设置 | `:187` |

槽位还能声明**子槽位**（`ui-workspace` 就声明了 `sidebar.workspaces.directoryFlow`，
`kind: 'single'`），所以往里加东西不必抢占整块区域。

我们独有的那几件（媒体三档选择器 `MediaPicker.tsx` 441 行、账户余额行
`AccountBalanceRow.tsx` 113 行、市场入口 `MarketGallery.tsx` 611 行 +
`settings/Market.tsx` 948 行）就挂这些槽位。专家团成员条 `TeamMemberBar.tsx` 163 行
与问答卡 `AskUserModal.tsx` 239 行**先比对内核的 `-subagent` / `-user-questions`
再决定留不留**——按上面那条铁律，默认是不留。

### 连接器：能力有、界面无、热重载也没有（2026-08-17 真机验完）

这是全份名录里唯一一处内核真的缺东西的地方，而且**我们现在就有这个功能，直接迁会丢**。
现状（`src/main/market/connector-installer.ts`）：连接器是市场里的一个条目类型，
manifest 带 MCP server 配置，安装 = `openclaw mcp set <名字> <json>` →
（OAuth 型再 `mcp login`）→ `mcp reload`，卸载 = `mcp unset` + reload，
`market-connectors.json` 记安装态。**openclaw 内核自带运行时增删 MCP 服务器的通路和授权流。**

DSH 侧逐条实测：

| 问题 | 答案 | 证据 |
|---|---|---|
| 挂上去能不能连 | **能** | profile 用户层写一行 → 重启 → 自写的零依赖 stdio 探针收到 `initialize from dsh-mcp-client` 与 `tools/list`，即内核侧已连上并取走工具清单 |
| 模型真能调到吗 | **能，最后一公里已通** | 换 `llm-pi-ai` 路由后（见「中转分片错位」一节），V4-Pro / V4-Flash 各一次 `mcp__ywprobe__ping`，**首次即成**，探针进程侧 `tools/call ping` 对得上，口令原样返回，各 9 秒。此前卡住的不是 MCP，是 `llm-deepseek` 撞中转分片错位 |
| 要不要装包 | **不要** | `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-mcp-client` 随 bundle 依赖树就在，早于我们任何安装动作 |
| 往哪儿写 | `$DSH_HOME/profiles/<档>/cordis.patch.yml` | 文件头自己写着「Your patch layer for this dsh profile, applied after every bundle layer」，允许 `!!js`，默认是空数组 `[]`。**这是用户拥有、运行时可写的组合文件，等价于 `mcp set` 的落点** |
| 改了能不能免重启生效 | **不能** | 应用运行中写入，等 16 秒探针进程没被拉起；重启后立刻拉起。`mcp-client` README 说的 HMR 指的是 loader 侧热替换，desktop 档的这个文件不在监听范围内。**`mcp reload` 没有对应物** |
| 有没有现成界面 | **没有，而且上游是故意的** | `mcp-client` 无浏览器半侧；插件设置页只渲染插件自己注册的手写卡片（WebSearch / Bash / AgentLoop 三张），不枚举命名空间；就算写了卡片，命名空间还得进 `apiproxy` 里写死的 `WEB_SETTINGS_NAMESPACES`；preset 那条路上游明说「浏览器不再编辑任何组装文本」 |

**所以连接器这条这样做**：界面沿用我们本来就要保留的市场页，安装 = 往 profile 用户层写一行、
卸载 = 删掉那一行，落点全在我们自己的壳里，不动内核。两处净增成本要认：

1. **生效要重启。** openclaw 是 `mcp reload` 立即生效，DSH 得重启应用。
   装完提示「重启后生效」是最省的做法；想做到即时，得自己找 loader 的重载入口，属于未验的活。
2. **OAuth 型要自己走。** openclaw 有 `mcp login` 内核代劳，`mcp-client` 只认静态
   `headers` / `env`，授权那一趟得我们自己跑完再把 token 写进配置。

### 字标是唯一一处真冲突

不自写侧栏之后，内核字标 `BrandWordmark`（`ui-primitives/src/BrandWordmark.tsx`）
被 `SidebarRoot.tsx:140` 硬导入进 logo 行，而 logo 行**不是槽位**（三个槽位都在它下面）。
客户端是按包构建、按 `/plugins/<id>/client.js` 分发的，所以字标是编译进
`ui-sidebar` 的 client bundle 的，从外部换不掉。三条路，都有代价，**待定**：

1. **接受它**，内测期先挂着 DeepSeek Harness 字标。零成本，但不能这样发版。
2. **CSS 盖掉**：藏掉 `.brand` 里的 svg、换成我们的背景图。不动内核，但
   `SidebarRoot.module.css` 的类名是构建期哈希的，选择器脆；每次升内核要复验。
3. **fork 内核的 `ui-primitives`**，从源码构建。最干净也最贵：内核是 `0.1.0-rc`，
   fork 一个包就等于把整条源码构建链接进我们的流水线（今天不需要，见阶段 0 第 1 条发现）。

WorkBuddy 的作用降为**判据来源**：某个交互该长什么样、某条降级该怎么兜，
仍以「WorkBuddy 用户看到的行为」为准（例如余额取不到时四档降级、绝不显示 0）。
但**实现形状以内核为准**。

## 未完成清单 / 没做的功能 / 待做（2026-08-19 04:40 全文扫过一遍）

**为什么要有这一节**：这份文档是按阶段增量写的，待做项散在两千多行里，"用户指定模型出图"
这种条目还埋在一个标题不含关键词的小节里（叫「工具可见面收窄」的第三点），按关键词搜必然
扑空。所以这里只做索引与排序，**每条的正文以它自己那节为准**，改完记得回来划掉。

### 一、正在造成真实损失，最先做

| 条目 | 落点 | 判据 |
|---|---|---|
| **专家团成员的工具面被钉死成四个** `['skill','read','write','edit']`，六个成员一个出图/出片/shell 工具都看不到 | `MEMBER_ALLOW`（已扩到 9 个，2026-08-19 起搬到两条路径共用的 `openlux-plugin-account/src/market/teammate-tools.ts`）；**改产物会被下次 materialize 覆盖** | 正确组装上让 `image_creator` 真出一张图 |
| **同一个生成器还有第二条路径不写 `toolFilter`**（`marketing-growth-team` 四成员看得见全部工具，包括彼此的 `delegate_*`，能互相委派绕圈）| 同上，两条路径要收敛到"按角色给能力工具" | 成员看得见自己该用的，看不见别人的委派工具 |
| **人设内容还是 WorkBuddy 的**：25 处 `SendMessage`、13 处 `ImageGen`、9 处 `ImageEdit`、13 处 `deliver_attachments`、16 处 `YT-VITA`、死模型名 HY-Image×25 / HY-Video×18 / YT-Video×28、品牌词 WorkBuddy×14 | 同上；具体清单见「14 份 preset 全量静态扫描」 | 成员不再建议用户"去 WorkBuddy 出图"；模型名一律删掉不换新名 |
| `tencent-cloud-quote-assistant` 还有 2 处 WorkBuddy | 市场内容 | 全文零命中 |

### 二、工具可见面收窄：三条里剩两条半（正文见「工具可见面收窄」）

- **第一条 `web_fetch` 网络面：已落地**，唯一缺口是**所有判据都没经过模型**——要在会话里让
  模型自己去抓一次内网。很便宜，一发会话。
- **第二条工具名单按角色收窄：不是没做，是做过头了。** 子代理侧本来就是配置（上面第一组
  就是它的修正）；还差**主 agent 侧那一薄层**——内核没有声明式行，要在 agent 创建时读配置调
  `agent.ctx.tools.restrict()`；以及 **deny 方向的会话判据**（配 `deny: [image_generate]`
  后问模型"你有哪些工具"，`ctx.tools.schemas()` 是全局视角看不出来）。allow 方向 2026-08-19
  已在真机兑现。
- **第三条用户指定模型出图/出视频：完全没动，而且要覆盖三档——不用专家 / 用单专家 /
  用专家团。** 把 `model` 加成取 `ROUTE_MODELS` 键的 enum、`size` 取值跟着所选模型走，
  这一改三档的参数面同时活（**已验**：14 份 preset 无一挂媒体工具行，三档共用全局那一份）。
  后两档各多一个前提：单专家要求**人设不写死模型名**，专家团还多**一跳透传**（成员看不到
  用户原话，得由主理人写进委派 prompt）。三档共同还差"用户点名我们没有的模型时怎么答"。
  **硬依赖**：后两档现在连 `image_generate` 都被 `toolFilter` 挡着，所以第一组那件事是前提。
  **另有外部依赖**：网关上 gemini 那几个出图模型是 503，名单要人工筛，工期不由我们定。

### 三、发版阻塞（阶段 6）

- **品牌还剩"两处半"，界面换完了嘴没换**（正文见「品牌换成 OpenLux」）：
  模型自报上游名字（`dsh-web-app` 的 `webSurfacePrompt` 写着 "the DeepSeek Harness Web GUI
  at …"，系统提示词 "You are an AI agent powered by DeepSeek Harness"，落点 `system-prompt`
  行的 `persona`）；`web_fetch` 对外的 `User-Agent` 还是 `deepseek-harness/0.0.1`
  （**现成旋钮 `Config.userAgent`，改一行**，被抓的站点看到的就是它）；
  `manifest.webmanifest` 的 `name` / `short_name`（桌面壳里看不见）。
- **签名、更新通道、灰度与回滚方案**都还没做。托盘里那条上游更新命令目前是刻意不挂的
  （我们没有自己的发布服务），`verify:profile` 有断言守着。
- `THIRD_PARTY_NOTICES.md` 只能在目标平台生成，别在开发机上跑 `verify:notices`（会把 mac
  条目换成 win32，不报错的回归）。

### 四、跨项目：admin-server / admin-cloud（正文见「admin-server / admin-cloud 要改什么」）

- **制品重新设计的服务端那半边**：单位是"一个 preset 目录的归档"，服务端只投
  `expert-content.zip`（组装在客户端做），制品按 `kernel_api` 分行、不为客户端代际留兼容分支。
  **客户端安装器已实现并真机验通**，服务端与后台界面按新形状改造还没做。
- **模型档案的思考方言**：`desktop_model_profile` 现在下发的还是 openclaw 的七种方言，
  目标形状 2026-08-17 就定了（`thinking_levels` + `default_thinking_level` 合成
  `reasoning_efforts` 字典、`can_disable_thinking` 删列、档位扩到七档），admin-cloud 的
  模型档案页跟着改表单，**服务端还要继承客户端那三道校验**——dsh 那边是解析期抛错，
  下发脏数据的后果从"铺出假档位"升级成"整个路由起不来"。

### 五、产品能力缺口

- **用户没法给 AI 发图。** 代码分支照内核形状写了，卡在模型清单：`dsh-host-apiproxy` 按
  `inputModalities` 拒收，而 profile 里两个模型都是 `input: [text]`，所以窗口里根本没有
  附件入口。**清单里进一个能收图的模型这条自动就活**，同时模型话术里现在不许提"让用户发一张"。
- **连接器（MCP）装完要重启才生效。** openclaw 是 `mcp reload` 立即生效，DSH 没有对应物；
  "装完提示重启"是最省的做法，想做到即时得自己找 loader 重载入口，属于未验的活。
- **视频内联播放**是第二步增强（`ui-media` 插件），第一步"白嫖现成产出行"已落地，不是欠账。
  查证之后这条有了前置条件与形状（正文见「产物预览：主线在 DSH 客户端，缺的是一条文件通道」）：
  **客户端没有通用的读本地文件字节通道**，只有图片附件那一条，所以第一件事是照 WorkBuddy 的
  `local-file://` 协议造通道，**动手前先手挂一个 `local-file://` 的 `<video>` 验能不能播**。
  通道通了之后视频 / 音频 / PDF 三类共用它；**Office 三件套与 drawio / excalidraw 明确不做**。
- **异步出片显示成两段对话**（两排点赞、复制只复制一段）：查清了是 `tool-jobs` 在空闲 owner 上
  只能 `followup` 开新轮，加上我们自己的工具描述让模型第一轮就收尾，**内核语义上两轮是对的**。
  处置已定为「保留两轮、只治观感」，三件活见正文「出片通告开的是新一轮」那节，最便宜的一件是
  让唤醒轮别复述上一轮已经说过的产出。

### 六、测试覆盖与跟随风险

- Windows 上「非竞争性锁失败」这条内核锁分支无上游覆盖（他们自己 `skipIf win32`），
  **我们的守卫一侧已覆盖**，内核锁本身那条仍待补。
- 内核锁在 `0.1.0-rc.6`，rc 接口会变：每次升级前 diff 配置层与 subagent 目录。
- 外壳是社区单点依赖（anywhere-labs，MIT 已 fork）。
- 内核认得的对话模型是广场 249 条里的 101 条（41%），缺口按家族 qwen 46 / gpt 16 —— 这条是
  "要不要自己补能力表"的决策，不是必做项，判据是那 101 条恰好是用户真在用的头部。

### 七、旧壳遗留（openclaw 那边，不在 DSH 主线上）

- 媒体模型名纠正钩子**真机那一发仍未打**（要重启应用让网关重载插件），判据是网关日志出现
  `纠正媒体模型覆盖: openai/gpt-image-2 -> yunwu-image/gpt-image-2` 且出图成功。
  离线复验 8/8 已过，正文见 `references/media-video.md`。

## 分阶段计划

每个阶段都遵守「查 → 验 → 改 → 复验」：**动手前必须拿到一条真机输出证明假设成立**，
证不了就不开始写。下面每阶段的"动手前要拿到的证据"就是那道闸门。

### 阶段 0 · 骨架（1 周）· 构建闸门已通过

fork `deepseek-harness-desktop`，改品牌（上面那七处）、接签名证书，
内核按 `upstream.json` 锁版。

- **动手前要拿到的证据**：已有 —— 真机 69 tok/s 通过 `api.openlux.ai`。
- **复验判据**：我们品牌的安装包能装、能起、能用 OpenLux 的 key 跑通一条对话，
  且更新检查打的是我们的地址。

**构建闸门已验（2026-08-17，本机 Windows + node 24.12.0 + yarn 4.18.0 + electron 43.4.0）。**
在上游克隆里从零跑通，验完已清理（探针已删、`git status` 空白、临时 `DSH_HOME` / `userData` 已移除）：

| 步骤 | 真机结果 |
|---|---|
| `corepack yarn install` | **18.8s**，850 包 / 513 MiB；`koffi` / `node-pty` / `dsh-subprocess-local` 三个原生包本机编过，无需 MSVC 手工介入 |
| `corepack yarn build` | **6.8s**，tsdown 出 40 个文件 / 438 KiB |
| 起进程 | 窗口起来了，标题「DeepSeek Harness Desktop」，stderr 干净 |
| 宿主服务 | loopback `127.0.0.1:62808` 返回 **HTTP 200 / 12301 字节**，`<title>DeepSeek Harness</title>` |

**顺带查清三件影响做法的事**：

1. **内核不用从源码构建。** `upstream.json` 里 `sourceVersion`（rc.5）与
   `runtimePackageVersion`（rc.6）是两个值，因为 `dsh-plugin-desktop` 依赖的是**发布在 npm 上的**
   `@deepseek-ai/dsh-*@0.1.0-rc.6`，submodule 只是源码参考。本机 submodule 目录**是空的**
   （`git submodule status` 前缀 `-`），照样装完、构建完、跑起来了。
   `dsh-plugin-desktop` 自己也在 npm 上（latest 2.0.0，本地仓库 2.0.1 未发布）。
2. **开发运行必须给独立 `userData`。** 本机已装正式版 DSH Desktop
   （`%LOCALAPPDATA%\Programs\DSH Desktop\DSH Desktop.exe`）并在跑，它占着
   `%APPDATA%\DSH Desktop` 那把单实例锁，于是 `main.ts:108` 的
   `requestSingleInstanceLock()` 返回 false → `app.quit()`，**静默退出、退出码 0、零输出**。
   查这个现象要注意 Windows 上 electron 是 GUI 子系统，控制台拿不到它的 JS 输出，
   诊断得往文件写。改完 `PRODUCT_NAME` 之后 userData 目录换名，这条自然消失。
3. `.yarnrc.yml` 是 `nodeLinker: node-modules` + `enableScripts: false`，
   靠 `dependenciesMeta.*.built` 逐包放行；换句话说加新依赖如果要跑安装脚本，得在那里显式开。
   **副作用：`yarn install` 不会当场跑 electron 的安装脚本**，`dist/electron.exe` 缺着，
   要在这个 workspace 里跑过一次 yarn 脚本才补上（`yarn rebuild electron` 不触发）。
   第一次 `yarn start` 打「Downloading Electron binary...」就是它在补。

#### 落地：外壳已并入 `dsh/`，品牌已换（提交 `77272d9c`）

**布局**：用户 2026-08-17 定在 `yunwu-desktop` 的 `feature/dsh-kernel` 分支上开一个顶层目录。
做法是 `git subtree add --prefix=dsh dsh-upstream master --squash`，remote 指本地克隆
（不走网络）。以后跟上游合用 `git subtree pull`，所以**对上游的偏离要尽量小**：
品牌值收在 `dsh/dsh-plugin-desktop/src/brand.ts` 一处，各调用点只多一行 import。

坑：`git subtree add` 会因为 CRLF 归一化报 `working tree has modifications`，
而 `git status` 是干净的——它用 `git diff-index` 比 `status` 严格且不刷索引。
先 `git update-index --really-refresh`。

顺带删掉了 `dsh/deepseek-harness` 那个 submodule 与 `dsh/.gitmodules`（照上面第 1 条，用不上）。
**这一删同时废掉了 `check:layout` 的一半断言**，当时没跟着改，见下面「聚合 check 从来没绿过」。

| 改了什么 | 值 / 做法 |
|---|---|
| `APP_ID` | `ai.openlux.desktop` |
| `PRODUCT_NAME` | `OpenLux Desktop` —— 同时决定 userData 目录名 |
| `WINDOW_TITLE` / `SHORTCUT_NAME` | `OpenLux` |
| `INSTALLER_STEM` | `OpenLux-Desktop` |
| 更新插件 | `cordis.patch.yml` 里**整行摘掉** `desktop-updates`，不是设 `enabled: false` —— 要让没有代码路径能碰到那三个 `www.dshdesktop.cn` 常量。包导出保留（打包校验器 `verify-packaged-runtime.ts:102` 仍要解析它）；`runtime.updates.notify` 不受影响，它是 `ElectronDesktopRuntime` 的方法 |
| 字标 | 未动，见「字标是唯一一处真冲突」，内测期先挂着 |

**上游的测试逮住了这次改动，这是好事**：两处断言更新那一行**必须存在**
（`tests/package.spec.ts:102`、`tests/profile.spec.ts:161`），两处断言品牌字面量
（`package.spec.ts` 的 *fixes the installed application identity*、`plugin.spec.ts:187`）。
都翻成我们的意图了 —— 尤其 `package.spec.ts` 改成拿 manifest 的 `build` 块**对 `brand.ts` 比**，
守的是那条真不变量：electron-builder 按 manifest 出安装包、运行时
`app.setName(PRODUCT_NAME)` 决定 userData，两边不一致会把一份安装劈成两个状态目录。

**测试基线**（原文：本机 Windows 上未改动的上游就是 `4 失败 / 297 通过`，四条全在 mac 专属，
我们改完逐条一致，所以判断回归要拿这个数比、不是拿全绿比）**已于 2026-08-18 作废**：
那四条已经处理掉，现在本机基线就是 `299 通过 / 2 跳过 / 0 失败`。见下面「聚合 check 从来没绿过」。

**复验（真机）**：`dsh/` 里装 9.0s、构建 0.3s；起进程窗口标题为品牌名、
userData 落在 `%APPDATA%\OpenLux Desktop`、
loopback **HTTP 200 / 12301 字节**；`typecheck` 干净。

**三份 userData 互不相撞，本机可以并排跑**（对着一个活的上游正式版比对很有用，别关它）：

| 谁 | userData |
|---|---|
| 已装的上游正式版 | `%APPDATA%\DSH Desktop` |
| 我们的新壳 | `%APPDATA%\OpenLux Desktop` |
| 旧项目 | `%APPDATA%\yunwu-desktop` —— 它只调 `setAppUserModelId`、**没调 `app.setName`**，所以目录名是 package.json 的 `name` |

改名成 OpenLux 之后连 `AppUserModelId` 也不再共享了（旧项目仍是 `ai.yunwu.desktop`，
新壳是 `ai.openlux.desktop`），两者在 Windows 任务栏上各占各的位置。

##### 云雾 → OpenLux（2026-08-17 改完并复验）

产品定名 OpenLux。**这不是改一处返回值**：名字落在五个地方，前三个是「越晚改越贵」的，
所以趁没发版一次改完。

| 落点 | 改了什么 | 晚改的代价 |
|---|---|---|
| `brand.ts` 的 `PRODUCT_NAME` | `OpenLux Desktop` | 它同时决定 userData 目录名，发版后再改会把一份安装劈成两个状态目录 |
| `brand.ts` 的 `APP_ID` / `INSTALLER_STEM` / package.json 的 `build` 块 | `ai.openlux.desktop` / `OpenLux-Desktop` | 安装身份与升级路径，发版后再改就成了两个产品 |
| 组合层路由 id | `yunwu` → `openlux` | **凭据名跟着变**，见下 |
| 显示名与模型名 | `OpenLux` / `OpenLux V4-Pro` / `OpenLux V4-Flash` | 纯展示 |
| 自建包与槽位 id | `openlux-plugin-account` / `openlux-sign-in` | 纯内部 |

**路由 id 不是标签，它派生凭据名。** 模型页按 `<ROUTE>_API_KEY` 推导，且删除一行时只清
「引用等于该派生目标」的凭据（`ui-settings-models/README.zh.md:7,34`）。所以路由改叫
`openlux` 之后，`apiKeyEnv` 必须同步改成 `OPENLUX_API_KEY`——改名前它写的是
`DEEPSEEK_API_KEY`，那本来就是个对不上的引用，用户从模型页删账号会删不干净。这次一并修正了。

端点本来就已经是 `https://api.openlux.ai/v1`，只有标签还写着云雾。

**真机复验**：模型选择器里四条（内核自带 DeepSeek 两条 + 我们 OpenLux 两条）；选中
OpenLux V4-Flash 发一条，回「链路已通。」，**5.3s / 首 token 5.2s**——证明新凭据名
`OPENLUX_API_KEY` 真被解析到了。冷启动分段采样 10s 到 45s，登录步稳定挂起且 `#root` 冻结。
测试 297 通过 / 4 失败，与上游基线一致。

> **改名时被 PowerShell 坑了一次，记下来。** 用 `Get-Content -Raw` + `Set-Content -Encoding UTF8`
> 批量替换，PS 5.1 会按 ANSI 码页读 UTF-8 文件、再写回 UTF-8 并加 BOM：八个文件全带上 BOM
> （`JSON.parse` 直接失败），含中文的两个还多了一层乱码。**在这个仓库里批量改文件不要走
> `Get-Content`/`Set-Content`**，用 Node 读写 Buffer，或者逐处精确替换。

##### 聚合 check 从来没绿过（2026-08-18 收掉）

`dsh/` 根目录的 `yarn check` 是上游自带的聚合闸门（布局守卫 + 三个子包各自的
构建 / 类型检查 / 单测 / 五个 verify）。**从 subtree 合入起它一次都没绿过**，三处红：

| 红的那段 | 性质 | 处置 |
|---|---|---|
| 我们的 `openlux-plugin-account` **不在链上** | 漏 | 根 `check` / `build` / `typecheck` 都串进它，且排在宿主包**之前**（宿主那段最重，我们的 8 秒，失败早暴露） |
| `check:layout` | 被 subtree 形状废掉 | 上游源码那半边条件化，见下 |
| `verify:profile` | 漏翻第三处陈旧断言 | 翻成断言更新托盘命令**不存在**，注释指向 `cordis.patch.yml` |
| 宿主 `test` 里 4 条 mac 专属 | 两条是断言不跨平台、两条真依赖 POSIX 权限位 | 前者修成跨平台断言（现在 Windows 上真跑），后者按上游先例 `it.runIf` 门控 |

**为什么必须补链，有真机证据**：我们这个包的入口是构建产物，而根 `build` 只构建宿主包。
把 `lib/` 挪走再跑宿主的 profile 冒烟，失败点从第 192 行提前到 `boot()` 本身——
`failed to import loader entry openlux-account (openlux-plugin-account): Cannot find module
'…\profiles\node_modules\openlux-plugin-account\lib\index.js'`（`ERR_MODULE_NOT_FOUND`）。
路径正是 `cordis.patch.yml` 注释描述的那条：app-boot 把宿主的依赖闭包逐个 symlink 进
`$DSH_HOME/profiles/node_modules`。**干净克隆上 `install && build && 起进程` 会起不来**，
是响的失败，但要有人跑闸门才看得见。

**`check:layout` 那两处，第二处是不报错的失败形态。** 一是删掉 submodule 后它仍要读
`deepseek-harness/package.json`、要 gitlink 是 `160000`、要那个目录 `git status` 干净——
删是对的（外壳吃 npm 上的发布版，`sourceVersion` 只是源码参考），所以这半边改成
「目录在就照原样逐条验，不在就跳过并**在输出里明说**跳过了什么」，`runtimePackageVersion`
那条钉版检查留在外面，它只要 `upstream.json`。二是它用 `git rev-parse HEAD:README.md`
核对双语记录的 blob 哈希，而 `HEAD:<path>` 是**仓库根**相对：在 `dsh/` 这个子树里，
这条路径静默命中的是**外层仓库**的 `README.md`（真解析出一个哈希，`a6457f64b6`），
于是报「README.i18n.yaml 过期」——指向一个它根本没读过的文件。改成用
`git rev-parse --show-prefix` 拼前缀，上游仓库里那是空串，同一份代码两种形状都对。

**复验**：根目录 `yarn check` **47 秒全绿**；宿主测试 `299 通过 / 2 跳过 / 0 失败`
（原先失败的两条 `mac-universal` 现在是**通过**，不是跳过）；`check:layout` 输出
「upstream 47f943859b is not checked out, so its source reference went unverified」。

**阶段 0 剩下的**：用 OpenLux 的 key 跑通一条对话；接 Windows 代码签名证书
（`scripts/package-win.ts` 支持 PFX `win_csc_link`）；出一次安装包验能装能起。

### 阶段 1 · 登录与账号（2 周）· 闸门已通过

> **2026-08-17 重写这一节。** 原文写的是「把 946 行账号代码原样搬过来」。前提变了：
> 外壳以 DSH 为主，老壳只作参考，所以这一阶段不是搬运而是**照内核给的面重设计**。
> 下面「闸门已验」那部分（配置层的真机结论）仍然有效，保留原文。

#### 重设计：登录是内核引导队列里的一步，不是我们自己的全屏门

查了 `client/ui-settings/src/client/contract/slots.ts` 与
`client/ui-settings-models/README.zh.md`（这两份是本节全部结论的出处）：

| 内核已经有的 | 出处 | 对我们的意义 |
|---|---|---|
| 有序首启引导队列 `settings.onboarding`，**外壳一次只挂一步** | `contract/slots.ts:63-73` | 登录注册成其中一步，排在内核凭据步之前 |
| 注册方自持 readiness、文案、弹窗外壳，自己决定何时 `complete()` | 同上 | 「没登录就不放行」是槽位本来的语义，不用另造门禁 |
| 内核那步凭据**自判该不该出现**：「只要用户已经能触达任何一个提供方，它就直接完成而不渲染」 | `ui-settings-models/README.zh.md:11` | 我们写完凭据它自动消失，**不需要压制** |
| `OnboardingSurface` / `Modal` / `Button` / `Input` / `StateDot` 均已导出 | `ui-primitives/src/index.ts:18-20` | 这一步能用内核原件搭，长得跟原生一致 |
| 模型页收密钥：只问密钥不问变量名，存进 profile 的引用；profile 无引用则派生 `<ROUTE>_API_KEY` | `README.zh.md:7` | **凭据名是内核约定，不是口味**：路由 id 是 `openlux` → 必须叫 `OPENLUX_API_KEY` |
| 删除一行**仅当**引用等于该派生目标时才清凭据 | `README.zh.md:34` | 名字对不上，用户从模型页删账号就删不干净 |

**所以登录的落点是**：一个客户端插件把登录注册进 `settings.onboarding`（order 在内核凭据步之前），
登录成功后 `credentials.set('OPENLUX_API_KEY', sk)` 再 `complete()`。至此内核凭据步自行完成，
模型选择器里的 OpenLux 路由拿到密钥即可用——baseURL 早已烤在组合基座里（见「中转分片错位」一节）。

原计划里「新写把 `sk-` 与 baseUrl 落进 dsh 配置的那一层」**缩成一次 `credentials.set`**。

#### 承重墙已验（2026-08-17 真机，验完即撤，`git status` 干净）

上面整节都压在两句读来的话上：「注册进队列就能拦」和「写完凭据内核那步自己消失」。
读来的只是假设，动手前各验了一次。

**内核凭据步的自消语义（不写一行代码就能验）**：把 `.credentials.yaml` 移走重启——
弹出「添加一个 API Key 开始使用」，两个按钮「稍后配置 / 保存并继续」，**且 `#root` 带 `inert`**，
即它是真拦不是提示；凭据放回重启——**对话框 0 个、`#root` 不冻结**。它自己完成了，我们不用压制。

**我们能不能插一步**：在 `dsh-plugin-desktop` 已有的客户端半边（`src/client/index.ts`，
tsdown 按 browser 单独打成 `lib/client.js`）里注册一个 order `-50` 的探针步。四条都成立：

| 要问的 | 真机结果 |
|---|---|
| 注册生效吗 | 整屏挂上，`step id: yw-onboarding-probe · order -50` 如实渲染 |
| order 真落位吗 | 落在内核 `welcome-notice`(-100) 与 `deepseek-official`(0) 之间 |
| 能拦住应用吗 | `OnboardingSurface` 在自己挂载期间把 `#root` 置 `inert`，卸载即还原 |
| 交棒对吗 | 点完成 → 探针消失、`#root` 解冻，**没有别的步顶上**（内核凭据步自判不渲染） |

顺带钉死三件实现事实：`ui-primitives` 的 `Button` 直接可用且长得就是原生样式；组件在
「还没想好」时返回 `null` 就既不画也不拦（这是 `OnboardingSurface` 头注释写明的契约）；
运行期要用到的模块得进 `package.json` 的 `dsh.client.inject`，那是模块加载序，
和导出的 `inject`（cordis 服务）是两回事，别混。

#### 插件住哪：自建包 `openlux-plugin-account`，骨架已通真机

探针借的是上游的 `dsh-plugin-desktop`。业务代码不该住在那里——`git subtree pull` 会变脏，
`brand.ts` 那次收口正是为了躲这个。定为自建包，代价是先答清「它怎么被 profile 解析到」。

**答案在内核源码里，不用猜**（`boot/app-boot/src/profile.ts:223` `healProfilesModuleFallback`）：
启动时 BFS 遍历**桌面包清单的 dependencies + peerDependencies 闭包**，给每个包在
`$DSH_HOME/profiles/node_modules` 放一条扁平符号链接；Node 从任何 profile 往上走都能找到它。
配套的 `verify-runtime-closure` 守的就是这条闭包的完整性。所以规则一句话：**挂进
`dsh-plugin-desktop` 的 dependencies，就能被裸名解析。** 客户端半边同理——`modules` 插件
「扫描 Loader 条目里声明了 `dsh.client` 的包」并按包名服务 `/plugins/<id>/client.js`，
机制对 out-of-tree 的包一视同仁。

**真机复验（一次重启看四件事）**：

| 要问的 | 结果 |
|---|---|
| 闭包投影认不认我们的包 | `profiles/node_modules/openlux-plugin-account` 链接已生成，指向工作区目录 |
| 客户端 bundle 送不送 | 启动图第 40 项：`/plugins/openlux-plugin-account/client.js`（rev 每次构建都变，别记死） |
| 槽位注册生效吗 | 「登录 OpenLux」整屏挂起，`#root` 被冻结 |
| 交棒对吗 | 点过之后步消失、应用解冻、无人顶上 |

`dsh-plugin-desktop` 测试 **297 通过 / 4 失败**，那 4 条是 Windows 上跑 macOS DMG 与
universal 那组的既有失败，与上游基线一致；`profile.spec.ts` 没被组合新增撞到。

**上游两条守卫按老规矩翻成我们的意图，不是关掉**（`scripts/verify-layout.mjs`）：
工作区清单从三项改成四项（仍然写死，不改成「至少包含」——进了工作区就等于进了桌面包的
依赖闭包，也就等于进了 profile 的可解析范围，这件事必须显式）；`workspace:` 的全面禁令
收窄成「`@deepseek-ai/*` 不得用本地范围」。那条禁令守的是 DSH 边界：内核只能以固定版本的
已发布包进来，不能活链进 submodule。上游写成一刀切是因为当时每个工作区包都是它自己的；
我们的不是。改完单独验过判据：我们的包放行，反例（给某个 `@deepseek-ai` 包写 `workspace:^`）
照样被抓。

**顺带查实两件工程事实。** 一是 `check:layout` 在我们这个 fork 里**本来就是空转的**——
它第 19 行要读 `dsh/deepseek-harness/package.json`，而 subtree 合并没带子模块，所以自打并进来
就没跑通过；这不是本次改动造成的，但意味着它的上游锁定那半边目前不提供任何保护。二是新包
开了 `skipLibCheck`：内核客户端包是在它自己的 pnpm 工作区里做类型检查的，那里每个传递类型
依赖都解析得到；到我们这儿它们是发布出来的 tarball，`.d.ts` 会引用这个叶子包从不 import 的东西
（`dsh-api-remotes` 的类型伸手要 `dsh-cordis-host-runner`，`ui-primitives` 的 Markdown 类型
import 了 katex 的样式表）。试过把它们逐个声明上：警告从 7 涨到 21 再涨到 30，是发散的。
`skipLibCheck` 只跳过 `.d.ts` 内部的检查，不影响我们自己的源码被完整检查。

#### 浏览器怎么调宿主：自建 RPC 通道，不走 Typert（2026-08-17 验通）

登录、图形验证码、余额三个接口都不带 CORS 头，浏览器直接 fetch 会被挡，所以这三件事必须落在
host 半边，browser 半边得能调过去。

**内核的标准答案是 Typert Remote**：host 侧 `class X extends TypertRemoteService` + 方法上打
`@Remote`，browser 侧 `ctx.remote.<ns>.<method>()`。查下来这条路我们走不了，卡在两处，
**都是先验后判、不是猜的**：

| 卡点 | 出处 | 实测 |
|---|---|---|
| browser 侧挂载前强制每个入参与返回值都有 codegen 出的 strict codec | `api/gateway/src/client/index.ts:549-564`；README:39 明说 SRC 标记在客户端面无 codec | SRC 回退产出的全是 `mode:'src-json'`（`gateway/src/index.ts:300,306,355`），必然抛 |
| strict codec 只能由内核的 typert 生成器产出，种子是内核仓自己的 `tsconfig.host.json` | `typert/generator/README.md:19-21` | 我们的包在 `dsh/` 独立 workspace，进不了那条流水线 |

绕过 browser 面直接打底层 `rpc.call('/api', 'ns/method', {args})` 也试过，**在编译这一关就先死了**：
`@Remote` 是 TC39 标准装饰器，V8 至今没实现，得靠构建期降级成 `__esDecorate`。内核自己走 `tsc`
所以自动降级（对照它的产物：`dsh-message-feedback/lib/index.js` 里 `list(request)` 前面干干净净，
文件顶部有 `__esDecorate` 辅助）；我们走 tsdown（rolldown/oxc），**`@Remote("ping")` 原样留在产物里**，
Node 直接 `SyntaxError: Invalid or unexpected token`。把 target 从 es2024 降到 es2022 也不触发转换。

**所以改用内核给插件预留的另一个口子**：`ctx.connection.rpc.handle('/openlux', handler, { authority: 'loopback' })`。
它自己注册 webserver 前缀路由、校验请求信封、按 authority 拒非回环来源（`client/connection/src/rpc-host.ts:90-115`），
注册走的是调用方 fiber 的 `effect`，随插件一起销毁。`/api` 是保留字，自建通道必须另起名
（`:220-224`）。这条路没有装饰器、没有 codegen、不靠解析函数源码取形参名，比 Typert 少三层假设。

**它不是野路子**：内核自己的契约测试把 `rpc.handle` 的成功、403、方法不匹配、处理器抛错四条路径
全测了（`client/connection/tests/node-half.host.spec.ts:227-418`）。代价是没有生成的类型投影——
但那本来就拿不到，Typert 在我们这儿不提供任何我们能用的东西。

**一条硬约束要记住**：`RpcErrorDetailsMap` 是内核里的闭合联合（`host/apiproxy/src/api/rpc.ts:32-110`），
仓外加不了新错误码。所以**业务失败不能走 error 分支**，得跟内核自己的服务一样，从 `ok:true` 里带
自己的判别式返回（`message-feedback/src/index.ts:190-196` 是范本）；error 分支只留给真正的意外。
验证码错、密码错、账号锁定这些将来都走前者。

顺带两条同源事实：**超时内核一处都没有**（浏览器 `rpc.call` 只透传调用方 signal，
`client/connection/src/client/rpc.ts:30-38`），要自己用 `util/timeout` 的 `deadline()`；
**写凭据根本不用新增 host 方法**——`credentials.set` 早在 apiproxy 协议上
（`api/rpc-map.ts:71-73`），而且它把 `assertUnshadowed` 抛的裸 `Error` 映射成了有码的
`credential-rejected`（`api-proxy.ts:3274-3288`）。只有**读回**凭据明文是故意不上协议的
（`api/credentials.ts:3-7`）。

**真机复验**：登录步里那行显示「宿主应答 AMBER-4471，回声「来自登录步」，凭据服务在」——
一次调用同时证明了通道通、payload 过河完整、host 侧 `ctx.credentials` 在场。
测试 297 通过 / 4 失败，与上游基线一致。

#### host 侧账号能力：不是搬，是重判（2026-08-17 七条真机探针）

老壳那几个文件是 2026-08 写的，注释里那些「只有这一条路」的断言当时对，现在得重新对着
**当前 DSH 内核**和**当前 `new-yunwu-api` 源码**判一遍。判下来三处跟照搬的结果不一样。

**一、会话 cookie 归内核凭据库，不再自建加密文件。**
老壳用 Electron `safeStorage` 加密存盘，图两件事：cookie 出不了主进程、落盘不是明文。
这两件内核都白送——`resolve` 故意不放在浏览器那侧的凭据 API 上
（`host/apiproxy/src/api/credentials.ts` 只有 `describe`/`set`/`unset`），所以**没有一条线路
能把它带出去**；`credentials-local` 建目录 `0700`、原子替换文档 `0600`，还拒读任何他人可读的
文档（`credentials-local/src/index.ts:116,383,394`）。全仓 `safeStorage` 零命中，是内核的
有意选择：Windows 上 DPAPI 同样是用户级的，防的是文件被拷走，而那正是 `0600` 已经覆盖的。

**顺带查了 `ctx.storageDomain` 然后决定不用它。** 它是真设施（zod schema、`domain/changed`、
web-app 组合里 `storage` + `storage-json` + `storage-domain` 三个都挂着，
`bundle/web-app/cordis.patch.yml:51-62`），但本包只有一件要落盘的东西，而它是密钥；
`domain/changed` 又只是进程内事件（README 明说重连的 GUI 什么也观察不到），
换不来浏览器侧的新鲜度。**余额一个字节都不落盘**——开机就画出来的数字看着是活的，
可能是昨天的，而余额恰好是用户不复核就直接据以行动的那一格。

**二、用户访问令牌看着更合适，但有副作用，封死。**
余额只有 `/api/user/self` 给得出来，而 `authHelperApply`（`middleware/auth.go:87`）在没有
会话 cookie 时**接受 Authorization 里的用户访问令牌**，且跳过 session_token 与改密作废两道校验
（`:147,234`）——比 30 天会过期的 cookie 稳。但**每个用户只有一张**：
`GenerateAccessToken`（`controller/user.go:1418`）生成新 key 直接覆盖那一列，
桌面端登录时换一张，就把用户原有的那张顶掉；而**我们自己的从站同步正是用它认证**
（`SystemTokenAuth`，`middleware/auth.go:1181`）。登录不能顺手废掉用户的同步令牌。

`sk-` 也替不了：`/api/user/self` 挂的 `UserAuthOrApiKey`，那个 "ApiKey" 是代理站的
`X-Api-Key`/`X-Api-Secret`（`auth.go:504-514`），不是中转令牌；
`/api/usage/token` 倒是认 `sk-`（`TokenAuth`），但回的是**令牌自己的额度**，
而我们建的是 `unlimited_quota` 令牌，那几个数跟账户余额没关系（`controller/token.go:145-184`）。
——所以老壳的结论是对的，但现在是验过的结论，不是继承来的。

**三、请求语言归内核管。** 控制台按 `Accept-Language` 逐请求选语言
（`middleware/i18n.go:23-39`），我们一条都没带，于是中文界面上原样引了一句
`Please complete the CAPTCHA verification first`——真机打出来的，不是设想。
语言在内核里有主：`client-locale` 在 host 侧注册了 `locale` 设置命名空间
（`preference: 'zh' | 'en'`），`ctx.settings.get('locale')` 就能读。
头在 `requestJson` 里统一加，不放调用点——放调用点迟早有一个漏掉。

**真机复验（`/openlux` 通道，七条）**：

| 端点 | 结果 | 证明了什么 |
|---|---|---|
| `status` | `signedIn:false, apiKeyConfigured:true` | 凭据 `describe` 通；两件事分开判 |
| `captcha.config` | `enabled:true, type:click-shape` 1.3s | 站点**确实开着**人机验证，登录必须先过它 |
| `captcha.challenge` | 76KB 图 + 3.3KB 缩略，0.35s | 真题解出来了 |
| `balance`（未登录） | `expired`「登录后即可查看余额」 | 四档降级的入口档，不打网络、不显示 0 |
| `sign-in`（错密码） | `ok:true` + `kind:'rejected'`「请先完成人机验证」`needCaptcha:true` | 业务失败走判别式而非 error 分支；**中文**（语言修复前是英文） |
| 不存在的方法 | `ok:false, code:'bad-request'` | error 分支只留给真意外 |
| `captcha.verify`（答错） | `passed:false` | 判错是普通结果，不是异常 |

一条要记住的时序：控制台**先查人机验证再查密码**，所以登录表单不能等密码错了才弹验证码。

#### 登录步的界面：内核给什么用什么，剩下的才是我们的（2026-08-17 真机）

**先补了 host 那半一个漏子。** `rpc.handle` 的 handler 一旦抛异常，上游只会回一个
纯文本 500（`client/connection/src/rpc-host.ts:183-185`），控制台自己的报错文案在路上就没了——
而 `fetchCaptcha` / `fetchCaptchaConfig` 恰恰是靠抛来报错的。现在整个分发包在一层 try 里，
真意外折进 error 分支并把原文带过去；业务判别式（`rejected` / `passed:false`）照旧走成功分支。

**样式不用 CSS module，是查出来的，不是图省事。** 内核 UI 包里 `import css from './X.module.css'`
那套哈希类名来自编译 `src` 的打包管线，`ui-primitives/tsdown.config.ts:3-10` 写得很直白：
它自己的 lib 构建**把 CSS 打成空模块**，因为「哈希类名只在 bundler 上下文里有意义」。
我们这个仓外包走的是自己的 tsdown，没有那层转换。模块加载器倒是**期望**插件在工厂闭包里
自己注入 `<style>` 并会认领它（`client/modules/src/client/system.ts:41-48`），但那要先有
一个 CSS 插件把样式变成字符串——为了几十行布局引一套构建机制不划算。所以：**凡是有交互的
一律用内核原子**（`Button` / `Input` / `OnboardingSurface`），我们只剩布局，用内联样式，
颜色全部走 `--dsw-alias-*` 变量，主题跟着内核走。

**纵向节奏归步骤自己。** `OnboardingSurface` 的舞台是 `display:flex; justify-content:center`，
**没有 `align-items`**（默认拉伸），注释里说得明白：这一步「拥有完整工作区」。内核里没有
第二个步骤用过它，所以居中是我们自己给的一行 `justifyContent: 'center'`，不是抄来的。

**验证码三族的坐标口径原样继承老壳**，那套是对着同一个后端在生产里跑过的：题面按 1:1 画，
点选交 `x1,y1;x2,y2`（图坐标），滑块交 `x,tileY`，旋转交 `angle`。五种题型都问了一遍
控制台，坐标数学要的字段全在：

| 题型 | 真机返回 | 渲染要的量 |
|---|---|---|
| `click-text` / `click-shape` | 300x220 + 150x40 缩略 | 提示条 + 点击点 |
| `slide-basic` | 300x220，`tile 42x42@y=87` | travel = 300−42，答案 y 取 87 |
| `slide-region` | 300x220，`tile 60x60@y=41` | 同上，换一组数 |
| `rotate` | **220x220 方图**，`thumbSize 150` | 圆形舞台 + 150px 中心盘 |

站点当前只发 `click-shape`，另外四种的渲染没在真机上点过——但输入参数是真的，数学是搬的。

**真机五步（CDP 驱动，截图存 `.tmp-probe/signin-0*.png`）**：

| 步 | 结果 |
|---|---|
| 缺 `OPENLUX_API_KEY` 时开机 | 登录步画出来，`#root` 被冻住，无对话框 |
| 填账号密码点登录 | 直接出验证码（不是密码错了才弹），题面 `naturalWidth` 300 = 声明宽度，**没有缩放错位** |
| 图上点三下 | 三个序号标记精确落在点击处 |
| 点确认（故意答错） | 判掉、显示「验证未通过，请重试」、**自动换新题**（图 88135 → 71455 字节） |
| 点两次「稍后」 | 我们这步消失、`#root` 解冻、队列交给内核那步，工作区可用 |
| 放回 `OPENLUX_API_KEY` 重启 | `apiKeyConfigured:true` → 这步**一个像素都不画**，直接进工作区 |

最后一条是这一步的承重设计：**该不该出现由步骤自己判**，判据是 host 侧问凭据库——
所以从环境变量来的、在模型页手填的密钥同样算数，登录步没资格拦一个已经把密钥给了内核的人。
七条 host 探针在 try/catch 重构后全数复通。

**真账号登录已通（用户自己点的，`yw_zhoucongjie` / `userId 745453`）**：

| 落点 | 实际结果 |
|---|---|
| 会话 cookie | JSON 存进凭据库 `OPENLUX_SESSION`（586 字符），无明文文件 |
| `sk-` 密钥 | 写进 `OPENLUX_API_KEY`，且**复用了账号下已有的那把**，没新建重复令牌——`findReusableKey` 按预期生效 |
| 余额 | `status:'ok'`，`$84.70` / 已用 `$15.34` / 1763 次；quota 42351874 按 `/500000` 换算正确 |

**顺带暴露一件事：登录只有首次启动队列这一个入口。** 有密钥就自消，登进去之后
就再也回不到那一页。侧栏账号行（阶段 1C）不是锦上添花，它是**唯一的重入口**——
登出在那儿，登出后要能回到登录页。

#### 侧栏账号行：一行余额，一块面板，一个重入口（2026-08-17 真机）

**先纠正一个我们以为的事实：内核的引导队列不是「首次启动」队列。**
协调器的判据是**当前会话是不是空白**，而且每次这件事从真变假，它就把「已完成」集合清空
（`ui-settings-general/src/client/SettingsRoot.tsx:122-133`）：

```ts
const onboardingActive = useSessions(state =>
  state.phase === 'ready'
  && (state.current === undefined || state.byId[state.current]?.blank === true))
useEffect(() => { if (onboardingActive) return; setCompletedOnboarding(new Set()) }, [onboardingActive])
```

好处是白送的：用户登出、开一个真会话、再回到空白页，登录步会**自己**回来。
**缺口也是确定的**：人就杵在空白 Hero 上登出时，`onboardingActive` 一直是 true，
那个清空永远不触发，我们这步不会回来。所以登出的重入口必须自己给——
表单抽成 `SignInForm`，引导步和侧栏各挂一次，侧栏点「登录」顶的是**同一块全屏页**。
不在工作台里弹密码框：旧壳那条注释点得很准，应用内突然要密码反而像钓鱼。

**形状照内核自己的 footer action 做**（`ui-cordis` 的 CordisPanel）：徽章按钮，宽栏
「图标 + 文字」、56px 轨道只剩图标，点开一块 `position: fixed` 面板——面板必须是 fixed 且
按触发器测量定位，因为侧栏自己是裁剪溢出的。外部点击关闭那五行是抄它的逻辑但内联了，原因见下。

**四档余额沿用旧壳（旧壳又是照 WorkBuddy 的 credits 区）**：`ok` 出数字、`stale` 出数字
加「缓存」徽章、`expired` 换成「重新登录」、`unavailable` 出「获取失败」。
存在的理由是取数失败和余额花光**渲染出来一模一样**，而这两种读法里用户会当真去行动的
那个（「我的钱没了」）恰好是错的那个。

**踩到一个必须记住的差别：`deepseek-harness/` 源码树是 rc.7，我们锁的依赖是 rc.6。**
照源码写的 `useDismissOnOutsidePointer` 在装着的包里根本没导出，构建当场报
`TS2305`。逐个核对之后：`sidebar.footer.action` 槽、`settings.onboarding` 槽、
`bindSnapshotSelector`、那三个图标 rc.6 全都有，**只有那个钩子是 rc.7 才加的**——
为一个五行的辅助函数把整套依赖往前拖不划算，就地内联并注明出处。
**从此读内核源码时要多问一句：这个 API 在 rc.6 里有吗。**

**真机六步**：

| 步 | 结果 |
|---|---|
| 宽栏 | 行挂在 footer 区，人像图标 + `$84.70` |
| 点开面板 | `yw_zhoucongjie` / 余额 `$84.70` / 累计已用 `$15.34` / 用户分组 `default` / 退出登录，274×169 锚在触发器上方 |
| 收起侧栏 | 只剩 18px 图标，与内核自己的轨道控件同列；展开后恢复 `$84.70` |
| 退出登录 | 行变「未登录」，会话 / 密钥 / 缓存一起清 |
| 面板里点「登录」 | 同一块全屏登录页顶上来，`#root` 被冻住 |
| 放回会话重启 | 行恢复 `$84.70`，登录步照旧自消 |

宽栏下不挂 Tooltip：图标旁边已经把那个数印出来了，悬浮再重复一遍是噪音。

#### 空家复验：不带任何既有状态从零走一遍（2026-08-17）

前面所有真机验证都跑在同一个用了几天的 `DSH_HOME` 上，那里面攒了四样东西是新用户不会有的：
欢迎提示的已读版本号、`llm-deepseek.baseURL`、`locale: zh`、默认模型
`openlux / deepseek-v4-flash`。所以另起一个空目录重跑：

| 查什么 | 结果 |
|---|---|
| 首屏是不是登录页 | 是。`#root` 冻住，标题「登录 OpenLux」，侧栏那行已经是「未登录」 |
| 环境里的 `YUNWU_API_KEY` 会不会遮蔽 | **不会**。凭据名改成 `OPENLUX_API_KEY` 之后它就不相干了 |
| 点「稍后」之后交给谁 | 内核自己的凭据步（「保存并继续 / 稍后配置」），顺序对 |
| 没有 `settings.yaml` 还有没有出厂路由 | **有**。模型页照样列出 OpenLux 提供方与 v4-flash / v4-pro——它来自组合层 `cordis.patch.yml`，不是用户态 |

**顺带纠正一条早先的误判**：之前登录页没出现，我一度归咎于环境变量 `YUNWU_API_KEY` 遮蔽凭据。
空家实测证否——真实原因就是当时用户已经登录了，凭据库里有 `OPENLUX_API_KEY`。

##### 抓到一个真缺陷：新装机第一条消息必然失败

真账号在空家登录后（`sk-` 又复用了同一把，没新建重复令牌；侧栏立刻亮成 `$84.70`，
不用重启），发第一条消息直接报：

```
provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service
MISSING_CREDENTIAL
```

**默认模型落在内核自带的 `deepseek-official` 上。** 基础组合包写死
`provider: deepseek-official`（`bundle/base/cordis.patch.yml:63-67`），
而拿 OpenLux 账号登录的人永远不会有 `DEEPSEEK_API_KEY`。旧家之所以一直没暴露，
是因为它的 `settings.yaml` 攒了一行 `agent-default-model: provider openlux`——纯用户态。
更阴的是模型选择器当时显示「DeepSeek-V4-Flash」，看着像配好了。

修法和当初压 `llm-pi-ai` 同一招：组合层按 id 覆盖那一行。它是
`agent-default-model` 装进设置系统的 base 层，所以用户改选别的模型照样能盖过去，
动的只是出厂地板：

```yml
- id: agent-default-model
  config:
    provider: openlux
    model: deepseek-v4-flash
```

改完复验：选择器变成 **OpenLux V4-Flash**，同一条消息 7 秒回「空家已通。」，首 token 7.9s。

**教训是流程性的**：所有真机验证都跑在同一个用了几天的 home 上时，用户层会把出厂层的
窟窿盖住。凡是「新用户第一次打开」的判断，必须在空 `DSH_HOME` 上重跑一遍。

#### 老代码重新判定：活下来的比原先估的少

| 老代码 | 行数 | 命运 | 理由 |
|---|---|---|---|
| `yunwu-auth.ts`（登录 + 换 `sk-`） | 246 | **活，几乎原样** | 纯 fetch，内核不做账号，没有对应物 |
| `yunwu-captcha.ts` + `Captcha.tsx`（go-captcha 五模式） | 157 + 323 | **活，换宿主**（已完） | 内核没有人机验证；已从 renderer 组件变成引导步里的一段，坐标口径原样继承，样式换成内核原子 + 内联布局 |
| `yunwu-account.ts`（余额四档降级） | 254 | **活** | 挂进侧栏槽位 |
| `account-session.ts` + `secret-box.ts` | 87 + 47 | **死**（2026-08-17 改判） | 会话 cookie 改存内核凭据库，两个手工搭的性质都白送：`resolve` 故意不上协议 → cookie 结构上出不了 host；`0700` 目录 + `0600` 文档且拒读他人可读的文件 → 不必再引 `safeStorage`。按 `userId + baseUrl` 记账的部分作为 JSON 存进那一格 |
| `yunwu-client.ts`（`/v1/models` 校验令牌） | 50 | **活** | 登录时确认令牌真能调 |
| `Activate.tsx` 的四步编排 | 513 | **大部分死** | 内核的引导队列接管排序与弹窗；只剩登录表单本身 |
| `store.ts` / `activation.json` | 106 | **死** | 三样东西各归各位：凭据进凭据库、baseURL 进组合基座、模型选择进 settings，不再攒一个大 JSON（顺带解决老壳「渲染进程内存里有明文 `sk-`」那个问题） |
| `ModelPicker` + `MediaPicker` | 920 | **死（待阶段 2 确认）** | 模型页已能编辑路由的模型列表并做端点询问（`llm.discoverModels`） |
| `config-writer.ts` + `gateway-client.ts` | 3,273 | **死** | 写的每个键都是 openclaw schema；其中约 630 行是为绕开 openclaw 写入语义而存在的（体积骤降保护、渲染队列分槽、baseHash 快照、脱敏还原），dsh 这边没有这些概念 |

#### 这一阶段要自己验的三条

1. **环境变量会遮蔽凭据写入，而且是硬失败。** `credentials-local/src/index.ts:410` 的
   `assertUnshadowed`：继承的环境变量排在文件层之上，被它遮蔽的写入直接抛错而不是静默无效。
   用户机器上凑巧有 `OPENLUX_API_KEY` 就登录写不进去——要给一条能读懂的话，不能吐原始错误。
2. **登录成功不能被配置写入失败拖垮。** 老壳的 `writeOpenClawConfig` 刻意不把失败上抛成登录失败
   （`config-writer.ts:1029-1038` 记着那次「换账号时配置整批被拒、用户卡在登录页反复重试」的事故）。
   新壳里 `credentials.set` 失败要走同一条纪律：登录态先落，配置失败单独提示。
3. **登出要清干净。** 老壳登出漏了 `providers.json` 与 `openclaw.json` 里的 `apiKey`，
   换账号后旧令牌还在盘上。新壳只有一个落点（凭据库），顺手把这条补上。

**闸门已验（2026-08-17，本机 Windows + node 24.12.0 + vitest 4.1.8）。**
先跑内核自己那套 `packages/settings` 测试：**151 通过 / 2 跳过**；再按我们
`config-writer` 的真实形状（三个 namespace：供货商带密钥 / 账号 / 媒体三档）写了六条探针，
全过，验完已删、`git status` 干净、临时目录零残留、本机真 `settings.yaml` 未被动过。

| 我们要问的 | 真机结果 |
|---|---|
| 并发批量写会不会互相覆盖 | 三个 namespace 并发 `update`、**都不带** `expectedRevision`，一段都不丢，**36ms** |
| 用户手改夹在飞行中会不会被吃掉 | 注释、我们没注册的 `locale` 段、我们的新值三样同时存活（写入在锁内先 `reconcileFromDisk` 折进盘上状态） |
| 盘上文档坏掉时 | 写入 **loud 失败**，原文一字未动（刻意不覆盖用户手改）；而热重载路径相反——warn + 保留 last good，绝不让进程下去 |
| 脱敏视图回写会不会误删密钥 | `describe({redactSecrets:true})` 里搜不到密钥、`secrets` 枚举出 `apiKey` 槽位；按 path op `mutate` 之后密钥仍在盘上 |
| 冲突检测 | 陈旧 `expectedRevision` 被拒，赢家留在原位 |
| 孤儿锁 | **2173ms** 后失败 |

**配置层的形状（`packages/settings`，与 openclaw 完全不是一个路子）**：一份
`settings.yaml`，按 namespace 分段；写入走跨进程文件锁 `<file>.lock` + 锁内读改写 +
叶级 diff（保留注释、锚点、格式）+ 原子 rename 落盘。解析顺序是
schema 默认 → 注册方的 composition `base`（来自 `cordis.yml`）→ 用户段。
三个写入 API 各有分工：`update` 稀疏合并、`replace` 整段替换（这是删除/重置路径）、
`mutate` 路径寻址（`set` / `unset`）。

**四条要落进代码的纪律**：

1. **持有脱敏视图的调用方只能用 `mutate`，绝不能用 `replace`。** 子系统文档原话：
   从脱敏文档重建的整段 `replace` 会**静默删掉每一个协议层从未返回的密钥**。
   我们的模型选择器、设置页都属于这一类。
2. **孤儿锁要我们自己兜。** `withFileLock` 的超时是 2000ms（退避 20→200ms），而且
   `atomic-write/src/index.ts:81-88` 明说竞争者**永不删除**已存在的锁——文件年龄证明不了
   持有者已死，"orphan recovery is an operator action"。桌面应用崩在持锁期间，之后每次写配置
   都要等 2 秒然后失败。**内核不给这个兜底，是我们要写的代码**：启动时检测残留锁 + 按 pid
   存活判断 + 给用户一条能读懂的话。
3. **`applies: 'live' | 'restart'` 是 UI 提示，不是机制。** 没有 openclaw 那张「前缀最长匹配、
   没匹配上一律 restart」的规则表——每个 namespace 的 owner 自己声明，`restart` 的语义只是
   「它不 watch，值在构造时读一次」。所以"这条配置要不要重启"是可查的，不用猜。
4. **两个事件分工别搞错**：`settings/updated` 是消费者面向的，**deep-equal 门控**（值没变不发）；
   `settings/document-updated` 是给配置界面的，raw 用户段变了就发——界面要知道「某字段从继承
   变成了覆盖」（resolved 值相同但含义不同）以及「我手上的 revision 过期了」。

**还有个白捡的旋钮**：注册时可给 `validate`，用来拒掉 schema 表达不了的跨字段约束，
抛错会**拒掉产生该值的那次写入**，而不是存进去然后静默禁用 owner。`dsh-llm-pi-ai` 就用它
拒绝一个它服务不了的供货商 profile——正是我们写供货商配置要的东西。

- **复验判据**：登录 → 换 `sk-` → 落配置 → 发第一条消息全程走通；
  余额四档降级逐档能复现；会话过期回登录页且用户名已回填。
- **保留的取舍**：首屏判据仍用本地 `hasStoredSession()`，不放网络往返
  （这条在 openclaw 上把首屏从 1303ms 降到 114ms，与内核无关，直接继承）。
- **一处 Windows 缺口**：`concurrency.spec.ts:89` 那条「非竞争性锁失败」用
  `it.skipIf(process.platform === 'win32')` 跳过了——他们自己知道 Windows 上
  chmod 那套不成立。我们是 Windows 产品，这块没有上游测试覆盖，要自己补。

### 阶段 2 · 模型（2 周）

~~搬 `model-catalog.ts` + `model-capabilities.ts`（1,429 行判据），重写配置写入的键映射，
模型选择器决定是复用 `dsh-client-ui-settings-models` 还是保留我们的。~~
**这段计划 2026-08-17 作废**，理由见下面「能力判据不用我们再养」一节：
内核自带一份逐模型实测的能力库，那 1,429 行和它配套的服务端下发通道都不必搬。

#### 闸门已通过（2026-08-17）：dsh 怎么表达思考档位

落点是 `llm-pi-ai` 的目录层（`packages/llm/llm-pi-ai/src/catalog.ts`）。
**结论：能一对一表达我们全部四个维度，而且比我们现在的形状更直白。**
真机跑了 8 项自写探针 + 内核 `catalog.spec.ts` 52 项，共 60 项全绿（探针已删）。

**这条闸门顺带把适配器选型也定了**：思考档位落在 `llm-pi-ai` 的目录层，
运行时就该走 `llm-pi-ai` 的路由，两件事本来是一件事。后来「中转分片错位」那一节
独立地又指向同一个结论（它对坏分片结构免疫），并已在真机上验过。
阶段 2 因此不必再纠结「复用还是自留模型选择器」的适配器前提——路由已经跑起来了，
剩下的是把 1,429 行判据翻成 `models[] + compat` 而已。

| 我们现在怎么表达 | dsh 怎么表达 | 真机验到 |
|---|---|---|
| `thinkingLevels: ['low','medium','high']` + `defaultThinkingLevel` | `reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' }`——**键是档位，值是该档下发的 wire 拼写** | `deepseek-v4-flash` 得到 `{minimal:null, low:'low', medium:'medium', high:'high', xhigh:null, max:null}` |
| `canDisableThinking: false` + 配置层写 `thinkingLevelMap.off = null` | **`off` 不进字典就是不提供**（内核测试标题原话：*leaving off out makes thinking mandatory*） | `gemini-3-pro` 未声明 `off` → 落地 `off: null` |
| `thinkingEffort: false`（上游不收 `reasoning_effort`） | `compat.supportsReasoningEffort: false`，**可按 route 设默认、按 model 覆盖** | `glm-4.5` 那条 400 的模型单独设成 false，成功 |
| `thinkingFormat`（七种方言，逐模型给） | `compat.thinkingFormat`，同样按 route 默认 + model 覆盖 | 见下一行 |
| **同一族两种方言**（`glm-4.5` 走 `enable_thinking:false`，`glm-5` 走 `thinking:{type:disabled}`）——我们「不能按族推」的最硬证据 | 两条模型各自 `compat.thinkingFormat` | `glm-4.5` → `qwen`，`glm-5` → `deepseek`，同一路由内并存 |
| 中转站服不了某个模型的思考 | `reasoningEfforts: false` 直接声明成不思考的模型 | `qwen3-vl-32b-instruct` → `reasoning: false` |

四条关键差异，都是往好的方向：

1. **档位取值域是超集。** dsh 七档 `off / minimal / low / medium / high / xhigh / max`
   （`catalog.ts:69-77`），我们现在放开的只有 `low/medium/high` 三档公约数。
   而且那张表是用 `Record<ModelThinkingLevel, true>` 全枚举写的，注释说明意图是
   **编译期漂移闸门**：上游加减档位会在这里编译失败并点名，而不是静默收窄。
   我们那份 `THINKING_FORMATS` 是运行时校验，弱一档。
2. **「方言」这个间接层在档位这一侧被取消了。** 我们现在要说「这个模型用 qwen 方言」，
   由内核去查那种方言的 effort 该怎么拼；dsh 直接让我们写下发的字符串。方言开关
   （`compat.thinkingFormat`）仍然保留且必要——因为它管的是**关思考要下发哪个字段**
   （`enable_thinking:false` 对 `thinking:{type:disabled}`），不是 effort 的拼写。
3. **内核替我们抹平了底层的不对称默认。** `catalog.ts:298-310` 写着：pi-ai 自己对五个基础档
   缺键当"支持"、对 `xhigh`/`max` 缺键当"不支持"，所以 dsh 在配置层把**所有**档位显式钉一遍，
   理由原话是 *a profile author should not need to know that*。真机验到：只声明
   `{off: null, high: 'high'}` 的模型，落地是六个档位全部显式决定。
   **这正是我们在 openclaw 上被咬的那类不对称**（方言写成 `openai` 会双重打击：
   wrapper 不挂 + 额外触发删 `thinking` 字段的清理器）。
4. **失手一律 loud。** 空字典、非 `off` 档位缺 wire 值、只有 `off` 没有思考档、空字符串 wire 值、
   给非 `openai-completions` 协议设 compat 开关、route 设了开关但没有模型讲那个协议
   ——六种都在配置解析期抛，不是运行时静默失效。

**一条已排除的风险**：dsh 刻意扣住两种方言不暴露（`chat-template` / `qwen-chat-template`，
理由是它们要走 `chatTemplateKwargs`，配置层不开这个口）。核过我们自己的
`model-capabilities.ts`：全部 `format:` 赋值只有 `qwen` 与 `deepseek` 两种，
加一个隐式默认 `openai`——**被扣住的两种我们一条都没用**，所以这条不构成迁移阻碍。

**顺带一个能力升级**：`off` 档位可以带 wire 值（内核测试 *keeps a declared off value in the
map for dispatch to send*）。所以「关思考」有两种表达：`off: null` = 不发这个参数就是不思考；
`off: '<wire>'` = 发这个特定值。我们现在只有前一种，`qwen` 族那些「关不掉」的模型
值得用后一种再试一次。
- **注意**：模型池**不缓存**是刻意决定（能不能调到取决于渠道分组与令牌路由，
  缓存住会骗人），继续保持。

#### 能力判据不用我们再养：内核自带一份，逐模型实测的（2026-08-17 五条真机）

原计划要搬 `model-capabilities.ts` 的 1,429 行家族表，外加 `model-profiles.ts` 那条
「服务端下发能力覆盖」通道。**两样都不搬了**，因为下面五件事逐条量过：

**一、内核自带 776 个模型的能力库。** `llm-pi-ai` 依赖的
`@earendil-works/pi-ai/providers/all` 里有 37 家提供方、1,109 条模型条目、去重 776 个 id，
**其中 556 条带思考声明**。一条条目长这样（`deepseek-v4-flash`）：

```
reasoning: true,  contextWindow: 1000000,  maxTokens: 384000,
compat: { thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true },
thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', max: 'max' }
```

——正是我们那 1,429 行费力算出来的四个维度，而且是**逐模型给的，不是按族猜的**。
我们被咬过的「同族两种方言」（`glm-4.5` 走 `enable_thinking` / `glm-5` 走 `thinking:{type}`）
在这里天然不成立问题：它们本来就是两条独立条目。

**二、裸 id 能继承，条件是路由键等于内置提供方名。** schema 注释原话：*an explicit list
replaces it, **each entry defaulting its unset fields from the installed model of the same id***
（`llm-pi-ai/src/config.ts:79-83`）。真机验证——路由键 `deepseek`、`models: [{ id: 'deepseek-v4-flash' }]`、
外加我们的 `baseURL` 与 `api: openai-completions`：

```
deepseek-v4-flash → name "DeepSeek V4 Flash", reasoning true,
  thinkingLevelMap {minimal:null, low:null, medium:null, high:"high", max:"max"},
  thinkingFormat "deepseek", contextWindow 1000000,
  baseUrl "https://api.openlux.ai/v1"   ← 我们的覆盖活着
```

同一份写在 `openlux` 路由上则直接抛错（`contextWindow must be a positive integer`）——
**内置目录没有这条路由，什么都继承不到**，字段得自己给全。13 家厂商路由逐条试过
强制 `openai-completions`，全部通过，方言也跟着继承（`zai` → `zai`、`moonshotai` → `deepseek`、
`qwen-token-plan` → `qwen`）。

**三、覆盖率量到了：广场 249 条对话模型里，内置目录认得 83 条（33%），
轻度归一化（剥日期后缀）后 101 条（41%）。** 缺口按家族：qwen 46、gpt 16（多是日期变体，
基名本身有）、llama 15、deepseek 14（`v3`/`r1` 这些老的）、doubao 13、grok 9、ernie 8、glm 6、qwq 5。
**认得的那 83 条恰好是用户真在用的头部**（GPT / Gemini / Claude / DeepSeek / Kimi / GLM）。

**四、价格这条风险不存在。** 内置条目带着官方厂商的 `cost`，而我们的账单走中转站自己的倍率。
但 `catalog.ts:29-30` 写着：*The harness never reads pi-ai's cost metadata — `replay.ts`
zeroes it and no consumer reports spend.* 内核既不显示也不消费花费，不会在钱上误导用户。

**五、那条服务端下发通道从来没上线过。** `admin-cloud/src/api/desktop-model-profile.ts`
有整套管理端封装（列表 / 批量导入 / 一键实测 / 灰度开关），桌面端也有 `model-profiles.ts`
消费它——但 MCP 查两个站的库，**`desktop_model_profiles` 这张表在海外站和主站都不存在**
（`information_schema` 里 `%desktop%` / `%profile%` / `%thinking%` 只捞到 `billing_profiles`
和 `corporate_payee_profiles`）。也就是说这层覆盖在生产上一天都没生效过，
我们一直靠的就是那 1,429 行家族表。

**于是阶段 2 的形状是：**

| 层 | 谁给 | 覆盖 |
|---|---|---|
| 清单（哪些模型） | 用户自己的 key：`/v1/models` ∩ 广场 `/api/pricing_new` | 249 条对话模型 |
| 能力（会不会思考 / 档位 / 方言） | **内核自带目录，同步时按 id 取** | 101 条 |
| 长尾的能力 | **不声明** = 内核的安全默认（*a hand-declared model has none and does not reason*） | 148 条 |

长尾不声明是有意的：平台库里只有 `tags` 和 `model_type`，**没有任何思考能力字段**
（`models` 表 27 列逐列看过），而 `tags` 里那个「推理」正是当年把向量模型误判成推理模型的
那个坑。判不出来就不判，比猜错强——猜错的代价我们见过，是 `glm-4.5` 收到
`reasoning_effort` 直接 400。真要给某条长尾开思考，是在组合层加一行显式声明，
不是再造一条服务端往返。

#### 写入通道已验通：宿主插件能写别人的设置段，pi-ai 免重启认账（2026-08-17 真机）

`settings.mutate(ns, [{ op: 'set', path: [...], value }])` 是路径级写入
（`settings/src/index.ts:200-227`），比 `update` 的整块合并精确——只动
`providers.openlux.models` 一个路径，兄弟键不碰。真机：宿主插件写进第三条模型后，
`settings.get('llm-pi-ai')` 立刻能读到，**组合层的 `baseURL` / `apiKeyEnv` /
`streamIdleTimeoutMs` 全部原样保留**，选择器**不重启**就列出了新模型。
`installSettingsSection` 的 `onChange` 会让 pi-ai 重注册路由（`llm-pi-ai/src/index.ts:284-298`）。

**清单只存选中的那几条，不存整池。** 老壳栽过一次并写在注释里：登录时照单全收 `/v1/models`
把配置从 30KB 推到 124KB，换账号时新配置 29KB 撞上内核的体积骤降保护被整批拒写，
人卡在登录页看 `Config write rejected`。DSH 这边没有那道保护，但形状同样不能变——
**内核的模型选择器没有搜索框**（`ui-model-selection/src/client/ModelSelect.tsx` 全文无
filter/search），它就是为一份策展好的小清单设计的。铺 249 条进去是给用户挖坑。

可选池那一半内核也已经有了：模型页的「获取模型」按钮走
`ctx.llm.registerModelDiscovery`，`discovery.ts:11-14` 原话——*Nothing here is stored:
the reply is candidate metadata the surface offers for adoption.* **现拉、不落盘**，
与老壳「可选池不缓存」同一条纪律。它打的是 `/v1/models`（481 条，不过广场那一关），
这是个已知差距，记在下面待办里。

#### 阶段 2 已落地：同步作业跑在内核自己的 effect 里（2026-08-17 真机）

三个新模块，都在 `openlux-plugin-account`：`models/pool.ts` 取可调（`/v1/models`）
∩ 广场上架（`/api/pricing_new` 的 chat 类）；`models/capabilities.ts` 按 id 从 pi-ai
装机目录取能力；`models/sync.ts` 合成一次 `settings.mutate` 写入。

**触发点是 `ctx.effect`，不是让浏览器挂载后来踢一脚。** 一开始照老壳「首屏不放网络往返」
那条教训做成了客户端调用的显式端点，联网查完文档改掉了：cordis 对「插件自己起的、
自己要收的东西」的答案就是 `ctx.effect(() => { …; return dispose })`
（`develop/cordis-tutorial/02-lifecycle-and-effects`），卸载与热重载时 disposer 自动跑，
用不着浏览器代劳。也查了 `ctx.jobs`——**那不是这个用途**：它是给 agent 看的后台作业
（有 owner、`start` 会拒绝没有 controller 服务的 owner、模型能 read/kill，
`jobs/src/index.ts:41-58`），拿它跑目录同步等于把我们的内务挂进模型的作业列表。

那条教训本身依然成立，只是换了个方式满足：**已经有清单的机器这一轮根本不碰网络**
（`sync.ts` 只在「用户从没定过清单」时才去拉池子），所以挂载时跑不产生首屏往返。
登录成功后再跑一轮——那时才有密钥可播种——同样是 detached 的。另留 `models.sync`
端点作手动刷新。

真机（`DSH_HOME` 带密钥、无 `llm-pi-ai` 段）：五个策展模型全部播种成功，能力全部来自
内核目录，**每家的方言都不一样，一行都不是我们写的**：

| 模型 | reasoningEfforts | 输入 |
| --- | --- | --- |
| `deepseek-v4-pro` / `-flash` | `off:null high:high max:max`，另带 `compat.thinkingFormat: deepseek` | text |
| `claude-opus-4-8` | `off:null xhigh:xhigh max:max` | text, image |
| `gemini-3.1-pro-preview` | `low:LOW high:HIGH`（Google 的大写枚举） | text, image |
| `gpt-5.4` | `off:none low medium high xhigh` | text, image |

界面复验：推理等级子菜单**跟着模型换**——DeepSeek 是 Off/High/Max，GPT-5.4 是
Off/Low/Medium/High/Xhigh。发一条真消息（GPT-5.4 经 `api.openlux.ai`）5 秒回
`PONDEROSA`，带 Think 块。

**归属划分**：用户拥有成员资格与标签（模型页只编辑 `id`/`name`/`contextWindow`/`maxTokens`，
保存时先展开原条目），我们拥有思考声明（`reasoningEfforts` / `compat` 全壳没有编辑器）。
同步**从不删模型**——广场打个嗝就把用户策展好的清单静默清空，这种事不可逆。

#### 顺带摘掉 `llm-deepseek`：四条 DeepSeek 里有两条是陷阱（2026-08-17 真机）

播种后选择器列出 **7 条**而不是 5 条。多出的两条不是我们的出厂路由（那两条已被数组替换
掉了），是基础包 `llm-deepseek` 行自带的 `deepseek-official` 路由
（`bundle/base/cordis.patch.yml:450`，无 config，模型来自适配器 schema 的默认值）。

它们比「多余」更糟：普通用户没有 `DEEPSEEK_API_KEY`，点了就是 MISSING_CREDENTIAL；
而谁真给它配上并指向我们的中转，命中的正是本文上面那条分片错位——空 callId 落盘之后
**会话再也打不开**。所以在 `cordis.patch.yml` 里给它 `disabled: true`：不删行，因为行是
上游的，写成 disabled 能让合并冲突时看见我们的意图，也给自带 DeepSeek 密钥的人留了开关。
改完真机复验，选择器正好 5 条。

### 阶段 3 · 专家、技能、专家团（3 周）

这一阶段是**删得比写得多**。专家 → agent preset + `dsh-persona`；
专家团 → 一成员一个 `dsh-tool-subagent` 实例，各配 `persona` 与 `toolFilter`；
技能可见性 → `toolFilter`。删掉 `team-relay.ts`、`skill-visibility.ts`、
`before_model_resolve` 兜底、`agent-manager.ts` 的 agent 包袱。

**别把技能当成"市场装的那一种"——它有六个来源，漏一个就是一条静默失效的路**：
市场 zip、专家捆绑（装专家时一起下来）、内置引导播种（find-skills / skill-creator，
带 `_yunwu_builtin.json` 标记）、AI 现场生成、本地 zip 上传、项目级
（`<cwd>/.yunwu-desktop/skills/`，openclaw 发现不了所以靠插件注入）。
最后一条尤其要重新判断：它之所以走钩子注入，是因为 openclaw 按 agent workspace 而不是
会话 cwd 解析——**这个约束在 dsh 上未必成立，值得先验再决定要不要保留这条路**。

- **闸门已通过（2026-08-17）**：逐成员 `toolFilter` 真的能让模型只看到该角色的工具。
  跑内核自己的 `packages/core/tools/tests/scoped.spec.ts`，27 项全绿，四条比我预期的更深：
  1. **能过滤子代理从祖先 scope 继承来的工具**，不只是全局层的。测试注释描述的正是我们的形状：
     「no model-facing row in the global layer, all of them contributed by an ancestor scope
     the child joined」。
  2. **子代理自己注册的工具豁免自己的 filter**——`allow` 只列能力工具时，不会把子代理的
     汇报 / 结构化输出工具一起剥掉。
  3. **多个 restriction 求交集，各自独立 lift**（`restrict` 返回精确 disposer）。
  4. **失手一律 loud**：非 scoped 调用、空 filter、写错名字、点名 scope 自己的注册、
     点名保留的 `run_code` 传输——五种都抛，且报错列出已知工具名。
  落地点是 `subagent/src/child-agent.ts:163-174` 的 `applyChildComposition`：
  一次给子代理装上 `deployment:persona` section（order 0）+ scoped `tools.restrict(toolFilter)`。
- **复验判据**：真专家团跑一轮，四条判据（各自人设 / 继承模型 / 继承 cwd / 产出汇总）
  全过，且模型的工具名录里只有该角色的那几个。
- **一条遗留已由阶段 4 闸门顺带关掉**：后台 / continuable 模式下产出会不会重复投递
  ——`reported` 位 + first-wins settlement 从机制上去重，见阶段 4。
- ~~仍待定性的一条：并行工具调用时 `name`/`id` 流式组装丢字段（`unknown tool ""`）~~
  **已定性，而且和"并行"无关**：是中转续片发 `"name": ""` 把首片取到的工具名冲空，
  见本文档「中转分片错位」那一节（2026-08-17 查实，2026-08-19 又白查了一遍）。
  出厂把 `llm-deepseek` 整行 `disabled` 之后形状上免疫。

#### 阶段 3 闸门已通过（2026-08-18）：真专家团一轮，六条判据全过

先按规矩查了官方文档（`deepseek-harness.github.io` 的 subagent / capability-seams 两页），
再回 rc.6 的类型与组合文件核了一遍——文档站是 rc.7，两边对得上的才敢用。

**一条决定形状的事实：web-app 部署把所有面向模型的委派与技能工具都 `disabled`，改由 preset 逐行挂载。**
出处 `packages/bundle/web-app/cordis.patch.yml:321-425`，它自己的注释写得很清楚：
「What a preset chooses is which delegation TOOLS its agent sees」。所以

| 我们要的结果 | 老壳怎么做的 | 新内核原生怎么给 |
|---|---|---|
| 一条会话一个专家人设 | 插件按 sessionKey 注入 | preset 里一行 `dsh-persona`，遮蔽部署级人设 |
| 技能随专家走 | 藏起全部市场技能再按专家注入 | preset 自带 `skills/` 目录 + 自己那行 `skill-filesystem`（注册进本 preset 的层） |
| 模型只看到该角色的工具 | `disable-model-invocation` + 提示词 | preset 挂哪几行，模型就只有哪几个工具 |
| 专家团成员各自人设 | leader 自 spawn + label 路由 | 一成员一行 `dsh-tool-subagent`，各配 `toolName` / `persona` / `toolFilter` |
| 成员产出回到 leader | 自己写 `team-relay.ts` 投 `<teammate-message>` | 前台一次性委派：成员产出**就是**工具结果。后台可继续的另有内核原生 `reportFrom()` |

`persona` 与 `toolFilter` 是 **tool 实例的配置，不是模型能填的参数**
（`dsh-tool-subagent/lib/types/index.d.ts:40-55`，原文 "applied to every child"），
所以"一成员一行"不是我们的发明，是这个工具唯一的用法。

**真机跑的那一轮**（preset `yw-team`：组长 KUMO-LEAD-7 + 组员 SCRIBE-4 / AUDIT-9，
deepseek-v4-flash，1 轮 2 步 38 秒）：

1. **组长人设接管**——回答首行 `[KUMO-LEAD-7]`，且 `request/header.system` 里能看到
   部署提示词后面接着 preset 的人设正文。
2. **两个成员各自人设生效**——工具结果原文分别以 `SCRIBE-4` 和 `我的代号是 AUDIT-9` 开头。
3. **`toolFilter` 逐成员生效**——allow 那个只剩 `TOOLS=<skill>` 一件；deny 那个是全局九件
   减掉 `pwsh`/`write`/`edit`，剩六件，一件不差。
4. **产出回到组长**——前台一次性委派，成员产出直接是 `tool/result`，组长下一步就转述了。
   老壳那条 `team-relay.ts` 连同它带出来的重复投递，在这条路上根本不存在。
5. **成员继承 cwd 与谱系**——子会话头一行就是判据：
   `{"parentSession":"session-cce…","origin":"subagent","delegationDepth":1,"agentPreset":"yw-team","cwd":"…\\dsh-plugin-desktop"}`。
6. **界面自带成员入口**——会话里出现内核自己的「2 个子代理」按钮（`dsh-client-ui-subagent`），
   不用我们做。

**四条会咬人的默认行为，抄之前先处置：**

- **成员默认看得见其他成员的委派工具。** AUDIT-9 的名录里有 `delegate_writer` 和
  `delegate_auditor`——成员能互相派活，也能自己套自己（默认 `maxDepth: 3`）。
  做专家团时成员这一行必须显式 deny 掉全部 `delegate_*`，或者干脆用 allow 白名单。
- **成员默认看得见我们挂的连接器工具。** `mcp__ywprobe__ping` 就在成员名录里。
  连接器是按全局工具注册的，不过滤就会漏进每个成员。
- **`toolFilter` 写错名字是 loud 失败，而且会把已知工具名全列出来**——
  `tools.restrict() names unknown global tool "x"; known global tools: …`。
  这既是保护，也是最省事的工具名发现手段（我们这次就是这么拿到那九个名字的）。
- **系统提示词里在自报 DeepSeek Harness。** 真机 `request/header.system` 开头是
  "You are an AI agent powered by DeepSeek Harness"，后面还跟着本地 checkout 路径和
  `http://127.0.0.1:63385` 这个 GUI 地址。对外发版之前这段必须换掉，落点是
  `system-prompt` 那行的 `persona`（base 里是空串，web-app 的 patch 填的）。

**preset 免不免重启：内核免，客户端不免。** `dsh-agent-presets` 的类文档写着
「Discovery is unmemoized: `list()` and `resolve()` re-read the roots on every call」，
真机复验的结果精确到这一步：进程运行期新写的 preset，**不刷新看不到；刷新一次页面就出现，
不用重启进程**——缓存在浏览器侧的选择器里。所以专家市场装完一个专家，代价是一次页面刷新。
另外两条同源事实：改 preset 文件对**之后新建的会话**生效（每一代记文件戳，戳变了起新一代，
已经跑着的会话留在原来那一代）；`copy()` 是唯一的写入口且只能整目录复制，
市场安装只能自己往可写根目录落文件——跟我们这次探针的做法一样。

#### `ai-content-creator-team` 静态核对（2026-08-19）：机制没问题，内容还是 WorkBuddy 的

上面那一轮闸门验的是探针 preset `yw-team`（组长 + 两名组员），**验的是内核机制**。
我们真正要发的那份 `config/agent-presets/ai-content-creator-team/agent.cordis.yml`（2100+ 行、
六名成员）**没有被那一轮覆盖**。拿内核的权威工具名表逐条比了一遍，机制用得对，内容是从
WorkBuddy 搬过来没改完的。**以下全是静态比对，没跑应用。**

先说对的：六名成员用的是 `allow` 白名单（`:877` / `:1097` / `:1405` / `:1634` / `:1786` /
`:2060`），正好关掉上面记的「成员默认看得见其他成员的 `delegate_*`」那条坑；四个名字
`skill` / `read` / `write` / `edit` 都是真注册名（`dsh-tool-skill`、`dsh-tool-fs`），所以
`toolFilter` 那条 "unknown names fail startup" 不会触发，这份 preset 挂得起来；
`provider: spawn` 也确实实现了 `toolFilter`（`dsh-subagent/lib/index.js:582` 的
`childCtx.tools.restrict`），不是只有外部 provider 才有的能力。

**一、白名单列得太窄，四名成员干不了自己人设里那件事。** 白名单是全局工具名的 allow，
所以没列进去的一律看不见：

| 成员 | 人设要它做的 | 需要的全局工具 | 白名单里 |
|---|---|---|---|
| `image-creator` | 出图，提示词还点名 HY-Image-V3.0 | `image_generate`（`openlux-plugin-account/src/media/name.ts:15`） | 无 |
| `video-generator` | 出片、图生视频、Fallback 链路 | `video_generate`（同上 `:25`） | 无 |
| `video-editor` | 剪辑、滤镜叠加、`uploadAndGetVid` | 至少 `bash`/`pwsh`；那套上传 API 在 DSH 里没有对应工具 | 无 |
| `content-adapter` | 明写「本地文件预处理使用 Bash 工具链（ffmpeg/ffprobe/whisper）」 | `bash`（非 win32）/ `pwsh`（win32，注册名就是 `pwsh`） | 无 |
| `creative-strategist` / `copywriter` | 纯文本产出 | 现有四件够用 | ✓ |

**二、`SendMessage` 那条指令三重错。** 六名成员每人都被要求「完成任务后**必须通过
SendMessage 将完整结果回传给主理人**」，全文 19 处。DSH 里那个工具真名是 `send_message`
（`dsh-tool-subagent-control`）；它不在任何成员的白名单里；而且**机制上根本不需要**——
成员是 `backgroundMode: one-shot` 的前台委派，上面那张表自己写着「成员产出**就是**工具结果」。
这是 WorkBuddy 常驻 agent 的形状，跟着提示词一起搬过来了。

**三、主理人的调度指令是 Claude Code 的 Task 形状。** `:432-439` 要求「必须在 Agent 工具的
`name` 参数中传入 Agent ID，同时 `subagent_type` 参数也传相同 ID」，还附了六个 Agent ID 的
「完整列表」。DSH 的 subagent 工具入参只有 `description` / `prompt` /（可选）`run_in_background`
（`dsh-tool-subagent/lib/index.js:142-157`），选哪个成员靠**调哪个工具名**，而
`:504-509` 其实已经把六个真名 `delegate_*` 列对了——两段自相矛盾。
多传的参数**不会报错**：`parameterSchemaSpecToJsonSchema`（`dsh-tools/lib/index.js:800-809`）
不写 `additionalProperties`，而未声明属性只在它显式为 `false` 时才被拒（`:465-466`），
所以是静默丢弃。真正的伤害在那句「否则系统会自动生成无意义名称」——界面显示名来自
`description`（schema 原文 "for display"），指示模型去管一个不存在的 `name`，
恰好放弃了唯一能管的那个字段，于是它想避免的现象照旧发生。

**四、还有一批指着不存在东西的字**：`uploadAndGetVid` ×2（WorkBuddy API，DSH 无此工具）、
`WorkBuddy` ×13（品牌残留，跟前面记的 User-Agent / persona 自报是同一类）、
`Agent 工具` ×2。

**建议的改法分三档**（都还没动手）：白名单按角色补齐能力工具（shell 那条要按平台，
`!!js process.platform === 'win32' ? 'pwsh' : 'bash'`，这份文件里已经在用 `!!js`）；
删掉 SendMessage / `name` / `subagent_type` / `uploadAndGetVid` 那些段，回归
「产出即工具结果、显示名靠 `description`」；品牌词随发布前那一遍统一扫。

**判据只能是真机**：`ctx.tools.schemas()` 是全局视角看不出成员的收窄（这坑踩过一次），
所以要在会话里让 `image-creator` 真出一张图、让 `content-adapter` 真跑一次 ffmpeg，
再看模型自报的工具名录。反过来说，**单专家那份 `content-creator` 是干净的**——
无 `toolFilter`、工具行照上游形状、零 WorkBuddy 残留。

#### 真机复验（2026-08-19 凌晨）：上一节的判据兑现了，但先纠正我自己的一个错判

> **先读这个更正（2026-08-19 04:15）：本节的测试环境是错的，凡是牵涉「我们的插件」的
> 结论一律作废，只有纯上游行为那几条还算数。** 我用 `node
> node_modules/@deepseek-ai/dsh/lib/bin.js --profile desktop` 起服务，以为 profile 一样就
> 等于出厂形状。不是：`src/profile.ts:157-160` 的 `desktopBundleList` **故意把我们自己的包
> 排除在 profile 的 bundles 之外**（`name !== DESKTOP_PACKAGE_NAME`），出厂那份
> `cordis.patch.yml` 是桌面 launcher 启动时作为 **`--patch` overlay** 挂上去的
> （`PreparedDesktopProfile.patches`；profile 自己的 `cordis.yml` 注释写着 *each bundle in
> package.json's dsh.profile.bundles, then cordis.patch.yml, then any --patch overlays*）。
> 走上游 bin 就把这一整层绕过去了。**判据不在 bundles 上**——出厂 launcher 的 bundles
> 也就是 `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']` 这两个（我们的包按设计
> 不进 bundles），差别是它额外叠的 **47 条 patch**。离线核对读数（`prepareDesktopProfile`）：
>
> | patch | 内容 |
> |---|---|
> | `patch[0]`（base 裸层）| `agent-default-model: {provider: deepseek-official}`、`llm-deepseek` 挂着、`tool-web: {fetch: false}` |
> | `patch[28]`（dsh-web-app）| `tool-web disabled: true` |
> | `patch[30]`（我们）| `web-fetch-guard`，`timeoutMs: 45000` |
> | `patch[32]`（我们）| `llm-pi-ai` 的 `openlux` 提供方（`apiKeyEnv: OPENLUX_API_KEY`、`streamIdleTimeoutMs: 90000`）|
> | `patch[33]`（我们）| **`llm-deepseek disabled: true`** |
> | `patch[34]`（我们）| **`agent-default-model: {provider: openlux}`** |
> | `patch[37]`（我们）| `tool-web disabled: false` + `{search: false, fetch: true}` |
>
> 上游 bin 一条都不叠，跑的就是 `patch[0]` 那层裸配置——`deepseek-official` 加一个挂着的
> `llm-deepseek`，`unknown tool ""` 必现；账号插件也不在，所以**连 `image_generate` /
> `video_generate` 都不存在**。
>
> **正确组装上复验过了**：`scripts/verify-profile-boot.mjs` 3.2 秒绿，它 `:173-185` 正好
> 断言 `image_generate` / `video_generate` / `web_fetch` 必须在全局工具表、`web_search`
> 必须不全局注册。所以出厂形状下「工具存在、成员被白名单挡住」这个因果是对的，
> 下面那条改生成器的结论不受这次环境错误影响。
>
> **判据要写成「bundles + patches 都对」，不是「profile 名字对」。** 想不开 Electron 又要
> 出厂组装，走 `prepareDesktopProfile()` 拿 `patches` 再用 `--patch` 传给 CLI
> （`scripts/verify-profile-boot.mjs:134` 已经是这个形状），或者干脆关掉正在跑的桌面 app
> 用真 launcher。这条并入本文档 967 行那个教训：**空 home 能暴露出厂层的窟窿，
> 错 bundles 会伪造一整套不存在的产品行为。**

**怎么跑的**：`DSH_HOME` 指到探针 home（`%TEMP%\yw-dsh-live`，含 `.credentials.yaml`
与测试期间装的 12 份 preset，**不是用户桌面 home**，见下面扫描那节的更正），`dsh --profile desktop --port 43121` 起 web 服务，浏览器驱动。
**没走 Electron 是因为 `main.ts:108` 那把 `app.requestSingleInstanceLock()`**——机器上已有
DSH Desktop 在跑，第二实例立刻 `app.quit()`。桌面 renderer 想在普通浏览器里打开要补
`?dsh-desktop-mode=compatibility`，少了它会被 loader 拒成
`invalid or missing dsh-desktop-mode null`。**但如上所述，这条路只有上游那一层。**

**先纠正错判：中途我判「专家团整个起不来」，是错的。** 起因是头一个会话里
`delegate_image_creator` 连挂三次 `Error: subagent run failed`（每次 60ms，
`list_agents` 也显示无子代理）。重启服务后同一份 preset **五发全成功**：copywriter 空手、
技能 + copywriter、image_creator 空手、image_creator 真任务，另加 `yw-team` 的
`delegate_writer` 作对照。那三次只出现在第一个服务进程里，之后再没复现过——
**结论是「不可复现的瞬时故障」，不是形状问题**，别拿它当 preset 的罪证。
（加上环境更正之后这条更要放轻：那个进程也跑在漏挂 patch 的组装上，
真要定性得在正确 bundles 上重新观察。）

**上一节留的判据，成员自己逐字兑现了。** 让 `image_creator` 先如实盘点再真出图，它回的是：
真实可调用只有 `read` / `write` / `edit` / `skill` 四个，然后把 ImageGen、ImageEdit、
HY-Image-V3.0、HY-Image-Lite、全部视频模型、`Bash 工具链`、`SendMessage`、`web_search`
逐条标成"无对应 API"，并且自己点出了病根：*"我的系统预设文案和 ai-content-production
技能包中确实描述了 ImageGen、ImageEdit、HY-Image-V3.0 等工具的用法，但这只是角色设定/
技能文档文字，并非我当前环境真实暴露的可调用函数"*。**这是 `toolFilter.allow` 逐成员生效的
正面真机证据**（allow 方向，deny 方向那条仍只有 `yw-team` 那轮）。**这一条不受上面那个
环境错误影响，反而更干净**：纯上游 base 里 `bash` / `web_fetch` / `web_search` 全都注册着，
成员一个都看不到，只剩白名单里那四个——收窄确实是逐成员生效的，跟我们的插件无关。

**真正的伤害不是"干不了"，是它把用户往 WorkBuddy 引。** 主理人给用户的收尾原话是
*"当前 DSH 环境未接入 WorkBuddy 图像生成服务，如需真正出图，需要在一个具备 ImageGen /
HY-Image 等 API 的运行时（WorkBuddy 平台）中执行"*。**这里的因果我给错了，按上面那个更正重述**：当时我断言"`image_generate`
我们自己注册着（`openlux-plugin-account/src/media/name.ts:15`），是白名单把它挡在门外"——
但那个组装里账号插件根本没挂，工具**确实不存在**，所以模型说的是实话。**出厂形状下这句话
才是错的**（那时工具在，挡它的是白名单），而这一条必须在正确 bundles 上复验才能定性。
**与工具存不存在无关、因此仍然成立的是话术问题**：人设里的 WorkBuddy 工具名让它把用户
往前身平台引，这是品牌残留的直接后果，不是工具面的后果。代价那条也照样成立：用户干等
4 分 03 秒（其中工具调用 3m28s，成员在反复盘点不存在的工具）才收到一句"我做不了"。

**那三次失败为什么查不出原因，是内核这一层的事实，记下来免得下次再挖一遍。**
`dsh-subagent/lib/index.js:2155-2166` 把子代理运行期的**任何**异常 catch 成
`stopReason: 'error'`，原始 error 只递给可选回调 `parts.onError`，而**全仓库没有任何一处
设置这个回调**（`rg "onError:" dsh-subagent dsh-tool-subagent` 零命中，唯一出现就是那句
`parts.onError?.()`）；`SubagentResult` 类型里也只有 `output` / `structured` / `stopReason`，
没有 error 字段（`dsh-subagent/lib/types/types.d.ts:207-222`）。工具层再把它映射成一句
`subagent run failed`（`dsh-tool-subagent/lib/index.js:59`）。所以界面、会话日志、
服务端 stderr **三处同时查不到原因**，用户遇到只有一句无信息的报错。想让它可诊断，
得我们自己接上那个回调或另找途径——这是内核的可改进点，不是我们找错了地方。

顺带两条查证方法：子会话日志确实落在 `sessions/<project>/<childId>/session.jsonl.zstd`，
header 里带 `origin: subagent` / `delegationDepth: 1` / `agentPreset`，**失败那三次里只有
header 一条事件**（子代理连一个事件都没产生）；这个文件是「每批一个独立 zstd 帧串联」，
Node 的 `zstdDecompressSync` 只吃第一帧、流式解到第二帧报 `Unknown frame descriptor`，
内核自带多帧解码器（`dsh-session-persistence-jsonl/lib/types/zstd-*-decoder.d.ts`），
要读全得用它。

**`maxDepth: 1` 不是嫌疑人**（我怀疑过）：`resolveChildDepth` 是 `childDepth > maxDepth`
才抛，第一层 `1 > 1` 为假；而且它抛的是带数字的 `SubagentDepthError`
（`dsh-subagent/lib/index.js:466-491`），不会伪装成 `stopReason: 'error'`。

#### 14 份 preset 全量静态扫描（2026-08-19）：三个改变结论的发现

出厂 2 份（`config/agent-presets/`）+ 探针 home 里的 12 份，逐份解析 YAML、
按成员取 `toolFilter`、全文数死工具名 / 死模型名 / 品牌词。

> **这 12 份的来处要说准，别当成用户的真实状态**（我一开始写成了"用户本地装的"）：
> 它们在 `%TEMP%\yw-dsh-live\.agent-presets`，创建时间集中在 8/17–8/18，是**这两天测试
> 期间装/造的**——10 份来自专家市场（`ad-creative-strategist`、`career-navigator`、
> `computer-operations-advisor`、`douyin-strategist`、`exam-preparation-planner`、
> `hr-digital-expert`、`market-probe-team`、`marketing-growth-team`、
> `tencent-cloud-quote-assistant`、`thesis-writing-mentor`），2 份是探针自造
> （`yw-finance`、`yw-team`）。**真机桌面 home（`C:\Users\000\.dsh\.agent-presets`）里只有
> `kumo-team` / `kumo-test` 两份 8/17 的早期残留，一个正式专家都没装。**
> 扫描结论本身不受影响（扫的是 YAML 文本，市场那 10 份正是要发给用户的东西），
> 但凡是"用户当前装了什么"的判断都得回这个目录数，别拿探针 home 顶替。

| preset | 形状 | 成员的工具面 | 死名字 |
|---|---|---|---|
| `ai-content-creator-team`（出厂） | 团 · 6 成员 | 六个都是 `allow=[skill,read,write,edit]` | ImageGen×13 ImageEdit×9 SendMessage×25 `deliver_attachments`×13 YT-VITA×16 `subagent_type`×7 `uploadAndGetVid`×2 `Agent 工具`×2；模型名 HY-Image×25 HY-Video×18 YT-Video×28（含小写变体）；WorkBuddy×14 |
| `market-probe-team`（探针 home） | 团 · 6 成员 | 同上 | **与上面逐项相同** |
| `marketing-growth-team`（探针 home） | 团 · 4 成员 | 四个都是**无 `toolFilter`** | 干净 |
| `content-creator`（出厂）+ 9 份单专家 | 单专家 | 无收窄 | 干净 |
| `tencent-cloud-quote-assistant`（探针 home） | 单专家 | 无收窄 | WorkBuddy×2 |
| `yw-team` / `yw-finance`（探针） | 团 2 成员 / 单专家 | `allow=[skill]` 与 `deny=[pwsh,write,edit]` | 干净 |

**一、`ai-content-creator-team` 与 `market-probe-team` 是同一份东西**（都 72500 字符、
死名字命中逐项相同）。所以今晚测的就是要发的那份，上一节那些静态结论直接适用，
不用再单独跑一遍出厂那份。

**二、`marketing-growth-team` 的四名成员根本没有 `toolFilter`**，即同一个生成器产出了
两种形状。没有收窄意味着成员看得见全部全局工具——`image_generate` / `video_generate` /
shell 都在，**能干活**，但也踩上前面记过的那条坑：**成员默认看得见其他成员的 `delegate_*`**，
可以互相委派甚至绕圈。所以这两个团要往中间收敛：一个太窄干不了事，一个太宽没有边界。

**三、10 份单专家全干净**（只有 `tencent-cloud-quote-assistant` 两处品牌词）。
「专家也要一样扫」这件事的答案是：**问题只在团里**，单专家这条线不用返工。

自动扫描有个必须说明的盲区：它只能标出"人设点名了真实工具名但白名单里没有"（只命中
`content-adapter` 的 `bash` 一条），因为其余成员人设里用的**全是 WorkBuddy 的名字**
（写 ImageGen 而不是 `image_generate`），压根没提过真名——这本身就是结论：
它们不是"要的工具被挡了"，是"从来没指向过我们真有的那个工具"。

顺带撞到两个与专家团无关、但每轮都在发生的问题，单独排：

这两条我一开始都当成新问题记，**查完是同一个早就查清的坑，而且恰好证明出厂那道封堵是
必要的**——它们只在我这个漏挂 patch 的组装里出现：

- **每一轮的第一次工具调用都报 `unknown tool ""`（空工具名），模型重试才成功**，6 个会话
  6 次、跨两份 preset 100% 复现。根因是上游 base 挂着 `llm-deepseek` 而用户态给它配了
  中转 `baseURL`：那个适配器的分片赋值是 `!== undefined`，**中转续片发 `"name": ""` 就把
  首片取到的工具名冲空**。**这件事本文档「中转分片错位」那一节（2026-08-17）早就查完了**，
  连中转的原始 SSE 分片、`llm-deepseek/src/translate.ts:159-160` 那两行、以及"空 callId
  让会话永久打不开"的后果都抄在那里——**我今晚是第二次挖同一个坑，纯重复劳动**。
  遇到工具调用相关的怪症状先搜本文档，别从零开始。册子那份摘要在
  `references/openclaw-kernel.md:131`、`:141-145`。
- **那条加载不出来的会话**（`SessionPersistenceCorruptionError: session event at seq 186
  message must have tool source`）是同一个坑的下游：册子原话是它"还会写出空 `callId`
  让整条会话永久打不开"。**所以不是我强杀服务造成的**，我那次归因错了。
- **出厂形状对这两条免疫**：`cordis.patch.yml:116-117` 把 `llm-deepseek` 整行
  `disabled: true`，注释 109-111 写明理由正是"它是我们中转会打坏流解析的那个适配器，
  它留下的空 callId 让会话再也打不开"；默认模型也覆盖成 `provider: openlux`
  （`:128-131`），走结构上免疫的 `llm-pi-ai`。真机桌面 home（`C:\Users\000\.dsh`）里
  那段 `llm-deepseek: baseURL` 是**无效残留**——`disabled` 是组合层 entry 字段，
  loader 见到就 `return` 不 init（`cordis-plugin-loader/lib/index.js:381`），
  用户 settings 只能给 entry 提供 config，翻不回这个标志。

#### 与「指定模型出图/出视频」的先后关系（2026-08-19 判定：不等，但要拆成两件）

问题原话是「用户在专家团里指定 xxx 模型去生产怎么办，要不要等那个功能做完再动专家团」。
拆开看是两件事，一件不依赖它、一件是它的下游：

**A. 让成员能出图出片（补白名单）——与它无关，现在就能做。**
两个工具给模型看的参数里**都没有 `model`**：`image_generate` 是 `prompt` / `n` /
`size`（`openlux-plugin-account/src/media/tool.ts:143-161`，`size` 是按所选模型取的 enum），
`video_generate` 是 `prompt` / `aspect` / `duration`（`media/video-tool.ts:209-222`）。
模型由部署配置定（`DEFAULT_IMAGE_MODEL`、`media/video-tool.ts:81` 的
`DEFAULT_VIDEO_MODEL = 'veo_3_1-fast'`），两处注释把理由写死了——
*"The model never chooses this: availability is a deployment fact it cannot see, and a
hallucinated model name is a refused request the user pays for"*（`tool.ts:52`，
`video-tool.ts:78` 同义）。所以成员一进白名单就能用默认模型出图出片，走的是已经端到端
验通的那条链。现在的状态不是"出图但模型不对"，是"根本出不了"。

**B. 让用户指定的模型真的生效，三档都算——不用专家 / 用单专家 / 用专家团。**
第三条（把 `model` 加成取 `ROUTE_MODELS` 键的 enum）一改，三档的参数面同时活，因为三档共用
全局那一份工具（已验，见第三条那节）。但**后两档各多一个前提**：单专家要求人设不写死模型名，
专家团还多一跳——**成员是独立子代理，用户的模型意图必须由主理人写进委派 prompt，
成员再填进工具参数**。这里有个容易走错的路要提前钉住：子代理确实继承父的
`provider/model/maxTokens`（`dsh-subagent/lib/index.js:492-498` 的 `resolveChildOptions`），
但那是**对话模型**；出图/出视频模型是工具的部署配置，**不在 agent 路由里，不会被继承**。
所以 B 不能指望"路由继承"白送，得显式透传。

**B 还有两条历史教训，都在旧壳上真发生过（`references/media-video.md`）：**

- **让模型能填模型名，模型就会编或写裸名。** 旧壳上有一发出图落到了内核自带的 openai
  路径、报 `OpenAI API key or Codex OAuth missing`，而配置里 `imageGenerationModel.primary`
  明明是 `yunwu-image/gpt-image-2`——起因是模型自己传了裸名 `model: "gpt-image-1"`
  （`media-video.md:585-589`）。旧壳的解法是运行时钩子纠正前缀（编的前缀纠正、裸名补前缀、
  没传就不插手，离线 8/8，`:597-602`）。DSH 上第三条打算用 enum，是在 schema 层就拒掉，
  比运行时纠正更早——这也正是第三条判据里那句「写一个不存在的名字，被 schema 当场拒掉
  而不是发一次付费请求」的由来。**专家团里这个风险更高**：成员看不到用户原话，只看到主理人
  转述的 prompt，写错名字的机会比单会话多一跳。
- **「对话里指定模型」连旧壳都没做过，别当成迁移。** 旧壳要复现的结果是「用户能在设置里挑
  出图/出视频/朗读用哪些模型，**挑完固化**」（`media-video.md:100-103`），形状是
  `imageGenerationModel = { primary, fallbacks, timeoutMs }`（`:241-243`）。而且那一节明写
  **WorkBuddy 在这件事上没有可对齐的形状**（它的媒体能力是自家掏钱的固定档，不给用户选）。
  所以 B 是一个新形状：既没有旧壳实现可搬，也没有 WorkBuddy 行为可对齐，得自己定，
  更不该拿它挡住 A。

**排法**：A 现在做（它正在造成真实伤害）；B 记成第三条的一个子项，第三条动工时一并设计，
别做完发现漏了专家团这一跳。另外 A 阶段清人设时，**所有具体模型名一律删掉、不换成新名字**：
`ROUTE_MODELS` 是部署事实（图 3 个、视频按厂商加行），把它抄进 2100 行人设等于把部署配置
复制进内容，换一次模型要改所有专家；模型看得见 enum，不需要人设教它。B 阶段要不要在人设里
提"可以让用户指定模型"，等第三条的名单定了再说。

**顺序上的风险也不对等**：第三条自己记着「网关上 gemini 那几个出图模型是 503，名单得
人工筛」，带外部依赖、工期不可控；把一个正在把用户往 WorkBuddy 引的问题挂在它后面不划算。

**别和旧壳那件事混了**：`experts-and-teams.md:50-51` 记的「出图模型让用户自己选」
在 openclaw 旧壳上 2026-08-13 已端到端验通（候选 3 → 21 个），但那是**设置里选**的配置层；
第三条说的是**对话里说「用 xxx 模型画」**的参数面。两件事都还没迁到 DSH，互不替代。

#### 根因在生成器，改产物会被覆盖

那份四件套白名单不是手写疏忽，是 `dsh-plugin-desktop/scripts/materialize-expert.mjs:51`
的 `MEMBER_ALLOW = ['skill', 'read', 'write', 'edit']`，注释写着
*"Portable allow-list: only tools the standard preset always registers"*——为了"挂载一定
不失败"（`toolFilter` 里的未知名字会 fail startup）选的最小可移植集，但没人验过它的后果。
**所以要改的是生成器，不是那两份 yaml**，否则下次 materialize 覆盖回去。同时
`marketing-growth-team` 那份说明生成器还有一条不写 `toolFilter` 的路径，两条都要对齐到
"按角色给能力工具"：shell 那行按平台走 `!!js process.platform === 'win32' ? 'pwsh' : 'bash'`
（这份文件里已经在用 `!!js`），出图给 `image_generate`、出片给 `video_generate`，
检索按需给 `web_search`（它是真实存在的，`dsh-base/cordis.patch.yml` 里有，
成员看不见纯粹是白名单挡的）。改完的判据仍是真机：让 `image_creator` 真出一张图。

#### 22 份预设全量入库（2026-08-19 下午）：四个「静默不出现」的真错

**分母先摆正。** 本机下载的 WorkBuddy 包 **22 个**（68 份人设、9 个团、46 个成员行），
仓库此前只随包发 2 份。线上清单是 **421 位**（369 单专家 + 52 团），但当前壳装不了——
`/api/desktop-market/*` 在已部署控制台 404，所以「随包发」是眼下唯一通路。
22 份现已全部入库（822 文件 / 20.3 MB），并新增 `scripts/materialize-all.mjs`
让重导入可复现（order = 20 + 下标，排在 dsh CLI 自带那四份之后）。

**四个错全是同一种形态：不报错，只是东西不在。**

| 错 | 表现 | 修法 |
|---|---|---|
| 生成器把人设当**替换串**喂给 `String.replace` | 人设里的 `$&` 把 tool-subagent 那一行拼进正文，`mvp-dev-expert-team` 整团静默消失 | 一律走替换函数（`spliceLiteral`） |
| 产出的 YAML 不合法（`Map keys must be unique`，2269 行） | 一份不合法的 preset 就是「选单里没有这一项」，没有任何提示 | 新增 `assertParses`：YAML 解析 + 成员行计数 + 模板变量白名单，三条都不过就构建失败 |
| 导入文本里的 `{{…}}`（JSX / Vue 片段，mvp-dev 一份里 18 处） | `renderPrompt` 严格解析、无转义、只认 `provider` / `model` / `cwd`，撞上就**每轮**抛错——只读文件的检查看不见 | `neutralizeTemplates` 中和成 `{ { … } }`，真的 `{{cwd}}` 保留 |
| 打包清单漏了 `config/agent-presets/**`（npm `files` 与 electron-builder `build.files` **两份都没有**） | 开发机一切正常，装机版一份预设都没有 | 两份都补上，包内测试跟着断言；`npm pack` 现含 99 个预设文件 |

**成员工具面：4 → 9。** `MEMBER_ALLOW` 从 `skill/read/write/edit` 扩到再加
`image_generate`、`video_generate`、`pwsh`、`web_fetch`、`read_image`。
给不了的那几个（`web_search` / `glob` / `grep` / `todo_write` / `ask_user_question`）
不是漏了：它们是**预设自带、不是全局注册**，写进 `toolFilter.allow` 会被 restrict 挡掉。
放开 `pwsh` 的代价查过：子会话实测 `approval/policy: never`（`source: delegation`）、
沙箱 `workspace-write`，所以既不会给用户弹窗，也出不了工作区。

**幽灵机制改在生成器里，不改产物。** 规则表 + 断言三件套：`FABRICATION_FIXES`（精确串，
配套「没命中就报错」的失效检测）、`MECHANICAL_REWRITES`（正则）、`PHANTOM_TOOLS` +
`assertNoPhantomTools`（我们自己的免责段落例外）。这一轮补的是派活与交付：
`TeamCreate` / `AgentTool` / `name`+`subagent_type` → `delegate_<成员 ID>`（入参只有一段自然语言）；
`deliver_attachments` → 把路径写进回复；`open_result_view` → 图片用 `image_show`；
`memory_write` → `write` 落文件；`connect_cloud_service` 与 `mcp__…`（企查查、ima 知识库）
→ `web_search` / `web_fetch`，并要求说清这是公开检索的结果。

> **词级替换会造出读得通但仍然错的句子。** 「团队创建（本机没有这一步）必须且只能由主理人执行」
> 仍在命令它做那一步；高考那份更露骨——换完变成「调用 `web_search` 获取凭证」。
> 判据是：**整句只为强制那个不存在的步骤而存在时，就整句换成它本来想达到的目的**
> （真派活、别自己替成员发言；本机没有凭证服务，这几类改走公开检索）。

**工作目录那句是被我们自己盖掉的。** 生成器用导入人设整体替换默认人设，
`你的工作目录是 {{cwd}}` 跟着没了。已补进工具真相块，真机复验主理人与成员两侧
都渲染成绝对路径（`dsh-agent-loop` 注册 `provider`/`model`/`cwd`，子会话走同一张注册表）。

**复验：22/22 逐包冒烟全过**——预设真的生效（判据是日志里的 `agent-preset/selected`，
不是窗口文字）、工具真相块在场、`cwd` 已解析、无残留花括号、无错误事件。

**派活复验：46 位成员一个不漏，全部真机跑过。** 判据取三处对不上就算失败的地方：
父会话日志里的 `delegate_*` 调用、子会话自己的工具清单与调用记录、磁盘上的文件。
先是 9 个团各派一位（9/9 过），再是每团一发把该团**全部**成员各派一次——
9 个团、46 次 `delegate_<成员 ID>` 调用、46 个子会话（工具面都是 **9 个**、`pwsh` 在内、
审批 `never` 且 `source: delegation`）、46 个文件真落在工作目录、子会话零报错。
先前只派头一位是不够的：成员人设各自是独立文件，主理人那份干净不代表他们干净。

覆盖面按层说清楚，免得含混：**13 个单专家**在逐包冒烟里各真跑过一发（它们没有派活这一环），
**9 位主理人**冒烟 + 派活各一发，**46 位成员**如上。三层加起来正好是 68 份人设。

**指定模型两发（都用非默认模型，判据是日志里的调用参数，不是模型的说法）：**

| 验什么 | 结果 |
|---|---|
| 新装专家出图（种草草 / `xiaohongshu-operations-expert`） | 点名 `doubao-seedream-5-0-260128`（默认是 seedream-4.0），调用参数与结果 `meta.model` 都是这个名字，3200×3200 JPEG 落盘 |
| 新装团出片（袋鼠帝宣传片创作团队 / `promo-creator-team`） | 点名 `veo_3_1`（默认是 `veo_3_1-fast`），提交参数 `{"model":"veo_3_1","duration":6,"aspect_ratio":"16:9"}`，约 2 分钟出片、11.7 MB mp4 |
| 改动最大的那个团整条回路（内容创作专家团） | 主理人只派珀西、把点名的 `qwen-image-max` 原样写进任务描述 → 珀西填进 `model` 一次成功并汇报路径 → 主理人调 `image_show` 把图摆进父会话，并如实解释「我不摆你就看不到」 |

**审计收口：假的不只是名字，还有能力清单。** 拿 473 条线上模型当判据扫完 22 份，
`ai-content-creator-team` 一份里就有 23 处指向本机调不到的腾讯系模型；但真正危险的不是名字，
是**围着这些名字长出来的承诺**——「文生 3D / 图生 3D / 图片特效 / 视频内容理解」四项能力清单、
一棵每片叶子都是死模型的选型决策树、一条「A 模型失败换 B 模型」的兜底链，
以及一个整份人设都建立在视频理解模型上的成员（艾达）。这些都改成了本机的真形状：
两个媒体工具、按「有没有参考图」选路、失败就去掉参考图 / 换提示词而不是换模型名、
要「看视频」就 `pwsh` 跑 ffmpeg 抽帧再 `read_image` 看帧。图生图 / 局部编辑本机没有，
「改图」明确写成重出一张或用 ffmpeg / ImageMagick 做机械编辑。
扫到最后人设层只剩 6 处可疑引用，逐条看都是审计的假阳性
（Godot 的 `EventHandler`、`SignalName`、美团记忆文件的字段名这类）。
技能参考文档里的旧模型名不动，改由文档顶部那段免责说明兜住——顺带把 MiniMax 那套
`MINIMAX_API_KEY` 也纳进触发条件，否则「前端资产用 MiniMax CLI 生成」这份文档不会带上说明。

**验证链自身修了两个假阳性。** 一个是驱动脚本在选单可视区外的坐标上空点却报「已选中」
（现在先 `scrollIntoView`，再校验触发器改名）；另一个是它按文字找预设触发器，
而触发器会改名成上一次选中的预设——`中文法律咨询团` 不含「模式 / 专家」，
于是 9 连测出现了严格的一发过一发失败。现在按预设名单匹配 `aria-haspopup=menu`，
并且在派活脚本里补上「选中真的落上了吗」这道校验。

#### 全量 421 个包过一遍生成器（2026-08-19 傍晚）：规则表覆盖住了整个语料

**先修一处口径。** 上面写的「装不了所以只能随包发」只对一半：装机那条路确实断着
（`https://api.openlux.ai/api/desktop-market/items` 现打是 404，`desktop_market_items`
这张表在 `openlux_mysql` 与 `openlux_test` 里都不存在，所以设置里的市场页是空骨架），
**但拉包这条路一直是通的**。上游那份清单与包体都在公开 COS 上，
`admin-server/service/desktop_market/import_expert_center.go:43,448` 写着地址形状：
清单 `expert_center.json`，包体 `<base>/bundles/<plugin>.tar.gz`，解出来正好是生成器要的布局
（`.codebuddy-plugin/plugin.json` + `agents/*.md` + `skills/`）。421 个包全拉下来 1,015.7 MB，零失败。

**真实分母比 22 大一个数量级。** 清单 421 条 = 369 个单专家 + 52 个团；
52 个团在清单里声明 52 位主理人 + **289 位成员**（12 位没有 `promptFile`），
即全量约 **710 份人设**——我们跑过的 68 份是其中 10%。
本机那 22 个包里 21 个仍在清单上，`redfox-xiaohongshu-ops-team` 不在（上游改名或下架）。

**结果：421/421 全部通过生成器，一个都没炸。** 这句话的分量在于它经过的那几道断言：
`assertNoPhantomTools`（一个假工具名都不许活到产物里）、`assertParses`（YAML + 成员行计数
+ 模板变量白名单）、`assertFixesLanded`。也就是说规则表**覆盖住了整个语料**，
不只是我们手上那 22 个：原始人设里 **57 个包共 983 处**点名了本机不存在的机制
（`SendMessage` 567、`subagent_type` 212、`TeamCreate` 123、`AgentTool` 30、
`open_result_view` 22、`deliver_attachments` 15、`use_skill` 9、`connect_cloud_service` 8、
`memory_write` 3），产物里一处不剩。

**头一遍是 4 个失败，两类原因，都值得记：**

| 包 | 现象 | 归属 |
|---|---|---|
| `fundus-disease-analysis`、`python-fullstack-engineer` | 找不到 `agents/腾讯健康-…-专家.md` / `skills/09-python全栈工程师` | **我的解包**：Windows 自带 bsdtar 按 ANSI 代码页解头部，中文名成了 `鑵捐鍋ュ悍…`。换 node-tar（按 UTF-8 读）就对了 |
| `executing-marketing-campaigns` | 包内 `plugin.json` 没有 `agentName`，回退到 slug 后找不到人设（真实文件叫 `marketing-campaign-expert.md`） | **上游包**：生成器比参考实现窄 |
| `rum-fullstack-team` | `plugin.json` 写 `./skills/tencent-cloud-rum`，包里实际是 `tencent-cloud-rum-zh-2.1` | **上游包**：同上 |

后两个照管理端导入器的做法改（它吃的是同一批包，早就踩过）：人设按
`expert_bundle.go:361-384` 三段回退——声明的 id → `promptFile` 的文件名 →
`agents/` 下唯一那份；技能**从包里扫 `skills/` 目录**而不是信 `plugin.json` 的清单
（`:436-455`），并要求目录里有非空 `SKILL.md`（`:522-529`，这一条同时挡掉了把
`skills/references/` 当技能的误判）。全量里 `plugin.json` 与包体对不上的有 12 个，
11 个是包里有、清单没写。**对已发的 22 份是零变化**（822 个文件数不变，
`preset.yml` 只有 order 因确定性排序变动）——本机那份 `plugin.json` 恰好都写全了。

**顺手补上一类新的幽灵：只是名字不一样的同一个工具。** 这是只有全量才看得见的——
`WebSearch` 出现在 **76 个包**、`WebFetch` 65 个、`AskUserQuestion` 30 个、`read_file` 23 个、
`ImageGen` 7 个，而这些在本机都有一一对应的真工具（`web_search` / `web_fetch` /
`ask_user_question` / `read` / `image_generate`）。改名就是全部修法，也是最便宜的一种：
没有一句话改变意思，agent 不再去找一个就在手边、只是换了拼法的工具。
`read_file` 这类停在 `(` 前面——技能文档里的 `read_file(path)` 是代码示例，改了会留下一份
读者看不出错在哪的坏样例。刻意不改的三类：`ImageEdit`（2 个包，本机没有图生图，是能力缺口
不是拼法）、`present_files` / `show_widget`（17 / 6 个包，只决定结果怎么呈现，缺了退回聊天里给结论——
`expert_bundle.go:404-415` 拿两条证据得出同一结论，还推翻了自己早前「为这个词丢掉整条技能」的旧判据）、
`execute_e2b_code` 那套托管沙箱（1 个包，`pwsh` 不是同一回事，改名等于说谎）。
补完这七条，产物里残留的假媒体名从 55 处降到 22 处，集中在 6 个包，且剩下的都是刻意留的：
`ImageEdit` 11、`HY-*` 9（模型名是数据，填错会被路由当场拒掉并告知有哪些能用）、`多模态内容生成` 2。

**还查到一条与「该发哪些」直接相关的既有判据。** 导入器对随包技能有一套上架政策
（`expert_bundle.go:386-415`）：名字命中腾讯专属服务（`westock*` / `tencent-*` / `12306-*` /
`meituan-*` / `andonq` / `cloudq` / `migraq`）或正文点名 `HY-Image` / `HY-Video` / `YT-Video` /
`youtu-vita` 的技能一律不收；上游给了技能而一条都没留下的专家判为空壳、**不上架**。
按这条规则扫全量：**14 个包是空壳**，其中一个是我们已经发出去的 `ai-content-creator-team`
（唯一那份随包技能整篇在讲 HY-*）。我们的版本不算空壳——人设已经改成指向真的
`image_generate` / `video_generate`，假的只剩技能文档，由文档顶部那段免责说明兜住。
真要扩发的时候，这 14 个是第一批该单独判断的。

**没做的，和为什么不做。** 421 份不该全塞进仓库：22 个包已经是 822 文件 / 20.3 MB，
按这个比例全量约 390 MB 进安装包，而且装机路径本来就该是市场按需装。
真机也不该全跑：710 场会话按实测节奏（约 2 分钟一场）是 24 小时起步，
而真机唯一独占能验的三件事——YAML/模板炸不炸、预设在选单里出不出现、成员工具面对不对——
前两件现在是静态判据（`assertParses` + 打包清单那条测试），第三件对 710 份是同一个答案。
**真正的缺口不在跑，在装机路径**：`openlux-plugin-account/src/market/compose.ts` 把服务端
下发的人设**原样**塞进预设，整份文件里 `allow` / `deny` / `toolFilter` 一个字都没有，
工具真相块与改写规则也都不在。市场一上线，从市场装进来的专家会把这 983 处幽灵原样带回来，
成员也退回内核默认那 6 个工具。规则表搬进这条路径之前，扩发多少份都是白改。

#### 装机路径怎么补（2026-08-19 夜，查完三个参考源后重判分层）

**先修上一节末尾那句的口径。** 上面说「工具真相块与改写规则也都不在 `compose.ts`」，
这句把两件性质不同的事按在了同一层。查完参考实现才看清：**真相块根本不该写进人设文件**。

**WorkBuddy 没有「改写层」（本机实测，它装在这台机器上）。** 市场是整棵目录树原样同步到
`~/.codebuddy/plugins/marketplaces/cb_teams_marketplace/plugins/<slug>`，装好的副本里幽灵名字
**原样在**：`plugins/trading-agent/rules/trading-agent_rules.md` 6 处、
`plugins/ai-hedge-fund/rules/ai-hedge-fund_rules.md` 3 处、
`plugins/ardot-design-generator/skills/…/references/slides-agent-teams-workflow.md` 3 处
（按 `HY-Image|HY-Video|YT-Video|TeamCreate|SendMessage` 计）。它的规则放在**运行期提示层**，两级：
宿主级 `~/.workbuddy/{BOOTSTRAP,IDENTITY,SOUL,USER,MEMORY}.md`（582 B ~ 1.9 KB，都是小文件），
插件级 `plugins/<name>/rules/<name>_rules.md` —— 位置与 frontmatter 有成文标准，就在市场根上那份
`marketplaces/cb_teams_marketplace/rules-standard.md:9-11,19-27`，其中 `alwaysApply: true` /
`enabled: true` 是「始终设为 true」的硬要求。旁证：`~/.workbuddy/teams/<team>/` 里只有
`config.json` 与 `inboxes/*.json` 这类运行态，**没有人设副本**——人设不落第二份，只在运行期拼。
它当然不需要改写：那些名字对它是真的。

**Claude Code 同形。** 包原样装（市场只管文件与版本），plugin 自带的 agent 用 frontmatter 的
`tools` / `disallowedTools` 声明工具面、由宿主执行（`code.claude.com/docs/en/plugins-reference`，
同一处还写明为安全原因不接受包里的 `hooks` / `mcpServers` / `permissionMode`）；换人设走
output styles，也是运行期。两边合起来给出同一条分界：**工具白名单跟着包走，工具真相跟着宿主走。**

**内核的旋钮现成，而且比静态文本强。** `section(section: PromptSection): () => void`
（`dsh-system-prompt/lib/types/index.d.ts:187`）：global 层对每次 assemble 都生效，agent 层按
scope shadow 同名段；order 带是 `-100` 身份 / `0` 人设 / `100~199` 工具指导；只有
`complete: true` 会把其他段全压掉（`dsh-persona/README.md:18,21`，默认 `false`），
而我们 22 份预设一个都没开（`agent-presets` 里搜 `complete` 只命中 plan 模式的散文）。
同一个服务还给了 `variable()` 与 `system-prompt/assemble` 瀑布，**能拿到本次 assemble 的真实工具表**——
真相块因此可以现算，而不是我写一份、工具面一变就过期。

**于是三样东西各归其层：**

| 东西 | 该在哪层 | 为什么 |
|---|---|---|
| 本机工具真相（有哪些工具、没有 MCP、模型名照原样传、成员出的图要 `image_show` 才到用户眼前） | 运行期：`systemPrompt` 全局段 | 讲的是「这个构建」的事实。一处生效于普通对话 / 出厂 22 份 / 市场装的 / 用户自己写的；写进文件只会过期 |
| 人设正文里写错的工具名、模型名、机制 | 落盘处：生成器与 `compose.ts` 共用一份规则模块 | 错的是正文本身，运行期改不动 |
| 成员工具白名单 `MEMBER_ALLOW` | 组装层：两条路径共用 `market/teammate-tools.ts`，各自写进自己的 teammate 行 | 与 Claude Code 把 `tools` 放包里同层；写错名字内核 fail loud 并列出已知全局工具（`dsh-tool-subagent/lib/types/index.d.ts:45-55`） |

搬完的净效果还省 token：真相块从 68 段人设各带一块，收成全局一段。

**动手前必须先拿到的一条真机输出**：全局段能不能到三档——普通对话、出厂专家团（它的 persona 行
已经 shadow 掉 `deployment:persona`，要验全局段没被连带压掉）、派活给成员（子会话 scope，要验段能到
且能按 scope 换成成员版文本）。第三档若拿不到 child scope，退路是成员那份真相仍由 `compose.ts:290`
那个每成员一份的 `persona:` 带着走，前两档照搬。

#### 落地结果（2026-08-19 夜，三档真机 + 22 包逐字节回归）

**真相块搬完了，在 `openlux-plugin-account/src/persona/tool-reality.ts`。** 注册一个全局段
（`order: 150`，落在工具指导带里），静态文本只写「与人设冲突时以本段为准 + 工作目录 + 模型名是数据」
这几条恒真的；工具清单、没有 MCP、媒体那几句、成员版 / 主理人版的差别，全在
`system-prompt/assemble` 瀑布里按 `assembly.tools` 与 `agent.session.header.origin` 现算。
生成器里的 `TOOL_REALITY` / `LEAD_TOOL_REALITY` / `MEMBER_TOOL_REALITY` 三个常量删掉，22 份预设重生。

**一个坑记着：瀑布里要原地改，不能返回副本。** 第一版写的是 `return { ...assembled, sections }`，
探针于是读到 `next()` 那个旧对象、把派活成员报成「只有静态正文」——不是段没到，是我们自己看错了。
内核把 assembly 叫 mutable，就照它的字面改 `assembled.sections[at]`。

**三档真机（`.tmp-probe/reality-reach.mjs`，`ai-content-creator-team` + 真派活）：**

| 档 | 工具数 | 真相块 | 附带证到的 |
|---|---|---|---|
| 普通对话 | 4 | 现算 | `image_generate` / `image_show` / `video_generate` / `web_fetch` 是全局层 |
| 出厂专家团主理人 | **33** | 现算，含 6 条 `delegate_*` 名册 | persona 行 shadow 掉 `deployment:persona` **不影响**全局段 |
| 派活成员（真子会话） | 9 | 现算，含成员版那两句 | `header.origin === 'subagent'` 是可靠判据；`toolFilter.allow` 生效 |

**规则搬进共用模块，两条路径同源：**

| 模块 | 装什么 | 谁用 |
|---|---|---|
| `market/persona-rules.ts` | `FABRICATION_FIXES`（逐包精确改写）/ `MECHANICAL_REWRITES`（通用正则）/ `PHANTOM_TOOLS` / `SKILL_DOC_NOTE` / `createScrubber` | 生成器 + `compose.ts` + `install.ts` |
| `market/teammate-tools.ts` | `MEMBER_ALLOW`（9 个）+ `withTeammateRoster` | 同上 |

生成器**按源码 import**（`node --experimental-strip-types`），不走构建产物：重生预设不该依赖先构建插件。
搬完重生 22 份，`git diff` 对预设产物**零变化**——这是「搬对了」的判据，不是「跑通了」。

**`compose.ts` 补齐四件**（原先一件都没有，市场装的专家等于绕过全部规则）：
人设过 `rewriteIdentity → scrub → neutralizeTemplates`；teammate 行补 `toolFilter.allow`；
主理人人设补名册；组装完 `assertRenderable` —— 只有「渲染必失败」这一类走 `ArchiveError`（转成拒装并回滚），
幽灵工具名只 `warn`（用户要的是这个专家，而运行期那一段已经压过它了）。

**测试抓出一个真 bug，两边读代码都看不出来。** delegate 工具名：生成器是 `id` 里连字符换下划线
（`delegate_video_editor`），`compose.ts` 保留连字符（`delegate_video-editor`）——两个都过线上那条
`^[a-zA-Z0-9_-]{1,64}$`，所以谁都不报错；但 `MECHANICAL_REWRITES` 把人设里的派活指令改写成的是
**下划线那版**。市场装的团于是每次派活都调一个不存在的工具。已按生成器口径统一。
测试在 `dsh-plugin-desktop/tests/market-compose.spec.ts`（54 例，其中 44 例是 22 个真包的两路径等价）。

**两处差异是不可消除的，写下来免得下次当 bug 修：**

| 差异 | 为什么消不掉 |
|---|---|
| 成员顺序：生成器按 `plugin.json` 的 `teamInfo.memberAgents`，装机按 `members/<id>.md` 文件名排序 | 制品里没有清单，档内只有文件。每行自带人设与工具名，顺序只影响名册列出的先后 |
| 名册标签：生成器用清单的 `displayName / profession`，装机用人设自己的第一个 `#` 标题 | 同上。frontmatter 里那份是按语言嵌套的 YAML，读它要给这个刻意不带解析器的文件加一个解析器 |

**顺带查证的一条内核事实**：`dsh-tool-subagent` 的 config 只有 `provider` / `toolName` /
`enableRunInBackground` / `backgroundMode` / `agentOptions` / `persona` / `toolFilter` / `maxDepth`
（`lib/index.js:22-38`），**没有 description 旋钮** —— 工具说明是内核自己那段通用措辞。
所以「哪个工具找到谁」只能是主理人人设里的散文，名册那一块删不掉。

#### 两处分歧的裁决：都判给「不删内核的东西」

**`tool-ralph` / `tool-workflow`：不关。** 生成器原先给专家团关掉这两行，代码里没写为什么、
本文档也搜不到依据；而装机路径对同类问题早有成文判断（「删内核自己拥有的行，没人要求，不做」）。
拿不出依据就按那条办。**改完真机复验**：主理人工具数 31 → 33，多出来的正是 `ralph` 与 `workflow`
（行真的挂上了，不是静默失败），同一轮派活仍然成功、成员仍是 9 个工具。

**`includeDefaultRoots`：不关。** 这条本文档自己在「不关 `includeDefaultRoots`」一节里已经判过——
出厂 `cordis` 自己带技能也只**加**一个根——生成器却一直写着 `false`，是它没跟上。
`false` 真正屏蔽掉的是 `<cwd>/.dsh/skills`、`~/.dsh/skills` 及其 `.agents` 同胞
（`dsh-skill-filesystem/lib/index.js:152-178`），也就是**用户自己写的和项目自己带的**技能，
不是我们的哪一堆；而本机这两个 home 根都不存在、`DSH_BUNDLED_SKILL_DIR` 也没设，
所以它没隔离到任何东西，只保证了「用户召唤专家的那一刻，自己写的技能失效」。
上面那两格旧结论已就地改掉。

### 阶段 4 · 媒体（4~6 周）· 四条闸门已通过

**原本判定这是全案最大的不确定性，因为风险不在"要写多少行"，在"dsh 有没有承载它的能力"。
2026-08-17 四条证据全部验完：能力都在，只有视频产物的显示方式要选一条路。**
先记下 openclaw 在这条链上白送的四样东西——我们的 4,219 行插件是**长在它们上面**的，
所以下面这张表是"要自己补什么"的清单，不是"做不了"的清单：

| openclaw 白送的 | 出处 | 少了它会怎样 |
|---|---|---|
| `video_generate` 工具原生收参考图：`image`（一张）/ `images`（多张）/ **`imageRoles`**（`first_frame` / `last_frame` / `reference_image`，按下标对齐） | `agents/tools/video-generate-tool.ts:117-131` | 图生视频整档要自己造，包括工具 schema 与模式推导 |
| 模式由**有没有传参考图**推出（`generate` / `imageToVideo` / `videoToVideo`），provider 只声明 `capabilities.imageToVideo` | `video-generation/types.ts:105` | 同上 |
| **`resolveModelCapabilities(ctx)` 钩子**，运行时逐模型问参考图张数，调用点在张数卡**之前** | `video-generation/types.ts` + `runtime.ts` | Vidu 首尾帧那条路径就是因为静态声明算不出张数，写好后当了四天死代码。这是"不报错的失败形态" |
| 内核在同一条 primary+fallbacks 链上**按能力跳**：候选不支持这次的参考图输入就跳下一个 | `video-generation/runtime.ts:125-205` | 用户会撞到"选中即必然失败"的模型 |

我们自己的抽象**可以整体保留**：视频「提交 → 轮询 → 取 url → 下载」循环在 `generateVideo` 内部，
异步出图同形骨架在 `generateAsyncImage`，每家适配器只补「拼提交体 / 解析轮询体 / 取 url /
判终态」四个函数，归属判据由适配器自己用 `endpointTypes` 声明，装不进静态清单的
（Replicate / fal 的类型名逐模型）走 `matchesType` 钩子。这套「一家一个适配器」**不是我们发明的**，
openclaw 自带的五个视频扩展逐条对得上，是成熟做法。

**产物怎么回到对话，是这条链上花力气最多的地方，且必然要重做。** openclaw 上那套是：
媒体一律后台任务 → 投递走 `deliverSubagentAnnouncement`（对我们的会话键必然失败）→
所以我们用 `after_tool_call` 钩子记账落 `~/.openclaw/yunwu-media-tasks/<taskId>.json` →
主进程 `fs.watch` + 启动全量扫 + 30 秒慢清扫 → `chat.send` 补投 → `agent.wait` 确认真起了一轮 →
失败按 `3s / 10s / 30s` 退避重投。还有一条：**本机绝对路径只在 `agent`/`stream:"assistant"`
的 `data.mediaUrls` 上**，`chat`/`final` 的正文里 `MEDIA:` 行已经被内核剥掉了。
dsh 的事件流形状完全不同，这一整套要重新设计——但**要复现的结果不变**：
用户说"画一张图"，图出现在这条对话里，失败也要说出原因。

#### 四条前置证据：已验完（真机跑过，探针已删）

**第 1 条 · 长任务：通过，而且内核给的比我们手搓的那套完整。**
dsh 有一等公民的后台任务运行时 `ctx.jobs`（`packages/jobs/jobs/src/index.ts:62`），
`JobKindMap` 明确设计成插件声明合并扩展（`jobs/src/types.ts` + `docs/subsystems/jobs.md:9`），
所以 `video_generation` / `image_generation` 是加一个 kind 的事。生产者契约正好是媒体的形状：
`run()` 返回 `{ cancel, done, readOutput? }`，**不给 `readOutput` 就是 final-output-only 任务**，
终态产物放 `JobOutcome.output`，`read()` 幂等不消费。真机读数：

| 我们在 openclaw 上手搓的 | dsh 的对应物 | 真机验到 |
|---|---|---|
| `chat.send` 补投 + `agent.wait` 确认 + `3s/10s/30s` 退避重投 | `ctx.jobs.onJobDone` → 闲的 owner 走 `owner.followup()` 开一轮，忙的走 `owner.inject()` 等在 next-step 收件箱（`tool-jobs/src/index.ts:279-300`） | idle → `followup=1`；busy 且两个任务同时完 → `inject=2`（只花一步） |
| 「会不会重复投递」一直没验 | `JobSnapshot.reported` 位 + first-wins：**`kill`/`read`/`wait` 任一发生就算有人认领了终态**，通告自动去重 | 调过 `wait` 后 `reported=true`，投递 0 条 |
| `duplicateGuard` 按「工具+provider」锁死，同一时刻只能一个视频任务 | `maxConcurrentJobsPerOwner` 配置项，**默认 10** | 第 11 个被拒，报错还教模型怎么办：`background job limit reached for this owner (limit: 10); use job_kill to stop an unneeded job, wait for it to finish, then retry` |
| 用户点停止后撤上游轮询要自己接 | `kill(id, caller, reason)`，reason 原样传给生产者 `cancel()` | `cancel` 收到 `'用户点了停止'` |
| 自激链（任务完成唤醒一轮、那一轮又起任务）没防护 | `maxConsecutiveWakes` 默认 3 轮，由用户真实输入重置（`tool-jobs/src/index.ts:39-45`） | 内核注释直说这是防自激 |

**一个要做的设计选择**：内核默认通告的内容是**「任务完成了，用 `job_output` 读」**，
不是产物本身——照默认走，一次出图 = 提交 1 轮 + 唤醒 1 轮 + 模型再调一次 `job_output`。
`ctx.jobs.onJobDone` 是公开 API，我们可以自己挂监听器把产物直接塞进消息，省掉那一次读；
代价是要把 `dsh-tool-jobs` 的 `completionDelivery` 设成 `'quiet'`，否则两个监听器各投一条。

**第 2 条 · 产物显示：出图通过，出视频要选路。这是本次唯一一条改产品形态的发现。**

- **出图有一等公民的路。** `ctx.attachments.saveImage()` 验字节 → 原子提交 →
  返回内容寻址的 `ImageAttachmentRef` → 进 `ImageBlock`（`llm/src/types.ts:99-105` 的
  `ContentBlockMap` 里 `'image'` 是内建项）→ 会话日志与模型可见块都认它。
  内核刻意规定引用里**不许放 base64、provider URL、主机临时路径**
  （`docs/subsystems/attachment.md:5`）。这比我们现在那套「`MEDIA:<绝对路径>` 行 +
  内核广播前剥掉 + 我们从 `data.mediaUrls` 捞」干净一个量级。
- **出视频 / 音频在内核层没有落点。** 正面证据三条：`attachment/src/types.ts:8` 的
  `ImageMediaType` 只有 `image/png|jpeg|webp|gif`；`ContentBlockMap` 只有
  text / reasoning / image / tool-call / tool-result；全 `packages` 搜
  `video/mp4|video/webm|audio/*` 只命中 2 个文件、**都是测试**。
  **选路已定，见下面「视频产物显示：选路结论」。**
- `ToolResultView` 的卡片种类是封闭联合（`generic` / `terminal` / `diff` / `search` /
  `read` / `web`），**没有媒体卡片**；但 UI 不认识的卡片会回落到原始 content，
  所以内联显示图片靠的是 `ImageBlock`，不是卡片。
  → **这一句在落地时被纠正了**：`ImageBlock` 放进**模型可见**内容是有代价的，
  而卡片这条路其实走得通（键槽 + 平台的图片件）。见下面「出图落地」。

#### 出图落地（2026-08-18 真机验通）：图只进卡片，字节走自己的通道

第一个真跑起来的媒体工具，`image_generate`，落在 `openlux-plugin-account` 里
（`src/media/{name,images,tool,read}.ts` + `src/client/{ImageToolCard.tsx,image-loader.ts,media-locales.ts}`）。
跟同一个插件同住是因为它吃同一个 `baseUrl` 与同一把 `sk-` 键：出图是按账号计费的，
再开一个包只多一份组合与依赖闭环。

**上面那句「内联显示图片靠 `ImageBlock`」要收窄成「靠 UI 可见的 `ImageBlock`」。**
`ImageBlock` 进**模型可见**内容的代价是查出来的，不是猜的：`contentHasImage`（`dsh-llm`）
**会下钻 `tool-result` 的 content**，而 `host/apiproxy` 拿它当闸——`selectModel` 与发 prompt
两处都是「会话含图 + 目标模型 `inputModalities` 声明了却不含 image → `model-unavailable`」，
`llm-deepseek` 的 serialize 更是对 `ImageBlock` 直接抛 `UNSUPPORTED_CONTENT`。
所以一张图会把会话变成**只有视觉模型能续**的会话，而且是延迟起爆：出图那轮好好的，
用户过几天切个文本模型才炸，那时他已经改不了历史。

内核自己就把两个受众分开了，所以形状是现成的：`output.render` 给模型（纯文本，明确写着
「图已展示给用户、你自己看不到，不要描述」），`presentResult` 给界面（`GenericResultView`
的 `content` 里放 `ImageBlock`）。视图每次投递重算、不进模型内容，所以引用走
`output.presentationMeta`——那是会话日志唯一保留的投影，重放靠它。

**代价是内核那条读附件的路跟着一起用不了，这是被逼的分歧。**
`session.readAttachment` 的宿主端用 `referencedImage(state.events, id)` 授权，
而它的 `imageBlockIn` 只走模型可见载体（会下钻 `tool-result`，**不看** `presentResult` 的视图）。
内核的规则实际是**可读性 == 模型可见性**，于是我们的图必然回 `ATTACHMENT_NOT_REFERENCED`，
卡片永远停在「加载失败，点击重试」。补法是在插件自己的 `/openlux` 通道上加一条
`media.image`（`src/media/read.ts`），授权靠 ref 本身：`ImageAttachmentRef` 是内容寻址凭据，
`attachment-local` 的 `readImageFile` 按 id 里的 sha256 定位、再校验摘要/媒体类型/字节数/宽高，
完整 ref 只存在于卡片正在渲染的那条会话日志里，通道又是 `loopback`。

卡片挂在 `tool.call.toolview` 键槽上（按工具名派发，**键错了不报错、静默退化成通用行**，
所以工具名做成两半共享的常量）。缩略图、加载态、重试、灯箱全用平台件 `ImageGallery`
（`dsh-client-ui-attachment`），我们只供 `ImageLoader = (ref) => Promise<url>` 并负责 revoke。

两个真栽的细节，都只在真机现形：

- **`ctx.attachments` 不能裸读。** 通道处理器跑在 inject 作用域之外，读它得到
  `cannot get property "attachments" without inject`。用 `ctx.get('attachments')`，
  与工具注册同一个写法（顺带让没有附件服务的组合仍然有账号面）。
- **`attachmentId` 是 `sha256:<hex>`，不是对象文件名。** 拿文件名手搓 ref 去打端点，
  回的是 `Attachment reference is invalid.`。

路由侧三条（云雾 `/v1/images/generations`，逐条真机打过）：默认
`doubao-seedream-4-0-250828`，约 15 秒一张 ~900KB JPEG；**`size` 必须是 enum**——
非法尺寸不报错、直接挂满整个超时预算（`123x456` 挂了 180 秒），所以模型手上只有清单里那几个值；
`gemini-*-image-*` 全族在这个端点回 503 无可用渠道。端点还会被上游饱和拖住
（同期别人的令牌 `use_time` 到 1287 秒），所以是 **90 秒一次、重试一次**，不是一个长超时干等。

真机复验（compatibility 外壳 + CDP）：发「帮我画一张图：一只戴着围巾的小黄狗，卡通风格」，
模型自己调了工具，29 秒出图，卡片渲染标题 + 提示词 + 缩略图，点开是 2048×2048 原图；
应用重启两次后从日志恢复这条会话，图照样加载；在这条带图的会话里切到另一个文本模型
`OpenLux V4-Pro`，切换被允许、追问 4 秒答完——这正是「图不进模型内容」买到的东西。

> 一条探针纪律的代价记在这儿：离线探针断言过「`presentResult` 视图里有 image block、
> `render` 出来的内容里没有」，**8/8 全绿**，但它停在数据结构上，没走「浏览器把字节取回来」
> 那一跳——而那一跳恰好否掉了它祝福的形状。探针要落在用户看得见的结果上。

**自检回看（2026-08-18，用户问「是不是没找到内核正确那条路」）。** 联网查了三个同题的社区
插件：`condaThinker/dsh-image-inline` 把上面那条授权规则逐字写了一遍并得出同一个结论
（结果故意不含 image 块 → 附件永不被日志引用 → 必须由插件自己提供读取通道），
`JuneLearn/dsh-image2-draw` 与其上游 `MC5lan/dsh-multimodal` 也是在卡片里解析附件、
不注入模型上下文。官方文档的三件套（`output.render` / `presentCall`+`presentResult` /
`output.presentationMeta`）与我们用的完全一致。**分歧只剩通道一处**：它们用
`ctx.webServer.register` 开 `GET /plugin/show-image/<id>`，让 `<img src>` 直接取字节；
我们用自己的 RPC + base64 + blob URL。两条都是正规旋钮，取舍是这样的——我们这条**与内核
自己的 `resolveImage` 同形**（也是 RPC → base64 → blob），并且继承通道的 loopback 授权；
`dsh-host-webserver` 的 README 明写"不提供 TLS、认证或来源策略"，而 `<img>` 的 GET **不带
`Origin`**，连我们自己 `renderer-boot.ts:62` 那道守卫都抄不过来。代价记明：base64 多 33%、
URL 生命周期得自己管（约 90 行）。图多的会话真出现内存压力时，换那条是有据可依的。

同一轮自检的其余结论：`sniffImageType` 与内核的 `detectImage` 重复，但后者只在
`dsh-attachment-local` 这个运行时半边里，import 它正是烧过我们的传递依赖陷阱，而猜错了
`saveImage` 会重新探测并报错（属于"镜像错了会响"）；`ROUTE_MODELS` 那张尺寸表**没有运行时
来源**——线上 `models` 表只有 `endpoints`（确认三个模型都是 `/v1/images/generations`），
尺寸只存在于网关前端的静态 `modelParams.js`，为它新开一条服务端下发通道正是我们已经烧过的错。
**改掉一处**：`n` 原本是自由整数 + 运行时 clamp，现在是 schema `enum`（数值 spec 只有
`enum`/`const`，没有 min/max），越界由内核校验器拒绝并告诉模型可选值。

#### 联网搜索落地（2026-08-18 真机验通）：整件事是一行配置，不是一个工具

老壳的形状会让人直接去写「联网搜索工具」。DSH 上不用写：`dsh-tool-web` 拥有工具名、
JSON Schema、系统提示词区段、`card: 'web'` 结果卡片、结果去重与截断；`ctx.web`（`dsh-web`）
拥有提供方注册与选择策略；这两行**在 base bundle 里本来就组合着**
（`bundle/base/cordis.patch.yml:404-418`，`fetch: false` + `searchTimeoutMs: 60000`）。
缺的只有一个能答出**结构化来源**的提供方。

**而且这不是"新增能力"，是"修掉一个必然失败的能力"。** base 把提供方指向
`deepseek-official` 并取 `DEEPSEEK_API_KEY`，而工具注册按内核设计**跟随产品启用状态、
不跟随后端可用性**（`dsh-tool-web` README「稳定注册」那节）。所以拿 OpenLux 账号登录的用户
每次请求都带着一个 `web_search` schema，一调就是 `WEB_PROVIDER_CREDENTIAL_MISSING`——
工具摆着，用不了。

路由这一侧探了三条，都是真机 POST：

| 试法 | 结果 |
|---|---|
| `/v1/messages` + `deepseek-v4-flash`（提供方默认模型）| HTTP 500 `channel deepseek does not support Claude format` |
| `/v1/chat/completions` + `deepseek-v3-search`（平台的 `-search` 能力后缀）| 真检索了（注入后 prompt 2542 tok、9.6 秒），但**只有散文**：中转把任何引用字段都没带出来，`sources[]` 无从填 |
| `/v1/messages` + `claude-haiku-4-5-20251001` + 原生 `web_search_20250305` | 10 条 `web_search_result`，带 `url` / `title` / `page_age`，文本块另有 10 条 citations，7.7 秒 |

第三条正好是内核提供方要映射的形状（它明确**拒绝从模型文本里刮 URL**），所以落地是
`dsh-plugin-desktop/cordis.patch.yml` 里一行：覆写 `web-search-deepseek` 的
`baseURL: https://api.openlux.ai/v1`（提供方自己接 `/messages`）、
`model: claude-haiku-4-5-20251001`、`apiKeyEnv: OPENLUX_API_KEY`。凭据**按次解析**，
所以未登录只会让这一次调用失败、schema 不抖；模型在广场上，计费落回同一个账号。
提供方注册 id 仍是 `deepseek-official`（那是 `web` 行选的名字），只有端点和模型搬了家——
为了名字好看去自己注册一个提供方，买不到任何行为。

两层复验：无头宿主里直接 `ctx.web.search({ query, maxResults: 5 })`，回 5 条带标题 / 时间 /
摘要的来源，`content` 按提供方纪律省略；界面里发「联网搜一下 DeepSeek V4 是什么时候发布的」，
模型自己发了两次 `web_search`（工具耗时 12.6 秒），答出 4 月 24 日发布、8 月 13 日 GA，
并带来源链接。

#### 网页抓取落地（2026-08-18 真机验通）：旋钮在预设层，我们故意没照那一层放

`web_fetch` 上游默认关着，注释里给的理由两条都成立：没有 fetch 提供方挂载，而那个提供方
把 SSRF 防护推给部署、目标 URL 又由模型选。**但第二条的结论到不了桌面端。**
沙箱只管文件效果——`dsh-sandbox-policy` README 原话是网络与进程策略"不在 `SandboxMode` 的
词汇里，因此这里没有限制它们的旋钮"——而每个权限档位都组合着 shell（`tool-bash`，
Windows 上是我们实际发货的 `tool-pwsh`）。也就是说模型早就能碰这台机器碰得到的任何主机，
无上限、无内容规则。提供方反而是更窄的一条：只收 http(s)、URL 带凭据直接拒
（真机验到 `WEB_BLOCKED_URL`）、只跟同源跳转、5MB 与 10 万字符双上限、只解码文本类型、
带诚实的 `User-Agent`。所以这一行买到的是一条**有上限的读取路径，不是新的可达范围**。
换成宿主跑在用户无权浏览的网络里的部署（托管 / 共享宿主），这个判断立刻反过来，那时这一行
要跟着那种形态一起撤掉。

**旋钮的真身在预设层，这是这次最值钱的一条内核事实。** 顺序是这样查出来的：

1. 我先照直觉把 `- id: tool-web / config: {fetch: true}` 打在了 profile 根上。
2. 无头宿主里 `ctx.tools.schemas()` 全局视图只有 `image_generate` 一个，`web_search` 也不在——
   而搜索明明在界面上能用。
3. 于是去查 `dsh-web-app/cordis.patch.yml`：它把 `tool-web` 整行 `disabled: true`
   （同一批还有 `tool-fs`、`tool-jobs`、`tool-skill`、`tool-todo`、`plan-mode`……），
   注释写着模型能看见的工具属于 agent 预设：**"What a preset chooses is which tools its
   agent sees"**。
4. 于是 `fetch` 的落点是每份预设自己的 `tool-web` 行——随 dsh CLI 发的
   `config/agent-presets/standard/agent.cordis.yml:247-251`（`fetch: false` +
   `searchTimeoutMs: 60000`），以及我们自己那两份专家预设里的同名行。
   我原来那行打在一个本应用里根本不启用的行上，**是死配置**。

照预设层改会撞上三件事：预设层**没有 patch 语义**（`dsh-agent-presets` README「已知限制」
原话：改随附预设一行只能整目录复制，而"副本是会漂移的快照"，升级不会更新它，上游自己的
`cordis` / `code` 就是 `standard` 的整份副本并接受这个代价）；我们产品的默认预设**就是**
随附的只读 `standard`（`profile.ts:368-380` 只往 `roots` 追加了我们的目录，`default: standard`
照抄 base）；而**靠前的根赢重复 id**，我们的目录默认盖不住它。三条合起来：想让默认档也能抓页面，
要么再养第三份 `standard` 副本（升级后悄悄停止继承上游改动，正是"从来没绿过的守卫"那类失效），
要么换掉产品默认预设（那是产品决定，不是这一步该顺手做的）。

**所以选了另一条内核既有的缝：把 `dsh-web-app` 关掉的那一行重新打开。**

```yaml
- id: tool-web
  disabled: false
  config:
    search: false
    fetch: true
```

这样 `web_fetch` 注册进**全局工具层**——`image_generate` 本来就在那里——不管会话从哪份预设
组装都看得见，也没有副本要同步；真有哪个 agent 不该有，`tools.restrict()` 是内核给的缝。
代价写清楚两条：这条工具不再由预设决定（连上游宣称"双工具"的 `极简模式` 也会多出它，
我们的出图工具其实早就有同样的外溢，上一轮自检只审了字节通路没审这个平面）；以及
`search: false` 让搜索留在预设层（一份全局的搜索注册只会多出一段和预设自相矛盾的提示词，
不会多出一个工具），于是搜索那段提示词里"搜完接着 fetch"的引导不会出现——
**实测模型照样会串**：一轮里 3 步，先 `Search` 再 `Fetch https://cursor.com/changelog`，
答案带原文引用与来源。fetch 自己那段提示词本来就拿"`web_search` 的结果"当例子输入。

提供方那行只调了一个值：`timeoutMs: 45000`。它是直接 `ctx.web.fetch()` 调用方的资源兜底，
README 要求部署把它设在**工具调用预算之上**，好让模型侧超时报 `TOOL_TIMEOUT`（由
`dsh-tool-call-timeout-policy` 拥有）而不是提供方的 `WEB_FETCH_TIMEOUT`——而两边默认值都是
30 秒，那不叫"之上"。

**三个探针陷阱，代价都是真金白银：**

- **把补丁追加在最后验的是机制，不是层序。** 我在探针里 `[...prepared.patches, 那一行]`，
  它当然赢；而仓库里的 `cordis.patch.yml` 是一个 bundle 层，位置在
  `profile.ts:315-320`（web-app 层之后）。层序对了才有效，探针那一下证不到这件事。
- **旧实例会静默接管新启动。** 第一次界面复验，模型直接答"I don't have a web_fetch tool
  in my available toolset"。原因是应用 21:13 就在跑，我 21:45 那次启动被单实例锁交接掉、
  shell 反而干净退出，界面测的是**旧组装**。判据以后是先比进程 `StartTime` 与补丁文件
  `LastWriteTime`，别只看"窗口起来了"。
- **提供方包要进 profile 的模块闭包。** `$DSH_HOME/profiles/node_modules/@deepseek-ai/`
  下面的软链是启动时按桌面清单的依赖闭包铺的，所以加完依赖必须重启一次才有
  `dsh-web-fetch-http`。

**真机结果**（标准模式、新会话）：模型说 "I'll fetch the page and extract the title and
paragraph."，一条 `Fetch https://example.com` 卡片，答出 `Page title: Example Domain`
与那一段正文，用时 24 秒。离线四条卫生规则也逐条验过：200 正常、404 作为**结果**返回不抛错、
URL 带凭据被 `WEB_BLOCKED_URL` 拒、loopback 能通（SSRF 缺口确实存在，与文档一致，
这也是上面那段判断的前提而不是意外）。

**守卫**：`verify-profile-boot.mjs` 现在断言全局工具层里有 `image_generate` 与 `web_fetch`、
且**没有** `web_search`（搜索该留在预设层）。反向验过：把 `disabled: false` 去掉就红，
报 `assembled desktop profile offers no web_fetch tool (global tools: image_generate)`——
也就是说这条守卫恰好挡住我这次犯的那个"死配置"错。

#### 视频产物显示：选路结论（2026-08-17 查证 + 探针验完）

**结论：不给 `ContentBlockMap` 加 `video` 模态。照 `dsh-client-ui-deliverables` 的形状
自己写一个 `ui-media` 插件。** 理由是四条路里三条免费、唯一要钱的那条要动内核文件。

先把「加模态」的四条路逐条定价（内核 `types.ts:96-97` 自己写明「New core blocks must
land with adapter, UI, and compaction support」）：

| 路 | 落点 | 加 `video` 的成本 |
|---|---|---|
| 适配器（上线） | `llm-pi-ai/src/context.ts:58-60` 与 `replay.ts:140-142` 都是 `default: break` | **0**。探针实证：静默丢弃、不抛。对照组 `image` 放在助手内容里**会抛**（`replay.ts:138`），所以我们反而比内建模态好过 |
| 计费 / 压缩 | `token-meter/src/estimate.ts:42-45` 的 `default` 按 JSON 长度计价 | **0**。注释明写就是给 merge-extensible 留的 |
| 持久化 / 回放 | `apiproxy/session-export.ts:125` 只认 image 的附件引用；`attachment/src/types.ts:8` 的 `ImageMediaType` 无视频 | 不论走哪条路都要我们自己的产物存储，**不是加模态的增量成本** |
| **UI** | `runtime/conversation.ts:71` 落到 `kind:'other'`；`ui-tool/tool-call-model.ts:110-111` 把**所有非 text 块 `JSON.stringify` 摊平** | **唯一要钱的一条**：想有播放器而不是一坨 JSON，就得改内核文件 = 长期维护补丁 |

最后那条是决定性的。我们现在已经在 `scripts/patch-kernel-reasoning.mjs` /
`patch-kernel-toolcalls.mjs` 上吃过打内核补丁的苦，不该为了显示视频再欠一笔。

**而内核给了不用改它的做法，`ui-deliverables` 本身就是范例**——它不是内核内建，
是个能被 `cordis.yml` 整个撤掉的插件（`ui-deliverables/src/client/index.ts:5-8` 原话：
「All policy lives here … so composing this plugin out of cordis.yml removes both
surfaces entirely」）。它的注册只有两句（同文件 `:39-51`）：

- `ctx.conversationEvents.register(定义)`：一个 `ConversationNodeDefinition`，
  自己盯 `tool/call` / `tool/result` 事件攒 turn 数据
- `ctx.slots.inject('conversation.chat.turnTail', …)`：往聊天时间线的 turn 尾部挂组件，
  `select` 返回 null 就在挂载前主动弃权

照这个形状，我们的 `ui-media` 插件盯自己的媒体工具、渲染真的 `<video>` / `<img>`，
**零内核改动，且升级内核不受影响**。分两步走：

**这两步都不降级，第一步反而是升级——这条查了现状才敢说。** 今天视频产物在界面上
**并没有内联播放**：它是 `msg-artifacts` 里的一张 `artifact-card`（`Workspace.tsx:5626-5642`），
点开走产出物预览抽屉，而那个抽屉**只有图片分支**（`:2409-2410` 注释原话「图片字节;有值即走
图片分支(主进程只对图片扩展名返回它)」）。也就是说用户今天点视频卡片是**预览不了**的。
dsh 第一步给的是产出行文件片 + Host opener 交给系统播放器，**真能播**。
第二步的内联播放是超出今天的增强，不是保平的欠账。
（顺带：`Workspace.tsx:6241` 已经有一个原生 `<video controls preload="metadata">`，
是剧本产物那条路上照 WorkBuddy 的 `PreviewVideo` 做的，第二步可以直接复用这个形状。）

- **第一步（零代码）**：媒体工具的 `presentCall` 返回
  `{ card:'generic', kind:'edit', title, locations:[{path}] }`，产物立刻进现成的
  `ProducedFiles` 那一行，点击交给 Host opener。内核自己的测试把这条契约钉死了：
  `ui-deliverables/tests/produced-files.client.spec.tsx:194-205` 证明 `kind:'edit'`
  + `locations` 会进产出行，`:215` 证明缺 `locations` 就不进，`:196` 证明 `kind` 不是
  `edit` 也不进，`:198` 证明失败的调用不进。
- **第二步**：`ui-media` 插件接内联播放。

**第一步有一条硬约束，是这次查证纠正的一个判断**：deliverables 读的是 **call view**
（`turn-deliverables.ts:43` 形参是 `ToolResultNode['callView']`，`update` 里存的是
`for:'call'` 那一支），不是 result view——而 `GenericResultView` 压根没有 `locations`
字段。`presentCall` 又被明确规定为**纯函数、只能依赖 `args`**（`tools/src/index.ts:275-277`：
回放时也会调它）。**所以产物路径必须能从工具参数纯推出来**：不能用执行时的墙上时钟、
不能用 callId，得用参数哈希这类确定性的算法，且 `presentCall` 与 `execute` 共用同一个
纯函数算路径。

第二步没有这条约束：我们自己的 node definition 直接读 `tool/result` 事件上的
`meta`（工具私有展示载荷，`tools/src/index.ts:296-301` 说明它从事件原样穿过来），
而 `meta` 是执行时产生的，可以带真实产物路径。

一条要注意的既有限制：deliverables 的已知限制第二条正好命中我们——「Files created
indirectly by terminal commands remain outside the matching vocabulary」。所以视频文件
光写到磁盘上**不会**自己出现在产出行里，必须由工具声明。另有一条：
`turn-deliverables.ts:40-41` 明说只有**根**调用视图进 turn 累加器，
Code Mode 里嵌套派发的不单独计入——媒体工具若被 `run_code` 包着调，产出行不会出现。

**第 3 条 · 参考图与逐模型能力：问题被重新框定了，而且是好消息。**
dsh 没有内建的出图 / 出视频工具，所以「它收不收参考图」不是内核问题——
**工具是我们自己用 `defineTool` 定义的，schema 由我们写**。这恰好消掉了 openclaw 上那个坑的根：
当年 `resolveModelCapabilities` 钩子之所以必要，是因为**工具和 fallback 链归内核所有**，
我们只能静态声明能力，于是 Vidu 首尾帧那条路径算不出张数、当了四天死代码。
在 dsh 上链和张数卡都在我们自己的 `execute` 里，直接查实时模型目录即可，不存在静态声明这一层。
参考图**输入**同样有一等公民的路：用户/模型传进来的图就是 `ImageBlock` 挂 attachment 引用，
我们用 `ctx.attachments.readImage(ref)` 取回字节。代价是 primary+fallbacks 的按能力跳选逻辑
要自己写（openclaw 是 `video-generation/runtime.ts:125-205` 白送的），但不必再跟内核契约较劲。

**第 4 条 · 工具闸门：通过，形状比 openclaw 干净，顺带把阶段 3 的 `toolFilter` 闸门也答掉了。**
dsh 的工具收窄是运行时 API `ctx.tools.restrict({ allow?, deny? })`，返回精确 disposer，
按 scope 生效、多个限制求交集、scope 自己注册的工具豁免自己的 filter。跑过内核自己的
`packages/core/tools/tests/scoped.spec.ts`（27 项全绿）证到更深的四条：

- **拒绝非 scoped 调用**，报错原话：`tools.restrict() requires a scoped context (agent.ctx):
  a context-global restriction would mask every agent — deny the tool for the intended agent
  instead`。内核压根不让你不小心做一个全局收窄。
- **传错名字失败而不是静默无效**，且报错列出已知工具名（`unknown global tool "reall" …
  known global tools: real`）。openclaw 上那个「`image_generate` 躺在 `tools.deny` 里、
  改完还要重启网关」的坑，在 dsh 上换成了代码里显式调的 API + 启动即报错。
- **能过滤子代理从祖先 scope 继承来的工具**，不只是全局的。测试注释写的正是我们专家团的形状：
  「no model-facing row in the global layer, all of them contributed by an ancestor scope
  the child joined」。
- 专家团（leader + member）有一等公民实现：`subagent/src/child-agent.ts:163-174` 的
  `applyChildComposition` 一次给子代理装上 `deployment:persona` section（order 0）
  和 scoped `tools.restrict(toolFilter)`。我们现在靠改 `SKILL.md` frontmatter 的
  `disable-model-invocation` + `before_prompt_build` 钩子拼出来的那套，**整体可以扔**。
  顺带解掉两条存量差异（对照 `experts-and-teams.md`）：
  - **成员人设的 7 秒延迟没了。** 我们现在是「`subagent_spawned` 记一笔
    `childSessionKey -> label`，约 7 秒后子会话 `before_prompt_build` 触发才回查注入」
    （该册第 136-139 行）。dsh 是在子代理创建窗口里**同步**装 section，不存在这个窗口。
  - **我们判定「v2026.6.11 无解」的重复投递，dsh 有内核级答案。** 该册第 42 行记着：
    成员产出回传做通之后长出「内核那条会迟到落地，同一份产出进两遍上下文」，
    结论是当前内核版本无解。dsh 用 `reported` 位 + first-wins settlement 从机制上去重
    ——真机验过：任何一方 `kill`/`read`/`wait` 认领了终态，另一条通告就不发。
    这条不是"少写代码"，是**换内核解掉一个我们已经判死的存量 bug**。
- **复验判据**：13 家逐家端到端出片（openclaw 上的既有战果，不接受退化）；出图三条路径各出一张；
  TTS 出一段音频。三个判据脚本继续通过：`verify-video-endpoints.mjs`（52 条）、
  `verify-image-endpoints.mjs`（26 条）、`verify-search-capability.mjs`（17 条）——
  它们是纯函数 + 真机快照，换内核不该让它们变红，是最便宜的回归网。
- **两条必须继承的纪律**：判据取库里的 `models.endpoints`，不自己拼路径、不看文档；
  界面认候选靠端点类型名、插件跑靠适配器，**两份清单必须逐字一致**（这就是那两个脚本在看的东西）。
- **一条与内核无关但必须带过去的产品智慧**：搜索后端可能是思考模型时，`max_tokens` 要按
  「思考预算 + 正文」给。实测 1200 时 `reasoning_tokens` 一次就烧 1149，正文只剩 45 个 token，
  答案截断成半句，而 `finish_reason` 仍是 `stop`、回执结构完好——**不报错的失败**，上层不会换后端。

#### 视频工具已落地：`video_generate` 交给 jobs，产物进产出行（2026-08-19 真机验完）

按上一节定的第一步做完了，形状与那份选路一致，**没有改任何内核文件**。
落点：`openlux-plugin-account/src/media/video.ts`（请求层：提交/轮询/取回）
+ `video-tool.ts`（工具 + 后台任务 + 路径推导）。守卫加在
`verify-profile-boot.mjs` 的全局工具清单里，反向测试证明它真看得见
（装配出的全局工具是 `web_fetch, image_generate, video_generate`）。

真机一条链走完（compatibility 外壳 + CDP 驱动，默认模型 `veo_3_1-fast`）：

| 环 | 看到的 |
|---|---|
| 模型自己选工具 | 「用 video_generate 生成一段 4 秒的视频：一只柴犬在海边奔跑…」→ 直接调用，没追问 |
| 交活即回话 | 卡片 `Tool call · video_generate`，模型答「视频正在后台生成中，一般需要 1~6 分钟。我会在出片后通知你。」——它没空等，也没编自己看得见画面 |
| 后台任务可见 | 会话头「1 个后台任务运行中」；面板行末尾是我们给的 `detail`：`5.9 MB · 1280x720 · 4s · 1分42秒` |
| 产物行 | 「产物」那一行立刻挂上文件片，`title` 是绝对路径 `…\media\video\黄昏逆光下…-5fcc397a1607.mp4` |
| 出片通告 | `上下文注入 · tool-jobs · video video_generate: …` → 模型自己调 `job_output` → 复述路径/时长/分辨率/大小，并说明自己看不到画面内容 |
| 点开播放 | 点文件片：点前系统 0 个播放器，点后 Windows `Video.UI` 起来了（`host.openPath` 这一环成立）|
| 取消 | 「取消刚才那个视频任务」→ `job_kill video-2` → 面板「已取消 28秒」，磁盘上没多出文件 |

出片内容也对：抽帧是逆光沙滩上奔跑的柴犬，`ffmpeg` 全解无报错，5.89 MB / 1280x720 / 4s。

顺带解掉两件与上游文档有关的事，细节记在 `references/media-video.md` 那一册：

- **文档站可以当契约源读**：`doc.openlux.ai` 的 SPA bundle 内联了整份 Apifox 导出，
  按数字 api id 能切出每条接口的 `requestBody`（字段、必填、枚举、示例）。
  这次用它补了统一视频那条的字段面，也发现**查询那条的 schema 是错的**（写成了 multipart chat 形状），
  所以判据仍以真机报文为准。
- **`enhance_prompt` 决定不发**：文档说 veo 只吃英文提示词、需要中文就开这个开关，
  但真机上中文裸发直接就对（青石板/白墙黑瓦/薄雾全中），而这个开关在回执里既不回显也没有
  `enhanced_prompt` 可查。**既非必需又无从验证，就不声明。**

#### 出片通告开的是新一轮：两排反馈按钮是这条路的代价（2026-08-19 查证，处置已定）

上一节那张表里「出片通告」那一行，用户看到的实际形状是**两段独立的回答**：交活那一轮末尾
一排「复制 / 点赞 / 点踩 / 重试」，出片通告之后又是一排，而复制只复制它自己那一段。
这不是重复渲染，是**真的两轮**，四个环节全在内核里：

| 环 | 出处 | 事实 |
|---|---|---|
| 完成投递先挑 owner 状态 | `jobs/tool-jobs/src/index.ts:294-299` | owner 空闲且投递方式是默认 `wakeup` 时走 `owner.followup(message)`，否则 `owner.inject()` |
| `followup` 必然开新轮 | `core/agent/src/runtime-types.ts:119-124` | 原话「becomes the sole ordinary message of **its own turn**」|
| 空闲 owner 上的 `inject` 不会被消费 | `core/agent-loop/tests/loop.spec.ts:640-667` | 空闲时 `inject` 之后 `turn/start` 为 0 条，要等下一次 followup 或 steer 才进上下文——所以「不开新轮」和「模型能知道」在空闲态下不可兼得 |
| 反馈按钮按轮次挂 | `ui-conversation/src/client/conversation-nodes/turn-tail.ts:152-188` | `turn-tail` 节点按 `event.data.turn` 分组，一轮一个；`ui-message-feedback` 的模块注释说它挂进这排 IconActions、「sit between copy and branch」，正是截图里那个图标顺序 |

**而第一轮为什么会提前收尾，是我们自己写的**：`video-tool.ts:144-146` 的工具描述
（"answer the user that it is running … instead of waiting in silence"）和 `:313-318` 的结果
文本（「现在先告诉用户正在生成，不要空等」）都在要求模型立刻收尾。模型照做 → agent 转空闲
→ 六分钟后任务完成 → 内核在空闲 owner 上只剩 `followup` 这一条路。**所以这既不是 bug，
也不是「没用好内核」，是这条路自带的代价**——`references/media-video.md` 当初只把这一环记成
白拿的能力，这笔代价已经补进那一册的「交给 jobs 的真正代价」一节。

**两个参考实现都走不到这个形状，但原因不同，所以它们的做法搬不过来**：WorkBuddy 出图 46 秒
在同一轮里等完，产物靠随后一条 final 事件补挂回同一轮（`references/workbuddy-ui.md:302`），
一轮一排按钮；豆包的视频生成是产品级固定流程，同一条气泡原地更新成完成态，它没有「模型
必须自己读回结果再复述」这一步。我们是 agent 循环，模型不调 `job_output` 就不知道结果，
这一步天然占一个轮次。

**处置：保留两轮，只治观感。** 三个旋钮都不用改内核文件，前两个的代价更大：

| 旋钮 | 位置 | 为什么不选 |
|---|---|---|
| `completionDelivery: 'quiet'` | 每份 preset 的 `tool-jobs` 行。**我们 20+ 份 preset 一个都没配**，全是默认 `wakeup` + `maxConsecutiveWakes: 3`（`jobs/tool-jobs/src/index.ts:29-53`）| 空闲 owner 的通告不再被认领，等于模型永远不知道片子出了。内核自己的注释把这个后果写成「a completion the model never learns about」|
| 工具描述改成同轮 `job_output(wait: true)` 死等 | `video-tool.ts:144-146` | 轮次要挂 1~6 分钟，而这正是 `video-tool.ts` 开头那段注释长篇论证要避开的（"Holding a conversation turn open that long is exactly what the kernel's job registry exists to avoid"）|
| **保留两轮，治观感** | 我们的文本 + 一处客户端小改 | 选它：两轮在内核语义上是对的，要改的是「看起来像两段互不相干的回答」|

三件具体的活，按收益排：

1. **唤醒轮别复述上一轮说过的东西。** 真机那一发里它把「图片 9:16 竖构图、雨夜霓虹街头…」
   整条又说了一遍。治法在我们自己的文本里——`filmInBackground` 写回的收尾行
   （`video-tool.ts:504-505`）要明确「只报视频这一件事，不重述这轮之前的产出」。
2. **产物卡片和「已完成」被切在两段里。** 产出行读的是 call view，而 `video_generate`
   的调用发生在第一轮，所以文件片永远挂第一轮；第二轮只有 `job_output` 的读卡片，模型只能
   抄一串绝对路径给用户看，**真正能点开的那张片子在上面一段**。这是产出行契约的必然结果
   （上一节那条硬约束的另一面），跟 `ui-media` 那步一起解。
3. **唤醒轮在视觉上并进上一轮。** 判据内核给得出：`user/message` 事件带 `source`，唤醒那轮是
   `{kind:'plugin', plugin:'tool-jobs'}`，而 `TurnLocation.start` 就是那条 `turn/start`
   （`core/agent-loop/tests/loop.spec.ts:1306-1326` 证明两个 followup 各开一轮且 `source`
   各自保留）。所以「这一轮是谁开的」是可判的，不用靠猜文案。

#### 产物预览：主线在 DSH 客户端，缺的是一条文件通道而不是预览库（2026-08-19 查证）

起因是「md、视频这些点开都走系统程序」。查完分三层，第一层就纠正了一个会白干的判断。

**一、别在旧壳上做。** 旧壳那套 `.artifact-preview` 抽屉（`Workspace.tsx:5218-5317`：文本上限
512 KB、图片 6 MB 转 base64、`TEXT_EXT` 白名单之外一律「不支持文本预览」，限额在
`src/main/workspace.ts`）属于 openclaw 那边，本文档第七节已经把它划进「旧壳遗留，不在 DSH
主线上」。用户现在跑的是 DSH compatibility 外壳（`dsh-plugin-desktop/src/profile.ts:1` 原话：
composition over the **official Web bundle**），界面整套是内核一方客户端。在旧壳上补 PDF、
视频预览，是给一个正在下线的壳投资。

**二、「点开走系统」是内核的设计，不是我们漏接。** 产出行加 Host opener 就是内核给产出文件的
完整答案（`TurnTailOwnerProps.openFile`，`ui-conversation/src/client/contract/slots.ts:326-330`）。
真正缺的是另一样东西：**客户端没有通用的「读本地文件字节」通道。** `packages/client` 全搜
下来只有 `loadImage(attachment)` 一条（同文件 `:365`），走的是 session 授权的图片附件；而视频
进不了附件库（`ImageMediaType` 没有视频成员，见本阶段「视频产物显示」那节的定价表）。
**所以内联播放的第一步是造这条通道，而不是挑预览库。**

**三、这条通道的现成答案在 WorkBuddy 手里。** 它注册一个 `local-file://` 协议，处理器就是把
路径交给 `electron.net.fetch(filePath)`，再在 CSP 的 `img-src` / `media-src` 里放开
`local-file:`，然后 `<video src="local-file://…">` 直接播——解码全归 Chromium，零第三方库。
它连能播的扩展名白名单都单独切了一个 chunk（视频是 mp4 / webm / ogv / ogg / m4v / mov / 3gp，
音频另一份）。取法照 `SKILL.md` 的「WorkBuddy 的界面源码怎么读」：协议注册在 `main/index.js`
里搜 `local-file`，白名单和分派器在 renderer 侧按语义搜，**文件名带构建 hash，别写死**。

据此定该弄与不该弄：

| 类型 | 做不做 | 依据 |
|---|---|---|
| 视频 / 音频 | **先做这一档** | Chromium 原生解码，只欠那条通道；而且是用户当下的痛点（刚出的片子要跳出应用才能看）|
| PDF | 同一条通道，随后 | ClawX 的取舍值得照抄：**不用 pdf.js**，读字节 → Blob URL → `<iframe>` 让 Chromium 的 PDFium 画。`ClawX/src/components/file-preview/PdfViewer.tsx` 自己的注释写明理由是避开 CMap/CID 字体在中文生成 PDF 上的白屏 |
| Markdown / 纯文本 / 代码 | 看对齐目标再定 | 旧壳已经内联渲染 md，这不是能力缺口而是产品选择 |
| Office 三件套（docx / xlsx / pptx）| **不做** | WorkBuddy 是 `docx-preview` / `@fortune-sheet/react` / `pptx-preview` 三套库各自适配，还挂了腾讯文档 SDK 兜底。这是「一个一个适配」的重灾区，而这三类恰是我们产品最少产生的文件 |
| drawio / excalidraw | **不做** | 我们没有产生这类文件的工具 |

所以「是不是每种格式都得单独适配」这个问题的答案是分裂的：**图片 / 视频 / 音频 / PDF 四类
不用**，Chromium 全包、共用一条通道；**Office 那三类必须逐个适配**，而且没有可靠的
all-in-one——查过 npm 与开源方案，维护中的都是单一用途库，all-in-one 要么停更要么小众，
商业的贵。

**动手前要拿到的那条真机输出**：在 DSH 的 web 客户端里手挂一个 `local-file://` 的 `<video>`，
能播再往下写。验不过说明通道形状不对（CSP、协议特权、Range 请求任一环），那时候写下的每行
播放器代码都是白写。

#### 图生视频接完了：那条「已知阻点」不存在，本地字节直接进 `images`（2026-08-19 真机验完）

上一版这里写着「`images` 收的是公网 URL 数组，我们手里是本地字节，data URI 收不收未验」。
**验了，收，而且上游真拿它当首帧。** 一发真机（137 KB 的巷子猫 JPEG 折成 data URI 提交）出片
116 秒，抽首帧就是那张照片本身。中转站那侧也解释得通：`unified_video/adaptor.go` 的
`BuildRequestBody` 就是把 dto marshal 了原样转发，整条路径上没有 base64 处理也没有上传，
所以答话的只能是上游。**回执里 `detail.input.images` 回显成 `[""]` 是回显把长串抹了，不是被剥掉**，
别把它当成没收到的证据。

于是不需要图床。文档包里那条 `POST /mj/submit/upload-discord-images`（收 `base64Array`、
回 URL 数组）留作备用，这次没用上。

工具这侧多了一个 `animate_last_image`，形状是被两条内核事实逼出来的：

| 事实 | 出处 | 逼出什么 |
|---|---|---|
| `presentCall(args)` 只拿到 args，且重放时会再算一遍 | `dsh-tools` 的 `presentCall` 注释 | 产物路径必须是 args 的纯函数 → 图的身份不能只活在执行期 |
| 模型看不到任何附件 id：用户发的图是 `ImageBlock`（它只看得见画面），我们生成的图**故意不进模型内容** | `media/tool.ts` 的设计；`ImageBlock` 只带 `attachment` | 模型没法把「哪张图」当参数传 → 只能由工具自己去会话里取最新那张 |

取法是走会话日志：`exec.agent.session.events` 一遍过——`user/message` 里的 `ImageBlock`
（用户发的），以及 `tool/call` 名字对上 `image_generate` 的那条 `tool/result` 的 `meta`
（我们画的，`presentationMeta` 就存在那儿）。`ToolResultMessage` 不带工具名，只有 `callId`，
所以工具名要靠 `tool/call` 配对，不能靠 meta 形状去猜。

真机验的四件事：

| 验什么 | 结果 |
|---|---|
| 画完接着出片（同一轮） | 「先画一张 9:16 的雨夜霓虹街头…画好后直接做成视频」→ `image_generate` → `video_generate · 9:16` → 8 秒 720x1280，**首帧就是那张图，满幅无黑边** |
| 上一轮的图也能拿 | 柴犬那轮：先画（2048x2048 方图），下一条消息说「把这张图做成视频」→ 首帧是那只柴犬，方图塞进 9:16 上下留黑边 |
| 会话里没有图 | 新会话直接说「把上一张图做成视频」→ 工具当场报错（不是等六分钟后失败），模型转述成两个可选项。取图**只看当前会话**，不跨会话 |
| 取图逻辑对真实日志成立 | 拿本机 36 份会话日志跑一遍 `findLatestImage`：4 份命中，尺寸与当时那几张对得上（2048x2048、1600x2848）|

顺带修掉一件模型没法自己知道的事：**它看不到图的尺寸**（我们的图不进模型内容），所以第一版
它给方图猜了个 `9:16`、嘴上却说用的 16:9。现在没显式传 `aspect_ratio` 时由参考图自己定横竖，
并把「首帧用的是哪来的图、多大、出片什么比例、会不会留黑边」写回工具结果里让它照着说。

**今天还够不着的一条**：用户自己拖图进来这条路，被模型模态挡着——`dsh-host-apiproxy` 按
`inputModalities` 拒收，而我们 profile 里两个模型都是 `input: [text]`，所以窗口里根本没有附件入口
（附件面板的文案就是「drops are currently refused」）。代码里那条分支照写（形状是内核的），
但**模型侧的话术不许提「让用户发一张」**，免得许诺一个界面给不了的动作。等清单里进了能收图的模型，
这条自动就活。

#### 阶段 3 / 5 定案（2026-08-18）：内容用 WorkBuddy 的，分发走内核的目录，不造市场内核

联网查了官方仓库、文档站（skills / agent-presets / core）、以及社区那几家
「DSH 插件市场」（dshplugin.world、w2112515/dsh-plugin-marketplace、NanmiCoder/dsh-plugin-market）。
再回 rc.6 的类型与 README 核对。三条必须分开的事实：

1. **DSH 官方没有专家/技能商店。** 官方发现渠道是 GitHub topic `dsh-plugin`，
   安装命令是 `dsh plugin add github:owner/repo`——那是 **Cordis 插件**（改运行时能力），
   不是人设内容。社区那几家市场也是在扫这个 topic、往 profile 里 `pnpm add`。
   **不能拿它们当专家市场来抄**，产品不是一回事。
2. **专家的分发单位内核已经定死：一个 preset 目录。**
   `copy()` 是内核唯一的创作写入，而且**拒绝调用方提交组装文本**
   （`dsh-agent-presets/lib/types/authoring.d.ts:8-11`）——所以市场安装不能走 `copy()`，
   只能自己把目录写进可写根。发现不做缓存，写完刷新页面即可。
3. **WorkBuddy 的内容形状已经在本机。**
   `C:\\Users\\000\\.workbuddy\\plugins\\marketplaces\\experts\\plugins\\<slug>\\`
   共 22 个包。单体专家是 `agents/<name>.md` + `skills/` + `plugin.json`
   （`expertType: agent`）；专家团多几个 `agents/*.md` 和 `teamInfo.leadAgent / memberAgents`
   （`expertType: team`）。旧壳错在把这些平铺进 `~/.openclaw/skills` 再用
   `skill-visibility.ts` 藏名录——内容没错，落点错了。

**三落点，对内核三套根，不要混：**

| 装什么 | 落到哪 | 内核怎么看见 | 信任 |
|---|---|---|---|
| 出厂几个专家 / 专家团 | 桌面包自己的 `config/agent-presets/<id>/`，组合里加一条 `system` 根（**不要**写进 `@deepseek-ai/dsh/config/agent-presets`，升级会覆盖） | `ctx.agentPresets.list()` | `system`，只读、升级覆盖、选择器不当作用户创作 |
| 市场装的专家 / 专家团 | `$DSH_HOME/.agent-presets/<id>/` | 同上，`includeUserRoot` 默认就会扫 | `user`，可删；卸载走 `ctx.agentPresets.remove(id)` |
| 市场装的**独立**技能 | `$DSH_HOME/skills/<id>/` | 出厂 `standard` / `code` / `cordis` 的 `skill-filesystem` 默认 `includeDefaultRoots: true` | 用户技能根。**这一格原先写「专家 preset 必须 `includeDefaultRoots: false`」，2026-08-19 已推翻**：出厂 `cordis` 自己带技能也只**加**一个根（见下面「技能根」一节的裁决） |
| 连接器 | profile 用户层一行 MCP（阶段 5 已定） | `dsh-mcp-client` | 与专家无关 |

**WorkBuddy 包 → preset 目录的映射（内容保留，机制换掉）：**

| WorkBuddy | DSH preset |
|---|---|
| `plugin.json` 的 `displayName.zh` / `displayDescription.zh` | `preset.yml` 的 `name` / `description`；`id` 是目录名，必须 `[a-z0-9][a-z0-9-]*` |
| `agents/<lead>.md` 正文 | `dsh-persona` 的 `text`（身份指令里的 CodeBuddy 换成 OpenLux） |
| `skills/*` | 档内 `skills/` + `skill-filesystem.customSkillDirs` 指向 `new URL('skills/', baseUrl)`（**只加根，不关默认根**，同上已推翻） |
| 专家团 `teamInfo.memberAgents` | 一成员一行 `dsh-tool-subagent`：`toolName` / `persona` / `toolFilter`（**显式 deny 全部 `delegate_*` 和 MCP 工具**，闸门已踩过） |
| 成员加入哪份组装 | **不要**给成员单独 preset。内核规定子代理 `composeFrom()` 加入父方常驻组装（README「组装子 agent」），成员技能名录 = 团的 `skills/` |
| 头像 / 开场白 / 快捷提示 | 内核 `preset.yml` 只有 name/description/order。这些是**市场画廊**的字段，挂我们自己的 gallery，不要塞进组装文件 |
| 已安装列表 | **不要再养一份 `experts.json`。** WorkBuddy 自己也没有；内核 roster（盘上有哪些 preset 目录）就是已装列表 |

**界面：内核已有的用内核的，市场画廊才是我们加的。**

- 选择专家 = 内核的新建会话 chip + 设置页「Agent 预设」卡片（复制 / 删除 / 设默认 / 打开目录）。**不重做选择器。**
- 浏览 / 安装 / 更新 = 我们的市场画廊（WorkBuddy 专家中心那个结果）。内核没有商店 UI，这是被逼自己做的那一层；槽位走 `settings.section` 或侧栏，具体挂哪等画廊动手时再对 WorkBuddy 解包，不提前发明。
- 装完刷新一次页面——缓存在浏览器选择器，不在内核。

**admin-server 制品：格式加版本，不能一刀切。** 旧客户端还在拉 openclaw 形状的 zip。
新制品是 preset 目录的 zip（`preset.yml` + `agent.cordis.yml` + `skills/`）。
`desktop_market_item` 加内核/格式字段，snapshot 按客户端能力过滤。下载直链机制不动。
转换器跑在导入侧（`ImportExpertCenter`），本机 WorkBuddy 包是输入，preset 目录是输出——
客户端不要在运行时解析 `agents/*.md`。

**先内置、后市场。** 出厂先落 1 个单体 + 1 个专家团，用真 WorkBuddy 内容把
「人设接管 / 技能只在该专家名录 / 团员 toolFilter」再跑一轮；过了再接 snapshot 安装。

#### 市场安装重判（2026-08-18）：管理那半边内核已经做完了，我们只做「浏览 + 安装」

上一节写"内核没有商店 UI"是对的，但漏了一件更值钱的事：**「已装专家的管理」内核自带一整套**，
而且我们仓里就躺着上游自己的市场规范。两处都要拿来用。

**一、上游 `dsh-community-market` 是我们 subtree 进来的包，规范先于实现。**
`yunwu-desktop/dsh/dsh-community-market/`（归属 `anywhere-labs/deepseek-harness-desktop`）只有
文档、没有 src，自称 Phase 0「文档优先的初始化工程，现在不要加进 DSH profile」。它给了两样东西：

- **市场壳设计**（`docs/market-shell.zh.md`）：Host 管目录 I/O、校验、标准化、安装编排、取消、
  串行化；renderer 只经普通 route/RPC 收标准化纯数据，拿不到 Electron / fs / 包管理器。
  安装必须两步意图，确认框展示锁定后的精确目标 + 当前 profile + 「以用户权限本地运行」提示。
  **绝不执行目录返回的命令字符串**；远程字段只当文本渲染。失败矩阵逐条列了副作用。
  这套规则与我们的专家市场完全适配，**照它做**。
- **目录提供方合同**（`docs/catalog-provider-contract.zh.md` + 4 个 JSON Schema）：来源 manifest、
  query、不可信 provider page、Host 标准化响应。

**但它的 wire 条目装不了"专家"**：`catalog-provider-page.schema.json` 的 item 是
`additionalProperties: false`，且 `anyOf` 要求必须带 `repository` 或 `package`（`registry` 写死
`const: "npm"`）。专家是内容制品（tar/zip + 版本 + 摘要），既不是 npm 包也不是 git 仓库，
**结构上表达不出来**。它的安装路径也是 `desktopPnpm.runPlugin('add')` → 装 Cordis 插件 → 提示重启，
跟"写一个 preset 目录、立即可用"是两件事。所以：**壳规则照搬，wire 格式自己定**——
这是"查不到先例才自己设计"的那一类，代码注释里要写明被什么逼的。

**二、内核已有的管理界面（真机 2026-08-18 实见，advanced 模式）。**
设置页第四栏「Agent 预设」（`settings.section`，排在「模型」之后）就是完整的已装列表：

| 行的信任 | 内核给的动作 |
|---|---|
| `system`（出厂） | 设为默认 / 查看（只读查看器） / 复制 |
| `user`（市场装的、手工创作的） | 设为默认 / **打开目录** / 复制 / **删除** |

`broken` 行渲染成红框标记卡、原样展示原因、禁用设默认与复制，但**保留删除**（这正是清幽灵目录的入口）；
没有可写根时整栏降级为只读浏览（`authorable: false`）。`agentPreset.read/copy/openDocument/remove`
钉在环回地址，`list` 不钉（局域网客户端的选择器要用）。

**所以卸载、改默认、打开目录、看组装、坏档处置，一律不做**——我们做的只有"浏览市场 + 装进来"。

**三、安装机制已在真机验通，零代码、零重启、零刷新。**
拿一个没上过的真制品 `ad-creative-strategist`（`%TEMP%\ec-sweep\ex\` 下共 **409** 个 tar 解包目录，
形状就是 WorkBuddy 专家包）：物化 → 整目录放进内核报告的可写根
`$DSH_HOME/.agent-presets/ad-creative-strategist/`。应用全程没重启、页面没刷新，
再开设置页就看见「点睛睛」落在**自定义**组，描述正确，四个动作齐全（设为默认 / 打开目录 / 复制 / 删除）。
名录在**自身操作、`settings/changed`、`connection/reset`** 时重读（`dsh-client-ui-agent-preset`
README「已知限制」），所以装完不必让用户刷新页面——上一节那句"装完刷新一次页面"就此作废。

安装器因此只有五步，每步都压在内核既有判据上：

1. `ctx.agentPresets.authorable` 为假直接拒绝并说明原因（别给一个点了必然失败的按钮）。
2. 落点取 `writableRoot(ctx.agentPresets.roots)`，**不要硬编码 `$DSH_HOME/.agent-presets`**——
   内核注释明说这条根是 `includeUserRoot` 的默认值，路径归它。
3. id 用内核的 `PRESET_ID` 校验；已被占用就拒绝（对齐 `copy()` 从不覆写）。
4. 先解到临时目录再原子改名进可写根，避免半个解包占住 id 变成 `broken` 幽灵。
5. 装完用 `list()` 复验：新行必须在、`broken` 必须为空；不然按内核给的 reason 报错并回滚。

卸载不写代码（内核卡片的删除按钮就是）；要在自己界面上提供入口时调 `ctx.agentPresets.remove(id)`，
它会拒绝出厂档，也会顺手清掉指向它的默认值。

**四、市场归属记在 sidecar，不能进 `preset.yml`。**
`preset.yml` 按内核定义**只承载显示文本**（name / description / order），而 `copy()` 会重写它的
name 与 order。所以"这条是市场装的、版本多少"写成档内独立文件 `openlux-market.json`。
这与旧册子那条教训同源：归属别写进会被整目录换入冲掉的正文。

**五、对账判据换成内核的健康结论。** 旧壳的自愈判据是"不只比版本号，还要看人设在不在盘上"；
DSH 上这件事内核替我们做了——`list()` 里 `broken` 带原因就是权威结论。
下架清理只扫「`user` 行 + 有我们 sidecar + id 命中目录快照」这三者的交集，
手工创作的副本（别的 id、没 sidecar）永远不动。

**六、一个物化器两用。** `scripts/materialize-expert.mjs` 加了 `outRoot`，
出厂就写桌面包 `config/agent-presets/`，做市场制品就写临时目录再打包——
避免"出厂一套逻辑、市场另一套逻辑"这种必然走偏的分叉。

#### 长跑命令别用终端捕获判断进度（2026-08-18，代价二十分钟）

跑那种十分钟量级、输出极多的一次性命令（导入器就是），**终端捕获文件会在约 1 MB 处停止增长**，
而进程还在正常跑。表现出来的形状极像挂死：最后一行时间戳定在某一刻不动、文件大小分秒不变、
`Get-NetTCPConnection` 还能看到几十条 ESTABLISHED。我照这个形状连着推断了三轮（先怀疑我新加的
图床上传、再怀疑上游下载、最后怀疑 MySQL 死连接 + DSN 没有 `readTimeout`），甚至去查了服务端
`information_schema.processlist`——**全部作废**：真日志（`Tee-Object` / `*>` 写的那个文件）
一直在长，5.3 MB / 18915 行，末尾明明白白写着 `IMPORT_EXPERT_CENTER done, exiting`，10 分钟跑完。

两条纪律：

- 长跑命令**必须**自己重定向到文件（`*> path.log`），进度只看那个文件，不看终端捕获。
- 判"挂住"之前先取一次**权威证据**：进程还在不在、真日志末尾是什么。ESTABLISHED 连接数
  说明不了挂住（里面本来就有连接池的空闲 keep-alive），这个数字骗过我两次。

#### 真机形状的两个坑（2026-08-18 踩到，探针纪律）

- **外壳档位是 `$DSH_HOME/settings.yaml` 里的一项设置，两档都是上游自带的**
  （`dsh-desktop: mode: compatibility | advanced`，默认 compatibility——见 `profile.ts:55`
  的 `DEFAULT_DESKTOP_SHELL_MODE` 与 `index.ts:41` 的 `.default('compatibility')`；advanced
  带着上游自己的设计说明书 `dsh/.agents/notes/implemented/architecture/2026-08-15-desktop-advanced-shell.md`）。
  **2026-08-18 决定：跑 compatibility，即默认档**，用户要原生标题栏。这里没有"改回内核原生"
  这回事——两档都是内核原生，我们只是从非默认档退回默认档。
  仓库里**没有任何代码写过这个值**（`yunwu-desktop/src` 搜 `advanced` 零命中，会写它的只有上游
  自己的 `tests/profile.spec.ts:210` 和自检脚本 `verify-profile-boot.mjs:31`）。
  肉眼判据：compatibility 带标准 Windows 标题栏，advanced 是无边框头部；跑任何界面探针前
  先看 URL 里的 `dsh-desktop-mode`，那才是宿主真正组装出的那一档。
  顺带验清：我们写清单那条路（`settings.mutate`）**不会**清掉别人的命名空间——
  手加的 `dsh-desktop` 段经过一次启动重写后仍在。
- **advanced 是怎么长驻的：把从未持久化过的非默认设置当成"丢了"去修复。** 这条记下来是因为
  它不是外壳问题，是判断问题，换个题目还会犯。评估期开 advanced 只为回答"界面能不能替换"，
  先试 `?dsh-desktop-mode=advanced` 撞了 `service "layout" has been registered`，改把
  `dsh-desktop: mode: advanced` 写进**官方安装版的家目录**，把那个正式版搞成了首次运行状态
  （要 API Key、会话列表空），排查未果后**已经撤回**；而且同一轮读源码得出的结论恰恰相反——
  「换位置靠的是 slot，不是 advanced，这套机制在兼容模式下一样可用，不必开 advanced」。
  真正让它留下来的是后面那次：开发家目录里 advanced 一度在跑，十几分钟后应用起成 compatibility、
  `dsh-desktop` 段不见了，第一反应是"这段丢了、可能是我们的 `settings.mutate` 清的"（那会是真 bug），
  查明**它从来没被持久化过**之后，动作却仍是把它写回去、记作"复位"——因为同一时刻确实有一处要复位
  （登录会话被留在 `.credentials.yaml.user-session` 没放回），两件事被当成一件事一起修了。
  此后"无边框头部"就成了判断应用健康的肉眼标准（当时原话：「截图里是标准 Windows 标题栏，
  说明它起在 compatibility 模式，不是我们的 advanced 外壳」），上面那条判据最初就是这么写下来的。
  **纪律**：发现某个设置不在了，先查它的默认值和"谁写过它"，确认它究竟是丢失还是本来就没有；
  同一轮里有真要复位的东西时，尤其要把两件事分开做，别让一次"顺手复位"替你做了产品决定。
- **换档不动我们自己的东西（2026-08-18 真机逐项复验）。** compatibility 下实测：侧栏余额条
  `$84.50` 在、设置第五栏「市场」在、目录卡片与筛选（全部 / 专家 / 专家团 + 七个分类）正常、
  详情三条提问条照常渲染、点提问条后弹窗关闭 + 输入框落字 + 预设标签切成「腾讯HR数智专家」——
  召唤端到端通。所以 `openlux-plugin-account` 里原先那句"会话流只存在于 advanced 组合"的注释
  是错的（已改）：那条绑定要的是 `sessions` / `workspaces` 服务，两档都给。
- **「设置蒙层跟官方版不一样」是底色差异，不是蒙层。** 两边蒙层都是 `rgba(0,0,0,.24)` +
  `blur(2px)`（`VOzbGW_mask`），像素实测都是均匀压暗 24%。差别在底：advanced 把 `body` /
  frame / 侧栏全设成透明去吃 mica（`client/styles.ts:13-15`，上游自带，且 `tests/client-environment.spec.ts:57`
  就在断言那条 `--dsw-specific-sidebar-fill: transparent`），于是侧栏底是白 mica，
  `#FFFFFF × 0.76 = #C2C2C2`；compatibility 下 `bodyBg` 是实心白、侧栏是不透明浅灰，
  官方版实测 `#BDBEC0`，回推底色 `≈#F9FAFD`。查这类"看着不一样"先量像素再回推，别靠肉眼比。
- **别用手工导航去救僵尸窗口。** 宿主换端口后老渲染器停在旧端口上，看着还有界面但所有请求
  `ERR_CONNECTION_REFUSED`；这时若照旧 URL 带 `?dsh-desktop-mode=advanced` 导到新端口，
  而宿主是按 compatibility 组装的，就会报 `failed to apply loader entry (dsh-plugin-desktop):
  service "layout" has been registered`——查询串必须与宿主组装出的模式一致。正解是重启，不是导航。

#### 品牌换成 OpenLux（2026-08-18 真机验通）：标题有内核的缝，字标只能靠样式

界面里自报 DeepSeek Harness 的地方有三处：侧栏字标、页面标题（= Windows 原生标题栏与任务栏
悬浮提示）、窗口 / 托盘图标。这一轮换掉前两处，第三处的代价单独记在下面。

**标题：内核给了缝，一处改完三处生效。** `dsh-host-webserver` 的服务上有
`tapIndex(transform: (html) => string)`——纯 html→html 变换，由 fallback 座位（dist 服务器）
在每次 index 响应上按注册顺序应用。它够用是因为另外两条事实：compatibility 窗口的原生标题
跟着 `document.title` 走（构造时给的 `title: 'OpenLux'` 在页面加载后就被盖掉，这正是用户看到
"DeepSeek Harness" 的原因）；而前端的会话标题是 `useRef(document.title)` 取的基准值
（dist 里 `document.title = n === void 0 ? r.current : \`${n} — ${r.current}\``）。
所以改服务出去的那一行 `<title>`，标题栏、任务栏、每条会话标题一起对。

**字标：没有缝，这是查出来的，不是猜的。** `ui-sidebar` 的 slot 合约把话说在文档里——
"The shell owns column geometry (fold state machine, brand row, New Session)"，声明的洞只有
`sidebar.workspaces` / `sidebar.settings` / `sidebar.footer.action` 三个，**没有品牌行那一格**。
画的东西是 `dsh-client-ui-primitives` 的 `BrandWordmark`，运行时住在平台模块层
（`dsh-web-frontend/dist/assets/index-*.js` 里 `BrandWordmark: vf`），插件的 `lib/client.js`
只是按外部引用它（`_deepseek_ai_dsh_client_ui_primitives.BrandWordmark`）。于是只有三条路：
用 yarn patch 改上游包（我们已有这个机制，`dsh-client-ui-agent-preset` 就打着补丁，但这次要改的是
minified 的 vendor chunk 里十七条 path）、整份 fork 侧栏外壳（连折叠状态机、会话列表接线、
各种弹窗一起接走）、或者样式覆盖。选了样式覆盖，因为它是三条里唯一不接管别人代码的。
顺带排掉一个同名误会：`@deepseek-ai/dsh-brand` 是 `Branded<B>` 名义类型原语，跟品牌无关。

**选择器要挑不会随构建变的那个。** 类名带每次构建的哈希（`hHd-Xa_brand`），选它等于把
下次 `yarn build` 当成敌人；`viewBox="0 0 182 24"` 是组件文档里声明的比例
（"width keeps the 182:24 ratio"），这才是稳的钩子。于是
`button:has(> svg[viewBox="0 0 182 24"])` 里把 svg `display: none`，`::before` 拉 24px 的
mark，`::after` 写 `OpenLux`，颜色用 `--dsw-alias-label-primary`（暗色下自动翻白，实测
`rgb(249,250,251)`）。收起态不用管：真机验到侧栏收窄后品牌行**整个不存在**，只有展开一态。

图走宿主自己的路由：`build/openlux-mark.png`（1024 原图压到 96px，9 KB）+
`webServer.register({kind:'exact', path:'/openlux/brand-mark.png'})`，和出图那条
`/openlux/media.image` 同一个缝。没有把它塞成 data URI——源码里不放 base64 大块。
资产要同时进 `files` 与 `build.files`，后者漏了只在装机版上少一个字标，别处一声不响。

**守卫按"用户看到什么"写，不按形状写：**

- `verify-profile-boot.mjs` 已经在 fetch 根页面，就地断言正文含 `<title>OpenLux</title>`、
  不含 `DeepSeek Harness`，再 fetch 一次 `/openlux/brand-mark.png` 要 200 + `image/png` +
  非空。反向验过：把 `installWebBrand(ctx)` 摘掉即红（`assembled Web root serves the upstream
  product identity`）。
- `tests/web-brand.spec.ts` 读**真实的** dist `index.html` 与它指向的入口 chunk，断言那条
  viewBox 字面量还在。上游哪天重画字标，这里红，而不是侧栏悄悄变回 DeepSeek。
- `tests/plugin.spec.ts` 断言 tap 与图片路由都注册上了；顺带发现 `verify-loader-boot.mjs`
  的 `webServer` 假体缺 `tapIndex` 就整棵树起不来——那些假体也是接口契约的一部分。

**真机**：`document.title = "OpenLux"`，`Get-Process electron` 的 `MainWindowTitle` 是
`[OpenLux]`，品牌行 216×24 里 svg 已 `display: none`、mark 从
`http://127.0.0.1:56592/openlux/brand-mark.png` 取到 9,309 字节、`::after` 内容 `"OpenLux"`；
亮暗两套底色各截一张都对。

#### 图标换成 OpenLux（2026-08-18 真机验通）：一份提交进仓库的画，派生出三家产物

上一轮只换了字和标题，鲸鱼还在四个地方：原生标题栏左上角、Windows 任务栏、托盘（隐藏图标区），
以及**新会话页那个空态图**——最后这个不是同一块画，字标是 `BrandWordmark`，空态与收起态的栏顶
用的是同一个 `FishLogo`（`viewBox="0 0 23.16 17.04"`，组件文档同样把比例写成合约）。
所以界面侧是第二条 CSS，不是把第一条推广一下。

**界面侧：换画不换盒子。** 字标那处是「藏掉 svg，用 `::before/::after` 重画一行」，因为要把
182×24 的横向字标换成「图 + 字」；`FishLogo` 这处相反——每个使用点自己决定尺寸（栏顶 24×18、
空态 34×25），所以规则是给 svg 自己贴背景、藏掉它的 `path`：一条规则同时管住栏顶、空态，以及
将来还没遇到的使用点。真机两态都验过：展开态字标 216×24、空态 34×25 都取到 mark；收起成 rail
后栏顶那格变成「展开按钮里画着 logo」，也一起对了（顺带修正上一轮记的"收起态品牌行整个不存在"，
那次是没看 rail 的 `logoRow`）。

**图标侧：源头只留一份画。** `build/openlux-mark-source.png`（用户给的 1024 原图）进仓库，
`scripts/generate-brand-icons.mjs` 从它派生两件：`app-icon.png`（任务栏 / 标题栏 / 安装器 /
mac 图的源）与 `openlux-mark.png`（界面那张 96px）。中间踩到的坎是 mac 那条流水线的几何断言：
`generate-mac-app-icon.mjs` 要求源是 1024² RGBA16 + ICC，且产物 trim 出来必须正好 824² 落在
(-100,-100)——换句话说**源图的墨必须顶到四边**。用户给的图四周有留白（墨框 720×726），
直接用会红。所以派生时先 trim 到墨框，再按 `fit: 'fill'` 撑满 1024²（0.8% 的形变，肉眼无感），
补上 `rgb16` + sRGB ICC。界面那张则用 `fit: 'contain'` 保比例，它要的是「填满 24px 的格子」。

**托盘：上游用 SVG，我们改成从同一张位图派生，这是被资产形状逼的。** 运行时两边一样——
Electron 的 `nativeImage` 读不了 SVG，上游那份 `tray-icon.svg` 只是构建期原稿，sharp 把它栅格化成
六张 PNG（template 16/32 给 macOS，blue 16/20/24/32 给 Windows，`@2x` 由文件名约定被自动选中）。
差别只在原稿层：矢量能任意尺寸精确重栅格、能靠字符串替换改色、改动在 diff 里看得见；位图这边
最大产物 32px 而源图 1024²，只做缩小、余量 32 倍，**唯一真实代价是 16px 上的毛边**（这张画的笔刷
边缘缩小后留下半透明锯齿，放大 6 倍能看出来）。改色改成拿图自己的 alpha 当蒙版整片填色——
成立是因为托盘图标本来就该单色（macOS template 必须纯黑 + alpha）；将来若要双色托盘图，
alpha 表达不了，那时候必须回矢量。留 20% 内边距：方形墨满格会比系统自带托盘图标显得大一号
（上游那只鲸 23.16:17.04 是靠自身比例在方盒里自带留白的）。

> **待办（拿到就换）**：向设计要 logo 的**矢量原文件**（AI / SVG）。有了它值得把托盘换回上游那条
> 形状——16px 边缘干净、改色回到字符串替换、改动在评审里可见，`generate-tray-icons.mjs` 里那段
> flatten 可以删掉；顺带界面那张 96px PNG 也能换成能缩放、能跟深浅色走的矢量。
> 现在没换是因为把位图变矢量得描边，那等于由我手工近似品牌几何形状。

**守卫跟着源头搬家，而不是删掉：**

- `app-icon.png` 的 sha256 仍然钉死（改名为"pins the brand source icon, which no build step
  regenerates"）。它是提交进仓库的画、`yarn build` 不重生，钉住它才能让"某次误跑生成脚本"变成红灯
  而不是一个悄悄换了的任务栏图标。改画就要在同一个提交里改这行。
- 托盘那条从「SVG 里正好一处 `#4D6BFE`、没有 `<style>`」改成验产物：六张各自尺寸对、**每个可见
  像素都是同一个颜色**（template 纯黑、blue 是这张画自己的蓝 `#0493CC`，取自墨色最大的那一桶，
  不是猜的）、且墨没顶到边。期望值写在测试里而不是从生成器 import——读生成器常量的测试是
  「按构造同意」，钉不住任何东西。
- `tests/web-brand.spec.ts` 现在两条 viewBox 都验：上游重画字标或 `FishLogo` 哪个都会红。

**真机**：原生标题栏、Windows 任务栏、托盘隐藏图标区（悬浮提示 `OpenLux Desktop`）、侧栏展开态、
rail 态、新会话空态，六处都换成了 OpenLux；聚合 check 310 passed / 2 skipped。

**还剩两处半没换，别当成完事了：**

- **模型自己会说出上游名字**：`dsh-web-app` 的 `webSurfacePrompt` 写着 "the DeepSeek Harness
  Web GUI at …"，加上前面已经记过的系统提示词 "You are an AI agent powered by DeepSeek Harness"
  （落点 `system-prompt` 那行的 `persona`）。界面换完了，嘴还没换。
- **对外的 `User-Agent` 还是上游的**：`dsh-web-fetch-http` 默认
  `deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)`，`web_fetch` 每次抓页面都这么自报，
  被抓的站点看到的是它。这条是现成旋钮（`Config.userAgent`），改一行补丁就行。
- `manifest.webmanifest` 的 `name` / `short_name`（桌面壳里看不见，只有浏览器安装才用到）。

#### 工具可见面收窄（视频做完之后做；2026-08-18 查过内核与同类产品）

出图、搜索、抓取三个工具现在都是「全局层 + 参数面靠 enum 兜」的形状。要收窄的有三件事，
**内核三个缝都是现成的，都不需要改上游代码**。按价值排：

**一、`web_fetch` 的网络面（2026-08-19 落地并当天自检重做了一遍，补默认不是加谨慎）。**

上游自己把话说在模块文档里：*"Private-network and SSRF protection is not implemented;
do not enable this provider where it can reach sensitive internal targets"*
（`dsh-web-fetch-http/lib/types/provider.d.ts`）。动手前先拿裸 `HttpFetchProvider` 打了一发
本机 HTTP：`127.0.0.1` 上一个返回 `<title>secret</title>` 的服务，**200 / html / 正文原样**，
所以那条警告不是口头上的。同类产品的默认是挡住（Claude Code 的 WebFetch 拒私网，issue #39884
列的段就是 RFC1918 + 127/8 + `::1` + `fc00::/7`；openclaw 有整套 `net-policy`）。

**「DSH 内核这块是空的」有正面证据。** 最硬的一条是上游自己逐项列的缺失清单
（`dsh-web-fetch-http/README.md:49`）：*"no blocking of private, loopback, link-local,
multicast, or otherwise non-public destinations, no DNS-resolve-then-validate,
**no per-hop re-validation** … this provider is an SSRF primitive and must not be enabled
in a deployment that can reach sensitive internal network targets"*。第二条是那个包**唯一**
的纯策略文件 `lib/types/policy.d.ts` 全文只有五个函数——`validateFetchUrl`（http(s)、
无内嵌凭据、长度上限）、`isSameOrigin`、`classifyContentType`、`parseCharset`、
`decoderForCharset`——第 14 行明写 "SSRF / private-network blocking is deferred"。
第三条是全量搜 `allowedHosts|hostAllowlist|blockedHosts|privateNetwork` 与网段字面量，
只命中 webserver / picker / startup 里用来**绑定**本机的 `127.0.0.1`，没有任何判据或旋钮。
唯一长得像旋钮的 `webRuntime.trustedHosts` 是**反方向**的——它守入站 `/api` 的 `Host` 头
（`dsh-client-connection` 的「/api 浏览器信任栅栏」），出网用不上。

顺带一条**方法教训，比这个结论本身重要**：我第一版拿的证据是「用 Grep 工具在
`node_modules/@deepseek-ai` 下搜 SSRF 关键词两轮 0 命中」，那个证据是**假的**——
Cursor 的 Grep 工具在 `node_modules` 下不扫 `.js`（走 ignore 规则），拿一个必然存在的
`defineTool` 去对照同样 0 命中。查内核产物只能用 `rg --no-ignore --hidden`（或直接 Read
文件）。**判据记成：任何「内核里没有 X」的结论，先用一个必然存在的字符串验证搜索真的扫到了
文件，再相信那个 0。** 这次结论侥幸没变（换成上面三条正面证据后依旧成立），但同样的假 0
用在「内核有没有这个旋钮」上，就是自己造一套机制的起点。

落点 `dsh-plugin-desktop/src/web-fetch-guard.ts`（装配行）+ `web-fetch-policy.ts`（纯分类），
**没有改任何内核文件**，机制全是内核的两个缝：

| 缝 | 挡什么 | 挡不了什么 |
|---|---|---|
| `ctx.tools.guard` | 参数里的字面量，理由回给模型 | 要 DNS 才知道的（同步、看不见解析结果） |
| `openlux-http` 把 `HttpFetchProvider` 当传输层 | 连接前 `dns.lookup({all:true})`，任一答案落在私网段就 `WEB_BLOCKED_URL` | **DNS rebinding 本身**（见下） |

**上游那一行不再挂了。** 原来 `web-fetch-http` 和我们的包装并存、靠 `web.fetchProvider` 钉住，
说法是「掉钉就是 `WEB_PROVIDER_AMBIGUOUS` 不会静默退回」。自检时判这个形状本身就脆：
注册表里留着一个未加守卫的提供方，靠一行配置不选它。现在唯一挂的 fetch 提供方就是包装过的那个，
零配置也只能选到它；`fetchProvider: openlux-http` 那行留着是声明，不是开关。
**limits 也不再有第二份**——我们这行的 `Config` 直接复用上游导出的 schemastery `Config`，
45000 只在 patch 里写一次（上一版把默认值抄进了代码，两处要人工同步）。
`config` 整键替换，所以 `searchProvider: deepseek-official` 仍必须一起抄过来。

**段表照 openclaw 抄，因为上一版是我自己拍的、窄了一大截。**
判据来源 `openclaw/packages/net-policy/src/ip.ts:22-117`，连 `ipaddr.js` 都装成它 pin 的
2.4.0。上一版漏掉的：CGNAT `100.64/10`、`multicast`、`broadcast`、`reserved`（含 240/4、
192.0.2/24、203.0.113/24）、IPv6 的 `multicast` / `discard`(100::/64) / `benchmarking` /
`orchid2` / `fec0::/10`，以及**整张嵌入 IPv4 表**——NAT64 `64:ff9b::/96`、6to4 `2002::/16`、
Teredo `2001:0::/32`、ISATAP `::5efe:`。最后这批是真缺口：`http://[64:ff9b::7f00:1]/` 与
`http://[2001:4860:1::5efe:7f00:1]/` 都能通过 URL 解析进来，上一版**放行**，本机有对应网关就等于回环。

**`fc00::/8` 与 `198.18/15` 只在 DNS 答案里容忍，字面量照拒。** 这条是自检时被真机打出来的：
补齐段表后 `https://example.com/` 当场挂掉，因为**本机 `example.com` 解析到 `198.18.0.76`**——
这台开发机在 fake-ip 代理下，`github.com`、`api.openlux.ai`、连不存在的 `.invalid` 域名
全都回 `198.18.0.x`，真实连接由代理按域名转发。国内用户这个配置很常见，照「更严」提交就是
把整个公网挡死。openclaw 撞过同一面墙（`allowRfc2544BenchmarkRange` /
`allowIpv6UniqueLocalRange`，issue #74351），它的旋钮按「配置里的 baseUrl 推出的可信 hostname」
限定作用域；`web_fetch` 的目标是模型任选的，没有这种 hostname 可依，所以我们限定的是**方向**：
占位地址只可能来自 DNS 答案，不可能是模型写在 URL 里的。IPv6 那半还比 openclaw 更窄——
只放 `fc00::/8`（RFC 4193 未指派、fake-ip 池取自这里），真实自分配内网的 `fd00::/8` 照拒。

**「挡住 rebinding」这句话上一版写过头了，改掉。** 业界判据是解析→校验→**钉 IP**
（`undici Agent({connect:{lookup}})`），openclaw 自己就是这么做的（`src/infra/net/ssrf.ts:430`
`createPinnedLookup` + `createPinnedDispatcher`）；不钉就留着 TOCTOU 窗口，Budibase 那个 CVE
正是「pin 了 `http.Agent` 但 undici 用自己的 dispatcher 重新解析」。而
`dsh-web-fetch-http/lib/index.js:226` 的 `requestOnce` 用的是**全局 `fetch`，没有 dispatcher 参数**，
复用它当传输层就注定钉不了；它每跳 redirect 还会再 `fetch` 一次，我们只在最外层校验过。
要钉就得自己接管传输层（redirect / 字节封顶 / 编码判定全接过来），那是另一个量级的加法。
所以这层的定位是**缩小可达面 + 让模型当场读到理由**，不是安全边界（agent 还有 shell）。
同源重定向上游本来就拒，公网 302 跨域到内网那条路不通。没有做 `allowPrivateNetwork` 逃生口，
也没有做 pre-execute `ask`。

真机 / 装配验过的：

| 验什么 | 结果 |
|---|---|
| 真工具管道 | 装配里 `ctx.tools.execute({name:'web_fetch', arguments:{url}})` 打回环与 `http://2130706433/` 两发，都 `isError` 且正文是 `Blocked: … is not a public HTTP(S) target (loopback address). …` |
| 判据真在跑 | 把期望文本临时改成一个不可能匹配的串，`verify:profile` **变红**并打出上面那句真实拒绝文本；改回后绿 |
| 回环 HTML | 同一份装配里 `ctx.web.fetch('http://127.0.0.1:<port>/')` 抛 `WEB_BLOCKED_URL`（这页本来是 html，裸提供方会 200）。这条现在同时兼掉「pin 掉了 / 行没挂上」——那两种情形报的是 `WEB_PROVIDER_*`，不是 `WEB_BLOCKED_URL`。上一版读 `ctx.web.fetchProviderId` 那条断言删了：d.ts 里它是 `private` |
| 公网 | 编译产物直接跑：`https://example.com/` 与 `https://www.iana.org/help/example-domains` 都 200 / html / 标题对得上（且都是经 fake-ip 解析的） |
| 字面量 | 同一发里 8 个全拒且理由准确：`127.0.0.1`、`198.18.0.76`、`[64:ff9b::7f00:1]`、`2130706433`、`[2001:4860:1::5efe:7f00:1]`、`100.64.0.1`、`[ff02::1]`、`[fd12::1]` |
| DNS 侧 | 注入 lookup：`['93.184.216.34','127.0.0.1']` → `WEB_BLOCKED_URL` 且消息里带那张回环地址；`['198.18.0.76']` → 放行；`['64:ff9b::a9fe:a9fe']` → 拒 |
| 分类器 | vitest 24 条，段表逐段、嵌入 IPv4 五种形式、fake-ip 双向、fail-closed、公网放行 |

一条**被 WHATWG 自己吃掉**的攻击面，顺手记下免得再写一遍死代码：`new URL()` 会把
legacy IPv4 折成点分十进制（`0x7f.0.0.1`、`2130706433`、`017700000001`、`127.1` 全部
`-> 127.0.0.1`，`8.8.2056 -> 8.8.8.8`），`999.1.1.1` 直接 `ERR_INVALID_URL`。所以「非规范字面量」
那条分支在真实路径上永远不触发（上一版单测直接调纯函数才命中，给了假信心）；它留着只为
resolver 答案和导出函数的直接调用者，而 URL 侧的正面判据是 `http://2130706433/` 被当作
`loopback address` 拒掉。

**二、工具名单按角色收窄（下一项；这条我上一轮判错了，代价小得多）。**
上一轮我说「预设层没有 patch 语义，所以收窄工具名单要整份复制预设」——那句话只对
「改预设自己的插件行」成立。**内核另有 `ctx.tools.restrict({allow, deny})`**：
"Per-scope filter over global tools. Restrictions intersect and do not affect scoped
registrations"，并且实现里**强制要求 agent 作用域**（`agent.ctx`），传全局上下文直接报错，
错误信息是 "a context-global restriction would mask every agent — deny the tool for the
intended agent instead"。两处落点：

- **子代理侧是纯配置**：`dsh-tool-subagent` 的 `Config.toolFilter: { allow?, deny? }`
  直接透传，`dsh-subagent` 在子 agent 创建窗口里 `childCtx.tools.restrict(toolFilter)`，
  被限的工具**从提示词里消失且拒绝执行**（一种可见性），断点恢复时还会重放。
  也就是说给专家团成员收窄工具，是往 `cordis.patch.yml` 加一行的事。
- **主 agent 侧需要一薄层**：内核没有声明式的行，得我们在 agent 创建时读配置调
  `agent.ctx.tools.restrict()`。仍然是用内核 API，不是造机制。

外部实践支持这个方向：Claude Code 的子代理 frontmatter 就是 `tools`（allowlist）/
`disallowedTools`（denylist），社区共识是**优先 allowlist、从最小集加起**，并且明确说这是
减小影响面、不是安全边界（有 Bash 的子代理照样能碰网络）。同一句话对我们成立：收窄
`web_fetch` 的可见性不能替代第一条的网络面判定。

**三、用户在对话里指定模型出图 / 出视频（「用 xxx 模型画」），即模型选择面。**

> **2026-08-19 定形（用户口径 + 联网核对 + 真机目录复量）：参数面是对的形状，
> 但真正的瓶颈是清单宽度，而清单宽度是「旧壳接过、DSH 没迁」。**
>
> **用户口径先摆上，它决定形状**：我们是中转站，模型很多，**用这个产品的大多数是我们中转站
> 自己的用户，他们进来时脑子里已经有模型名**。所以**不做界面选择器**——对这批人，
> 「用 flux-kontext-pro 画」就是他们在 API 里写 `model` 字段的同一个动作，
> 选择器是多一层，而且装不下这么长的清单。
>
> 这条把联网查到的行业形状**筛掉了一半**：Picsart 把 59 个模型摆进 playground、
> FluxoKit / Morphic / Chatday 全是「一个画布 + 模型选择器」，那套的前提是
> **用户不知道有哪些模型、要摆出来让他挑**（它们的用户是创作者）。我们的用户画像相反，
> 所以那个形状对我们不成立，别照抄。
>
> **仍然有效的那一半**是 Claude Code 的教训，而且在参数面形状下**更重要**：它的子代理
> `model` 是定义时的 frontmatter（默认 `inherit`），per-invocation 参数取值域
> 只有 `sonnet`/`opus`/`haiku`/`fable` 四个别名，传完整 model ID 会被 schema 拒；
> 解析有四层优先级（env > per-call > frontmatter > 主会话），生产上三个 issue
> **全是静默的**——不在 allowlist 里就悄悄换成别的（#57718）、env 抢掉 per-call
> 而回执里没有任何字段能看出真相、frontmatter 被上层 `--model` 无条件覆盖（#43869）。
> 它们自己提的修法是给 `tool_result` 加 `effective_model` / `clamped_by`。
> **用户明确说了模型名的场景下，这两个字段是入场券**：我们要么真用他说的那个，
> 要么明确告诉他没用、以及为什么。**静默替换是这条路上唯一不可接受的失败形态。**
>
> ### 为什么现在只有出图 3 / 出视频 2（2026-08-19 查实，三层原因）
>
> 现状：出图 `doubao-seedream-4-0-250828`（默认）/ `4-5-251128` / `3-0-t2i-250415`，
> 出视频 `veo_3_1-fast`（默认）/ `veo_3_1`（`media/tool.ts:72-85`、`video-tool.ts:113-116`）。
>
> **一、进表要连尺寸一起进，因为非法 size 不是被拒而是挂住。** `size: '123x456'`
> 跑满 180 秒预算什么都没回，而表里的值 15 秒就回（`tool.ts:58-70` 的一手记录）。
> 所以尺寸做成 `enum` 让模型没法越界，而**一个模型和它的合法尺寸集合是同一个事实**，
> 不能只抄名字。这是「验一个进一个」的直接原因。
>
> **二、目录里有 ≠ 这条路由能服务。** `gemini-*-image-*` 整族在
> `/v1/images/generations` 上回 HTTP 503 + 一串「每个分组都没有渠道」（`tool.ts:44-50`）。
> 所以照目录抄一份名字进来，等于把「选中即必然失败」铺给用户。
>
> **三、根本原因：旧壳早就接宽了，DSH 这一侧是从零重写的，没迁过来。**
> 旧壳（openclaw 内核）时代真机复量过：**出图 23 条**
> （`image-generation` 14 + `images-generations` 4 + `dall-e-3` 4 + `openai-绘图` 1，
> 2026-08-19 拿 `.tmp-probe/v1models-live.json` 那份 478 条目录重数，与册子记的 23 一字不差）、
> **视频在选 19 条** + **十一家专属异步适配器**（MJ / 可灵 / Vidu / 海螺 / PixVerse /
> 百炼 happyhorse / Runway / Luma / Replicate / fal-ai / grok），而且 2026-08-17 下午
> **口径就已经改成「渠道不用管，只管接」**（见 `references/media-video.md` 同名小节）。
> 那套实现在 `resources/yunwu-video-plugin/index.mjs` + `shared/media-endpoints.ts`，
> 是 openclaw 插件形状，DSH 用不了；`openlux-plugin-account/src/media/` 是新写的，
> 只把当场真机验过的几条填进了新表。**所以这不是「当时没接」，是「接了但没迁」。**
>
> ### 零、动手前的方向修正（2026-08-19 真机三条，推翻了下面几节的一部分）
>
> 用 `yw_zhoucongjie` 那把 `auto` 令牌（openlux 库 token 2379977，`routing_priority=auto`，
> 客户端打的就是 `api.openlux.ai`，见 `openlux-plugin-account/src/index.ts:80`）
> 现打 `/v1/models` 与 `/api/model_preset`，得到三条与下面几节冲突的事实。**以这一节为准。**
>
> **一、零新路径的真实分母是 22 条出图 + 3 条视频，不是 46 / 97。**
> 现拉 470 条、85 个端点类型。出图那三个同族类型合起来 22 条
> （`image-generation` 14 + `dall-e-3` 4 + `images-generations` 4），
> 逐个查 `/api/model_preset` 确认**三个类型名指向同一条 `/v1/images/generations`**。
> 视频这侧**`Unified video format` 已经从目录里消失了**（现在 0 条），
> 我们在用的 `veo_3_1` 挂的是 `OpenAI video format` → `/v1/videos`，全族只有 3 条
> （`veo_3_1` / `-fast` / `-components`），我们接了 2 条，只差 `-components`。
> `sora` 在这把 key 的目录里**一条都没有**。所以下面第一节写的
> 「`image-generation` 21 + `Unified video format` 25」两个数今天都不成立——
> 那是更早的快照，而且目录随渠道天天变，**任何写死的条数都会过期，只能现拉**。
>
> **二、这批模型旧壳早就全接完了，而且形状比我这份方案更干净。**
> `resources/yunwu-video-plugin/index.mjs`（**181 KB，2026-08-17 还在改**）是 openclaw 时代的
> 媒体插件，出图认领 33 条（OpenAI 兼容 23 + Gemini 对话端点 6 + MJ 2 + 可灵 2）、
> 视频认领 15 个模型十几家适配器，参数表 82 处。它的做法是：
> **模型名压根不写死**（`assertImageModel` 按端点类型在线校验，`IMAGE_DEFAULT_MODEL`
> 只是缺省值），尺寸只收 `IMAGE_SIZE_BY_ORIENTATION` 那**三个通用安全值**
> （`1024x1024` / `1536x1024` / `1024x1536`，`:562-566`），并且**故意只给 `sizes`
> 不给 `aspectRatios`**，理由写在 `:3632-3634`：给了内核会把比例吸附到清单最近值，
> 而我们真正只区分横竖方三档，清单越长越像在承诺我们并不遵守的精度。
>
> 反过来看，DSH 侧那份逐模型枚举 8 个 size 的 `ROUTE_MODELS`（`media/tool.ts:72-85`）
> **是迁移时新造的、更窄的一条路**。它注释里那条硬约束是真的（非法尺寸不报错、直接挂满
> 180 秒），但旧壳的解法不是逐模型列举，而是固定用三个安全值——**同一个约束，成本差一个数量级**。
> 这是「没查成熟做法就自己造一条路」的又一次现形，而且这次撞的是我们自己三天前的实现。
> **所以第 0 步不是「从零接 22 条」，是「把旧插件已验过的判据搬过来」**，
> 判据表现成的在 `src/shared/media-endpoints.ts`（342 行，主进程与旧插件共用同一份口径）。
>
> **三、真正的 bug 是一条断链：用户在界面上选的媒体模型，到 DSH 这侧不生效。**
> 桌面端**早就有媒体模型选择器**，整条链是通的：选择器 → `saveSelectedMediaModels`
> → `config-writer.applyMediaSelection()` → 写 `agents.defaults.imageGenerationModel.primary`
> 与 `.fallbacks`（`config-writer.ts:220-283`）→ 旧插件消费。
> 而 DSH 侧的 `imageModel` / `videoModel` 只从**插件自己的 composition config** 读
> （`openlux-plugin-account/src/index.ts:70-76, 150-157`），`cordis.patch.yml` 里没有这两行，
> 于是永远落到 `DEFAULT_IMAGE_MODEL`。叠上 `tool.ts:127-133` 那段
> 「不在 `ROUTE_MODELS` 里就换回默认、只打一条 `logger.warn`」——
> **用户选了 `flux-1.1-pro`，实际出图仍然是 `doubao-seedream-4-0-250828`，界面上没有任何提示。**
> 顺带一个对不上的默认值：主进程预勾的是 `IMAGE_MODEL_PREFERENCE = ['gpt-image-2', …]`
> （`shared/public-models.ts:93`），DSH 插件的默认是 seedream 4.0，两边从一开始就不是一个模型。
>
> 所以真实的活按依赖是：**接上这条断链**（用户已经选了，只是不生效）、
> **把 3+2 硬编码换成旧插件那套按端点类型判的形状**、然后才是专家那两档的白名单与人设清理。
> 下面第一、二节的源码勘查结论（路由判据、`size` 不校验、`duration` 会 400、sora 静默改写、
> `desktop_model_profiles` 没迁起来）**全部仍然成立**，只是「要接多少条」和「参数表从哪来」
> 这两个问题已经有现成答案，不必再去 `api-reference` 写导出脚本。
>
> ### 零之二、已落地（2026-08-19 下午，含对上面第一、三条的两处纠正）
>
> 用同一把 key（openlux 库 token 2379977）复打，并把结论落成代码。**上面第一条的 22 要改成
> 23，第三条的「断链」框错了。**
>
> **纠正一：出图分母是 23，而且它每天在动。** 现拉 470 条，四个同族类型
> `image-generation` 14 + `images-generations` 4 + `dall-e-3` 4 + `openai-绘图` 1 = **23**。
> 上面写 22 是漏了 `openai-绘图` 那 1 条。更值得记的是**六天里它从 21 涨到了 23**
> （旧插件 `index.mjs:368-369` 记的 2026-08-13 是 12/4/4/1）——两次读都用同一把 key、
> 同一套判据。所以文档里任何「一共 N 条」都只是当天的读数，判据（端点类型）才是稳定的那层，
> 这正好是把它做成在线校验而不是写死清单的理由。改图侧 7 条可用，
> 四个类型里 `images-edits` 今天命中 0（其余 4/1/2）。
>
> **纠正二：不存在「用户在界面上选了但不生效」这条断链——DSH 侧压根没有媒体选择器。**
> 上面第三条把旧壳的链路当成了 DSH 的现状。实测（`5c3e31d1` 那轮勘查，逐条带 path:line）：
> `dsh-plugin-desktop/src` 与 `openlux-plugin-account/src` 里**没有任何媒体模型选择界面**，
> 客户端文件清单只有账号、市场、图片卡三类；`cordis.patch.yml:28-29` 的 `openlux-account`
> 行**没有 `config:` 块**；而 `cordis.patch.yml` 是**打进安装包、每次启动只读**的构建期文件
> （`src/profile.ts:312` 读它，`:310` 每次启动还把 profile 的 `cordis.yml` 截成 `[]`），
> 全仓**没有任何运行期改插件行 config 的路径**。内核给的持久化位置是 settings 服务
> （`settings-file/src/index.ts:227` 原子写 `settings.yaml`），但 rc.6 运行体对它加了命名空间
> 白名单（`dsh-host-apiproxy/lib/index.js:888-896`），`openlux` 不在里面。
>
> **而这条断链本来也不该接**：用户明确说了不做界面选择器——「我们是中转站，模型很多，
> 用我们这个项目的大多数是我们中转站的用户，他们自己知道有哪些模型」。
> 所以模型来源就一条：**用户在对话里点名，工具原样接住**。选择器与它的配置写入都不做。
>
> **落地的四件事**（都在 `openlux-plugin-account` 与 `dsh-plugin-desktop`）：
>
> | 改了什么 | 落点 | 形状 |
> |---|---|---|
> | 出图放开到全部可服务模型 | `media/catalog.ts`（新）+ `media/tool.ts` | 判据搬旧插件的端点类型，`/v1/models` 现拉 + 5 分钟缓存 + 读不到就放过；`model` 是自由文本，不在名单里的**当场拒并列出可用的**，不再静默换默认 |
> | 尺寸从逐模型枚举换成三档 | `media/tool.ts` | `IMAGE_SIZES` 三个通用安全值，`ROUTE_MODELS` 整个删掉 |
> | 视频放开 veo 全族 | `media/video-tool.ts` | 加 `veo_3_1-components`，`model` 做成 enum（视频**不能**照出图那样放开：每家路径与 body 都不同，而且 `duration` 是真会 400 的那个参数）；选定模型后按它自己那行校验时长/画幅/首帧 |
> | 成员拿得到这两个工具 | `scripts/materialize-expert.mjs` | `MEMBER_ALLOW` 加 `image_generate` / `video_generate` |
>
> **为什么视频没跟出图一样放开**：出图那 23 条共用一条 URL、一套参数词汇，所以「名字能不能服务」
> 就是全部问题，目录答得了。视频不是——目录把 veo 标成 `OpenAI video format` → `/v1/videos`，
> 而我们提交的是异步统一入口 `/v1/video/create`；**路由由调用方选的路径决定，不由模型名决定**，
> 所以对视频模型问端点类型本身就是问错了。
>
> **人设清理改成机械化的，因为手改会被下一次导入吃掉。** 那份包里 175 处引用的是我们没有的
> 东西（`HY-*`/`YT-*` 104、`ImageGen`/`ImageEdit` 26、`SendMessage` 24、`use_skill`、
> 「多模态内容生成」技能），而且**技能正文里也有**（7 个 md 文件全中）。做法：
>
> - **不改导入的正文，在它上面压一段**「本机工具真相」——形状与内核自己拿会话人设盖部署默认一样。
>   主理人一份（多一条：派活只有自然语言，用户点名的模型名必须写进任务描述才到得了成员）、
>   成员与单专家一份、技能文档一份。插在 frontmatter **之后**，插前面会把 name/maxTurns 变成正文。
> - **三类会真失败的，机械改掉**：`必须通过 SendMessage 回传`（要一个没注册的工具）、
>   `人物场景必须用 YT-Video-HumanActor`（必须，用一个调不到的模型）、
>   `直接说出你的生成意图，WorkBuddy 会自动识别并调用对应工具`（**最危险那条**：
>   它让模型以为说一句就等于画了，于是那一轮什么都没调、却告诉用户图在路上）。
>   结构性的（表格、决策树、工具边界）用整段精确串替换并**断言每条都命中过**，命中不了就构建失败；
>   反复出现的工具名（`SendMessage` 20 处 + `use_skill` 3 处）用短语规则批量改，
>   再用 `assertNoPhantomTools` 断言产物里**一行都不剩**（我们自己那段引用块豁免）。
> - **假模型名故意不进这条断言**：模型名是数据不是调用，它作为 `model` 参数走出去、被路由拒掉时
>   报文里会列出可用的；而残留一个 `SendMessage` 是白烧一轮去找一个不存在的工具。
> - 结果：`config/agent-presets/ai-content-creator-team` **与生成器输出逐字节相同**
>   （2208 行，diff 双向 0），也就是说这个产物已经完全可重放，没有任何手改要维护。
>
> **验过的**（都用线上 key，不是离线桩）：
>
> | 验什么 | 怎么验 | 读数 |
> |---|---|---|
> | 判据与线上目录对得上 | 把 `catalog.ts` 里的常量**从源码里解析出来**再打 `/v1/models`，避免验的是副本 | 23 条出图 / 7 条可改图；四条判据命中 14/4/4/1 |
> | 出图模块本体（不是它的复制品） | `node --experimental-transform-types` 直接 import `media/catalog.ts` 打真机 | 首读 1169ms 拿到 23 条、二读 0ms 命中缓存；5 个真机验过的名字全放行；`HY-Image-V3.0`/`HY-Image-Lite`/`ImageGen`/`gemini-3-pro-image` 全拒且报文列出 23 个可用名；目录传 undefined 时放过 |
> | 三档尺寸真的通用 | 逐模型发图 | `1024x1024`/`1536x1024`/`1024x1536` 在 seedream 4.0、gpt-image-2、qwen-image-max、seedream 5.0 上都出图；不带 `size` 也正常 |
> | `-components` 能纯文字出片 | 真机提交 | 7.2 秒受理、122 秒出片（同 prompt 的 `veo_3_1` 是 175 秒），**不需要参考图** |
> | 人设产物没有幽灵工具 | 生成器内断言 + 事后扫 | 非引用块里 `SendMessage`/`use_skill` 0 行；7 个人设 + 7 个技能文档各带一段声明 |
> | 没弄坏别的 | 聚合 check | `openlux-plugin-account` 与 `dsh-plugin-desktop` 全绿，334 测试通过 |
>
> ### 零之三、真机三档验完（2026-08-19 13:14–13:41，线上 key、线上模型、CDP 驱真窗口）
>
> 三档全过，而且是在**会话日志里**核的——主理人嘴上说用了哪个模型不算证据，成员是独立
> 子会话，得去它自己的日志里看入参。每档故意点一个**不是默认值**的模型，否则「传通了」
> 和「回落默认」这两件事看起来一样。
>
> | 档 | preset | 点名的模型 | 工具入参 | 回执 `meta.model` | 出图 |
> |---|---|---|---|---|---|
> | 不用专家 | 标准模式 | `qwen-image-max` | ×3 全对 | `qwen-image-max` | 出了（内容有问题，见下） |
> | 单专家 | 文爆爆 | `flux-1.1-pro` | ×9 全对 | —（连吃 3 个 429） | 没出，但**没有偷偷换模型** |
> | 专家团·主理人直接出 | 内容创作专家团 | `gpt-image-2` | ×3 全对 | `gpt-image-2` | 出了，画面对 |
> | 专家团·派给成员 | 同上 | `doubao-seedream-5-0-260128` | ×3 全对（**成员自己的子会话**） | 同名 | 出了，画面对 |
>
> 派活那档是这次唯一有新机制的一档，主理人第一轮就照 `LEAD_TOOL_REALITY` 做对了，
> 原话：「按照人设，我需要把珀西的 Agent ID image-creator 传给他的委托工具，
> 并把用户点名的模型名原样写进任务描述里」。落到 `delegate_image_creator` 的入参里是：
>
> ```
> 【必传信息】
> - 用户点名的模型：doubao-seedream-5-0-260128。请在调用 image_generate 时，
>   把 model 参数原样填为 doubao-seedream-5-0-260128，不要改用其他模型。
> ```
>
> 单专家那档吃了三次 `HTTP 429 当前分组上游负载已饱和`（是我自己前面几轮探针把分组打满的），
> 但它的表现恰好验到了另一件事：**它没有降级成默认模型**，而是把 429 原文摆出来、说明
> 「和模型名无关，flux-1.1-pro 是合法传参」，然后问用户要不要等或者换默认。
> 这正是把「静默换模型」改成「当场拒绝并说明」想要的效果。
>
> **顺带查实两件与我们无关但会被当成我们 bug 的事：**
>
> **一、`qwen-image-max` 上有一类中文提示词会被上游换成完全无关的图，还不报错。**
> 第一档出的图是个旗袍女子，跟「雨后天台橘猫」毫无关系。落盘的**附件本体**就是那张，
> 所以不是渲染错文件。撇开客户端直打 `/v1/images/generations` 复现了 8 次，结论很干净：
> 中文没问题（中文拖拉机一次就对）、天台没问题（中文天台无猫，对）、橘猫没问题
> （中文橘猫蹲栏杆，对）、英文同场景没问题（英文天台橘猫，对）；
> **只有「中文 + 天台 + 活物蹲在栏杆上」这个组合会翻**，翻了 4 次 4 次都翻，
> 每次给一张不同的无关人像。最合理的解释是中文安全分类器把「天台 + 栏杆上蹲着一个活物」
> 读成了自伤场景，而这条链路**用一张安全图顶替，而不是回一个错误码**——
> 于是模型以为出图成功，还照着自己的 prompt 把画面描述了一遍。
> 客户端这边没得治（我们拿不到判定信号），但它是中转站侧值得查的一条：
> 静默顶替比明确拒绝坏得多。
>
> **二、成员出的图，用户一辈子看不到。** 派活那档成员真出了图
> （`doubao-seedream-5-0-260128`，2.4 MB，画面完全对，钱也花了），主理人回话说
> 「图已直接展示在上方对话里」——**上方没有图**。整页只有一个 `<img>`，是上一轮主理人
> 自己出的那张；展开「1 个子代理」也没有。原因是结构性的：出图的产物是
> **attachment 内容块**（`media/tool.ts:277`），它留在子会话里，回到主理人手上的只有
> 成员的最终文本。视频没这个问题，因为视频**落文件**（`video-tool.ts:29-31` 写明
> attachment 存储只收图片，所以视频只能走文件），路径能随文本传回来。
> 所以修法基本确定是**让出图也落一份文件**，跟视频对齐，成员才有东西可交；
> 这条是新发现的缺口，不在原计划里。**已修完并真机验通，见下一节。**
>
> ### 零之四、成员出的图现在能到用户眼前了（2026-08-19 14:26–14:41 落地并真机验通）
>
> 落一份文件是必要条件，不是充分条件：路径能过子→父那道墙，但**光有路径图还是不在对话里**。
> 内核这两条把形状定死了——`dsh-tool-subagent` 回给父会话的只有子代理的最终文本，
> 产出行又是按 Turn 折、只读那一个 Turn 自己的 call view，所以父会话不可能继承子会话的产物。
> 结论只有一个：**必须由父会话里的一次调用把图摆出来**。于是两件事一起做：
>
> | 改动 | 为什么是这个形状 |
> |---|---|
> | `image_generate` 额外落一份文件（`media/artifact.ts`），路径进结果文本与 `presentationMeta` | 文本是唯一能过那道墙的东西。文件名走**内容寻址**（`<提示词头>-<摘要12>.<真扩展名>`），不像视频那样必须是 args 的纯函数——视频的产出行要靠 args 重算路径，我们这条路径是随结果当文本传的，所以能用摘要，同一句提示词出两张图不会互相覆盖 |
> | 新增 `image_show`（`media/show-tool.ts`），收 `paths`，把文件重新交给 `saveImage` 再摆成卡片 | 校验与授权就是 `saveImage` 自己那一套（解码、限额、内容寻址），手搓 ref 等于重写那道栅栏。顺带解决另一件事：文本模型的会话里用户拖不进图（附件按 `inputModalities` 把门），而摆卡片不进模型内容，所以照样能看 |
> | 两个工具名共享同一张卡片（`media/card.ts` + 第二个 toolview 键） | 键槽按**工具名**派发，漏注册不会报错，只会静默退回通用行把 ref 打成 JSON |
> | 人设机械化加两条（`materialize-expert.mjs` 的 `MEMBER_TOOL_REALITY` / `LEAD_TOOL_REALITY`） | 成员被告知「你的图只在你自己这条会话里，把路径抄进汇报」；主理人被告知「收到路径就调 `image_show`，转述路径不算展示」 |
>
> **真机四发全过**（本机 dev 壳 + CDP，线上 key）：
>
> | 验什么 | 结果 |
> |---|---|
> | `image_show` 单点 | 拿今早那张「成员出了却没人看见」的对象文件（3200×3200、2.4 MB、无扩展名）直接展示，卡片「已展示 1 张图片」+ 图出来了。扩展名不影响：类型是嗅字节得来的 |
> | 派活整条回路 | 主理人派珀西 → 珀西 `image_generate` 出图并把路径写进汇报（还自己加了一句「请主理人用 `image_show` 展示」）→ 主理人调 `image_show` → **父会话里出现那张图**。日志核到子会话结果文本正是 `delegated` 那一支，父会话 `image_show` 的附件摘要与子会话一致 |
> | 普通会话没被改坏 | 「晴天海边白色灯塔，水彩」照常出图、照常展示，回话里多了一句文件路径 |
> | 拒绝路径 | 一个非图片文件（`package.json`）+ 一个不存在的路径 → 卡片「展示失败」，逐条给原因（不是 PNG/JPEG/WebP/GIF；ENOENT） |
>
> 残留一条不打算追的：模型仍会把**提示词**当画面描述转述一遍（「厚涂笔触、暖猫冷雪」这类）。
> 人设里写了「看不到就不要评价画面」，但它转述的是自己写的提示词，不是凭空编内容，
> 而且现在图真的在用户眼前，用户自己能对。
>

> ### 定稿方案（2026-08-19 两路源码勘查 + 只读 SQL 复核，全部带出处）
>
> **真实分母先摆正。** openlux 生产库 `models` 表 `status=1` 的媒体档共 **321 条**
> （图像 160 + 音视频 157 + 视频 3 + image 1，只读 SQL 现查）。客户端现在接 5 条。
> 而 relay 里唯一成形的参数约束表只有 22 条，覆盖 7%。
>
> **一、清单与路由：两个接口就够，全部 DB 驱动，上游上新自动跟上。**
>
> - 清单判据 `GET /v1/models`（带用户 `sk-` key）。权威源是 `channels.models`
>   （逗号分隔）× `channels.group_ids`，且只算 `status=enabled` 的渠道
>   （`model/channel_cache.go:115-162`，注释明写「不再依赖 abilities 表」——**别去查
>   `abilities`**）。`models` 表只是元数据装饰层，不决定模型存不存在。
>   因为按 token 分组过滤，**拿到的就是「这个用户此刻真能调」的那一份**，比任何静态表准。
> - 路径判据 `GET /api/model_preset?model=<id>`（**匿名可访问**，`api-router.go:85`）。
>   它返回 `endpoint_configs`，即「端点类型 → 具体 path」，而且在 DB 查不到时会回落
>   `GetDefaultEndpointInfo`（`controller/pricing.go:32-79`）。
>   **不能用 `/api/endpoint_map` 代替**：那个直接吐 `GetSupportedEndpointMap()`，而
>   `model/pricing.go:848-857` 把「内置端点入 map」整段注释掉了，所以最常用的
>   `openai` / `image-generation` / `gemini` 在它那儿查不到。
> - **方向性纠正**：路由判据是**请求路径**，不是模型名。路径是调用方选的，模型名只用来
>   选渠道和计价（`middleware/distributor.go:613` 起那个千行 if/else 按 path 前缀定
>   platform）。所以「该往哪个 URL POST」必须客户端自己决定，这就是上面第二个接口的用途。
> - 真机那 84 种端点类型名（`images-generations` / `dall-e-3` / `openai-绘图` 这些）
>   **Go 源码里一个都没有**——`constant/endpoint_type.go` 只有 11 个、
>   `common/endpoint_defaults.go` 只有 7 条默认路径，其余全部来自 `models.endpoints`
>   这个 JSON 列（`model/pricing.go:819-898`，形状 `{"<类型>":{"path":...,"method":...}}`，
>   还兼容双重序列化）。**所以清单绝对不能从 Go 常量抽**：`unified_video/models.go:6-24`
>   的 `ModelList` 至今停在 `veo3` 时代，没有 `veo_3_1`——`modelParams.js` 的错名就是抄它。
> - 兜底一条必须写：`supported_endpoint_types` **可能是空数组而模型是好的**。
>   因为它来自 `models.endpoints`，而 `models` 表靠 `SyncUpstreamModels`
>   （`controller/model_sync.go:254`，RootAuth **手动点**，只补 `GetMissingModels()`
>   缺的，且**丢掉 endpoints 与 model_type**）从 `basellm.github.io/llm-metadata` 拉。
>   没人点同步 → 新模型没 meta 行 → 类型为空。此时按
>   `web/src/pages/Lab/capability/registry.js:46-153` 的 `ENDPOINT_RULES` 反推
>   （那是一份「路径 → 出图/出视频、同步/异步」的 JS 字面量表，可直接搬）。
> - 拼路径要复制 `web/src/pages/Lab/shared/labEndpointPath.js:11-18` 的
>   `fillEndpointModel`：替换 `{model}` / `%7Bmodel%7D` 占位符并剥掉
>   `:floor` / `:nitro` / `:stable` 路由后缀，**否则 Gemini 那条路径拼不出来**。
> - **三家目录 id ≠ 请求体 model，只能硬编码**（无法从任何接口推导）：可灵
>   （计费名 `kling-video`，请求体要 `kling-v2-5-turbo`，`kling/models.go:341-382`
>   还有一张点号→横线归一表 `:147-164`）、PixVerse（计费名 `pixverse-video`，
>   请求体要 `v5`，`pixverse/models.go:97-106`）、Runway（目录
>   `runwayml-gen4_turbo-5`，请求体要 `{model:'gen4_turbo',duration:5}`，网关自己拼，
>   `middleware/distributor.go:1330-1335`）。抄语义的最佳位置是
>   `middleware/video_model_guard.go:44-67` 的 `dedicatedVideoModelSet`——
>   全仓库**唯一**把「模型集合 → 该走哪条专属路径」写在一起且可编译期枚举的表（6 家）。
> - **`GET /v1/models/:model` 单查接口不可用**：只查 Go 常量 map，DB-only 的模型
>   （`veo_3_1` 这类）返回 `model_not_found`（`controller/model.go:325-350`）。
> - `/api/pricing_new` **不能当清单判据**：它跳过 `show_in_square=0` 的模型
>   （`model/pricing.go:909-917`），只能补 `model_type` / `tags` / 计费类型。
>
> **二、参数：「挂住 180 秒」的成因已定位，结论对我们有利。**
>
> - 出图 `size` **网关从头到尾不校验**：`relay/valid_request.go:106-133` 只校验 `n`
>   （1..128，因为 n 是计费乘数），`size` 读进来原样转发；`dto/dalle.go:262-292` 上
>   `size` 没有任何 binding 或枚举。而 `RELAY_TIMEOUT` 默认 **0**
>   （`common/init.go:130`）⇒ `service/http_client.go:66-70` 不设 Timeout。
>   **所以那 180 秒不是网关设的**（全仓库无此常量，自带 nginx 是 300s），
>   是上游卡住、网关陪着等、耗尽的是我们客户端自己的预算。
> - 推论一（**这条让方案变干净**）：**不传 `size` 完全安全**——网关不校验、不改写、
>   直接转发，上游用自己的默认值。所以「用户点名任意目录内模型 → 不传尺寸直接发」
>   这条路没有挂住风险。
> - 推论二：**网关不会帮我们挡，也不会告诉我们什么合法**。想给 `size` 就必须客户端
>   自带白名单，范围可以收得很小（只覆盖我们主推的那几个）。
> - `duration` 相反，**是真会 400 的**：`relay_tasks/sora/duration_validate.go:18-64`
>   （但它 `switch originalModelName`，只覆盖 4 个 sora 名字，`veo_3_1` 走不到，
>   时长完全不校验）、`minimax/models.go:109-142`（只认 6 / 10 秒）、
>   `dto/ali/bailian/bailian.go:166-218`（3~15 秒 + 按模型分支的必填校验）。
>   这几张表值得抄成客户端预校验，省掉一次白等。
> - **sora 的 `size` 是静默改写，不报错**：`relay_tasks/sora/handler.go:160-189`
>   把任意 `WxH` 按宽高比归一到 4 个合法值之一。**客户端以为指定了尺寸，其实被改了。**
> - 各家严格程度横跨整个区间，没有集中表：从 `unified_video/adaptor.go:160-183`
>   （结构体原样 marshal，零校验）到 `pixverse/models.go:443-530`（三级白名单 +
>   per-action 必填）。VIDU 的参数枚举**只写在注释里**（`dto/vidu.go:119-124`），
>   代码不校验。`xaivideo/models.go:16-56` 形状最理想——**参数白名单和计费表是同一张表**，
>   查不到即不支持，不会漂移。
>
> **二·补、参数面写成什么：三源合一，产出一份 JSON，生成脚本挂在 `api-reference`。**
>
> 用户问「relay 的 Go 常量表没有 API 暴露，那我们能不能写成什么」。答案是**不要在网关
> 加接口，也不要手抄进客户端**——`D:\work\yunwu-jihe\api-reference` 这个仓库就是为这件事
> 存在的，而且已经有成熟工具链。
>
> **它是什么**：「云雾 API 文档管理系统」独立 monorepo（管理端 `apps/admin` + 开发者门户
> `apps/portal` + Go 后端 `services/docs-api`），`relay/<platform>/openapi.yaml` 是内容
> SSOT，共 **30 家**（veo / sora / kling / vidu / pixverse / minimax / volc / seedance /
> tencent-vod / mj / fal-ai / replicate / runway / luma / jimeng / ideogram / grok /
> alibailian / ali-pix / avatar / omni / gemini-v1beta / v1 / v1-models …），
> 标准 **OpenAPI 3.1**（`paths` + `components.schemas` + `x-platform` / `x-i18n`）。
> 44 个脚本里已有 `check:manifest`（manifest ↔ 后端路由对账）、`generate:relay`
> （**从 `relay-router.go` 自动生成 manifest**，每份 manifest 首行就写着
> `# AUTO from relay-router.go`，还带 `task_adaptor` 与 `code_ref`）、`lint:content`
> （Spectral）、`export:seed`、`sync-relay-yaml-to-pg`，甚至有
> `scan-cross-model-contamination.mjs` 专扫「参数写串到别的模型上」。
> 管理端「发布 OpenAPI 会写入 `relay/<platform>/openapi.yaml`」——**所以运营改参数走管理端，
> 不用改代码、不用发版**。
>
> **三个来源各补一块，缺一不可**：
>
> - **`api-reference` 的 OpenAPI 枚举 —— 端点级参数，主力。** 带 enum 的分布：
>   kling 76 / pixverse 48 / **v1 26** / avatar 24 / mj 17 / gemini-v1beta 16 /
>   minimax 9 / veo 8 / volc 8 / vidu 7 / fal-ai 6 / omni 6 / ideogram-v1 5 / runway 5。
>   veo 那份实测拿到的是真数据：`aspect_ratio: 16:9 / 9:16 / 1:1`、
>   `resolution: 720p / 1080p`、sora 的 `orientation: portrait|landscape` 与
>   `size: large|small`（正好对上网关 `sora/handler.go:66-71` 那 4 个合法尺寸），
>   还有一条完整的异步状态流转枚举（`pending → image_downloading → video_generating
>   → … → completed`）——**那正是我们轮询要认的字面量**。
> - **relay 的 Go 常量 —— 补「会真 400」的硬约束。** OpenAPI 是契约、Go 才是执法者，
>   两者不一致时以 Go 为准。要抄的就三张：`sora/duration_validate.go:18-64`、
>   `minimax/models.go:109-142`、`dto/ali/bailian/bailian.go:166-218`。
>   理想形状仍是 `xaivideo/models.go:16-56`（参数白名单与计费表同一张，不会漂移）。
> - **`modelParams.js` —— 只补 OpenAPI 缺的那块模型级尺寸。** `v1/openapi.yaml` 的出图
>   `size` 枚举**停在 OpenAI 系**（`256x256/512x512/1024x1024`、
>   `1024x1024/1536x1024/1024x1536/auto`、`1024x1024/1792x1024/1024x1792`），
>   没有我们主力 seedream 的 `2K`/`4K`/`2848x1600` 那一套。而这套恰好在
>   `modelParams.js` 里、且**名字对得上**（seedream / gpt-image / qwen-image 都在能对上的
>   那 17 条里）。所以它降级为「补 17 条主力模型的 size」，不当清单、不当路由判据。
>   注意那份 yaml 有中文编码损坏（`常�?1024x1024`），抽取时别把描述带进产物。
> - **模型名一律不从这三处取。** `veo/openapi.yaml` 的 `model` 枚举同样是
>   `veo3 / veo3-fast / veo3-pro / sora-2 / grok-video`，与 Go 常量同源、同样没有
>   `veo_3_1`。清单只认 `/v1/models`。
>
> **产出与落点**：在 `api-reference/scripts/` 加一个 `export:media-params`（与既有 44 个
> 脚本同形），遍历 30 家 `openapi.yaml` 抽出媒体端点的 `enum` / `default` /
> `minimum` / `maximum`，合并 Go 那三张硬约束与 `modelParams.js` 的 17 条尺寸，
> 产出一份 `media-params.json`。短期客户端内置这份 JSON（构建期拉取），
> 长期塞进 `desktop_model_profiles.params`（服务端可改，前置是修迁移，见第四节）。
> 校验照 LiteLLM 那两个阈值（条数下限 + 不得少于兜底表的一半）。
>
> **接宽的工作分层（按线上真实端点分布，只读 SQL 现查）。** 在架媒体模型按
> `endpoints` 第一个 key 聚合，头部极集中、尾部极分散，共 146 种 key：
>
> | 端点类型 | 条数 | 异步标记 | 对我们的意义 |
> |---|---|---|---|
> | `Unified video format` | 25 | 23 | **DSH 已在打这条**（`/v1/video/create`）|
> | `image-generation` | 21 | 0 | **DSH 已在打这条**（`/v1/images/generations`），全同步 |
> | `openai` | 20 | 1 | 对话端点出图/出视频，旧壳的「第二条路」|
> | `OpenAI video format` | 13 | 11 | sora 官方那条 `/v1/videos` |
> | `MJ action` | 9 | 9 | MJ 后处理动作，不该当模型挑 |
> | `gemini` | 8 | 0 | Gemini 图像族（对话端点）|
> | `dall-e-3` / `images-generations` | 5 / 5 | 0 | 与 `image-generation` 同族请求形状 |
> | `Text to image` / `Image remix` | 7 / 7 | 0 | 待认领 |
> | `Grok video` / `Doubao video (Async)` | 6 / 5 | 3 / 5 | 待认领 |
> | `fal-ai/…`、`black-forest-labs/…`、`stability-ai/…`、`google/imagen-4…` 等长尾 | 每个 1 | 1 | **一个模型一个端点类型**，但路径形状统一，一个适配器覆盖一片 |
>
> 由此分四层，按收益递减：**第一层 46 个模型零新路径**（放开
> `image-generation` 21 + `Unified video format` 25 的模型名即可，这是今天就能拿的）；
> 第二层 51 个（`dall-e-3` 5 + `images-generations` 5 同族形状，
> 加 `openai` 20 + `gemini` 8 的对话端点出图，加 `OpenAI video format` 13 的
> sora 官方——那条**成品不给直链**，要带我们自己的 key 打 `/v1/videos/{id}/content`）；
> 第三层 fal-ai / replicate 长尾约 60 个（形状统一，一个适配器覆盖一片）；
> 第四层各家专属（Vidu 10 + Happyhorse 4 + Runway 4 + 海螺 3 + Wan 3 + Doubao 7 +
> Grok video 6 + 可灵 / PixVerse / Luma / 腾讯 AIGC，旧壳每家约 450 行）。
>
> **321 全接是个错的目标——有相当一批压根不该当「模型」挑。** 这个账旧壳盘点时算过一次
> （广场 46 条图像里 13 条不该挑，见 `references/media-video.md`），线上分布里同样成立：
>
> - **`MJ action` 9 条是对「已有任务」的后处理**（upscale / variation / reroll /
>   inpaint / pan / zoom），走 `/mj/submit/action`，没有前置任务就无从谈起；
>   `MJ modal` 是 inpaint/zoom 的第二步，`MJ image upload` / `MJ blend` 同理。
> - **图生文不是出图**：`MJ describe`、`Image recognition`、`Image to text`、
>   `kling-image-recognize`。
> - **另一档能力，不能塞进出片档**：`Upscale` / `Reframe` / `Replace background` /
>   `Subject swap`（含 mask）/ `Restyle video` / `Video modify` / `Video extend` /
>   `Multi-transition` / `Motion control` / `Motion imitation` / `Lip-sync`
>   （含 `Pix lip-sync`）/ `Digital human` / `Multi-element video editing` /
>   `Virtual try-on` / `custom-elements`。内核的出图出片工具没有对应模式，
>   铺出去就是「选中即必然失败」。要开这一档，先决定它是独立工具还是独立模式。
> - **语音 / 音效 / 音乐不在本条线内**：`Sync speech` 6 + `Async speech` 6 +
>   `Text to speech` 5 + `Speech to text` 3 + `Suno music generation` 3 +
>   `Sound effect` / `Speech synthesis` / `Custom voice` / `Vidu speech synthesis` 等。
>
> 扣掉这些，**接得动的范围是第一层加第二层约 97 个**，第三层长尾按需要再加。
> 提「缺口」之前先按上面四类拆，别拿 321 当分母——这正是旧壳踩过的算错账。
>
> **同步还是异步，判据在 `tags` 里，不用猜**：`image-generation` 那 21 条异步标记全为 0，
> `Unified video format` 那 25 条里 23 条带「异步」。
>
> **线上没有地方存参数**：`models` 表 27 列（只读 SQL 现查），有
> `preset_prompt` / `preset_image` / `example_output` 这些体验预设，**没有任何参数字段**。
> 所以参数的落点只能是新表/新列，而 `desktop_model_profiles.params` 已经把这个位置占好了。
>
> **三、回报：静默替换是这条路上唯一不可接受的失败形态。**
>
> 我们自己的网关就在干这事（sora 归一 `size`），我们客户端也在干（`ROUTE_MODELS`
> 命中不到就 fallback 到默认模型，只打一条 `logger.warn`）。Claude Code 的三个 issue
> 全是同一个病（#57718 / #43869），它们自己提的修法是给 `tool_result` 加
> `effective_model` / `clamped_by`。**所以工具结果里必须回报真正用了哪个模型、哪个尺寸**，
> 用户点名了就更是硬要求：要么真用他说的那个，要么明确说没用成、以及为什么。
>
> **四、参数的长期家已经存在，只是没接通（这是最省的一条）。**
>
> `admin-server` 早就为桌面端造了专用管道 `GET /api/desktop-config`
> （`router/api-router.go:288`，`TokenAuth()` 认的就是我们已持有的 `sk-` key，
> 带 ETag 重校验与灰度开关），背后 `desktop_model_profiles` 表**已经有 `category`
> （chat/image/video/audio）与 `params text` 列**，注释原话是
> 「媒体参数预留(图片/视频的默认时长、分辨率档位等)。本期只建字段,客户端不读」
> （`model/desktop_model_profile.go:53-54`、`:84-85`）。接通它 = 客户端加 `Params`
> 到 `clientModelProfile`（`controller/desktop_model_profile.go:456-468` 现在没带）
> + admin 页面加编辑器 + 从 relay 那 22 条种子化。**收益是参数以后改服务端就行，
> 不用发客户端版本**——而这些事实每次上游上新都会变。
>
> **前置：那张表在生产库里不存在。** 只读 SQL 现查：openlux 业务库只有 `models`
> （1292 行），云雾主库只有它前面那张 `channel_ops_permissions`（0 行），
> **两个库都没有任何 `desktop_*` 表**。成因写在代码注释里：
> `MigrateAdminOwnedTables` 只要任一模型失败就整体 return，而
> `ChannelOpsPermission`（撞 MySQL 64 索引上限）与 `ProformaInvoice`（有一条重复
> 发票号）长期迁不动，`DesktopModelProfile{}` 挂在名单最后（`migrate_admin_owned.go`
> 约 :111 与 :159-163），永远执行不到。
>
> **形状照 LiteLLM，它的两个阈值是买来的教训。** LiteLLM 的模型能力表也不内置在代码里：
> 启动时从远端拉 JSON（5 秒超时），失败回落包内 backup，并且**校验完整性——拉到的表
> 必须至少 50 条、且不少于 backup 的一半，否则丢弃**（`MODEL_COST_MAP_MIN_MODEL_COUNT`
> / `MODEL_COST_MAP_MAX_SHRINK_RATIO`），免得一次坏响应把能力表清空。它文档自己警告
> 的失败形态是「静默回落且健康检查不报警」。我们照这个形状做，并且**回落时要让模型知道**。
>
> **另一条更短的路（要运维给系统令牌）**：`GET /api/sync/models`
> （`controller/sync_export.go:72-81`，`SystemTokenAuth()`）一次返回整张 `models` 表、
> 不分页、含 `endpoints` JSON 原文与 `name_rule`。它是「声明的目录」不是「启用的目录」，
> 所以仍要与 `/v1/models` 求交集：`/v1/models` 定「有哪些」，`sync/models` 定「每个怎么走」。
> 两个请求覆盖全部 478 条。
>
> **五、顺手能修的两个缺陷（与本功能独立，但都是真实损失）。**
>
> - `web-server/model/pricing_new.go:176-194` 的 `parseEndpoints` 把
>   `models.endpoints` 当「JSON 数组或逗号分隔」解析，而生产库里绝大多数是**对象**
>   （只读 SQL 现查：在架图像 155/160、音视频 150/157 是对象形式），
>   `json.Unmarshal` 失败后逗号兜底把 JSON 文本撕成碎片 → **模型广场那侧
>   `supported_endpoint_types` 对媒体模型几乎全错**。改成按对象解析（键就是端点类型、
>   值给出 path），立刻能修好 969 个模型的路由信息。
> - `SyncUpstreamModels` 明明声明了 `Endpoints json.RawMessage`
>   （`controller/model_sync.go:60-69`）却在写库时丢掉它和 `ModelType`（`:345-353`），
>   这是「1268 行里只有 969 有 endpoints、838 有 model_type」的直接成因。
>
> **六、别再挖的地方（省下一次重复劳动）。**
>
> - `API-server` 是**废弃骨架**：`git log --all` 只有 1 次提交（2026-06-09），
>   15 个 Go 文件，处理器全是 `RelayNotImplemented` 占位，README 自己写明只有
>   「分组结构 + 鉴权链」。当前在跑的网关只有 `new-yunwu-api`（module `one-api`，
>   最近提交 2026-08-17，分支「国际站分支」，1131 个 Go 文件）。
> - `web-server` 不是前端，是从单体拆出来的**用户端后端**（`go.mod` module
>   `github.com/yunwu/web-server`）；模型广场前端是另一个不在本工作区的 `web-cloud`。
>   同一个 `/api/pricing_new` 由谁应答会改变返回内容：单体带
>   `GetSupportedEndpointMap()`，`web-server` 那份 `supported_endpoint` **硬编码为空**
>   （`controller/pricing.go:21-34`）。
> - 仓库内**没有** OpenAPI / Swagger / Apifox 导出。`Lab/capability/registry.js:10`
>   引用的 `.cursor/skills/ai-gateway-api/reference/all-endpoints.md`（apifox 243 操作）
>   被 `.gitignore` 排除，只在某人本地——**值得单独去要**，它是参数面唯一成体系的文档
>   （但已知有 schema 写错的先例，只能当补充、不当判据）。
> - `model_type` 不可信：admin-server 自己的注释写着实测 `aigc-video-hailuo` /
>   `kling-omni-video` 的 `model_type` 是「对话」（`model/desktop_model_profile.go:481`），
>   openlux 库里还有 469 行是空值。客户端要按端点类型判档，别信这个字段。
> - **`models.endpoints` 那 84 个类型名的源头是站外第三方元数据仓库**：
>   `https://basellm.github.io/llm-metadata/api/newapi/models.json`（newapi 生态的公开
>   元数据，`controller/model_sync.go:26-52`，可用 `SYNC_UPSTREAM_BASE` 覆盖）。
>   它是「上游的上游」，只带 `description` / `endpoints` / `model_name` / `name_rule` /
>   `tags` / `vendor_name`（`:60-69`），**没有参数约束**，所以它补不上参数面这一块。
> - 顺带一条对中转站用户有用的：`quota_type` 是计费维度——
>   **0 按量 / 1 按次 / 2 按像素 / 3 按视频尺寸 / 4 按视频时长**（`model/pricing.go:93-99`），
>   配 `/api/pricing_new` 里的 `model_price` / `model_ratio` / `image_ratio`。
>   我们的用户花的是自己的余额，所以出图出视频的结果里**顺带说清按什么计费**是真价值，
>   而且这份数据匿名就能拿。这条独立于本功能，先记着。
>
> **七、三档（聊天 / 单专家 / 专家团）的完整分解。**
>
> **先纠正一句话**：之前写的「参数面一改三档同时活」是错的。工具是全局的、没有 preset
> 自挂媒体行，这点没错，但**只有「聊天出图」那一档是真的一改就活**。另外两档各有硬前置，
> 而且专家团那档**现在就是坏的**——坏因不是缺工具，是人设在教成员用不存在的模型、
> 并明文禁止我们唯一能用的那个。
>
> | 档 | 现状 | 硬前置 |
> |---|---|---|
> | 聊天出图（不用专家） | 能用 | 无。工具层改完即活 |
> | 单专家出图 | 工具可能不在白名单 + 人设里有假模型表 | 白名单 + 人设清理 |
> | 专家团出图 | **坏的**：人设明文禁 Veo、教用 `HY-Image-V3.0` 这类不存在的名字、教「说出意图系统会自动识别」 | 白名单 + 人设清理 + 主理人转述纪律 |
>
> **四层改动，按依赖排序：**
>
> **1. 工具层（改一次，三档共享）**：`model` 参数放开（取值不设死枚举，判据是
> `/v1/models`）、size 分两档（表里有给 enum，没有就不传）、结果里回报真正用了哪个模型
> 与哪个尺寸。
>
> **2. 白名单层（专家 / 专家团的硬前置）**：`scripts/materialize-expert.mjs` 里硬编码的
> `MEMBER_ALLOW` 要给需要出图出片的成员放开 `image_generate` / `video_generate`。
> **不改这一层，后两档永远不活**——工具 schema 改得再好，工具不在成员的可见集合里。
>
> **3. 人设层（三份各自清理）。原则是「删多于写」：**
>
> - **人设不复述工具能力，工具描述才是权威。** 理由是工具描述随代码走、人设是静态文本，
>   两者一冲突就是现在这个局面。所以那几张「模型选型表」整段删掉，让
>   `image_generate` / `video_generate` 自己的 description 说话。
> - **不写具体模型名——连我们自己的也不写**（不要把 `HY-Image-V3.0` 换成
>   `doubao-seedream-4-0-250828`）。清单是运行时从 `/v1/models` 来的，人设里任何静态
>   模型表都必然过期，而且写死了用户就没法点名别的。
> - **不抄别的产品的机制描述**，也**不抄别人的商业约束**。
> - 只留角色职责与判断力（什么时候该出图、出几张、什么构图、结果怎么回报）。
> - 加一条纪律：**用户点名了模型就把那个名字原样填进 `model` 参数；没点名就不要填。**
>
> **具体要改的位置（2026-08-19 grep 实得，动手时不用重查）**，全部在
> `config/agent-presets/ai-content-creator-team/`：
>
> - `agent.cordis.yml:99` —— video-generator 那行的假模型表
>   （`HY-Video-1.5` / `YT-Video-2.0` / `YT-Video-HumanActor` / `YT-Video-FX`）
> - `:100` —— image-creator 那行（`HY-Image-V3.0` / `HY-Image-Lite` / `ImageGen` / `ImageEdit`）
> - `:496` 与 `:1400` —— 两处「工具边界」禁令，明文写着**不得引用 Grok / Veo / Gemini**，
>   而我们唯一能用的视频能力就是 `veo_3_1`
> - `:1127` —— 维欧人设里的「WorkBuddy 内置的 AI 视频生成模型」
> - `:1439` —— **假机制**：「直接说出你的生成意图，WorkBuddy 会自动识别并调用对应工具」。
>   在我们这里说出意图什么都不会发生，必须真的调工具
> - `:1448` / `:1456` —— `HY-Image-Lite` 那张选型表与决策树
> - `skills/ai-content-production/SKILL.md:94` —— 第三处同样的禁令
> - `skills/ai-content-production/references/image-generation-guide.md:31` —— 同一张假模型表的副本
>
> **4. 验证层**：三档各验一次。聊天档说一句「用 xxx 画」；单专家档进专家会话说同样的话；
> 专家团档要**查会话日志里成员的 `tool/call` 参数**，确认模型名真的传到了成员手上——
> 因为那条链是自然语言，看主理人的回话看不出来。
>
> **自由与约束的界线（查实，避免以后又绕着走）：**
>
> - **我们的自由有三处**：人设正文（就是我们仓库里的 YAML）、成员白名单
>   （`materialize-expert.mjs` 里的 `MEMBER_ALLOW`）、团队结构（几个成员、谁管什么）。
>   这些都不是内核约束，改写不需要任何人同意。**照抄 WorkBuddy 正文反而违背对齐的判据**
>   ——技能规则第一条就是「判据是结果，不是形式」，人设里写它的内部模型名，
>   结果是成员用不存在的模型，行为反而不一致。
> - **内核逼的只有一条**：委派工具的入参只有 `description`（3-5 词，显示用）、
>   `prompt`（自然语言）与 `run_in_background`，**没有任何结构化透传槽位**
>   （`dsh-tool-subagent/lib/index.js:142-157`，那三处 `properties` 是 output schema
>   的 `background` / `continuable` / `foreground` 三种形状，不是入参）。
>   所以「用户点名的模型名」传给成员只有一条路：主理人写进 `prompt` 的自然语言里。
>   这是三档里唯一真正被逼出来的额外工作，只能靠人设纪律，机制保证不了。
>
> **八、执行顺序与每步的真机判据（照「查 → 验 → 改 → 复验」）。**
>
> | 步 | 做什么 | 依赖 | 动手前要拿到的证据 | 做完的判据 |
> |---|---|---|---|---|
> | 0 | 工具层：`model` 放开、不传 size、回报实际用了什么 | 无 | 手工打 2~3 个**没验过**的目录模型，确认返回载体与耗时 | 聊天档说「用 xxx 画」真出图，且结果回报的模型名与请求一致 |
> | 1 | 白名单：`MEMBER_ALLOW` 放开两个媒体工具 | 无（可与 0 并行） | 读一次现有 `MEMBER_ALLOW` 实际值 | 进单专家会话问「你有哪些工具」，两个工具在列 |
> | 2 | 人设清理三份（按第七节的行号清单） | 第 1 步 | 无（纯文本） | 单专家真出图；专家团成员真出图 |
> | 3 | 主理人转述纪律 | 第 2 步 | 无 | **查会话日志里成员的 `tool/call` 参数**，模型名到了成员手上 |
> | 4 | 参数面：`api-reference` 加 `export:media-params` | 无（可延后） | 先抽一家跑通再全量 | 指定比例出图，尺寸真生效 |
> | 5 | 接通 `desktop-config` 的 `params` | 修迁移（要运维） | 确认迁移已通、灰度开关已开 | 客户端拉到 `params`，且完整性校验与回落都生效 |
>
> **第 0 步为什么能先做且无依赖**：出图这侧**已经两种载体都吃**——`carrierBytes`
> 读到 `b64_json` 就解码、读到 `url` 就自己下载，而且**刻意不发 `response_format`**
> （`media/images.ts:8-16` 的注释写明理由：网关的归一化只对一个短白名单生效、
> 失败就原样透传另一个载体，而白名单外的模型收到这个参数会被上游当未知参数拒掉）。
> 所以旧壳踩过的「`qwen-image` 返 url 拿不到 base64」在 DSH 这侧已从根上避开，
> 放开模型名不会撞上它。
>
> **顺手可做、与主线完全独立的两件**（都在第五节）：修 `web-server` 的
> `parseEndpoints` 按对象解析；让 `SyncUpstreamModels` 别丢 `endpoints` 与 `model_type`。
>
> **已知会骗人的地方，动手时别被绕进去：**
>
> - **sora 的 `size` 被静默改写**，回执里看不出（`sora/handler.go:160-189`）。
> - **我们自己的 `ROUTE_MODELS` fallback 也是静默的**：命中不到就换默认模型，
>   只打一条 `logger.warn`（`media/tool.ts:127-133`、`video-tool.ts:196-201`）。
>   第 0 步必须把这条变成对模型可见的回报。
> - `detail.input.images` 会回显成 `[""]`——那是回显把长串抹了，不是被剥掉。
> - `model_type` 不可信、`supported_endpoint_types` 可能为空而模型是好的
>   （成因见第一节与第六节）。
> - **`/v1/models` 因 token 分组过滤而因人而异**，所以「有哪些模型」不是全站常量，
>   不能缓存成一份发给所有用户。
>
> 下面这一段是原设计记录，其中「取值域收成 enum」已被上面第一、二节取代。
现在出图模型是部署配置（默认 `doubao-seedream-4-0-250828`），工具参数只有
`prompt` / `n` / `size`，模型选不了、用户说了也不算；搜索固定走我们网关上的
`claude-haiku-4-5-20251001`。要让「用指定模型出图」生效，就把 `model` 加成 enum（取
`ROUTE_MODELS` 的键）并让 `size` 的取值跟着所选模型走。代价是工具描述变长、用户可能
选到更慢更贵的模型，而且网关上 gemini 那几个出图模型是 503，名单得人工筛。

**这条要在三种场景下都成立：不用专家、用单专家、用专家团。** 好消息是不用做三遍——
`ROUTE_MODELS` 是部署级的，enum 取值域只定义一次，参数面改一次三档同时活。
**便宜的前提已验（2026-08-19）**：14 份 preset（出厂 2 + 探针 12）**没有任何一份挂媒体
工具行**，出厂那两份挂的是 `ask-user` / `bash` / `fs` / `fs-search` / `goal` / `jobs` /
`pwsh` / `ralph` / `skill` / `subagent` / `subagent-control` / `todo` / `web` / `workflow`，
media 零命中——所以三档用的都是**全局那一份** `image_generate` / `video_generate`，
不存在"某个专家的取值域和别处不一样"。真正要分档处理的是这三件：

| 场景 | 参数面 | 这一档额外要做的 |
|---|---|---|
| 不用专家（默认 agent）| 改完 enum 即活 | 无 |
| 用单专家 | 同上 | **人设里不许写死模型名**。现在就有 `HY-Image-V3.0` 这类，模型会照人设去填，填出取值域外的值被 schema 拒——人设该说的是"你有出图工具"，让 enum 自己告诉模型有哪些 |
| 用专家团 | 同上 | 成员是独立子代理，**看不到用户原话**：模型意图必须由主理人写进委派 prompt，成员再填进参数。成员人设同样不许写死模型名 |

**三档共同还差一条**：用户点名一个我们路由上没有的模型（"用 midjourney 画"）时该怎么答。
要给一句明确的话术并让它落到取值域内，而不是让 schema 硬拒之后模型自己乱猜一个名字重试。

**顺序上有个硬依赖**：场景 2、3 现在连 `image_generate` 都被 `toolFilter` 挡着（见上面
「根因在生成器」那节），所以**白名单修正与人设清理是这两档的前提，不是并行项**——
不然 enum 做完了，专家和成员照样一个出图工具都看不见。

子代理继承的 `provider/model` 是**对话模型**，出图/出视频模型是工具的部署配置，不在 agent
路由里（详见上面「与『指定模型出图/出视频』的先后关系」那节，连旧壳踩过的裸模型名故障
一起记在那）。

**判据（做的时候按这个验，不按「代码写完了」验）：**

- 第一条：**已验**（装配里真工具管道两发被拒 + 反向验证那条断言真在跑 + 回环
  `WEB_BLOCKED_URL` + example.com / iana.org 200 + 八个字面量 + 注入 lookup 三种答案）。
  唯一没验的是**在会话里让模型自己去抓一次内网**——上面全是装配与真机层的判据，没经过模型。
- 第二条：给一个专家配 `deny: [image_generate]`，**在会话里问模型"你有哪些工具"**——
  它说不出那个名字才算成立（`ctx.tools.schemas()` 是全局视角，看不出预设/子代理的收窄，
  这个坑已经踩过一次）。**allow 方向 2026-08-19 凌晨已在真机兑现**：`image_creator`
  自报只有 `read`/`write`/`edit`/`skill`，并把 ImageGen / HY-Image 系列逐条标成"无对应 API"
  （见上面「真机复验」一节）；deny 方向仍只有 `yw-team` 那轮的证据。
- 第三条：说「用 xxx 模型画」时卡片里的 `model` 字段是那个模型；写一个不存在的名字，
  被 schema 当场拒掉而不是发一次付费请求。

### 阶段 5 · 市场与后端契约（2 周，与阶段 3 并行）

见下一节。

### 阶段 6 · 发布（1 周）

品牌、签名、更新通道、许可证附带（内核 MIT + `THIRD_PARTY_NOTICES.md` + 外壳 MIT）、
灰度与回滚方案。

**`THIRD_PARTY_NOTICES.md` 只能在目标平台生成，别在开发机上随手跑（2026-08-19 清残留时发现）。**
`verify:notices` 是纯生成、无比对（`scripts/verify-licenses.mjs:158` 直接 `writeFileSync`），
清单又来自当前平台**装得上**的 `optionalDependencies`。所以在 Windows 上跑一次，仓库里那份
mac 生成的清单就会把 `@img/sharp-darwin-*` / `@koromix/koffi-darwin-*` 换成 `win32-*`——
一条不报错的回归，而且发 mac 包时才发现。`check` 走的是不带 `--notices` 的 `verify:licenses`
（只校验、不写），所以日常复验是安全的；加了新依赖要补清单时，手工插那一行（平台无关的包
本来就与平台无关），整份重生成留给发布流水线。

## admin-server / admin-cloud 要改什么

两个仓库都已建 `feature/dsh-kernel` 并并入最新 main。要改的不多，但有一条是硬的。

### 硬的那条：制品重新设计（2026-08-18 重判）

**先把前提改对：现在那套 zip + `getDownloadInfo` 是 openclaw 形状的旧设计，只当参考，不当目标。**
新内核是全新分支，制品格式、目录契约、后台界面都按新内核重新设计。下面每条都有内核或生态证据。

**一、单位定了：一个 preset 目录的归档，归档根就是 preset 目录本身。**
内核发现的单位就是"含 `agent.cordis.yml` 的目录"（可选 `preset.yml` + `skills/`）。
生态也是这么流通的——社区把 preset 放在 GitHub 仓库里分发，`#dsh` topic + awesome 目录里
已经有好几个纯 agent preset 仓库（`dsh-preset-scaffold`、`dsh-anchored-*`、
`dsh-coding-agent-preset` 等）。归档根与仓库根同形，两边可以互相消费。

**二、为什么不能走上游那套 npm 插件安装（查过并否掉）。**
上游市场的安装路径是 `desktopPnpm.runPlugin(['add', spec])` → 装 Cordis 插件 → 提示重启，
`spec` 转给 pnpm，连 tarball URL 都能装。看着很诱人：整套复用上游的市场壳 + 目录合同 + 受管安装。
**但内核 `AgentPresets` 没有运行时加根的 API**——`roots` 只有 getter、由 config 驱动，
全类型里没有 `addRoot` / `registerRoot`。所以一个市场装进来的插件**无法给内核贡献 preset 目录**，
专家走不了这条路。内容只能写进内核自己的可写用户根。**这是被内核逼的，不是口味**，
代码注释里要这么写。

**三、物化跑在客户端，服务端只投内容。**（2026-08-18 推翻原判，原文见本条末）

服务端投 `expert-content.zip`：根 `SKILL.md` 是（负责人的）人设，`members/<id>.md` 是各成员
人设，其余是人设正文引用的随包资料。**组装成 preset 那一步在客户端做**，落在安装器里。

推翻的理由是一条量化的成本：组装文件整份内联内核包名（见下面第四条），所以**一份 preset
归档只对一个内核版本成立**。若由服务端产，每次内核升级都要把全部专家重新编一遍再上传，
而升级完成之前，新客户端看整个市场都是"未适配当前内核"——这等于把**内核版本和市场内容
永久绑在一起**，每次升级都欠一次全量重编。反过来把组装放在客户端，它天然知道自己跑的是
哪一版，换内核零市场工作量。

这也不是新发明，是**现有客户端的既有形状**：派活规范里要点名每个成员的 agent id，而 id
带团队前缀、还要看用户实际装了谁，所以那段一直由 `agent-manager.ts` 在本机生成
（`seed.go:204-208` 的注释把这个理由写得很清楚：服务端再写一份就是第二个真相源）。
组装 preset 和生成派活规范是同一类事情，归属应该一致。

原判是"导入时跑 `materialize-expert.mjs`，输出 preset 目录再打包上传"。它错在把
`kernel_api` 当成一个可以随手加的维度，没算过"每次内核升级 × 1364 个条目"这笔账。

**随包技能不进内容归档。** 它们已经被导入器上架成**独立的市场技能条目**
（`import_expert_center.go` 的 `upsertMarketSkill`），slug 记在 `manifest.bundledSkills` 里。
所以安装一个专家 = 拉 1 份内容归档 + N 份技能归档，技能字节在多个专家之间复用而不是各存一份。
这一条是既有设计，保留。

**四、`kernel_api` 只对"归档里带组装文件"的格式成立。**
组装文件里写着具体插件包名，还带 `!!js` 表达式（`disabled: !!js process.platform === 'win32'`、
`customSkillDirs` 用 `new URL('skills/', baseUrl)`），所以一份组装是**按某个内核 API 版本**写的。
我们锁 rc.6、上游源码树已经是 rc.7，照源码写会撞 TS2305——这条教训已经吃过一次。

但按第三条，专家投的是内容而不是组装，所以三种格式里只有 `preset-dir.tar.gz`（整份写好的
预设）必须声明 `kernel_api`，另两种恒为空：

| 格式 | 谁产 | 装到哪 | 绑内核版本 |
|---|---|---|---|
| `skill-dir.tar.gz` | 导入器 | `<dshHome>/skills/<slug>/` 或 preset 内 `skills/` | 否 |
| `expert-content.tar.gz` | 导入器 | 客户端组装成 preset 后落可写根 | 否 |
| `preset-dir.tar.gz` | 我们自己精选 / 第三方直投 | preset 可写根 | **是** |

技能不绑内核版本这一条是查过内核的：`packages/skill/skill-filesystem/README.md`
的 *Skill Format* 一节要求的只是 `<root>/<name>/SKILL.md` 加 frontmatter 里 kebab-case 的
`name` 与 `description`，通篇没有任何内核包名。绑定内核的是**组装**，不是内容。
代码里这个判据是 `model.DesktopArtifactNeedsKernelApi(format)`，上传与快照两处都过它，
免得两边各写一次 `format == preset-dir` 然后漂移。

**五、制品要多份并存 → 独立表，而不是在条目上再加一组列。**
新增 `desktop_market_artifacts`：`item_id` + `format` + `kernel_api` + `key` / `sha256` / `size` /
`version` / `created_at`，`(item_id, format, kernel_api)` 唯一。以后多内核版本并存、
或再加一种格式，都是加行不是改表。

**没有老客户端要照顾，这一条是查过库的（2026-08-18）。** 我原来在这里写着"老客户端还在外面
拉 openclaw 形状的 zip，条目上那三列原样保留"——**前提是错的，我们还在开发，没有存量用户**。
`desktop_market_items` 是 admin-server 自己 AutoMigrate 的表（`model/migrate_admin_owned.go:103`），
而两站线上库里**这套表一张都不存在**：主站 `yunwuapi` 117 张表、海外站 134 张表，
`%desktop%` / `%market%` / `%expert%` / `%scenario%` / `%plugin%` 全部零命中（连接是通的，
总表数就是正面证据）。也就是说那三列只活在 Go struct 和本地开发库里，从来没有客户端拉过它们。

所以：`artifact_key` / `artifact_sha256` / `artifact_size` 从条目 struct 上**摘掉**，制品一律进
新表；导入侧不再产 openclaw 形状的 zip；格式并存只为内核版本与格式演进，不为客户端代际。
内核自己对这个局面有成文立场，照它办（`deepseek-harness/AGENTS.md:5-7`，*Pre-release stance:
foundation over blast radius* —— *with no external consumers, prefer the correct foundation over
compatibility shims… Backends reject old on-disk formats*）。

**已在真库执行完（`jishu_test`，2026-08-18 04:13）。** AutoMigrate 只 CREATE / ADD、从不 DROP，
所以另写了 `model.DropLegacyDesktopMarketArtifactColumns()`（先 `HasColumn` 再 `DropColumn`，
空跑零 DDL）。跑真实迁移路径复验：条目表 22 列 → 19 列，三列确实没了；
`desktop_market_artifacts` 建出，唯一索引是 `uk_dm_artifact_target(item_id, format, kernel_api)`；
连跑两遍第二遍零动作。

两条踩到的坑，都记在这里：

- **它必须挂在 `MigrateAdminOwnedTables()` 外面**，和 `EnsureAgentsDocsApiHostColumn` 并列。
  那个函数只要有任一模型迁移失败就整体 `return`，而本库上就有两个与市场无关的模型长期迁不动
  （`ChannelOpsPermission` 撞 MySQL 64 索引上限、`ProformaInvoice` 有一条重复发票号）。挂在它
  后面等于永远不执行——我第一版就挂错了，是启动日志把它抖出来的。
- **删列丢掉了 1364 个仍然有效的 key。** 1367 条里 1364 条带旧 `artifact_key`，我按"openclaw
  形状的 zip 对 DSH 没用"把它们直接丢了——那个判断在第三条推翻之前是对的，推翻之后就错了：
  专家条目那份**正是** `expert-content.zip`，技能条目那份**正是** `skill-dir.zip`。
  改了方案没回头复查迁移的前提。代价是重跑一次导入器把归档整批重传（它本来就设计成可重跑、
  归档按上游内容确定性重建），以及存储里留一批孤儿对象，按
  `desktop-market/<type>/<slug>/` 前缀单独清。

**五之二、图标一律转存，不留直链（2026-08-18 推翻自己的旧判断）。**
库里 380 个已上架条目的 `icon` 直指上游腾讯 COS。原因不是机制没生效——是 `expert_avatar.go`
的 `resolve()` 开头**故意**对 `/avatars/` 前缀直接 return 上游地址，连幂等表都不查。当时写的
理由是"公共目录那 391 个稳定可达，为一批本来就好用的图付上传代价不值"。

**那笔账漏了一整个维度**：权衡里只有"图能不能加载出来"，没有"这张图是谁的机器在提供"。
直链意味着每个用户每次打开市场，浏览器都去打竞品的桶——用户 IP 直接送过去，而对方只要加一条
Referer 防盗链、或换个对象前缀，我们货架上几百张卡的头像会同时变空白，且图片加载失败不出声。
上传代价又是**一次性**的（`previousSelfHostedAvatars` 保证后续每轮零上传），所以那个顾虑本身
也不成立。做法没有新发明：走仓库既有的 `api_storage`，与案例封面 `resolvePlaybookCover` 同形状；
包里找不到对应文件时才按清单地址去上游取那一张再转存，让"不留直链"是完整的而不是近似的。

**复验（真库 `jishu_test`）**：上游 COS 0 条、我们图床 407 条；`manifest` 里的成员头像 0 残留。
顺带查出**第二处盗链**：精选场景大卡的配图（`import_featured_scenes.go` 裸拼 `base + s.Image`）
还有 10 张直连上游，而那是首页最显眼的位置——同一处方治好。

**六、归档格式取 tar.gz，而且是三种格式一律 tar.gz。** 内核不提供任何解包能力，
Node 内建只有 `zlib`。tar 头是定长 512 字节记录，自己写一个**有界读取器**是几十行，
且必须自己写才能显式拒绝绝对路径、`..`、符号 / 硬链接、设备节点、超大条目与超量条目——
这些正是上游安全说明要求的。zip 要解中央目录，且 `adm-zip`（旧壳用的那个）历史上有路径穿越
CVE。所以：**零依赖 + 严格白名单**。这属于"内核没有、参考实现也不适用，才自己造"的那一类。

**服务端原来产 zip，2026-08-18 一并改成 tar.gz。** 判据是"客户端只养一个解包器"：留着 zip
就要在客户端再写一份中央目录解析，那是同一批路径穿越风险重来一遍，约 150 行安全敏感代码，
而已有的 tar 读取器已按 7 个对抗用例验过；收益只是"格式看着眼熟"。
Go 侧改动很小（`archive/tar` + `compress/gzip` 都是标准库，`zipFiles` → `tarGzFiles`），
但**确定性要自己重新保一遍**：tar 头带 mtime、uid/gid/uname，gzip 头也带 mtime，
全部写死，否则同内容每次打出不同字节，`upsertItem` 里"内容没变就不重传"的短路会永久失效
（这正是当初 zip 那版就踩过一次的坑，注释还在）。

**七、信任措辞照上游 market-shell + `dsh-sync` 的口径。**
preset 里有 `!!js`，**安装一个专家在信任上等于给 shell 权限**；`dsh-sync` 同步用户 preset 目录时
也把它判为"可执行变更、要显式确认"。所以确认框必须展示：名称、锁定后的精确版本与 sha256、
落点（当前 profile 的可写根）、"以用户权限在本地运行"的提示。**绝不执行目录返回的任何命令字符串。**

**八、下载直链机制不动。** 公开 HMAC 直链（`api-router.go` 的 `ServeDesktopMarketArtifact`
刻意没挂 `TokenAuth`）+ 响应里给 sha256，客户端验完再解包。下载计数用 `UpdateColumn`
避免刷 `updated_at`（那是快照 ETag 指纹的一部分）——这条现有设计是对的，保留。

**admin-cloud 要跟着改（`src/pages/desktop-market/`）：**

- 制品栏从"一个 zip"改成**一份列表**（format × kernel_api），能分别上传、替换、下线。
- 每条显式回答"新客户端可见吗"：没有匹配 `kernel_api` 的制品就标不可用，别让运营以为上架了。
- 详情页要能预览 preset 目录树（`agent.cordis.yml` 的插件行摘要 + `skills/` 清单 + `preset.yml`
  的 name/description/order）。现在运营对着一个 zip 完全无法判断这个专家在新客户端能不能用。
- 专家团那一栏继续用 `is_team` 物化列（二级 tab 靠它），语义不变。

### 客户端安装器：已实现并真机验通（2026-08-18）

落在 `openlux-plugin-account/src/market/`（`targz.ts` 有界读取器 + `install.ts` 五步），
宿主通道新增两个端点 `market.target` / `market.install`。**装什么、装到哪、装成没有，
三个判断全部取内核的答案**：`authorable` 决定能不能装，`roots` 决定落点，`list()` 决定
id 空不空与装完健不健康。已装专家的管理仍然一件不做（内核设置页第四栏就是）。

真机一轮七条判据（宿主 60711，制品由 `tar -czf` 打的真 tar.gz，58 KB，本地 HTTP 取）：

| 判据 | 结果 |
| --- | --- |
| 落点 | `authorable: true`，root 正好是内核派生的 `<DSH_HOME>\.agent-presets` |
| 摘要不符 | `digest-mismatch`，一个字节都没落盘 |
| 归档损坏（截半，摘要对得上坏字节） | `bad-archive: 不是有效的 gzip 数据` |
| id 被出厂专家占用 | `already-installed（来源：system）`——first-root-wins 的影子也拦住了 |
| id 不合内核目录规则 | `invalid-id` |
| 正常安装 | `installed`，目录里 `agent.cordis.yml` / `preset.yml` / `skills/` / sidecar 齐全 |
| 装完复读名录 | `market-probe-team trust=user item=probe-item-42 version=1.4.0 broken=no`，且归属只挂在我们装的那行，手工副本仍是 `-` |

五处形状是被真机逼出来的，别改回去：

**一、暂存目录用点号前缀，并且放在可写根里面。** `.openlux-staging-<id>-<rand>`：
rename 只在同一文件系统上原子，所以必须同根；而 discovery 过滤子目录用的正是那条
id 正则（`lib/index.js:247`），点号开头过不了它——**半写状态的目录对内核完全不可见，
连 broken 都不会列**。同一条规则同时守着 id 和暂存命名空间，这是内核送的。

**二、`ctx.get('agentPresets')` 合法，`ctx.agentPresets` 属性读取会被拒。**
没在 `inject` 里声明就读属性，reflect 代理直接抛
`cannot get property "agentPresets" without inject`（真机吃过）。内核自己的网关就写着这条
区别（`host/apiproxy/src/api-proxy.ts:3172-3176`），机会性消费一律走 `get`，
再把**服务本身**当参数传下去，别在下游函数里碰属性。名录缺席不是故障：
`market.target` 答 `authorable: false`，`market.install` 答一条 refused。

**三、仓外插件不能运行时 import 内核的 `dsh-agent-presets`。** 内核包是按 workspace 各自
装的 tarball，落到我们包里那份解析不到自己的 `@deepseek-ai/dsh-scope`，外壳直接起不来
（`ERR_MODULE_NOT_FOUND`，启动即炸的好失败）。所以 `writableRoot()` 调不到，
它那两行由 `writableRootOf()` 镜像（取第一条 `trust: 'user'` → `resolve(expandHomePath(path))`）。
镜像不是白镜像：**落点算错内核就发现不了我们写的东西，第五步复读 `list()` 会失败并回滚**——
id 正则那条镜像同理。而 `expandHomePath` 这一半是真从内核拿的：`dsh-home-paths`
的产物只 import Node 内建，零传递依赖，唯一能安全运行时导入的一个。

**四、归档根那条 `./` 条目要跳过而不是拒绝。** `tar -czf x -C dir .` 会把归档根自己写成一条
成员；拒绝它等于拒绝最常见的打包方式。归档根 = preset 目录本身，`agent.cordis.yml`
必须在根上；多包了一层就报出那层的名字（id 只认目录条目给的，不从归档里读）。

**五、归属 sidecar 只由本机写。** 制品里自带 `openlux-market.json` 一律拒装——归属是
这台机器观察到的事实，不是制品可以自称的。装完写在暂存目录里，和内容一起原子改名进来。

### 软的那条：模型档案的思考方言

`desktop_model_profile` 现在下发的是 openclaw 的 `compat.thinkingFormat` 七种方言与
`thinkingLevelMap`。阶段 2 闸门验完后（2026-08-17），目标形状已经确定，可以直接定表：

| 现在的列 | 换成 | 备注 |
|---|---|---|
| `thinking_format`（七种枚举） | 同名保留，取值域收到 dsh 的 `PiAiThinkingFormat` | 我们只用 `qwen` / `deepseek`，被扣住的 `chat-template` / `qwen-chat-template` 要从枚举里去掉 |
| `thinking_levels`（字符串数组）+ `default_thinking_level` | **合成一列 `reasoning_efforts`（档位 → wire 拼写的字典）** | 这是形状变化最大的一列：从"提供哪些档"变成"每档发什么" |
| `can_disable_thinking`（布尔） | 不再单独存——**`off` 键在不在 `reasoning_efforts` 里就是答案** | 少一列，也少一处自相矛盾的可能 |
| `thinking_effort`（布尔） | `supports_reasoning_effort`，语义不变 | 只是改名对齐内核字段 |
| `reasoning`（布尔） | 保留；`false` 时下发 `reasoning_efforts: false` | dsh 用 `false` 显式表达"不思考的模型" |

档位取值域从 `low/medium/high` 三档扩到 dsh 的七档（`off / minimal / low / medium /
high / xhigh / max`）。admin-cloud 的模型档案页（`src/pages/desktop-model-profile/`，41 KB）
跟着改表单：档位那一栏从多选框变成"档位 + wire 值"的键值对编辑器，
`can_disable_thinking` 那个开关删掉。

**服务端要继承客户端已有的那三道校验**（现在写在 `model-profiles.ts:147-168`）：
方言不在枚举里整条作废、`thinking_effort: false` 却配了档位整条作废、
`reasoning: false` 时连带清掉思考细节。dsh 那边这些是解析期抛错，
所以下发脏数据的后果从"界面铺出一排点了不生效的假档位"升级成"整个路由起不来"——
这道校验比现在更要紧，不是更不要紧。

**这条通道只下发能力、不许携带"该用哪些模型"** —— 清单是用户数据，这条纪律继承。

### 客户端组装步：expert-content 装成预设（2026-08-18 落地，内核 discovery 判绿）

服务端只发内容（人设 + 成员人设 + 随包资料），组装文件由客户端在装的那一刻拿**当前跑着的
内核自己的 `standard`** 生成，落在 `market/compose.ts`。这一步的每个决定都有出厂成句背书，
不是我们的新发明——查证顺序与证据如下：

| 要做的事 | 内核给的现成东西 | 证据 |
|---|---|---|
| 换专家身份 | 出厂 `standard` **本来就有** `persona` 行（默认只一句"You are a coding agent…"），`dsh-persona` 是 scope-only 插件，存在的理由就是让预设遮蔽部署人设 | `dsh/config/agent-presets/standard/agent.cordis.yml:24-28`、`dsh-persona/lib/index.js:8-15` |
| 成员各自的人设 | `dsh-tool-subagent` 的 `persona` 配置项（"Per-child persona that shadows `deployment:persona`"），且 `spawn` provider **四项能力全支持**（`persona` / `depthLimit` / `toolFilter` / `outputSchema`）——所以 `maxDepth: 1` 不会在挂载期抛 | `dsh-tool-subagent/lib/types/index.d.ts:41-44,59-65`、`dsh-subagent-spawn-in-process/lib/index.js:23-28` |
| 随包技能的落点 | 出厂 `cordis` 预设那条 `customSkillDirs: - !!js …new URL('skills/', baseUrl)`，它自己的注释写着"`baseUrl` 是预设自己的目录，所以装到哪都解析得对" | `dsh/config/agent-presets/cordis/agent.cordis.yml:255-259` |

**三处刻意不做，都是"别改内核的行"：**

- **不关 `includeDefaultRoots`。** 出厂 `cordis` 只**加**一个技能根，没关默认根。我们手工物化那
  两份预设多写了 `includeDefaultRoots: false`，那是自己加的，不跟——而且叠加才对得上
  WorkBuddy 的实情（一条会话六十多个技能里只有四五个来自被召唤的专家）。
- **成员行追加在根层，不塞进出厂的 `delegation` 组。** 那个组存在是为了给 `workflows` 一个
  entry-local realm；`dsh-tool-subagent` 只注入三个注册表、不 provide 任何服务，所以不需要 realm
  （`lib/index.js:15-19`）。追加就不会碰内核自己那个组里的任何一行。
- **通用 `subagent` / `subagent_fork` 两行留着。** 手工那份专家团把它们换成了成员行，
  但删内核的行换来的只是省两个工具 schema，用户看不到差别。

**为什么是文本编辑而不是"解析再序列化"。** 组装文件带 `!!js` 标签，通用 YAML 解析器直接抛，
序列化器也没法把它原样吐回来——真正读它的是 `cordis-plugin-include`：
`yaml.load(content, { schema: yaml.JSON_SCHEMA.extend(JsExpr) })`，且顶层**必须是数组**
（`src/index.ts:9-23,250-263`）。所以按行改：组装文件根层是扁平序列，每行以 `- id:` 顶格开头、
属于它的行一律缩进，`rowBody()` 就吃这条，不成立时**显式抛**而不是猜。

**唯一躲不开的是"要吐出任意文本"**（人设是整篇 markdown）。取**内联块标量**，因为出厂 `standard`
和我们手工那两份都是这个形状。**认真考虑过并否掉了 `!!js readFileSync` 从文件读**：那样零转义风险，
但把内核自带的四份组装文件全扫一遍，`!!js` 的用法**清一色是 `process` / `baseUrl` 上的纯表达式，
没有一处做 I/O**——那就是我要发明的机制。改为在 `blockScalar()` 里归一化（CRLF→LF、砍掉首行缩进、
空行保持真空），而且写坏了也不可能静默装上去：安装器最后一步问内核认不认，不认就带着装载器
自己的话回滚。

**真机复验（`.tmp-probe/compose/check.mjs`，故意难看的输入：CRLF + 首行缩进 + 制表符开头 +
反引号 + 行首 `---` + 行首 `- id:` + 中文）**：

| 判据 | 结果 |
|---|---|
| 用内核那套 schema 解析 | 顶层是数组，19 行（`standard` 原有 16 + 3 个成员） |
| 人设正文 | 与原文逐字节相等（归一化后） |
| `standard` 自己的 `!!js` 行 | `tool-bash` / `tool-pwsh` 的表达式节点都在，没被改坏 |
| 技能根 | `customSkillDirs` 加上了，且是 `!!js` 表达式节点 |
| 成员行 | 3 行（空文件被丢、`members/<id>/` 子目录不算成员），工具名全过 `^[a-zA-Z0-9_-]{1,64}$` |
| **内核自己的 `scanRoot`** | 发现 `probe-expert`、读到 `preset.yml` 的名称、`broken === undefined` |

**探针抓到一个我判据没盖到的真 bug，值得单记。** 工具名做了去重，**行 id 没有**：
`video.editor@v2` 与 `video-editor-v2` 两个成员 slug 化之后撞成同一个 `teammate-video-editor-v2`，
而 **Loader 按 id 认条目**——后一行会静默盖掉前一行，那个成员从团队里消失且不报错。
判据只看了工具名，是探针把两个同名 id 打印出来才发现的。修法是行 id 与工具名共用同一个
`unique()`（行 id 用 `-` 连接以留在 kebab 字母表内），并把"id 唯一 + 三份人设互不相同"加进判据。
**教训**：生成式的东西要对**每一个下游键**都断言唯一，不是只对最显眼那个。

**还没验的一条，别当已验**：discovery 判的是"读得进、解析得动"，**不是挂载**。
"某行插件包不存在 / config 形状不对"这类只会在**第一条会话挂载时**才现形。我们是从当前内核
自己的 `standard` 派生的（每一行都在这个部署里挂得起来），成员行用的 `dsh-tool-subagent`
也已经在 `standard` 里，所以风险低——但**低不等于验过**，下一步要在跑着的应用里真开一条会话。

### 挂载已验（2026-08-18，真机一条会话）

在跑着的应用里从广场装了 `marketing-growth-team`（4 成员 + 1 个随包技能），开一条会话发
「请调用 delegate_seo-content-strategist」，拿到的证据链是完整的：

- 预设进了预设选择器、会话头显示「营销增长专家团 · 1 个子代理」——**挂载起来了**；
- `delegate_seo-content-strategist` 真被调用并返回内容——成员行的 `toolName` 与 `persona`
  都生效，OpenAI 那条 `^[a-zA-Z0-9_-]{1,64}$` 也没被 slug 里的连字符绊倒；
- 上下文注入里 `skill-catalog` 列出了 `marketing-growth` 及其描述——**随包技能被内核从
  `<preset>/skills/<slug>/SKILL.md` 发现了**，`customSkillDirs` 那一步是通的；
- 落盘核对：`agent.cordis.yml`（78KB，人设 + 4 行 `dsh-tool-subagent` + 内核自己那 4 行
  通用 subagent 原样保留）、`preset.yml`、`openlux-market.json`、
  `skills/marketing-growth/` 整棵 references 树（80 余个 md）。

**内核对技能目录的三条硬事实**（读 `dsh-skill-filesystem` / `dsh-skill` 源码得来，别照目录名想当然）：

1. 技能的身份取 **frontmatter 的 `name`**，不是目录名；两个技能 `name` 撞了就是撞了，
   放在不同目录也救不回来（随包技能的 rank 是 `BUNDLED_SKILL_RANK = 600`）。
2. 目录型技能只认 `<root>/<dir>/SKILL.md` **一层**；`SKILL.md` 再往深一级就发现不了
   （`isPotentialSkillPath` 直接砍 `segments.length > 2`）。
3. frontmatter 不合格（缺 `name`/`description`、`name` 不合 `^[a-z0-9]+(?:-[a-z0-9]+)*$`）
   是 `logger.warn` **静默忽略**，不报错。所以"装完了"不等于"看得见"，判据必须是
   会话里的 skill-catalog，而不是盘上有没有那个目录。

### 两条路径真机对完了（2026-08-19）：差异只剩导入器自己追加的三节

本地 admin-server 起在 3011、库指线上测试库 `jishu_test`（市场数据已导入：420 个专家**全都有**
`expert-content.tar.gz` 归档、其中 52 个是团、264 个带随包技能；另有 994 个技能、3 个连接器；
13 个专家被"空心专家"规则判成隐藏 `status=2`）。探针 `install-reach.mjs` 把
`promo-creator-team` / `xiaohongshu-operations-expert` / `content-creator` 从这台控制台装进临时
`DSH_HOME`，再与出厂预设逐字比：

- **5 行派活工具名一致**（`delegate_asset_producer` 等），成员工具面 `toolFilter.allow` 一致；
- **5 份成员人设在导入器追加的三节之前逐字相同**，没有"只有出厂才有"的段落丢失
  （追加的是「语言与身份」「正文排版规范」「协作纪律」）；
- lead 人设的差异查清了、是服务端设计而非漂移：Go 导入器**剥掉**上游那段
  `CRITICAL IDENTITY DIRECTIVE` 换成自己的「语言与身份」，再追加「内置技能」与人设来源署名；
  生成器则保留那段、只把厂商名擦掉（于是留下 `NOT a generic coding assistant, NOT a generic
  coding assistant` 这种重复）。两份都把身份和中文作答钉住了，装出来的那份反而更干净。

**点名模型透传，真机走完最后一段**（`generate-reach.mjs`，账号 `yw_zhoucongjie` 的桌面客户端
令牌，预设根指向上面装出来的那三份）：这把密钥的出图目录有 23 个模型；先直接点名
`doubao-seedream-3-0-t2i-250415`（**不是**默认的 `doubao-seedream-4-0-250828`）出图成功；再把
同一句"用 <模型> 出一张咖啡海报"当**自然语言**派给装出来的团的 `delegate_asset_producer`——
没有任何地方告诉成员该填哪个参数，成员照样用点名的那个模型出了图，回报了文件路径并提示
主理人用 `image_show` 展示。**网关账单两笔出图都是 `doubao-seedream-3-0-t2i-250415`，默认模型
一笔都没有**——链路上不存在静默替换。

两条探针教训，都不是产品的错：

1. `openlux-plugin-account/lib/index.js` 比 `src/` 旧了一小时，第一轮"装出来的团没有成员、
   没有派活工具"跑的其实是**重构前的包**。探针跑之前先 build，这条比任何猜测都便宜。
2. 成员行的 id 前缀是 `teammate-<slug>` 而不是 `member-<slug>`，探针正则写错就会把
   "5 个成员都在"读成"一个都没有"。判据来自落盘文件本身，不是记忆里的命名。

### 界面那一段也点通了（2026-08-19，CDP 真机）：「召唤」就是安装路径

前面那轮走的是宿主 RPC，这轮补的是用户真正走的那条：**设置 → 市场 → 搜索 → 召唤**。
拿 `video-dissection`（视频解剖专家团，出厂 22 份与本机已装 11 份里都没有）做样本，
证据链完整：卡片上是「召唤」而不是「安装」→ 点它先弹「安装到本机?」并把落盘目录写在弹窗里
（第一次召唤才问）→ 同意后盘上出现 `.agent-presets/video-dissection`，
`agent.cordis.yml` 24423 字符带 2 行 `teammate-*`、2 个同名 `delegate_*`、2 份成员工具面，
两个随包技能连 `references/` 与 `scripts/`（29KB JS + 32KB Python）一起解包 →
设置面板自己关掉、输入框上方的预设选择器变成「视频解剖专家团」、并预填了主理人的开场白。

**装完之后在界面里真发了一次请求（22:48，1 分 02 秒跑完）**，一句话把四层一起验了：
「派一位成员用 doubao-seedream-3-0-t2i-250415 出一张横版视频封面图……」。四层证据都取自
界面自己的「轨迹」面板，不是模型的自述：

| 层 | 记录下来的东西 |
|---|---|
| 主理人派活的**参数原文** | `delegate_script_analyst {"description":"生成黑金封面图","prompt":"…模型参数必须原样填写：doubao-seedream-3-0-t2i-250415（这是用户点名的模型，不要替换、不要省略）…"}` |
| 成员的**调用参数** | `image_generate {"prompt":"…","model":"doubao-seedream-3-0-t2i-250415","size":"1536x1024"}` |
| 工具回执（`delegated` 分支） | 「已用 doubao-seedream-3-0-t2i-250415 生成 1 张图片。**你是被派活的成员，这些图只出现在你自己这条会话里**……请主理人用 `image_show` 展示给用户」 |
| 用户看到的 | 主理人照办调了 `image_show`，图渲染在对话里；2848×1600、`sha256:3ffe7c53…`、落盘在 `media/image/` |

派活这一跳没有结构化参数可用，模型名是**主理人把它原样抄进任务描述**过去的——这正是
`persona/tool-reality.ts` 里那句中继要求在真机上的样子，不是靠成员猜。
请求侧到此是逐字证据（`tool.ts:222` 的 `model` 就是发出去的那个名字，且点名模型发请求前
还过了一次 `assertImageModel` 真实目录校验）；上游**账单**那一侧的证人在前一轮 RPC 复验里
已经拿到过（同一条工具路径、同一个模型名、两笔账单都是它），这轮 MCP 只读 SQL 代理断线没能复取。

**顺带暴露一件产品事实：今天线上没有任何一台服务器在供这个市场。** 客户端默认
baseUrl 是网关站 `https://api.openlux.ai`，那儿没有 `/api/desktop-market/*`，市场页直接
`目录读取失败（HTTP 404）`；线上主库 `yunwuapi` 117 张表里 `desktop*` 一张都没有
（`skills*` 那 6 张是网站 Skills Hub，与桌面市场是两个产品面）。也就是说市场目前只在
「本地跑 admin-server + 库指 jishu_test」这一种形态下活着，本机那 11 份已装专家就是这么来的。
判据别看客户端界面，看 `information_schema`。

两个把人骗住的坑，都值得记：

1. **应用跑在哪个 home，问 `DSH_HOME` 而不是想当然。** 这台机器的 shell 里
   `DSH_HOME=%LOCALAPPDATA%\Temp\yw-dsh-live`，于是我往 `~/.dsh` 写的补丁与令牌全是白写，
   现象是"补丁明明在组装里却不生效"。判法：`prepareDesktopProfile` 打印 home，或者读
   安装确认弹窗里那行落盘路径——它显示的就是真 home。
2. **机器级补丁文件在 `<home>/cordis.patch.yml`**（`PROFILE_PATCH_FILENAME`，`profile.ts:325`
   读的是 home 根），不是 `profiles/<name>/cordis.patch.yml`。写错位置不报错、只是没效果。

顺手核了「测试库里会不会残留旧设计误导人」这个担心：`jishu_test.desktop_market_items`
现在只有 19 列，与 `model.DesktopMarketItem` 一一对应，制品三列
（`artifact_key` / `artifact_sha256` / `artifact_size`）**根本不存在**——这张表是制品拆表之后
才由 AutoMigrate 建的，所以结构体注释里"旧列删不掉"的情形在这台站上没发生。
真正咬过我们一口的是反方向：8/16 编的 `admin-dev.exe` 还在按拆表前的模型查
`desktop_market_items.artifact_key`，对着新表报 `Error 1054`，admin-cloud 于是一片空白。
**结论：怀疑库脏之前先怀疑二进制旧。** 判据是 `information_schema.columns` 与结构体对照，
不是界面有没有数据。

### 这一轮修掉的三处真错配（客户端 ↔ 控制台）

都是"没照服务端已经写明的设计对齐"造出来的，不是内核缺功能：

1. **客户端对所有分区只要一种格式**（硬写 `preset-dir.tar.gz`）。真相是一区一格式：专家发
   `expert-content.tar.gz`、技能发 `skill-dir.tar.gz`、**连接器根本没有归档**（它带的是
   MCP 启动清单）。不改的话专家技能全被标成"没有适配当前内核的版本"，连接器 3 条也会
   被冤枉成不可用。格式表统一收在 `wire.ts` 的 `formatFor(type)`，只留一个真相源。
2. **客户端要求快照里带 `url`**，而服务端**刻意不带**，理由写在
   `controller/desktop_market_client.go:97-107`：预签名链接几小时就过期，快照走 ETag 能缓存
   好几天，把会过期的塞进不会过期的缓存里 = "点安装那一刻才发现链接死了"，而 ETag 表达不了
   这种失效。改成：目录只带不会过期的事实（sha256 / size），链接在点安装那一刻现签。
3. **安装 RPC 收的是渲染进程递来的 URL**。服务端那段注释顺带点明了本意——宿主该收到
   「装哪个条目」。这不只是洁癖：主进程去 fetch 渲染进程给的任意 URL 是 Electron 里的
   SSRF 标准靶子。改成 `InstallRequest` 只带 `type` + `id` + `format`，URL 与 manifest
   都由宿主自己去控制台取（`market/console.ts`）。旁文件的 `source` 也跟着从"那条签名链接"
   改成 `<type>/<slug>@<format>`——记一串几小时后就失效的签名，重装时什么也做不了。

### 两个把人骗住的诊断坑（各花了十几分钟）

1. **端口上是两天前的旧二进制**。本地起 admin-server 时 `go run` 打的是
   `listen tcp :3000: bind: Only one usage of each socket address`——但**日志被
   PowerShell 重定向缓冲了**，我先看到的是快照接口回
   `Unknown column 'desktop_market_items.artifact_key'`，于是去查结构体、查库、查 GORM，
   全都对得上（结构体没有那三列、库里也没有）。真相是 3000 端口上蹲着 8/16 23:54 编的
   `admin-dev`，它的结构体还在制品拆表之前。**判法**：`Get-NetTCPConnection -LocalPort`
   把 pid 和 `StartTime` 一起打出来，别只看"端口通不通"。
2. **窗口指着上一轮的宿主端口**。市场页出「连不上市场目录：Failed to fetch」，而转发器
   日志上明明有 200/304。渲染侧控制台里是
   `ws://127.0.0.1:64542/api/events.mux failed` + `connection lost, retry #175`，
   而活宿主在 **55375**——同一个 electron 进程，窗口里却是旧端口的页面。
   **判法**：`Get-NetTCPConnection` 按 electron 的 pid 反查它在听哪个端口，和
   `location.href` 对一下；不一致就把页面导到活端口，不要去查市场代码。
   顺带一条：`Failed to fetch` 是 **Chromium 渲染进程**的措辞，主进程 undici 失败说的是
   `fetch failed`——这两个词分得清，就知道该往哪一侧查。

### 召唤：一键到会话（2026-08-18 落地并真机验通）

**要复现的结果**（WorkBuddy 的形状）：专家中心里点一个专家，**不出现"安装"这一步**，直接开一条
新会话，并把它的开场问题**预填**进输入框（不自动发送，用户还能改）。开场问题取 manifest 的
`defaultInitPrompt`，缺了就退到 `quickPrompts[0]`——WorkBuddy 自己的注释写着「解析专家召唤时
预填输入框的默认提示词」。

**内核三步全是现成面，没有自造机制**（`src/client/summon.ts`）：

1. `workspaces.startSession()` —— 复用或新建工作区的空会话并打开它。它不回传 id，所以召唤
   请求是**暂存**的，由"谁看到当前会话变化"来兑付。这不是我们的发明：内核自己那个
   Creator 入口就是 `seat.stage(id) + workspaces.startSession()`，注释也写着"会话可能在
   pick 之前或之后才出现"。
2. `agentPresets.select({ sessionId, agentPreset })` —— 和 hero 芯片按下去用的是同一条 RPC。
   它**拒绝已经跑过一轮的会话**，所以只往 `blank` 的会话上落。
3. `conversation.input.for(actx).setDraft(text)` —— 经 `sessions.scope(id)` 拿到那条会话的
   输入器，是内核 `ui-commands` 和队列坞从会话外面写输入框的同一条路。

**首次召唤仍要过一次确认，这是内核的信任模型逼的**，不是我们谨慎：`user` 预设在内核自己的话
里"carries the same trust as shell access"（`agent-presets` README 的 Trust 一节），我们组装出
的 composition 又带 `!!js`。所以第一次落盘要用户点一下，之后每次召唤都是一下点到会话。

**开场问题的三个来源，按代价排**：装的时候 `readExpertManifest` 一并取回、写进旁文件
`openlux-market.json` 的 `prompts`（已装的离线可召唤）→ 详情页临时缓存 → 都没有才走
`market.prompts` 这条宿主 RPC（manifest 是逐条读，快照刻意不带）。

**修掉一个自己造的 bug**：详情页点第三条提问，装完却预填了第一条——`pending` 只存了条目、把
用户点的那句丢了。改成 `PendingSummon { item, prompt? }`，确认对话框把它原样带过去。

#### 内核缺口：芯片不会跟着别人改的 composition 走（已打补丁）

`AgentPresetSeatController.load()` 的取值顺序本来就是「暂存的 pick → **当前会话已经在跑的
preset** → 部署默认」，也就是说内核**认**"芯片该显示当前空会话的 composition"。问题是这个
推导只在 `load()` 时做一次，而 `load()` 只在挂载、`settings/document-updated`(ns=agent-presets)
和它自己那套 `rosterReaders` 时跑。芯片订阅了会话列表，回调里却只有 `seat.apply()`。

后果是实测过的：召唤完会话真的在跑 `hr-digital-expert`（会话日志里有 `agent-preset/selected`
事件，答话也是那个人设），芯片却还写着「标准模式」。这不只是难看——用户从芯片里挑一下它显示
的那个"标准模式"，`select` 会真把会话换成 standard，把召唤悄悄撤了。

内核对这一类缺口是**明说**的，README 的 Known Limitations 里写着「Composition edits are
invisible to the page」，`section-store` 的注释更直接：目录被改这件事"没有别的办法告诉
new-session 芯片"（它自己靠包内的 `rosterChanged` 回调解决，跨包没有出口）。查过的出口都不
通：没有 commands、没有 roster 变更事件、`settings/document-updated` 只在**原始段真的变了**
时才 bump（`bumpRevision`），拿它当刷新信号是假话且不可靠。rc.7 也一样没改。

所以按仓库既有先例（`dsh-sandbox-windows-acl` 那个补丁）打了
`patches/dsh-client-ui-agent-preset@0.1.0-rc.6.patch`：给 seat 加一个不发 RPC 的 `sync()`，
在会话列表变化的回调里跟 `apply()` 一起调——有暂存 pick 就不动它；当前会话的 preset 已在名录
里就直接改显示；不在名录里（刚装的那种）才 `load()` 一次。**换内核版本时这条补丁要重做**，
`yarn install` 打不上会直接报错，不会悄悄丢。

真机证据（本地控制台 3100 + 转发器 8792）：

- 已装专家一下点到会话：芯片「营销增长专家团」+ 输入框「为我的 SaaS 产品制定 90 天营销
  计划」，全程 0 个对话框；
- 未装专家：确认框（写明落盘目录 + "只有第一次召唤要过这一步"）→ 约 2.4 秒后芯片
  「论文写作导师」+ 预填开场问题，走的是 `sync()` 里 `load()` 那条（名录还不认识它）；
- 详情页第三条提问 → 装完预填的就是第三条（`match: true`）；
- 真发一轮：会话头「营销增长专家团」，答话「我是盛全局——营销增长专家团的首席营销策略师」
  ——composition 真挂上了；
- 重启外壳后芯片仍是「腾讯HR数智专家」（当前会话开机就 attach，摘要带得出解析后的 preset）。
  顺带一条：**输入框草稿过不了重启**——它存在渲染侧，而宿主端口每次启动都变，
  `http://127.0.0.1:<port>` 换了 origin 就换了存储。这是内核既有行为，与召唤无关。

### 不用改的

- 登录 / 令牌 / 余额相关的接口（`/api/user/login`、`/api/token/`、`/api/user/self`、
  `/api/status`、go-captcha 那三个）：桌面端换内核与它们无关。
- 市场的分类、场景、反馈三块的接口形状。
- `/api/pricing_new` 与 `/v1/models` 的口径。

## 风险与未决

| 风险 | 应对 |
|---|---|
| 内核锁在 `0.1.0-rc.5`，rc 版接口会变 | fork 而非 submodule 跟随；每次升级前 diff 配置层与 subagent 目录 |
| 外壳是社区单点依赖（anywhere-labs） | MIT 已 fork，最坏情况自己维护 5,766 行 |
| 媒体从零，13 家适配器的端到端战果可能退化 | 逐家复验，不接受"大部分能用"。四条前置证据 2026-08-17 已全部拿到，见阶段 4 |
| **视频 / 音频产物在内核层没有落点**（`ImageMediaType` 只收四种光栅图，`ContentBlockMap` 无 video） | **已选路**：不加模态，照 `ui-deliverables` 形状自写 `ui-media` 插件。四条路里适配器与计费两条免费（探针实证静默丢弃、不抛），UI 那条要改内核文件所以不走。第一步先白嫖现成产出行，且**比今天强**——今天视频卡点开预览抽屉只有图片分支 |
| ~~老客户端还在外面跑，制品要两种格式并存~~ | **不成立，已查库销号（2026-08-18）**：还在开发、没有存量用户，且 desktop-market 那套表在两站线上库一张都没有（117 / 134 张表里 `%desktop%`/`%market%`/`%expert%` 零命中）。制品只按 `kernel_api` 分行，不为客户端代际留兼容分支——照内核 `AGENTS.md:5-7` 的 pre-release 立场 |
| ~~**孤儿写者锁**：进程崩在持锁期间，之后每次写配置等 2173ms 然后失败，内核刻意不夺锁~~ | **已落地** `src/main/dsh/settings-lock.ts` + `npm run verify:settings-lock`（11 项全绿）。判 **pid 三态**而非文件年龄，`EPERM` 必须当"活着" |
| Windows 上「非竞争性锁失败」无上游测试覆盖（他们自己 skipIf win32） | 我们是 Windows 产品，这条分支自己补测试。**守卫这一侧已覆盖**（判据脚本本机 Windows 跑绿，含 `EPERM` 那档）；内核锁本身的失败分支仍待补 |
| 默认通告只说"任务完成了，用 `job_output` 读"，照默认走每次出图多花一轮模型调用 | 自己挂 `ctx.jobs.onJobDone` 把产物直接塞进消息，同时把 `dsh-tool-jobs` 的 `completionDelivery` 设 `'quiet'`，否则两个监听器各投一条 |

**四条闸门全部关掉（2026-08-17 一天内验完，所有探针已删，内核仓库无残留）**：

| 闸门 | 结论 | 真机证据 |
|---|---|---|
| **阶段 1 · 配置的程序化写入语义** | 通过。跨进程文件锁替掉 baseHash，叶级 diff 保注释，操作串行化 | 6 项自写探针 + 内核 `packages/settings` 151 项 |
| **阶段 2 · 思考档位表达** | 通过，且比我们现在更直白：档位直接映射 wire 拼写，方言开关按模型可覆盖 | 8 项自写探针 + 内核 `llm-pi-ai/catalog.spec.ts` 52 项，共 60 项 |
| **阶段 3 · 逐成员 `toolFilter`** | 通过，能过滤祖先 scope 继承来的工具，失手一律 loud | 内核 `core/tools/tests/scoped.spec.ts` 27 项 |
| **阶段 4 · 媒体四条证据** | 长任务与工具闸门**超预期通过**，出图有一等公民的路，**只有视频 / 音频产物要选路** | 6 项自写探针（jobs 投递 / 去重 / 并发 / 取消） |

**没有一条闸门要求改变产品形态。** 阶段 4 那条视频产物的路，是"先做文件产出行、
内联播放留作后续"，不是"媒体退回服务端"。

**那两件工程活也收掉了（2026-08-17）**：

1. **孤儿写者锁兵底 —— 已落地**。`src/main/dsh/settings-lock.ts` +
   `npm run verify:settings-lock`（7 项行为判据 + 4 项内核漂移闸门，全绿）。
   判据是 **pid 三态**，不是文件年龄：`process.kill(pid, 0)` 正常返回 = 活着，
   `EPERM` = **活着但我们没权限**，`ESRCH` = 不存在。只有 `ESRCH` 才回收。
   **这里有个坑值得单记**：仓库既有的 `isAlive`（`openclaw-manager.ts:45-52`）把
   `catch` 一律当"死了"——本机实测 `pid 4`（System）返回 `EPERM`，照那个判据会去删一个
   活写者持有的锁。用来决定"补不补一刀 kill"没问题，用来决定"删不删别人的锁"是错的，
   所以单写了一个。锁内容解析不出 pid 时（进程死在"创建锁"与"写 pid"之间）退回年龄兜底，
   10 秒为界——这不违背内核那条纪律，它拒绝的是"用年龄替代所有判断"。
   漂移闸门每次跑都回内核源码核那三条字面量，内核改了锁文件名或内容格式就变红，
   不会让守卫静默失效。
2. **视频产物显示选路 —— 已定**：不加 `ContentBlockMap` 模态，照 `ui-deliverables`
   的形状自己写 `ui-media` 插件；第一步先用 `presentCall` 的 `kind:'edit'` + `locations`
   白嫖现成的产出行。四条路的逐条定价与理由见上面「视频产物显示：选路结论」。

## 全量装机扫描：407 个专家逐个真装（2026-08-19）

**为什么要跑这一遍。** 生成器那条路早有全量证人（421/421 过断言），装机这条路却只装过 4 个包
——而两条路是两个写者，它们之间唯一被抓到的差异（delegate 工具名连字符 vs 下划线）在被比较之前
是完全不可见的。所以把清单上的 407 条全部走一遍真装机：真签名链接、真对象存储、真在启动起来的
内核里组装。**没有一次模型调用**，所以这一遍的成本只有时间（约 12 分钟）。

探针 `dsh-plugin-desktop/.tmp-probe/market-sweep.mjs`，两个阶段各回答一个问题：

1. **装得进去吗** —— `market.install` 的真实结果。安装器本来就会把内核判为坏的预设回滚
   （`broken-after-install`），所以"报成功"等于"组装出来的东西内核认"。
2. **站得起来吗** —— 逐个挂载：工具解析、派活行变成 `delegate_*` 工具、系统提示词拼得出来
   （不可渲染的模板变量就在这一步炸）。**45 个团全挂**（派活是脆的那一半），单专家抽 40 个。

### 第一轮：403/407，四类失败全是真缺陷

| 失败 | 数量 | 根因 | 处置 |
|---|---|---|---|
| `the stream contains non-printable characters` | 3 | 上游人设里是**被压坏的 emoji**：`## 🔄 Your Workflow Process` 到我们手里是 `## =` + `U+0004`，正是 `U+1F504` 的 UTF-16 代理对（`D83D DD04`）被当低字节写出来。读着没事，装不进去——内核 YAML 拒收非打印字符，于是组装、判坏、回滚 | `persona-rules.ts` 加 `stripNonPrintable`（放在 `scrub` 第一步，早于所有按可读文本写的规则），外加一条只改标题行的残渣改写。**修的是装机路径**：22 个出厂包的源文件扫过，控制字符与残缺标题各 0 命中 |
| slug 撞内核自带预设 | 1 | 上游有一条 `plugin: code`，内核自带的 `code` 是「PTC 模式」。撞上不报错：安装器回「已经装过 code 了（来源：system）」，市场页却显示已安装，用户召唤到的是内核那个预设 | 导入器判**不上架**（`isKernelPresetId` + 建条目时置 hidden），不改名——改名能保住这个专家，但要凭空造一个上游没有的标识，少一个我们认。两条 Go 单测钉住 |
| 随包技能静默丢失 | 8 个包 | 撞的是**我们自己的归档限额**，不是缺东西：`jiayi-ads-analytics-expert-public` 958 条 > 512、`ppt-implement` 708 条 > 512、`malaysia-finance-tax` 单文件 5.5MB > 4MB、`pdb-viewer-skill` 4.8MB > 4MB（它被 4 个 omics 专家共用）、`html-ppt` 压缩 9.8MB > 8MB 下载上限。旧限额是照 22 个出厂包的形状定的（几十个文本文件、不到 1MB），真语料不是那个形状 | 把 994 个已上架技能归档**全量测了一遍**（0 个失败）再定阈值：真实上限是 958 条 / 单文件 5.5MB / 解压 15.7MB / 压缩 9.8MB，其中解压总量离旧的 16MB 只差 4%。新值取实测最大值的两倍上下：`maxEntries 2048`、`maxEntryBytes 16MB`、`maxTotalBytes 64MB`、`MAX_DOWNLOAD_BYTES 24MB` |
| 幽灵工具残留 | 1 处 | `content-creation-expert-prod` 里一处 `read_file` | 不改：规则刻意在 `read_file(` 前止步，那是代码样例，改了样例就错了 |

**结构判据同时全过：0 个"可疑"**——团的成员数 = 派活工具数 = allow 表数，且没有一个残留不可渲染的
模板变量（`provider` / `model` / `cwd` 之外的花括号）。

### 复验：改完再全量装一遍

| 判据 | 结果 |
|---|---|
| 装机 | **406/407**，唯一拒的是 `code`（撞名那条要下次导入才隐藏，本轮没对共享测试站重跑导入器） |
| 结构可疑 | 0 |
| 随包技能 | **762 个全部落地，0 个包缺技能**（改限额前是 752 个、8 个包缺） |
| 挂载 | **85/85 站起来**（45 个团 + 40 个单专家抽样），45 个团的派活工具数与成员数一一相等 |
| 全局工具真相段 | 85/85 在场 |
| 工具面 | 单专家 29 个，团 33–41 个（多的是 `delegate_*`） |

### 记账：还没解决的三件

1. **`code` 那条**要等下一次 `IMPORT_EXPERT_CENTER` 才隐藏。共享测试站的数据我没重导。
2. **一个包的人设 201KB**：`sg-finance-tax` 的 `SKILL.md` 是 201,177 字节 / 119,227 字符
   （汉字占 30%），装出来系统提示词 126,610 字符——第二名 38,786。**粗估 6.1 万 token，
   每一轮都付**，在 128K 上下文的模型上先吃掉近一半窗口。**它真跑过了**：抽样那一轮里
   6 步 58 秒完成、答出 2878 字，上游没有拒收（见下一节），所以体积是价钱问题而不是功能问题。
   既然这不是对错问题：要不要为这类专家付这个价，是**产品/运营的取舍**，不是技术判据能自动裁决的。
   技术侧能给的三个选项，代价各不同：(a) 导入侧按人设体积告警或直接不上架——最省，但等于替
   运营决定了下架谁；(b) 装机侧截断，照内核 `DEFAULT_MAX_SKILLS_PROMPT_CHARS = 18_000`
   那个旋钮的思路——保住条目但用户拿到的是被削过的专家，且削哪一段没有好答案；
   (c) 什么都不改，把体积显示在后台条目上让运营自己看着办——最诚实、最没成本。
   **默认建议 (c)**，等真出现成本或上下文告警再谈闸门。全量里归档 >500KB 的有 9 个、
   >1MB 的 6 个，所以这是个别现象，不是普遍问题。
3. **覆盖面别含混**：这一节新增的是「407 个全部真装 + 85 个真挂载」。装机与挂载是静态到
   半静态的判据，真发一轮是另一件事。**已被下面「抽样真跑」那一节接上**：30 个包各真发一轮
   全部干净，并且顺手把成本量出来了——全量真跑约 16 美元、并发 3 约 6 小时，所以
   「上线前跑全量」是可行的，此处原先写的「24 小时起步、不打算全跑」按实测作废。

### 管理端这一半要不要改：要，且有一个是现在就坏的

| 项 | 拦上线？ | 判断与修法 | 量级 |
|---|---|---|---|
| 制品上传缺 `format` | **拦**（运营根本传不上包） | **已修**。服务端拆表后要求 `format`（`controller/desktop_market_admin.go:307`），而 admin-cloud 只发 `file` + `version`，任何上传都必然回「format 非法」。格式由条目类型推出来（专家 → `expert-content.tar.gz`，技能 → `skill-dir.tar.gz`），不新增界面 | 已完成，3 个文件 |
| `artifact_key` / `artifact_sha256` / `artifact_size` 三列 | 不拦，但**会误导运营** | **已修**，走的是②：服务端列表随条目带一份按 `item_id` 索引的制品 map，前端「制品」列照它渲染。选②不选①（去掉这一列）是因为列表上运营唯一要问的就是「这条能不能被装到」，去掉列等于把这个问题挪进抽屉里逐条点 | 已完成 |
| 制品列表 / 删除 | 不拦 | **已修**。抽屉里逐份列出「格式 × 内核版本 + 体积 + sha + 时间」，每份带「看内容 / 下掉」；下掉走既有的 `DELETE /items/:id/artifact?format=&kernel_api=`。两页共用 `_artifacts.tsx` | 已完成 |
| 重跑导入的入口 | 不拦 | **定了：不做**。导入是一次性命令，上线跑一遍即可（用户口径）。真要重复刷新目录，先答下面第二节的覆盖策略，别先加按钮 | 不做 |
| 条目预览 | 不拦 | **已做，但不是"渲染后的文本"那种预览**：服务端解开归档，报结构与体积（主文件字数、成员逐位字数与开头、随包技能是否缺 `SKILL.md`、其余文件按体积排序）。这答的是"包里装了什么"，而条目字段一个都答不了。全量装机扫描仍是更硬的准入检查，两者不互斥 | 已完成 |

**上线还差的是服务端形态，不是专家包。** 三件事按依赖排：

#### 一、谁来供 `/api/desktop-market/*`：反代那一段，别给客户端加第二个源

客户端整个账号插件只有**一个** `baseUrl`（`openlux-plugin-account/src/index.ts:99`，默认
`https://api.openlux.ai`），登录、余额、模型、市场全走它；而这套路由只存在于 admin-server
（`new-yunwu-api` 全仓搜 `desktop-market` 零命中），它默认还是纯管理端
（`middleware/admin_cloud_only.go:32`）。

**三个前提今天已经成立**，所以这不是"要打通两个系统"，只是"入口上分一条路径"：

| 前提 | 判据 |
|---|---|
| 同一个库 | 两个服务都读 `SQL_DSN`，`admin-server/.env:13` 与 `new-yunwu-api/.env:2` 是同一条 DSN 字面量；`admin-server/cmd/admin/main.go:3-7` 写着「与 yunwu-newapi 共享同一套 MySQL + Redis + Session Cookie」 |
| 令牌互通 | 两边的 `ValidateUserToken` / `GetTokenByKey`（`model/token.go:141`、`:221`）逐字一致，读同一张 `tokens`、同一个明文 `key` 列（`char(48)` 唯一索引，不哈希） |
| 路径不冲突 | 中转站没有这个前缀；admin-server 反过来也不挂任何 `/v1`、`/mj`、`/pg`（它自己的 `deploy/nginx.conf.example:85` 还额外 404 掉这些） |

**先例有四条，反代这条路是本仓房子里的既有做法，不是新发明**：

1. **反方向的同一件事已经在跑**：`admin-server/router/mainsite_proxy.go` 是一个
   `httputil.ReverseProxy`，把 `/api/channel/*` 从 admin-server 转到中转站
   （`MAIN_SITE_API_BASE`，不配就回落本地控制器）。它连跨服务的坑都踩完了：主站只认
   `users.access_token`，而 admin-cloud 前端刻意不持有它，所以是**服务端现签**
   （`EnsureUserAccessToken` + `New-Api-User` 头 + 删掉自己的 cookie）。
   **我们要的方向比它简单**：桌面端带的是 `sk-`，两边同库同校验，不需要身份翻译。
2. 中转站那边为了"被人前置"专门加了豁免：`X-Internal-Proxy` 头让域名守卫放行被改写的 Host
   （`new-yunwu-api/middleware/sub_station_domain_guard.go:11-22`），密钥走共享 `options` 表。
   **admin-server 这一侧不需要对应物**——它没有全局 Host 守卫（`CheckDomainRestriction`
   是逐路由挂的，且未知域名直接放行），桌面市场那组只挂了 `TokenAuth`。
3. `API-server/docs/从单体裁剪清单.md` 第 4 节已经写过按子路径分流的纪律：精确 `location`
   必须写在 `/api/` 通配之前。这正是我们要的那条规则。
4. `admin-cloud/nginx.conf` + `deploy/README.md` §3.3：一个域名两个后端，上游地址走环境变量，
   并记了 `Host` 改写与 cookie domain 的坑。

**口径其实早就定过，只是没进文档，而且新客户端把旋钮丢了**：老客户端的
`yunwu-desktop/src/main/market/market-client.ts:19-30` 写着生产形态是「激活配置里的 baseUrl
——**若把 admin-server 反代到同域 `/api` 下即可直接命中**；独立部署时用 env 指向公网地址」，
并配了 `YUNWU_MARKET_BASE_URL` / `YUNWU_MARKET_TOKEN` 两个覆盖口。DSH 那套账号插件只有一个
`baseUrl`，等于把这两个旋钮收掉了。

**所以结论是反代，不是给插件加第二个源**：加第二个源就是把老客户端那两个旋钮重新造一遍，
多一个能配错的面、且开发期还得配第二把令牌（因为两把令牌来自两个库）；而反代之后客户端
一行不用改，令牌天然是同一把。要落的就一条 `location`：

```
location /api/desktop-market/ { proxy_pass http://admin-server:3001; }   # 写在 /api/ 通配之前
```

**待运维确认的一条**：`admin-server/cmd/admin/main.go:229-234` 的注释说「当前部署已无
yunwu-newapi 主进程」。如果这句是当前事实，那么 `api.openlux.ai` 背后到底是谁、
`mainsite_proxy` 那条转发今天有没有目标，都要拿真机确认再定 `proxy_pass` 的上游。
仓库里没有任何一份文件写着生产拓扑（所有 nginx 都是 `your-domain.com` 模板）。

#### 二、生产库建表 + 跑一次导入；「后台重跑入口」要不要做，先答覆盖策略

两站线上库今天 `desktop*` 一张表都没有（判据看 `information_schema`），所以是 AutoMigrate
建表 + `IMPORT_EXPERT_CENTER=1` 跑一次。**上线不需要后台入口**：导入是一次性命令，跑完就退出、
不绑端口（`cmd/admin/main.go:54-155`），生产就是起一个临时容器/一次性 job 的形状。

**但"要不要做入口"这个问题问反了**。上游清单是活的（2026-08 实测 406 条，8-19 数到 421 条），
所以刷新目录这件事一定会重复发生；真正要先定的是**目录的所有权**：
`import_expert_center.go:1027-1029` 明说「每轮都按当轮事实重算上架状态……代价是运营在后台
手工改过的上架状态会被下一次导入覆盖」。也就是说今天做一个"重跑导入"的按钮，等于给运营一个
会悄悄抹掉他自己上下架决定的按钮。三种口径，选一个再谈入口：

| 口径 | 含义 | 代价 |
|---|---|---|
| 导入永远赢（今天的行为） | 上架状态完全由规则算出来 | 运营不能手工下架任何一条；按钮很危险 |
| 运营赢 | 加一列"人工锁定"，导入跳过被锁的条目 | 上游修好了空壳包也不会自动回架，要人工解锁 |
| 分层 | 规则算"可不可上架"，运营只在可上架集合内决定"上不上" | 语义最清楚，改动最大 |

按依赖排：**上线用一次性命令，不阻塞**；入口排到覆盖策略定了之后再做，形状照 admin-server
既有的异步任务先例（`ExportTask` 那种落表 + 进度），别做成一个同步请求跑十几分钟。

#### 三、制品对象存储配 S3

不配会回落本地磁盘（`service/desktop_market/artifact.go:25-29`），多实例或重启后预签名直链
就断。这条没有争议，属于部署清单。

**专家包本身不用改，这一点是有机制托着的**，不是运气：Go 导入器把上游包归一成
`expert-content.tar.gz`（人设 + 成员 + 随包技能清单），客户端装的时候再过 `compose.ts` 那一层
——人设改写（`FABRICATION_FIXES` + `MECHANICAL_REWRITES`）、成员 `toolFilter.allow`、派活行、
技能根、不可渲染变量拒装。所以"线上拉一遍数据就能用"成立的前提是这层转换在装机时跑，
而不是有人逐个手改了 407 个包。今天这一遍 406/407 就是这个前提的证据。

## 抽样真跑：30 个专家各真发一轮（2026-08-20）

**这一遍回答的是上一节答不了的那半个问题。** 装机与挂载都是不发模型的判据：文件组装得出来、
工具解析得开、提示词拼得出来。而只有真发一轮才会暴露**请求本身**坏掉的那一类——人设大到上游
拒收、人设指使模型去调一个不存在的工具、派活派出去成员回不来、模板到建请求那一步才炸。
这一类失败由**包的形状**决定，不由行数决定，所以按形状取 30 个，等于把 407 行里所有不一样的
形状各走一遍；剩下的 377 个是同形状的重复。

### 抽样怎么挑：按会出事的形状，不摇号

| 类 | 个数 | 为什么非它不可 |
|---|---|---|
| `mangled` 非打印字符 | 3 | 控制字符剥离是新加的，装得进去只证明 YAML 过了，不证明模型读得动那份被改过的人设 |
| `huge` 超大人设 | 3 | 提示词 12.6 万 / 12.5 万 / 7.7 万字符，上下文拒收只会在这里出现 |
| `skills` 随包技能 | 7 | 归档限额刚放开，含之前实测缺技能的 `malaysia-finance-tax`、`ppt-implement`，和共用 4.8MB 单文件技能的 omics 一支 |
| `team` 专家团 | 9 | 派活是脆的那一半。铺开规模：12 / 10 / 8 / 8 / 6 / 6 / 6 / 4 / 3 个成员位，含唯一残留幽灵工具 `read_file` 的 `content-creation-expert-prod` |
| `thin` 最小组合 | 4 | 货架上组合最小的四个（`agent.cordis.yml` 13.6k–13.9k 字符，装出来提示词 9.0k–9.3k），空壳包会藏在这里 |
| `ordinary` 中段 | 4 | 不能整个样本都是异常值 |

出厂的 22 个刻意排除（它们早跑过冒烟），所以这 30 个全是**市场装机得来的**副本。

### 怎么跑的

探针 `dsh-plugin-desktop/.tmp-probe/turn-smoke.mjs`，分两段是**被凭据逼的**：装机要拿测试站令牌
打本地 admin-server，真发一轮要拿生产令牌打网关，而账号插件只有一个 `OPENLUX_API_KEY`。
所以第一段用 `SWEEP_HOME=<dir>` 把装机结果留在盘上（`market-sweep.mjs` 加了这个口），
第二段启同一个 home、换回生产凭据、`agent-presets` 的根指向 `<home>/.agent-presets`。

- 模型：`openlux/deepseek-v4-flash`，**就是默认选择**，没有为测试挑一个更强的。
- 一句提示词打全部 30 个：自述身份与可用技能/成员 → 挑最典型的任务做出第一步**实际产出** →
  有成员必须至少派一位并转述结果。三句都是判据：自述看人设有没有压住通用身份，
  "实际产出"逼出真步骤而不是一份计划，"必须派活"是团的成员进场的唯一途径。
- 并发 3（网关在压力下回过 429），单轮上限 8 分钟。
- **无人在场的两处代偿**，都记了账：审批一律放行（实测被问 **0** 次——这个 profile 下
  `pwsh` / `write` 走的是沙箱与 fs 观察策略，不走审批）；"问人"的工具（`ask_user_question` /
  `exit_plan_mode`）在分发前拒掉，拒绝理由本身就是给模型的指令（实测触发 **0** 次，
  提示词里那句"不要问我问题"是有效的）。

### 结果：30/30 干净

| 判据 | 结果 |
|---|---|
| 一轮跑完并给出答复 | **28/30 在 8 分钟内 `turn/end = completed`**，答复 377–6661 字符、1–40 步；另 2 个撞上限，换 25 分钟重跑后也完成（见下），合起来 **30/30** |
| 调用了自己没有的工具（`unknown tool` 那条路） | **0**——含那个人设里还留着 `read_file` 的包，它一次都没去调 |
| 团真派活 | **9/9** 都至少派了一位，9 个团共派出 12 位；成员会话真跑工具，最多一个团的成员合计 76 次 |
| 非打印字符修过的 3 个 | 全跑通（4 / 14 / 21 步） |
| 超大人设 | `sg-finance-tax` 提示词 **126,610 字符**、6 步 58 秒完成，**上游没有拒收** |
| 随包技能真被用 | `skill` 工具真被调用 14 次（此前只有单体专家有过一次正面证据） |
| 工具报错 | 只有 `opc-team` 两处 `FS_NOT_OBSERVED`（内核的"覆盖前先读"策略在正常工作，模型自己绕过去了）；第三处是探针到点取消留下的 `ABORTED`，不算包的事 |

人设确实压住了通用身份，四条随手抽的自述都对得上号：`sg-finance-tax` 自称新加坡财税金融专家
并列出 IRAS/MAS/ACRA 规则库；`kdocs-ppt-creator` 自称 WPS AIPPT 创作助手、点名自己的
`aippt` 技能；`fbsir-eight-seat-board` 把成员交回的风险清单逐条转述并标了证据边界；
`omics-tfold-expert` 撞上本机没装 `omics-platform-cli`，**如实报告失败而不是编数据**。

### 两个撞上 8 分钟上限的：判据是耗时不是超时

`references/experts-and-teams.md` 记着一条实测：首发上游等过 3 分 16 秒，所以
**"多久没回就算失败"不是判据**。探针照这条把截断记成「慢」而不是「坏」，然后换 25 分钟上限
单独重跑这两个——**2/2 完成**：

| 包 | 8 分钟那轮 | 25 分钟那轮 |
|---|---|---|
| `malaysia-finance-tax` | 15 步 / 20 次工具，产出已落盘、子代理已派出 | **349 秒完成**，34 步 / 40 次工具，答复 12,434 字符（中途 3 次 `FS_NOT_FOUND`，读了个不存在的路径，自己改对了）|
| `trading-agent`（12 个成员位） | 1 步 / 2 次派活，成员会话已跑 76 次工具 | **478 秒完成**，派了 4 位成员、成员会话合计 134 次工具，答复里逐位列出四位分析师的评分 |

`trading-agent` 只比原来的上限多用了 **2 秒**。所以那两条"截断"是**我给的上限**造成的，
不是包的问题——这也说明上限本身是判据风险的一部分，全量跑要给到 20 分钟以上。

### 这一遍花了多少钱：网关账单说 $1.19

探针自己数的 token 只覆盖 leader 会话，所以口径以网关账单为准
（`openlux` 站 `logs`，`user_id=745453`「云雾桌面客户端」令牌，`QuotaPerUnit=500000`）：

| 模型 | 调用 | 输入 token | 输出 token | 折美元 |
|---|---|---|---|---|
| `deepseek-v4-flash` | 776 | 22,648,222 | 315,366 | $1.08 |
| `claude-haiku-4-5` | 189 | 132,299 | 153,056 | $0.11 |

**那 189 次 haiku 是我们自己配的，不是意外**：明细日志里的请求体是
`{"tools":[{"type":"web_search_20250305"}]}`，对应
`dsh-plugin-desktop/cordis.patch.yml:168-172` 把 `web-search-deepseek` 的模型定为
`claude-haiku-4-5-20251001`——那一段注释（`:146-158`）记着 2026-08-18 的实测理由：
deepseek 渠道不支持 Claude 格式、`deepseek-v3-search` 只回散文没有引用字段，只有 haiku 的原生
`web_search_20250305` 会回带 `url` / `title` 的结构化结果。所以这不是缺陷。
**但它是一条与聊天模型无关的独立账单**，重搜索的专家（`lazy-travel-planner` 那一类）成本结构
和别人不一样，全量估算时不能只按聊天模型算。

**由此全量真跑的价钱第一次有了实测底数**：30 个 28 分钟 / $1.19 → 407 个约
**$16、并发 3 约 6.3 小时、并发 6 约 3 小时**。钱不是障碍，时间也在一个晚上之内，所以
**上线前跑一遍全量是可行的**，判据照这一节，上限调到 20 分钟以上、并发看 429 再定。

### 这一遍没证明什么

- **不证明产出质量。** 判据是"机器没坏"：跑完、有答复、没调不存在的工具、该派活的派了。
  产出好不好是运营看内容，技术判据给不了。
- **只跑了一个模型**（默认的 flash）。换模型会变的是行为而不是机制，但确实没测。
- **无人值守下不能问人。** 真实用户会答，探针只能拒；所以"模型问了问题就卡住"这条路径
  这一遍没走到（也没触发）。
- **成员没有逐位跑遍。** 45 个团 × 平均 6 位成员是 260 多个角色，这一遍进场的是被 leader
  自己选中的那些（9 个团共派出 12 位）。要逐位跑就得绕开 leader 直接调 `delegate_*`，
  那是另一件事。

**怎么复现 / 证据在哪**：

```powershell
# 一、装机（测试站令牌打本地 admin-server:3000），home 留在盘上
$env:SWEEP_HOME="…\.tmp-e2e\smoke-home"; $env:SWEEP_ONLY="<逗号分隔的 slug>"
node .tmp-probe\market-sweep.mjs
# 二、真跑（本机生产凭据 → 网关），并发与上限走环境变量
$env:SMOKE_HOME="…\.tmp-e2e\smoke-home"; $env:SMOKE_CONCURRENCY="3"; $env:SMOKE_CAP_MS="480000"
node .tmp-probe\turn-smoke.mjs
```

逐轮记录 `.tmp-e2e/smoke/turns-30.jsonl`、汇总 `.tmp-e2e/smoke/smoke-30.json`
（含每一轮的工具调用序列、答复尾巴、结束原因、token 数），重跑那两个在 `smoke.json`；
`.tmp-e2e/smoke-report.mjs` 把它们印成上面这些表。

## 出厂预设目录清零：22 份全删，专家只从市场来（2026-08-20）

`dsh-plugin-desktop/config/agent-presets/` 原先躺着 22 份物化好的专家（822 文件 / 20.3 MB，
其中 `content-creator` 与 `ai-content-creator-team` 已入库 100 个文件，其余 20 个一直是未入库的
本机产物）。**全部删掉**，安装包里不再随包任何专家。

**这是 WorkBuddy 的形状，不是我们省事。** 解包它的安装包（`D:\workbuddy\resources\app.asar`，
21000 条）看随包插件：`resources\plugins\workbuddy-builtin\` 下 825 条里有 `skills\`（含
`recommend-experts` / `expert-manager`）、`mcps\`、`prompt-common\`、`welcomemode\{work,design,code}\agents\*.md`
——**一个市场专家都没有**，市场专家全在下载来的 `%USERPROFILE%\.workbuddy\plugins\marketplaces\`
里，这与技能那一节早先量到的「`.workbuddy\skills` 是空的」是同一件事。

**删之前钉了四处会踩空的地方，四处都不踩：**

| 疑点 | 事实 | 证据 |
|---|---|---|
| 预设根指向不存在的目录会不会启动失败 | 不会，ENOENT 直接当零行 | `dsh-agent-presets/lib/index.js:240-242` |
| 新会话的默认预设会不会指到被删的 slug | 不会，默认是内核只读的 `standard` | `dsh-plugin-desktop/cordis.patch.yml` 自己写着 *Our product default IS the shipped read-only `standard`* |
| 打包白名单那条断言会不会挂 | 不会，它断言的是数组本身，glob 匹配不到东西不算错 | `tests/package.spec.ts:187-206`，改后 74 例全过 |
| 启动守卫会不会按预设数量断言 | 不按，它只查工具行与 `web_search` 的注册位置 | `scripts/verify-profile-boot.mjs`，删后 exit 0 |

**代价只有一条，而且是产品决定不是技术缺陷**：市场服务端上线之前，新装机器的选择器里只剩内核
那 4 个（标准模式 / PTC 模式 / 极简模式 / 创造模式，全是编码向的），召唤市场专家要先登录且要有人供
`/api/desktop-market/*`。WorkBuddy 对同一个空档的答案是随包三个欢迎模式（work / design / code），
我们今天的答案是内核 `standard`——**要不要也给一组产品化的开箱人设，是运营/产品口径**，
技术上现在两条路都通（放回 `config/agent-presets/` 就是随包，白名单和预设根都还在）。

**顺手补掉一个被这次删除暴露的空洞。** 两条写入路径的等价性测试原先是拿
`config/agent-presets/<pkg>/agent.cordis.yml` 当比对目标，且写着「没物化过就跳过」——
目录一删它会 22 例全部**静默空过**（文件耗时从 465 ms 就能看出来什么都没跑）。改成测试自己
把生成器跑进临时目录再比：生成器多认一个 `OPENLUX_PRESET_OUT_ROOT`
（`scripts/materialize-expert.mjs:41`），测试按包 spawn 它、从它自己报的 `dest` 读回
（`tests/market-compose.spec.ts:280-295`）。**现在这 22 例是真跑的**：同样 54 例，耗时
237 ms → 10.3 s，且不再依赖"有人先手工物化过"这个前提。

## 管理端补齐：制品说真话 + 归档预览，外加一个一直坏着的详情接口（2026-08-20）

**三条口径先定下来（用户口径，本节按它落地）：**

| 问题 | 口径 |
|---|---|
| 生产谁供 `/api/desktop-market/*` | **就按本地这套，admin-server 直接供**。前提已核实：`ADMIN_CLOUD_ONLY` 的封禁名单里没有这个前缀（`middleware/admin_cloud_only.go` 的 `blockedSelfServiceExact` / `blockedSelfServicePrefixes` 都不含它），所以它在纯管理端形态下照样对外。剩下的只是入口怎么摆——同域反代一条 `location`（上一节的四条先例）还是让客户端直连 admin-server 的地址，属于运维选择，代码两边都不用改 |
| 后台要不要「重跑导入」入口 | **不要**。导入是一次性命令，上线跑一遍就行 |
| 6 万 token 人设要不要体积闸门 | **不要闸门，包是怎么样就是怎么样**。所以这一轮既不在导入时拒收大包，也不在装机时截断，预览里也不设阈值、不标红「太大」——只把字节数与字数照原样报出来 |

**这一轮真正的收获是一个没人报过的缺陷。** 制品拆表那一版（`admin-server` 的 `d35d86c`，
8-18）把详情接口的返回体从「条目」改成了 `{item, artifacts}`，而 admin-cloud 侧
`src/api/desktop-market.ts` 从那天到今天只改过一次（补 `format`），**始终把整个 `data` 当条目
返回**。后果不是报错而是静默错位：编辑抽屉里 `detail.name`、`detail.manifest` 全是
`undefined`，专家页与连接器页两处都中；而 `manifest` 是整条覆盖写回的，**运营重新填一遍名字
保存，就把导入写进去的清单抹平了**——按客户端今天真正读的那两样算，代价是随包技能不再安装、
召唤不再预填开场白（`market/console.ts:129-143` 只取 `bundledSkills` 与
`defaultInitPrompt`/`quickPrompts`；成员是从归档的 `members/*.md` 读的，不受这条影响）。
判据不是读代码猜出来的，是真机上看到的：修好之后同一个抽屉里 `#name` 的值是「科研专家团」，
修之前是空。

**这一轮改了什么**

| 改动 | 位置 | 为什么这么改 |
|---|---|---|
| 详情返回体解包 | `api/desktop-market.ts`、专家页、连接器页 | 见上。类型上钉成 `DesktopMarketItemDetail = { item, artifacts }`，让编译器替我们看住第二次漂移 |
| 列表带制品摘要 | `model.ListDesktopMarketArtifactsByItems` + `GetAdminDesktopMarketItems` | 一次 `IN` 查完一页，挂成与 `items` 同级的 map。不塞进条目结构：那个结构直接映射数据库表，多一个非列字段会让写路径也长出一个不存在的列 |
| 已删三列清零 | `types/admin/desktop-market.ts` + 两页 | `artifact_key` / `_sha256` / `_size` 从类型和渲染里一起删掉，列表列改读上面那份 map |
| 制品清单 + 逐份下掉 | 新增 `pages/desktop-market/_artifacts.tsx`（专家页与技能页共用） | 一个条目可以同时有多份投放目标（格式 × 内核版本），"已上传/未上传"这种单值展示表达不了。空态写成「还没有制品，客户端装不了这条」而不是留白 |
| 上传口改收 `tar.gz` | 两页的 `Upload` | 服务端只认 tar.gz（`validateTarGzArchive`），而界面写着「persona 包(zip)」、`accept=".zip"`——运营照界面选出来的文件必然被拒 |
| 归档预览 | `service/desktop_market/preview.go` + `GET /items/:id/artifact/preview` + 前端弹窗 | 条目字段答不了「成员少一位」「随包技能一个都没进去」。服务端解开归档现算，不落盘、不落库 |

**预览只报事实**：主文件（内容型归档是根 `SKILL.md`，预设归档是 `agent.cordis.yml`）的字节数、
字符数与开头一段；成员逐位的字数与开头；随包技能逐个的文件数、体积、**有没有 `SKILL.md`**（没有
就是客户端的技能层根本发现不了它，这个标红）；其余文件按体积从大到小（运营问的是"谁把包撑起来
的"，字母序答不了）。字符数与字节数两个都给：CJK 人设两者差三倍，运营看的是前者。

**真机验了什么（本地 admin-server:3000 + 测试库 `jishu_test` + admin-cloud dev:5188）**

| 验的事 | 结果 |
|---|---|
| 列表带制品、条目行上没有残留列 | `顶层字段: artifacts, items, limit, page, total`；420 条专家里首页 5 条各自 `expert-content.tar.gz@* 320KB…4KB`；`条目行上残留的已删列: 无` |
| 详情形状 | `data 的字段: artifacts, item`；`item.name=腾讯HR数智专家 manifest 639 字 制品 1 份` |
| 专家团预览 | `empirical-research-team` 归档 29 KB → 解开 75 KB / 13 文件，负责人 6398 字，成员 7 位逐位带字数与开头（`academic-writer.md 4160字` …） |
| 大包不设闸门也给得出结构 | 全库最大三份：`indonesia-digital-law-expert` 3130 KB（2.5 s）、`malaysia-hr-admin` 2167 KB / 44 文件、`south-africa-hr-admin` 1529 KB / 146 文件，都正常返回 |
| 技能归档（另一种格式） | `net-new-video-editor` 6 文件 / 主文件 `SKILL.md` 4184 字，抽屉与弹窗都正常 |
| 坏参数 | `format=nonsense` → `format 非法`；`preset-dir.tar.gz@0.0.0-nope` → `该投放目标下没有制品` |
| 界面上真点一遍 | 建一条草稿条目 → 上传一份最小归档（`format` 由页面推出来，服务端收下）→ 列表列显示 `专家内容 534 B` → 「看内容」读出 2 位成员 + 2 个技能（故意缺 `SKILL.md` 的那个标红）→ 「下掉」后 toast「已下掉该制品」、抽屉变空态、列表列变「无制品」→ 删掉该条目。控制台无新增报错 |
| 静态检查 | `go build ./...` + `go test ./service/desktop_market/`（新增 3 例预览测试，含专家团形状、预设主文件、坏字节/空归档）；admin-cloud `tsc -b` 与改动文件 `eslint --max-warnings 0` 都干净 |

**顺手记两件真机上才看见的小事**：成员开头原先挂了 tooltip，1600 字节的气泡会糊满整屏，去掉——
两行摘要已经够判断这一位是不是空壳；antd 的 `destroyOnClose` 在当前版本已废弃，改 `destroyOnHidden`。

## 编辑抽屉里的老字段：六个填了不生效的，删（2026-08-20）

上一节修完详情解包，抽屉这才第一次真的回显出内容——于是看见了另一半问题：**抽屉里一多半的字段，
新客户端根本不看**。

判据是客户端读清单的入口只有一处，`openlux-plugin-account/src/market/console.ts` 的
`readExpertManifest`，它只取 `bundledSkills` 与 `defaultInitPrompt`/`quickPrompts`；卡片渲染
用的是条目自己的列（名称、`icon`、`is_team`、标签、简介），身份、成员、工具一律来自归档
（`compose.ts` 的 `readExpertContent` 只吃根 `SKILL.md` + `members/*.md`）。老客户端不是这样：
它把人设当技能装到 `~/.openclaw/skills/<personaSkillSlug>`，再按 `model` / `tools` /
`displayName` 写一份 `AgentConfig`（老仓 `src/shared/types.ts:1075-1102`）。那套播种方式随内核
一起没了。

| 字段 | 处置 | 依据 |
|---|---|---|
| 职业/头衔 `profession`、展示名 `displayName`、专属模型 `model`、工具白名单 `tools`、persona 技能 slug `personaSkillSlug`、`agentId` | **删**（表单、类型、导入器写入三处一起） | 客户端已无读取方。留着不是中性的：运营在「专属模型」里填一个值，界面看着生效，客户端根本不看 |
| 团队成员 `memberSlugs`（多选器） | **删** | 成员来自归档的 `members/*.md`，选择器选的是"市场里另一条专家"，两套名单对不上；`compose.ts` 也不读它 |
| 头像 `avatar` | **留，继续双写** `manifest.avatar` + 条目列 `icon`（用户口径） | 客户端读的是 `icon` 列 |
| 专家团开关 `isTeam` | **必须留** | `is_team` 列是从它推导的（`model.DeriveIsTeam` 是那一列唯一真值来源），而客户端「专家团」那一页读的是那一列。差点跟着一起删——这也解释了上一节里手工建的临时条目为什么没成团：`is_team` 不是接口字段，传了也没用 |
| 随包成员 `members` | 留，只读展示 | 客户端不读，但它是后台唯一能看出"这个团有几位成员"的地方 |

**还揪出一个同类的静默写坏。** 抽屉原先是**重拼**一份 manifest 再整条覆盖，只手工把
`members` 带回来。导入器写进去的键比表单多：`lead`（负责人展示行）、`source`（来源标记）
——这两个从来没被带回来过，**运营保存一次就没了**。现在改成"在存量上覆盖表单拥有的那几项"
（`{ ...parseManifest(editing?.manifest), ...表单项 }`），表单不认识的键原样留着，这一类事故
整类消失。`parseManifest` 的返回类型也跟着写成 `Partial<ExpertManifest> & Record<string, unknown>`，
把"可能还有别的键"这件事说给编译器听。

**顺带**：列表「专家」列的副标题原先写 `m.profession || row.slug`、头像写 `row.icon || m.avatar`
——列表接口 Omit 掉了 longtext manifest，所以那两个 `m.*` 一直取的是空值。改成只读条目列。

**真机验的（本地 admin-server:3000 + `jishu_test` + admin-cloud dev:3002）**

| 验的事 | 结果 |
|---|---|
| 抽屉里还剩哪些字段 | 名称 / slug / 简介 / 分类 / 头像 URL / 自带技能 / 快捷提示词 / 开场白 / 专家团 / 随包成员（只读）/ 版本 / 标签 / 状态 / 推荐 / 排序值 / 归档上传。六个死字段不再出现 |
| 专家团存一次不掉东西 | `#620 ai-content-creator-team` 保存前后 manifest 键完全一致（含 `lead`、`source`），`members` 6 位、`quickPrompts` 3 条、开场白都在，`is_team` 仍为 `true` |
| 客户端真读的那个键不掉 | `#806 investment-banking` 保存前后 `bundledSkills` 都是 22 个 |
| 静态检查 | `go build ./...`、`go test ./service/desktop_market/`、`tsc -b`、改动文件 `eslint --max-warnings 0` 全干净 |

**存量里的死键怎么清**：合并写入会把它们原样留着（它们此刻是惰性的，没有读取方）。清理靠下一次
导入——`upsertItem` 走的是整条覆盖（`seed.go:315` 的 `UpdateDesktopMarketItem`），而导入器这一轮
已经不再写那四个键，所以上线时跑的那遍全量导入会顺手把存量抹干净。

**另外看到一件不属于本轮、但记下来**：连接器页要求填一份合法的 MCP 清单（校验 `mcpName` /
`server`），而新客户端全仓搜不到任何读取方——`catalog.ts` 只把连接器标成"没有归档也算可用"，
没有安装路径。也就是说连接器今天在客户端还落不了地，那份清单是给将来的安装器留的契约。

## 真机环境地图：三个家目录、两个应用、两套配置（2026-08-20）

写这一节的直接起因：客户端侧栏里只剩 9 条会话，而记忆里有九十多条；找不到之前真机测出图的那些
对话，也找不到市场装下来的预设。三个问题的答案都是同一件事——**东西在别的家目录里**。下次再"东西
不见了"，从这张表开始查，不要从代码查。

### 三个家目录，各存各的

| 家目录 | 谁在用 | 里面有什么（2026-08-20 实测） |
|---|---|---|
| `~/.dsh` | 日常那份客户端 | 1 个工作区 `C:\Users\000\Desktop`，9 条会话；凭据 `.credentials.yaml`；`.agent-presets/` 只有 `kumo-team`、`kumo-test` |
| `%TEMP%\yw-dsh-live` | **所有真机验证**（`DSH_HOME` 指过去） | 194 条会话，其中 174 条在工作区 `D:\work\yunwu-jihe\yunwu-desktop\dsh\dsh-plugin-desktop`；`media/` 下 5 张图 + 5 段视频（含 UI 测试那张黑金封面 `一张高端电影感的横版视频封面图…-3ffe7c53dae8.jpg`，1.4 MB，8/19 22:49）；12 个预设，含市场装的 `video-dissection` |
| `~/.openclaw` | 换内核前那个产品 | `agents/main/sessions` 67 条在册对话（另有 202 个 `.deleted.*` 墓碑），最后一条写于 **8/17 15:27**——正是切内核那一刻。全盘 70 条 |

三件要点：

1. **测试一律用隔离家**，这是有意的：真机验证会装几十个预设、写几百条会话、落几十 MB 图片视频，
   不该进你日常那份 profile。代价就是"测过的东西在日常客户端里看不见"。
2. **`yw-dsh-live` 在 `%TEMP%` 下**，Windows 磁盘清理会动它。里面的会话和图要留就得挪到稳定位置。
3. **会话按工作区分目录**（`sessions/--<转义后的路径>--/`），侧栏只列当前工作区那一批。所以即使
   家目录对了，换个工作区照样"少了一半"。
4. 新客户端**没有**读 `~/.openclaw` 的代码（`dsh/` 全仓搜 `.openclaw` 零命中），所以旧对话不会自己
   出现。搬迁需要写一个转换脚本：旧的是 `agents/<agent>/sessions/<id>.jsonl` 明文，新的是
   `sessions/<工作区>/<id>/session.jsonl.zstd`，schema 也不同。

### 两个应用别搞混

| | 本机安装的 | 我们从源码起的 |
|---|---|---|
| 可执行文件 | `%LOCALAPPDATA%\Programs\DSH Desktop\DSH Desktop.exe` | `dsh/dsh-plugin-desktop` 里 `node lib/bin.js` |
| 窗口标题 | `DeepSeek Harness Desktop` | `OpenLux` |
| `PRODUCT_NAME` / userData | `DSH Desktop` → `%APPDATA%\DSH Desktop` | `OpenLux Desktop` → `%APPDATA%\OpenLux Desktop` |

两者 userData 分开，但默认都用 `~/.dsh` 当 DSH_HOME，所以**别同时开**——会抢同一份会话与凭据。

**它还会自己升级，然后把家目录迁到我们读不了的格式（2026-08-23 栽了一次）。** 那天开发版
启动即崩：

```
credentials-local: the value for "version" in C:\Users\000\.dsh\.credentials.yaml must be a string
```

真因不是我们改坏了什么：安装的那份（命令行带 `--updated`，Squirrel 升级后的标志）已经跑在比
`rc.6` 新的内核上，把 `.credentials.yaml` 从**平铺 map**（`KEY: value`，rc.6 唯一认的形状，
见 `dsh-credentials-local/lib/index.js:121` `parseCredentialsDocument`）迁成了
`version: 1` + `refs:` 的嵌套形状。新版能读旧的，旧版读不了新的，于是只有开发版起不来。

处置：备份后把三条 `refs` 提回顶层平铺，开发版即正常启动；下次安装版再跑一遍又会迁回去，
所以**这是每次它自动更新后都会复发的**。两个信号帮你 5 秒定位而不是去查自己的改动——
崩在 `#credentials` 这一层、且报的是「某个键的值必须是字符串」。
根治要么钉住安装版不让它升，要么给开发版单独一个 `DSH_HOME`（但会再多一个家目录，见上）。

从源码起之前先重建两个包，否则你看到的是上一次构建的代码（8/19 那次就是这么差点看错的）：

```powershell
cd d:\work\yunwu-jihe\yunwu-desktop\dsh\openlux-plugin-account; npm run build
cd ..\dsh-plugin-desktop; npm run build; node lib/bin.js
```

要看隔离家里那批测试会话，加一个环境变量即可，日常那份 `~/.dsh` 不受影响：

```powershell
$env:DSH_HOME="$env:LOCALAPPDATA\Temp\yw-dsh-live"; node lib/bin.js
```

### 两套配置：生产 / 本地市场，二选一

根子在于**客户端整个账号插件只有一个 `baseUrl`**，登录、余额、模型、市场共用它。所以这不是
"要不要看市场"，是二选一：

| | 生产（默认） | 本地市场 |
|---|---|---|
| `baseUrl` | `https://api.openlux.ai`（网关站） | `http://127.0.0.1:3000`（admin-server） |
| 能用的 | 登录、余额、模型全正常 | 市场能逛（测试库 420 个专家 / 专家团） |
| 不能用的 | **市场页 404**——线上还没有任何一台在供 `/api/desktop-market/*` | 余额、模型全打到 admin-server，那台不供这些 |
| 凭据 | 生产令牌 | **测试站令牌**（jishu_test 的 `tokens` 表里取一条 `status=1` 的） |

切到本地市场：写机器级补丁 `~/.dsh/cordis.patch.yml`（**用户级补丁的正确位置是这里，不是
`~/.dsh/profiles/desktop/cordis.patch.yml`**，后者试过不生效），

```yaml
- id: openlux-account
  config:
    baseUrl: http://127.0.0.1:3000
```

再把 `~/.dsh/.credentials.yaml` 里的 `OPENLUX_API_KEY` 换成测试站令牌，重启客户端。切回生产就是
删掉这个文件、把凭据换回来。

补丁到没到，别靠猜，跑一次只读探针 `dsh-plugin-desktop/.tmp-probe/patch-reach.mjs`：它按启动器同样
的方式组装 profile，打印所有跟账号插件有关的条目。判据是有补丁时 48 条、`#38 id=openlux-account
config={"baseUrl":"http://127.0.0.1:3000"}` 排在插件插入项（#30）之后；删掉补丁回到 47 条、
那一条消失。

### 踩过一次的坑：换了凭据没换回来，四个半小时没发现

8/20 04:24 为 UI 测试把 `~/.dsh/.credentials.yaml` 换成测试站令牌，当时以为还原了，其实没有——
直到 05:55 起客户端才发现。留下的证据很直白：那个文件的修改时间**正好是 04:24:56**，长度从 743
字节缩到 139，`OPENLUX_SESSION` 整段丢失。

判据不用猜，两条对打就行：拿现用的 key 打本地 admin-server（测试库）——`200 success=true` 说明它是
测试站的；拿备份里那把打同一个口——`401` 说明它是生产的。还原后客户端余额正常显示，这才算真的回来。

**所以规矩是**：换凭据必须同时留一份带时间戳的备份，用完立刻还原并用上面那条对打确认，不要靠"我记得
还原过"。本机两份备份放在 gitignore 掉的 `yunwu-desktop/.tmp-e2e/backup/`（`live.credentials.yaml`
是生产那份、`test-station.credentials.yaml` 是测试站那份）——**令牌不入库**，换机器就按上表重新取一条。

## 模型列表改成两层：服务端下发 + 用户自留（2026-08-20）

**要复现的结果**（先写清结果，再挑能到达它的能力）：运营在服务端改下发清单，增的删的在用户
**下次启动**都跟着变；用户自己添加的模型一个字都不动；下发的那几条用户**删不掉也改不了**。
第三条是用户明确要的（"不让删、不让改名"），等于把 Chrome 的 `recommended` 换成 `mandatory`。

**光把那个常量换成服务端下发是不够的。** `STARTER_MODELS` 只在"从未决定过成员"的机器上种一次，
种完写进 settings 的 user 层，`membershipDecided` 从此为真（`models/sync.ts:186-198` 改前），之后永不增删。
所以改数据源只对新装机器有效，存量装机一辈子收不到下发变更——这正是要动合并逻辑的原因。

### 参考实现（2026-08-20 联网查的）

三个不相干的领域给出同一个答案：**基线 + 用户增量，靠溯源标记区分每条归谁**。

| 参考 | 它怎么做 | 我们取哪一点 |
|---|---|---|
| **Cherry Studio**（同类 Electron AI 客户端，与我们形状最像）| `user_model` 表每行带 `presetModelId` 做溯源；读取时**以当前注册表为基线、只叠加用户存下的 delta**，预设行只物理存用户改过的列（PR #17442：*registry updates now apply to existing providers and models while preserving user overrides*）| 溯源标记这个位置，以及"基线可变、增量持久"的读取模型 |
| **K8s server-side apply** | `managedFields` 记录字段归属，apply 时删掉"我上次拥有、这次不再声明"的，**前提是没有别的 manager 认领过** | 删除的判据。没有标记就只能比对数组按值猜意图，那正是 `sync.ts` 原来不敢删的原因 |
| **Chrome 企业策略** | `managed`（用户不可改）与 `recommended`（管理员给默认值、用户可覆盖）两级，物理上分目录 | 语义分级。我们这次选 mandatory |
| LobeChat | `OPENAI_MODEL_LIST="-gpt-4,+my-model"` 用 `+/-/=` 表达对默认清单的增删改名 | 只作佐证：它是**部署方**改配置，不是运营对终端用户下发，形状不同 |

### 我们这边的三条约束，都是查出来的

1. **内核 settings 本来就分层**（schema 默认 → 注册方的组合 `base` → 用户文档，
   `dsh-settings/README.zh.md:5`），看着正是 Chrome 那套。**但 `mergeLayers` 对数组是整体替换**
   （"plain objects merge recursively, every other value (arrays included) replaces the lower layer
   wholesale"，`dsh-settings/lib/index.js:228-241`）。所以"base 放下发清单、user 放用户自选"在同一个
   `models[]` 上走不通——用户一加东西就把下发层整个遮住。`providers` 是普通对象、递归合并，双路由
   那条路存在，但会在下拉里多出一个分组标题，且要动 cordis 配置。
2. **schemastery 保留未声明的字段**，嵌在数组和 dict 里同样保留（真机验证：把带额外键的条目过一遍
   settings 文档用的同一套 object/array/dict 形状，键原样出来）。所以溯源标记直接写在条目上就行
   ——不需要外部快照、不需要碰 cordis 配置、不需要打上游补丁。这是本轮最省的一步，也是 Cherry
   Studio 那个 `presetModelId` 的同一个位置。
3. **服务端数据早就齐了，不用新增接口**：`/api/pricing_new` 每条带 `tags` / `model_ratio` /
   `sort_order` / `usage_count` / `enable_groups` / `icon` / `translations`（`model/pricing.go:30-60`），
   而客户端 `models/pool.ts` **本来就在调它**（为了"在售 + 这把 key 能调"的交集），连 `tags` 都已经
   带回来了。而 `tags` **已经在承载运营语义**——线上模型广场把 `new`/`新` 渲染成 NEW 角标、
   `hot`/`热门` 成 HOT（`web/src/components/table/model-pricing/view/card/PricingCardView.js:205-222`），
   所以借它做下发开关是走既有做法，不是发明。注意它是共享字段：`PricingTags.js` 会把所有 tag
   自动收进网页版筛选器。

### 方案

标记字段 **`openluxManaged: true`**，带产品前缀是为了永不与上游 `models[]` 字段撞名。

每次 `syncModels` 做四步，与首启无关、每次都跑：

1. 拉服务端下发清单 `desired`（从既有的 pool 里按约定 tag 筛）；
2. 读 **user 层**的 `models[]`（不是解析值——解析值含 base 层的出厂条目，会被误当成用户的），
   按标记分两堆：带标记的是我们上次下发的，不带的是**用户自己加的**；
3. `next` = `desired`（每条打上标记、字段全部重建）+ 用户那堆（原样，一个字段不动）；
4. 写回。

于是：服务端增一条，用户重启多一条；删一条，那条自动消失；用户自己加的完全不参与这套计算。
id 撞车时托管那条胜出——不是偏好，是因为适配器拒绝同一路由列出两次同一个 id
（`dsh-llm-pi-ai/lib/index.js:1113-1115`），而且它废掉整个 section 而不是那一行。

**数据源与回落。** 第一版从 `pricing_new` 按约定 tag（`桌面推荐`）筛，**一条都没筛到就回落到现有那 5 个**。
这条回落让改动可以先上线、后配置：线上还没打标签时行为与今天逐字一致，运营打上标签后自动接管。
它也与这个模块既有的谨慎一致（"一个 starter 都调不了就别动出厂列表"）。

**拿不到答案就什么都不改。** 控制台不可达意味着下发清单"未知"，不是"空"——按空处理会在网络第一次
抖动时删掉全部下发条目。所以只有真的拿到 pool 才走合并，否则只刷 catalog 字段。这与 `pool.ts`
既有的纪律同口径：没有快照就不对账。

**mandatory 要在界面上闭合，而且 `id` 必须一起锁。** 托管行整行只读（id / 名称 / 容量 / 删除）。
锁 `id` 不是顺手为之：留着它就等于留了一条绕过删除禁用的路——用户把 id 改一个字，那条不再匹配下发
清单，下次合并会把它当成"上次下发、这次不再下发"清掉，改 id 就是删除。

**配置文件手改这个洞不用堵。** `settings.yaml` 是用户可编辑的文本文件、设置页自带打开入口，界面拦不住；
但下次启动照下发清单重写就回来了，"改了也白改、重启复原"正是 mandatory 该有的行为，不用额外写代码。

**代价说清楚，这是取舍不是缺陷。** 下拉列表的长度从此完全由运营决定，用户没有清理视野的余地——
下发 8 条他就得看 8 条，哪怕只用其中 2 条。WorkBuddy 也是这样（完全服务端下发 + 底部"配置自定义模型"），
所以不算跑偏，但下发数量要当成产品决策来控制。真要给收纳自由，Cherry Studio 的 `isEnabled`
（条目仍归我们、删不掉，但用户能关掉不在下拉里显示）是条中间路，这一版不做。

### 这一版**不做**：倍率与「限时免费」的显示

它和上面那套机制是两件事，卡在一个具体的地方：下拉每行渲染的是 `name` + `description`
（`dsh-client-ui-model-selection/lib/client.js:566-572`），而 pi-ai 的 `modelFields` 不含 `description`
（`dsh-llm-pi-ai/lib/index.js:1349-1356`）、它的 `resolveModel` 也不产出（`:797-805`）——尽管
`dsh-llm` 这一层是支持透传的（`dsh-llm/lib/index.js:1165`、`:1195`）。所以**存得进去、显示不出来**，
中间那一段要给 pi-ai 打个小补丁（`modelFields` 加一个 `description`，`resolveModel` 的返回带上它）。

退一步把倍率拼进 `name` 是不行的：`name` 是用户可编辑字段（模型设置页就在改它），我们每次刷倍率会
覆盖用户改的名字，不刷就永远不更新。`description` 反过来——全 shell 没有任何编辑器能写它，处境与
`reasoningEfforts`、`compat` 完全一样，归我们所有、每次重写，不会和用户的编辑打架。

顺带记一个已经查清的事实，做「限时免费」时会用到：WorkBuddy 截图里 Hy3 那行是 `0.00x` 加「限时免费」，
两者是同一件事——**倍率设 0 就是免费**，管理端本来就能改倍率。所以"免费"这件事服务端零代码改动、
纯运营配置；真正缺的只有"限时"的自动到期（现在改倍率是手动的，没有起止时间）。

### 落地与真机验证

代码分两处：`models/delivery.ts` 是纯策略（标记名、标签、回落清单、`deliveredIds`、`merge`，零
import），`models/sync.ts` 是那一轮的执行（读 user 层、合并、填 catalog 字段、写回）。拆开不是
洁癖——测试要跨包 import 这些函数，而 `sync.ts` 会把 pi-ai 的类型图一起拉进来，桌面包的
`tsconfig.tests.json` 在 `NodeNext` 下当场报出 pi-ai 自己 `.d.ts` 里几十条 TS1543。**判据**：把测试
文件挪走再跑 `tsc -p tsconfig.tests.json` 是 exit 0，所以那些错误是这个 import 引进来的，不是既有的。
界面那半边在 `dsh-client-ui-settings-models` 的补丁里（`ModelListEditor` 逐行判 `openluxManaged`）。

**只读用 `readOnly` 而不是 `disabled`。** 上游 `.zGbnIq_input:disabled` 是 `opacity:.6`，整行压到
六成会让**最该用的**那几个模型看着像失效；`readOnly` 不发灰、还能选中复制模型 id，语义正好是
"这是定的，不是坏的"。删除按钮没法 readOnly，所以托管行**不渲染**它，那一格换成「官方」标签
（行是四列网格 `1.4fr / 1fr / auto / auto`，换掉不塌）。

**前置事实（只读探针 `.tmp-probe/delivery-preflight.mjs`）**：线上 409 条、其中 248 条是这把 key
可调的对话模型，**没有任何一条带 `桌面推荐`**——所以真机跑的就是回落路径；回落那 5 个在 pool 里全在。

| 验的事 | 结果 |
|---|---|
| 下发生效 | 隔离家启动一次，user 层 2 条（自定义名 `OpenLux V4-Pro`）→ **5 条全带 `openluxManaged: true`**，name/容量/思考声明由本地 catalog 填齐。那 2 条与下发撞 id，托管版本胜出（名字回到 `DeepSeek V4 Pro`）——**老用户改过的名字第一次同步时会被官方名覆盖**，这是 mandatory 的必然结果 |
| 托管行整行只读 | 5 行全部 `readOnly=true`（id、名称、展开后的两个容量字段），「官方」标签带说明 tooltip，**删除按钮不存在**。没只看类名：量了计算样式（灰底 `rgb(245,246,247)`，用户行是白底 `rgb(255,255,255)`），并确认 `[readonly]` 与 `managedTag` 两条规则在活着的样式表里 |
| 改不动是真的改不动 | 往第一行 id 里真打 `XXX`，值仍是 `deepseek-v4-flash` |
| 运营改清单 → 重启跟着变 | 把标签换成线上真实存在的 `联网`（只覆盖 6 个 gpt-search 模型）重启：托管条目变成那 6 条，原来 5 条**全部消失** |
| 用户自留不动 | 手工加一条不带标记的 `glm-5.3` /「我自己加的 GLM」，两次换标签重启后都在、名字一字未改；界面上它白底可编辑、有删除按钮、无「官方」标签 |
| 回落 | 标签改回 `桌面推荐`（线上无此标签）重启 → 回到 5 条，用户那条仍在 |
| 掉线不动成员 | 日常家那把 key 已 401，于是 `pool === undefined`、成员一条不动（只刷 catalog 字段）。这条不是构造出来的，是真机现状 |
| 静态检查 | 桌面包四份 tsconfig 的 `typecheck` + 新增 `tests/model-delivery.spec.ts` 11 例全过；account 包 build + typecheck 干净；补丁重生成后 `yarn install` 还原出的 `client.js` 与工作副本 **sha256 完全一致** |

**两件真机才看见的事，都会影响运营怎么用它**：

1. **下发一个本地 catalog 不认识的模型，条目就只有 id 和标记**——那 6 个 gpt-search 就是这样，
   下拉里显示的是模型 id、没有 name、也没有思考声明（`reasoningEfforts` 靠 catalog 填）。所以
   下发清单要优先选 catalog 认识的模型，否则用户看到的是裸 id。
2. 日常家 `~/.dsh` 的默认模型现在是 **`kling-effects`**（一个视频模型），models 列表里也躺着它
   ——是「获取模型弹窗默认全选」那个 bug 期间误加的。新逻辑不会替用户删（它不带标记，归用户），
   要手动清；`agent-default-model` 也得改回一个对话模型，否则默认模型发不出话。

**重新生成补丁的办法**（改完 `node_modules` 里的 `client.js` 之后）：`node .tmp-probe/regen-patch.mjs`。
它用 node 驱动 `yarn patch` / `patch-commit` 并自己写字节——现有补丁是**无 BOM 纯 LF**，而
PowerShell 5.1 的 `>` 重定向写的是 UTF-16，直接重定向会把补丁写坏。复验用 sha256：`yarn install`
之后工作副本应当逐字节不变。

> **这一节被并发编辑冲掉过一次**：写进去之后另一处按自己读到的快照整文件写回文档，这 100 多行
> 无声消失。判据是 `grep` 自己刚写的标题——**写完文档要回头搜一遍确认还在**，和 CSS 那次同一个坑。

## 视频接了第二、第三家：一家一个 provider，判据是活目录的端点类型（2026-08-21 真机四发出片）

**要复现的结果**：用户在对话里点名一个中转站真有的视频模型，就得用那个模型出片；
接不了的当场按名字拒绝并列出能用的，绝不静默换成默认值。

改之前这条链只认写死的三条 veo（`ROUTE_MODELS` 是个 enum），点名别家会被 schema 挡掉。
现在池子是 **3 → 10**（veo 3 + 豆包 seedance 5 + 海螺 2），真机拒绝那一发把这 10 条原样列了出来。

### 形状：`media/video/` 一家一个文件，与内核自带的五个视频扩展同形

`provider.ts` 定契约（`endpointTypes` / `fallbackModels` / `spec` / `submit` / `poll`），
`registry.ts` 从 `/v1/models` 现拉目录、按端点类型认领，`video.ts` 只剩「等、下片、判 MP4」。
加一家是一个文件加一行，骨架不动——内核 `openclaw/extensions/{runway,minimax,pixverse,fal,vydra}`
就是这么写的，不是我们发明的。

**没做成 Cordis Service**（`ctx.web` 那种接缝）：那套的价值是让**别的包**注册进来，而我们三家都在同一个包里，
换来的只是占掉一个全局服务名。契约形状照着接缝做，将来真要跨包再抬。

### 三个坑，全是真机当场撞出来的，读代码读不出来

| 坑 | 现象 | 判据 |
|---|---|---|
| 照抄老壳的端点类型清单 | 豆包被当成统一入口发到 `/v1/video/create`，回 **HTTP 429「未找到该模型的定价配置」**，日志里还被 i18n 改写成「请求过于频繁」 | 端点类型只能从库里 `models.endpoints` 现读：豆包声明的是 `/volc/v1/contents/generations/tasks` 与 `/api/v3/contents/generations/tasks`，**不是**统一入口。定价是按路由挂的，走错路在选渠道之前就被拒 |
| 轮询时重新推路径 | seedance 2.0 中转站侧早已 SUCCESS，客户端却一直「生成中」直到超时 | **错的挂载不回 404，回 HTTP 200 + 空壳 `{"id":"…"}`**。所以提交时走的哪条路必须带回给 poll（`VideoSubmitted.handle`），不能在 poll 里再猜一次 |
| 只按文档读 `error` 字段 | 任务失败，界面上却说「错误信息没有给出具体原因」 | 火山这条路上 `error` 是**字符串**不是对象：真机回执 `{"status":"failed","error":"[OutputAudioSensitiveDetected]…","output":{"message":"…"}}`。两种形态都要读 |

### 真机复验（2026-08-21，四发出片 + 一发拒绝）

| 发 | 走哪条 | 结果 |
|---|---|---|
| `doubao-seedance-1-0-pro-250528` | `/volc/v1/contents/generations/tasks` | 75s / 7.19MB，计费日志 720P（1248×704）/ 5s |
| `doubao-seedance-2-0-260128` | `/api/v3/contents/generations/tasks` | 225s / 2.18MB（同一模型第一发被上游音频审核拦了，`OutputAudioSensitiveDetected`，不是我们的代码）|
| `MiniMax-Hailuo-02` | `/minimax/v1/video_generation` | 95s / 1.31MB，计费日志 768P / 6s |
| `veo_3_1-fast`（回归）| `/v1/video/create` | 115s / 1.28MB / 1280×720 / 4s，计费日志 `veo_3_1-fast` 基础价 0.5760 |
| `kling-video`（没接的一家）| — | 当场拒绝，并列出这个账号能用的 10 条 |

veo 那一发是**必须真拍的**，不能算「代码没动所以回归」：统一入口的收发被搬进了
`video/unified.ts`，搬家本身就是改动。四条挂载点各有一行真机计费日志，缺哪条就等于那条没验。

顺带看到的一条好消息：被音频审核拦掉的那发 seedance 2.0，中转站自己冲了预扣
（`quota` 一正一负 347126），失败路径不需要我们这侧补退费。

驱动脚本 `scripts/probe-video-model.mjs`：CDP 打字发消息 + 盯 `~/.dsh/media/video` 出文件，
判据是**产物文件**不是回复文本——「模型名被悄悄丢掉、用默认模型出了一片」在屏幕上看着也像成功。

### 这一轮明确不接的

- **统一入口全族**（veo2/veo3/sora/grok-video）：这把密钥的 `/v1/models` 里**一条都没有**，
  `Unified video format` 这个类型已经从目录里消失、`OpenAI video format` 接了班。加类型名不会让任何模型进池，
  所以那条路这轮零收益，没做。
- 可灵 / PixVerse / Vidu / 百炼 happyhorse / 万相 / grok：目录里有、渠道也有，缺我们这侧适配器，
  下一轮按同一个形状一家一个文件加，老壳 `resources/yunwu-video-plugin/index.mjs` 里每一家的契约与坑都还在。

后台白名单（`admin-server` 的 `desktopSupportedVideoDefaults`）与管理端下拉同步成了这 10 条，
判据是**按挂载点验**：一条挂载点一发真机出片，同挂载点下的同族变体才跟着放行。

## 出图照同一个形状接了三家，另外撞出一条「画成了、钱花了、存不下」（2026-08-21 真机复验）

**要复现的结果**：与视频那节同一句话——点名一个中转站真有的出图模型就用那个模型画，
接不了的当场按名字拒绝并说清是哪一种接不了，绝不静默换成默认值。

改之前这条链只走 `/v1/images/generations` 一条路，池子 **23 → 31**：
多了 Gemini 6 条（走对话端点）、`mj_imagine`、`aigc-image-kling`。

### 形状与视频那侧逐条对应，因为它就是照着抄的

`media/image/provider.ts` 定契约，一家一个文件（`openai.ts` / `gemini.ts` / `mj.ts` / `vod.ts`），
`registry.ts` 现拉 `/v1/models` 按端点类型认领，`images.ts` 收成门面只管「下载、嗅类型、封顶、报账」。
两处与视频不同，都是被出图本身的形状逼的：

- **`ImageCarrier` 允许回 bytes 或 url**。视频永远是 url，出图不是：`b64_json`（seedream / gpt-image）
  与 `url`（qwen / z-image）同时存在，Gemini 更是把 data URI 写在**对话正文**里。门面收口之后，
  四家都不必各自写一遍下载与体积判断。
- **`variesCount` / `variesSize` 要声明，丢掉的参数事后回报**。MJ 没有尺寸字段（比例只能写进提示词的
  `--ar`），腾讯云一次只出一张。真机上模型把这两条如实转述给了用户——
  「MJ 这条接口不支持单独的尺寸字段，所以这次是方图（2048×2048），我传的横版比例没有生效」。
  这是设计要的结果：**参数被无声吞掉**和**模型被无声换掉**是同一类事故。

### 这一轮撞出来的三条

| 坑 | 现象 | 判据 |
|---|---|---|
| 附件库 5MB 上限 | MJ 每一发都是**画成了、计费了、存不下**：界面只说「出图失败」，用户看不到那张已经付过钱的图 | MJ `imagine` 回的是一张 2×2 四格图，实测 7.3～8.5MB，而 `attachment-local` 的 `maxImageBytes` 默认 5MB。这不是我们选的数，是从上游继承来的通用默认 |
| 模型名按「长相」被归类成工具名 | 「用 mj_imagine 画…」被答成「工具 mj_imagine 在本机并不存在」，然后用默认模型画了 | 提示词里早写了「这一条只管工具名，不管模型名」，没用——`mj_imagine` 是 snake_case，模型按**拼写**分类。规则必须给一条不依赖长相的判据 |
| 拒绝话术把两种「接不了」说成一种 | `kling-image` 明明在这个账号的目录里，拒绝时第一句却说「这个账号的出图接口上没有」 | 目录读取原本把没人认领的行直接丢掉，于是分不清「路由下架了」和「我们没适配器」。这两件事对用户是不同的结论：前者他得换模型，后者是我们欠的 |

第一条的改法值得单说，因为它是**内核自己的旋钮**、不是我们发明的机制：
`dsh-plugin-desktop/cordis.patch.yml` 给 `attachment-local` 配 `maxImageBytes: 33554432`。
32MB 这个数也不是为凑过 MJ 挑的——**老壳就是 32MB**
（`resources/yunwu-video-plugin/index.mjs` 的 `DEFAULT_MAX_BYTES`，挂在内核 `agents.defaults.mediaMaxMb` 上），
所以四格图在上一代产品里本来就过得去。代价要说清楚：这个上限同时管 `read_image` 与用户粘贴的图，
那些**会真的进模型请求、并且在压缩之前每一轮都计费**，所以放开的是成本不是安全边界；
`maxImagePixels`（40MP）保持默认，解码那道闸没动。

第三条现在按 `catalog.present`（目录里所有 id，不只被认领的）分两句话说，两条分支都真机验过。

### 真机复验（2026-08-21，三发新路 + 一发老路回归 + 两发拒绝）

| 发 | 走哪条 | 结果 |
|---|---|---|
| `gemini-3-pro-image` | `/v1/chat/completions`，图在正文的 data URI 里 | 19s / 1.04MB / **768×1376 竖**（`image_config.aspectRatio` 生效）；计费日志 模型价格 0.33 × 分组倍率 0.18 |
| `mj_imagine` | `/mj/submit/imagine` → `/mj/task/{id}/fetch` | 84s / **7.3MB PNG** / 2048×2048 四格；计费日志 固定价格 0.30，操作 IMAGINE。**这一发在抬闸之前存不下** |
| `aigc-image-kling` | 腾讯云点播 aigc 提交 + 轮询 | 64s / 1.25MB / 768×1360 竖；计费日志 `aigc-image-kling-3.0 (API: Kling 3.0)`，说明名字/版本拆分与中转站内部计费名一致 |
| `doubao-seedream-4-0-250828`（回归）| `/v1/images/generations` | 12s / 1.39MB；计费日志 大小 1536x1024。老那条路整体搬进了 `image/openai.ts`，搬家本身就是改动，必须真画一发 |
| `kling-image`（目录里有、没适配器）| — | 拒绝：「这个账号有，但本工具还没接它走的那条厂商专属接口」 |
| `dall-e-9`（目录里没有）| — | 拒绝：「这个账号的出图接口上没有」 |

计费日志查的是 **`openlux_log`**，不是 `logs`——客户端连的是 `api.openlux.ai`，
按用户名去云雾那张表里查会一行都查不到，早先在这上面白绕了一圈。

提示词那条改动单独验了一次，用的是同样 snake_case、同样在目录里但没接的 `mj_blend`：
模型答「用户点名了模型 mj_blend，我按照人设规则直接把它填进 model 参数」，被按名字拒绝，
**先告诉用户再**改用 `mj_imagine`。改动前后同一形状的名字，一个被当工具驳回、一个被当模型传出去。

### 这一轮明确不接的

按活目录点名，文生图里没接的就三条，判据是端点类型没人认领：

- `kling-image`（`Kling image generation` / `Kling image expand` / `Kling multi-image to image`）
- `kling-omni-image`（`omni-image`）
- `viduq2`（`Vidu image generation`）

可灵那两条**不是「没来得及写」，是写了也验不了**：2026-08-20 直连探过一次，路由本身是通的，
上游当场回 `{"code":400,"message":"Account balance not enough"}`——

```
POST /kling/v1/images/generations  (kling-v3)      -> 429，Account balance not enough
POST /kling/v1/images/omni-image   (kling-image-o1) -> 429，Account balance not enough
```

卡的是那个渠道的余额，不是我们这侧的形状。按本项目「做完要真机验证」的规矩，
今天写下去也拿不到一发出图的证据，所以留到渠道有余额再接。
契约不用重查：老壳 `resources/yunwu-video-plugin/index.mjs` 里这两条都在（`n` 上限 9、三档
`aspect_ratio`、上游模型名 `kling-v3` / `kling-image-o1`），补上适配器加真机一发即可。
`viduq2` 没探过，不知道是同样的余额问题还是别的，接之前先探一次。

> **2026-08-21 改判，三条全接了。** 可灵那两条见文末「可灵两条接进新插件」：改判的理由不是
> 余额通了（还是没通），而是判据换了——能验到的最远处是**路由与上游模型名被接受**，
> 这一层用一发对照组证死了，剩下的成功路径写进文档标成未验。
> 一直不接的代价是另一头：交付页照样把它们列成可选出图模型，运维选中就整条出图挂掉。
>
> `viduq2` 探完是另一回事：**上面这行「没接」的判据本身就是错的**，见文末
> 「viduq2 当年不该被排除」。它两半都当场验通了，是这一批里唯一成功路径可验的一条。

**MJ 的 action / blend / describe / upload / modal 与 `OpenAI image edit` 那几类不算漏接**：
它们是**改图**不是文生图，要先有「把输入图交给工具」这个能力，是另一件事。

后台这侧不用同步：图片默认模型在 `admin-server` 没有白名单（`desktopSupportedVideoDefaults` 只管视频），
管理端图片 tab 用的是 `ModelNameSelect` 自由选，本来就不写死清单。

驱动脚本 `scripts/probe-image-model.mjs` 与视频那份同形，判据同样是**产物文件**。
它有一个已知的钝处：拒绝检测匹配的是整页文本，会命中还留在屏幕上的历史消息——
这次就误报过一次，得回头读一遍当轮的界面才认。

## 改图接上了：「生图 → 再叫改图」以前是**默默重画一张**（2026-08-21 真机复验）

**要复现的结果**：用户说「把这张图里的猫改成黑色」，改的就得是那张图；
改不了的当场说改不了，绝不退回去照提示词重画一张交差。

### 上一轮把这件事划到范围外，理由是错的

上一节写着「MJ 动作族与 `OpenAI image edit` 那几类是**改图**不是文生图，是另一件事」。
边界划错了地方。真机一验：先画一只白猫，再说「把猫改成黑色，桌子和背景别动」，
模型**没有拒绝**，它去调 `image_generate` 重画——甚至挑了个名字里带 edit 的模型
（`qwen-image-edit-2509`）想照办。但那时工具的入参只有 `model / prompt / count / size`，
**根本没有装图片的槽**，白猫从来没被发出去过。用户会拿到一只长得不一样的黑猫，
并被告知「改好了」。这与静默换模型是同一类事故：看着成了，要的事没发生。

### 三处证据说明它接得了，而且不用发明机制

- **老壳接过并验通**：`references/media-video.md` 记着 2026-08-17 的结案读数
  「池子 33 条、**可改图 17 条**」，还留了两条关键结论——云雾的 `/v1/images/edits`
  要 **multipart**（内核 litellm 那条发的是 JSON + data URL，一直是坏的，只是没人试过），
  以及 Gemini 那族**出图与改图是同一个请求**，只多一个 `image_url`。
- **「哪张图」我们自己已经解决了**：`media/session-images.ts` 的 `findLatestImage(session)`
  走会话日志找最近一张图（用户贴的或刚生成的）。生成的图刻意不进模型可见内容，
  所以模型手上没有附件 id 可以引用，只能由工具自己找。视频那侧的 `animate_last_image`
  就是靠它做的图生视频——改图缺的只是**同一个开关装到 `image_generate` 上**。
- **动手前先验，没有直接照搬册子**：册子那两条是 08-17 的读数，不能当今天的证据。
  2026-08-21 直连各打一发：`gpt-image-1` multipart **200 / 53.8 秒**，
  `gemini-2.5-flash-image` 对话端点 **200 / 27.5 秒**且 `prompt_tokens` 277
  （同路径纯文字提问不到 40，说明图真被读进去了）。两条都成立才开始写。

### 「能不能改图」按端点类型认领，名字不算数

判据与选模型同源：`OpenAI image edit` / `images-edits` / `openai-编辑` / `image-edit`
四个名字是同一条 `/v1/images/edits`，加上 Gemini 全族（这条路上编辑不是第二条路由）。
**`qwen-image-edit-2509` 是反例**：名字里就写着 edit，但它的行一个编辑端点都没声明，
所以不认领它。真机拒绝那一发列出的可改图正好 **13 条**（6 Gemini + 5 gpt-image + 2 grok），
与册子 08-17 记的「7 直连 + 6 对话端点」逐条对上。

### 一个必须想清楚的决定：用户没点名模型时怎么办

配置下发的默认模型是 seedream，它**不会改图**。两种情况分开处理，判据是「用户有没有表达过意见」：

- **点名了一个不会改图的模型** → 按名拒绝并列出能改的，不替换。用户的选择不是我们能改的。
- **谁都没点名** → 自动换一个能改图的（`EDIT_DEFAULTS`，只放真编辑成功过的两条，
  两种传输各占一条、便宜的在前），结果里如实报出用的是谁。没点名时本来就是工具在挑，
  为改图挑一个能改图的属于同一类决定，不是替换。
- **目录读不出来** → 保持原样并报「查不到，所以不能确定它改不改得了」，**不在看不见的时候换**。

### 真机复验（2026-08-21，两条传输 + 两条拒绝 + 老路回归）

| 发 | 结果 |
|---|---|
| 白猫基线（没点名）| `doubao-seedream-4-0-250828`，19.5 秒——**老那条出图路的回归** |
| 「把猫改成黑色，桌子背景别动」（没点名）| 模型自己判定要用 `edit_last_image`；自动换到 `gemini-2.5-flash-image`，9 秒，计费 0.15 × 0.18。**猫的姿势、桌角桌腿、墙上两道斜光、左下角阴影全部留住，只有毛色变了** |
| 「用 gpt-image-1 改成橘色虎斑」| multipart 那条经我们代码跑通，68 秒 / 1.73MB PNG，场景同样逐项保住 |
| 「用 doubao-seedream-4-0-250828 改成灰色」| 当场拒绝并列出 13 条可改图的；模型是**被拒之后才明说**换用 gpt-image-1 的 |
| 新会话里「把刚才那张图改成黑白的」| 拒绝：「这个对话里还没有图片」 |

最后那发还带出一条要补的话：模型被拒之后跑去 glob 磁盘、翻出桌面上一张无关 PNG，
再拿 `read_image` 撞了一次「文本模型不能读图」，白费四步。所以那句拒绝后面补了
「改图只认这段对话里的图，磁盘上的文件找出来也用不上」——把门关死比让它去猜便宜。

### 仍然不接的，和上一轮同一个判据

- **MJ 动作族**（`MJ action` 9 条 + `mj_modal`）：要上一个任务的 `taskId` + 图序号，
  是 MJ 自己定义的 Secondary Editing，我们这侧没有「记住上一个 MJ 任务」这件事。
- **`mj_blend`**：它确实是改图，但**不收 prompt**——把 2~9 张图混合，
  对「把猫改成黑色」这种诉求帮不上忙，不属于这一轮要复现的结果。
- 腾讯云点播那条没探过有没有改图路径，没验就不声明。

### 卡片文案有两份，只改宿主那份等于没改（2026-08-21 补）

改图接通那天真机上卡片仍写着「已生成 1 张图片」。不是逻辑没生效——同一轮里拒绝话术、
`edit_last_image` 开关都对了——而是**标题根本不走 `presentResult`**：桌面端给
`image_generate` 注册了自己的卡片（`client/ImageToolCard.tsx`），文案取自
`client/media-locales.ts`，宿主那份 `presentCall` / `presentResult` 只服务没有卡片的界面。

补法是给浏览器侧字典加一档 `edit.*`（修改图片 / 修改中… / 已改出 {count} 张图片 / 改图失败），
卡片从它已经在解析的 `argsRaw` 里读 `edit_last_image` 决定说哪一档。顺手把三层嵌套三元换成
一张 `COPY` 表——同一处要在「展示 / 文生 / 改图」三套词汇 × 四个状态里选，写成内联三元
读起来是道谜题。

**复验没花钱**：卡片是从日志回放重画的，所以重启后打开昨天那段对话就能看结果——
`已生成 1 张图片`（老路没连累）、`已改出 1 张图片` ×3、`改图失败`（被拒那发）、
`已展示 1 张图片`（`image_show` 没受影响）。以后凡是动卡片文案，先问一句「桌面端这行字
是从哪个字典来的」。

### 还没收口的：交付页认得比插件多（选得到、跑不动）

判据脚本 `scripts/verify-image-endpoints.mjs:128` 自己写着这条不变量：
*「界面凭端点类型认，插件凭适配器跑。多认出一条就是『选得到、跑不动』。」*
但它锁的是**老插件**那份名单（`:27` 的 `mj_imagine` / `mj_blend` / `kling-image` /
`kling-omni-image` 四条），新插件这侧没人锁。

今天两边对不上：

| | 谁认 |
|---|---|
| 端点类型那份清单（`src/shared/media-endpoints.ts`）| `IMAGE_ASYNC_ENDPOINT_TYPES` 整档六个类型全部当出图模型，且消费它的 `model-catalog.ts:489-499` **一律 `canEdit: true`** |
| 新插件（`media/image/registry.ts:54-59`）| 异步只有 `mjImagine` 一个适配器；另有一个 `vod`，而它**不在**上面那份类型清单里 |

> **2026-08-21 更正：上面那张表说的不是新客户端的交付链路。**
> `src/main/model-catalog.ts` 只被 `yunwu-desktop/src/**` 消费（老 Electron 壳的
> `Activate.tsx` / `settings/Models.tsx` / `main/ipc.ts` / `config-writer.ts`），
> **不喂 DSH 客户端**。新客户端的默认出图模型走的是另一条：
> **admin-cloud 交付页 → 中转站 → 插件 `models/delivered.ts:69`
> （`GET /api/desktop-config/model-delivery`）→ `index.ts:594-596`**。
>
> 沿着这条真链路重查，「选得到、跑不动」不但还在，而且口子比原文写的更大：
> - 页面那侧（`admin-cloud/src/components/form/ModelNameSelect.tsx`）是**全模型库的自由补全**，
>   `filterOption={false}`，按能力一个都不筛。出图 tab 的 placeholder 写着「从图像模型中选择」，
>   但没有任何东西拦着填一个对话模型或视频模型。
> - 中转站那侧（`controller/desktop_delivered_model_client.go:143`）唯一的把关是
>   `deliveredModelAllowed` = **可调用 ∧ 在模型广场里**，不问桌面端有没有适配器。
>
> 所以真正的兜底只有插件那句拒绝，它会在每一次出图上出现，直到有人回后台改掉。
> 这条口子今天没堵，先记在这里；堵它要么让交付页按能力筛，要么把适配器名单发布出去给页面用，
> 都跨仓，值得单独一轮。

**2026-08-21 已接掉可灵两条（见下一节）与 `viduq2`（见文末）**，
`mj_blend` 是刻意不接（不收 prompt），不是漏接。

### 可灵两条接进新插件（2026-08-21，成功路径仍未验）

目录今天 474 行，异步出图正好 4 行，与老插件那份适配器名单一一对应：
`kling-image`（一行挂着 generations / 多图生图 / 扩图三个类型）、`kling-omni-image`
（只有 `omni-image`）、`mj_imagine`、`mj_blend`。

**动手前先打了三发直连**，因为册子里那两条是 08-17 的读数，不能当今天的证据：

| 发 | 结果 |
|---|---|
| `/kling/v1/images/generations`，`model_name: kling-v3` | HTTP **429**，体 `{"code":400,"message":"Account balance not enough"}` |
| `/kling/v1/images/omni-image`，`model_name: kling-image-o1` | 同上 |
| 对照组：`model_name` 填目录 id `kling-image` | HTTP 429，`model_name value 'kling-image' is invalid` |

**对照组那发是关键**：没有它，前两发只能证明「被拒了」；有了它才能说前两发不是笼统拒绝——
两个上游模型名今天都过了名字校验，只在渠道余额那步被挡。顺带今天复验了两条老结论仍成立：
业务错误包在 HTTP 429 里（判据只能看体里的 `code`）、目录 id 不能当 `model_name`。

落地成 `media/image/kling.ts`，两个 provider 共用提交 / 轮询。与老插件的三处刻意不同：

- **`endpointTypes` 只认 `Kling image generation` 一个**，不认多图生图与扩图。今天它们与
  generations 同在一行，所以照样认得出 `kling-image`；但哪天平台把它们拆成独立的行，
  只认一个会让那行落到「没接这条」的准确拒绝上，认三个则会拿 generations 的请求体去撞。
- **`fallbackModels` 留空**。这份名单只在目录读不出来时用，契约是「真出过图的名字」——
  可灵在这台机器上一张都没出过，这时候猜它等于在什么都验不了的时刻把付费请求送上没验过的路。
- **轮询上限 200 秒**（老插件 300）：工具自己的预算是 `TOOL_TIMEOUT_MS = 250_000`，
  轮询超过它只会被换成一句没有信息量的通用超时。

**没验到的是成功路径**：任务建起来之后的轮询、状态词汇、`task_result` 形状，
在这把密钥上一次都没跑到过，是照着老插件原样搬的。第一次真跑通时要盯着看，别当已验。

真机复验（同一台客户端，两发）：

| 发 | 结果 |
|---|---|
| 「用 kling-image 画一只橘猫坐在窗台上」| **出图失败：可灵拒绝了这次提交：Account balance not enough** —— 从「本工具还没接它走的那条厂商专属接口」变成厂商自己的话，就是路由到位的证据 |
| 「用 kling-omni-image 把刚才那张橘猫图改成黑白的」| **改图失败**（标题不是「出图失败」）：说明 omni 被认成可改图，请求带着 `image_list` 真发了出去，才被余额挡回 |
| 两发之后的兜底 | 模型都如实说明了「你点名的是 X、被拒原因是 Y、我改用了 Z」，没有静默替换；默认模型出图 / 改图各成功一次，**老路无回归** |

第二发还顺手把卡片文案那条补验了：`已改出 1 张图片` 这次是在**实时路径**上出现的，
之前只在回放上看过。

### viduq2 当年不该被排除（2026-08-21，两半都验通）

老插件把它列进「明确不接」，理由是 `/ent/v2/reference2image` 不是「按一句话出图」。
这个理由是**读名字读出来的**，而网关自己的请求类型写得很清楚
（`new-yunwu-api/dto/vidu.go:118-123`）：

```go
Images []string // 图像参考，可选，viduq2支持输入 0～7 张图片
Prompt string  // 注1：使用 Viduq2 且没有上传任何 images 时，模型会用该参数的文本内容生成图片
```

**0 张就是文生图，1 张就是改图，同一条路。** 一条路同时对上我们两套词汇，
反而比别的家更省事。教训与本文档里其他几条同源：路径名不是契约，请求类型才是。

真机三发，成功路径**全程看到底**（这是这一批里唯一做到的一条）：

| 发 | 结果 |
|---|---|
| 文生（不带 `images`）| HTTP 200 `state: created` → 38 秒 `success`，6 credits |
| 改图（带 1 张 404 KB 参考图）| 53 秒 `success`，8 credits，下载 1984.5 KB，magic `89504e47`（真 PNG，不是错误页） |
| 客户端点名 `viduq2` 出图 + 改图 | 「已生成 1 张图片」/「已改出 1 张图片」，构图、木屋位置、窗光都留住了，只有季节变了——是真改不是重画 |

契约上与别家不一样的三处，都是量出来的：

- **参考图要带 `data:` 前缀**（与 MJ 同侧、与可灵的裸 base64 相反）。中转站对 `images`
  不做任何转换（`relay/channel/task/vidu/` 里没有一处碰 base64），所以格式是上游的规矩，
  只能实测。提交回执里它被改写成了 `ssupload:?id=…`，是平台替我们上传了。
- **提交本身很慢，而且随参考图大小涨**：裸提示词 2 秒，404 KB 参考图 12 秒，2.5 MB 参考图 **68 秒**。
  所以预算按**整段**算（`TOTAL_BUDGET_MS = 240_000`）而不是提交、轮询各一份——各一份加起来
  会越过工具自己的 250 秒上限，届时用户看到的是通用超时，我们这句「任务还在上游跑」就没了。
- **`aspect_ratio: auto` = 与输入图同比例**，改图默认走它。

最后这条是**写完之后看图才发现的缺陷**，值得单独记：第一版照着可灵的写法写成
`aspectOf(request.size) ?? '1:1'`。改图时模型不会传 `size`，于是 1:1 被我们主动加了上去，
一张 1080×1920 的竖版灯塔**改完变成了方图**——而改图这件事的全部意义就是「除了点名要改的，
别的都别动」。改成「没人要求就不塞」之后复验：参考图 1080×1920，出来 1080×1920。
`kling.ts` 里同样的 `?? '1:1'` 一并去掉了（可灵的合法值只有三档、没有 `auto`，
保不住原比例，但至少不该由我们主动强加一个）。

**接口返回的图不小**：两次都是 2~3 MB PNG，靠的是 `maxImageBytes` 早先抬到 32 MB。
默认 5 MB 也够，但离得不远。

### Vidu 视频：四条路接了两条（2026-08-21，两条都真机出片）

出图收口之后按同样的办法对视频点了一次名。活目录 84 行音视频里，已认领的只有三家
（unified 的 veo、doubao、minimax 的海螺），**未认领的最大一块就是 Vidu 的四条视频路由**，
覆盖 viduq1 / q1-classic / q2 / q2-turbo / q3-pro / q3-turbo / vidu2.0 等 10 个模型。

**只接了两条，另两条是刻意不接**：Vidu 按「你给它什么」分路——纯文字、一张首帧、两张首尾帧、
最多七张主体参考。而本工具一次只递一张图（`video-tool.ts:350`），所以首尾帧缺第二张、
参考生视频缺主体词汇。把一张图塞给要两张的路是 400，塞给「主体参考」则拍出来的是另一件事，
不如让只有 `Vidu reference to video` 的那几个（`viduq3` / `viduq3-mix` / `viduq2-pro`）
落到注册表那句准确的「没接这条」上。

真机 `viduq3-turbo` 540p/4s，两条路各一发：

| | 提交 | 出片 | 产物 |
|---|---|---|---|
| 文生视频 | HTTP 200 / 1 秒 | 36 秒 | mp4；客户端整条走完 86 秒，**720×1280**，请求的 9:16 生效 |
| 图生视频 | HTTP 200 / 12 秒（它要上传参考图）| 46 秒，28 credits | mp4；客户端整条 90~105 秒 |

顺手量出来的两件事，猜都会猜错：

- **同一个模型，两条路被中转站分到了不同上游**：文生那发的产物在腾讯云 VCLM 的桶里，
  图生那发在 Vidu 自己的 S3。回执形状也随之不同——文生只回三个字段、没有 `credits`、
  不回显参数，图生把整个请求回显一遍。所以解析不能依赖那份厚的。按
  `platform-data.md` 的分工，谁承载是中转站的事，我们两边都得能读。
- **路径是 `/ent/v2/img2video`**。请求类型自己的注释写的是 `image2video`
  （`dto/vidu.go:70`），但路由注册和 adaptor 匹配的都是短的那个，照注释写就是 404。

**没有声明时长白名单**，这是按 `video/provider.ts` 自己的规矩来的：中转站对时长/分辨率/比例
不是拒绝而是**逐模型纠正**（`relay/channel/task/vidu/models.go:481` 的 `CorrectDuration`，
以及 `CorrectResolution` / `CorrectAspectRatio`），本地再声明一份猜来的集合，只会把路由其实
收的值拦掉。比例是例外，它值得带：不支持的比例不会向请求靠拢，而是被换成模型默认值，
不声明就会出现「要竖版、拿到横版、没有人说一声」。

#### 为此动了两处公共契约，都是被真机逼出来的

**其一，`spec()` 现在收第二个参数 `types`。** Vidu 把**模式编码在端点类型里而不是模型名里**：
`viduq2` 能文生不能图生、`viduq3-turbo` 两样都行、`viduq3` 两样都不行，名字上一点看不出来。
而 `spec()` 原来只拿得到模型名，于是「viduq2 不能用图片当首帧」这句话只能等后台作业跑起来
才报——那已经是它该出现的那一轮之后了。真机复验这条：

```
用 viduq2 把刚才那张白猫图动起来
→ 当轮 Error: viduq2 不支持用图片当首帧；要图生视频请不要指定这个模型，或改用 veo_3_1-fast。
```

模型收到之后没有静默换模型，而是把选择抛回给了用户。另外三家 provider 不用改（TS 允许实现
少收参数），`video-tool.ts` 两个调用点各加一个实参。

**其二，`VideoModelSpec` 多了 `referenceDecidesShape`。** 这条是**写完之后量文件才发现的假话**，
形状与出图那边的 `?? '1:1'` 完全一样，值得并排记：

```
源图 2048×2048（方）→ 出片 960×960（方，跟着首帧走，没有黑边）
而模型当时对用户说的是：「出片 16:9 横版（源图正方形，出片会留黑边）」
```

假话不是模型编的，是工具喂的：`video-tool.ts` 会从参考图推一个比例再讲给模型听，
那套说辞是照 veo 那条路写的（veo 确实要选一个比例并给方图加黑边），而 **Vidu 的 `img2video`
根本没有 `aspect_ratio` 字段**，画面就是首帧本身。改法是让 provider 自己声明这件事：
声明了的，工具不再推比例、改说「出片就按这张图的比例，不会留黑边」，用户如果显式点名了比例
则当轮拒绝并说明去哪儿要（纯文字出片可以指定，或先把图改成那个比例）。

复验两条都做了：Vidu 图生（源图 2048×2048 → 出片 960×960，措辞里不再有比例和黑边）；
**老路不回归**——默认 veo 走同一张方图，照旧说「16:9 横屏……两侧可能会有一点黑边」，
作业状态 `1280x720`，与改动前一致。

#### 顺带查出一条静默失效：grok 视频今天没人认

`unified.ts:122-126` 的 `endpointTypes` 里写着 `Grok video`，而活目录里 grok 那两行
（`grok-imagine-video`、`grok-imagine-video-1.5-preview`）挂的类型是 **`官方格式`** 和 `edit`。
名字对不上，所以今天没有任何 provider 认得到它们，点名就落到「这个账号的出片接口上没有」。

这条**没有就地改掉**，因为 `官方格式` 是个非常泛的中文名，今天只有 grok 两行挂着它，
明天完全可能挂上别家；照 `endpointTypes` 直接认领等于赌它永远专属，而 `claims(id)` 收窄成
`/^grok-/` 又是在没验过 grok 这条路到底吃不吃统一格式请求体的情况下先写代码。
按本文档一贯的顺序，这条要先探一发再动手，记在这里免得下次又当新发现。

> **2026-08-21 探完了，而且推翻了「加个字符串就行」的猜想。** 打 `/v1/video/create` 发
> `{"model":"grok-imagine-video"}`，回的是统一入口自己的形状（`{"id":"","status":"error",
> "error":"prompt is required"}`）——看着像是它就属于这条路。但库里 `models.endpoints` 写的是
> **`官方格式` → `POST /v1/videos/generations`**，即 xAI 原生那条（老插件第七家适配器打的就是
> 它）。统一入口只是宽容，**判据归 `endpoints`，不归一次探针的宽容度**。所以 grok 是一个独立
> 适配器，不是一行字符串；仍未接。

### 百炼接进新插件：happyhorse + 万相，6 个模型（2026-08-21，端到端出片）

Vidu 那轮把视频这侧的差集看清了：**老插件有七家适配器（`media-video.md:804-813`，全部端到端
验过），新 DSH 插件只有四家**（unified / doubao / minimax / vidu）。缺的是可灵 v1、可灵 3.0
turbo、PixVerse、百炼 happyhorse。先花一发确认这四家今天还活不活——发缺字段的请求，只看路由
与渠道，不产生计费任务——**六条全部回了「缺哪个字段」的校验投诉，没有一条是无可用渠道**。

先接百炼，因为它一个适配器带两家：`Happyhorse video`（1.0 四条）、`happyhorse视频`（1.1 三条）、
`Wan video generation`（万相两条）在平台侧是同一个 channel、同一条路径、同一套状态字面量
（`relay/channel/task/ali/bailain/models.go` 的 ModelList 里 wan2.x 与 happyhorse 并列）。
落进本工具词汇的是 **6 个**：happyhorse 1.0/1.1 的 t2v + i2v，加 `wan2.5-i2v-preview`、
`wan2.6-i2v`。`-r2v`（要 reference_image）与 `-video-edit`（要一个公网视频 URL）是另一档能力，
按 `media-video.md:844-846` 的规矩不塞进出片档。

**认领按精确名而不是后缀**，这一条跟别家不同：平台的 `GetModelAction`（`models.go:21-32`）是个
精确 switch，`-t2v` / `-r2v` / `-video-edit` 各自对应一种动作，**其余一律 image_to_video**——
万相那两条正是落在这条 default 上。所以将来某个 `happyhorse-1.2-t2v` 在平台眼里是图生，
照后缀猜就会替用户发一个必然缺图的请求。

#### 真机（720P / 3 秒）

| 用例 | 提交 | 出片 | 产物 |
|---|---|---|---|
| `happyhorse-1.0-t2v`，`ratio:16:9` | HTTP 200 / 1 秒 | 96 秒 | 1280×720，1.19 MB |
| `happyhorse-1.0-i2v`，方图首帧 | HTTP 200 / 12 秒 | 87 秒 | **960×960**，1.41 MB |
| `happyhorse-1.0-i2v`，不给图 | HTTP 500 / 1 秒 | — | `必须提供 first_frame 媒体` |
| `happyhorse-1.0-t2v`，`ratio:1:1` | HTTP 200 | 109 秒 | 960×960，1.88 MB |
| 客户端整条：点名 `happyhorse-1.0-t2v` 拍 3 秒 | — | 80 秒 | 1280×720，1.90 MB，**无水印** |
| 客户端整条：点名 `wan2.6-i2v` 动画一张方图 | — | 165 秒 | 960×960，2.63 MB |

第二行就是**写代码之前**量出来的那条：请求的是 `16:9`，回来的是源图的方形——`img_url` 这条路
的 `parameters` 里根本没有 `ratio` 字段（文档站的字段面里也没有，而且分辨率那条的说明原话是
「输出的视频宽高比与输入首帧近似一致」）。所以百炼图生也声明 `referenceDecidesShape`，
与 Vidu 同一条。这次没等模型对用户说出假话。

#### 文档站挖出一个没人知道的旋钮：happyhorse 默认烧水印

`ratio` 在中转站侧**不校验**（dto 里只有 `Ratio string`，校验的是时长与分辨率），所以合法集
只能问上游，而按 `platform-data.md:83` 那条路子——文档站前端包里内联着整份 Apifox 导出——
一次就取到了：`16:9`(默认) / `9:16` / `1:1` / `4:3` / `3:4`，其中三个已真机量过。

同一份导出里还带出一条谁也没提过的：**`watermark` 默认 `true`，会在右下角烧上 "Happy Horse"**。
产物文件名一律是 `…_refiner_watermark.mp4`，所以光看回执永远发现不了。按册子的规矩验了一发
（同一 prompt 拍两条、各抠一帧对比）：默认那条角上确有字样，`watermark:false` 那条干净。
现在固定发 `false`；万相那边本来就默认 false，发了也不亏。

#### 两处公共契约又动了，仍然是被真机逼的

- **`durationRange`**：百炼校验的是**区间**不是集合（happyhorse 3~15、万相 2~15，
  `relay_tasks/ali/bailian/duration/task.go:119-125`，越界回 400）。原来只有 `durations`
  离散白名单，把十三个整数列出来会读成「量过的白名单」，其实不是。
- **`requiresFirstFrame`**：这一家 6 条里有 4 条只能图生。原来只有反方向的 `firstFrame`
  （拿图给不吃图的模型），正方向「只吃图的模型却只给了文字」没有当轮判据，只能等后台作业
  里报。海螺的 `MiniMax-Hailuo-2.3-Fast` 同一形状，一并声明，submit 里那道保留作兜底。

复验这条拒绝时，**模型的反应比拒绝本身更值得记**：

```
用 wan2.6-i2v 拍一段视频：一只柴犬在雪地里奔跑
→ 当轮 Error: wan2.6-i2v 只做图生视频，得先有一张图当首帧。纯文字出片请换一个模型
  （比如 veo_3_1-fast），或者先生成一张图再让它动起来。
→ 模型照着后半句做了：先出一张柴犬图，再用它当首帧调 wan2.6-i2v。
```

拒绝文案里那句「或者先生成一张图再让它动起来」不是客套，它是模型下一步的依据。

#### 一个真实故障：7 MB 首帧把提交拖过了我们自己的闸

上面那次自救**当场失败了两次**，报的是「账号服务超时（120 秒未响应）」。量了一发才知道不是
上游抽风，是**体积**：同一张 2048×2048 的 PNG（7.03 MB，base64 之后 9.37 MB）——

| 首帧 | happyhorse 提交 | wan 提交 |
|---|---|---|
| 9.37 MB data URI | 51 秒 | **173 秒** |
| 缩到 0.16 MB | 4 秒 | 3 秒 |

两发都是 HTTP 200，路是通的，只是上传腿随体积涨，而 wan 那条超过了 provider 里写死的 120 秒。
所以带参考图的提交给到 300 秒（Vidu 同一暴露面，一并调整），复验那条失败两次的用例
165 秒出片、960×960。

**但这只是把伤止住了，正确的修法是根本别发 7 MB。** 这几家都只出 720p/1080p，四百万像素的首帧
一点用没有，缩到 1536 边长再发能把上传腿从三分钟压到几秒。卡在编码器上：`sharp` 确实在应用的
依赖树里（`dsh-attachment-local` 自己在用），但插件是 junction 链进 `dsh-plugin-desktop/node_modules`
的，**node 按 realpath 解析，从插件真实路径 `require.resolve('sharp')` 是 MODULE_NOT_FOUND**
（实测）。给插件单加一份原生模块要动打包，这一轮验不了——按规矩不先写，记在这里。

### 可灵视频接进新插件：一个品牌两套协议（2026-08-21，四条路真机出片）

差集四家里剩下的两家：`kling-video` 与 `kling-3.0-turbo`。**它们不是一个协议的两个名字**——
v1 收扁平字段（`model_name` / `mode` / `duration`）、终态 `succeed`、url 在
`data.task_result.videos[0].url`；3.0 turbo 把参数塞进 `settings`、参考图塞进 `contents` 数组、
终态 `succeeded`、url 在 `data[0].outputs[0].url`，而且**提交回对象、查询回数组**
（它自己的 dto 两种都认，`dto/kling_v30_turbo.go:203-233`）。所以是两个 provider，
不是一个带分支的。

#### 写代码之前先把四条路的形状问清楚，一发片子都没产

用的是册子记的那招：**毒一个校验顺序靠后的字段**。四条路各一发，全部回 HTTP 429 + 体内 `code:400`：

| 路径 | 毒的字段 | 回什么 |
|---|---|---|
| `/kling/v1/videos/text2video` | `aspect_ratio: '99:1'` | `aspect_ratio value '99:1' is invalid` |
| `/kling/v1/videos/image2video` | `image: 'not-an-image'` | `File is not in a valid base64 format` |
| `/kling/text-to-video/kling-3.0-turbo` | `settings.resolution: '4k'` | `settings.resolution must be 720p or 1080p` |
| `/kling/image-to-video/kling-3.0-turbo` | `contents` 里不放首帧 | `contents must include at least one first_frame item` |

**这几句投诉的措辞有额外信息**：中转层自己的本地校验说的是 `invalid aspect_ratio value: …`
（`kling/adaptor.go:1085`），而回来的是 `aspect_ratio value '…' is invalid`——**措辞不同，
说明请求穿到了可灵本身**，不是被平台在门口拦下。判「路通不通」时这比状态码有用得多。

同一发也证伪了一个我差点写进注释的推断：拿目录 id `kling-video` 当 `model_name` 发过去，
回的**也是**比例投诉——**这不能证明它合法**，只说明比例排在名字之前校验。所以仍按老结论发
真实版本号 `kling-v1`（白名单 `kling/adaptor.go:1928`）。事后平台日志把这条钉死了：

```
2026-08-21 18:19:11  kling-video  渠道 4124  模型 kling-v1，模式 std，时长 5s，基础总价 0.15
```

计费行的 `model_name` 是目录 id，`content` 里记的才是上游版本号——两者确实是两回事。

#### 真机四发（720p / 5 秒）

| 用例 | 出片 | 产物 |
|---|---|---|
| 客户端点名 `kling-3.0-turbo` 文生 | 301 秒 | 1280×720，6.67 MB |
| 客户端点名 `kling-video` 文生 | 341 秒 | 1280×720，5.99 MB |
| 客户端点名 `kling-video` 动画一张 1024×1536 竖图 | 371 秒 | **832×1216**，3.58 MB |
| 客户端点名 `kling-3.0-turbo` 动画同一张竖图 | 175 秒 | **784×1176**，2.46 MB |

后两行是这一轮唯一真正的新知识。`referenceDecidesShape` 我原本只是照平台源码断言的
（v1 的 `image2video` 根本没有 `aspect_ratio` 字段，turbo 的图生我则是刻意不发 `settings.aspect_ratio`），
而 **2:3 根本不在我们声明的比例集 `16:9 / 9:16 / 1:1` 里**，两条路的产物却都与源图同比——
所以画幅确实由图定，两代同一条。同一轮客户端对用户说的是「视频会保持竖版比例，不留黑边」，
这句正是这个字段的输出；Vidu 那次它说的是假话，这次两条都是真的。

turbo 明显更快（图生 175 秒 vs v1 371 秒），但两条都远超统一入口的 veo（约 100 秒）——
facade 那个十分钟预算当初就是照可灵定的，别往下调。

#### 两处与老插件刻意不同

- **不认领 `Multi-image reference to video`**。那条要 2~4 张图，而本工具最多交给 provider 一张
  （`media/video-tool.ts`）。`kling-video` 靠另外两个类型照样认得出，少认一个类型不丢模型，
  却能让将来真拆出去的多图行落到「没接这条」的准确拒绝上。
- **`claims` 按 `kling-` 前缀收窄**。`Text to video` / `Image to video` 是整份目录里最泛的两个
  类型名，今天只有可灵挂着；将来别家挂上同名类型时，没有这道收窄就会把它的请求发到 `/kling/…`。

轮询仍然必须走**提交时那个挂点**（`handle` 带过去）：这条路上问错挂点不回 404，回的是一个 stub，
于是轮询会把整个预算耗在一个几分钟前就拍完了的任务上。

### grok 视频：xAI 原生那条，也是这个目录里唯一挂在 `/v1` 下的（2026-08-21，两条路出片）

上一轮记的那句「统一入口只是宽容，判据归 `endpoints`」这次兑现了：`grok-imagine-video` 与
`grok-imagine-video-1.5-preview` 挂的类型是 **`官方格式` → `POST /v1/videos/generations`**，
请求体、终态字面量、错误封套跟统一入口全不一样，所以是独立适配器，不是往 `unified.ts` 里
加一行字符串。**别家的专属路由都在站点根（`/kling/…`、`/minimax/…`、`/ent/v2/…`），只有这条在
`/v1` 下**，用 `wire.base` 而不是 `root`——拼错了得到的是一个看着像「任务不存在」的 404。

#### 五个必填字段，以及一个不会文生的型号

`model / prompt / aspect_ratio / resolution / duration` 缺一不可（`xaivideo/adaptor.go:84-96`）——
其中后两个在我们工具里是可选的，所以默认值得在适配器里定（时长按秒计价，用户没点名长度就
不该替他多买三秒，取 5 而不是平台默认的 8）。四发探针全部被中转层**本地**拒掉，没产片没计费，
而本地拒绝同时也证明这把 key 在这条路上有渠道（选渠道跑在校验之前）：

| 发的 | 回的 |
|---|---|
| `resolution: '1080p'` | `resolution 1080p is not supported yet` |
| `grok-imagine-video-1.5-preview` 不给图 | `only supports image-to-video, image is required` |
| 同上但给了图 | 过了那道关，改报被我毒的分辨率 |
| `duration: 99` | `duration must be in range [1, 15]` |

第二行就是 `requiresFirstFrame` 的第三个客户（前两个是百炼与海螺）：平台把它写成一张显式表
（`xaivideo/models.go:33-42`），两个名字只差一个版本尾巴，看名字是判不出来的。

#### 两处形状跟这个目录里所有别家都不同

- **参考图是对象** `image: { url }`，不是裸字符串（`xaiMediaRef` 收 `url` / `image_url` / `file_id`）。
- **拒绝时 `code` 是字符串**（`{"code":"invalid_request"}`），而可灵成功时 `code` 是数字 0。
  照搬可灵的判据会把 grok 的每一次回答都读成失败，所以这边的判据是「有没有 `request_id`」——
  提交成功时它回的就是一个裸 `{request_id}`，没有状态也没有包装层。

#### 真机

| 用例 | 出片 | 产物 |
|---|---|---|
| 客户端点名 `grok-imagine-video` 文生 | 100 秒 | 1280×720，9.04 MB |
| 客户端点名它动画一张 1024×1536 竖图 | 80 秒 | 720×1280，3.58 MB |
| 直连：同一张竖图 + 显式 `16:9`、480p、1 秒 | 43 秒 | **848×480**，0.27 MB |
| 客户端点名 `-1.5-preview` 纯文字 | — | 当轮拒绝，模型改为先出图再动画 |

第三行是**专门为了不重蹈 Vidu 那次**打的。第二行看着像「图决定形状」，其实不是：源图是 2:3，
产物却是 9:16，两者不同——是模型自己挑了 9:16。要分清「照搬源图」和「按字段选」，判据必须让
源图比例**落在合法集之外**，再显式要一个跟它最不像的。竖图要 16:9 回的是横屏，所以这条路
**不声明 `referenceDecidesShape`**：它即使带图也必填 `aspect_ratio`，画幅是选的不是继承的。
同一发还顺带钉死了 `image.url` 收 data URI（2.09 MB 的 PNG，7 秒提交完）。

## 改图的第二条路：源图塞进 generations，目录里一个字都看不出来（2026-08-21 真机复验）

**要复现的结果**：点名 `doubao-seedream-4-0-250828` 或 `qwen-image-3.0` 说「把这张图改成黑白」，
它就真的改。改之前我们回的是「「qwen-image-3.0」在这个账号上只能凭提示词出新图，没有改图这条
路径」——**那是假话**，而且是我们自己那条「宁可拒绝也不静默重画」的规矩误伤的。

### 先把出图这侧的差集算干净，才发现缺的不是模型是能力

镜像注册表的认领规则去减活目录（`.tmp-probe/image-gap.mjs`，同一套四字段、同一组判据）：
476 行里认领 34 条，`模型广场`「图像」档中没人认领的 14 条**逐条都不该接**——9 条 MJ 动作族
＋ `mj_modal` 要上一个任务的 taskId，`mj_describe` 与 `kling-image-recognize` 是图转文，
`mj_blend` 不收 prompt 且要 2 张以上，`dall-e-3` 标着「弃用」且一个端点类型都没声明。

**出图这一档没有缺口**，缺的是那 34 条里有多少会改图：改之前算出 16 条，改之后同一支探针
数出 **24 条**（多的 8 条是豆包 seedream 5 条 + 千问图像 3.0 两条 + kontext 一条）。

### 判据不在目录里，在平台自己的控制台

这条路是**照常 POST `/v1/images/generations`，body 里多带一个源图字段**，同一个模型就从
文生图变成改图。所有走这条路的行 `supported_endpoint_types` 都只有 `image-generation`，
与纯文生图的行**逐字节相同**，所以按端点类型写的判据必然把它们判成不能改图。

平台自己的答案在 `web/src/data/modelParams.js` 的 `supportsImageInput` 标志 +
`web/src/pages/Lab/capability/buildImageRequest.js:329 / :249 / :292` 三处按家族拼字段。
**字段名逐家不同、猜不出来**：seedream 5.0 收数组 `images`，它自己的 `-pro` 兄弟收字符串
`image`。所以 `media/image/openai.ts` 里那张 `GENERATIONS_EDIT_FAMILIES` 是**必要的**，
不是偷懒的硬编码——目录答不了这个问题。

### 「是改图不是重画」怎么证：提示词里不给任何景物

指令是「把这张图改成黑白的，其他都不要变」，**一个主体词都没有**。忽略源图的模型无从画起，
所以回来的还是原来那盏灯笼/那把红伞，就只能是读了源图。这比肉眼比「像不像」硬，也比看
HTTP 200 硬——这条路最危险的失败形态恰恰是 200 + 一张漂亮的无关新图。

| 模型 | 字段 | 用时 | 结果 |
|---|---|---|---|
| `doubao-seedream-4-0-250828` | `image` | 13 s | 改，裁成方图 |
| `doubao-seedream-4-5-251128` | `image` | 13 s | 改，裁成方图 |
| `doubao-seedream-5-0-260128` | **`images`（数组）** | 97 s | 改，裁成方图 |
| `doubao-seedream-5-0-pro-260628` | `image` | 61 s | 改，保住竖版；**带「AI生成」水印** |
| `qwen-image-3.0` | `image` | 84 s | 改，保住竖版 |
| `qwen-image-3.0-pro` | `image` | 94 s | 改，保住竖版 |

控制台把这栏写作 URL（`imageInputFormat: 'url'`）而我们没有图床，所以**data URI 收不收**是
唯一的悬念：2.79 MB 的 data URI 六家全收。**这条路上图的大小不是瓶颈**，与视频那侧「参考图
太大就提交超时」正好相反——32 KB 与 2.79 MB 的反应逐字节一样。

### 两条真接不了，一条欠着渠道

- `qwen-image-max` / `z-image-turbo`：中转层走同一套映射（`relay/channel/ali/image.go:32-51`
  把 `image` 拼成 `content[0].image`），但上游 DashScope 分别回 `content parameter's length
  invalid` 与 `Field 'text' is required in content item`。**换 32 KB 小图报一模一样的错**，
  所以是形状不合、不是负载太大。不接。
- `flux.1-kontext-pro`：三次全 429，账单里写着 `No available channel`。渠道空缺不是接法有问题，
  所以按控制台声明照接（in-context 编辑是这一族的全部用途），欠一次真机——猜错也是响亮失败。

### 顺手捞到的：豆包水印默认是开的

`doubao-seedream-5-0-pro` 出的图右下角盖着「AI生成」。控制台对豆包**每一发**都显式带
`watermark: false`（`buildImageRequest.js:330`），我们一个字没发，吃的是厂商默认；带上之后
同一张图干净了。**只给看见过的那一家补**：这条路上不认识的参数会原样转给上游变成被拒的请求，
拿一个没人见过的水印换一个人人见得到的失败不划算。

### 一处连带修正

`editableDefault` 的注释原来写着「今天的默认模型（seedream）不会改图」，那句话从这一版起
不成立了——默认模型现在两条都会，所以没点名时它原样留用，`EDIT_DEFAULTS` 只在下发的默认
模型确实只会画画时才被摸到。

### 真机复验（客户端一轮跑完两步）

一句话两步：`doubao-seedream-4-0-250828` 画竖版红伞 → `qwen-image-3.0` 改成黑白。产物是同一把
伞、同一块青石板、同一处水洼涟漪的黑白版；账单两行分别是 19:47:46 `doubao-seedream-4-0-250828`
（1024×1536，9 s）与 19:49:02 `qwen-image-3.0`（65 s）——**点名的两个模型各自扣费，没有偷换**。

## 附件收任意文件：内核这一版没有入口，我们自己接了一条（2026-08-23 真机复验）

起因是用户的两张图：内核的输入框**只能拖图片**，拖别的报「仅支持 PNG/JPG/WebP/GIF」；
而 WorkBuddy 什么文件都能扔进去，用**同一个中转站的令牌和对话模型**照样处理。
查完得到的形状，六条事实，每条都决定了一处取舍：

| 事实 | `path:line` | 逼出来的取舍 |
|---|---|---|
| `@文件` 补全（`ui-reference`）在 npm 上**最低 rc.8**，它的依赖要 `^0.1.0-rc.8` 的 `api-remotes` / `client-runtime` / `client-ui-input-trigger` | npm view | 我们全线钉 rc.6，装下去会并存第二份 slots 契约，槽位合并当场坏；这条能力跟内核升级来 |
| 拖进来的文件整批交给 `onAddImages` | `ui-attachment/ComposerAttachments.tsx:65` | 「拖任意文件」升不升级都要自己拦 |
| `inputActions.setDraft(text)` 是唯一公开草稿写入路径，且属会话标准套件 | `ui-conversation/contract/slots.ts`（`SessionStandardProps`） | 往输入框插路径不用碰内核、不用 DOM 黑魔法 |
| `fs-sandbox` 三档全是围 **mutation** 的 | 内核 README「`read-only`：拒绝一切 mutation」 | 桌面上任意绝对路径都读得动，**不用把字节搬进工作区** |
| `read` / `write` / `edit` / `read_image` / `bash` / `pwsh` 都在 vendored 清单里 | `tool-fs/src/read.ts:77` 等 | 「路径进消息」是真能落地的活路 |
| DSH 的窗口 `sandbox: true` 且**不挂 preload** | `dsh-plugin-desktop/src/window-options.ts` | 渲染层拿不到 `webUtils.getPathForFile`（Electron 43 里 `File.path` 早没了），所以「只传路径不传字节」这条走不通 |

据此落地的形状（`openlux-plugin-account`）：

- **按钮在 `conversation.input.left`**——内核给「紧挨常驻控件的小控件」留的列表槽，
  实测渲染在「访问模式」和模型选择器之间，正是 WorkBuddy 回形针的位置。
- **隐藏 `<input type=file>` 收文件，字节走本插件自己的 RPC（`files.stage`）**，
  宿主写进 `~/.dsh/media/incoming/`，回一个绝对路径，`setDraft` 把它以行内代码插进草稿。
  上限 32 MiB，和内核收图那条 `attachment-local.maxImageBytes` 同一个数。
- **文件名 = 原名（保留中日韩字符）+ 内容 SHA256 前 12 位 + 原扩展名。** digest 取自内容，
  所以同一个文件附两次落到同一份文件（实测第二次「新增 0 个」）。
- **人设补一句**（`persona/tool-reality.ts`，条件是这个 agent 真看得见 `read`）：消息里的路径是
  本机真实文件、有权打开、不受「产出落在工作目录」那条约束；`read` 打不开的二进制改用
  `pwsh` / `bash`。缺这句就退化成「请把内容粘贴给我」。

**用槽位要引声明它的那个包的类型。** `conversation.input.left` 的契约在
`dsh-client-ui-conversation` 里，不加这个 types-only 依赖，`SlotMap` 里就没有这个键，
`register` 过不了类型。注意本插件 `client/summon.ts` 有条相反的注释「`IConversation`
所在的包本插件不依赖」——那说的是**值**（服务面），结构化声明就够；**槽位名是类型**，只能靠真依赖。

### 真机复验：纯文本模型 DeepSeek V4 Flash，两个附件

判据都设成「答案里必须出现文件内部才有的东西」，避免它靠文件名编：

| 附件 | 判据 | 结果 |
|---|---|---|
| 脚本现造的 pptx，正文写一个**随机**验证码 | 原样念出那个码 | 通过：模型自己判断 pptx 是 zip，用 `Pwsh` 解出两页 XML，念出 `YW-402872` 并复述第二页。18 s / 4 步 |
| `~/.dsh/media/video` 里一段 8 秒 mp4（中文文件名） | 时长 / 分辨率 / 帧率与 `ffprobe` 一致 | 通过：8 s、1280×720、24 fps、H.264+AAC 全对，还跑 `signalstats` 推出画面偏暖。1m41s / 16 步 |

第二条顺带量出了纯文本模型的代价：它看不见帧，只能靠命令行绕，16 步换一段描述。
真要「看画面」得视觉模型 + 抽帧（WorkBuddy 就是抽帧喂 `image_url`），这条还没接。

**驱动手法**（原生文件对话框没有 DOM，点按钮验不了）：CDP `DOM.setFileInputFiles` 把真文件塞给
那个隐藏 input，再读 `textarea.value` 看路径有没有进草稿——`.tmp-probe/attach-file.mjs`。

### 拖放那半：preload 其实不需要（同日）

计划里写着「要给 DSH 窗口加最小 preload 暴露 `webUtils.getPathForFile`」——**决定搬字节之后
这条前提自己没了**：`dataTransfer.files` 给的 `File` 和文件选择器给的完全一样，
同一条暂存路径直接复用。所以拖放只剩一件事：**捕获阶段的 `document` 上拦下带非图片的 drop**
（内核的在冒泡阶段，`ComposerAttachments.tsx:70`），`stopPropagation` 一下，
「仅支持 PNG/JPG/WebP/GIF」就不会冒出来。

分流规则：**整批都是图片 → 原样放给内核**（缩略图轨、预览、多模态轨都是路径给不了的）；
**掺了一个非图片 → 整批归我们**，图片也变路径。因为内核那个 handler 要么吃下整个
`dataTransfer.files` 要么什么都不吃，拆不开；而「图片带路径」还能 `read_image` 打开，
「pptx 被拒」是真没了。拖拽中内核那张遮罩仍写着图片字样，先留着。

真机复验（`.tmp-probe/drop-file.mjs`，`Input.dispatchDragEvent` 投**真实文件路径**，
与资源管理器同一条入口）：拖 pptx——草稿出现路径、暂存 +1、内核那句拒绝没出现；
拖 png——草稿为空、暂存没变、内核缩略图 1 张。第二行是分流规则的另一半。

**更正（8-23 量出来的）：CDP 的合成拖拽只给路径，不给字节。** 同一条命令今天复跑，
落地的是「这个文件读不出来，没附上」。在 `document` 上挂个探子读 `dataTransfer.files`
（`.tmp-probe/drop-bytes.mjs`）：`{name: 'attach-sample.pptx', size: 0}`，`FileReader`
报 `NotFoundError`——渲染进程没有那条路径的读权限，真实拖拽是用户手势顺带授的，
`Input.dispatchDragEvent` 没有。所以这条探针能证的只有**分流与拦截顺序**
（我们的监听先跑、内核那句拒绝没冒出来）；**读字节那半由按钮那条路证**
（`DOM.setFileInputFiles` 给的是有字节的 `File`，`stage` 之后完全同一段代码）。
「从资源管理器真拖一个」这半只能人来点一次，记成未验。

**再更正（8-23 傍晚）：字节到底给不给，取决于开发版是怎么起的。** 同一条
`Input.dispatchDragEvent` 在直接跑 `electron.exe lib/main.js --remote-debugging-port=9333`
的实例上**是带字节的**：拖一张 12495 字节的 png，`~/.dsh/media/incoming` 当场多出
`ask-sample-6468b01b1394.png`，长度 12495、时间戳就是那一秒（内容寻址的名字，字节不对
连名字都拼不出来）。所以上面那句「只给路径」是**那一次那个实例**的事实，不是 CDP 的通则。
**判据别写成「CDP 不带字节」，写成「先看暂存目录里有没有真长度的文件」**——这是唯一
不受启动方式影响的证据。

拖放这条路顺带逼出两个真缺陷（都已修，形状值得记）：

1. **拒绝只写在按钮 tooltip 里等于静默失败。** 点按钮的人指针就在那儿，拖文件的人不在。
   现在同一句话同时进**会话通知条**：`notify(level, text)` 是内核给「机器外部的通知」留的入口
   （`ui-conversation/lib/types/client/input/contract.d.ts:50`），**按会话路由**——
   切了会话也落回它自己那条。它**不在**会话标准套件里（`InputActions` 只有 `setDraft` /
   `addImages` / `removeImage` / `pruneImages` / `submit`），所以照内核自家 `QueueDock`
   的做法从 inject 面拿（`QueueDock.d.ts:7`）。
2. **`ctx.sessions` 不在插件 inject 清单里，碰它就抛。** 第一版直接 `composerFor(ctx, …)`，
   异常穿过 `stage`，按钮永远停在「正在附带…」——比原来的静默更糟。改成把绑定放进
   `ctx.inject(['sessions'], …)` 的作用域（这也是本插件 summon 已有的形状），再给 `stage`
   补 `finally` 兜 busy。**「异常吃掉收尾状态」这个形状，值得在插件里整体搜一遍。**
3. **`stopPropagation` 顺手把内核那张拖拽遮罩的复位一起拦了。** 用户看到的是
   「图片拖动到此处即可添加」糊在整个窗口上不走，直到重启。原因在内核源码里写得很直白：
   复位 `reset()`（`dragDepthRef = 0` + `setDragActive(false)`）**只挂在两处**——它自己的
   `onDrop` 里（就在 `intakeImages` 上一行）和 `window` 的 `dragend`
   （`ui-conversation/lib/client.js`，`dragleave` 只在指针离开视口时才复位）。
   我们在捕获阶段把 drop 停掉，`onDrop` 就没跑；而 `dragend` 在「从操作系统拖进来」这条路上
   页面里根本不触发，所以遮罩没有第二次机会。修法是拦下之后**照它自己的另一个入口说一声**：
   `window.dispatchEvent(new DragEvent('dragend'))`。不碰它的 state，不猜它的类名。

## 上游版本盘点：我们落后多少，值不值得跟（2026-08-23）

### 硬数字

| 东西 | 我们 | 上游 | 差距 |
|---|---|---|---|
| 内核 npm 包（`@deepseek-ai/dsh-*`） | `0.1.0-rc.6`（外壳 97 处 pin + 本插件 50 处） | `0.1.1-rc.2` | 中间还有 rc.7、rc.8、0.1.1-rc.1 |
| 内核源码 clone（`deepseek-harness`） | rc.8 | master | 落后 207 个提交，56 篇 `.agents/notes/implemented` |
| 外壳（`deepseek-harness-desktop`，社区维护） | clone 2.0.1 | 2.0.2，**已 pin 到 0.1.1-rc.2**（含一份 `patches/dsh-app-boot@0.1.1-rc.2.patch`） | 落后 89 个提交；我们这份 fork 与上游 head 差 177 文件 / +15513 −3060 |
| 本机安装的 DSH Desktop.exe | — | 2.0.2 | 就是上游那版，所以它写出来的档案是新格式 |

外壳里那两个提交名字就叫 `chore(runtime): upgrade DeepSeek Harness to rc2` /
`build: migrate desktop patches to dsh rc2`——**内核这一跳的适配上游已经做完了**，
我们要做的是把 fork 往前并，而不是自己啃 rc.6→0.1.1 的破坏性变更。

### 跟上去能拿到什么（只列真影响我们的）

1. **`@文件` / `@会话` 引用（rc.8）**——顺带确认我们的形状是对的：上游那篇笔记在
   「Alternatives considered」里明确否掉了「选中即把文件内容塞进上下文」，理由和我们一样
   （先花上下文、又绕开可审计的 `read` 调用），所以 `@file` 给模型的**也只是路径文本**。
   跟上去多的是补全菜单 + 宿主侧工作区索引 + 内核自带的模型提示；**我们这条暂存路径不会白写**：
   它管的是工作区外的文件（桌面、下载）和拖放，`@file` 的索引只覆盖工作区。
2. **pi-ai 线兼容面（0.1.1）**——30 个 compat 字段里放出 20 个，可按路由/按模型写，
   其中就有 `supportsDeveloperRole` 和 `maxTokensField`。今天这版的行为是：**手写路由
   （我们的中转站就是）拿到的是 OpenAI 自己的报文形状**——`role: "developer"`、
   `max_completion_tokens`、`store`，而且写了配置也会被静默丢掉。这正是我们记过的
   「DeepSeek 那条 `developer` 角色」那类问题唯一的正经旋钮。
3. **图片请求管线统一（0.1.1）**——持久附件与「每条模型路由自己的请求版本」分开，
   解决的两件事我们都撞过：大但正常的图被拒、每轮重复塞 base64。
4. **附件所有权改走槽位（0.1.1）**——`ui-conversation` 声明
   `conversation.input.attachments` / `conversation.message.images`，`ui-attachment` 去注册。
   这意味着上面那个「捕获阶段拦 drop」的土办法将来有正经缝可用。**还多解一件今天解不了的**：
   图轨里已有的图想转成路径，得读 `draftImages` / `removeImage`，而 rc.6 把它们关在
   `ComposerBarInjected` 这个包内私有面里（`contract/slots.d.ts:529-537`），
   `conversation.input.left` 够不着——所以「视觉模型下贴了图、再换成纯文本模型」这一格
   目前只能停在内核那句「当前模型不支持图片，请切换支持图片的模型」。
5. **Agent Teams 成了内核自带服务（含 experimental 包）**——专家团我们是自己在
   `tool-subagent` 上搭的。再动这块之前先读它，别又发明一遍。

不算收益的两件：`deepseek-files-inline-fallback` 走的是 DeepSeek 直连 Files 那条路，
不是我们的中转站；`web-*` 那批改的是浏览器部署。

### 代价与顺序

破坏性变更集中在客户端启动那一层：`dsh-client-web` 变成不带框架的 boot kernel，
React 根交给新的 `dsh-client-ui-renderer` 动态插件；设置面改成插件自持 + describe 镜像；
会话投影与 client views 重写；experimental 包整体改名。这些都可能碰到我们插件的槽位注册，
外壳那 177 文件的差异里也埋着我们自己的品牌/去更新器/SSRF 改动要重新落位。

**所以：值得跟，但当成一件单独的任务排在当前「模型能力事实」这条线之后。**顺序是
外壳 fork 先并上游 2.0.2（内核跳版随它一起过来）→ 再修本插件 50 处 pin 与编译错误 →
再按现有探针复验一轮。中途还有个天天在收的税：**安装版 2.0.2 每跑一次就把
`~/.dsh/.credentials.yaml` 迁成 `version: 1` + `refs:` 的嵌套格式，rc.6 的
`credentials-local` 只认平铺 `KEY: value`（且 value 必须是字符串），开发版就起不来**，
每次都要手工摊平一遍。

### 「升级能不能省掉图片入口这摊事」——不能（2026-08-23 查 rc.8 源码）

问题起于要不要接着自己写「发图给纯文本模型」的分流。查完 rc.8 的答案是**省不掉**，
三条事实各自独立地把这条路堵死，而且都不是版本差距造成的，是上游的设计就这样：

| 事实 | 出处（rc.8 源码） | 对我们的意思 |
|---|---|---|
| 线上模型目录**不带模态** | `packages/host/apiproxy/src/api/sessions.ts:120-129`，`ModelCatalogModel` 只有 `id` / `name` / `description?` / `reasoning?` | 渲染层升级后照样不知道「当前这个模型收不收图」，能力事实只在宿主。我们那个 `files.vision` 端点该写还得写 |
| 客户端**一处模态判断都没有** | 整个 `packages/client` 里 `inputModalities` 命中 0 | 「当前模型不支持图片」只在发送时由宿主抛（`api-proxy.ts:2402-2408`），死胡同是上游的设计，不是我们落后 |
| 拖放**仍然只收图片** | `ui-attachment/src/client/ComposerAttachments.tsx:65`（`onAddImages([...dataTransfer.files])`）、`:70` 冒泡阶段挂 `document`；`canAcceptDrop = !locked && !machineBusy && addImages !== undefined`（`ui-conversation/src/client/skeleton/InputBar.tsx`），与模型无关 | 我们那个捕获阶段拦截升级后照样有效，也照样是拖一个 pptx 进来的唯一办法 |

升级**确实**能省的只有半句话：`@file` 会带上游自己的提示词
（`context/file-reference/src/index.ts:18` 的 `FILE_REFERENCE_PROMPT`，内容和我们人设里那句
「路径是真文件，先 read」几乎一样），到时候可以删掉我们的重复表述。但它
**按 session cwd 划边界**（同文件 `list()` 的契约：*agent whose session cwd bounds discovery*），
所以桌面 / 下载目录里的文件仍然只能走我们这条暂存路径。

还有一条顺带查清的：上游**没有任何「让能看图的模型代看一眼」的工具**
（`packages/` 里 `image_ask` / `describeImage` / `visionFallback` 命中全为 0），
所以 `image_ask` 这类东西升不升级都得我们自己养。

## 真升了：外壳并到 2.0.2，内核 rc.6 → 0.1.1-rc.2（2026-08-23）

在独立工作树（`.wt-dsh-upgrade`，分支 `chore/dsh-0.1.1-rc.2`）里做，主工作树照旧跑着开发版。
`git subtree pull` 带进来 379 个文件、17 个冲突；解完之后 `yarn check` 全绿
（构建、类型、847 + 274 个测试、运行时闭包、loader、profile、许可）。

### 守住的分岔（每一条都是当初有理由的）

| 分岔 | 上游 2.0.2 的样子 | 我们保留的做法 |
|---|---|---|
| 品牌 | DSH Desktop | OpenLux：窗口标题、品牌标记、nsis、`APP_ID` 常量（上游 main.ts 重写后是硬编码字面量，改回常量） |
| 更新器 | 有 `desktop-updates` 行 | 仍然不挂：端点是 `update-checker.ts` 里的模块级常量，指着上游的发布服务，挂上去就是替上游发版 |
| 市场界面 | 自带 `dsh-community-market` | 依赖收了、UI 不挂，市场仍走我们自己的 `openlux-market` 段 |
| 客户端入口 | 新增桌面设置 UI、文件夹拖放、原生目录选择器 | 入口保持最小形状，`applyDesktopSettings` 不调；目录选择器的两条路由收作惰性脚手架（路由在、界面不挂） |
| web_fetch | 直接挂 `dsh-web-fetch-http` | 仍走我们的 `web-fetch-guard`（先分类目标再用它作传输），私网防护不外包 |
| 布局校验 | 上游版 `verify-layout.mjs` | 我们这版（subtree 感知 + 双语说明检查）；合并时它悄悄吃掉了一个 `basename` 导入，已补回 |

### 新拿到的旋钮

`hooks` 隔间（插件把裸 observable 交给渲染层，渲染层绑成 `use<Name>`）、
`dsh-client-ui-renderer` 这个 React 根、`settings-models` 里「改过 baseURL 就解锁 API 字段」、
`app-boot` 接受空 patch 层、Workspace 浏览器的 drop 目标标记、Trajectory 工具栏中文、
诊断与通知两行（`desktop-diagnostics` / `desktop-notifications`，已挂）。

### rc.2 打断我们的三处，以及怎么落回去

| 断点 | rc.2 的变化 | 我们的落法 |
|---|---|---|
| `bindSnapshotSelector` | `dsh-client-web-react` 整包没了，函数搬进 `ui-renderer` 且不对外导出 | 改走 rc.2 认可的 `hooks` 隔间：注入面里给 `hooks: { account: store }`，渲染层负责绑 |
| 图片原子 | `ui-attachment` 不再导出 `ImageGallery` / `ImageLoader` / `MessageImageLabels` | 自持：把 `ImageLightbox` / `MessageImage` 搬进本插件，CSS module 翻成内联样式（不为此引一套 CSS 构建） |
| `AssembleContext.agent` | 那个字段由 `@deepseek-ai/dsh-agent` 的模块增强提供 | 在 `tool-reality.ts` 里加一条 type-only import，包进 devDependencies |

### 四个补丁对 rc.2 重打（这次的主要工作量）

| 补丁 | 管什么 | rc.2 还需要吗 |
|---|---|---|
| `conversation` | 首页副标题「预览版 → 桌面版」 | 需要，rc.2 仍写 `预览版` / `Preview` |
| `settings-general` | 账户设置页的导航图标 | 需要，`navIcon` 仍是按 id 硬编码，`ui-slots` 里 `icon` 命中为 0 |
| `agent-preset` | 切会话后预设显示回不来 | 需要，rc.2 的 `load()` 才从会话推导 `current`，切会话只调 `apply()` |
| `settings-models` | 采纳对话框：搜索、只看已选、不预勾、全选只作用于命中项、计数行 | 需要，rc.2 有 `selectAll` 但作用于整份回复，且仍 `new Set(models.map(...))` 预勾 |

**上游自己也补了 `settings-models`**（`baseURL` 那条），而一个包只能有一个补丁文件，
所以我们的必须叠在它上面。可复用的重打流程：

1. `yarn patch <pkg>@npm:<version>`（`-u` 不可靠：它没把上游那份带进来，装好的产物里却有）。
2. 在解出来的副本里**先手打上游那份**，`git init` + commit 作基线。
3. `git apply --reject` 打我们的旧版补丁，看剩几块。这次 18 块里 11 块直接进，7 块要手工移。
4. 手工移那几块：CSS 那串不能整串替换（上游也改过），按规则算增量再挪
   （这次是新增 14 条、改 4 条、丢 0 条，另外上游新增的 `.candidateActions` 要留）；
   派生集合尽量沿用上游的变量名、只收窄语义，这样它现有的 JSX 不用动。
5. 删掉 `.rej` 和临时 `.git`，`node --check` 过一遍语法，再 `yarn patch-commit -s`。
6. **两个坑**：`patch-commit` 把文件写进 `.yarn/patches/`（locator 里的 `~` 是项目根，不是家目录），
   还会把 workspace manifest 里那条依赖改成 `patch:` 写法——两处都要按仓内约定改回：
   文件放 `./patches/<pkg>@<version>.patch`，`resolutions` 里 `npm:x` 与 `npm:^x` 两条都写，
   manifest 里恢复成纯版本号。
7. 复验：装一遍，然后直接在 `node_modules` 里的产物上验标记（含上游那处有没有被挤掉）。

### 顺手补的守卫

这次 resolutions 是被合并吃掉的：补丁文件还在，没人引用，产品静悄悄跑上游行为。
所以照上游的写法给这四个补丁各加了一个 `package.spec.ts` 断言——钉住两条 resolution key，
再钉一个必须能在装好的产物里看到的标记。

另外三处 `yarn test` 失败已分清，不是合并弄坏的：一处是上游断言根 `typecheck` 脚本只有两个
workspace（我们多一个 `openlux-plugin-account`，改成 `toContain`），另两处是上游测试只按 POSIX
写——`module-resolution` 用 `file:///tmp/...` 作锚（Windows 上 `fileURLToPath` 要盘符）、
`profile-create-window` 断言路径里有 `/native-ui/`（Windows 是反斜杠）。

### 落地顺序（2026-08-23 晚）

主工作树那 48 处未提交工作先自成一笔（`5ce406c`：纯文本模型改由有能力的模型代看），
再把升级分支并进来，破坏性变更的修复**放在合并这一笔里**——这样每个提交都装得上、编得过，
不会留一个「内核已换、插件还引着删掉的包」的中间态。

账号插件的适配因此是对着主工作树的新文件重做的，落点与上面预判的一致：

- `client/index.ts` 不再 import `bindSnapshotSelector`，两个注册点各交出裸 store
  （`hooks: { account: store }`）；组件侧类型套一层 `InjectFace`，`useAccount` 由渲染器绑好送进来。
- `ImageToolCard.tsx` 与 `image-loader.ts` 改指自持的 `MessageImage.tsx`；
  `tsdown.config.ts` 的 external 去掉 `dsh-client-web-react` 与 `dsh-client-ui-attachment`，
  并把上游那条注释一起抄来（这两条之外的 `@deepseek-ai` 取值导入会被新的构建闸口拒）。
- 插件 manifest 50 处 pin 换到 `0.1.1-rc.2`，补 `dsh-agent` 与 `react-dom`／`@types/react-dom`。

**一处上游没有的连带修复**：`dsh-plugin-desktop/tsconfig.tests.json` 把 rootDir 放宽到
workspace 根（好让三个 spec 直接 import 账号插件源码），于是 tsc 顺着 import 走进插件装好的
tarball 去检查 `.d.ts` 内部——pi-ai 的 providers 声明用无 import 属性的 JSON 导入、
Anthropic SDK 的类型按候选相对路径摸 undici-types，rc.2 起两处都成硬错（44 行）。
账号插件自己的 tsconfig 早就为同一个理由关了这项检查，这里跟上（`3500d0c`）。
范围只到 `.d.ts` 内部，我们的源码怎么用这些声明仍然全检。

收尾：`yarn check` 全绿（82 个测试文件 / 854 通过 / 13 跳过，闭包 202 节点、许可证 544 包）。

### 真机复验（2026-08-23 夜，开发版一轮跑完）

**那笔天天收的税自己没了**：rc.2 的 `credentials-local` 就是写出 `version: 1` + `refs:`
这个形状的版本，还带一次性迁移（`dsh-credentials-local/lib/index.js:150,686`：缺 version
时报的是「把现有条目挪到 `refs:` 下、值一个都不用改」，读到旧平铺文档会自己迁并记一条日志）。
安装版和开发版从此同代，不用再手工摊平。

**起法有一处变了**：`?dsh-desktop-mode=compatibility` 那条浏览器路子在 rc.2 断了——
平台层抽成 `electron-platform` + preload 注入，纯浏览器拿不到 `dsh-desktop-platform`，
直接落恢复页（实测报 `invalid or missing dsh-desktop-platform null`）。要挂 CDP 就绕开
`lib/bin.js`（它 `spawn(electron, [main.js])`，不转 argv），直接
`node_modules\electron\dist\electron.exe lib\main.js --remote-debugging-port=9223`。
渲染器自己带的查询串是 `?dsh-desktop-mode=advanced&dsh-desktop-platform=win32`。

量到的（CDP，非肉眼）：

| 验什么 | 真机读数 |
|---|---|
| 启动 | 无错，`errors` 探针 0 命中；宿主在 `127.0.0.1:43120` |
| 账号插件 | 侧栏 `yw_zhoucongjie` / `$59.15`；账户页 累计 $40.90 / 请求 5,203 / 前往管理中心 / 退出登录 |
| 补丁一（conversation） | Hero 是「桌面版」，不是「预览版」 |
| 补丁二（settings-general） | 「账户」排在「通用设置」之上，图标 path `M11.0307 5.46369…`（与侧栏账号行同款），齿轮是另一条 |
| 补丁三（settings-models） | 476 条候选**一条没预勾**；搜 `seedream` → 5 条；点全选只勾这 5 条、按钮变「添加所选 (5)」；取消退出没落库 |
| 对话链路 | 新会话发一条，6.9 秒回，输入 11.3K tok / 输出 2 tok |
| 我们的附件入口 | `附带文件` 按钮在位 |

**补丁四（agent-preset 跟随会话）当轮补验通过。** 先看清一件事：预设在界面上有两处形状——
新会话那屏是可点的座位（`button[class*="_seat"]`，`AgentPresetSeat`），已开始的会话里是只读标签
（`span[class*="SVAs4q_label"]`，`AgentPresetLabel`），两处读同一个 store，所以要验的是切会话
时这个 store 会不会按会话重新推导。

本机没有任何会话记着 `agentPreset`（`~/.dsh` 全量扫 28 个 json/jsonl，零命中），
所以造了一条：新会话上把座位从「标准模式」改成「腾讯HR数智专家」，发一条
「回两个字：收到」（输入 19.5K tok、输出 1 tok，12.8 秒），会话就真跑在那个预设上了。
然后 `location.reload()` 把 store 清回默认再切：

| 当前会话 | 预设显示 |
|---|---|
| 「收到。」（跑 hr-digital-expert） | 腾讯HR数智专家 |
| 切到「收到内核」（没记预设） | **标准模式** |
| 切到「PDF验证码提取」 | 标准模式 |
| 切回「收到。」 | **腾讯HR数智专家** |
| 点新会话 | 座位回到标准模式，没有继承上一条会话 |

两个方向都跟得住，新会话也不粘上一条的预设——这正是那条 `sync()` 存在的理由。
**侧栏行是 `role="treeitem"` 的 div**（不是 button / a / li），探针按 button 找会静默点空。

**留下的痕迹**：这轮在日常家目录 `~/.dsh` 里多了两条真会话（「收到内核」「收到。」），
共两次模型调用。留着不碍事，要清就在侧栏行的操作菜单里删。

### 顺带查清的两处「上游已经做了」

**一、`preload` 回来了，`files/stage.ts` 那条理由过期了。** 那个模块开头整段解释「为什么把字节
走一趟而不是传路径」，落点是「DSH 窗口 `sandbox: true` 且没有 preload，`webUtils.getPathForFile`
够不着，要拿到路径就得 fork 上游」。rc.2 自己加了 `src/preload.ts`，`contextBridge` 暴露
`__DSH_DESKTOP_FILE_PATH__.getPathForFile(file)`（契约在 `src/file-path-bridge-contract.ts`，
上游自己用它做工作区文件夹拖放，`src/client/workspace-folder-drop.ts:64`），
真机上 `window.__DSH_DESKTOP_FILE_PATH__.getPathForFile` 是 function。
所以桌面部署下**可以直接拿到真路径、跳过暂存拷贝**；浏览器部署仍然没有路径可交，
那条兜底还得留。**这段注释现在是过期证据，改动时一并更新。**

**二、`@file` 引用是原生的了。** `dsh-file-reference` 给宿主口子
（`ctx.fileReferences.list(agent, query, signal)` + 远程 `fileReferences/list`），
`dsh-client-ui-reference` 给浏览器端补全，`dsh-file-reference-local` 是实现——**按会话 cwd 建
有界索引**，`maxResults 20` / `maxEntries 10000` / 默认排除 `.git` 与 `node_modules`，
工具结果事件会让索引失效。真机验通：在输入框敲 `@` 就列出会话 cwd 下的目录，`@a` 会模糊排序。
它和我们那条路的分工是清楚的：**工作区内的文件走它**（白送，且带 `FILE_REFERENCE_PROMPT`
那段引导），**工作区外的文件仍然只有我们的按钮 / 拖放**（它明说「浏览器端不能自己扫盘」，
provider 也只认 cwd 那棵树），而「模型读不了文档时换一个能读的模型」那半仍然只有我们有——
`application/pdf` 在 rc.2 全部包里**零命中**，附件层白名单还是 png / jpeg / webp / gif 四个。

**三、模型能力事实仍然不下发给渲染层。** 但宿主侧这一版有权威读数了：
`ctx.llm.resolveModelInfo(provider, model).inputModalities`，宿主发送前用它拦
（`dsh-host-apiproxy/lib/types/api-proxy.js:2105` → `MODEL_DOES_NOT_SUPPORT_IMAGES`）。
下发给浏览器的 `modelCatalogModelSchema` 仍然只有 `id` / `name` / `description?` / `reasoning?`
（`sessions.schema.d.ts:113`）。而且它的事实源是 pi-ai 那份按厂商切的目录，
**没有 openlux 这一路**，所以对我们那 476 条模型它返回 `undefined`（那行判断写的是
`!== undefined && !includes('image')`，未知一律放行）。结论不变：这条事实得我们自己的宿主端点递。

### 还没做完的

1. **`files/stage.ts` 按新的 preload 桥重估**：桌面部署能省掉暂存拷贝那一跳，
   模块开头那段「拿不到路径」的理由已经过期。
2. **外壳档位**：本机 `~/.dsh/settings.yaml` 存着 `dsh-desktop: mode: advanced`，
   而源码默认与 8/18 的决定都是 compatibility（原生标题栏）。要不要改回是产品决定，没动。
