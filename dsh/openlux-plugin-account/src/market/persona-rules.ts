/**
 * The corrections an imported persona needs in its own prose.
 *
 * ## Why this is a module and not a build script
 *
 * These packages reach this product through two doors. The 22 that ship in the
 * box are materialized at build time by `dsh-plugin-desktop/scripts/
 * materialize-expert.mjs`; the other ~400 are installed at runtime by
 * `market/install.ts` and composed by `market/compose.ts`. Both write a persona
 * to disk, so both need the same corrections — and until this module existed
 * only the first one had them, which meant the entire published catalog
 * installed with `SendMessage` mandates and model names this route cannot serve.
 *
 * The rules live on this side of the fence because the runtime path cannot
 * import a build script, while a build script can import a shipped module.
 *
 * ## What belongs here and what does not
 *
 * Only what is wrong *in the text*: a tool name we spell differently, a model
 * that does not exist, an instruction to use a mechanism this kernel has no
 * equivalent for. What this build currently *offers* is deliberately not here —
 * that is stated once at runtime, from the visible tool set of the agent being
 * assembled (`persona/tool-reality.ts`), because a snapshot of it written into a
 * document goes stale the moment a tool is added.
 *
 * ## Two callers, two severities
 *
 * The build-time caller turns every finding into a build failure: those 22
 * packages are curated, a stale rule means upstream reworded, and a human is
 * standing there. The install-time caller cannot do that — refusing an install
 * because somebody else's expert says `present_files` would take a working
 * expert away from the user over one wasted tool call, which the runtime
 * tool-reality section already denies by name. So the checks here *report*, and
 * each caller decides: structural faults (a `{{…}}` the prompt registry cannot
 * resolve, which breaks every turn) refuse; wording faults are logged.
 *
 * @module openlux-plugin-account/market/persona-rules
 */

/** One exact-string correction, keyed to a package's current wording. */
export interface Fix {
  /** Why this sentence had to change; quoted back when the rule goes stale. */
  readonly why: string
  /** The exact text to find. Exact, not a pattern — see {@link FABRICATION_FIXES}. */
  readonly find: string
  /** What it becomes. */
  readonly replace: string
}

/** One pattern-based correction, applied to every package. */
export interface Rewrite {
  /** What to look for. */
  readonly find: RegExp
  /** Replacement text, or a function of the match when it needs the captures. */
  readonly replace: string | ((...args: string[]) => string)
}

/**
 * Prefixed to every markdown file inside an imported skill.
 *
 * The reference guides are the part worth importing — mood boards, prompt
 * formulas, shot design — and that craft is unaffected by which vendor serves
 * the pixels. Only their tool and model tables are fiction, so the documents
 * stay and get a header that says which half to trust.
 */
export const SKILL_DOC_NOTE = `> **注意**：本文档来自 WorkBuddy。它提到的工具名、模型名与厂商 CLI / API key
> （\`HY-*\` / \`YT-*\` / \`ImageGen\` / \`ImageEdit\` / \`YT-VITA\` / MiniMax 那套
> \`MINIMAX_API_KEY\` 之类）在本机一个都不存在，也没有配。本机出图只有
> \`image_generate\`，出片只有 \`video_generate\`；模型不填就走验过的默认值，
> 只有用户点名了才把他说的名字原样填进 \`model\`。下文的创作方法论照用，
> 工具与模型部分一律以工具自己的说明为准。`

/**
 * Names that only exist in WorkBuddy, used to decide which docs need the note.
 *
 * The note exists to correct these, so a document that never mentions one needs
 * no correcting — and pasting it onto, say, an OpenXML element-order reference
 * would be noise at the top of a file about something else entirely. The first
 * pass did exactly that to 40-odd documents across five skills, which is how
 * this predicate came to exist.
 */
export const FABRICATED_NAMES = /HY-(?:Image|Video)|YT-(?:Video|VITA)|ImageGen|ImageEdit|多模态内容生成|youtu-vita|MiniMax|MINIMAX_API_KEY|Hailuo/

/**
 * Sentences that would fail on this machine, and what they should say instead.
 *
 * ## Why rewrite these when the runtime tool-reality section already outranks them
 *
 * A paragraph saying "ignore the model names below" handles a name. It does not
 * handle a *mandate* or a *misdirection*, and the imported package has both:
 *
 * - `必须通过 SendMessage 将完整结果回传` — an instruction to use a tool that was
 *   never registered. Costs a turn discovering that.
 * - `人物场景必须用 YT-Video-HumanActor` — 必须, for a model this route cannot serve.
 * - `直接说出你的生成意图，WorkBuddy 会自动识别并调用对应工具` — the dangerous one.
 *   It tells the agent that *saying* it will draw is enough, which produces a
 *   turn where nothing is called and the user is told a picture is coming.
 *
 * ## Why exact-string replacement, and why it is asserted
 *
 * These are somebody else's documents and a re-import brings their next version.
 * A loose pattern would keep matching after upstream changed the meaning; an
 * exact string stops matching, and {@link scrubFabrications} turns that into a
 * build failure naming the fix that went stale. So the failure mode of this
 * table is a loud one, and until then the artifact needs no hand editing —
 * which is the whole point, since hand edits are what a re-import silently ate.
 *
 * Keyed by preset slug because the wording is that package's, not a convention.
 */
export const FABRICATION_FIXES: Record<string, readonly Fix[]> = {
  'ai-content-creator-team': [
    {
      why: 'lead: the tool list it dispatches against, plus how a named model reaches a member',
      find: '5. **工具边界**：多模态内容生成使用 WorkBuddy 内置工具（多模态内容生成 Skill、ImageGen、ImageEdit）；本地视频文件预处理使用 Bash 工具链（ffmpeg/ffprobe/whisper）。不得引用其他外部 API（如 Grok、Veo 等）',
      replace: '5. **工具边界**：出图与出片由成员直接调用本机工具 `image_generate` / `video_generate` 完成，'
        + '工具自己的说明就是权威，人设里任何模型名都不作数；本地视频文件预处理使用 shell 工具链（ffmpeg/ffprobe/whisper）\n'
        + '5.1 **用户点名了模型就要转述**：派活的入参只有一段自然语言，没有地方放结构化参数。'
        + '所以用户说了"用 xxx 出图/出片"时，必须把那个模型名原样写进派给成员的任务描述里，'
        + '并要求成员把它填进工具的 `model` 参数；你不许替他改成别的模型',
    },
    {
      why: 'video-generator: the frontmatter description is always in context, and four of its five models do not exist here',
      find: 'description: AI video generation expert specializing in text-to-video (HY-Video-1.5), image-to-video (YT-Video-2.0), human actor video (YT-Video-HumanActor), video effects (YT-Video-FX), prompt engineering, and multi-model selection strategy on WorkBuddy platform.',
      replace: 'description: AI video generation expert specializing in text-to-video and image-to-video through the built-in video_generate tool, plus video prompt engineering.',
    },
    {
      // 艾达's whole job upstream is a video-understanding model. We have none, so
      // the honest job is 抽帧 + 看图: `pwsh` runs ffmpeg, `read_image` reads the
      // frames. Left as-is, this member spends its turn describing analysis it
      // never ran — the failure mode that reads like success.
      why: 'content-adapter: its stated core skill is a video-understanding model this route cannot serve',
      find: '你是 AI 内容创作专家团的素材改编专家艾达（Ada），擅长视频内容分析（利用 YT-VITA 模型）、精彩片段提取、视频翻译（AI 声纹克隆+唇型同步）、以及多媒体素材合成。你的核心价值在于将现有内容转化、提炼、重组为新的高价值内容。',
      replace: '你是 AI 内容创作专家团的素材改编专家艾达（Ada），擅长把已有素材转化、提炼、重组成新的高价值内容。\n'
        + '\n'
        + '> **本机能力真相（这几条比下文所有工具名都优先）**：\n'
        + '> - **没有视频内容理解模型**。要"看"视频，就用 `pwsh` 跑 ffmpeg 抽帧成图片，再用 `read_image` 逐帧看；'
        + '音轨用 ffmpeg 抽出来。抽了几帧、看到什么，都要如实说。\n'
        + '> - **视频翻译、声纹克隆、唇型同步本机都做不到**，问到就直接说做不到，不要描述一个没跑过的流程。\n'
        + '> - 出图用 `image_generate`，出片用 `video_generate`；剪辑与合成用 `pwsh` 跑 ffmpeg。',
    },
    {
      why: 'content-adapter: the frontmatter description is always in context',
      find: 'description: Content adaptation expert specializing in video content analysis (YT-VITA), highlight extraction, video translation with AI voice cloning and lip sync, and multi-media composition for creating composite videos from images, clips, and audio.',
      replace: 'description: Content adaptation expert specializing in reworking existing footage — frame extraction and inspection with ffmpeg plus read_image, highlight selection, and multi-media composition from images, clips, and audio.',
    },
    {
      why: 'content-adapter: the three bullets promising video understanding and voice cloning',
      find: '- 通过 YT-VITA 模型分析**已有 URL 的视频**的内容（视觉、音频、语义）\n'
        + '- 从视频中提取精彩片段（基于 YT-VITA 的内容理解）\n'
        + '- 视频翻译（AI 声纹克隆 + 唇型同步）',
      replace: '- 用 `pwsh` 跑 ffmpeg 抽帧 / 抽音轨，再用 `read_image` 逐帧看，据此说清画面里有什么\n'
        + '- 从视频里挑精彩片段（依据是你真看过的那些帧，不是猜的）\n'
        + '- 视频翻译要声纹克隆与唇型同步，**本机没有**，问到就说做不到',
    },
    {
      // Our image tool is text-to-image only: there is no img2img and no inpaint.
      why: 'image-creator: the whole "edit an existing image" section assumes img2img',
      find: '通过 **ImageEdit** 工具或 HY-Image-V3.0 图生图模式，修改已有图片：',
      replace: '**本机的 `image_generate` 只有文生图，没有图生图 / 局部编辑。**'
        + '要"改图"就把改动写进新的提示词重出一张（把原图里要保留的元素一并写清）；'
        + '纯机械的裁剪、拼接、加水印用 `pwsh` 跑 ffmpeg / ImageMagick。下面这些当提示词写法参考：',
    },
    {
      why: 'content-adapter: the tool table row for that model',
      find: '| **YT-VITA** | `youtu-vita`，通过多模态内容生成 Skill 调用 | 视频/图片内容理解分析，视频结构解析、图像目标检测 | 视频分析、精彩片段识别、内容理解 |',
      replace: '| `pwsh` + `read_image` | ffmpeg 抽帧 / 抽音轨，再逐帧看图 | 本机唯一的"看视频"办法：分辨率与帧数由你自己定，看到什么说什么 | 视频分析、片段挑选 |',
    },
    {
      why: 'lead: dispatch table row promising video understanding',
      find: '| 分析视频内容（需要视频 URL） | ✅ 派给 content-adapter（通过 YT-VITA） | — |',
      replace: '| 分析视频内容 | ⚠️ 本机没有视频理解模型：可以派 content-adapter 抽帧看图，做不到的部分直接说 | — |',
    },
    {
      why: 'lead: routing table row promising the same thing',
      find: '| 分析视频内容（需有视频 URL） | content-adapter | 视频理解/片段提取（YT-VITA） |',
      replace: '| 分析视频内容 | content-adapter | 抽帧成图片再看图，没有视频理解模型 |',
    },
    {
      why: 'video-generator: opening line names a model catalogue it does not have',
      find: '你是 AI 内容创作专家团的视频生成专家维欧（Veo），擅长利用 WorkBuddy 内置的 AI 视频生成模型将文字描述或图片素材转化为高质量视频内容。你精通多模型选型策略和视频 Prompt 工程。',
      replace: '你是 AI 内容创作专家团的视频生成专家维欧（Veo），擅长用本机的 `video_generate` 工具把文字描述或图片素材变成高质量视频。你精通视频 Prompt 工程。',
    },
    {
      why: 'video-generator: 必须, for two models that do not exist',
      find: '3. **模型匹配**：人物场景必须用 YT-Video-HumanActor，特效必须用 YT-Video-FX',
      replace: '3. **模型别自己挑**：不填 `model` 就走本机验过的默认模型；只有用户点名时才把他说的名字原样填进去',
    },
    {
      why: 'video-generator: forbids the vendor we actually film with',
      find: '6. **工具边界**：只使用 WorkBuddy 内置工具，不得引用外部 API（如 Grok、Veo 等）',
      replace: '6. **工具边界**：出片只用本机的 `video_generate` 工具，出图只用 `image_generate`。'
        + '工具自己的参数说明是权威，本人设上文列的任何模型名都不作数',
    },
    {
      why: 'video-generator: the whole "how to call it" section points at a skill that does not exist',
      find: '你通过 `多模态内容生成` Skill 来生成视频。调用方式是**使用 `use_skill` 工具，skill 名称为 `多模态内容生成`**，在调用描述中明确以下要素：',
      replace: '你直接调用 `video_generate` 工具生成视频。写 prompt 时明确以下要素：',
    },
    {
      why: 'image-creator: the frontmatter description is always in context',
      find: 'description: AI image generation expert specializing in photorealistic scenes, stylized illustrations, product photography, minimalist design, text-accurate images, sequential art, and batch generation using WorkBuddy built-in tools (HY-Image-V3.0, HY-Image-Lite, ImageGen, ImageEdit).',
      replace: 'description: AI image generation expert specializing in photorealistic scenes, stylized illustrations, product photography, minimalist design, text-accurate images, sequential art, and batch generation through the built-in image_generate tool.',
    },
    {
      why: 'image-creator: opening line',
      find: '你是 AI 内容创作专家团的图文创作专家珀西（Percy），擅长利用 WorkBuddy 内置的 AI 图像生成工具创作各类高质量图片内容。',
      replace: '你是 AI 内容创作专家团的图文创作专家珀西（Percy），擅长用本机的 `image_generate` 工具创作各类高质量图片内容。',
    },
    {
      why: 'image-creator: tells it that stating an intent draws the picture — the silent no-op',
      find: '> **重要**：你只能使用 WorkBuddy 内置的图像工具。直接说出你的生成意图（如"画一张 XX 图"），WorkBuddy 会自动识别并调用对应工具。',
      replace: '> **重要**：出图要**真的调用 `image_generate` 工具**。说出生成意图不会有任何事情发生，没有谁会替你识别并代调。\n'
        + '>\n'
        + '> 模型不用你挑：不填 `model` 就走本机验过的默认模型。只有用户点名了某个模型时，才把他说的名字原样填进 `model`'
        + '——**不要自己猜模型名**，这个账号调不到的名字会被当场拒掉并告诉你有哪些能用的。\n'
        + '> 尺寸只有方图 / 横图 / 竖图三档（`1024x1024` / `1536x1024` / `1024x1536`），用户没提形状就别填。',
    },
    {
      why: 'image-creator: four fabricated rows become the one real tool',
      find: '| 工具/模型 | 调用方式 | 能力 | 适用场景 |\n'
        + '|-----------|----------|------|---------|\n'
        + '| **ImageGen** | 文本描述生成图片 | 文生图 | 通用图片生成 |\n'
        + '| **ImageEdit** | 修改已有图片 | 图生图、局部编辑 | 风格转换、元素添加/删除 |\n'
        + '| **HY-Image-V3.0** | `hy-image-v3.0` | 文生图、图生图 | 高质量场景（80B参数，千字级语义、文字渲染、漫画/表情包） |\n'
        + '| **HY-Image-Lite** | `hy-image-lite` | 文生图 | 快速出图（电商图、设计素材） |',
      replace: '| 工具 | 能力 | 说明 |\n'
        + '|------|------|------|\n'
        + '| **`image_generate`** | 文生图，一次 1~4 张 | 唯一的出图工具。参数与可用模型以工具自己的说明为准 |',
    },
    {
      why: 'image-creator: a decision tree whose every leaf is a model that does not exist',
      find: '├─ 文生图\n'
        + '│   ├─ 高质量/复杂场景/中文文字渲染 → HY-Image-V3.0\n'
        + '│   ├─ 快速出图/电商素材 → HY-Image-Lite\n'
        + '│   └─ 通用场景 → ImageGen\n'
        + '│\n'
        + '├─ 图片编辑（基于已有图片）\n'
        + '│   ├─ 风格转换/局部修改 → ImageEdit\n'
        + '│   └─ 基于原图重新创作 → HY-Image-V3.0（图生图模式）\n'
        + '│\n'
        + '└─ 批量生成\n'
        + '    └─ 根据场景选择上述工具，保持风格锚定词一致',
      replace: '├─ 用户点名了模型 → 把那个名字原样填进 model\n'
        + '├─ 没点名 → 不填 model，走默认\n'
        + '│\n'
        + '├─ 用户提了形状 → size 选方 / 横 / 竖三档之一\n'
        + '├─ 没提 → 不填 size\n'
        + '│\n'
        + '└─ 要多张 → n 最多 4；批量时靠同一套风格锚定词保持一致，而不是靠换模型',
    },
    {
      why: 'image-creator: recommends a fabricated model for Chinese type',
      find: '- **要点**：指定字体风格、设计方法、配色方案。**推荐使用 HY-Image-V3.0，文字渲染能力最强。**',
      replace: '- **要点**：指定字体风格、设计方法、配色方案。**要渲染中文时把字样写进 prompt，默认模型的中文渲染是可用的。**',
    },
    {
      why: 'skill: the frontmatter description, which the skill index always shows',
      find: '  AI 多模态内容生产技能包，基于 WorkBuddy 内置工具（HY-Video、YT-Video、HY-Image、YT-VITA、ImageGen、ImageEdit），',
      replace: '  AI 多模态内容生产技能包，出图出片走本机的 image_generate / video_generate，',
    },
    {
      why: 'skill: a 27-line catalogue of tools and models that do not exist',
      find: '## WorkBuddy 可用工具总览\n'
        + '\n'
        + '### 内置工具\n'
        + '| 工具 | 触发方式 | 能力 |\n'
        + '|------|----------|------|\n'
        + '| **多模态内容生成**（Skill） | 说"生成图片/视频/3D"自动触发 | 文生图、图生图、文生视频、图生视频、文生3D、图生3D、图片特效 |\n'
        + '| **ImageGen** | 文本描述生成图片 | 文生图 |\n'
        + '| **ImageEdit** | 修改已有图片 | 图生图、局部编辑 |',
      replace: '## 本机可用工具总览\n'
        + '\n'
        + '| 工具 | 怎么用 | 能力 |\n'
        + '|------|--------|------|\n'
        + '| **`image_generate`** | 直接调用 | 文生图，一次 1~4 张 |\n'
        + '| **`video_generate`** | 直接调用 | 文生视频、图生视频（后台跑，1~6 分钟出片）|\n'
        + '\n'
        + '就这两个，没有别的。模型不填走默认，用户点名了才原样填 `model`；'
        + '文生3D、图片特效、视频理解本机都没有，别答应用户。',
    },
    {
      why: 'skill: forbids the vendor we actually film with',
      find: '4. **工具边界**：所有成员只能使用 WorkBuddy 内置工具，不得引用外部 API（如 Grok、Veo、Gemini 等）',
      replace: '4. **工具边界**：出图出片只用 `image_generate` / `video_generate`，别去找别的工具；'
        + '这两个工具背后用的就是 Veo 这类模型，所以「不得使用 Veo」那类话对本机不成立',
    },
  ],
}

/**
 * Phantom tool names, rewritten by pattern rather than one sentence at a time.
 *
 * `SendMessage` appears 20 times across six members and `use_skill` 3 more, all
 * saying one of three things: hand the result back, ask the lead for something,
 * or report a failure. Enumerating 23 exact sentences would be 23 things to
 * maintain against a package that gets re-imported, and would still miss the
 * 24th the next version adds. The phrase around a tool name is stable in a way
 * the sentence is not, so these match the phrase.
 *
 * Order matters: the longer, more decorated forms have to go first, and the bare
 * name last as a catch-all. {@link assertNoPhantomTools} is what proves the
 * catch-all caught everything.
 */
export const MECHANICAL_REWRITES: readonly Rewrite[] = [
  { find: /通过 \*\*SendMessage\*\* 将/g, replace: '在最终回复里把' },
  { find: /通过 SendMessage 将/g, replace: '在最终回复里把' },
  { find: /通过 \*\*SendMessage\*\* /g, replace: '在最终回复里' },
  { find: /通过 SendMessage /g, replace: '在最终回复里' },
  // Before the bare `SendMessage 回传` rule below, which would otherwise leave
  // the space in `从各成员的 结果回传中`.
  { find: /从各成员的 SendMessage 回传中/g, replace: '从各成员的回复中' },
  { find: /\*\*SendMessage 回传\*\*/g, replace: '**结果回传**' },
  { find: /SendMessage 回传/g, replace: '结果回传' },
  { find: /通过 `use_skill` 调用 `多模态内容生成` Skill/g, replace: '直接调用 `video_generate` 工具' },
  { find: /使用 `use_skill` 工具/g, replace: '直接调用工具' },
  // Whatever the three above did not reach. Reading as "your final reply" keeps
  // every one of those sentences true, because that is how a member reports.
  { find: /\*\*SendMessage\*\*/g, replace: '**最终回复**' },
  { find: /SendMessage/g, replace: '最终回复' },
  { find: /`use_skill`/g, replace: '`skill`' },
  { find: /use_skill/g, replace: 'skill' },

  // ## How a lead dispatches
  //
  // WorkBuddy's shape is "create a team, then spawn into it, passing the member's
  // id as `name` and `subagent_type`". Ours is one `delegate_<member id>` tool per
  // member, taking a description and a natural-language prompt and nothing else
  // (`dsh-tool-subagent`). Both halves of their shape are unreachable here, and
  // both are written as 必须: 20 sentences mandate `TeamCreate` across six teams,
  // and 12 more mandate the two parameters. A lead that believes it must create a
  // team before dispatching either stalls or invents the members' output — which
  // is the failure those very sentences were written to prevent.
  //
  // Two capability inventories, not two names. A wrong `model` argument is data
  // the route refuses with a message (see {@link assertNoPhantomTools}), but
  // these tables tell the lead what the *team can do* — 文生 3D、图片特效、视频内容
  // 理解 — and it promises those to the user before anything is called. So the
  // tables are replaced by the two tools that exist.
  {
    find: /### 内置工具[\s\S]*?`youtu-vita`[^\n]*\n/u,
    replace: '### 本机的媒体工具（一共两个）\n'
      + '| 工具 | 能力 | 模型怎么定 |\n'
      + '|------|------|-----------|\n'
      + '| `image_generate` | 文生图，一次 1~4 张；尺寸只有方图 / 横图 / 竖图三档 |'
      + ' 不填就走验过的默认模型；用户点名了就把那个名字原样填进 `model` |\n'
      + '| `video_generate` | 文生视频、图生视频（可带参考图），后台出片 | 同上 |\n'
      + '\n'
      + '按厂商代号命名的模型（`HY-*` / `YT-*` 这类）在这个账号上一个都调不到，'
      + '填进去会被当场拒掉并告知有哪些能用。文生 3D、图生 3D、图片特效、视频内容理解这四样本机没有，'
      + '用户问到就直接说没有，别许诺。\n',
  },
  {
    find: /## 模型选型快速决策表[\s\S]*?`youtu-vita`[^\n]*\n/u,
    replace: '## 派活快速决策表\n'
      + '\n'
      + '模型不由这张表决定：不填就走默认，用户点名了就把那个名字原样往下传给成员。\n'
      + '\n'
      + '| 需求场景 | 调度成员 |\n'
      + '|---------|---------|\n'
      + '| 文生视频 / 图生视频 / 人物视频 / 特效向视频 | video-generator |\n'
      + '| 文生图 / 图片编辑 | image-creator |\n'
      + '| 视频裁剪 / 拼接 | video-editor |\n'
      + '| 视频内容理解 | 本机没有这个能力，需要就抽帧成图片再用 `read_image` 看，做不到的直接说 |\n',
  },
  // The member ability table annotates each ability with the model behind it, so
  // stripping the parenthetical is what leaves a true sentence: the ability is
  // real, only the attribution is not.
  { find: /（(?:HY-|YT-|ImageGen|ImageEdit|hy-|yt-|youtu-)[^（）]*）/gu, replace: '' },
  {
    // video-generator keeps its own copy of the model table, one column wider.
    find: /### 视频生成模型（4 个）\n\n\|[^\n]*\n\|[-|]+\|\n(?:\| \*\*(?:HY|YT)-Video[^\n]*\n)+/u,
    replace: '### 可用模型\n'
      + '\n'
      + '模型名不在这份人设里，也不该由你背下来：不填 `model` 就走本机验过的默认模型，'
      + '用户点名了就把那个名字原样填进去。填了这个账号调不到的名字，工具会当场拒掉并告诉你有哪些能用。\n'
      + '\n'
      + '参考图（首帧 / 参考画面）是 `video_generate` 自己的参数，先用 `image_generate` 出图，再把文件路径填进去。\n',
  },
  { find: /\*\*推荐使用 HY-Image-V3\.0，[^*]*\*\*/gu, replace: '**这一档对模型比较挑，出得不好就换用户点名的其他模型再试一次。**' },
  {
    // Same reasoning as the decision tree: a fallback chain built from model
    // names becomes a loop of refusals. What is worth keeping is the escalation
    // itself — drop the reference image, then give up and say so.
    find: /### Fallback 链路（按顺序尝试）\n\n```\n[\s\S]*?\n```\n/u,
    replace: '### 失败了怎么退（不换模型名）\n'
      + '\n'
      + '```\n'
      + '图生视频失败 → 去掉参考图，改纯文生视频再试一次\n'
      + '文生视频失败 → 换一版更具体的 prompt 再试一次\n'
      + '仍失败      → 把工具返回的原文报给主理人，不要自己换模型名去猜\n'
      + '```\n'
      + '\n'
      + '模型名只有两种来源：不填（走默认）或用户点名。'
      + '拿别的名字当兜底只会换来一次「这个账号调不到」的拒绝。\n',
  },
  { find: /### 1\. 视频内容分析（基于 YT-VITA）/gu, replace: '### 1. 视频内容分析（抽帧 + 看图）' },
  { find: /\*\*使用工具\*\*：\[ImageGen[^\]]*\]/gu, replace: '**使用工具**：`image_generate`' },
  {
    find: /\*\*文字渲染\*\*：需要精准文字时推荐 HY-Image-V3\.0，文字渲染能力最强/gu,
    replace: '**文字渲染**：精准文字很吃模型，出不对就把要出现的字面内容写得更具体，或换用户点名的其他模型再试',
  },
  { find: /- 视频分析 → 使用 YT-VITA 进行内容理解\/片段提取/gu, replace: '- 视频分析 → ffmpeg 抽帧 + `read_image` 看帧，据此做内容理解与片段挑选' },
  { find: /\*\*分析工具\*\*：YT-VITA/gu, replace: '**分析工具**：`pwsh` 跑 ffmpeg 抽帧，`read_image` 看帧' },
  { find: /视频越清晰，YT-VITA 分析结果越准确/gu, replace: '视频越清晰，抽出来的帧越好认；帧太密没意义，按镜头切换取几张就够' },
  {
    find: /- 需要视觉分析\/精彩片段 → [^\n]*/gu,
    replace: '- 需要视觉分析 / 精彩片段 → 先抽帧再看图，看到多少说多少；本机没有视频理解模型',
  },
  {
    find: /- \*\*用户提供了视频 URL\*\* → [^\n]*/gu,
    replace: '- **用户给了视频文件** → 用 `pwsh` 跑 ffmpeg 抽帧，再用 `read_image` 看那些帧（网络地址要先下载到工作目录）',
  },
  {
    find: /当视频主体涉及人物时，\*\*必须优先使用 YT-Video-HumanActor\*\*：/gu,
    replace: '当视频主体涉及人物时（本机没有专用的人像驱动通道，只能靠提示词和参考图逼近，做不到就说做不到）：',
  },
  {
    find: /当用户需要.给图片加动态效果.时，使用 YT-Video-FX：/gu,
    replace: '当用户需要给图片加动态效果时（没有特效模板，把效果写进 prompt 并把这张图当参考图）：',
  },
  {
    // A decision tree whose every leaf is an unservable model does more damage
    // than a stray name: the agent fills `model` from it and eats a refusal.
    // What survives is the part that is actually a decision — 有没有参考图。
    find: /## 模型选择决策树\n\n```\n[\s\S]*?\n```\n/u,
    replace: '## 选路决策树（不含模型名）\n'
      + '\n'
      + '```\n'
      + '用户需求分析：\n'
      + '├─ 文生视频（无参考图）→ 直接调 video_generate，只给 prompt\n'
      + '│   💡 想更可控：先用 image_generate 出关键帧，再走下面那条\n'
      + '│\n'
      + '├─ 图生视频（有参考图/关键帧）→ 把图片文件路径填进 video_generate 的参考图参数\n'
      + '│\n'
      + '└─ 模型：不填走默认；用户点名了就把那个名字原样填进 model\n'
      + '```\n'
      + '\n'
      + '人物驱动、图片特效模板这两类本机没有专用通道，'
      + '能做的就是把要求写进 prompt 或用参考图引导，做不到的直接说做不到。\n',
  },
  {
    find: /### 辅助工具\n\n\| 工具 \| 用途 \|\n\|[-|]+\|\n(?:\| \*\*(?:ImageGen|HY-Image)[^\n]*\n)+/u,
    replace: '### 辅助工具\n'
      + '\n'
      + '| 工具 | 用途 |\n'
      + '|------|------|\n'
      + '| `image_generate` | 出关键帧 / 参考图，然后把文件路径填进 `video_generate` 的参考图参数 |\n',
  },

  // Whole clauses first. A token swap alone produced sentences that were worse
  // than the original — 「团队创建（本机没有这一步）必须且只能由主理人执行」 still
  // orders the lead to do it, and 「通过 delegate_ 工具建立本次任务的协作团队」 is
  // not even grammatical. Where a sentence exists only to mandate the missing
  // step, the whole sentence is replaced by what it was trying to achieve:
  // dispatch for real rather than ventriloquise the members.
  { find: /\*\*建立团队\*\*[：:—][^\n]*/gu, replace: '**不用建团队**：本机没有「创建团队」这一步，接到任务直接调对应成员的 `delegate_<成员 ID>` 工具派活' },
  { find: /\*\*必须亲自创建团队\*\*[：:][^\n]*/gu, replace: '**必须真的派活**：由我调 `delegate_<成员 ID>` 把活交给成员，不能自己模拟多角色发言' },
  { find: /\*\*🚫 严禁跳过 `?TeamCreate`?\*\*[^\n]*/gu, replace: '**🚫 严禁自己模拟成员发言**——必须真的调 `delegate_<成员 ID>` 把活派给成员，不允许自己想几个视角替他们说话' },
  { find: /禁止跳过 TeamCreate[^\n]*/gu, replace: '禁止自己模拟成员发言或并行写出多角色内容，必须真的调 `delegate_<成员 ID>` 派活' },
  { find: /所有成员调度必须经过 ?TeamCreate → Agent spawn → SendMessage 回传正式流程。?/gu, replace: '所有成员调度都走同一条路：调 `delegate_<成员 ID>`，成员把结果写在自己的回复里回到我手上。' },
  { find: /团队建立后，?/gu, replace: '' },
  { find: /\| 创建团队 \| `?TeamCreate\([^\n]*/gu, replace: '| 派活 | `delegate_<成员 ID>`（没有建团这一步）|' },
  { find: /- ([✅❌]) `name: "([a-z0-9-]+)"`[^\n]*/gu, replace: (_all, mark, id) => `- ${mark} \`delegate_${id.replace(/-/gu, '_')}\`` },
  // The English team says the same things.
  { find: /\(no TeamCreate\)/gu, replace: '(handle alone)' },
  { find: /MUST TeamCreate and spawn the relevant/gu, replace: 'MUST dispatch through the delegate_<member id> tool of the relevant' },
  { find: /MUST call TeamCreate before spawning any member[^\n]*/gu, replace: 'Dispatch by calling each member’s delegate_<member id> tool — there is no team to create first.' },
  { find: /NEVER skip TeamCreate and simulate member outputs yourself/gu, replace: 'NEVER simulate member outputs yourself — actually call the member’s delegate_<member id> tool' },
  // Delivery, as clauses, so the sentence still reads as an instruction.
  { find: /调用 `?deliver_attachments`? 交付/gu, replace: '把文件路径写进回复，交付' },
  { find: /调用 `?open_result_view`? 展示/gu, replace: '图片用 `image_show` 摆出来、视频只给路径，展示' },

  // The composite phrases go next so the token rules do not shred them.
  { find: /TeamCreate → Agent spawn → SendMessage 回传/gu, replace: '直接调成员的 delegate_ 工具，成员把结果写在自己的回复里' },
  { find: /TeamCreate → Agent spawn → 结果回传/gu, replace: '直接调成员的 delegate_ 工具，成员把结果写在自己的回复里' },
  { find: /via TeamCreate \+ AgentTool/giu, replace: "via each member's delegate_ tool" },
  { find: /TeamCreate \+ AgentTool/gu, replace: '成员各自的 delegate_ 工具' },
  // Keyed on the two parameter names rather than on the wording around them,
  // because that wording differs in all six teams — and scoped to the whole line,
  // because these lines are *entirely* about the parameter convention. A
  // sentence-scoped version left the follow-on 「**禁止**省略 name 参数」 standing,
  // which is the same instruction again in a shorter sentence.
  {
    find: /^[^\n]*`name`[^\n]*`subagent_type`[^\n]*$/gmu,
    replace: '调度成员时直接调用该成员的 `delegate_<成员 ID>` 工具。派活的入参只有一段自然语言，'
      + '没有 `name`、没有类型参数、也没有别的字段可填；下面列出的就是每位成员对应的工具名：',
  },
  { find: /禁止跳过"建立团队"的正式流程，?/gu, replace: '禁止' },
  { find: /禁止跳过「建立团队」的正式流程，?/gu, replace: '禁止' },
  { find: /`name: "([a-z0-9-]+)", subagent_type: "[a-z0-9-]+"`/gu, replace: (_all, id) => `\`delegate_${id.replace(/-/gu, '_')}\`` },
  { find: /`subagent_type`/gu, replace: '成员 ID' },
  { find: /subagent_type/gu, replace: '成员 ID' },
  { find: /（TeamCreate）/gu, replace: '（本机没有这一步）' },
  { find: /`TeamCreate`/gu, replace: '`delegate_<成员 ID>`' },
  { find: /\bTeamCreate\b/gu, replace: 'delegate_<成员 ID>' },
  { find: /`AgentTool`/gu, replace: '`delegate_<成员 ID>`' },
  { find: /\bAgentTool\b/gu, replace: 'delegate_<成员 ID>' },
  { find: /Agent 工具/gu, replace: 'delegate_<成员 ID> 工具' },

  // ## How a produced file reaches the user
  //
  // Their two-tool split — `deliver_attachments` to put files in a products panel,
  // `open_result_view` to preview one — does not exist here, and the personas are
  // emphatic about it (「所有产出文件必须通过此工具交付」, plus a ⚠️ warning that
  // using only the preview tool loses the rest). Locally a written file is surfaced
  // by naming its path in the reply, and an image additionally needs `image_show`
  // in the session the user is reading.
  { find: /`deliver_attachments`/gu, replace: '「把文件路径写进回复」' },
  { find: /deliver_attachments/gu, replace: '「把文件路径写进回复」' },
  { find: /`open_result_view`/gu, replace: '`image_show`（只对图片有效）' },
  { find: /open_result_view/gu, replace: 'image_show（只对图片有效）' },

  // ## Two more, each a single package's
  //
  // `memory_write` (美团): no memory tool here, and the intent — remember this for
  // later — is served by writing a file in the working directory.
  // `connect_cloud_service` (高考): fetches a credential for that package's search
  // scripts. Without it those scripts cannot run, so the honest rewrite says the
  // search is unavailable rather than leaving a step that fails halfway.
  // 高考 wants a credential before each search-script call, so a token swap turns
  // into 「调用 web_search 获取凭证」 — an instruction that is false on its face.
  // Both occurrences are whole steps, and what they gate is unavailable here, so
  // the steps say that instead.
  {
    find: /\*\*凭证实时获取\*\*[：:][^\n]*/gu,
    replace: '**本机没有凭证服务**：`gaokao-search` 这类要 token 的脚本在本机跑不通，'
      + '这四类内容改用 `web_search` 搜、`web_fetch` 取原文，并说明这是公开检索的结果',
  },
  {
    find: /\*\*知识库检索认证\*\*[：:][^\n]*/gu,
    replace: '**没有知识库检索**：本机取不到检索凭证，高考真题 / 作文 / 高校 / 专业这几类改用 `web_search` 与 `web_fetch`',
  },
  { find: /`memory_write`（type=`?longterm`?）/gu, replace: '`write`（写进工作目录里的文件）' },
  { find: /`memory_write`（type=daily）/gu, replace: '`write`（写进工作目录里的文件）' },
  { find: /`memory_write`/gu, replace: '`write`（写进工作目录里的文件）' },
  { find: /memory_write/gu, replace: 'write（写进工作目录里的文件）' },
  { find: /`connect_cloud_service`/gu, replace: '`web_search`（本机没有云凭证服务，知识库检索不可用）' },
  { find: /connect_cloud_service/gu, replace: 'web_search（本机没有云凭证服务，知识库检索不可用）' },

  // ## Names that are only names
  //
  // Found by running this generator over all 421 published packages rather than
  // the 22 that happened to be on this machine. These are the same tools we
  // have under a different spelling, and the corpus is full of them: `WebSearch`
  // in 76 packages, `WebFetch` in 65, `AskUserQuestion` in 30, `read_file` in 23,
  // `ImageGen` in 7. A rename is the whole fix, and it is the cheapest kind —
  // no sentence changes meaning, and the agent stops hunting for a tool that is
  // sitting next to it under our spelling.
  //
  // Deliberately not renamed:
  // - `ImageEdit` (2 packages): we have no image-to-image tool, so this is a
  //   capability gap rather than a spelling. The runtime tool-reality section
  //   denies it by name, and `ai-content-creator-team`'s tables get a
  //   written-out fix above.
  // - `present_files` / `show_widget` (17 / 6 packages): display-only, and
  //   missing one degrades to "answer in chat" rather than breaking a promise.
  //   `expert_bundle.go:404-415` reached the same conclusion with two pieces of
  //   evidence, and reversed an earlier rule that had dropped whole skills over
  //   the word.
  // - `execute_e2b_code` and its sandbox siblings (1 package): a hosted sandbox
  //   we do not have. `pwsh` is not the same thing, so a rename would lie.
  //
  // `read_file` and friends stop at `(`: a bare `read_file(path)` in a skill
  // document is a code sample, and rewriting the call would leave the sample
  // wrong in a way the reader cannot see.
  { find: /\bWebSearch\b/gu, replace: 'web_search' },
  { find: /\bWebFetch\b/gu, replace: 'web_fetch' },
  { find: /\bAskUserQuestion\b/gu, replace: 'ask_user_question' },
  { find: /\bImageGen\b/gu, replace: 'image_generate' },
  { find: /\bread_file\b(?!\s*\()/gu, replace: 'read' },
  { find: /\bsearch_content\b(?!\s*\()/gu, replace: 'grep' },
  { find: /\bsearch_file\b(?!\s*\()/gu, replace: 'glob' },

  // ## What a mangled emoji leaves behind
  //
  // `stripNonPrintable` removes the control byte, and what remains at the head of
  // a heading is the emoji's other low byte: `## = Your Workflow Process`, or
  // `## =à Technical Implementation`. Dropping the debris keeps the outline the
  // model reads clean. Anchored to a heading and bounded to two characters so a
  // line that genuinely starts with `=` is left alone.
  { find: /^(#{1,6}) =[\u00A0-\u00FF]{0,2}[ \t]+/gmu, replace: '$1 ' },
]

/**
 * Tool and parameter names that must not survive into a materialized preset.
 *
 * Every entry here is something a persona instructs an agent to *call* or *fill*,
 * so a leftover costs a turn discovering it is not there. `mcp__…` is deliberately
 * absent: those names are conditional («use the Qichacha MCP tools when
 * available»), they are data rather than a mandate, and 14 of them across three
 * packages would turn into 14 lines of identical apology — the runtime
 * tool-reality section says once that this machine has no MCP servers, and says
 * it only while that stays true.
 */
export const PHANTOM_TOOLS: readonly string[] = [
  'SendMessage', 'use_skill', 'TeamCreate', 'AgentTool', 'subagent_type',
  'deliver_attachments', 'open_result_view', 'memory_write', 'connect_cloud_service',
]

/**
 * Prompt variables the registry actually resolves.
 *
 * `dsh-agent-loop` registers exactly `provider`, `model` and `cwd` globally
 * (`ctx.systemPrompt.variable(…)`), and the registry throws on anything else at
 * prompt-build time — a per-turn failure, so it is invisible to any check that
 * only reads the file.
 */
const TEMPLATE_VARS = new Set(['provider', 'model', 'cwd'])

/**
 * Drop control characters an imported document has no business carrying.
 *
 * Upstream ships mangled emoji: a heading meant to read `## 🔄 Your Workflow
 * Process` arrives as `## =` + `U+0004`, which is that emoji's UTF-16 surrogate
 * pair written out as its low bytes (`D83D DD04` → `3D 04`). Harmless to read,
 * fatal to install — the kernel's YAML reader refuses a stream containing
 * non-printable characters, so the composition is written, judged broken, and
 * rolled back. Measured 2026-08-19 over the whole catalogue: 3 of 407 packages
 * (`app-store-optimization-expert`, `rapid-prototyping-engineer`,
 * `mobile-application-developer`) failed for exactly this and no other reason.
 *
 * Stripped rather than refused because the alternative is losing an expert over
 * a broken emoji, and stripped rather than repaired because the original code
 * point is not recoverable from its low byte — the pair's high half is gone.
 * Tab and the newlines stay: a block scalar carries them fine.
 * @param text - the imported text.
 * @returns the text with C0 and C1 controls removed.
 */
export function stripNonPrintable(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, '')
}

/**
 * Rewrite the vendor's product name out of an imported document.
 * @param text - the imported text.
 * @returns the text with the host's name made generic.
 */
export function rewriteIdentity(text: string): string {
  return text
    .replaceAll('"CodeBuddy Code"', '"a generic coding assistant"')
    .replaceAll('"CodeBuddy"', '"a generic coding assistant"')
    .replaceAll('CodeBuddy Code', 'a generic coding assistant')
    .replaceAll('CodeBuddy', 'a generic coding assistant')
}

/**
 * Neutralize `{{…}}` groups an imported document did not mean as variables.
 *
 * `renderPrompt` is strict — an unknown reference throws, and the registry has
 * no escape syntax for literal `{{…}}` braces. So one JSX `style={{ … }}` in a
 * persona is not a cosmetic problem: every turn of that agent fails to assemble
 * a prompt. `mvp-dev-expert-team` alone carries 19 such groups across its
 * frontend member's code samples, plus a `{{ t('welcome') }}` from a Vue
 * snippet.
 *
 * Spacing the braces apart keeps the sample readable and, for the JSX cases,
 * still valid — `style={ { color: '#fff' } }` is the same expression. `{{cwd}}`
 * is spared by name because it is the one reference the registry would actually
 * resolve, so a document that means it keeps it.
 * @param text - imported text.
 * @returns text whose only complete groups are variables the registry knows.
 */
export function neutralizeTemplates(text: string): string {
  const KEEP = '\u0000cwd\u0000'
  return text
    .replaceAll('{{cwd}}', KEEP)
    .replaceAll('{{', '{ {')
    .replaceAll('}}', '} }')
    .replaceAll(KEEP, '{{cwd}}')
}

/**
 * Put {@link SKILL_DOC_NOTE} directly below a document's frontmatter.
 *
 * Below rather than above, because `---` is frontmatter only on the first line:
 * pushing it down would turn a skill's own name and description into body text.
 * @param doc - the imported document.
 * @returns the document with the note in place.
 */
export function withSkillDocNote(doc: string): string {
  const text = doc.replace(/\r\n/g, '\n')
  const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(text)
  if (!frontmatter) return `${SKILL_DOC_NOTE}\n\n${text}`
  return `${text.slice(0, frontmatter[0].length)}\n${SKILL_DOC_NOTE}\n${text.slice(frontmatter[0].length)}`
}

/**
 * Report every place a document still tells an agent to call a tool we never
 * registered.
 *
 * This is the check that does not go stale. The tables above are keyed on a
 * package's current wording and a re-import can reword any of them, but this
 * asserts the property we actually care about — no instruction to call something
 * that is not there — so a reworded mandate is reported instead of shipping
 * unnoticed.
 *
 * {@link SKILL_DOC_NOTE} is blanked before the scan rather than exempted by
 * shape: it names these tools in order to deny them, but the earlier form of
 * this check skipped every line starting with `>`, which let an imported
 * document's own blockquote carry a mandate past it. Blanking keeps the line
 * numbers in the report honest.
 *
 * Fabricated *model* names are deliberately not looked for. A model name is
 * data, not a call: it travels as the `model` argument and the route refuses an
 * unservable one with a message naming what is available, so a leftover
 * `HY-Image-V3.0` in a reference guide costs one legible refusal. A leftover
 * `SendMessage` costs a turn spent hunting for a tool.
 * @param text - the materialized document.
 * @param label - what to name in each line of the report.
 * @returns one line per finding, empty when the document is clean.
 */
export function findPhantomTools(text: string, label: string): string[] {
  const found: string[] = []
  const body = text.replace(SKILL_DOC_NOTE, note => note.replace(/[^\n]/g, ' '))
  body.split('\n').forEach((line, index) => {
    for (const tool of PHANTOM_TOOLS) {
      if (line.includes(tool)) found.push(`  ${label}:${String(index + 1)} 还在说 ${tool} → ${line.trim().slice(0, 80)}`)
    }
  })
  return found
}

/**
 * Report `{{…}}` references the prompt registry would refuse to render.
 *
 * Structural rather than cosmetic: an unknown reference throws at prompt-build
 * time, so an agent whose persona carries one cannot take a single turn. Both
 * callers treat a finding here as a reason not to write the preset at all.
 * @param text - the composed document.
 * @returns the unresolvable names, deduplicated, without their braces.
 */
export function unknownTemplateVars(text: string): string[] {
  const asked = [...text.matchAll(/\{\{([^{}]*)\}\}/g)].map(match => (match[1] ?? '').trim())
  return [...new Set(asked.filter(name => !TEMPLATE_VARS.has(name)))]
}

/** The registry-resolvable variable names, for an error message that names them. */
export function templateVarNames(): string[] {
  return [...TEMPLATE_VARS]
}

/** Applies one package's corrections and remembers which ones matched. */
export interface Scrubber {
  /**
   * Correct one document from this package.
   * @param text - the imported document.
   * @returns the corrected text.
   */
  scrub: (text: string) => string
  /**
   * Report the fixes that matched nothing in this run.
   *
   * A fix that matches nothing means upstream reworded the sentence it was
   * written for, and the sentence it was correcting is therefore still in the
   * document under a new wording. Silence here would be the failure we built
   * exact-string matching to avoid.
   * @returns the message to raise, or undefined when every fix landed.
   */
  staleReport: () => string | undefined
}

/**
 * Build a scrubber for one package.
 *
 * Per package rather than per document, because the staleness report is a
 * property of the package: a fix aimed at the lead's persona finds nothing in a
 * member's, and only after every document has passed through can a rule be
 * called stale.
 * @param slug - the package id, which is how {@link FABRICATION_FIXES} is keyed.
 * @returns the scrubber.
 */
export function createScrubber(slug: string): Scrubber {
  const fixes = FABRICATION_FIXES[slug] ?? []
  const applied = new Set<number>()
  return {
    scrub: (text: string) => {
      // First, because everything below was written against readable text and a
      // stray control byte in the middle of a heading would hide a match.
      let next = stripNonPrintable(text)
      for (const [index, fix] of fixes.entries()) {
        if (!next.includes(fix.find)) continue
        next = next.replaceAll(fix.find, fix.replace)
        applied.add(index)
      }
      // After the exact fixes, so a replacement that reintroduces a phrase is
      // caught by the patterns rather than slipping past them. A rule may
      // replace with a function — the delegate tool names need the member id
      // with hyphens turned into underscores, which a template string cannot do.
      for (const rule of MECHANICAL_REWRITES) {
        next = typeof rule.replace === 'function'
          ? next.replace(rule.find, rule.replace)
          : next.replace(rule.find, () => rule.replace as string)
      }
      return next
    },
    staleReport: () => {
      const stale = fixes.filter((_, index) => !applied.has(index))
      if (stale.length === 0) return undefined
      return 'these fabrication fixes matched nothing — upstream reworded, so re-read the source and update them:\n'
        + stale.map(fix => `  - ${fix.why}\n    找的是: ${(fix.find.split('\n')[0] ?? '').slice(0, 60)}…`).join('\n')
    },
  }
}
