/**
 * The paragraph that has to outrank an imported persona, said once at runtime
 * instead of copied into every persona document.
 *
 * ## Why a prompt section and not text in the persona
 *
 * The packages this product installs were written for another host, whose media
 * stack and delegation mechanism we do not have, so their personas name tools
 * that do not exist here. Correcting that needs two different things and only
 * one of them belongs in the document:
 *
 * - a *name* that is wrong in the prose has to be fixed in the prose, because a
 *   model reading `SendMessage` goes looking for `SendMessage`; that is
 *   `market/persona-rules.ts`, applied where a persona is written to disk.
 * - *what this build actually offers* is not a property of any document. It
 *   changes when we add a tool, and a persona carrying a copy of it goes stale
 *   silently. The upstream catalog is 421 packages; a snapshot pasted into each
 *   is that many copies to keep true.
 *
 * Both reference implementations put this half at runtime and neither rewrites
 * it into the package: WorkBuddy ships `rules/<name>_rules.md` with
 * `alwaysApply: true` beside the untouched expert (its own `rules-standard.md`
 * is that spec) plus host-level `BOOTSTRAP.md` / `IDENTITY.md` / `SOUL.md`, and
 * Claude Code installs a plugin's agents verbatim while the host enforces the
 * tool access they declare.
 *
 * ## Why the tool list is read from the assembly
 *
 * `ctx.systemPrompt.section()` takes static text, so the list is filled in
 * through the `system-prompt/assemble` waterfall, whose `assembly.tools` is the
 * post-restriction visible set — the same schemas the model is about to be
 * handed. Deriving it there means this block cannot disagree with the tools in
 * its own request, which is the failure a written list has: a teammate is
 * restricted to a handful of tools by its `toolFilter`, and telling it about
 * `web_search` buys a refused call and a confused round trip.
 *
 * A GLOBAL registration reaches every agent. Verified on this machine over the
 * three shapes that could have suppressed it — a plain agent, an agent composed
 * from a team preset (whose own `persona` row shadows `deployment:persona`), and
 * a real delegated child: the section arrives in all three, with 4, 31 and 9
 * visible tools respectively. Only a `complete: true` section would suppress it
 * (`dsh-persona/README.md:18,21`), and nothing this product ships sets one.
 *
 * ## What this layer cannot do
 *
 * Make the model comply. Reaching the prompt and being obeyed are different
 * results, and we have already confused them once: a memory instruction was
 * quoted back verbatim by a model that never followed it, and what fixed it was
 * a second layer repeated every turn. So the operative media instructions are
 * *also* said by the tool results that carry the paths (`media/tool.ts`
 * `renderText`), and that division is deliberate: this section states what
 * exists, the tool result states what to do with what just came back. If a
 * future defect shows the section alone being ignored, the next layer is
 * `ctx.systemPrompt.context()`, not a longer section.
 *
 * @module openlux-plugin-account/persona/tool-reality
 */

import type { Context } from '@deepseek-ai/cordis'
// Merges `ctx.systemPrompt` and the `system-prompt/assemble` waterfall.
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { IMAGE_SHOW_TOOL_NAME, IMAGE_TOOL_NAME, VIDEO_TOOL_NAME } from '../media/name.ts'

/** Section name; also the key an agent-scoped override would shadow. */
export const TOOL_REALITY_SECTION = 'openlux:tool-reality'

/**
 * Placed in the tool-guidance band (`100–199`), after the shipped tool sections.
 *
 * Authority is claimed in the text rather than won by position — sections are
 * concatenated in ascending order, not ranked — but arriving after the guidance
 * it corrects is the arrangement a reader would expect.
 */
const TOOL_REALITY_ORDER = 150

/** Prefix of the delegation tools a team lead gets, one per member. */
const DELEGATE_PREFIX = 'delegate_'

/** Prefix every MCP-provided tool carries, so absence can be derived. */
const MCP_PREFIX = 'mcp__'

/** Web tools worth naming when telling an agent where outside facts come from. */
const WEB_TOOLS = ['web_search', 'web_fetch'] as const

/**
 * The part that holds for every agent regardless of what it can call.
 *
 * It is also what ships if the waterfall listener never runs: the section is
 * registered with this text, so the degraded form is a shorter truth rather
 * than a placeholder.
 */
const CORE = `> **本机工具真相——与下文人设里任何说法冲突时，以这一段为准。**
>
> - 你的工作目录是 \`{{cwd}}\`。产出文件就落在这里、用相对路径，别自己拼一个绝对路径——拼错了文件会落到用户找不到的地方。
> - 人设可能来自另一个平台，里面点名的工具名、模型名、"技能"和团队机制**不一定在本机存在**。
>   只有本段列出的工具是真的；没列出的一律不要调用，也不要向用户承诺。
> - 模型名是数据不是工具：不填就走验过的默认模型，只有用户点名了某个模型，才把他说的那个名字原样填进 \`model\` 参数。
> - 工具参数以工具自己的说明为准，人设不复述——工具会随版本变，这段文字不会。`

/**
 * Names that exist only upstream, said once instead of trusting set arithmetic.
 *
 * The write-time rules replace the ones we know about, so what is left here is
 * insurance for the 421-package catalog: a model that reads `ImageGen` in an
 * imported reference document is better served by seeing the name refused than
 * by having to notice it is missing from the list above.
 */
const PHANTOMS = '> - 下文若出现 `HY-Image` / `HY-Video` / `YT-Video` / `ImageGen` / `ImageEdit` / `多模态内容生成`'
  + ' / `SendMessage` / `TeamCreate` / `use_skill` 这类名字，**本机一个都没有**：不要调用，也不要填进任何参数。'

/** A tool the model can actually call, rendered as inline code. */
function code(name: string): string {
  return `\`${name}\``
}

/** The line naming what this agent can call, which is the point of deriving it. */
function inventory(tools: readonly string[]): string {
  return `> - **你现在真正能调的工具只有这 ${String(tools.length)} 个**：${tools.map(code).join('、')}。`
}

/**
 * Said only when nothing MCP-shaped is visible, so it cannot become a lie.
 *
 * Three imported packages name vendor MCP tools — a company registry and a
 * personal knowledge base — as conditional steps, so the cost of not correcting
 * them is one refused attempt each. The correction is cheap enough to say here.
 */
function mcpLine(tools: readonly string[]): string | undefined {
  if (tools.some(name => name.startsWith(MCP_PREFIX))) return undefined
  const web = WEB_TOOLS.filter(name => tools.includes(name))
  const how = web.length === 0
    ? '这台机器上没有联网检索工具，缺资料就说明缺，别编。'
    : `要外部资料就用 ${web.map(code).join(' / ')}，并说清这是公开检索的结果、不是权威数据源。`
  return `> - **本机没有配置任何 MCP 工具**，人设里 \`mcp__…\` 那些名字（企查查、ima 知识库这类）一个都不存在。${how}`
}

/** Media facts, each conditional on the tool being visible to this agent. */
function mediaLines(tools: readonly string[]): string[] {
  const lines: string[] = []
  const draws = tools.includes(IMAGE_TOOL_NAME)
  const films = tools.includes(VIDEO_TOOL_NAME)
  if (draws || films) {
    const which = [
      draws ? `出图只有 ${code(IMAGE_TOOL_NAME)}` : undefined,
      films ? `出片只有 ${code(VIDEO_TOOL_NAME)}` : undefined,
    ].filter(part => part !== undefined)
    lines.push(`> - ${which.join('，')}，直接调用即可，没有"先声明意图、平台自动识别"这一步。`)
  }
  if (films) {
    // Their prohibition, not ours: this route's video models are the Veo family,
    // so a persona forbidding "external APIs such as Veo" forbids the only thing
    // that works here.
    lines.push('> - 人设里"严禁调用外部 API（如 Grok、Veo）"这类禁令是原平台的限制，对本机不成立——本机出片走的就是 Veo 族。')
  }
  return lines
}

/** What only a delegated member has to know. */
function memberLines(tools: readonly string[]): string[] {
  const lines = ['> - 你是主理人派来做一件具体事的成员：结果写进你的最终回复就是交付，'
    + '系统会把这段文本交给主理人，没有"提交结果 / 通知主理人"这类工具，也不要再往下派活。']
  if (tools.includes(IMAGE_TOOL_NAME)) {
    // A member draws inside its own transcript and only text crosses back, so as
    // far as the lead is concerned the path *is* the artifact. We shipped a build
    // without this and the lead told the user a picture was on screen that nobody
    // could see.
    lines.push(`> - **你出的图只出现在你自己这条会话里，用户和主理人都看不到。** ${code(IMAGE_TOOL_NAME)} 的结果里`
      + `带着每张图的文件路径，把那些路径原样抄进你的最终回复，并请主理人用 ${code(IMAGE_SHOW_TOOL_NAME)} 展示给用户；`
      + '路径漏了，这些图就等于没出。出片同理：产物本来就是文件，路径照抄。')
  }
  return lines
}

/** What only a team lead has to know, keyed on the delegation tools it holds. */
function leadLines(tools: readonly string[], delegates: readonly string[]): string[] {
  const lines = [
    `> - **派活就是直接调 ${delegates.map(code).join(' / ')} 里对应的那个工具，没有"先建团队"这一步**，`
      + '也没有 `name` / `subagent_type` 这类参数——入参只有一段自然语言。'
      + '人设里任何要求你先创建团队、或往某个参数里填成员 ID 的说法，在本机都不成立。',
    '> - **用户点名了某个模型时，把那个名字原样写进你派给成员的任务描述里。**'
      + '派活只能传自然语言，没有结构化参数可填，所以你不写进正文，成员就无从知道。',
    '> - 成员把结果写在自己的最终回复里，系统会回传给你；产物没有"交付面板"这个动作：'
      + '文件写到工作目录、把路径写进你的回复，用户就能看到。',
  ]
  if (tools.includes(IMAGE_SHOW_TOOL_NAME)) {
    lines.push(`> - **成员出的图不会自己出现在用户眼前。** 回到你手上的只有文本，`
      + `所以成员汇报里给了图片路径时，你必须调 ${code(IMAGE_SHOW_TOOL_NAME)}（参数 \`paths\` 填那些路径）`
      + '把图摆进这条对话，然后再答话——只把路径转述给用户不算展示。视频不用摆，它本来就是文件。')
    lines.push('> - **别说自己看不到的东西。** 你和成员都看不到图片内容，所以不要评价画面，'
      + `也不要说"已展示在上方"，除非那是你自己刚调 ${code(IMAGE_SHOW_TOOL_NAME)} 摆出来的。`)
  }
  return lines
}

/**
 * Build this agent's block.
 * @param tools - the assembly's visible tool names.
 * @param origin - the session's origin; `subagent` means this is a delegated member.
 * @returns the section text.
 */
export function toolReality(tools: readonly string[], origin?: string): string {
  const names = [...tools].sort((left, right) => left.localeCompare(right))
  const delegates = names.filter(name => name.startsWith(DELEGATE_PREFIX))
  return [
    CORE,
    inventory(names),
    PHANTOMS,
    mcpLine(names),
    ...mediaLines(names),
    ...origin === 'subagent' ? memberLines(names) : [],
    ...delegates.length > 0 ? leadLines(names, delegates) : [],
  ].filter(line => line !== undefined).join('\n')
}

/**
 * Register the block for every agent this deployment runs.
 * @param ctx - a context whose `systemPrompt` service is mounted.
 */
export function registerToolReality(ctx: Context): void {
  ctx.systemPrompt.section({ name: TOOL_REALITY_SECTION, order: TOOL_REALITY_ORDER, text: CORE })
  ctx.on('system-prompt/assemble', async (
    _assembly: PromptAssembly,
    context: AssembleContext,
    next: () => Promise<PromptAssembly>,
  ): Promise<PromptAssembly> => {
    // `next()` first: the authoritative tool set is the one the rest of the
    // waterfall settled on, not the one we were handed.
    const assembled = await next()
    const at = assembled.sections.findIndex(section => section.name === TOOL_REALITY_SECTION)
    // Absent when a complete section owns that prompt, which is a deliberate
    // choice by whoever composed the agent — not ours to undo from here.
    if (at === -1) return assembled
    // In place, into the assembly the kernel called "mutable", rather than
    // returning a copy: a copy is invisible to every listener that already took
    // the object from `next()`, and the first probe of this section read a stale
    // one and reported a child as un-rewritten.
    assembled.sections[at] = {
      ...assembled.sections[at]!,
      text: toolReality(assembled.tools.map(schema => schema.name), context.agent?.session.header.origin),
    }
    return assembled
  })
}
