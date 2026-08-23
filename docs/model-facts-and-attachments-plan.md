# 模型能力事实与附件入口：方案（2026-08-22）

起因是两个现象：客户端发图被拒（「当前模型不支持图片」），而 WorkBuddy 用**我们的中转站、
我们的令牌、同一个 `deepseek-v4-flash`** 什么文件都能处理。查下来发现这不是一个 bug，
是一层设计——我们让客户端自己持有「模型能做什么」的意见，而那份意见抄自第三方表。

本文只写有出处的结论。没有 `path:line` 或一条真跑过的命令的，不写。

---

## 一、查到的事实

### 1. WorkBuddy 的「什么文件都能传」不是上传，是路径 + 工具

证据是它自己发到我们中转站的请求原文（token 2379003 = `yw_zhoucongjie` 的
`deepseek-v4-flash`，日志 `654768640` / `654864935`，`openlux_log.detail_logs`）：

| 观测 | 值 |
|---|---|
| 请求体 | 4.63 MB |
| 角色序列 | `system>user>assistant>tool>assistant>tool>…` |
| `data:image` / `image_url` | 11 / 22，**全部在 tool 结果里**，user 消息里一张都没有 |
| user 消息里的文件 | 只有路径：`<user_references> … Only paths are provided. Use read tool to fetch contents … "C:\Users\000\Videos\V5ncIMj-….mp4"` |
| 它的工具表 | `Bash, Read, Write, Edit, Glob, Grep, PowerShell, WebFetch, WebSearch, Skill, Agent, Task*` |

那段 5 秒视频它是这么读懂的：

1. `Bash: ls -lh "<路径>" && which ffprobe ffmpeg …; ffprobe -show_entries format=duration,…`
2. 抽帧到自己的会话工作区 `C:\Users\000\WorkBuddy\2026-08-22-22-45-33\video_frames\`
3. `Read` 五张 `frame_0N.png` —— 图以**工具结果**回灌
4. `deepseek-v4-flash` 读图作答（43964 prompt tokens）

三条推论，每条都影响我们的设计：

- **文件永远留在本机**，模型请求里只有路径。所以「支持任意格式」对它来说不需要解析器。
- 它对 `deepseek-v4-flash` **假定能读图**，没有任何本机能力表拦一道。
- 图走的是 tool 结果，不是相邻的第二条 user 消息——正好绕开了我们撞到的那个上游丢图形状。

### 2. 内核有三道门，判据都是 `inputModalities`

| 门 | 位置 | 拒绝时机 |
|---|---|---|
| 上传预检 | `host/apiproxy/src/api-proxy.ts:2213-2221` | 用户点发送，弹「当前模型不支持图片」 |
| 适配器 | `llm/llm-pi-ai/src/adapter.ts:307-310` | 组装请求前抛 `UNSUPPORTED_CONTENT` |
| `read_image` | `fs/tool-fs/src/read-image.ts:63-75` | 工具调用当场拒绝 |

第三道最要紧：**照 WorkBuddy 那样「路径 + Read」也绕不开它**。它的注释写明为什么更严——
工具结果会进耐久历史，在一条载不动图的路线上吐图会让这条会话再也续不下去。

### 3. 会话一旦出现过图，就锁死在视觉模型上

`api-proxy.ts:2211-2221` 用 `contentHasImage` 判整条会话，而它**会下钻 `tool-result`**
（`llm/llm/src/content.ts:18-21`）。命中之后切非视觉模型会被拒：
*this session already contains images; select an image-capable model.*

所以「让模型自己 `read_image`」不是免费的：读一张图 = 这条会话从此只能用视觉模型。

### 4. 控制台的「识图」标签不能当判据（2026-08-22 实测）

原本想用它替掉第三方表，一验就否了（`.tmp-probe/tag-truth.mjs`，同一张图同一句问题）：

| 标签 | 模型 | prompt tokens | 结论 |
|---|---|---|---|
| 识图 | `gpt-3.5-turbo-1106` | 642 | 读到（说出「红色中式灯笼」） |
| 识图 | `qwen3-vl-235b-a22b-thinking` | 405 | 读到 |
| 识图 | `doubao-seed-1-6-*` ×2 | — | HTTP 429，问不出来 |
| **无标签** | `kimi-k2-0711-preview` | 539 | **读到** |
| **无标签** | `o1-2024-12-17` | 392 | **读到** |
| 无标签 | `qwen-plus-2025-12-01` | 17 | 没读到，且**编了一只橘猫** |

两个方向都不准。这条印证了 `references/platform-data.md` 里那句「tags 是展示层」。

### 5. DeepSeek 上游在「两条相邻 user 消息」时会静默丢图（2026-08-21 查实）

同一份报文，Claude / Gemini 正常读图，DeepSeek 那条上游只多算 29 个 token。
我们的中继不合并消息（`new-yunwu-api/relay/channel/deepseek/adaptor.go` 原样透传），
所以丢在更上游。客户端第一轮恰好就是这个形状：用户消息 + 内核的 runtime-context 用户消息。

> **2026-08-23 补：这里说的「DeepSeek 上游」根本不是 DeepSeek 官方。**
> 官方文档（`api-docs.deepseek.com/zh-cn/guides/vision/`）写死两条：**只有
> `deepseek-v4-flash-vision-exp` 收图**，其它模型一律 `400 This model does not support image`；
> 图片只能出现在 `user` 消息里（`system` / `assistant` 带图 400）。**全文没有任何一句
> 限制相邻同角色消息。** 而我们的 `deepseek-v4-flash` 不但没 400，还准确说出了图里的红灯笼——
> 因为这条流量落在渠道 5976「PICO-开源-0.3对私」，`type=1`、`base_url=http://142.0.143.129:3000`，
> 是另一台二道贩子的中转，名字对得上、行为不是官方的。
>
> 由此纠正两处理解：
> - **内核 catalog 把 `deepseek-v4-flash` 记成纯文本是对的**，跟官方文档一致；
>   图片入口对它关着不是 bug。之前「卡住的是 deepseek-v4-flash」那句话，问题在我们想强开它。
> - **「相邻两条 user 丢图」是那家二道贩子的毛病，不是 DeepSeek 的规则。**
>   它仍然会影响我们（大量渠道都是这种），但它是渠道兼容性问题，不是协议问题。
>
> 还有一条方法论：**探针测的是「今天这把令牌打到的那条渠道」的行为，不是模型的能力。**
> 渠道会换、会是二道贩子。所以 `input_image` 这类事实，能对官方文档就先对官方文档，
> 至少要把测到的渠道 id 一起记下来。

---

## 二、我们做错的三件事

> **先记一条差点写进方案的假 bug，形状比结论值钱。**
> 我一度判定「搜索模型下发是空转的」：`models/sync.ts:98` 写复数 `models: [...]`，
> 而 `deepseek-harness/packages/web/web-search-deepseek/src/index.ts:63-74` 的 schema
> 只有单数 `model`。查的是**源码树**，跑的是 **vendored 的那份**——
> `dsh-plugin-desktop/node_modules/@deepseek-ai/dsh-web-search-deepseek/lib/index.js`
> 里有 `models: z.array(z.string())`、有 `for (const model of options.models)` 的失败降级，
> 取值是 `configuredModels.length > 0 ? configuredModels : [config.model ?? 'deepseek-v4-flash']`。
> 也就是说下发是通的，`cordis.patch.yml:202` 那个 haiku 只在下发为空时兜底。
> **源码树的版本可以旧于装机跑的那份**，内核结论要落到 `node_modules` 里的运行体。
>
> 仍有一条待验：`logs` 里这个用户 221 次搜索全记在 `claude-haiku-4-5-20251001`，
> 最后一次 2026-08-21 01:37，`gpt-4o-mini` 零条——可能只是下发改在那之后且此后没搜过。
> 客户端搜一次、回查 `openlux_log` 就能定论。

### 错误一：admin-server 的出视频白名单已经过期

`model/desktop_delivered_model.go:38-53` 有一张 11 条的硬编码表 `desktopSupportedVideoDefaults`，
不在表里的默认出视频模型会被 `:166-170` 拒掉：「尚未在桌面端实现参数适配」。

这张表停在 veo / 豆包 seedance / 海螺。08-21 之后接进客户端并真机出片的
**Vidu、百炼（happyhorse/wan）、可灵 v1 与 3.0 turbo、Grok** 一个都不在里面。
**影响**：客户端明明支持，运营在交付页选不了，选了报错——而报错文案说的是客户端没适配，
会把排查方向直接带偏。出图侧没有对应白名单，两侧不对称。

### 错误二：「对话清单第一项是装机默认」这条契约客户端没实现

admin-server 的注释把它写成契约（`desktop_delivered_model.go:100`），
但插件里**没有任何地方写 `agent-default-model`**（全仓 grep 无命中），
装机默认恒等于 `cordis.patch.yml:158-161` 的 `deepseek-v4-flash`。
**影响**：运营调整清单顺序不生效；更糟的是清单里若不含 `deepseek-v4-flash`，
默认模型会指向一个选择器里没有的名字。

### 错误三：模型能力抄第三方表——这才是图片入口卡住的那条

`models/capabilities.ts` 从内核自带的 pi-ai 目录取 `input`，写进 `settings.yaml`。
那张表把 `deepseek-v4-flash` 记成纯文本，于是三道门全关。而实测这个模型**能读图**
（单条 user 消息形状下 685 prompt tokens，答案正确）。
WorkBuddy 也有这层记录（`supportsImages`），区别是**它的值随自家服务端的模型清单下发**。

三件事是同一个病：**桌面端持有了本该由服务端说了算的事实**，而且持有的那份还来自第三方。

---

## 三、动手前必须知道的（容易漏掉的代价）

1. **放开图 = 可能悄悄答错。** 只要把 `deepseek-v4-flash` 标成能读图，第一轮的相邻 user 消息
   形状就会让上游丢图，模型照答不误。今天的显式拒绝虽然难看，但不骗人。所以第 1 步落地时
   要同时处理消息形状（见第四节第 4 步），否则是拿一个可见问题换一个不可见问题。
2. **`read_image` 会锁死会话。** 见事实 3。给用户的说法要提前想好：读过图的会话不能再切文本模型。
   我们已有的 `image_show`（不进模型内容、只摆卡片）是这条约束的既有解，路径引用方案应尽量复用它。
3. **删 `DEFAULT_IMAGE_MODEL` / `DEFAULT_VIDEO_MODEL` 会牵动文案。** 这两个常量不只是默认值，
   还出现在拒绝话术里（`media/video-tool.ts:334,341` 让模型「改用 veo_3_1-fast」）。
   删掉要连拒绝文案一起改成「从当前可用清单里挑」。
4. ~~**加「吃不吃图」字段的迁移风险。** 新字段默认 false 的话，`claude-opus-4-8` /
   `gemini-3.1-pro-preview` / `gpt-5.4` 这三个今天能读图的会当场退化。首次上线必须带一次
   数据迁移或按现状预置。~~
   **2026-08-23 已由设计消掉，不需要迁移**：字段是 `*bool`，`nil` = 不覆盖，客户端此时
   继续用第一层（pi-ai 目录）的答案；只有明确填了 true/false 才动它。所以 143 条存量档案
   一条都不用改，那三个能读图的模型照旧。真机验过：开关打开、只标了 `deepseek-v4-flash`
   一条，`gpt-4o` 与 `claude-opus-4-8` 的 `[text, image]` 原样不动。
5. ~~**路径引用 = 文件留在本机 = 权限边界。**~~ **2026-08-23 由第 3 步的真机跑验掉了。**
   暂存目录 `C:\Users\000\.dsh\media\incoming\` 在会话工作区（`C:\Users\000\Desktop`）之外，
   而 `read` / `pwsh` / `image_ask` 三条路都照常打开了它——pptx 靠命令行取出正文里的暗号、
   mp4 靠 ffprobe 报出时长分辨率、png 走读图。所以我们这套预设不限制工作区外读取，
   不需要放宽也不需要拷进工作区。
6. **ffmpeg 不是我们的东西。** WorkBuddy 用的是 PATH 上的 ffprobe/ffmpeg。视频理解这条要么
   接受「装了才有」，要么打包——后者要动安装体积，先不做，但拒绝话术要说清楚。
7. ~~**32MB 单图上限与 20MiB 请求上限打架。**~~ **2026-08-23 查实：这条在 DSH 上不成立，
   写的时候抄的是 openclaw 时代的事实。** `maxRequestImageBytes` 和那个把旧图换成
   `OFFLOADED_IMAGE_TEXT` 的静默降级，整个 `yunwu-desktop/dsh` 树里一处命中都没有
   （`rg --no-ignore --hidden`，按内核那一册的规矩验过搜索确实扫到了文件）。
   现在的限是四道，**全在 `attachment-local` 一家手里，而且四道都出声**：

   | 限 | 我们机器上的值 | 超了谁来说 |
   |---|---|---|
   | 单图字节 `maxImageBytes` | **32MB**（我们改的，默认 5MB；`cordis.patch.yml:84`）| 复合器 toast `image.fileTooLarge` / 宿主 `IMAGE_TOO_LARGE` |
   | 一条消息图片总字节 `maxMessageImageBytes` | 100MB（默认，没动）| `IMAGES_TOO_LARGE` |
   | 每条消息图片张数 `maxImagesPerMessage` | 20（默认）| `TOO_MANY_IMAGES` |
   | 解码像素 `maxImagePixels` | 40MP（默认）| `IMAGE_TOO_MANY_PIXELS` |

   所以 32MB 单图 < 100MB 总量，**两个数本来就不打架**，一条消息塞三张 32MB 也还在总量内。
   `read_image` 的上限取 `min(单图, 总量)` = 32MB（`dsh-tool-fs/lib/index.js:1017`），
   超了是 `FS_TOO_LARGE` **抛错，不截断**（`dsh-fs-local` 的 `readWholeBytes:371,382`
   前后各拦一次：先 stat 后流式，都是 throw）。
   **剩下的真实代价只有一条**，`cordis.patch.yml` 的注释里已经写着：进了历史的图在压缩之前
   每轮都跟着计费——那是花钱，不是丢东西。

---

## 四、顺序

### 第 0 步：先修「运营改不动」的两处（不依赖任何设计决策）

不做设计、不动架构，纯纠错，所以排在最前面：

- 视频白名单：admin-server 的 `desktopSupportedVideoDefaults` 补上 Vidu / 百炼 / 可灵 / Grok
  （名字以插件里各 provider 真机验过的为准），或改成由客户端上报能力。
  验收：交付页能选中并保存 `kling-video`，桌面端拿到后能出片。
- 「清单第一项是装机默认」：在客户端实现，或把 admin-server 那句注释改成实情。
  验收：改交付页清单顺序 → 新装机（或清掉 `agent-default-model`）后默认模型跟着变。
- 顺手把搜索那条待验点掉：客户端搜一次，回查 `openlux_log` 确认 `model_name` 是下发的那个。

#### 第 0 步的验证记录（2026-08-22 夜）

> **环境口径只有一份，在参考册里**：
> `.cursor/skills/align-with-claude-and-workbuddy/references/platform-data.md`
> 的「谁是谁：门、钥匙、以及哪把开哪扇」（2026-08-23 整格实测）。这里不再抄一遍，抄了就会跑偏。
>
> 三句话的版本：**判据是「这一步碰渠道吗」**——碰就走线上 `api.openlux.ai` +
> `OPENLUX_API_KEY`（476 条，客户端自己也走这把）；只读下发 / 能力档案就走本地 `:3001` +
> 本地站令牌（线上这两条读取面仍 404）；改配置走本地 `:3000` / `:3002`。
> 探针是混合形态：服务在本地、表单里 `base_url` / `token_key` 填线上。
> **别用同文件里那把 `DEEPSEEK_API_KEY`**（只 68 条，没有 gpt/claude/gemini，一测就是假阴性）。

**验下发必须起本地服务，线上域名做不了这件事**——这条是前提，不是偏好：

```
GET https://api.openlux.ai/api/desktop-config/model-delivery  → 404 Invalid URL
GET http://localhost:3001/api/desktop-config/model-delivery   → 200 configured:true
```

线上中转站还没部署这条读取面，所以生产上下发一路缺席，客户端的模型清单其实来自「广场上架」
那条旁路。我一开始拿线上域名验，三条分支全都不写，差点当成代码没生效去翻日志。

补了这一条之后两条分支都在真机上过了（客户端 `OPENLUX_BASE_URL=http://localhost:3001`，
本地下发清单 `[gpt-4o, claude-opus-4-8, deepseek-v4-flash]`，真档案就地改、跑完还原）：

| 分支 | 造的局面 | 结果 |
|---|---|---|
| 播种 | 删掉 `agent-default-model` 段 | 写成 `openlux/gpt-4o`，即清单第一项 |
| 修复 | 写成 `openlux/openlux-model-that-is-gone` + `reasoningEffort: high` | 改成 `openlux/gpt-4o`，档位被 `unset` 清掉且没抛错 |

两条「不该动」的分支（用户选的还在清单里、用户选的是别家路由）由进程内探针覆盖：把 `syncModels`
用 esbuild 打成 cjs，喂一个临时 HTTP 下发和一份内存设置替身，四条分支一次跑完，均如期。

白名单那条只有单测（`NormalizeAndValidateDesktopModelDeliveryConfig` 的放行/拒绝两侧），
~~**交付页真存一次还没做**~~。

#### 补做那次「交付页真存一次」，当场抓到一个只有打开页面才看得见的 bug（2026-08-23）

**症状：后端放行、页面不给选，而且不报错。** 出视频那一格的下拉只有 10 条（veo 3 条、豆包 5 条、
海螺 2 条），我们扩到 19 条的可灵 / Vidu / 百炼 / Grok 一条都没出现。运营在页面上根本走不到
「存进去被拒」那一步，所以单测两侧都绿也没用。

**病根：那份清单在前端被手抄了一份完整选项表**（`admin-cloud` 的 `VIDEO_MODEL_OPTIONS`）。
它自己的注释还写着「两边错开一条就是这里选得到、保存时被后端拒掉」——防的是反方向，
真出事的是这一侧：后端加了 9 条，抄本没跟。

**改法是让它没得抄**：能选什么由服务端在同一个 GET 里给
（`supported_video_defaults`，顺序即展示顺序，所以 model 层从 map 改成切片 + 派生集合，
map 的随机遍历顺序会让运营每次打开看到的排列都不一样）；前端只留一张「模型名 → 中文标注」
的注解表，**认不出的名字照原样显示**。于是以后往白名单加模型，页面当场就能选，
最坏情况是少一句中文备注。

真机（本地 admin-server:3000 + admin-cloud:3002，Root User 会话）：

| 步 | 结果 |
|---|---|
| 接口 | `supported_video_defaults` 19 条，与 Go 侧清单逐条一致 |
| 下拉 | 滚到底能看到 `kling-video（可灵 v1）` … `grok-imagine-video（xAI Grok Imagine）` |
| 存 | 选 `kling-video` → 保存 → 回读 `default_video_model: "kling-video"`，`updated_at` 跟着走 |
| 还原 | 再存回 `veo_3_1-fast`，回读一致（本地环境不留在一个 341s 才出片的默认上） |

> 量的时候差点误判一次：下拉打开后 DOM 里**永远只有 10 个 `.ant-select-item-option`**，
> 因为 antd 是虚拟列表，只渲染可见项——而那 10 条恰好就是新清单的前 10 条，跟旧的抄本
> 一模一样。要滚 `.rc-virtual-list-holder` 才能看到后 9 条。按 DOM 计数下结论会得出
> 「改了没生效」。

### 第 1 步：把「服务端覆盖层」补回新插件（`input` 是它承载的第一条事实）

> 2026-08-23 重新设计过一轮。原先写的是「交付页对话模型行加开关 → 下发表加列」，
> 那是顺着症状加字段；查完两侧的既有纪律后改成下面这个形状。

**病根比「少一个字段」大。** 老客户端是三层——本地家族表 → 服务端下发覆盖 → 用户自改，
形状照 WorkBuddy（`src/main/model-profiles.ts:9-30`）。第二层就是 `desktop_model_profiles`
这张表，建表理由写得很硬：这些事实只能逐模型实测，塞进客户端常量等于每修一条发一版
（`admin-server/model/desktop_model_profile.go:14-23`）。新的 DSH 插件重起炉灶时，
把第一层从家族表换成了 pi-ai 内置目录——**这一步是升级**，pi-ai 逐模型上游实测，
比我们那张按族猜的表强（`capabilities.ts:11-15` 就是这么论证的，还点了 `glm-4.5` 那次 400）——
但**第二层整个没接**（插件全仓搜 `model-profiles` 零命中）。于是今天不只是 `input` 错：
凡是 pi-ai 记的与我们中转站背后那条渠道不一致的字段，我们都只能发版，没有旋钮。

所以要做的是把第二层接回来，`input` 只是第一条乘客。

**落点：能力表，不是下发表。** 中转站对 admin-server 的表已有既定的镜像纪律——
市场表（`new-yunwu-api/router/api-router.go:537-539`）、下发表
（`new-yunwu-api/model/desktop_delivered_model.go:10-13`）都是「admin-server 建表并写，
主站只读同一批表」。能力表现在写着「主站无任何读写」，那是它建表时只有老客户端直连
admin-server 的实情；新插件只有一个 `(baseUrl, apiKey)` 出口且指向中转站，所以按同一条
纪律镜像它，是延用既有机制，不是新发明。

**独立路由，不塞进下发报文。** 塞进下发只要一次往返，且「需要能力的模型」恰好就是
「下发的那些」——但下发未配置时插件会回落到广场上架那条旁路，那条路上同样要能力事实。
独立路由两条路都覆盖得到。

**字段形状**：`input_image *bool`，`nil` = 不覆盖、`false` = 明确覆盖成不支持，
与这张表现有的四个思考布尔同一条规矩（`desktop_model_profile.go:56-59`）。
映射到内核就是 `input: [text]` 还是 `[text, image]`。

**不做乐观默认。** 内核那份笔记权衡过「未声明即当作支持图片」并否决了；我们这侧证据更强：
deepseek 那条上游收到图是**静默丢弃**而不是报错（事实 5），乐观默认换来的是用户看着像模型瞎了。
未知就保持显式拒绝。

**路由也不新开。** 原本打算加一条 `/api/desktop-config/model-profiles`，读了 admin-server
那条客户端面的注释后否了——它写着这份响应刻意做成「一份产品配置」而非「一个实体的列表」，
对齐 WorkBuddy 的 `getProductConfiguration`，「将来加媒体参数、加别的客户端旋钮都往这个
响应里挂，不必再开一条路」（`controller/desktop_model_profile.go:472-480`）。所以中转站
镜像的是**同一条路由、同一份报文**：`GET /api/desktop-config`，字段逐个对齐，两端说同一种线上格式。

#### 落地与真机验（2026-08-23 凌晨）

四个仓库各一处，都编译/lint 过：

| 仓库 | 改了什么 |
|---|---|
| admin-server | `desktop_model_profiles` 加 `input_image *bool`；校验拦「非 chat 类别上填」；后台 DTO / 留痕 / 客户端报文各带一个字段；两条单测 |
| new-yunwu-api | 只读镜像那张表（`model/desktop_model_profile.go`，逐字段对齐、不进 AutoMigrate）+ `GET /api/desktop-config`（TokenAuth + ETag） |
| openlux-plugin-account | `models/profiles.ts` 取覆盖层，`sync.ts` 同一轮读、`described()` 里盖在 pi-ai 之上；拉不到就保持目录答案 |
| admin-cloud | 档案表单加「收不收图」三态 + 列表加一列 + 「保存后会下发什么」多一行 |

真机验（本地 admin-server:3000 + 本地中转 :3001 + 真客户端，共享测试库 `jishu_test`，
造的局面跑完已还原）：

| 局面 | `settings.yaml` 里的 `input` |
|---|---|
| 标 `deepseek-v4-flash` 收图 + 总开关开 | `deepseek-v4-flash` → **`[text, image]`**；`gpt-4o` / `claude-opus-4-8` 原样 `[text, image]` |
| 行照旧标着收图，**只把总开关关掉** | `deepseek-v4-flash` → **退回 `[text]`** |

中转站报文侧同时验了一发：`HTTP 200`、`ETag "dc.mp.1.9.1787418216.143"`、
`rollout {"enabled":true}`、9 条里只有 `yunwu/deepseek-v4-flash` 带 `input_image=true`。

**栽的那一跤值得记**：第一遍真机跑出来 `deepseek-v4-flash` 仍是 `[text]`，我差点去翻
中转站日志。真因是我只跑了 typecheck 没跑 `npm run build`——junction 指向源码目录，
但装机跑的是 `lib/index.js`，那份还是改动前构建的。这和方案里那条「源码树可以旧于装机
跑的那份」是同一个坑的两面：**内核结论要落到 `node_modules` 的运行体，自己的改动也要
先构建再上真机**。

验收（已达成）：后台标一条 → 客户端 `input` 变 `[text, image]`。
**注意这条只验到「门开了」**；图能不能被上游读到是第 4 步。

#### 第 1.5 步：这一格的数据从哪来 —— 探针加「收不收图」这一维（2026-08-23 凌晨）

覆盖层建好之后剩下的问题是「谁来填」。手填 477 个模型不现实，而且填了也会过期
（同一个模型名背后的渠道会轮换）。所以照既有 `StartThinkingProbe` 的样子加一维，
**不导静态数据、只做可重复的一条流水线**，结论一律落草稿等人看。

判据被真机打脸两次才定下来，三层缺一不可：

1. **答得出图里那个随机数就算读到。** 图是现画的（七段码，纯 stdlib），每发换一个数字——
   嵌一张固定的图会让「图里是什么」变成常量，上游任何一层缓存都能骗过判据。
2. **答不出不等于没读到，所以要一发同形状、去掉图的对照。** `gpt-4o` 把 `643698` 认成
   `643690`（七段码的 8 少认了中间那杠），prompt tokens 却是 411——图明明进去了；
   `deepseek-v4-flash` 两种形状都答空，因为它把 `max_tokens` 全花在思考上了
   （所以预算给到 512，且思考正文也参与匹配）。判负的最终依据是
   **带图那发比对照多出的 prompt tokens**：真进去至少涨上百，被丢掉只涨几十。
3. **打不通 ≠ 不收图。** 429、渠道不通、超时、上游没回 usage，一律 `unresolved`，
   一个字都不写库。只有 4xx 且正文点到 image/vision/modality 才算「上游明说不收」。

还有一层是**按客户端真实的报文形状判**：第一轮发的是两条相邻 user 消息（用户那条 +
内核的 runtime-context 那条）。先打这个形状，判负了才补一发单条形状，用来把
「上游根本不收图」和「是我们的形状让它丢图」分开。后者单独计数（`shape_blocked`），
因为这批是我们自己能修回来的——它直接回答「做第 4 步能换回多少个模型」。

真机验（线上站，三个预期不同的模型都对上了）：

| 模型 | 客户端形状 | 单条形状 | 判定 |
|---|---|---|---|
| `claude-opus-4-8` | 353 tokens，逐字答对 | 不用打 | 收图 |
| `gpt-4o` | 411 vs 对照 56，答 `91056`（漏一位） | 不用打 | 收图（靠涨幅救回） |
| `deepseek-v4-flash` | 137 vs 对照 103，只多 34，模型自称「不支持图片」 | 285 vs 83，答对 | **不收图，但是被我们形状挡的** |

最后一行把 2026-08-21 那个推测变成了机器可复现的结论。

写库这条路也真机验过（新建 / 补全 / 冲突三条分支，跑完还原）。**顺手挖出一个我自己
埋的 bug**：`UpdateDesktopModelProfile` 用显式列名 map 更新，第 1 步加 `input_image`
字段时漏了把它加进那个 map —— 新建档案存得上，**编辑已有档案时那个开关静默不保存**。
后台界面上的三态开关也一样受影响；第 1 步的验证是直接改库造的局面，正好绕过了这条路。
教训：**加字段要顺着这张表所有的写入口各走一遍**，别只验你造的那条。

#### 第 1.6 步：把「谁还没被问过收不收图」变成运营点得动的清单（2026-08-23）

探针建好之后卡在一个很蠢的地方：**缺失清单只判「这个模型有没有档案行」**。
档案表加了收图那一格之后，这个判据不够用了 —— 一条早就建过档（比如从客户端家族表导出来的
那批 claude）的模型，收图那格仍然是 NULL，它却永远不出现在清单里，运营也就没有入口去补。

真机数了一次（`jishu_test`，上架且展示的模型）：**807 条里 738 条没建档、64 条建了档但
`input_image IS NULL`**。后面那 64 条就是看不见的那批。

所以清单加了一维：`GET …/model-profiles/missing?dimension=vision` 时，"缺"的定义从
「没有档案行」换成「这一格是 NULL」（`p.id IS NULL OR p.input_image IS NULL`），
每行再带一个 `has_profile`，好让界面把两种「缺」分开说 —— 补一个没建档的会新建一行，
补一个已建档的是往已有行里填一格，而那行可能已经上架。

界面上是弹窗顶部一个二选一（「没建档案 / 收图这一格还是空」），切过去时清空已勾选的行
（两份清单成员不同，留着勾选会把没在看的模型也发去实测），并且**从这一档发起的实测只探收图那一维**
—— 省掉每个模型 4~6 发思考请求，而这批模型的思考结论多半早就在库里。

真机验（本地 admin-server + admin-cloud，线上站打模型）：

| 看哪一档 | 条数 | 说明 |
|---|---|---|
| 没建档案 | 409 | 老口径 |
| 收图这一格还是空 | **471** = 409 + **62** | 多出来的 62 就是「已建档、缺收图」（SQL 里那 64 条减去 2 条被非对话模型过滤掉的） |

发起的那一发报文里 `dimensions` 只有 `["vision"]`，两个勾选的模型逐字带上。
其中一发撞上 `503 无可用渠道（distributor）`，两条都记「无结论」、一个字没写库 ——
这正是「打不通 ≠ 不收图」那条纪律的现场。

**顺带量到一件要交代的事**：那 64 条里有 2 条是**已下发**状态。探针对已上架的行一个字都不碰
（`skipped-visible`），所以这两条只能由人在档案里手填。清单里也照样列着，因为不列的话它们就
彻底没人管了。

#### 第 1.8 步：靶子和打的那个站不同源 —— 上面那份清单一直在骗人（2026-08-23 傍晚）

整理环境口径时撞出来的，比钥匙用错更严重：**「还差谁」是从后台自己的 `models` 表捞的
（`ListModelsMissingDesktopProfile`，条件 `status=1 AND show_in_square=1`），而探针把请求打到
另一个站**（开发期必须指线上，本地站没有承载渠道）。两个宇宙不重合，真机数了一次：

| 量 | 数 |
|---|---|
| 本地表说「缺收图判定」 | 451 |
| 其中线上 + `OPENLUX_API_KEY` 真够得着的 | **147** |
| 够不着的（白占额度、每条还要赔一次真实请求的等待） | **304**：`aklskak`、`abab5.5-chat` 这类老古董，`api-cogvideox` 这类视频模型，还有一条名字带前导空格的 `" claude-opus-4-7-xhigh"` |
| 反过来：线上在卖、本地表里根本没有 | **273**（`kling-omni-image`、`veo_3_1`、`gpt-5.5-pro-2026-04-23`…）——永远不出现在清单里 |

于是「把线上模型全打一遍」照这份清单根本跑不出来，而且已有判定少得可怜：168 份档案里只有
**33 条**有收图结论（8 收 / 25 不收），那批批量探针用的还是受限钥匙，**gpt / claude / gemini
一条都没批量探过**。

**改法与交付页那个 bug 同一句话：能选什么和真能用什么必须同源。**
新增 `PlanProbeTargets`（`service/desktop_market/probe_targets.go`）：拿**真正要跑探针的那一对
`base_url` / `token_key`** 现拉一份 `/v1/models` 当宇宙，减掉这一维已经有结论的，
广场看得见的排前面、目录里多出来的补在后面，够不着的直接跳过。
编排结果挂进进度快照（`ThinkingProbeRun.Plan`），页面上就摆在运营正看的那个面板里——
「怎么只探了这些」得当场有答案。前端**不**照抄一份过滤逻辑：那就是第二份真相。

两个顺带的好处：

- **可断点续跑**：两条分支都排除「已有结论」，所以一轮跑挂了再按一次就接着往下探，不重不漏。
  也因此单轮上限对这条路放宽到 400（手工粘贴的清单仍卡在 60，防手滑）。
- **顺序可复现**：`/v1/models` 回来的次序是乱的（同一把钥匙两次都不一样），目录侧排过序才能让
  「取前 N 个」这件事说得清。

动手前先验了假设（`llmprobe/openai/catalog_live_test.go`，env 开关）：本包 `ListModels`
拿账号令牌打线上 = 476 条、含 gpt/claude/gemini、线上目录没有脏空格（那条带空格的是本地表独有）。

真机复验，先小批量对数（5 条）：目录 476 / 广场可见 5 / 跳过够不着 **304**（与我另一条路径
独立数出来的 304 完全对上）/ 非对话 143 / 还剩 295。结论：3 条 claude 首次被批量探到，
全判「收图」并写成草稿；2 条无结论（`audio1.0` 本来就是音频模型）。

##### 整轮跑完的数（第一遍，297 条靶子 = 广场可见 144 + 目录新增 153，只勾收图）

| 结果 | 条数 |
|---|---|
| 写进库 | **137**（新建 62 + 补全 75，冲突 0） |
| 判「收图」 | **101** |
| 判「不收图」 | 28 |
| 无结论（一个字不写库） | 152：429 频控/分组饱和 **119**、500 上游错 25、超时 4、503 无渠道 1、其他 3 |

耗时约 25 分钟（并发 3）。

**第二遍立刻验了「断点续跑」这个性质**：同样的参数再按一次，编排出 **160 条 = 297 − 137**，
一条不重。这正是「两条分支都排除已有结论」换来的，长扫描中途挂掉不用从头再来。

##### 但第二遍同时推翻了我对 429 的解释

第一遍看到 119 条 429，我判成「连续 25 分钟并发 3 把自己限住了，重跑能收回大半」。
**第二遍的数字否掉了这条**：160 条里只多写进 3 条，无结论 149 条，分布几乎逐项相同
（429 仍是 119、500 仍是 24、超时 3）。同一批模型两遍都 429，说明这是**稳定条件，不是我们打太快**。

把无结论按报文原话分了个类，才看清它们压根不是一回事：

| 为什么没结论 | 条数 | 例子 |
|---|---|---|
| `429 当前分组上游负载已饱和` | **72** | `claude-sonnet-4-20250514`、`claude-opus-4-20250514`、`gemini-3-pro-preview-11-2025`、一堆 `gpt-3.5-*` / `gpt-4-*` 老版本 |
| 上游说「该模型不存在或你无权访问」（外面套了 429） | 15 | `deepseek-chat`、`deepseek-reasoner`、`kimi-k2-250905`、`deepseek-r1-250120` |
| `500` 上游错 | 17 | `ERNIE-*` 全家、`gpt-3.5-turbo-0125` |
| 任务型渠道（`this channel is designed for task-based operations`） | 7 | `audio1.0`、`MiniMax-File-Upload`、`viduq1` / `vidu2.0` / `viduq3` |
| `Access denied` | 3 | `deepseek-v3-0324`、`qwen-turbo-2025-07-15`、`qwen-vl-max-2025-08-13` |
| 超时 | 3 | `glm-4.7`、`gpt-5.2-codex`、`qwen3-next-80b-a3b-thinking` |
| 其他 | 32 | `glm-5.1`、`gpt-4o-transcribe`、`gpt-5.2-chat-latest`… |

两条要记住的：

- **「在目录里」不等于「打得通」。** `/v1/models` 会列出这把令牌其实调不动的模型
  （15 条直接被上游否掉、72 条分组没容量）。同源过滤掉的是「本地表有、目录没有」那 304 条，
  这一层挡不住「目录有、上游不给」的那 100 多条。
- **重跑不会把它们救回来，但每跑一遍都要为它们赔上约 25 分钟。** 下一步该记一笔
  「这条上次是怎么死的」，让编排跳过近期确认打不通的，否则每次扫描一半时间花在同一批死条目上。
  （名字能认出来的那几家已经就地补进非对话过滤器：`vidu*`、`*file-upload`、`*transcribe`。）

##### 这一轮抓到的最重要一件事：**被我们自己报文形状挡住的是 GPT-5 全家**

`shape_blocked` 从上一轮的 18 涨到这一轮又中 **16 条**，名单变了性质：

```
gpt-5  gpt-5.1  gpt-5.2  gpt-5.5  gpt-5-codex  gpt-5.1-codex
gpt-5.6-sol  gpt-5.6-sol-max  gpt-5.6-sol-ultra
gpt-5.6-terra  gpt-5.6-terra-max  gpt-5.6-terra-ultra
deepseek-v3.1  deepseek-v3-1-250821  glm-4.5-air  qwen3-vl-8b-thinking
```

这批**上游本来就能读图**，是客户端第一轮发的两条相邻 user 消息让它们把图丢了。
之前判断「第 4 步不着急」的依据是「唯一撞上的那个模型我们本来就下发成不收图」——
现在这条依据不成立了：撞上的是旗舰家族。**中继那个合并相邻 user 的改动（已实现、已单测、
已真机 4/4）该尽快上线**，上线后这 34 条要重探一轮翻回「收图」。

#### 第 1.7 步：判据被真机推翻了一次 —— 涨幅顶不过模型自己的话（2026-08-23）

补数据时拿 `glm-4.5-air` / `glm-4.6` 试手，探针说「收图: 是」。**但它俩在客户端形状下
答的是「未提供图片」「无法识别」「0」**，prompt tokens 却照样比对照多 531。
按当时的判据（没答对 + 涨幅够 ⇒ 图进去了 ⇒ 收图）它们被判成收图 —— 而下发出去的后果是：
用户发一张图给 glm-4.5-air，收到的正是那句「未提供图片」。这就是用户最初抱怨的那种失败，
只不过换我们亲手把它写进库。

先补了一条独立证据再动手：同一把令牌、同一个模型，**换成单条 user 消息**问同一张图，
它逐位答对（`584131`）。所以图确实能读，卡的是形状；而涨幅只能证明**图被算进了 prompt**，
证明不了模型看见了它 —— 中间任何一层（二道贩子的报文规整、丢图的兼容层）都能让它算了钱不给模型。

判据因此加了第 2b 条，涨幅只在两种情形下才算数：

| 答案长什么样 | 判 | 为什么 |
|---|---|---|
| 含图里那串数字 | 收图 | 不用涨幅 |
| 与那串数字**形近**（最长公共子序列 ≥ 位数−2） | 收图 | 认错一两位是视力问题，不是收不收图（gpt-4o 把 643698 认成 643690） |
| **一个数字都没答**（预算花在思考上） | 涨幅够就算收图 | 没有反证，只能靠重量（deepseek 就是这样） |
| 答了个**不相干**的数（glm 的「0」） | **不收图** | 它给了读数，而读数是错的 |
| **自己说看不见**（「未提供图片」「无法识别」「no image」…） | **不收图** | 一手证据，压过涨幅 |

改完重跑同一批，三条结论全变了：`glm-4.5-air` / `glm-4.6` 从「收图」翻成
**「不收图（上游能读，是我们那两条相邻 user 消息让它丢了）」**，`glm-4.6` 那行因为库里存着
旧的 `true` 被记成 `conflict`（探针不覆盖冲突，由人定），`kimi-k2.5` 逐字答对不受影响。
被形状挡住的计数从 1 涨到 3。

**顺手换掉了图的字形**：原来画七段码，`glm-4.5-air` 对它答「0」、对普通字形答「72193」
（六位读对五位）。七段码把「这个模型收不收图」压在了「它认不认得数码管」上，而那一问我们不关心。
换成 5×7 点阵（纯常量，不加字体依赖，每次仍现画随机数字）。
留了 `TestRenderNumberImage` 落盘看图，和 `TestProbeVisionShapeAB` 两种形状各打一发 ——
后者就是这次能定案的原因：`ProbeVision` 判「收图」之后不再打单条形状，那一档从来没被追问过。

### 第 2 步：删掉本机写死的兜底模型（2026-08-23 做完）

三个常量没了：`DEFAULT_IMAGE_MODEL`（`doubao-seedream-4-0-250828`）、`DEFAULT_VIDEO_MODEL`
（`veo_3_1-fast`）、以及改图用的 `EDIT_DEFAULTS`。取而代之的是 `defaultImageModel` /
`defaultVideoModel`：下发说了算 → 下发没说、或**下发那个这把令牌没渠道**时，从当场读到的
`/v1/models` 里挑一个能干这件事的 → 一个都挑不出来才拒绝，并说清是账号侧的事。

**「下发那个用不了就换」这半条是原计划没写的，但它才是这次真正修掉的 bug。**
以前下发一个这把密钥没渠道的名字，用户明明什么都没指定，却会收到一句「这个账号的出图接口上
没有 X」——而同一份目录里躺着三十几个能用的。用户没选过任何模型的时候换一个，不算「静默换掉
用户的选择」；用户点名了的，仍然一个字都不改。

两处对原计划的修正，都是真机逼出来的：

- **原计划说 `fallbackModels` 只是「名字归哪家路由」的表，别混用。现在它多了一个角色：排序。**
  理由是它的既有契约恰好就是「只放真出过图/出过片的名字」——那是全仓库唯一一处关于「这个 id
  我们量过」的证据。但要分清它能做什么：**写死的名字只能参与排序，不能决定**。它是在路由已经
  说完「今天哪些能用」之后才被查的，所以删掉它只损失一个偏好，目录里没有它的密钥照样出图。
  这跟被它挡住是两回事。两个 provider 接口的注释都写了「顺序有意义，别随手重排」。
- **别按 `/v1/models` 的返回顺序推断任何东西。** 原本打算「同一传输内按目录顺序挑，运营在
  控制台排」，真机打脸：同一把令牌连读三次，476 条的顺序**三次都不一样**（Go map 迭代）。
  按它挑等于每次抽签——两次相隔 40 秒的探针分别挑中了 `gpt-image-1.5` 和 `qwen-image-3.0`，
  视频从 `veo_3_1-fast` 变成 `grok-1.5-video`。一个会自己变的默认值，是没人能复现的那种故障。
  现在的兜底排序是 id 字典序：任意，但**稳定**。

顺带被这件事改掉的两处：

- **视频工具的参数表不再绑在「默认模型的形状」上。** 以前 `animate_last_image` 这个参数
  只有在默认模型支持首帧时才挂出来——而默认模型是个写死的名字，于是某台机器一旦下发的是
  纯文生模型，这个参数对**所有**模型都消失了。现在无条件挂出来，按调用逐次拒绝，拒绝时
  从目录里报一个真能用的名字。
- **产物路径的身份从「实际出片的模型」换成「调用方指名的模型」。** 因为 `presentCall` 是
  同步重算的（回放时也算），它读不到目录。继续用实际模型当 key，产物行会指向任务根本没写的
  那个路径。代价是两次都没指名、参数又完全相同的调用共用一个槽位——这恰好是对的，两次都没人
  表达过偏好。

真机复验（`.tmp-probe/default-pick.mjs`，**import 插件真代码**，目录来自线上真令牌）：17/17。
含四条分支——下发可用则原样用、下发的名字目录里没有则改挑、下发的只能图生而这次是纯文字出片
则改挑、目录读不到且没有下发则不猜；外加「把目录条目打乱六次，挑出来的必须是同一个」。
落点是 `doubao-seedream-4-0-250828`（真打一发：HTTP 200 / 13.2s）与 `veo_3_1-fast`——
和从前写死的两个名字一样，但现在它们只是排在最前面，而不是唯一的答案。

### 第 3 步：附件收任意文件，走路径引用（2026-08-23 查清了形状，见下）

照 WorkBuddy 的形状：任意文件进来 → 消息里以路径引用（附一句「用 read 工具打开」）→
模型用 `read_file` / bash 自己读。图片仍走现有多模态轨。

**动手前查到的六条事实，它们把这一步的形状定死了：**

1. **内核有这套机制，但在我们钉的版本之后才有。** `ui-reference` 就是统一的 `@文件` /
   `@会话` 补全（`@path` 语法、原子行内引用、文件与目录分组）。它在 npm 上**最低只有
   `0.1.0-rc.8`**，而其依赖写的是 `^0.1.0-rc.8` 的 `api-remotes` / `client-runtime` /
   `client-ui-input-trigger`——我们全线钉 `rc.6`，装下去会并存**第二份 slots 契约**，
   槽位合并当场坏掉。所以这条能力跟着内核升级来，不是现在写代码能拿到的。
2. **就算升上去也不够。** `@文件` 要用户敲 `@` 去找；拖进来的非图片文件仍会被
   `conversation.input.attachments` 那一槽当图片处理（`ComposerAttachments.tsx:65`
   把 `dataTransfer.files` 整批交给 `onAddImages`），报「仅支持 PNG/JPG/WebP/GIF」。
   所以「拖任意文件」这件事无论升不升级都要我们自己接。
3. **写草稿有正规入口。** `inputActions.setDraft(text)` 是「唯一的公开草稿写入路径」，
   而 `useInput` + `inputActions` 属于**会话标准套件**——任何 `scope: 'session'` 的槽位条目
   都自动拿到（`contract/slots.ts` 的 `SessionStandardProps`）。所以往输入框里插一段路径
   不需要碰内核，也不需要 DOM 黑魔法。
4. **读文件不受沙箱围。** `fs-sandbox` 的三档全是围 **mutation** 的（`read-only` 的定义就是
   「拒绝一切 mutation」）。所以桌面上任意绝对路径都读得动，**不用把字节搬进工作区**——
   省掉一整套暂存、清理与配额。
5. **工具是齐的。** vendored 清单里有 `dsh-tool-fs`、`dsh-tool-fs-search`、`dsh-tool-bash`、
   `dsh-tool-pwsh`。所以「路径进消息」是真能落地的，不是给模型一句它使不上的话。
6. **DSH 的窗口没有 preload。** `window-options.ts` 两处都是 `sandbox: true` 且不挂 preload，
   所以渲染层拿不到 `webUtils.getPathForFile`——而 Electron 43 里 `File.path` 早就没了。
   老壳（`src/preload/index.ts`）反倒**已经有** `getPathForFile` 和 `pickFiles`，可以照抄。

**据此分两步走，先要能用的那半：**

- **3a：「附带文件」按钮。** 在 `conversation.input.left`（内核给「紧挨常驻控件的小控件」留的
  列表槽）放一个按钮，选中的文件交给宿主落盘，返回的绝对路径经 `setDraft` 进草稿。**已完成，
  2026-08-23 真机验过，见下。**
- **3b：拖放。** 在捕获阶段拦下非图片的 drop（内核那两个监听器都在冒泡阶段的 `document` 上）。
  图片仍旧放给内核。**已完成——而且 preload 那半不需要了**：3a 一旦决定搬字节，
  `webUtils.getPathForFile` 就没有用处了，渲染层从 `dataTransfer.files` 拿到的 `File`
  和文件选择器给的完全一样。这条计划里写的前提，被 3a 的取舍消掉了。

升级到 rc.8 之后，3a/3b 只需把插入的文本从裸路径换成 `@"路径"` 语法，其余不动。

验收：选一个 pptx 和一个 mp4，文本模型能说出内容（视频那条以本机有 ffmpeg 为前提）。

#### 3a 落地结果（2026-08-23）

**改了计划里的一处形状：不开 Electron 原生对话框，走渲染层的隐藏 `<input type=file>`，
字节经本插件自己的 RPC 通道（`files.stage`）送到宿主，宿主写进 `~/.dsh/media/incoming/`
并把绝对路径回给按钮。** 原方案想「让主进程开 `dialog.showOpenDialog`，只传路径不传字节」，
省流量；但那要在 `dsh-plugin-desktop` 里新开一个宿主端点，而**上面事实 6 已经说明白：拿到
`File` 的绝对路径本来就需要 preload，而 DSH 的窗口没有**。既然绕不开，选了不动内核那条：
浏览器的 file input 不需要 preload、也不需要 Electron，将来搬去 web 部署时同一份代码还成立
（那边根本没有「路径」可交）。代价是一次请求里多走一份 base64，上限压在 32MiB——
和内核收图那条 `attachment-local.maxImageBytes` 同一个数，两条入口在同一处拒绝。

落盘位置与命名：文件名 = 原名（保留中日韩字符，用户得认得出来）+ 内容 SHA256 前 12 位 + 原扩展名。
**digest 取自内容**，所以同一个文件附两次落到同一份文件，不会堆副本；同名不同内容的两个文件分开放。
扩展名照原名取、不嗅探——模型的工具是按扩展名决定怎么处理它的。

**人设里补了一句**（`persona/tool-reality.ts`，条件是这个 agent 真看得见 `read`）：
消息里的路径是本机真实文件、有权打开、**不受「产出落在工作目录」那条约束**，先 `read`，
`read` 打不开的二进制改用 `pwsh` / `bash`，都不行就说清卡在哪。这三件事缺一件就会退化成
「让用户把内容粘贴过来」。

**真机验（开发版客户端 + CDP 把真文件塞进那个 input，模型是纯文本的 DeepSeek V4 Flash）：**

| 附件 | 判据 | 结果 |
|---|---|---|
| `attach-sample.pptx`（脚本现造，里面写一个**随机**验证码） | 答案里必须原样出现那个码——猜不出来 | 通过：模型自己判断 pptx 是 zip，用 `Pwsh` 解出两页 XML，念出 `YW-402872` 并复述第二页文字。18s / 4 步 |
| `~/.dsh/media/video` 里的一段 8 秒 mp4（文件名是中文） | 报出的时长 / 分辨率 / 帧率要和 `ffprobe` 一致 | 通过：8s、1280×720、24fps、H.264+AAC 全对，还跑了 `signalstats` 推画面偏暖。1m41s / 16 步 |

第二条顺带说明了纯文本模型的成本：它看不见帧，只能靠命令行绕，16 步换来一段描述。
真要「看画面」还是得视觉模型 + 抽帧（WorkBuddy 就是抽帧喂 `image_url`），这条留到以后。

#### 3b 落地结果（2026-08-23，与 3a 同一天）

**拖放不需要 preload——那条前提是 3a 的取舍消掉的。** 计划里写「要给 DSH 窗口加最小 preload
暴露 `webUtils.getPathForFile`」，前提是「只传路径不传字节」；3a 改成搬字节之后，
`dataTransfer.files` 给的 `File` 和文件选择器给的一模一样，同一条暂存路径直接复用。
所以 3b 只剩一件事：**在捕获阶段的 `document` 上拦下带非图片的 drop**
（内核的在冒泡阶段，`ComposerAttachments.tsx:70`），`stopPropagation` 一下，
它那句「仅支持 PNG/JPG/WebP/GIF」就不会冒出来。

分流规则和它的代价说清楚：**整批都是图片 → 原样放给内核**（它有缩略图轨、有预览、有多模态轨，
这些是路径给不了的）；**只要掺了一个非图片 → 整批归我们**，图片也变成路径。
因为内核那个 handler 要么吃下整个 `dataTransfer.files` 要么什么都不吃，拆不开；
而「图片带路径」还能用 `read_image` 打开，「pptx 被内核拒掉」是真没了——两害取轻。
拖拽过程中内核那张遮罩仍会出现、仍写着图片字样：改它要连 `dragenter` / `dragover` 一起接过来、
再画第二张遮罩，这笔账（拖拽中一句错字 vs. 多维护一张遮罩）先记着不动。

真机复验（`.tmp-probe/drop-file.mjs`，用 CDP 的 `Input.dispatchDragEvent` 投**真实文件路径**，
和资源管理器拖进来同一条入口）：

| 拖进去的 | 草稿 | 暂存目录 | 内核那句拒绝 | 内核缩略图 |
|---|---|---|---|---|
| pptx | 出现路径 | +1 个文件 | 没出现 | — |
| png | 空 | 没变 | 没出现 | 1 张 |

第二行是分流规则的另一半：图片照旧走内核，我们一个字都没插。

**拖放这条路顺带逼出两个真缺陷，都已修：**

1. **拒绝只写在按钮的 tooltip 里，等于静默失败。** 点按钮的人指针就在那儿，看得见；
   拖文件的人注意力在窗口中间，`aria-label` 得去悬停才看到。现在同一句话同时进
   **会话通知条**（`notify('error', …)`）——那是内核给「机器外部的通知」留的入口
   （`input/contract.d.ts:50`），而且是**按会话路由**的。它不在会话标准套件里，
   所以照内核自家 `QueueDock` 的做法从 inject 面拿（`QueueDock.d.ts:7`）。
   实测拖一个 40 MiB 文件：按钮和通知条都写「这个文件超过 32MB，没附上」。
2. **`ctx.sessions` 不在本插件的 inject 清单里，直接碰它会抛。** 第一版就这么写的，
   于是拖大文件时异常穿过 `stage`，按钮永远停在「正在附带…」——比原本的问题更糟。
   两处都改了：通知条的绑定放进 `ctx.inject(['sessions'], …)` 的作用域里（拿不到就退回只写标签），
   `stage` 加 `finally` 兜住 busy。**这类「异常吃掉收尾」的形状值得整插件搜一遍。**

**为了槽位类型，插件多了一个 types-only 依赖** `@deepseek-ai/dsh-client-ui-conversation`：
`conversation.input.left` 的契约由它声明，不引入就没法 `register`。这跟 settings / sidebar /
tool 那几个槽位是同一个套路（`import type {} from '…/client'`），运行时不多加载任何东西。
注意本插件的 `summon.ts` 里有一条相反的注释——「`IConversation` 所在的包本插件不依赖」，
那说的是**值**（服务面），结构化地照形状声明就够；槽位名是**类型**，只能靠真依赖拿到。

### 第 4 步：消息形状（2026-08-23 量清了判据，改不在内核这边）

**触发条件就是「两条相邻的 user 消息」，跟图在第几条无关，也跟渠道抽签无关。**
四种形状各打两发（`.tmp-probe/vision-merge.mjs`，`deepseek-v4-flash`，同一把令牌）：

| 形状 | prompt_tokens | 图进去了吗 |
|---|---|---|
| A 单条 `user`（图 + 问题） | 685 / 685 | ✅ |
| B `system` + 单条 `user` | 703 / 703 | ✅ |
| C 多轮 `user` / `assistant` / `user`（图在最后） | 706 / 706 | ✅ |
| D 合并成一条 `user`：上下文 + 图 + 问题 | 703 / 703 | ✅ |
| （`vision-position.mjs`）图 → 纯文本 `user` | 118 | ❌ |
| （`vision-position.mjs`）纯文本 `user` → 图 | 171 | ❌ |

**渠道抽签排除掉了**：回查 `logs`（`user_id = 745453`，那一分钟共 11 条），上面
685/703/706 和 118/171 **全部落在同一个渠道 5976**，只有一发 685 落在 6380。
同一个渠道，只有「相邻两条 user」这一种形状读不到图——单变量。

**内核不会改这个形状，而且在往反方向走。** 上游架构笔记原话：
*Consecutive user-role messages replace one baked prompt message; provider adapters
preserve that ordering*（`.agents/notes/implemented/architecture/2026-07-24-separate-context-injection-from-turn-execution.md:72`）；
运行时上下文快照就是 `createUserMessage(…)` 追加在用户消息之后
（`dsh-agent-loop/lib/index.js:500` + `RuntimeContextProjection.project`），
0.1.1 的 `@会话` 引用还要再加一条相邻 user（`packages/context/session-reference/README.md:35`）。
rc.6 与 0.1.1 都没有「合并相邻同角色」或「快照走 system」的旋钮（搜过 `llm-pi-ai` 与 `agent-loop`）。

**但官方文档把这件事的性质改了（2026-08-23 联网核对）：**

- 官方 `guides/vision` 的「使用限制」只有三条，角色规则只有一条——**图片仅限 `user` 消息**
  （`system` / `assistant` 带图 400）。**没有任何一句限制相邻同角色消息。**
- 官方**确实**有相邻同角色的规则，但只落在 `deepseek-reasoner` 上，而且是**响亮的 400**：
  *deepseek-reasoner does not support successive user or assistant messages (messages[1] and
  messages[2] in your input). You should interleave the user/assistant messages*
  （`deepseek-ai/DeepSeek-R1` issue #21、`BerriAI/litellm` issue #7972 都是这条原文）；
  `deepseek-chat` 系明确更宽松。**「静默丢图」不是任何一种官方行为。**
- 而我们打的那个 `deepseek-v4-flash` 按官方本该 `400 This model does not support image`，
  它却准确答出了图的内容——证明它落在渠道 5976 那台二道贩子中转上（见事实 5 的补注）。

所以这不是「给 DeepSeek 兜底」，是**给一类二道贩子渠道、外加严格 provider（`deepseek-reasoner` 那类）
兜底**。真正对症的一步在上架侧：**官方 8-21 上线的 `deepseek-v4-flash-vision-exp` 我们中转站还没有**
（`/v1/models` 里 19 个 deepseek 名字，没有它）。

**合并相邻同角色消息本身是成熟做法，不是我们发明的：** LiteLLM 就在按 provider 做这件事
（issue #7972 的结论是「it's just necessary compatibility」）；`HKUDS/nanobot` 有一个 PR 标题
与我们要做的一字不差——*fix: merge runtime context into user message to avoid consecutive user
messages*（#1417），报文形状也一模一样（`system` + `user`(runtime context) + `user`(真实消息)
→ 并成一条），理由列的是「省 token、语义更干净、对严格 provider 更安全」。
**注意那个 PR 最后没合**，原因是他们复现不出最初的报错——我们这边是复现得出的（118/171 vs 685/703/706）。

### 结论：这一步不做了（2026-08-23 上午定）——**当天下午作废，见下一节**

**因为能力下发已经把它解决了。** 用户的原话是「我们之前不是做了能力下发的吗，我们中转站
没有这个模型，不接」——查库确认，下发层现存的事实与官方文档完全一致，一个字都不用改：

| 模型 | `input_image` | 与官方文档 |
|---|---|---|
| `claude-opus-4-8` | 1 | 一致 |
| `gemini-2.5-flash` | 1 | 一致 |
| `gpt-4o` / `gpt-4o-mini` | 1 | 一致 |
| `deepseek-v4-flash` | **0** | **一致**（官方：非视觉模型收图一律 400） |

关键就在最后一行：**唯一撞上「相邻两条 user 丢图」的那个模型，我们本来就下发成不收图。**
所以发图这条路根本不会走到它——会走到上面四个，而那四个在探针里对相邻 user 消息全都正常
（`vision-merge.mjs` 的 C 行：多轮 `user`/`assistant`/`user` 也正常）。报文形状这件事
**没有真实用户会踩到**，做了是给一个我们不投递的组合兜底。

留一条记录，等以下任一条成立再回来做：中转站上架了官方 `deepseek-v4-flash-vision-exp`；
或下发清单里出现某个「能收图但落在会丢图的渠道上」的模型（判据：探针那一维报
`shape_blocked` 而不是 `input_image=false`）。

原本考虑过的两个落点，留着备查：

- **中继（`new-yunwu-api`）**：转发前把相邻同角色消息合并——**只对带图的请求做**，
  血量最小，且所有客户端（含 WorkBuddy 用我们令牌的那批）一起受益。
  已确认不是中继丢的：`deepseek` 适配器原样转发（`relay/channel/deepseek/adaptor.go:44-49`），
  118 这个数是上游返回的 usage。
- **客户端 `agent/pre-step` 钩子**：把快照那条并进用户消息。但它跟内核的设计对着来——
  `RuntimeContextProjection` 靠「自己那条 owned 消息落库」记 `retained`，并掉之后每轮都会重发快照，
  而且只救我们这一个客户端。

**倾向中继那条。** 验收不变：客户端第一轮发图 → `logs` 里 prompt tokens 跳到几百量级，
且答案与图一致。

### 重开：上面那条「不做」的前提当天就被真机推翻了（2026-08-23 下午）

上面写的重开条件是：*下发清单里出现某个「能收图但落在会丢图的渠道上」的模型（判据：探针那一维报
`shape_blocked` 而不是 `input_image=false`）*。补数据时随手探的四个模型里就中了三个：

| 模型 | 客户端形状（两条相邻 user） | 单条 user | 判定 |
|---|---|---|---|
| `kimi-k2.5` | 逐字答对 | 不用打 | 收图 |
| `glm-4.5-air`（**已下发状态**） | 答「未提供图片」/「无法识别」/「0」，prompt tokens 仍 +531 | 逐位答对 | **被形状挡住** |
| `glm-4.6` | 同上 | 逐位答对 | **被形状挡住** |
| `qwen3.8-max` | 答一个不相干的「7」 | 逐字答对 | **被形状挡住** |

所以「只有那条二道贩子 DeepSeek 渠道会丢图」是错的：**四个里中三个，横跨智谱与通义两家**，
而且其中一个已经是下发状态。这一步重新开着。

**代价现在是可量的**：被形状挡住的模型，我们只能下发成「不收图」——用户发图会走
第 5 步那条 `image_ask` 代看（能用，但多一跳、多一次计费，且看图的不是他选的那个模型）。
修好形状之后这批直接翻成原生收图。

**落点仍倾向中继**（理由不变：血量最小、所有客户端一起受益），但多了一条今天才清楚的约束：
**本地中继没有承载渠道，改完在本地验不了通不通**——只能在线上站验。

#### 批量探针给出了占比：能测出结论的里面，**一多半是被我们自己挡的**

把这把令牌够得着的 68 个模型全打了一遍（vision 单维，分两批 55 + 9，用真实用户令牌写真结论）：

| 判定 | 条数 | 含义 |
|---|---|---|
| 收图 | 8 | 客户端形状下直接读对图 |
| **被形状挡住** | **18** | 换成单条 user 就逐位读对；我们发两条相邻 user 时它答「未提供图片」或不相干内容 |
| 真不收图 | 7 | 两种形状都读不出 |
| 没结论 | 34 | 分组上游 429 饱和，跟能力无关，回头补 |

**补测过一轮，没补上**（同日 17:00，38 条重打）：0 新建 0 更新，33 条仍是
`当前分组上游负载已饱和`。所以这批不是「今晚忙」，是**这把令牌的分组根本没承载它们**——
llama 全家、`deepseek-r1` 各变体、`glm-5.x`、`qwen3.6/3.7` 都在里面。要么换一把够得着
那些渠道的令牌，要么等它们真正上架；照判据它们一个字都不该写库。

被挡住的 18 个横跨五家：`deepseek-v3-1` / `deepseek-v4-flash` / `deepseek-v4-pro`(+`-0813`)、
`glm-4` / `glm-4-airx` / `glm-4-long` / `glm-4.6`、`kimi-k2-0711-preview` / `kimi-k3`、
`MiniMax-M3`、`qwen-plus` / `qwen-turbo` / `qwen3-235b-a22b` / `qwen3-30b-a3b-think` /
`qwen3.6-27b` / `qwen3.8-max` / `qwq-72b-preview`（`glm-4.5-air` 已上架被探针跳过，实测也是这一类，
所以真实数字 ≥19）。

**所以这不是边角料**：能测出结论的 33 个里 18 个（55%）现在被下发成「不收图」，
纯粹因为我们比别人多发了一条相邻的 user 消息。修掉之后这批直接翻成原生收图，
省掉 `image_ask` 那一跳。

> **2026-08-23 傍晚补一刀，量级又变了。** 靶子改成跟目标站同源之后重扫（297 条，见第 1.8 步），
> 又中 **16 条**，而这批的名字改变了这件事的性质：**`gpt-5` / `gpt-5.1` / `gpt-5.2` /
> `gpt-5.5` / `gpt-5-codex` / `gpt-5.1-codex` / `gpt-5.6-sol`(+`-max`/`-ultra`) /
> `gpt-5.6-terra`(+`-max`/`-ultra`)**，外加 `deepseek-v3.1` / `deepseek-v3-1-250821` /
> `glm-4.5-air` / `qwen3-vl-8b-thinking`。
>
> 也就是说 **GPT-5 全家都在被我们自己挡着**。当初判断「这一步不着急」的依据是
> 「唯一撞上的那个模型我们本来就下发成不收图」——这条依据现在不成立了。
> 中继那个合并已经实现、单测过、真机 4/4，**只差上线**；上线后这 34 条要重探一轮翻回来。

#### 内核这边先查了，没有现成旋钮

`dsh-system-prompt` 只给了 `suppressRuntimeContext()`——**整条快照不发**，不是「并进系统提示」；
`dsh-agent-loop` 的 `RuntimeContextProjection.project()` 写死了 `createUserMessage(...)`
并且把它作为归自己所有的消息提交进会话（靠 `retained` 去重）。也就是说形状是内核有意为之，
改不动，只能在它下游改：

- **中继侧**：转发前把相邻同角色消息并成一条（可只在带图请求上做）。血量最小、所有客户端受益，
  但本地验不了，要上线上。
- **客户端侧**：`ctx.llm.registerAdapter(providers, adapter)` 是公开接口，我们可以给自己的
  `openlux` 路由挂一个适配器，在进 wire 之前合并。当天就能真机验，但要么代理 pi-ai 那个适配器，
  要么自己重写一遍协议——得先确认能不能只做一层壳。

#### 落点定在中继，已实现（2026-08-23）

改动三处，都在 `new-yunwu-api`：

| 文件 | 干什么 |
|---|---|
| `dto/message_shape.go` | `RequestHasImage` + `MergeAdjacentUserMessages`：把每一段连续的 user 折成一条 |
| `relay/relay-text.go`（`getAndValidateTextRequest` 的 chat 分支，图片代理之后） | 带图请求才调，纯文本一个字节不动 |
| `setting/model_setting/global.go` | `merge_adjacent_image_messages` 开关，默认开，出事一键退回 |

两个刻意的取舍：

- **不走 `ParseContent()` 重建内容，直接拼原始块数组。** 那个函数只认它列举过的字段，
  往返一次就会把 OpenRouter 的 `cache_control` 这类东西吃掉（`dto/openai_request.go:394-497`
  的 switch 里没有它）。同一处的图片代理逻辑已经在付这个代价了，我们不再多付一份。
- **带 `name` / `prefix` / `tool_calls` / `tool_call_id` 的 user 消息不参与合并。**
  这些字段把消息绑在某个说话人或某次工具调用上，并进别人身上就不是同一条消息了。

本仓库早有先例：Claude 适配器就在合并相邻同角色消息（`relay/channel/claude/relay-claude.go:609-644`），
只是它那处要求两条都是纯文本（`:628`），恰好把「第二条带图」排除在外。

**真机验了，4/4 全中**（`llmprobe/openaiprobe/suites_vision_merged_test.go`，对着线上站打）。
关键是这一发此前没人打过：探针的「单条 user」形状是**丢掉运行时上下文**的干净一发，
而中继合并出来的那条消息里，上下文作为第三个 text 块留在图后面——

| 模型 | A 客户端现状 | B 中继合并后 | C 探针基线 |
|---|---|---|---|
| `glm-4.6` | 答「0」 | **414396 ✓** | 414396 ✓ |
| `qwen3.8-max` | 答「42」 | **635629 ✓** | 635629 ✓ |
| `deepseek-v4-flash` | 「当前模型不支持图像」 | **743926 ✓** | 743926 ✓ |
| `glm-4.5-air` | 答「0」 | **741648 ✓** | 741648 ✓ |

B 与 C 同样答对，说明「一条消息里两个 text 块、图夹在中间」这个形状上游认。

**透传会绕开这段改写**（`relay-text.go:360-376`：全局 `PassThroughRequestEnabled` 或渠道
`pass_through_body_enabled` 打开时原始 body 直送上游）。查了线上：538 条在用渠道里只有 5 条开了透传，
**没有一条承载 glm / deepseek / qwen / kimi / MiniMax**；`options` 表里也没有全局透传那一行，
即取默认关。所以这条路对受影响的流量是通的。

#### 补验：**不上线也能验整条链路**（2026-08-23 傍晚，本地站 A/B）

上面 4/4 那一发是**手搓形状直连线上**打出来的，证的是「上游认合并后的形状」，
没证「我们中继真的把线上的报文改成了那个形状」。这一环单测替代不了：单测喂进去的
`Message.Content` 是手搭的，真机那条要先过图片代理的 `SetMediaContent`、再过序列化。

补法是给本地站挂一条**指向线上站**的渠道（详见参考册 `platform-data.md` 的「第四扇门」），
链路成「本地中继（带改动）→ 线上中继（无改动）→ 真上游」，同一形状只切我们自己的开关：

| `global.merge_adjacent_image_messages` | glm-4.5-air | deepseek-v3.1 |
|---|---|---|
| `true` | READ `507715` | READ `507715` |
| `false` | MISS「0」 | MISS「无法识别」 |

关的那腿还从日志里读到了转发出去的原文，`converted text requestBody` 里确实是两条 user
（`user:arr2 , user:str`），即开关关掉是真的一字不改。

顺手记两个把我误导过的判据坑，都写进参考册了：**选项改完 60 秒才生效**（我因此连误判两轮）、
**prompt_tokens 是中转站自己算的**（同一张图两个厂商都回 597，不能当「图进去了」的证据）。
另外单测补了一条：真机的顺序是**图那条在前、上下文那条在后且是纯字符串**，原来那条只钉了反序
（`relay/message_shape_live_shape_test.go`）。

**还没做完的一步：上线后要重探一轮，把那 18 条从「不收图」翻回来。** 探针本身是打中继的，
所以中继一合并，探针的「客户端形状」那一发也会被合并——同一套判据会自动给出新结论，
不需要为这件事改探针。`deepseek-v4-flash` 会因此翻成收图，注意它翻的是**我们中继上这条渠道的事实**
（渠道 5976 那台二道贩子替换了模型），不是官方 DeepSeek 的能力。

### 第 4.5 步：图轨里已经有图、再切成纯文本模型（2026-08-23 落地）

前面那套按「放进来的那一刻选的是哪个模型」路由，剩下反过来的顺序没管：**先在视觉模型下把图
放进图轨，再切模型**。内核跨模型切换保留图轨，于是那张刚才还合法的图，要到回车时才撞上
`MODEL_DOES_NOT_SUPPORT_IMAGES`，图就丢了。

改法是盯住这件事的两半——图轨和选型——任何一半变了就重新路由一次
（`client/AttachFileButton.tsx` 的 `rerouteRail`）：

- 选型变了：`client/selection.ts` 新增 `watchModelChoice`，订阅的就是选择器自己写的那个 store。
- 图轨变了：图是在能力清单还没到时进的轨（那种情况按设计交给内核），清单一到也要复查。
- 能力清单刚拿到：同理，`warm()` 之后补一次。

转的时候用内核自己的两个口子：`inputActions.removeImage(id)` 把 id 从输入态摘掉，
再 `conversation.releaseDraftImage(id)` 放掉预览的 object URL——顺序不能反，
否则会有一帧在渲染已经被吊销的 URL。取图靠 `conversation.draftImages(ids)`，
因为输入态只存 id，`File` 在会话服务的草稿注册表里。

**静默转，不发通知**，与放图那条一致：路径出现在草稿里、图从轨上消失，本身就是反馈。

真机验过（`.tmp-probe/rail-then-switch.cjs`）：Claude 下拖图 → 图轨 1 张；切到 DeepSeek V4 Flash
→ 图轨 0 张、草稿里出现 `C:\Users\000\.dsh\media\incoming\drop-secret-e14b751d52eb.png`（字节数
与原图一致，8998）；回车 → DeepSeek 调 `image_ask` → 转述里带着图中的 `410800`。

### 第 5 步：纯文本模型也能看图（2026-08-23 落地）

用户把原则重申了一遍：*对话模型不能改图或者完成其他任务，就应该直接用对应的下发模型
以及令牌能使用的对应模型进行解决*。出图、出片早就是这么做的（挑下发里能画的那个），
**看图是同一形状的第三例**，所以做法照抄，不发明新机制。

**先查了「升级内核能不能省掉这摊事」，结论是不能**，三条独立事实（rc.8 源码）：

| 事实 | 出处 |
|---|---|
| 线上模型目录不带模态：`ModelCatalogModel` 只有 id / name / description? / reasoning? | `packages/host/apiproxy/src/api/sessions.ts:120-129` |
| 整个 `packages/client` 里 `inputModalities` 命中 **0**，拒绝只发生在发送那一刻 | `api-proxy.ts:2402-2408` |
| 拖放仍只收图片，且 `canAcceptDrop = !locked && !machineBusy && addImages !== undefined`，与模型无关 | `ui-attachment/src/client/ComposerAttachments.tsx:65,70`、`ui-conversation/.../InputBar.tsx` |

升级**能省**的只有人设里那半句：`@file` 自带
`FILE_REFERENCE_PROMPT`（`context/file-reference/src/index.ts:18`），措辞和我们那条几乎一样。
但它按 session cwd 划边界，桌面 / 下载目录的文件仍得走我们这条暂存路径。上游也**没有**
任何「让能看图的模型代看一眼」的工具（`image_ask` / `describeImage` / `visionFallback` 命中全 0）。

**两件东西：**

1. **`image_ask` 工具**（`media/ask-tool.ts` + `media/vision.ts`）。参数是**路径**不是会话附件——
   会话里已经有的图，说明这条路由本来就收图，调用方自己看得见。挑模型的依据是
   `settings` 里 `providers.<route>.models[].input` 含 `image`，也就是「装机目录 → 下发覆盖 →
   用户改」三层合并后的结果，跟内核发送时那道闸**同一份事实**，所以挑出来的模型必然过闸。
   **只回文字**：`contentHasImage` 会下钻工具结果（`llm/llm/src/content.ts`），把图塞回去等于
   把调用方的会话变成「只能在视觉模型上继续」的会话——`media/tool.ts` 早就记过这个陷阱。
   请求只发**一条 `user`**，正好绕开第 4 步那个形状问题，且不是为它设计的。
2. **拖图分流**（`client/AttachFileButton.tsx` + `client/selection.ts` + 宿主 `files.vision`）。
   拖进来的整批都是图片时，看当前模型收不收图：收，原样放给内核（缩略图轨/预览/多模态轨
   都是路径给不了的）；不收，按文件走暂存路径，并在通知条说清「当前模型看不了图，已按文件
   附上路径」——否则用户看到的是「拖进去只出来一行字」，像坏了。
   **能力与选择分居两处**：浏览器只知道选了谁（`ctx.modelDirectories`，就是选择器渲染的那个 store），
   只有宿主知道收不收图（上表第一条）。任一半未知就交回内核——它至少会响亮地拒绝。
   还有个坑：**新会话里 `current` 是 `null` 直到有人问过一次**，所以 `modelChoice` 在落空时
   顺手 `load()`，按钮则在 `dragenter` 时先问一遍，等 drop 那一下答案已经在。

**真机验（CDP，同一张 12495 字节的 png，同一条 `Input.dispatchDragEvent`）：**

| 当前模型 | 草稿 | 内核缩略图 | 通知条 |
|---|---|---|---|
| DeepSeek V4 Flash（下发 `input_image=0`） | 出现 `~/.dsh/media/incoming/ask-sample-6468b01b1394.png` | **0** | 「当前模型看不了图…」 |
| Claude Opus 4.8（下发 `input_image=1`） | 没变 | **1** | 没有新增 |

`image_ask` 自身也真机验过：DeepSeek V4 Flash 读出图里的随机码 `769305`，
回查 `openlux_log` 是 `claude-opus-4-8` 收的费——确实是别人代看的，不是它自己蒙的。

**整条链再走一遍（用户视角，`.tmp-probe/drop-then-ask.cjs`）**：当前模型 DeepSeek V4 Flash，
拖入一张当场画的随机码图（`410800`）→ 草稿出现 `~/.dsh/media/incoming/drop-secret-e14b751d52eb.png`
→ 打字问「这张图上的数字是多少」→ 会话里出现 `image_ask · …drop-secret-….png`，答 `410800`。
拖图、分流、代看、回答四段一次跑通。

**通知条那句撤了（用户 8-23 定）**：路径落进草稿本身就是反馈，每贴一张图都要读一行解释
是负担。失败仍然会说话（走 `refuse`）。**撤掉它还顺带修好了一件事**——见下。

**「图轨里留着图 + 纯文本模型」这件事，我上一轮说错了，量清如下**
（`.tmp-probe/rail-then-switch.cjs`，Claude 上贴图 → 换 DeepSeek → 打字 → 回车）：

| 读数 | 值 |
|---|---|
| `textarea.disabled` / 发送按钮 `disabled` / 占位符 | `false` / `false` / 正常（**没有** composer block） |
| 回车之后 | 草稿原地不动、图仍在图轨 |
| 屏幕上 | **「当前模型不支持图片，请切换支持图片的模型」** |

所以内核**是说话的**，不是静默。我上一轮看不到那句，是因为**我们自己那条 info 通知占着同一条
通知条**，把内核的拒绝盖掉了——这正是「加提示反而更糟」的实例，也是撤掉它的第二个理由。

剩下的是「只给了换模型这一条路」。**这一半我们眼下接不了**：图轨的 `draftImages` /
`removeImage` / `addImages` 都在 `ComposerBarInjected` 里（`contract/slots.d.ts:529-537`），
那是 composer-bar 那个座位的**包内私有面**，`conversation.input.left` 拿不到；能拿到的只有
DOM 里那些 `blob:` 缩略图，而伸手去读内核自己的 DOM 是我们明确不做的事。
**记进升级收益**：0.1.1 把附件所有权改成槽位（`conversation.input.attachments`），到那时才有正经缝。

### 粘贴也走同一条分流（2026-08-23）

拖放修好后才发现**图轨还有第二个入口**：textarea 自己的 `onPaste` 把剪贴板里的文件交给同一个
`intakeImages`（`ui-conversation/lib/client.js:3542-3546`）。所以纯文本模型下粘贴一张截图，
是和拖放一模一样的死胡同。按同一条规则接上，捕获阶段拦 `paste`。

两条边界写死在实现里：**剪贴板里同时有文字就整个让给内核**（它的粘贴是一个带撤销和引用
chip 的草稿事务，`pasteBegin`，抢走一半会把文字那半弄坏；而截图粘贴本来就不带文字）；
**能力读数靠 `focusin` 预热**——粘贴没有任何前兆，Ctrl+V 的 keydown 只早几毫秒，不够跑一趟 RPC，
而点进输入框通常早好几秒。

真机验（`.tmp-probe/set-clipboard-image.ps1` 把图放进系统剪贴板，`paste-route.cjs` 真按 Ctrl+V）：

| 当前模型 | 草稿 | 内核图轨 |
|---|---|---|
| DeepSeek V4 Flash | `…/incoming/image-3bb153d3d30b.png` | 0 |
| Claude Opus 4.8 | 空 | 1 |

**顺带记一条探针技巧**：模型选择器是两步（先弹「模型 / 推理等级」，再出清单），
且 `Input.dispatchMouseEvent` **必须带 `buttons: 1`**，否则 React 不认这一下，
症状是「清单里没有这个模型」而不是报错（`.tmp-probe/click-path.cjs`）。

### 第 6 步：文档也走同一条路 —— 交给能收文件的模型（2026-08-23 落地）

图那条通了之后剩下的窟就是文档。**先查参考实现，四个来源都有据**：

| 来源 | 它怎么做 | 对我们的意义 |
|---|---|---|
| **DSH 内核** | `dsh-tool-fs/README.md:171` 明写 `read` 只吃 UTF-8 文本、图片走 `read_image`、**PDF/音频/视频 deferred**；附件层只认 4 个图片 MIME | 内核有意留空，没有旋钮可拧 |
| **WorkBuddy / CodeBuddy** | 官方插件市场装着 Anthropic 那套 `pdf`/`pptx`/`xlsx` **技能**：教模型用本机 `pypdf` / `pdfplumber` / `pdftotext` 自己解 | 前提是机器上有 Python 和那些库，我们的用户没有 |
| **Claude Code** | `utils/pdf.ts` **原生处理**：首选整份读成 base64 交给模型（校验 `%PDF-` 魔数、上限 ~20MB，因 API 总量 32MB 而 base64 涨 1/3），模型不吃时用 poppler `pdftoppm` 把每页渲成 JPEG | 形状照它，但**去掉栅格化**——Windows 上没 poppler，而我们有更好的第二档：换个收文件的模型 |
| **官方文档**（联网查） | Chat Completions 的 `file` + `filename` + `file_data` 就是正式形状；**PDF 抽「文本+页面图」（需视觉模型）、docx/pptx/txt 只抽文本、表格类走单独流程**；单文件 < 50MB；`detail` 只在 Responses 有 | 我们发的报文形状本来就对；「PDF 优先给能看图的模型」有文档依据 |

**没选技能那条路的理由是量出来的**：丢一份 PDF 给纯文本模型（无本机工具）= 3 分钟 / 13 步 /
16.2 万 token，还是没读出来，顺手往工作区拉了个临时脚本。装 Python 这件事我们做不到。

落地：`media/documents.ts` + `media/doc-tool.ts`，工具名 `document_ask`，和 `image_ask` 同一形状
（路径进、文字出、图/文档都不进会话内容）。接受的扩展名照官方那张表（pdf/doc/docx/rtf/odt/
xls/xlsx/ods/ppt/pptx/odp），**纯文本和代码故意不收**——内核 `read` 免费就能读。上限 20MB 生料，
理由同 Claude Code。PDF 校验 `%PDF-`、OOXML 校验 zip、旧版 Office 校验 OLE2，因为**无效文档块
一旦进历史，后面每次请求都 400，不清会话就废了**（这条坑是 Claude Code 记下来的）。

候选还是两级：**先下发清单**（本机 settings 里 5 条全是 `openluxManaged: true`），全拒了才落到
`/v1/models` 里令牌能调的对话模型、最多再试 3 个；拒过的记在进程里，同一会话不重复烧。

**真机验（同一份现造的文档，暗号只存在于这一次的字节里）**：

| 场景 | 结果 |
|---|---|
| PDF，模型 DeepSeek V4 Flash | **15 秒 / 2 步 / 2.24 万 token，答对 `106793`** —— 对比改之前的 3 分钟 / 13 步 / 16.2 万 token 没答上 |
| 谁代读的 | `gemini-3.1-pro-preview`（claude 那一发失败后失效转移接住） |
| docx，同一个模型 | 24 秒答对 `350559`，代读的是 `gpt-5.4`（跨过 claude 500 + gemini 拒 mime，工具内共 4 秒） |
| 回复里有没有漏机制 | 没有：只回数字，不提路径 / 工具名 / 代读模型 |

**这一轮真机抓到一个纸面上看不见的缺陷**：五个下发模型打同一份 PDF——

| 模型 | 结果 |
|---|---|
| claude-opus-4-8 | 500 `image url is nil for media message type: file` ← **我们中继的适配漏洞** |
| gemini-3.1-pro-preview | 读到 |
| gpt-5.4 | 读到 |
| deepseek-v4-flash | 429，老实说 `Invalid value: file. Supported values are: 'text','image_url','video_url' and 'video'` |
| **deepseek-v4-pro** | **200，却回「I cannot see any document. Please upload…」** |

最后那条是真陷阱：附件被静默丢掉，模型照样流畅答话，而我原来的代码只要拿到非空文字就当成功——
用户就会拿到「我看不到文档」当答案。已加否认识别（判据照搬 admin-server 探针里的 `deniesSeeing`），
命中就记成拒收、换下一个；模式刻意只认「文档本身没到」，「文档里没有验证码」是真答案，不能误杀。

顺带把排序改了：原先只对 PDF 把能看图的排前面（文档依据），实测**这条线路上对所有格式都成立**
（两个能看图的读到了，两个纯文本的都失败），所以统一按「能看图的优先」，纯文本的留在末尾不删掉——
它们的 `input` 说的是图片，不是附件，线路哪天开始收文件不该需要发版。

**因此 claude 那条中继适配从「可选」升级成该做**：它在 PDF 排序里是第一个，每份 PDF 都白赔一发
（好在中继侧 1.3 秒就失败，不烧上游）。Anthropic 原生支持 PDF document 块，是我们适配层没接。

### 第 7 步：中继给 claude 补上 document 块（2026-08-23 落地）

`relay-claude.go` 的 OpenAI→Claude 转换里，`text` 之外一律走图片分支，`file` 部件没有
`image_url`，于是整条请求 500 报 `image url is nil for media message type: file`——**读起来像
「模型不支持文档」，其实是我们缺一段**。形状**先查官方文档再写**：base64 的 `document` 源
**只收 `application/pdf`**，纯文本要走 `source.type: "text"` + `media_type: "text/plain"`，
**`.docx` / `.xlsx` 官方明说 document 块不支持**（原话是让调用方自己先转文本）。所以不支持的格式
当场报清楚是什么 mime 不行，让上层换模型，而不是硬送给 Anthropic 换一个更难懂的 400 回来；
`file_id` 也直接拒——那是 Anthropic Files API 的凭据，我们没代理那套上传。

验的办法是**本地站再开一扇门**：原来那条回环渠道是 OpenAI 兼容类型（type 1），走不到这段适配；
这次建的是 **Anthropic 原生类型（type 14）指向线上站**，链路成了「本地中继（带改动）→ 线上
`/v1/messages` → 真上游」，改动被夹在中间。加上 4 条单测（PDF→document、纯文本→text 源、
docx→报清楚 mime、file_id→拒），加真机：

| 场景 | 改前 | 改后 |
|---|---|---|
| PDF 给 claude-opus-4-8 | 500 `image url is nil` | 200，报文里带完整 document 块（日志 `converted text requestBody` 可见，data 以 `JVBERi0x` 即 `%PDF-` 开头） |
| docx 给 claude-opus-4-8 | 500 `image url is nil`（误导） | 500 `claude document block only accepts application/pdf or text/*, got application/vnd.openxmlformats-…`（0.27 秒，说清原因） |

**但真机顺手挖出一件更要紧的事：我们的 claude 供给读不了 PDF，坏法还有两种。**
同一份现造的 PDF、完全原生的 Anthropic 报文（绕开一切转换）打线上四个 claude：

| 模型 | 结果 | 说明 |
|---|---|---|
| claude-opus-4-8 / 4-7 / sonnet-4-6 | 200、**4.5 秒**、`input_tokens` 只有 **2~6**，回「PDF 里的文字像被编码或错位了，读不出来」 | 上游自己抽了文本再喂模型，子集化字体抽成乱码；28KB 的 PDF 不可能只值 2~6 token |
| claude-opus-5 | 200、34 秒、118 token，「我没有看到任何文档」 | 整块被丢 |

第一种对客户端是**新陷阱**：它不说「没收到文档」，说的是「读不出来」，**原来的否认识别抓不到**，
这句就会被当成答案交给用户——比原来那个 500 还糟。所以判据加了第二族「读不出来 + 乱码/编码/损坏
**同时出现**」才算失败；两半都要，因为单独任一半都是真答案（「文档里没有验证码」是结论，
「合同里有个编码字段」是内容）。这一族连同中文那条一起钉进了 `tests/document-denial.spec.ts`，
用的全是真机原话——**写单测的时候还抓到旧中文模式的一个漏**：模型说的是「我没有看到**你上传的**
任何文档**或图片**」，动词与名词之间隔了字、`图片` 也不在名词表里，所以放行了；顺手补了插入语
和名词，并排除「文档**里/中**没有」这种读到之后的结论。

真机复验（客户端整链路，两发新造 PDF）：**13~15 秒 / 2 步 / 2.24 万 token，都答对**，
代读的是 `gemini-3.1-pro-preview`。注意**客户端打的是线上站**，线上还没带这次中继改动，
所以现在 claude 那一发仍是 1.3 秒 500；上线后会变成 4.5 秒的乱码回复，由新判据接住。

**留下来的取舍，查完参考实现之后结论反了（2026-08-23）**：本来排了一件「把能不能读文档做成下发
维度」的活，先去查了四个来源，一致指向**不该做**，于是停手：

- **上游 openclaw 自己有这套东西，但挂在厂商上**——`nativeDocumentInputs: ["pdf"]` 一家一行
  （anthropic / google，openai 是空数组），配 `documentModels.pdf.image: false` 和内建 `pdf`
  工具的运行时兜底。不是「每个模型一格」。
- **Claude Code 只用一条已知不行的名单**（`utils/pdfUtils.ts:59`：不是 claude-3-haiku 就算支持），
  默认全开、按 provider 分支、允许部署方用环境变量覆盖，还留着 TODO 想做「靠 API 报错探测」。
- **models.dev / LiteLLM 有这种表，但键是厂商 × 模型**，models.dev 更是把「模型自身事实」
  和「某家怎么供」拆成两个文件。
- **我们跑的 DSH 把上游那套整体砍了**（`nativeDocumentInputs` / `mediaUnderstanding` /
  `PdfToolSchema` 零命中；正面对照 `read_image` 有命中）。所以 `document_ask` 不是重造一个
  本来能打开的开关。

判据落成两句，记在参考册里：**这个事实属于模型还是属于我们这条路**（PDF 属于路——Anthropic 原生
支持，坏的是渠道，写成 per-model 字段 ops 换渠道就错，也表达不了同名模型不同渠道），
**以及能不能事后判出来**（文档失败写在答案里，判据抓得到；「收不收图」事后判不出来，才值得建表）。
所以现在什么都不加，靠进程内的拒收记忆兜着：同一会话只赔第一发 4.5 秒。

---

## 五、不做什么

- **不在本机做文件解析 / OCR。** 三个参考实现里只有 WorkBuddy 装的那套技能这么做，它依赖本机
  Python 工具链；Claude Code 的首选路也是把整份文档交给模型，栅格化只是它的兜底。我们连
  poppler 都没有，所以只保留「交给能收文件的模型」这一条。
- **不打包 ffmpeg / poppler。** 先接受「本机装了才有视频理解」，拒绝话术里说清楚。
- **不再引入第二张本机能力表。** 包括「识图」标签——事实 4 已经证伪。
