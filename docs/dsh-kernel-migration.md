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

**测试基线要记住**：本机 Windows 上**未改动的上游**就是 `4 失败 / 297 通过`，
四条全在 mac 专属（`mac-universal.spec.ts` 2 条 + `verify-mac-smoke.spec.ts` 2 条，
要 mac 的权限位与 `lipo`）。我们改完之后逐条一致 —— 判断有没有回归要拿这个数比，
不是拿「全绿」比。

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
- **仍待定性的一条**：并行工具调用时 `name`/`id` 流式组装丢字段
  （`unknown tool ""`，重试自愈，尚未定性）。

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

### 阶段 5 · 市场与后端契约（2 周，与阶段 3 并行）

见下一节。

### 阶段 6 · 发布（1 周）

品牌、签名、更新通道、许可证附带（内核 MIT + `THIRD_PARTY_NOTICES.md` + 外壳 MIT）、
灰度与回滚方案。

## admin-server / admin-cloud 要改什么

两个仓库都已建 `feature/dsh-kernel` 并并入最新 main。要改的不多，但有一条是硬的。

### 硬的那条：制品格式要加版本，不能一刀切

现在市场条目的制品是 openclaw 形状的 zip：`SKILL.md` + persona 目录 + `_yunwu_meta.json`，
装到 `~/.openclaw/skills/<slug>`。dsh 的专家是 agent preset 目录
（`agent.cordis.yml` + 可选 `preset.yml`），技能与连接器又各是另一套。

**老版本客户端已经发布在外**，它们会继续按 openclaw 形状拉制品。所以：

- `desktop_market_item` 加一个格式/内核标识字段，客户端按自己认识的格式取。
- `GET /api/desktop-market/snapshot` 按客户端声明的能力过滤，或返回两份制品链接。
- 制品下载那条是公开 HMAC 直链（`api-router.go` 里 `ServeDesktopMarketArtifact`
  刻意没挂 `TokenAuth`），这条机制不用动。

admin-cloud 侧对应改：市场编辑器要能产出新格式（`src/pages/desktop-market/`，7 文件 87 KB）。

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
| 老客户端还在外面跑 | 制品格式加版本字段，两种格式并存一段时间 |
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
