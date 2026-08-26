# 统一市场：专家 / 技能 / 连接器（对齐 WorkBuddy 的 unifiedMarket）

> 起因：2026-08-24 用户要求「把专家和插件市场分清楚，做成 tab」，并点名要 WorkBuddy 的
> **我的专家**、**添加技能**、**自定义连接器** 三个功能。本档是动手前的方案，所有事实都带证据；
> 结论过期就地改，别另开一份。

## 0. 要复现的结果（对齐判据）

判据是结果，不是形式。要复现的就是 WorkBuddy 那一套，它的 i18n 里一字不差地摆着
（`D:\workbuddy\resources\app.asar` 原始字节扫描，偏移 150711282 附近）：

```
"unifiedMarket.tab.experts": "专家"
"unifiedMarket.tab.skills": "技能"
"unifiedMarket.tab.connectors": "连接器"
"unifiedMarket.search.experts": "搜索专家职称或描述"
"unifiedMarket.search.skills": "搜索技能"
"unifiedMarket.myExperts": "我的专家"
"unifiedMarket.myInstalled": "我安装的"
"unifiedMarket.addSkill": "添加技能"
"unifiedMarket.customConnector": "自定义连接器"
"unifiedMarket.backToAll": "全部专家"
"unifiedMarket.backToAllSkills": "全部技能"
```

三个 tab 一个搜索框，右上角按 tab 换动作按钮（专家 → 我的专家；技能 → 添加技能；
连接器 → 自定义连接器）。「我的专家」是**整页切换**的子页，不是弹窗——它自己的 CSS 注释写着
*「我的专家」子页面顶栏（点击「我的专家」按钮后整页切换）：隐藏左侧 slot / 搜索 / 按钮，
整个 ec-topbar 替换为返回按钮*（偏移 13169155）。子页有二级 tab 与创建卡片
（`.ec-my-panel` / `.ec-my-sub-tabs` / `.ec-create-card`，偏移 13181592）：

```
"myExperts.subTab.created": "我创建的"      "myExperts.recent.hint": "仅展示最近使用的 3 个专家"
"myExperts.created.createCard": "创建专家"   "myExperts.created.createTeamCard": "创建专家团"
"myExperts.created.ctxView/ctxEdit/ctxShare/ctxOpenFolder/ctxPublish": 查看/修改/分享/打开文件夹/上架
"myExperts.empty": "暂无使用记录"           "myExperts.emptyHint": "去专家中心召唤你的第一个…"
```

连接器那侧是完整一套状态机（`connectorPanel.*`，偏移 150991763）：可用 / 已连接 / 连接中 /
未连接 / 连接错误，动作是 连接 / 断开 / 重新连接 / 配置 / 解绑 / 工具列表，令牌走
`tokenDialog.tokenLabel: "访问令牌 (Token)"`。OAuth 那半（GitHub / MasterGo / 工蜂 / CNB）
是腾讯自家服务，我们没有对应物，不做。

**插件市场不并进来**，理由与形状见 `dsh-kernel-migration.md`：它装的是跑在我们进程里的第三方
代码，且新内核禁止跨插件 import 值、它的开关是它自己的 store，外部碰不到。它继续待在设置里那一栏。

## 1. 现状盘点（2026-08-24 真机核过）

### 后台数据（本机 admin-server :3000，用代码里那对 TEMP 市场凭据打的 `/api/desktop-market/snapshot`）

| 分区 | 条目 | 分类 | 有 icon 的 | icon 域名 |
|---|---|---|---|---|
| expert | 407 | 15 | 407 | `image.zhongzhuan.chat`（我们自己的图床） |
| skill | 994 | 10 | **0** | — |
| connector | **3** | 2 | 0 | — |

> 这张表是 08-24 那天的盘点，留着是为了看清起点。连接器那行已经不是这样了：
> 阶段四导入之后是 19 条，分类 0 个（见 §5.2 与 §5.3）。

- 技能的 icon 是空的，不是"没走我们图床"——两个导入器
  （`import_skill_repos.go`、`import_expert_center.go:733` 那段 upsert）**从来没写过 Icon 字段**。
  专家的头像是转存过的，策略见 `expert_avatar.go` 的文件头注释（一律转存、幂等靠上一轮结果）。
- 连接器只有三条手播（`seed.go:462` 起：context7 / tavily-search / filesystem），
  **没有任何导入器**（`rg DesktopMarketTypeConnector` 只命中 seed 与类型校验）。这就是"没拿完"。
- `manifest` 字段快照不下发，只在单条详情 `GET /api/desktop-market/items/:type/:slug` 里
  （`desktop_market_client.go:231` 注释：*manifest 仍走单条详情接口按需取，快照不带*）。
  实测 `items/connector/tavily-search` 返回
  `{"mcpName":"tavily","server":{"command":"npx","args":["-y","tavily-mcp"]},"auth":{"mode":"token","inject":"env","key":"TAVILY_API_KEY","label":"Tavily API Key"}}`。
- 客户端三类都已鉴权可读（`TokenAuth`，sk- 令牌），`type` 参数在 items / categories / snapshot
  三个端点上都支持（`desktop_market_client.go:50/191/251`）。

### 客户端现状

- 目录 wire 早就是三分区：`CatalogType = 'expert' | 'skill' | 'connector'`（`market/wire.ts:11`），
  安装格式 `formatFor()` 给 expert / skill 各一种、connector 明确返 `undefined`（它没有归档）。
- 但界面只请求了专家：`MarketSection.tsx:153` 写死 `{ type: 'expert' }`，
  `Kind = 'all' | 'agent' | 'team'` 是专家内部的分段筛选。
- 安装器只实现了专家：`installPreset` 走 `writableRoot(agentPresets.roots)` + 暂存目录原子改名，
  专家自带技能被 re-root 到 preset 的 `skills/<slug>/`（`install.ts:451` 起）。

### 内核旋钮（都是本机验过的，不是读 schema 猜的）

| 需要什么 | 内核给的 | 证据 |
|---|---|---|
| 独立技能装哪 | `<dshHome>/skills`，用户根 rank 400；`watch: true` 活扫，缺目录算合法空态 | `dsh-skill-filesystem/README.md` 的 Discovery 表 |
| 装完要不要重启 | 不要。专家 preset 只**加**一个自己的 `skills/` 根，从不关 `includeDefaultRoots`（`compose.ts:56` 注释写明这是照上游 `cordis` preset 抄的，也是 WorkBuddy 的形状：一条会话列几十条技能，专家自带的只是其中几条） | 本机 `$DSH_HOME/skills` 目前**不存在**，所以这是新落点 |
| 连接器怎么落 | 一个 MCP server = 一行 `@deepseek-ai/dsh-mcp-client`，config 里 `transport/command/args/env` 或 `url/headers`；HMR 热换不重启进程 | `dsh-mcp-client/README.md` 的 Usage / Config 两节 |
| 运行时加一行 | `ctx.loader`（`Context.loader`，`Loader extends EntryTree`）有 `create(options,parent?,position?)` / `update` / `remove` / `import(name)` | `cordis-plugin-loader/lib/types/config/tree.d.ts:25-34` |
| 包能不能解析到 | **从档案目录能，从我们插件目录不能**：`$DSH_HOME/profiles/desktop` 下 `import('@deepseek-ai/dsh-mcp-client')` → `OK exports: Config,apply,inject,name`；在 `dsh/openlux-plugin-account` 下同一句 → `ERR_MODULE_NOT_FOUND` | 扁平回退目录 `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-mcp-client` 存在（`healProfilesModuleFallback` 的契约） |
| 静态兜底落点 | 档案补丁层 `$DSH_HOME/profiles/desktop/cordis.patch.yml`（本机是空的 `[]`），以及 home 层 `$DSH_HOME/cordis.patch.yml`（**可选层，解析不到的行会被跳过而不是炸**，`profile.ts:651` 的 `omitUnresolvedOptionalEntries`） | 层序：bundles → provider → profile → home（`profile.ts:696`） |

**这条最重要**：连接器一定要走 `ctx.get('loader').create()` 用**包名**挂，
不能在我们插件里 `import` mcp-client——后者在真机上是 `ERR_MODULE_NOT_FOUND`，
正是技能里记着的那个坑（仓外插件解析不到内核包的传递依赖）。

## 2. 设计

### 2.1 顶部三 tab，一个搜索框

`MarketOverlay` 的 header 下面加一条 tab 栏，`MarketSection` 从"专家画廊"升成"三分区画廊"：
`tab: 'expert' | 'skill' | 'connector'` 是**分区**（决定 `market.catalog` 请求哪一类、
分类 chips 取哪一套），专家 tab 内部保留现有 `Kind`（全部/专家/专家团）作为二级筛选。
搜索框 placeholder 随 tab 换（对齐 `unifiedMarket.search.*`）。右上角动作按钮随 tab 换。

三个分区共用的：搜索、分类 chips、卡片网格、详情弹窗、安装态（未装/装中/已装/被拒）。
不共用的只有"装到哪"和"装完能干什么"，所以安装器按分区分派，UI 一份。

### 2.2 技能 tab

- **列表**：`market.catalog { type: 'skill' }`，994 条，10 个分类 chips。描述用 `description_zh`
  （后台已翻译，实测 `pdf` 那条中英俱全）。
- **头像**：对齐 WorkBuddy 的 `SkillAvatar`——**有图用图、没图用确定性色块首字母**。
  它自带 10 色调色板（`AVATAR_PALETTE`，"01 樱粉 / 02 晴蓝 / … / 10 青柠"，每色带
  light/dark 的 bg+fg 两对，偏移 7500831），按名字取色，图加载失败再退回色块。
  我们照这个做：`icon` 有值就用（图床通道专家那侧已经在跑），空就色块。
  **不为了补图去给 994 条技能抓图**：上游参考实现自己就不给技能配图。
- **安装**：`skill-dir.tar.gz` 归档 → 解到 `$DSH_HOME/skills/<slug>/`。
  复用专家安装器那三条纪律：暂存点在同一个根内（`.openlux-staging-*`，点号前缀对 discovery 隐身）、
  原子 rename、装完复验。装完**不重启不刷新**就该能用（`watch: true`），验法见 §5。
- **「添加技能」= 本地导入**（WorkBuddy 的 `chatInput.addMenu.skill.addLocal: 从本地添加技能`
  与 `PersonalSkillImportModal` 同源）：选一个目录或 zip，校验含 `SKILL.md` 且 frontmatter 有
  `name` / `description`，装到同一个落点。目录选择器用内核的
  `dsh-host-directory-picker-native`（已在组合里）。

#### 名录预算：DSH 与旧壳不一样，但仍要克制

旧壳（openclaw）的教训是名录膨胀会被预算静默截断：135 条挤进去，超 18000 字符后内核降级成
「只有名字没有描述」还丢掉 39 条（`experts-and-teams.md` 的「技能随专家走」一节）。
**DSH 这侧没有那道总预算**：`dsh-tool-skill` 只有 `catalogDescriptionMaxLength`（默认 500，
单条描述截断），名录是"每条一行、全量渲染"，代价写在它自己的 README 里——
*Repeated input cost scales with skill count*，且**每次名录变化都会追加一条完整替换消息**。

所以结论是：不会静默坏掉，但会线性变贵。两条约束落进界面：

- 安装成功后显示当前生效技能条数，让用户对成本有感（WorkBuddy 一条会话是 65~67 条，可作参照）。
- 不做"一键装一批"，不做推荐批量安装。装什么是用户逐条决定的。

### 2.3 连接器 tab

- **列表**：`market.catalog { type: 'connector' }`（不带 format，否则整批被判"无制品"）。
  卡片状态照 `connectorPanel.*`：可用 / 已连接 / 连接中 / 连接错误。
- **连接**：点连接 → 取单条详情拿 `manifest` → `auth.mode === 'token'` 就弹
  「访问令牌 (Token)」→ 令牌写内核凭据库（`ctx.credentials`，ref 名 `OPENLUX_MCP_<slug>`），
  **不写明文进任何 yml** → 我们自己的状态文件记一行（slug、mcpName、启动参数、ref 名）→
  `ctx.get('loader').create({ name: '@deepseek-ai/dsh-mcp-client', config })` 挂上去。
  config 里的 env 值从凭据库解析后传入内存，不落盘。
- **断开**：`loader.remove(id)` + 状态置为未连接（令牌保留，重连不用再输；
  「解绑」才删凭据，对齐 `connectorPanel.reset/unbind`）。
- **重建**：插件启动时按状态文件逐条 `create`，失败只记日志不拦启动
  （形状与 home 补丁层的"解析不到就跳过"一致）。
- **自定义连接器**：一个表单，stdio（command / args / env）或 streamable-http（url / headers）
  二选一，`serverName` 按 `[A-Za-z0-9_-]{1,32}` 校验且不能与已连接的重名
  （重名内核会 loud 失败，我们提前拦）。
- **工具列表**：连上之后模型侧工具名是 `mcp__<serverName>__<rawName>`，
  详情弹窗里列出来（对齐 `connectorPanel.tools`）。

### 2.4 我的专家（子页，不是第四个 tab）

> **2026-08-24 更正**：本节原来写「两块：最近使用 + 已安装」，依据是 i18n 里的
> `myExperts.recent.hint`。解包核对组件后发现**那半在 WorkBuddy 根本没上线**——
> `my-experts-panel.tsx` 的 `MyExpertsPanel` 只渲染 `CreatedExpertsPanel` 一个孩子，
> 同目录的 `recent-experts-panel.tsx` 编译进来的 `init_recent_experts_panel` **函数体是空的**
> （只 require 依赖、不定义组件，已被 tree-shake），`myExperts.recent.*` / `subTab.recent`
> 在整个 renderer 里**只出现在语言包**，零消费者；`.ec-my-sub-tabs` 也只剩 CSS
> （`center-<hash>.css`）。这正是本技能记过的「语言包里有文案 ≠ 功能上线」那个坑，
> 判据必须落到「有没有组件消费它」。证据见 `dsh-kernel-migration.md` 同日一节。

整页切换 + 返回，**只有一块**：我创建的（`CreatedExpertsPanel`）。
它的「最近」不在这个页面，在**输入框模式选择器的「专家」二级菜单**里
（`最近召唤专家` + `召唤其它专家`，hover 展开）。

**管理动作一律不重做**：内核设置页第四栏「Agent 预设」已经有设为默认 / 查看 / 复制 /
打开目录 / 删除 / 坏档处置一整套（`dsh-client-ui-agent-preset`）。
`myExperts.created.*` 那套修改 / 分享 / 上架属于专家创作，见 §6 不做清单。

#### 2026-08-24 落地：照它上线的那一块重做了

三处改动，真机逐条验过（截图与探针在 `.tmp-wb3/`，不入库）：

- **页面换成「我创建的」**（`MyExperts.tsx`）。判据是两条，各有主人：`trust === 'user'`
  是内核区分「随部署出厂」与「本机作者写的」，`itemId` 是我们自己的——安装会在预设目录里
  写一份 `openlux-market.json`（`market/install.ts:PROVENANCE_FILE`），带这个标记的就是市场装的。
  两条都是现成的，协议一个字段没加。空态照抄它的四件套：图标 + 还没有创建任何专家 +
  创建属于你的专家… + 「+ 创建专家」。
- **创建走内核的创造模式**。WorkBuddy 的 `handleCreateExpert` 是 `goHome()` +
  `createExpertMode$.next({ defaultPrompt: undefined })`——落到一条空会话、**不预填提示词**。
  我们就是 `summon({ preset: 'cordis', prompt: '' })`：内核自带 `cordis`（创造模式，
  「用于创建自定义 Agent preset」），召唤链路本来就能接任何预设，没有新机制。
  真机结果：市场关掉、hero 挂上「创造模式」chip、输入框空着（占位词是内核自己的
  「描述你想要构建的内容」）。
- **最近召唤搬到输入框**（`ExpertQuickPick.tsx`），因为它在 WorkBuddy 就在那儿。
  我们没有模式选择器可挂（内核那个下拉是我们**故意**占空的），所以挂在
  `conversation.input.left`——文件按钮那一排，内核给常驻小控件的坐位。菜单形状照它的
  `ExpertSubmenu`：最近召唤标题 + 最多 3 条 + 分隔线 + 召唤其它专家。
  **没有最近专家时整个按钮不画**：它多出来的价值就是侧栏那颗「市场」给不了的东西，
  给不了就不该占位置。

这一版**不做**的三件，都记在这里免得下次又当成漏掉：专家团 tab（我们的名录里没有 team 标记，
建团还要一段自造提示词）、删除（内核那两个设置坐位是我们刻意占空的，见
`experts-and-teams.md` 第 47 条；但一旦真有人用创造模式造出专家，删除就成了没有主人的动作，
这是个**已知缺口**）、查看 / 修改 / 打开文件夹。

## 3. 后台补齐

1. **连接器导入器**（`service/desktop_market/import_connectors.go`，新增）：
   一批公认可用的 MCP server，按 `seed.go` 的 manifest 形状 upsert，
   分类扩成 开发工具 / 联网搜索 / 数据与文件 / 办公协作。候选来源以官方
   `modelcontextprotocol/servers` 与各家自家仓为准，逐条记许可与出处（跟技能导入同一纪律）。
   目标量级 20~30 条，够撑满一屏且每条都能真连上。
2. **技能 icon 通道（可选）**：`DesktopMarketItem.Icon` 字段已有，后台上传走
   `api_storage`（`AdminUploadFile`）。运营想给某条技能配图就配，客户端"有图用图"天然吃下。
   **不做批量抓图**。
3. **不动**：`translate_items.go` 已经支持三类；客户端端点已支持 `type`；制品必需类型
   （`DesktopArtifactRequiredTypes`）已经把连接器排除在外。

## 4. 分阶段

| 阶段 | 内容 | 阻塞它的前置验证 |
|---|---|---|
| 一 | 顶部 tab 框架 + 技能 tab（目录 / 色块头像 / 安装 / 本地导入） | 技能装进 `$DSH_HOME/skills` 后不重启就出现在 `/` 名录里 |
| 二 | 连接器 tab（目录 / 连接 / 断开 / 自定义 / 工具列表） | `ctx.get('loader').create()` 真能在运行时挂起 mcp-client 并出工具 |
| 三 | 我的专家子页 | 无（都是已有数据）。2026-08-24 已改成「我创建的」+ 创建走创造模式，最近召唤搬到输入框，见 §2.4 |
| 四 | 后台连接器导入器 | 每条候选都要能真连上再上架。2026-08-25 完成，19 条，见 §5.2 |

## 5. 验收判据（每条都要真机可复现）

- **技能装完即用**：装 `pdf` → `$DSH_HOME/skills/pdf/SKILL.md` 存在 → 不重启、不刷新，
  聊天框输入 `/` 能看到它 → 刷新一次仍在。（内核侧与客户端侧要**各验一次**，
  别拿一次重启把两层蒙过去——这条在 `openclaw-kernel.md` 里有前科。）
- **本地导入**：选一个自建目录（含合法 `SKILL.md`）能装；缺 frontmatter 的目录被明确拒绝并说明原因。
- **连接器连上**：连 `context7`（`auth.mode: none`，不用令牌）→ 详情里出现
  `mcp__context7__*` 工具名 → 模型侧真能调一次 → 断开后工具消失。
- **令牌不落盘**：连 `tavily-search` 后 `grep` 整个 `$DSH_HOME` 拿不到那串令牌明文
  （只在凭据库里，且凭据库是内核自己的形状）。
- **重启重建**：连两个连接器 → 重启应用 → 两个仍在已连接态、工具名不变。
- **专家侧零回归**：407 条目录、分类 chips、专家团筛选、安装、召唤全部照旧。
- **门**：`yarn test` / `typecheck` / `check:layout` 全绿；改动记档进本文件与
  `dsh-kernel-migration.md`。

## 5.1 阶段一：真机验完的结果（2026-08-24）

四条判据在跑着的桌面端上逐条过了，方法是 CDP 驱动真界面（脚本在 `.tmp-wb3/`，不入库）：

| 验的事 | 结果 |
|---|---|
| tab 框架 | 专家 / 技能两个 tab 都在，切到技能读回 994 条，搜索占位词与介绍文案随 tab 变 |
| 装一条 | 点「安装」→ 落到 `~/.dsh/skills/<slug>/`，卡片翻「已安装」并收起按钮，计数 +1 |
| 连装四条 | 四条全成，没有一次失败（见下面那条竞态） |
| 从本地添加 | 用 `Page.setInterceptFileChooserDialog` 绕开原生对话框喂一个目录进去，子目录 `references/` 一起进来，落点是**被选中的那个文件夹**而不是它的父目录 |
| 移除 | 目录真删掉，计数 -1，卡片退回「安装」 |
| 模型真看得见 | 已经开着的会话里再问一次，`skill-catalog` 注入里已经有刚装的 `page-deliver`，模型照着列了出来——**不用重启，也不用新开会话** |

### 撞出来的两件事，都改了

**一、`rename` 到技能根上会 EPERM。** 原本按惯例先写暂存目录再 `rename` 就位。技能根是
`dsh-skill-filesystem` 正在监视的目录，Windows 上另一个进程持着句柄时 `rename` 直接
`EPERM: operation not permitted` —— 同一段代码前两次成功、第三次失败，是典型的竞态。
改成**不 rename**：文件直接写进目标目录，`SKILL.md` 留到最后一个写。因为「是不是技能」这件事
就由那个文件决定，它出现之前监视方只看到一个普通文件夹，它出现时内容已经齐了。中途失败留下的是
一个没有 `SKILL.md` 的目录，本来也不是技能，而且会被删掉。顺带加了 `write-failed` 这个拒绝理由——
它是唯一一个「再点一次通常就好」的失败，不该混在「制品下载失败」里。

**二、`resolveDshHome` 在这台机器上有两份不同的构建。** `openlux-plugin-account` 自己那份
`@deepseek-ai/dsh-home-paths` 导出 `resolveDshHome`，`dsh-plugin-desktop` 下那份把它压成了 `n`。
类型检查看的是前者，运行时解析到后者就是 `undefined`。改用两边都导出的 `dshHomePath('skills')`，
`files/stage.ts` 早就是这么写的。

### 一条已知的、这期不修的偏差

技能名字在所有根之间唯一，rank 低的赢。专家自带的同名技能会顶掉用户自己装的那份，日志里是
`skill "wait-what" from user-dsh ignored because a higher-priority skill already exists`；
真机上模型列出来的清单里确实少了 `wait-what`，磁盘上却在。

计数行本来想报**内核合并去重之后**的数（`ctx.skills.list()`），试了：从插件自己的（无 scope）
上下文调它返回 **0 条**，而当时根里有 7 条、模型明明带着。注册表是按 agent scope 分层的，插件这层
看不到 provider。**读不准就不显示**——计数行退回报「已装 N 个技能」，措辞也从「生效」改成「已装」。
等有了 scope 能读的时候再换，那时候顺带把「这条被顶掉了」标到卡片上。

## 5.2 阶段四：连接器目录，19 条，每条都连过（2026-08-25）

代码在 `admin-server/service/desktop_market/import_connectors.go`，触发是
`IMPORT_CONNECTORS=1`（先探活再写）或 `=nocheck`（没有外网的私有化环境）。
`SEED_DESKTOP_MARKET` 调的是同一张表——目录只留一份，避免重蹈「自撰专家 vs 专家中心」
那次两张同名卡片的覆辙。

**上架门槛按 §4 的要求逐条兑现**，用的是桌面端自己那套 bridge，不是读文档挑的：

| 这一类 | 怎么验的 | 结果 |
|---|---|---|
| 免鉴权 5 条 | 真挂起来列工具 | deepwiki 3 / cloudflare-docs 2 / huggingface 4 / kdocs 258 / lingxing 59 |
| 在架的 3 条 stdio | 走 `npx` 真拉包起进程 | context7 2 / filesystem 14 / tavily 5，3.6~4.2 秒 |
| 网页授权 11 条 | 发现 + 动态注册 + PKCE + 生成授权地址，客户端元数据与线上逐字一致 | 全部 S256、scope 由 SDK 按 SEP-835 从资源元数据推出 |

最后那一下「用户点同意」代替不了，除此之外整条无人值守的半程都验过了。

**验完被剔掉的，各有各的原因**（都记进代码文件头，免得下一个人再试一遍）：

- **GitHub / Figma**：动态注册被拒（Figma 直接 `403 Forbidden`），要去对方后台预注册应用。
- **QQ 邮箱**：动态注册回 `redirect_uri does not match any trusted platform`——它不接受
  127.0.0.1 回环回调，而桌面端的回调只能是回环（RFC 8252）。
- **Asana / Atlassian / invideo**：端点走 sse，内核只收 stdio 与 streamable-http。
- **令牌拼在 URL 里的那类**（gildata、盈米）：manifest 的注入只做 header 与 env，
  没有 URL 模板替换，硬上会把 `${TOKEN}` 原样发出去。

**撞出来的一件事。** 目录重构时把 `mcpName` 一律写成「取 slug」，于是 `tavily-search` 的
命名空间从 `tavily` 变成 `tavily-search`。它不报错，只是让模型看到的工具全部改名，老会话里
那句「用 `mcp__tavily__tavily_search` 查一下」突然指向不存在的工具。修法是 `mcpName` 独立成
字段、缺省取 slug，在架的三条钉死；`TestShippedConnectorsKeepTheirNamespace` 把它钉住了
（去掉那行 pin 确认过测试转红）。

**一条已知的粗糙处。** 金山文档一条 258 个工具、领星 59 个，装上即全量进每个会话的工具列表。
bridge 的 `Config` 表里没有工具过滤这个旋钮（只有 transport / headers / 超时 / 重连），
参考产品是靠端点自家的 `?includeTools=` 查询参数解决的，那是各家服务端的功能、不通用。
按用户拍板先上架，真嫌吵就从目录里删掉它。

## 5.3 连接器不归类：分类 chips 撤掉（2026-08-25）

**参考产品的连接器列表没有分类。** 解包读它的界面串（`app.asar` 里那份压缩包，i18n 键
按前缀捞）：连接器那一屏只有搜索框与「自定义连接器」，一个分类名都没有；分类是我们阶段四
自己加的，19 条摊进 6 个类、每类两三条，chips 占掉一整行却几乎筛不掉什么。

**改的是服务端一处，界面一行没动。** 落库那行 `CategoryId` 恒为 0（`connectorItem()`），
`ensureConnectorCategories()` 整个删掉。界面自己就收了，因为两道守卫本来就在：
快照里的分类被 `visibleClientCategories`（`controller/desktop_market_client.go:172`）按
「至少挂着一个已上架条目」过滤，连接器一条都不挂 → `categories` 是空数组 →
`MarketSection` 的 `categories.length > 0` 不成立；详情页那格也有 `categoryName !== ''`。

**明确写 0，而不是「空值让位于已有值」。** `upsertItem` 对 `DescriptionZh` 是让位的
（免得重跑清掉翻译），照抄那个姿势的话，库里已经挂着 dev/search 的那三条永远不变，
这个决定在老库上就等于没生效。代价是运营若手动给连接器分过类会被重跑清掉——分类是我们
自己加的字段、不是运营的编排，认下它。留在库里的那两条空分类客户端已经看不见了，
要清是运营在管理端删。

**真机兑账**（本机 admin-server :3000 → 测试库 `jishu_test`，跑 `IMPORT_CONNECTORS=1`）：

| 验什么 | 结果 |
|---|---|
| 快照 | 连接器 19 条，全部 `category_id=0`；`categories` 从 2 条变 **0 条** |
| 连接器 tab（CDP 读 DOM） | 19 张卡，没有「全部分类」，6 个旧分类名一个不剩 |
| 别的 tab 没被连带 | 技能 994 张卡 chips 在（效率办公/数据处理/…），专家 407 张卡 chips 在（腾讯专区/…）+ 专家/专家团二级筛选也在 |
| Go 单测 | `TestConnectorsCarryNoCategory` 钉住落库那行的 0；`TestShippedConnectorManifestsAreUnchanged` 证明 manifest 逐字节没变（分类从来不在 manifest 里） |

## 5.4 会话里的推荐卡：`connector_offer`（2026-08-25）

代码在 `openlux-plugin-account/src/market/connector-offer.ts`，注册在 `index.ts` 的全局工具那一段，
测试 `dsh-plugin-desktop/tests/connector-offer.spec.ts` 12 条。

**参考产品的形状是解包读出来的**，不是照着截图猜的。`app.asar` 里那份 `src-*.js` 的 i18n 键
`tool.pluginRecommendation.*` 共 23 个，把它的卡拼全了：两种标题（推荐连接器 / 推荐专家）、
五个动作（连接 / 启用 / 应用 / 重试 / 跳过）、倒计时两句（`{seconds}s 后跳过`、`未操作，已跳过`）、
四个状态（连接中… / 已连接 / 启用中… / 连接失败），以及回给模型的几句结果
（`已连接 {names}`、`{names} 连接失败`、`已跳过，未启用连接器`）。**它是一个工具的结果视图**，
不是聊天流里的一段富文本——这一条决定了我们照哪层做。

**照内核已有的接缝做，没有自己造卡。** `ctx.userQuestions.ask()` 本来就是干这个的：工具调用挂起，
渲染层在输入框上方画一张面板，带选项、自由输入、「跳过本题」「提交」。内核自己的
`dsh-tool-ask-user` 就是这么用的（33 行，`inject: ['tools','userQuestions']`，
把 `exec.agent` 与 `exec.signal` 原样转给 `ask()`），我们照抄这个形状。
先在真机上用它兑过账再动手：让模型调 `ask_user_question`，面板起来、选一个提交、模型接着说
「你选择了「继续」」——整条链（工具 → 宿主服务 → 渲染层 provider → 答案回环）都是通的。

**复现了什么，没复现什么。** 行为全在：推荐 → 选或跳过 → 连上 → 用新工具继续；跳过之后模型自己
说「没有它我能做什么」。没有的是那张卡的排场：逐条的「连接中…」状态芯片，和走动的倒计时——
`dsh-user-questions` 的词汇只有问题表单这一种，认不出的 intent 会退回通用选项列表。
倒计时改成写进正文（「120 秒内没有选择就按跳过处理」），行为留住，只是不走动。

**只推能当场连上的那几条。** 19 条里 8 条免凭据，其余要粘贴令牌或走浏览器授权。授权这件事在
工具调用里做不完（授权流把地址交给渲染层去开浏览器），硬推的结果是卡片最后落到一句
「去市场里连吧」——那句话模型自己就会说，不需要一个工具。所以需凭据的先过滤掉，
除非它已经授权过。

**真机四轮，每轮都改出东西**（这一节的每条结论背后都有一次真跑）：

| 真机看到的 | 根因 | 改法 |
|---|---|---|
| 卡片说「目录里没有对得上的」，可金山文档明明在架 | 注册时传的是出图出片计费用的 `access`，而市场目录归 `marketAccess()`（当前钉在本地 TEMP 那对凭据上） | `index.ts` 改传 `marketAccess(ctx, baseUrl)` |
| 中文点名的服务一条都匹配不上 | 中文需求整段是一个 CJK 串，`name.includes(整句)` 恒假 | 加 `services` 入参让模型点名，再按名字的 2-gram 覆盖度反向匹配 |
| 点名了金山文档，还捎上 Cloudflare 文档、Context7 | 服务名跟**标签**也做了双向包含，「金山文档」含「文档」二字，于是所有带该标签的都算被点名 | 服务名只跟 name / slug 比；名字覆盖满 2 段才算点名，只碰 1 段（「文档」这种）降级为线索；有点名的行就把猜的全丢掉 |
| 每条候选在卡上出现两次 | 详情里列了一遍，选项行又列一遍 | 详情只留倒计时那句 |

**兑账的那一轮**（2026-08-25 05:28~05:42，本机 dev 构建）：模型自己判断该用这个工具
（推理里点名了它），卡片起来 → 选 DeepWiki → `openlux-connectors.json` 落盘正确
（streamable-http + `failOnStartupError`）→ 换个会话直接调 `mcp__deepwiki__ask_question`
拿到答案。跳过那条也跑过：工具回 `已跳过，未启用连接器`，模型接着给替代方案。
验完把 DeepWiki 断开、记录文件清掉，机器恢复原状。

**防它无声消失**：`scripts/verify-profile-boot.mjs` 的全局工具清单里加了 `connector_offer`。
它比别的多一条消失路径——只在 `userQuestions` 挂着的组合里注册，profile 的装配顺序一变就没了，
而且哪儿都不会报错。

## 5.5 技能页与连接器页对齐参考产品（2026-08-25）

用户给的判据是它那一页的截图：顶部三 tab + 搜索框 + 「我安装的 18」+ 「+ 添加技能」，
下面「精选技能」带换一换，卡片右上角一颗加号，装过的变对勾、悬停出「试一试」。

**头像:取一次，转存自己的图床。** 先把参考产品的做法挖出来了 —— 扫它 `~/.workbuddy` 下
908 份 json，凡是 icon / avatar / logo 这类键上的地址，宿主只有四个，全是它自己的：
`openplatform-cdn.codebuddy.cn`、`download.codebuddy.cn`、两个腾讯云 COS 桶
（`codebuddy-platform-1258344699` / `acc-1258344699`），专家头像还是相对路径
`/avatars/X.png` 拼它自己的 base。**一条指向 GitHub 或品牌官网的都没有。**
（`cdn-yb.icon.qq.com/zuowei_dir/<域名>.ico` 出现在会话 trace 里，那是联网搜索结果的站点图标，
不是货架。）所以我们照同一条:

- 连接器 → **先读首页声明的 `<link rel="...icon">`**（按声明尺寸从大到小；没写尺寸的按 64
  看待、没写尺寸的 apple-touch-icon 按 180 看待，不能按 0 排到最后 —— 没标尺寸的往往就是主图），
  都不成再试 `apple-touch-icon.png` / `favicon.ico` 这几个惯例路径。第一个「能用」的转存到图床。
- 技能 → GitHub 作者头像（`github.com/<owner>.png`，个人与组织都成立，不用 token），
  一轮导入里每个作者只取一次。参考产品那边是每条技能一张作者上传的 SVG（它的
  `_skillhub_meta.json` 里的 `iconSource`），我们的技能来自开源仓库、根本没有配图，
  按作者给是能拿到的最接近的东西：同一批出品方在一页里一眼能认出来。
- 随包技能（占技能货架三分之二，998 条里 655 条）→ **带它来的那位专家的头像**。它们自己不带图，
  全画字母块的话整页认不出谁是谁，而挂专家那张脸顺带答了「这条是跟谁一起来的」。
  规则在 `import_expert_center.go` 的 `bundleSkillIcon()`；已在库的那几百条用
  `BACKFILL_BUNDLE_SKILL_ICONS=1` 补（只读 manifest、只写 icon 那一格，可重复跑）——
  专家中心导入是最重的一个，为补一张图重跑全量不划算。
- 「能用」按魔数判，不看 Content-Type 也不看后缀，两边都撒谎：favicon 路径在单页应用上常回
  一份 HTML 首页带 200（信 Content-Type 就把网页存成头像，卡片上是个碎图标，这种缺陷没人会报）；
  反过来 `context7.com/favicon.ico`、`mokahr.com/.../favicon.ico` 回的其实是 PNG 字节。
- **ICO 不能直接传，要把里面那帧 PNG 抠出来。** 第一次真跑才知道：15 条拿着 `.ico` 去传，
  图床全回 `400 不支持的文件类型: image/x-icon`（白名单在图床那边，不是我们的代码）。
  现代 favicon.ico 多数是 PNG 套壳，按 ICO 目录抠出最大那一帧当 PNG 传即可，不用解码 ——
  Hugging Face 那份 43KB 的图就是这么救回来的。整份都是 BMP 编码的老式 ICO 放弃，
  为它引一个图像解码库不值。
- 幂等：库里那格非空就一张也不重传（`storedIcon()`），`upsertItem` 里让空值让位于已有值。
  图床文件名带纳秒戳，无脑每轮都传等于每次重跑改写全站 icon，把客户端目录缓存打掉一次。

代码 `admin-server/service/desktop_market/brand_icon.go`，测试 `brand_icon_test.go`
（魔数判据 8 例、ICO 拆帧含越界不 panic、link 排序、图床没配时不去打别人的站）。

**真机结果（2026-08-25 在 jishu_test 上跑完三条导入）：** 专家 407/407、技能 994/998、
连接器 13/19 有图，客户端上 995 张图全部 load 成功、0 张碎图。取不到的 6 条里 5 条
（canva / grafana / lingxing / sentry / stripe）只发 BMP 编码的 ico，1 条（kdocs.cn）从裸域
跳登录页、一个 icon link 都不声明；剩 4 条技能是 seed 里的本地技能，本来就没有出品方。
这几条现在可以在管理端那一格手填地址。

**顺手补的两个洞：**

- 管理端保存会把图冲掉。`UpdateAdminDesktopMarketItem` 无条件 `existing.Icon = req.Icon`，
  而技能页与连接器页的表单根本不发这个字段 —— 运营在后台改一行名字就把刚转存的图清空，
  没有任何提示，要等下一次跑导入才补回来。请求体的 `Icon` 改成 `*string`，把「这次没提」
  和「要清空」分开（测试 `desktop_market_admin_test.go`），三个表单都加了「图标地址」一格
  并且总是带值上报（含空串=清空）。
- 精选带与网格头三张重复。目录是精选在前，于是精选带那三张也是网格的头三张，同样的卡片
  紧挨着出现两次，看起来像渲染故障。`MarketSection` 里网格改成 `shown` 减去精选带那几个
  slug（`grid`），「换一换」把某张换下去，它立刻回到网格里。

**精选口径。** 连接器 4 条、技能 5 条，全是人挑的：只给「点一下就能用」的
（要粘令牌、要网页授权的一律不进 —— 精选位推一条点开还要去别处办手续的，这个位置就白占了）。
技能那 5 条是 `xlsx / docx / pptx / pdf / skill-creator`：上游几百条里绝大多数是给写代码的人用的，
按 star 或更新时间自动挑只会把一整条 devops 推到最前面。`upsertItem` 里精选**只升不降**，
运营在管理端手挑的位不会被下一次重跑抹掉。

**没做「推荐 / SkillHub / 套件」这三个子页签。** 参考产品有，我们没有对应的数据：
我们的技能全部来自 6 个开源仓库，就是它的 SkillHub 那一档；「套件」是多技能打包，我们一条都没有。
做出来会是一个真页签配两个空页签，比没有更糟。它那一行承担的分流由分类 chips + 精选带 +
「我安装的」接住了。

**其余对齐项**（`MarketCard.tsx` / `MarketSection.tsx` / `MarketDialogs.tsx`）：
右上角一颗方按钮承担全部状态（加号 / 转圈 / 对勾 / 悬停出播放），装过的卡片底部不再重复写
「已安装」——对勾已经说过一遍了；「添加技能」变成菜单（查找技能聚焦搜索框 / 创建技能带提示词开会话 /
从本地添加）；「我安装的 N」挪到搜索框右边（它回答的是「哪些是我的」，跟分类不是一类问题）；
搜索框用 `size={44}` 撑宽 —— 那个 primitive 的外层是 `flex: 0 1 auto` 且不收 style，
只有 `size` 这个原生属性能改它的固有宽度，而且窄下来还能自己缩。
详情页按 `kind` 分别说「技能 / 连接器」，连接器的页脚说「已连接」而不是「已安装」。
切页签时清掉详情弹窗：不清的话弹窗会带着上一个页签的内容，用新页签的 `kind` 去渲染。

**连接器那两个数字**：右上角筛选数的是记录在册的（3），正文数的是这次启动真挂上的（2）。
两个数并排出现时小的那个必须自己解释清楚，正文因此改成「这次启动挂上了 2 个」。

**撤掉了「行状态」那一套。** 上一轮为「挂上了但缺凭证」加过 `tools/result` 观察者
（`connector-watch.ts`）与 `refusing` 状态，卡片上会多一个「用不了」。用户判定不要这个：
提醒贴令牌就够了。观察者、字段、文案一并删掉，回到两种说法 ——
没挂上叫「未连上」，需要凭证的在连接时就问你要。

**要在服务端跑三条导入才看得见图与精选**（都幂等，重跑不重传图）：

1. `IMPORT_CONNECTORS=1` —— 改了 kdocs / lingxing 的鉴权模式，加了 site 与精选。约 2 分钟。
2. `IMPORT_SKILL_REPOS=1` —— 开源技能的作者头像与 5 条精选。约 5 分钟。
3. `BACKFILL_BUNDLE_SKILL_ICONS=1` —— 已在库的随包技能继承专家头像。约 2 分钟。

第 3 条只对存量有必要：这之后新导入的随包技能自己就带头像了。

## 5.6 管理端十个叶子合成四个（2026-08-25 真机走过）

用户原话是「我感觉改个设置要切好多个页面」。侧栏「云雾桌面端」下原先摆着十条：
技能 / 连接器 / 专家 / 精选场景 / 实践案例 / 首页场景 / 分类管理 / 模型参数 / 模型下发 / 用户反馈。
而这十件事只有四组独立的上下文，其余全是同一件事被切开摆着：

| 新叶子 | 页签 | 合的理由 |
|---|---|---|
| 市场 `/desktop-market` | 专家 / 技能 / 连接器 / 分类 | 同一组接口（`/desktop-market/admin/items`，只差 `type=`），三个条目页有 73~85% 的行逐字相同；改一个条目的分类原先要切去分类页看有哪些 chip |
| 首页与场景 `/desktop-scenes` | 首页场景 / 精选场景 / 实践案例 | 案例**必须**挂一个首页场景（`scene_slug`），编一条案例原先要切过去抄 slug；后两者本来就是同一张表按 `kind` 分的两种形状 |
| 模型 `/desktop-models` | 模型下发 / 模型参数 | 清单与能力是一件事的两半，而**下发总开关原先长在参数页顶上** —— 想停下发得先想起它不在下发页 |
| 用户反馈 | — | 与上面三组没有交集，保持单页 |

**页签键就是旧路径的最后一段**（`/desktop-market/skills` → `skills`），所以运营存的书签、
群里转过的链接原样可用，落地时只是多了几个兄弟页签；另外五条改了形状的旧路径
（`scenarios` / `playbooks` / `scenes` / `desktop-model-profiles` / `desktop-delivered-models`）
在路由里用 `loader: () => redirect(...)` 送到对应页签。侧栏高亮与面包屑不用改：
`NavMenu` 认的是 `pathname === path || startsWith(path + '/')`，叶子 path 写到壳的根就行。

三条实现纪律，都是踩着才定的：

- **只挂活着那一个页签**（`children` 对非当前页签给 `null`）。条目页一挂就发列表请求，
  四个一起挂等于每次进这一页打四趟接口，模型参数那页还会各自跑一遍探活。
- **`replace` 分两种用法**。点页签是用户的导航，进历史（返回键退回上一个页签）；
  而「补全默认页签」那一下必须 `replace` —— 否则 `/desktop-market` 留一条历史，
  返回过去又被立刻改写回来，返回键看着像失灵。
- **子页自带的标题要摘掉**。模型下发页原先有自己的 `title="桌面端模型下发"`，
  套进壳里就是「模型 / 模型下发 / 桌面端模型下发」叠三层；状态胶囊（已配置、最近下发）留着，
  那是读数不是标题。外层页签用线条款、子页里那层用卡片款，两级才分得开。

真机读数（Vite :3002 + 本地 admin-server :3000，CDP 点过一遍）：侧栏该组 4 条
（市场 / 首页与场景 / 模型 / 用户反馈）；`/desktop-market/skills` 落到「技能」页签、
`/desktop-market/scenarios` → `/desktop-scenes/featured`、`/desktop-model-profiles` →
`/desktop-models/profiles`；四个市场页签逐个点过，每次**已渲染的页签面板恒为 1**、
表格 10 行、侧栏高亮停在「市场」；场景三档的列各不相同（精选有「关联专家」、
案例有「归属首页场景 / 产物」，117 条），证明共用组件的 `kind` 没串；
连点两个页签后按两次返回键依次退回上一个页签，标题不叠、`page-hero__title` 恒为 1 个。

## 5.7 待做：专家与专家团详情里的「使用案例」（2026-08-25 查清形状，未落地）

用户指出参考产品的专家详情、专家团详情里都有「使用案例」，我们要照做。查它的实现
（`expert-picker-*.js` 的 i18n + `use-inspiration-share-code-receiver-*.js` 里的组件原文）
得到的形状，落地时照这个来：

| 它怎么做 | 我们这侧对应 |
|---|---|
| 关联关系记在**案例**身上：案例带 `experts: [{id, expert_id}]` 数组 | `desktop_scenarios` 已有 `expert_slug` / `member_slugs`（专家 slug 数组），**不用改表** |
| 详情里用专家的 `marketExpertId / id / sourceId / agentName / plugin` 逐个去撞那个数组，命中即算 | 按专家 slug 撞 `expert_slug` / `member_slugs` |
| 排序 `is_featured → featured_order → sort_order → quality_score↓ → usage_count↓`，**取前 3**（`MAX_RELATED_CASES = 3`）| 我们只有 `sort_order`，按 `sort_order asc, id asc` 取前 3 |
| 卡片：封面图 + 标题 + 副标题，图挂了画占位块，`loading="lazy"` | 案例已有 `cover` / `title` / `subtitle` |
| 点卡片在**同一个弹窗里**换页看案例，左上角「返回」回专家（`caseBackToExpert`）| 我们的案例弹窗已有预览能力，接一层返回即可 |
| 组件在 `team-detail/expert-related-cases.tsx`，**专家与专家团共用一个**，差别只是标题「专家帮你做」/「团队帮你做」 | 同一个组件按 `is_team` 换标题 |
| 案例实体就是 playbook（埋点 `type: "playbook_case"`、`resolvePlaybookAssetUrl`）| 就是我们的 `kind=playbook` 那一档，不是另一种东西 |

**所以要动的只有两处**：管理端「实践案例」这一档把「关联专家」字段打开（现在只有精选场景那档有），
客户端专家详情加一段按 slug 反查的「使用案例」。判据取 `scene_slug` 空/非空这件事不受影响 ——
`desktop_scenario.go` 的注释当初就写明选它是为了「将来不一样的那天仍然对」，案例挂上专家之后
两种形状照旧分得开。

## 5.8 管理端技能页的「随包 / 独立」两档（2026-08-25 真机走过）

§5.5 把随包技能从客户端货架上摘掉之后，管理端成了**唯一**看得见它们的地方，而那一页当时
既没有开关也没有标记：翻页翻到的十条里九条是零件，真正上架的那 343 条反而找不着；更坏的是
零件行的状态列写着「已上架」——它的 `status` 确实是 visible（专家装机要拿 slug 签下载链，
改成隐藏会让专家装不齐零件），但客户端根本不列它，只写「已上架」是句假话。

照本仓现成的那条先例做，没有新发明：专家页的「专家 / 专家团」也是同表同 type 靠一个布尔列
分家，它的三态解析 + 工具栏 `Segmented` 原样搬过来即可。落地三处：

| 处 | 改动 |
|---|---|
| `model/desktop_market_item.go` | `GetDesktopMarketItemsPaged` 加 `bundled *bool`，非空才过滤 |
| `controller/desktop_market_admin.go` | `parseIsTeamQuery` 泛化成 `parseTriStateQuery`（两处共用），加 `bundled` 查询参数 |
| `admin-cloud` 技能页 | `Segmented`（全部 / 独立技能 / 随包零件）+ 名称列「随包」徽标 + 状态列补一行「不上货架」 |

客户端那条调用显式传 `nil, nil` 并写明理由：`onlyVisible=true` 自带货架口径（已上架 + 非随包），
随包压根不进这条口。**两个相邻的 `*bool` 位置参数是这次唯一的手雷**，所以单测钉的是三态解析
本身——「留空」和「显式 false」塌成一件事的方向是不出声的那一侧（默认档会静悄悄只剩 348 条）。

真机读数（新编的 dev 二进制 + Vite :3002，CDP 读 DOM）：三档条数与库里逐个对齐 ——
全部 1007 / 独立技能 348 / 随包零件 659；随包那一页十行**每行**都带「随包」徽标与「不上货架」，
独立那一页十行一个都没有。

顺带一条工程细节：`go test ./controller/` 会被存量的 `invite_channel_export.go:55`
（`non-constant format string`）挡在 vet 阶段，跑本包的测试要 `-vet=off`，那条报错与本次无关。

## 5.9 复验：服务端摘掉货架之后，专家照旧装得齐零件（2026-08-25 真机）

这是 §5.5 留下的那条尾巴。判据要落到磁盘，不是界面上的「已装」。

对象取 `sales-coach`（销售教练，manifest 里 6 条随包技能，六条在库里全是
`bundled=1 status=1` —— 正是「不上货架但仍要能装」这个组合）。桌面端的市场仍钉在
`localhost:3000`（`openlux-plugin-account/src/index.ts` 的 `TEMP_MARKET`），所以走的就是
刚编出来的那份服务端。

| 看什么 | 读数 |
|---|---|
| 客户端技能货架 | `[data-testid^=openlux-market-card-]` **343 张**，与库里 `status=1 AND bundled=0` 的 343 一致 |
| 六条随包 slug 在不在货架上 | 一张都不在 |
| 安装 | 卡片按钮是「召唤」→ 点开确认框（写盘要用户点头，路径 `C:\Users\000\.dsh\.agent-presets\sales-coach`）→「准备中」→ 市场关闭并落进会话 |
| 磁盘 | `sales-coach/skills/` 下 6 个目录：`anti-distill` / `business-case` / `call-debrief` / `competitive-brief` / `deal-strategy` / `prepare-meeting`，**每个都有 `SKILL.md`** |

**踩到一次，值得记住**：只点卡片上的「召唤」什么都不会发生——写盘前有一道
`MarketConfirm`（`openlux-market-confirm`），脚本驱动时容易把「确认框在等着」误读成
「点击没生效」。CDP 里驱动安装必须点两下。

## 6. 明确不做

- 不并入插件市场（理由见 §0）。
- 不重做已装专家的管理（内核自带一整套）。
- ~~不做 OAuth 连接器~~ —— 已经做了（见 §5.2 与 `market/connector-oauth.ts`）。
  当初的判断「WorkBuddy 那批是腾讯自家服务」是错的：82 条里指向的是各家公开端点，
  60 条要 OAuth，其中大多数支持动态注册，不需要我们去逐家申请 client_id。
- 不做专家创作与上架（`myExperts.created.*` 的创建 / 修改 / 分享 / 上架）：
  创作要一套编辑器 + 一条后台投稿通道，是独立一期。
- ~~不给 994 条技能批量抓图（上游参考实现自己就不给技能配图）~~ —— 这条判断是错的，
  已经推翻：参考产品每条技能都有图（作者上传的 SVG，存它自己的 COS 桶）。
  现在按作者给图，转存我们图床，见 §5.5。
- 不给单条技能配单独的图。要做就得有一条投稿通道让作者上传，而我们的技能是从开源仓库抓的，
  上游没有这个字段。
