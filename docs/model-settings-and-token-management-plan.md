# 模型设置页做减法 + 令牌管理（方案 A / 方案 B）

> 状态：**方案 A 已落代码**（2026-08-25）。host/RPC、令牌设置页、模型页快速切换和两份 DSH
> 补丁均已接入；类型检查、补丁重装和自动化测试已通过，真机界面复验进行中。效果图见
> `C:\Users\000\.cursor\projects\d-work-yunwu-jihe\canvases\model-settings-token-mockup.canvas.tsx`
> （顶部可切 A / B 两版）。
>
> **本文档第一到八节是方案 A**（模型页放一个令牌切换器 + 令牌独立成设置页），原样保留。
> **第九节是方案 B**：同样解决那三件事，但结构完全不同——模型页的补丁只删不加，令牌管理做成我们
> 自己的整屏面板。两版的取舍对照在第九节末尾。

## 一、要解决的三件事

1. 「OpenLux」那一行上的**「自定义」标签**去掉——我们就是官方，源码在自己手里。
2. **显示名称 / API 地址 / API 密钥**三个输入框不该存在。密钥那一格改成**令牌切换**：中转站是我们自己的
   源码，令牌有现成接口。
3. 新增**令牌管理**：智能路由四档可选，也可以关掉智能路由自己挑渠道分组。

## 二、动手前查了什么（每条都带出处）

### 内核侧（`@deepseek-ai/dsh-*`，随包交付的未压缩 `lib/` 与 `README.zh.md`）

| 事实 | 出处 |
|---|---|
| **「自定义」标签跟随 pi-ai 的「已安装 catalog」，不是设置文档** ——「当目录条目表明拥有该路由的适配器在这个键下什么都没有时，该行会带上 **自定义** 标签……存了 profile 并不使一条路由成为自定义」 | `dsh-client-ui-settings-models/README.zh.md`；渲染处 `lib/client.js:2057`（`row.entry.declared === true` → `t("customTag")`） |
| 那个 `declared` 由适配器直接给出，含义是「pi-ai 在这个键下是否什么都没有」。`openlux` 不是 pi-ai 认识的厂商，所以**改配置改不掉这个标签** | `dsh-llm-pi-ai/README.zh.md`「每个条目都带上 `declared`……由目录直接给出答案，而不是留给界面去猜」 |
| **显示名称那一格的开关就是同一个 `declared`**：`ownsIdentity = family === "pi-ai" && props.declared === true`，只有它 gate 住 `customDisplayName` | `dsh-client-ui-settings-models/lib/client.js:1644`、字段处 `:1701` |
| **API 协议那一格已经被我们的补丁放宽过**：`canCustomizeApi = ownsIdentity \|\| baseURLOverridden`（`baseURLOverridden = schema.hasPath(draft, ["baseURL"])`，只看用户层） | 补丁第 276-290 行；现文件 `:1646` / 字段处 `:1735` |
| **API 地址那一格谁都没 gate，是无条件渲染的** ——所以「关掉 `ownsIdentity` 就三格全没」是错的，它得单独加判据 | `lib/client.js:1718-1734` |
| `declared` 只有两个消费点：`targetOf()` 往编辑器传，和行头打标签。两处都在 `state.namespaces.get(target.settingsNs)` 之后，**base 层当场可查**（`namespace.base` 的用法见 `:1710`） | `:1891`、`:2057`、`:2026` |
| 内核自己说得很清楚：**内置目录路由这两格都不给**——「它的名称由目录条目兜底，它的每个模型各自带着自己的协议」 | `dsh-client-ui-settings-models/README.zh.md` |
| API 地址（`baseURL`）两个家族都放在「自定义设置」折叠区里 | 同上 README |
| **API 密钥这一格现在已经是只读的**：本机 `OPENLUX_API_KEY` 来自启动环境，`credentials.describe` 回 `writable:false`，占位符换成「由启动环境提供（只读）」 | `lib/client.js:1627`（`keyLocked = keyState?.writable === false`）、`:1652`、文案 `:2760` |
| **这个页面里内核没有留任何 slot**。settings 域只声明 `settings.trigger` / `header` / `close` / `action` / `section` / `plugins.tab` / `onboarding` | `dsh-client-ui-settings/README.zh.md`；全仓 `rg "settings\.[a-z]"` 命中只有这几个 |
| ~~设置面板没有跨页跳转 API~~ **有，只是没传给我们这一格。** 外壳里 `openSection(id)` 是现成的（`setActiveId` + `setOpen`），而且已经交给 `settings.onboarding` 用了；`settings.section` 那一格拿到的却只有 `{ close }` | `dsh-client-ui-settings-general/lib/client.js:192-195`（定义）、`:233`（onboarding 拿到了）、`:172`（section 只有 close）|
| 面板内换页只需要 `onSelect(id)`——就是左侧导航格 `onClick` 调的那个，`SettingsPanel` 作用域里现成 | 同上 `:145`、`:225` |
| **这个包我们已经在打补丁了**（2 处：给账户页加导航图标、导航从 `entries()` 改 `entriesOfSlot()` 并滤掉空标签），加一处转发是第三个 hunk，不是新开补丁 | `dsh/patches/dsh-client-ui-settings-general@0.1.1-rc.2.patch` |
| 这一页选东西**只有一种做法：原生 `<select class="input selectInput">`**，全页三处都是它（模型行的协议、API 协议、添加提供方的休眠路由选择）。没有任何浮层/下拉组件 | `dsh-client-ui-settings-models/lib/client.js:1354,1741,2123` |
| 行内按钮也是现成的三档：`linkButton`（h28 / r14 / 12px / tertiary / 无边框）、`addModelButton`（同尺寸但带 1px 边框）、`iconButton`（28×28 / r6）；`.input` 是 h32 / r8 / padding 0 10 / 14px，`selectInput` 额外带一个内联 SVG 箭头（right 12px、12×12、padding-right 32） | 同包 `lib/client.js:58` 那条内联 CSS；取值写个 `.cjs` 探针正则匹配 `\.[A-Za-z0-9]+_<类名>\{[^}]*\}`，**别用 `node -e`**（PowerShell 会吃掉反斜杠，静默返回空） |
| 列表 slot 按 id 定位单元格，**同 id + 更低 priority 就能占位**——我们已经在用这一招压掉了内核的专家预设页 | `openlux-plugin-account/src/client/HiddenPresetSeats.tsx:13-17`（id `agent-presets`，priority `-1`） |
| 模型页的 section id 是 `models`，order `10`；账户页是我们的 `openlux-account-section`，order `-10` | `dsh-client-ui-settings-models/lib/client.js:2917-2923`；`AccountSection.tsx:62,68` |
| 设置面板尺寸：面板 800×min(800, 100vh-48)，左侧导航 188px、导航项高 40 / 圆角 12，内容区 `padding:0 24px 24px`，模型分区 `max-width:720` | `dsh-client-ui-settings-general/lib/client.js:28`；`dsh-client-ui-settings-models/lib/client.js:58` |
| **这个包我们已经有补丁**（39KB，5 处语义改动：下发行只读 + 「官方」标、候选框搜索/只看已选/计数、`fetchAdopt` 改主按钮、`canCustomizeApi` 放宽、内测声明不注册） | `dsh/patches/dsh-client-ui-settings-models@0.1.1-rc.2.patch` |
| 我们的路由 profile 由**组合面**提供（不是用户层）：`llm-pi-ai.providers.openlux` 的 `displayName` / `api` / `baseURL` / `apiKeyEnv` 全写在组合行里 | `dsh-plugin-desktop/cordis.patch.yml:125-154` |
| 换令牌就是 `credentials.set(OPENLUX_API_KEY, 'sk-…')`——登录时走的就是这条路，生产在跑 | `openlux-plugin-account/src/index.ts:75,786,904` |
| 模型清单由账号插件按启动写进 `providers.openlux.models`，下发行带 `openluxManaged` 标记 | `openlux-plugin-account/src/models/sync.ts:400`；标记判据在补丁里 `isManaged()` |

### 中转站侧（`new-yunwu-api`，我们自己的源码）

| 事实 | 出处 |
|---|---|
| 智能路由合法值：`""` / `auto` / `price` / `speed` / `success_rate`。空串=关闭 | `controller/token.go:15-21` |
| **关闭智能路由时必须至少选一个分组**（后端与前端各有一道） | `controller/token.go:45-47`；`web/src/pages/Token/EditToken.js:1427-1431` |
| 四档的文案与副标题（照搬控制台，不另起一套） | `EditToken.js:179-218` |
| 表单初值就是 `auto`；开关关掉即写空串 | `EditToken.js:787,242` |
| **改令牌要用 `PUT /api/token/batch` + `update_fields`**；`PUT /api/token/` 是整份字段覆盖，只发几个字段会清掉用户在控制台设的模型限制和 IP 白名单 | `controller/token.go:248` 起 vs `:360-420`；桌面端 `account/auth.ts:184-188` 早就记了这个坑 |
| 列表 / 新建：`GET|POST /api/token/`，鉴权 `UserAuthOrApiKey`；桌面端拿会话 cookie + `New-Api-User` 头调，生产天天在跑 | `router/api-router.go:505-518`；`account/auth.ts:203-256` |
| 分组候选：`GET /api/user/self/groups` → `{data:{分组名→显示名}, ratios, group_ids, availability, current_group}`，且**与模型广场 `/api/pricing_new` 同口径**（倍率叠代理 markup、别名优先） | `controller/group.go:60-133`；`router/api-router.go:328` |
| 「智能路由非空即把候选分组扩展到用户组全部可访问且配了倍率的分组」，令牌原先绑的分组就此失效 | `middleware/distributor.go:307-323` |
| **换令牌会改变可用模型**：下发接口按这把令牌可达分组过滤后才回清单 | `controller/desktop_delivered_model_client.go:118-139`（`callableModelSet(c)`） |
| `tokens` 表真实有的列：`key/status/name/expired_time/remain_quota/unlimited_quota/used_quota/group/group_ids/routing_priority/model_limits*/allow_ips/accessed_time` | 线上库 `describe_table tokens`（20 列） |

### 产品侧（界面照的是 WorkBuddy，所以先问它怎么做）

解包 `D:\workbuddy\resources\app.asar`，把 `settings.models.*` 整本字典（96 条）拉出来看：

| 它的做法 | 键 |
|---|---|
| **那一页根本不叫「模型」，叫「自定义模型」**，副标题是「管理写入到 `~/.codebuddy/models.json` 的本地自定义模型配置」 | `settings.models.title` / `subtitle` |
| 空态是「**还没有配置自定义模型**」——它自家的官方模型压根不在这一页，账号给了就有，**任何地方都没有密钥格子** | `settings.models.empty.title` / `empty.description` |
| 接口地址 / API Key / 模型名称全在「**添加模型**」弹窗里，不铺在页面上 | `settings.models.modal.addTitle`、`fields.endpoint`、`fields.apiKey`、`fields.modelId` |
| 「自定义」在它这儿是**用户自建条目的分组标题**，不是官方那一行的徽标；另有 `Token Plan` / `Coding Plan` / `自定义 API` 等分组 | `settings.models.providerGroups.{custom,tokenPlan,codingPlan,customApi}` |
| 入口是**模型选择器底部的「配置自定义模型」**，不是一个你会落进去的设置页 | `settings.models.selector.footerAction` |

**结论（结果对齐，不是形式对齐）**：WorkBuddy 从不为自家服务展示身份/凭据表单，官方模型就是「有」；密钥表单只为用户自带的服务存在；「自定义」是给用户自建条目的分组名。用户提的
1、2 两条，正好就是把我们这一页搬到这个形状上。第 3 条（令牌）它没有对应物——它的账号只有一把隐式凭据，
而我们的中转站把额度、分组、有效期都挂在令牌上，所以这一层是我们自己的。

**它的「表单进弹窗」这一条我们没照抄**，理由和证据写在第五节末尾那小节：那是它的**新建**流程
（列表里还没有行可展开），而我们要做的是就地改一把已有令牌；同一个设置面板里的邻居是内核的模型页，
而内核这一页全程无弹窗、编辑器就长在行卡里。判据是结果，不是形式。

## 三、三条被查出来的硬边界

1. **「自定义」标签和那三个格子都没有配置旋钮可关**——标签与显示名称/API 协议的判据来自 pi-ai 的
   已安装 catalog（不是 `settings.yaml`），API 地址那一格更是无条件渲染。要改只有两条路：改 pi-ai
   的 catalog（等于替上游维护一份厂商目录，不干）或改我们已经拥有的那份补丁。
2. **模型页里没有 slot**，所以「往内核那张卡里塞一行令牌」这件事，只能靠补丁或整页接管，没有第三条路。
3. ~~设置面板不能从一页跳到另一页。~~ **2026-08-25 更正：这条是我查漏了。** 外壳里
   `openSection` 是现成的，`settings.onboarding` 已经在用，只是没转发给 `settings.section`。
   转发它是 `settings-general` 那份**已有补丁**的第三个 hunk（一个多传的 prop），所以「管理」
   真的能跳到令牌页。这正是路由层那条「看到一个写死的常量先别当墙」的又一次现形——上一版方案
   因为这条误判，差点把「管理」做成一句干巴巴的文字提示。

## 四、方案：分三层，各归各家

### 第一层 模型页做减法 —— 改现有补丁，不新增机制

全在 `patches/dsh-client-ui-settings-models@0.1.1-rc.2.patch` 里。**只加一个判据，用在三个地方，再加一处替换。**

判据叫 `isManagedRoute(namespace, settingsPath)`：`schema.getPath(namespace.base, settingsPath)` 有值
即为真——「这条路由的 profile 是组合面给的，不是用户手填的」。**不写死 route 名**，以后再加一条自营
路由不用回来改第二次。`namespace.base` 在两个 `declared` 消费点的作用域里都拿得到（`:2026` 先取的
namespace，`:1710` 已经在这么用），所以这个判据不需要新开数据通路。

| # | 改什么 | 落点 | 怎么改 |
|---|---|---|---|
| 1 | 不打「自定义」标签 | `:2057` | `row.entry.declared === true` 改成 `... && !isManagedRoute(...)`。同一处把标签文案换成「官方」（`customTag` 旁加一个 `managedTag` 键，补丁里已经有这个 CSS 类了） |
| 2 | 不给显示名称 | `:1644` | `ownsIdentity` 叠上 `&& !managed`。这不是新行为：内核对内置目录路由本来就不给这一格，「它的名称由目录条目兜底」 |
| 3 | 不给 API 协议 | `:1646` | `canCustomizeApi` 的 `ownsIdentity` 项自动跟着 2 变假；剩下的 `baseURLOverridden` 项**故意留着**——用户层若已存过 `baseURL`，这一格要留可见才能清掉它 |
| 4 | 不给 API 地址 | `:1718` | 这一格现在**无条件渲染**，得单独包一层 `managed && !baseURLOverridden ? null : …`。它现在是陷阱而不是功能：值是 `cordis.patch.yml:137` 的 `!!js (process.env.OPENLUX_BASE_URL ?? …)` 求出来的，用户填一次就在用户层把我们的环境求值永久压掉 |
| 5 | 密钥格子换成「当前令牌」一行 | `:1652` 的 `keyPlaceholder` 那一整块 | 只读摘要 + 一个原生 `<select>` + 一个 `linkButton`，形状见下一节。数据经 `connection.rpc.call('/openlux', 'tokens.current')` 取 |
| 6 | 把 `openSection` 转发给 section 槽 | `settings-general` 补丁第三个 hunk，`client.js:172` | `{ close: onClose }` → `{ close: onClose, openSection: onSelect }`。沿用内核自己的命名（`:233` 给 onboarding 的就叫这个），「管理」才跳得动 |

#### 「切换」和「管理」到底长什么样

**先问 WorkBuddy。** 它没有令牌这个东西（账号只有一把隐式凭据），但它有一个形状极像的控件：
聊天的**模型选择器**，下拉里按分组列模型（`settings.models.empty.description` 原文：「添加后……
出现在聊天模型下拉的『自定义模型』分组中」），**下拉底部一条动作行**
`settings.models.selector.footerAction = 配置自定义模型`，点了去模型设置页。也就是说它的答案是
「一个选择器 + 底部一条去管理的动作」，而不是两个并排的按钮。

**再问内核有没有现成件。** 这一页**没有任何浮层组件**，选东西全页三处都是原生
`<select class="input selectInput">`。原生 select 装不了「底部动作行」，也装不了每行带徽标的富文本
行。所以 WorkBuddy 那一个控件在我们这儿拆成两个，摆在同一行：

```
当前令牌   [ OpenLux 桌面客户端 · 智能自动 · default   ▾ ]   管理
           └ <select class="input selectInput">        └ <button class="linkButton">
```

| 元素 | 用什么 | 尺寸（全部照抄现有类，不新增 CSS） |
|---|---|---|
| 摘要 | `field` + `fieldLabel`，标签写「当前令牌」 | 列向 gap 6；标签 12/18、weight 500、`label-secondary` |
| 切换 | 原生 `<select class="input selectInput">` | h32 / r8 / padding 0 10 / 14px；箭头是 `selectInput` 自带的内联 SVG（right 12px、12×12）；宽度不用管——同包 CSS 里有一条 `select.input{cursor:pointer;max-width:240px}`，挂上类就是 240 上限 |
| 每个选项 | 纯文本一行：`令牌名 · 路由档 · 分组` | 原生 select 的 `<option>` 不能放徽标，所以徽标降级成中点分隔的文字。关掉智能路由的那把写成「deepseek-v4-flash · 手动分组 · Self-Deployed-2 +1」 |
| 管理 | `<button class="linkButton">` | h28 / r14 / padding 0 10 / 12px / `label-tertiary` / 无边框——和这一页「获取可用模型」「恢复默认模型」同一档 |
| 管理点了做什么 | `props.openSection('openlux-token-section')` | 面板不关，左侧导航高亮直接换到「令牌」。就是导航格自己 `onClick` 调的那个回调 |

**为什么不做成富下拉。** 想要每行带路由徽标、分组、已用额度，就得在补丁里自带一个浮层：定位、
outside-click、还有路由层记着的那条「靠 `:hover` 才显示的行内控件，浮层打开时必须另给一个 open 类」。
富行的地方我们已经有了——**令牌页**，那里我们自己写代码，一行能放下名字、徽标、分组、已用、两个动作。
所以模型页只留「快速换一把」，认真管理去令牌页。这也让第 5 条的补丁停在「几行 JSX」的量级。

**选项列表怎么来。** `tokens.current` 一次回当前那把 + 可选清单（都已脱敏），select 的 `onChange`
直接 `tokens.use`，成功后重跑模型同步（理由见第三层）。切换中把 `<select>` 置 `disabled`——
这一页每个 field 都吃 `disabled`，不用另造 loading 态。

第 5 条是本方案里**唯一一处内核补丁跨插件取数**，代价说清楚：

- 通道是按路径注册的，不按插件身份，而 models 插件的 inject 列表里本来就有 `connection`
  （`client.js:2854-2861`），所以调得通。
- 账号插件没挂载时这一行**降级回内核原来的密钥输入框**（写成 `?? 原实现`，不是硬崩）。实际上它永远
  挂着（`cordis.patch.yml:48-49`），这条只是别让补丁替内核做了假设。
- 想避开这一处耦合，代价是整页接管（下面「不做什么」里算过账）。

**「添加自定义提供方」那张卡不动。** 它的显示名称 / API 地址 / API 协议是**为它存在的**——内核原话
「手工声明路由为自己命名的东西：创建卡片之所以索要它们，正因为没有东西能为它们兜底」。WorkBuddy
也有这一层（`providerGroups.customApi`、`providers.ollama`）。用户要删的是**我们自己那一行**上的三个
格子，不是别人带自己服务进来的那条路。

### 第二层 令牌成为独立一页 —— 我们的插件，零补丁

```
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'openlux-token-section',
  order: -5,                       // 账户 -10 < 令牌 -5 < 通用设置 0
  label: () => t('nav'),           // thunk，跟随语言切换
  locale: NS,
  inject: () => ({ callHost, t, store, hooks: { tokens: store } }),
}, TokenSection))
```

形状与 `AccountSection` 一模一样（同一个 `callHost`、同一套 store/hooks 约定），所以这一层没有任何新
机制。

**为什么放在账户旁边而不是塞进模型页**：令牌承载的是额度、渠道分组、有效期、IP 白名单——账户范畴的
东西，不是模型范畴的。模型页只需要回答「现在用哪把」，加一个快速切换；富行、新建、编辑都在这一页。
两页之间靠转发进来的 `openSection` 连起来（模型页的「管理」→ 这一页），是单向的，这一页不用往回跳。

### 第三层 host 侧五个方法 —— 复用现成的 HTTP 与会话

全部走 `account/http.ts` 的 `requestJson` + `readSession()` 拿到的 cookie，与 `auth.ts` 同一条路：

| 方法 | 打哪个接口 | 说明 |
|---|---|---|
| `tokens.list` | `GET /api/token/?p=1&page_size=100` | 回**脱敏后**的列表 |
| `tokens.groups` | `GET /api/user/self/groups` | 分组名、显示名、倍率、可用性、`group_ids` |
| `tokens.create` | `POST /api/token/` | `name` / `routing_priority` / `group_ids` / `unlimited_quota` / `expired_time` |
| `tokens.update` | `PUT /api/token/batch` | **只发 `update_fields` 里点名的列**，理由见事实表 |
| `tokens.use` | 无网络请求 | `credentials.set(API_KEY_REF, 'sk-'+key)` → 立刻 `syncCatalog()` → 广播刷新 |

两条必须写进代码注释的约束：

1. **`sk-` 不过桥。** 列表接口回的 `key` 是明文（库里不带 `sk-` 前缀，要自己拼）。现有架构的原则是
   密钥不交给浏览器（`index.ts:20-27`：「the `sk-` key is written into the credential store by this
   file rather than handed back for the browser to store」）。所以 `tokens.list` 回给浏览器的是
   `{id, name, masked: 'sk-…7f3a', routingPriority, groups, status, usedQuota, expiredTime}`；
   `tokens.use` 只收 `id`，主进程自己再取一次真值。
2. **换完令牌必须重跑模型同步。** 可达分组变了，`GetClientDesktopModelDelivery` 回的清单就会变
   （`callableModelSet`）。不重跑的话，选择器里会留着新令牌根本调不动的模型名——那正是
   `platform-data.md` 里记的「在 `/v1/models` 里 ≠ 此刻调得动」的下游表现。

## 五、界面规格（三屏，效果图里都画了）

尺寸照内核实测值：面板 800 宽、左导航 188、内容区 `padding:0 24px 24px`、分区 `max-width:720`、
卡片 `radius:12` / `border:1px solid --dsw-alias-border-l2`、行内小按钮高 28 / `radius:14` / 12px 字。

**屏 1 设置 › 模型（改后）**
导航多一行「令牌」（在账户下面）。OpenLux 卡头：名字 + 绿点 + 灰色「官方」标（原「自定义」位置），
右侧「编辑」。展开后从上到下：当前令牌一行（名 · 脱敏 key · 路由徽标 · 分组 · 切换 / 管理）→ 一句
「密钥由账户签发并保存在本机凭据库，页面不展示也不接受手填」→「自定义设置」折叠区（里面只剩容量类
字段）→ 模型目录（下发行带「官方」标只读，用户自加行可删）→「添加模型」→「添加自定义提供方」。

**屏 2 设置 › 令牌（新页）**
上方一张「当前令牌」大卡（名字、脱敏 key、路由徽标、分组、额度、已用、最近使用），下方「其他令牌」
用内核那套列表：`rows`（`flex-column` / `gap:8`）里每行一张 `rowCard`（`radius:12` /
`border:1px solid --dsw-alias-border-l2` / `padding:12px 14px` / `gap:12`），行右侧 `rowActions`
（`margin-left:auto` / `gap:4`，里面的按钮被压成高 28 / `radius:14` / 12px）两个动作「使用」「编辑」。
列表末尾一条虚线「新建令牌」——照内核 `addButton` 的第二条规则：`border:1px dashed --dsw-alias-border-l3`
/ `radius:12` / `height:44` / `flex:1` / `min-width:180`。**不放右上角的主按钮**，内核这一页的新建
入口就在列表末尾。

**屏 3 编辑令牌（行内展开，不是弹窗）**
点「编辑」就在这张 `rowCard` 里往下长出表单，行头把徽标和用量让给表单，右侧按钮变「收起」。字段顺序：
名称* → 路由方式（右侧开关 + 「请求级可覆盖」说明）→ **按开关只显示一个分支**：

- 开启智能路由：显示四张策略卡 2×2（文案照 `EditToken.js:179-218` 原文）和请求级覆盖说明；
- 关闭智能路由：四张策略卡整块收起，显示**渠道分组选择器**（下面单列一节）。

再往下是折叠区「更多设置」（额度 / 有效期）→ 底部动作行。不开启的分支不是置灰占位，而是收起；这样
不会把同一件事同时画成“禁用的四张卡 + 可编辑分组”，行内表单也少掉约半屏高度。来回切换只改变当前
显示的分支，**不清空另一分支的草稿**：用户从指定分组切到智能路由再切回来，原顺序仍在。

四条形状全部照内核这一页现成的类名，不自己定：

| 我们要的东西 | 内核现成的 | 实测值 |
|---|---|---|
| 二级折叠「更多设置」 | `customized`（就是「自定义设置」那个 `<details>`） | `border-top:1px solid --dsw-alias-border-l2` + `padding-top:10px`；`summary` 12px/500、`label-secondary`、hover 转 `label-primary`、`width:fit-content`、`margin-left:-4px`、`padding:2px 4px`、小三角是 5×5 只留两条边的方块转 ±45°、`transition:.12s` |
| 折叠区正文 | `customizedBody` | `flex-column` / `gap:12` / `padding-top:12px` |
| 底部取消 / 保存 | `EditorFooter` + `editorActions`（`client.js:141-165`） | `justify-content:flex-end` / `gap:8`；`secondaryButton`「取消」+ `primaryButton`「保存」，`busy` 时换成「保存中…」，`submitDisabled` 控制可提交 |
| 行内删除 | `dangerButton` 的紧凑规则 | 高 28 / `radius:14` / 12px / `padding:0 10px`，**透明底、无边框**，色 `--dsw-alias-state-error-primary`，hover 才有 `interactive-bg-hover-danger` |

三条跟着内核一起抄的行为，不是我们发明的：

1. **一次只展开一个。** 内核用一个单值 `editing` 判 `editing?.provider === row.entry.provider`，
   所以点开第二个会收起第一个。我们的「当前令牌」卡和列表行共用同一个 `editing`。
2. **新建卡和编辑卡各管自己的开关。** 内核注释原话：*Each card kind owns its own open state, so
   closing one never discards a draft in another*。新建走 `setupCard`（`background:
   --dsw-alias-bg-module-platform` / `radius:12` / `padding:14px 16px` / `gap:14`，**填色无边框**，
   跟已存在的行一眼能分开）。
3. **保存反馈是页面顶部一行绿字，不是 toast。** `savedNotice`（`--dsw-alias-state-success-primary`
   / 12px / 18px）+ 文案 `savedProvider`「已保存 {provider}。」，我们照抄成「已保存 {name}。」。

**打开期间被别处改了怎么办**：内核有现成口径，`conflict`「这张卡片打开期间，这些设置已被其他地方改动。
请关闭后重新打开，在当前值上编辑。」——令牌同样会被控制台那边改，保存时 `PUT /api/token/batch` 回
非预期结果就出这句，不猜、不合并。

**删除仍然是弹窗**：内核这一页唯一的弹窗就是删除确认（`deleteTitle`「删除 {provider}？」/
`deleteDescription` / `deleteConfirm` / `deleting`），用的是 `dsh-client-ui-primitives` 的 `Modal`。
我们的「先问再删」跟它同款，照用，别自己搓一个。

### 渠道分组：输入框点开、可搜索、多选（2026-08-25 定的）

**先看中转站自己用的是什么。** `EditToken.js:626-673` 的 `GroupSelector` 是 Semi 的
`Select multiple`，四个关键参数：`searchPosition='dropdown'`、`searchPlaceholder='搜索分组名称'`、
自定义 `filter`（**同时匹配 value / label / desc 三个字段**）、`renderSelectedItem` + `renderOptionItem`
（框内标签 + 富选项行）。上方右侧一个计数「已选择 N 个分组 / 未选择分组」，placeholder 是
「选择分组，可多选，选择顺序即为优先级顺序」，下方一句「选择顺序决定分组优先级；关闭智能路由时必须
至少选择一个分组。」，再下面是**优先级预览**（dnd-kit 拖拽排序，每行可删）。选项按倍率**升序**排
（`getGroupPrice`，便宜的在前），并剔掉 `auto` 哨兵。所以用户说的「输入框点开多选并且可以搜索」，就是
它这个控件。

**再看内核有没有现成的。有，而且是三种不同的锚定列表，选错了就对不齐宽度：**

| 内核的哪一族 | 卡片宽度 | 焦点归谁 | 行规格 |
|---|---|---|---|
| `Menu`（`ui-primitives`） | **`min-width:218px` / `max-width:360px` 定宽** | 不抢焦点，但也没有方向键 | `min-height:40` / r10 / `padding:8 10` / 14-22 / `itemLabel` 单行省略 |
| `popupSelect`（`ui-commands`） | `min-width:min(220px,100%)` / **`max-width:100%`** → **与锚同宽** | **卡片持焦点**，卡内自带一个 `.search` 输入框 | `.row` r8 / `padding:6 8` / **13px** / `.label` + `.detail`(12px tertiary) + 行尾 `.check`；`.rowActive` 是键盘高亮 |
| slash menu（`ui-input-trigger`） | `min(260px,100%)` ~ `min(537px,100%)` | **焦点留在外面的输入框**（注释原话：*combobox — textarea keeps focus*） | `min-height:40` / r10 / `padding:8 10` / 14-22 / 名称 ≤40% + 说明省略 |

**所以「下拉和输入框一样宽」这件事：`Menu` 做不到**（218~360 定宽，`className` 还只落在锚的
wrapper 上、落不到卡片，卡片的 inline style 又被 portal 定位占满，没有缝隙塞宽度）。
**用 `popupSelect` 那张卡的规则就天然同宽**：`max-width:100%`、`max-height:320`、r12、
`border-inverted`、`bg:--dsw-specific-menu`、`shadow-lv3`、4px 内衬，`.viewport` 自己滚。

我们的控件 = **popupSelect 的卡片与行** + **slash menu 的焦点模式**（焦点留在外面那个输入框，
边打边筛）。这两条不是我拼的，是内核自己把两种模式并列写在 `PopupSelectView` 的文档注释里：
*Unlike the slash menu (combobox — textarea keeps focus), this shell HOLDS focus while open*。

| 零件 | 用什么 | 实测值 / 出处 |
|---|---|---|
| 输入框（锚 + 搜索） | 内核 `Input` | h32 / r8 / `border-l2` / `bg-layer-1` / `gap:6` / 左侧 16px icon 槽 / `:focus-within` 边框转 `brand-primary`。**我们市场页已经这么用**（`MarketSection.tsx:1170`，含「wrapper 是 `flex:0 1 auto`，得用 `size` 撑宽」那条坑注释）|
| 下拉卡片 | 照 `popupSelect` 的 `.card` | 同宽（`max-width:100%`）/ 320 高上限 / `.viewport{overflow-y:auto}` / 4px 内衬 |
| 选项行 | 照 `.row` + `.label` + `.detail` + `.check` | 一行放四样：可用性绿点 + 名称 + 说明（12px tertiary，省略号）+ 倍率，选中在行尾出勾 |
| 键盘 | 照 `popupSelect` 的契约 | 打字即筛、**↑↓ 移动高亮并 `scrollIntoView`**、Enter 选中（多选时是 toggle 且不关）、Escape 关闭、←→ 留给输入框的光标 |
| 高度夹取 | `useAnchoredMaxHeight`（primitives 导出） | 320 是设计上限，实际再按可用空间夹一次 |
| 中文输入法 | `onCompositionStart/End` + `!composingRef.current` | 内核重命名输入框的原样做法（`ui-workspace/lib/client.js:2105-2115`）。分组名全是中文，回车必须绕开 IME 组字 |

**上一轮我按 `Menu` 判断「方向键内核不给」，那条只对 `Menu` 成立**——`popupSelect` 这一族有完整的
↑↓ / Enter / Escape，照它做就有键盘导航。

**已选分组不塞进输入框，改成常显在搜索框上方。** 内核 `Input` 只有一个 icon 槽 + 一个原生
`input`，Semi 那种「框内可关闭标签」得自己搓一个容器控件。WorkBuddy 对共用选择器已经给出更重要的
判据：已选项存在的目的就是“始终看得到”，不能跟着搜索结果滚走。因此选择器从上到下是：

1. 当前优先级：抓手 + 编号 1·2·3 + 名称 + 倍率 +「×」移除；
2. 与内容区等宽的搜索输入框；
3. 绝对定位的同宽下拉卡，不参与文档流，不把「更多设置」和底部按钮向下顶。

搜索、筛选、下拉滚动只影响候选列表，**不影响上面的已选顺序**。这比照搬控制台“Select 在上、预览在下”
更适合 588px 宽的设置内容区：下拉一开，用户仍能同时看着当前顺序添加和拖拽。

### 优先级拖拽：用内核侧栏那套原生 DnD，不引 dnd-kit

控制台用 `@dnd-kit/core` + `sortable`，但**内核侧栏的会话「手动排序」已经用原生 HTML5 DnD 做好了**
（`ui-workspace/lib/client.js:725-742`），零依赖，契约可以整套搬——`openlux-plugin-account` 的
`dsh.client.inject` 只有 `dsh-client-runtime` + `dsh-client-ui-primitives`，不必为排序引一个库。

内核那份 `drag` 契约（照抄，别改名）：

```
drag = { start(), end(), active, hover(half), drop(half), marker: 'before' | 'after' | undefined }
```

- 行上挂 `draggable`；`onDragStart` 里 `effectAllowed='move'`、`setData('text/plain', id)`、`drag.start()`
- `onDragOver` / `onDrop` 都先判 `if (!drag.active) return`，再 `preventDefault()`，
  `dropEffect='move'`，然后 `drag.hover(rowHalf(e))` / `drag.drop(rowHalf(e))`
- `rowHalf(e)`：`e.clientY < rect.top + rect.height/2 ? 'before' : 'after'`（`client.js:437-440`）
- 落点提示是**一条插入线，不是跟着鼠标飞的幽灵行**：`.dropBefore:before` / `.dropAfter:after`，
  高 12、`left:0` / `right:4`、`top:-7` 或 `bottom:-7`、`pointer-events:none`、`z-index:1`，
  三层渐变拼出「左端箭头 + 2px 横线」，色 `--dsw-alias-state-business-primary`
- **拖拽只改当前表单草稿，不发请求。** 这点照中转站 `EditToken.js:601-610`：`handleDragEnd`
  只把 `arrayMove` 后的新顺序交给 `onGroupsChange`。用户点底部「取消」可以完整回退，点「保存」时才把
  最终顺序随 `group_ids` 一次提交。内核侧栏的 `sessionDropCommitted` 是“拖完立即落库”的另一种场景，
  这里只借它的落点判定与插入线，不借即时提交。

**提交口径照旧按 ID。** 控制台是「优先按 `group_ids` 灌入，可选列表里没有的 ID 用 `#id` 占位，避免
保存时静默丢组」（`EditToken.js:980-1019`），名字 CSV 只作无 ID 时的兼容回退。我们的 `tokens.update`
照抄这条：`group_ids` 为主、`group` 名单只在没有 ID 时回退，**并且 `#id` 占位项不能被当成名字提交**。

### 为什么行内展开，而不是抽屉（2026-08-25 改的）

初版把编辑做成 480 宽的抽屉，是自己发明的。回头解包核对，**内核这一页从头到尾没有任何弹窗**：
`rowCard` 是 `flex-column` / `gap:12` 的容器，行头只是它的第一个孩子，编辑器就是第二个孩子；
共享的 `EditorFooter` 也不是弹窗底栏，就是一行 `justify-content:flex-end` 的按钮。也就是说，
「点一行 → 在这张卡里展开成编辑器」是这一页原本的形状，行内不是妥协，抽屉才是外来物。

**这里跟界面锚有一处对不上，得说清楚。** WorkBuddy 的模型页是用弹窗的（i18n 键里有
`settings.models.modal.addTitle`），按「界面照 WorkBuddy」这条它该是弹窗。三个理由选内核这边：

- **不是同一件事。** WorkBuddy 那个弹窗是**新建**一个自定义模型（空表单，列表里还没有它的行，
  没东西可展开）；我们这屏是**就地改一把已有令牌**，行就在眼前。
- **视觉邻居是内核，不是 WorkBuddy。** 这一页跟内核的模型页并排住在同一个设置面板里，隔一行导航
  就是 `rowCard` 列表。同一个面板里两套编辑范式，比跟另一个产品的另一页不一致更刺眼。
- **判据是结果。** 用户要达到的结果是「改完令牌立刻看到它在列表里什么样」，行内展开就在原位给出
  这个结果；抽屉盖住列表，反而要求用户记住改前的样子。

顺带明确两处**不加**的东西，因为内核这一页一处都没有：展开后不 `scrollIntoView`、不抢焦点
（全文只有 `OnboardingModal` 里一处 `titleRef.current?.focus()`，那是首次配置的分步弹窗，不是这里）。
表单比行高很多，但面板正文本来就滚，浏览器点击后自然会跟；真发现看不到底部再补，别提前造。

## 六、真机证据，以及它顺带暴露的一个现存缺陷

线上库（`yw_zhoucongjie`，2026-08-25 查）：

| 令牌 | 智能路由 | 分组 | 已用 | 最近使用 |
|---|---|---|---|---|
| OpenLux 桌面客户端 | `auto` | default | $39.74 | **今天 15:19** |
| deepseek-v4-flash | **空（已关闭）** | `Self-Deployed-2,Self-Deployed-3` | $1.04 | 今天 06:10 |
| 云雾桌面客户端 | `auto` | default | **$0.00** | 今天 02:20（= 创建时刻） |
| yw_zhoucongjie的初始令牌 | `auto` | default | $2.09 | 08-18 |

三条结论：

1. **一个账号真的会有多把令牌，而且其中一把的可达渠道完全不同**（那把关了智能路由、绑在两个
   Self-Deployed 分组上）。令牌切换不是假需求。
2. **客户端在悄悄建用户看不见的令牌。** `云雾桌面客户端` 是今天 02:20 建的（`TOKEN_NAME` 改过名，
   `getOrCreateApiKey` 按名字找不到旧的就新建一把），但它**一次都没被用过**——15:19 在跑的还是
   8-13 那把 `OpenLux 桌面客户端`。原因就是截图里那句「由启动环境提供（只读）」：`.env.local` 里
   钉着的 `OPENLUX_API_KEY` 压过了新建的那把。**新建成功、然后立刻变成死账**，而现在的界面里没有
   任何地方能看出这件事。
3. 所以令牌页除了「切换」，还得承担两件事：把这些令牌**摊开给用户看**，以及在启动环境钉住密钥时
   **明说当前生效的是哪一把**（而不是页面上选中的那一把）。

## 七、落地顺序与验证清单

顺序按「先能看见，再能改」排，每步都能单独验：

1. host 五个方法 + 脱敏。验：`connection.rpc.call('/openlux','tokens.list')` 回 4 条、`key` 字段
   一律 `sk-…` 形式、真值不出现在渲染进程。
2. 令牌页只读版（当前令牌卡 + 列表）。验：与上面那张表逐行对齐。
3. `tokens.use`。验：切到 `deepseek-v4-flash` 那把 → `settings.yaml` 的
   `providers.openlux.models` 跟着变（可达分组不同）→ 切回来恢复。**在临时账号上做**，别拿在用的
   那把令牌试。
4. 行内编辑器（含末尾的新建卡）。验五条：关掉智能路由不选分组 → 前端拦住（后端也会拦，
   `token.go:45-47`）；改一次路由 → 只发 `routing_priority` 一列，回查库确认 `model_limits` /
   `allow_ips` 没被清；点开第二行 → 第一行自动收起；新建卡填一半再去点某行的「编辑」 → 新建卡的
   草稿还在（内核那条 *closing one never discards a draft in another*）；智能路由开→关→开，
   四档选择与手动分组顺序都不被清空。
5. 分组选择器。**五条必须真机量，读代码读不出来**：① 下拉与输入框**同宽**（量两个
   `getBoundingClientRect().width` 相等，而不是看 CSS）；② 展开在设置面板底部时不被祖先 overflow
   裁掉——内核的 popupSelect 用的是 `position:absolute` + `useAnchoredMaxHeight`，我们这一页的
   滚动容器不一样，裁了就退回 `Menu` 那种 portal 定位；③ 下拉打开后焦点仍在输入框里、能继续打字；
   ④ 中文输入法组字期间按回车不误触发选中。量法用 CDP：`getBoundingClientRect` 比宽度，
   `document.activeElement` 看焦点落在谁身上；⑤ 搜索与滚动候选时，当前优先级块位置和内容都不变。
6. 优先级拖拽。验四条：插入线出现在指针所在的那一半（上半 `before` / 下半 `after`）；拖完只改
   表单草稿、网络请求数仍为 0；点「取消」恢复原顺序；再次拖动并点「保存」后只发一次
   `tokens.update`，回查库确认 `group_ids` 顺序与界面一致。
7. 最后动两份补丁：`settings-models` 做减法 + 换令牌行，`settings-general` 加转发 `openSection`
   的那个 hunk。放最后是因为补丁最容易被内核升级冲掉，前面六步不依赖它们。验「管理」能跳：点了
   面板不关、左侧导航高亮换到「令牌」。

改完复验按 `.cursor/skills/.../SKILL.md` 的「界面复验：拿 CDP 量」做：
`$env:REMOTE_DEBUGGING_PORT=9222; npm run dev`，判据是 `curl 127.0.0.1:9222/json/list` 列得出 5173
那个 page，然后量 `getComputedStyle` 而不是只看 `classList`——那一条是批量操作那次栽过的。

## 八、明确不做的事

- **不整页接管 `models`。** 用 id `models` + priority `-1` 占位（`HiddenPresetSeats` 那一招）技术上
  可行，但代价是把模型目录编辑器整套自己重写一遍：下发行只读、「官方」标、`llm.discoverModels` 候选
  框（474 条的搜索/全选/计数）、容量字段的 `K`/`M` 往返、`settings.mutate` 的 `revision` 冲突处理。
  这些我们刚在补丁里加过一轮，重写等于把它们从内核维护面搬到自己头上。做减法四处 diff 便宜得多。
- **不动 pi-ai 的已安装 catalog。** 让 `openlux` 变成「内核认识的厂商」确实能一次性消掉标签和两个
  格子，但那是替上游维护一份厂商目录，每次升 pi-ai 都要重新对齐。
- **不用 `PUT /api/token/`。** 理由在事实表里，`auth.ts:184-188` 已经为此绕过一次。
- **不做模型限制（`model_limits`）与 IP 白名单。** 控制台有，桌面端不需要；但**编辑时必须不碰这两
  列**，这正是只走 `batch` 的原因。
- **不换 access token 那条臂。** 每个用户只有一张，`GenerateAccessToken` 生成即覆盖，而我们自己的
  从站同步正拿它认证（`middleware/auth.go:1181`）。用户级鉴权继续用会话 cookie。

---

# 九、方案 B：模型页只删，令牌做成我们自己的整屏面板

同样解决第一节那三件事，但换一套结构。**它不是 A 的微调，三条主干全不一样：**

| | 方案 A | 方案 B |
|---|---|---|
| 模型页那张卡 | 做减法 **+ 加一行令牌切换** | **只删，不加**（密钥格整块撤掉，换一句话） |
| 令牌管理住在哪 | 设置面板里新开一页（导航多一行「令牌」） | 我们自己的**整屏面板** 800×700（`shell.overlay`，市场那一套） |
| 「现在用哪把」摆在哪 | 模型页那一行 + 令牌页 | **账户页**的一条服务行 |

## B 为什么值得单独摆出来

**1. 补丁只删不加，跨插件耦合归零。** A 里唯一那处「内核补丁跨插件取数」（模型页的补丁经
`rpc.call('/openlux','tokens.current')` 去问令牌）在 B 里不存在，`openSection` 那个转发 hunk 也不
需要。`settings-models` 的补丁退回纯删除，是最抗内核升级的形态。

**2. 800×700 是两列，A 只有一列。** 这一条在 A 改成行内展开之后**大半失效了**：A 原来的抽屉只有 480
宽（面板本身才 800），四档路由卡片 2×2 挤得慌；现在编辑器长在 `rowCard` 里，可用宽度就是分区的
`max-width:720`，跟 B 的右列同一个量级。B 剩下的真优势只有一条：**左列令牌列表常驻**，编辑时列表不
被推走。这个尺寸不是我拍的——市场面板就是 `min(800px,100%) × min(700px,100%)`
（`MarketOverlay.tsx:52-53`）。

**3. 它踩的是我们已经铺好的路。** 下面这些全是自己的代码，已经在跑：

| 要用的 | 现成在哪 |
|---|---|
| 整屏面板：mask + `backdropFilter` + radius 24 + `bg-layer-2` + 头/身分离滚动 | `MarketOverlay.tsx:28-85`（`shell.overlay` 槽，`z-index:1000`）|
| 侧栏入口（可选） | `sidebar.footer.action` + `MarketLauncher`，就是界面左下角那个「市场」 |
| 账户页的服务行：32px 图标 + 标题 + 副标题 + chevron | `AccountSection.tsx:147-169`（`serviceCard` / `serviceRow` / `serviceIcon` / `serviceText` / `chevron`）|
| 列表 → 详情的页内导航 | `MarketSection.tsx:259`（`const [detail, setDetail] = useState<CatalogItem \| undefined>()`）|
| 视图开关的 store | `createMarketViewStore()`，`shell.overlay` 注册时挂 `store`（`client/index.ts:387-394`）|

**4. WorkBuddy 的账户那一层正好是这个形状。** 把它的账户/套餐/额度一族 i18n 键全拉出来看（224 条）。
复现法：`fs.readFileSync('D:\\workbuddy\\resources\\app.asar').toString('utf8')` 直接正则匹配
`"(account|plan|quota|usage|billing|credit)…"\s*:\s*"…"`，写成 `.cjs` 跑、`node --max-old-space-size=4096`，
约 1 秒。它的**账户菜单**里挂的是
`account.menu.credits = 积分余额`、`account.menu.usage = 用量`、`account.menu.account = 账户管理`、
`account.subscriptionManage = 订阅管理`；额度细节自成一族 `account.credits.*`
（月度限额 / 下次权益周期更新时间 / 不限量 / 加量包 / 到期时间），还有一句总纲
`account.usageManagementDesc`：「WorkBuddy 采用积分计费模式，模型调用根据系数自动扣除积分」。
**用量、额度、套餐全在账户那一层，模型页一条都不承载**——它那一页从头到尾只管「自定义模型」。
我们的令牌恰好就是「额度 + 可用渠道 + 有效期」，按它的分层，归属地是账户，不是模型。

## B 的三屏

**B1 设置 › 模型（纯删版）**
「自定义」→「官方」；显示名称 / API 协议 / API 地址三格照第四节那个判据关掉；**密钥那一格整块撤掉**，
原位留一句 12/18 的 tertiary 说明：「模型与密钥随账户下发，在『账户 › 通道与令牌』里管理」。卡里剩下的
就是模型目录（下发行只读带「官方」标）+「添加模型」，下面还是「添加自定义提供方」那张卡。
补丁改动：第四节的 1~4 条**照用**，第 5、6 条**不要**。

**B2 设置 › 账户（加一条服务行）**
identity 行 + balanceCard（现有的，28px 大号余额 + 右侧两格 stat）下面，`serviceCard` 里加一行：
32px 图标 + 标题「通道与令牌」+ 副标题「智能自动 · default · OpenLux 桌面客户端」+ chevron。
点了 → **先 `close()` 关设置面板，再开通道面板**（顺序见下面「必验的两条」）。
这一行的样式一个像素都不用新写。

**B3 通道面板（`shell.overlay`，800×700，两列）**
头部：标题「通道与令牌」+ 一句「令牌决定这台客户端能走哪些渠道分组、额度和有效期」+ 右上关闭。
身体分两列：

- 左列 260 宽：令牌列表，每行「名字 / 脱敏 key / 路由徽标 / 已用」，当前那把带「正在使用」标记；
  底部「新建令牌」。启动环境钉住密钥时，在列表顶部挂一条 warning（就是第六节那个真实缺陷）。
- 右列：选中那把的详情 + 编辑表单。四档路由卡片按 2×2 排（文案照控制台
  `EditToken.js:179-218` 原文）、关掉智能路由后分组多选亮起并必填、额度、有效期，底部「使用这把」
  「保存」两个动作。

## A / B 怎么选

| 判据 | A | B |
|---|---|---|
| 内核补丁面积 | 6 处（4 删 + 1 换 + 1 转发），跨两个包 | **4 处纯删**，只碰一个包 |
| 补丁跨插件取数 | 有 1 处（models 补丁调 `/openlux`）| **无** |
| 设置导航多几行 | +1（「令牌」）| **0** |
| 能不能在模型页就地换令牌 | **能**（一个原生 select）| 不能，要去账户页 → 通道面板 |
| 编辑表单长在哪 | **行内展开**（内核这一页原本的做法，无弹窗，宽度 720）| 800×700 两列，**左列列表常驻** |
| 离用户提的原话 | 更近（「做成令牌切换」就在那一页）| 更远，但「不该有填空的地方」执行得更彻底 |
| 新代码量 | 令牌页一页 | 通道面板一屏（更大，但样式基本现成）|

**已定：做 A，编辑走行内展开**（2026-08-25 用户选定）。A 正面回答了「那一页上做成令牌切换」，
多出来的那处耦合已经写清降级路径；改成行内之后还顺带把 B 的第 2 条优势削掉大半——编辑区从 480 变成
720，跟 B 的右列同一个量级。

**B 仍然是下一步的候选**，但触发条件变了：不再是「抽屉挤不下」（行内已经不挤），而是**需要列表和
编辑同时在场**——比如要横着比几把令牌的用量、或者字段涨到模型限制 / IP 白名单那一层。到那时把管理
搬进 B3 那块 800×700，模型页保留 A 的那一行 select 当快速通道，**两版可以叠，不是二选一**。

## B 必验的两条（动手之前）

1. **`shell.overlay` 和设置面板谁在上面。** 两边都写着 `z-index:1000`，但不在同一个层叠上下文：
   设置面板是应用根上的 fixed 层（`settings-general` 的 `.overlay`），而 `shell.overlay` 的孩子挂在
   layout 里的 `.overlayLayer{z-index:20;position:absolute;inset:0;pointer-events:none}`。谁赢取决于
   DOM 里谁更靠后，**读 CSS 读不出来，必须真机量**。规避写法是别去赌：服务行点了先 `close()`
   （section 槽本来就拿到这个回调）再开面板，两个面板永不同时在场。
2. **`pointer-events:none` 是挂在层上的。** 面板自己得把它翻回 `auto`（市场那份在 `root` 上写了
   `pointerEvents:'auto'`，`MarketOverlay.tsx:37`）。照抄即可，但漏了就是「面板画出来了、点不动」。

---

# 十、方案 C：设置内的令牌工作台

C 保留 A 的两个决定：模型页原位快速切换令牌、设置导航新增「令牌」。它只重新设计令牌页本身：
**不再把每把令牌做成一张向下展开的卡，而是在设置内容区里固定成 176px 列表 + 右侧详情的主从工作台。**

这不是 A 的视觉微调，解决的是另一类操作成本：

- A 适合两三把令牌逐张查看；编辑一张时，后面的令牌会被长表单推到下面。
- B 的左列始终可见，但要离开设置并打开整屏覆盖层。
- C 让列表始终可见，同时仍留在设置里；选哪把、哪把正在使用、右侧正在改哪把不会互相脱节。

## C 的三屏

**C1 设置 › 模型**

与 A 相同：去掉「自定义」、显示名称、API 协议、API 地址和手填密钥；原密钥位置换成当前令牌
select +「管理」。这样高频的“换一把用”不用进管理页。

**C2 设置 › 令牌工作台（详情态）**

- 左列 176px：总数、名称/尾号搜索、令牌列表、底部新建。每行只保留名称、脱敏尾号、用量和路由摘要；
  正在使用的令牌用 6px 状态点表示，选中的令牌用设置页原生 `fill.tertiary`。
- 搜索不会把右侧正在查看的令牌从左列抹掉；即使它不命中，也固定保留在结果顶部。
- 右列：名称、脱敏 key、路由策略、累计消耗、最近使用、有效期，以及唯一主动作「设为当前令牌」。
- 切换当前令牌后，在列表里原地移动“正在使用”状态，不关闭页面；随后重取这把 key 的模型目录。

**C3 设置 › 令牌工作台（编辑态）**

- 左列不消失，右列原地换成编辑表单；名称、智能路由四档、手动分组、额度和有效期沿用 A 已定的字段。
- 手动分组仍是“全宽搜索输入 + 多选下拉”；已选优先级常显在输入上方，整行拖拽只改草稿。
- 编辑状态点击另一把令牌时，不直接切换：右侧先出现「当前修改尚未保存」，只有“继续编辑”和
  “放弃并切换”两个明确动作。
- 新建令牌也复用右侧区域，左列顶部临时出现「未保存的新令牌」；保存成功后才进入正式列表。

## 尺寸为什么能放下

设置面板宽 800px，左导航 188px，内容左右 padding 各 24px，令牌页实际可用约 564px。
C 取 176px 列表 + 1px 分隔 + 约 387px 详情。右侧四档路由仍可按 2×2 排；手动分组输入框约
355px，足够容纳名称、说明与倍率三列。它比 B 的右列窄，但比 A 的单张 rowCard 编辑区只少左列那
176px，换来的是跨令牌操作时不丢上下文。

## C 的落点和风险

- 模型页补丁、`openSection` 转发、host 五个令牌方法都与 A 相同。
- 只把 `TokenSection.tsx` 的纵向 rows 换成 `TokenWorkbench.tsx`；不需要 `shell.overlay`，也没有 B
  的层叠上下文与 `pointer-events` 风险。
- 新风险只有一个：右侧有草稿时左列仍可点击，所以“未保存拦截”是必做契约，不能靠禁用整列掩盖。
- 如果实际设置面板在窄窗下低于 720px，工作台降级为两级页：先显示令牌列表，点一把后右侧详情整页进入，
  顶部给“返回全部令牌”；不要把双栏硬压到手机宽。

## 方案 C 的判断

C 比 A 更适合“账号会长期积累多把令牌”的真实情况，也比 B 少一次离开设置的跳转。代价是令牌页的信息密度
更高，右侧编辑宽度更紧。若主要目标仍是尽快落地、令牌常态只有两三把，A 更轻；若希望这次直接把令牌管理
做成可长期扩展的工作台，C 更合适。
