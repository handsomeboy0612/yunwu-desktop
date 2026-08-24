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

## 6. 明确不做

- 不并入插件市场（理由见 §0）。
- 不重做已装专家的管理（内核自带一整套）。
- ~~不做 OAuth 连接器~~ —— 已经做了（见 §5.2 与 `market/connector-oauth.ts`）。
  当初的判断「WorkBuddy 那批是腾讯自家服务」是错的：82 条里指向的是各家公开端点，
  60 条要 OAuth，其中大多数支持动态注册，不需要我们去逐家申请 client_id。
- 不做专家创作与上架（`myExperts.created.*` 的创建 / 修改 / 分享 / 上架）：
  创作要一套编辑器 + 一条后台投稿通道，是独立一期。
- 不给 994 条技能批量抓图（上游参考实现自己就不给技能配图）。
