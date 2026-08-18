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
- **仍待定性的一条**：并行工具调用时 `name`/`id` 流式组装丢字段
  （`unknown tool ""`，重试自愈，尚未定性）。

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

**怎么跑的**：`DSH_HOME` 指到 live home（`%TEMP%\yw-dsh-live`，含 `.credentials.yaml`
与用户装的 12 份 preset），`dsh --profile desktop --port 43121` 起 web 服务，浏览器驱动。
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

出厂 2 份（`config/agent-presets/`）+ 真机 live home 装的 12 份，逐份解析 YAML、
按成员取 `toolFilter`、全文数死工具名 / 死模型名 / 品牌词：

| preset | 形状 | 成员的工具面 | 死名字 |
|---|---|---|---|
| `ai-content-creator-team`（出厂） | 团 · 6 成员 | 六个都是 `allow=[skill,read,write,edit]` | ImageGen×13 ImageEdit×9 SendMessage×25 `deliver_attachments`×13 YT-VITA×16 `subagent_type`×7 `uploadAndGetVid`×2 `Agent 工具`×2；模型名 HY-Image×25 HY-Video×18 YT-Video×28（含小写变体）；WorkBuddy×14 |
| `market-probe-team`（live home） | 团 · 6 成员 | 同上 | **与上面逐项相同** |
| `marketing-growth-team`（live home） | 团 · 4 成员 | 四个都是**无 `toolFilter`** | 干净 |
| `content-creator`（出厂）+ 9 份单专家 | 单专家 | 无收窄 | 干净 |
| `tencent-cloud-quote-assistant`（live home） | 单专家 | 无收窄 | WorkBuddy×2 |
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
  首片取到的工具名冲空**（`references/openclaw-kernel.md:131`、`:141-145`，同一节还记着
  当年的错误结论是"等中转修或打补丁"，正解是换适配器）。
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

**B. 让成员按用户指定的模型生产——是那条功能的下游，而且比它多一步。**
第三条（把 `model` 加成取 `ROUTE_MODELS` 键的 enum）只解决"单会话里模型能选"。
专家团还多一跳：**成员是独立子代理，用户的模型意图必须由主理人写进委派 prompt，
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
| 市场装的**独立**技能 | `$DSH_HOME/skills/<id>/` | 出厂 `standard` / `code` / `cordis` 的 `skill-filesystem` 默认 `includeDefaultRoots: true` | 用户技能根。专家 preset 必须 `includeDefaultRoots: false`，只扫自己的 `skills/`，否则独立技能会漏进每个人设 |
| 连接器 | profile 用户层一行 MCP（阶段 5 已定） | `dsh-mcp-client` | 与专家无关 |

**WorkBuddy 包 → preset 目录的映射（内容保留，机制换掉）：**

| WorkBuddy | DSH preset |
|---|---|
| `plugin.json` 的 `displayName.zh` / `displayDescription.zh` | `preset.yml` 的 `name` / `description`；`id` 是目录名，必须 `[a-z0-9][a-z0-9-]*` |
| `agents/<lead>.md` 正文 | `dsh-persona` 的 `text`（身份指令里的 CodeBuddy 换成 OpenLux） |
| `skills/*` | 档内 `skills/` + `skill-filesystem.customSkillDirs` 指向 `new URL('skills/', baseUrl)`，`includeDefaultRoots: false` |
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

**三、出图 / 搜索的模型选择面（最后做，属于参数面）。**
现在出图模型是部署配置（默认 `doubao-seedream-4-0-250828`），工具参数只有
`prompt` / `n` / `size`，模型选不了、用户说了也不算；搜索固定走我们网关上的
`claude-haiku-4-5-20251001`。要让「用指定模型出图」生效，就把 `model` 加成 enum（取
`ROUTE_MODELS` 的键）并让 `size` 的取值跟着所选模型走。代价是工具描述变长、用户可能
选到更慢更贵的模型，而且网关上 gemini 那几个出图模型是 503，名单得人工筛。

**这条带一个必须一起设计的子项：专家团里的透传。** 成员是独立子代理，用户「用 xxx 模型画」
这句话不会自动到成员手里——它得由主理人写进委派 prompt，成员再填进工具参数。子代理继承的
`provider/model` 是**对话模型**，出图/出视频模型是工具的部署配置，不在 agent 路由里
（详见上面「与『指定模型出图/出视频』的先后关系」那节，连旧壳踩过的裸模型名故障一起记在那）。
动工时把这一跳一并画进去，别只做单会话那一档。

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
