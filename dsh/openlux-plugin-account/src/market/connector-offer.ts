/**
 * The model-facing "this needs a service you have not connected" card.
 *
 * A model asked to read a Notion page, or to ask a question about an open-source
 * repository, has two honest moves without this: refuse, or tell the user to go
 * to the market and find something themselves. The reference product has a third
 * — it puts a card in the conversation offering to connect one, and carries on
 * with the tools that arrive. This is that third move.
 *
 * ## Why it is a question rather than a card of our own
 *
 * The kernel already owns this interaction: `ctx.userQuestions.ask()` pauses the
 * tool call, the renderer's provider draws a panel above the composer with the
 * options, a free-text field, «跳过本题» and «提交», and the answer comes back as
 * the labels the user picked (`dsh-user-questions/README.zh.md`). Its own words
 * for what we would otherwise have invented: *「工具调用等待 Promise，工具结果随后
 * 恢复正常的 agent loop」*, and *「等待人类回答不会增加 token」*.
 *
 * What that seam does not carry is the reference product's richer card — the
 * per-candidate 连接中… / 已连接 chips and the running countdown. Its own README
 * says so («词汇仅包含问题表单形态»), and a UI that does not know an intent tag
 * renders the generic option list anyway. So the *behaviour* is reproduced (offer,
 * choose or skip, connect, carry on) and the chrome is the kernel's. Teaching the
 * renderer a new intent is a change to a kernel package, which is a maintenance
 * cost to take on for chrome, not for behaviour.
 *
 * ## Why only the connectors that need no credential
 *
 * Of the console's nineteen, eight connect on one press; the rest want a pasted
 * token or a browser sign-in. A sign-in cannot finish inside this call: the flow
 * hands back a URL for the *renderer* to open (`connector-oauth.ts`), and this
 * runs in the host with no way to ask a browser for anything. Offering one anyway
 * would end the card with "now go to the market", which is a sentence the model
 * could have written without a tool. So they are filtered out here, and the model
 * is told to name the market instead.
 *
 * ## Why the tools show up in the very next request
 *
 * `dsh-agent-loop`'s turn loop calls `preStep` before every step, `preStep`
 * re-runs `systemPrompt.assemble`, and tool providers are «evaluated for each
 * assembly» (`dsh-system-prompt/lib/index.js:213`). So a server mounted while
 * this call is still running is in the tool list of the request that follows it.
 * Measured, not assumed: `docs/dsh-kernel-migration.md:455-456`.
 *
 * @module openlux-plugin-account/market/connector-offer
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { readCatalog } from './catalog.ts'
import type { ConsoleAccess } from './console.ts'
import { installConnector, readConnectorRequirement, readConnectorTarget } from './connector-install.ts'
import type { CatalogItem, InstalledConnector } from './wire.ts'

/** What the model calls. */
export const CONNECTOR_OFFER_TOOL_NAME = 'connector_offer'

/**
 * How long the card waits before it counts as skipped.
 *
 * The reference product shows a countdown and skips on its own; the point of the
 * deadline is that an unattended session cannot be parked forever on a question.
 * Ours cannot draw the countdown in the generic panel, so the number is said in
 * the question text instead — a card that vanishes with no explanation is worse
 * than a card that says when it will.
 */
const ASK_DEADLINE_MS = 120_000

/** Above the deadline, so the deadline is what reports rather than the runtime. */
const TOOL_TIMEOUT_MS = 150_000

/** At most this many candidates on one card; more is a list, not a recommendation. */
const MAX_CANDIDATES = 3

/** One question, so its id is a constant. */
const QUESTION_ID = 'connector'

const description = 'Offer to connect an external service (MCP connector) when the user asks for something that needs one '
  + 'and you have no tool for it — reading or writing their Notion / WPS / Kingsoft documents, asking about an '
  + 'open-source repository, searching a vendor\'s own documentation, reading local files, querying their ERP. '
  + 'Pass what the user is trying to do in their own words; this shows them the matching connectors and connects '
  + 'the ones they pick, and the new tools are available to you from your next step onwards. '
  + 'Do not use it for anything you can already do (web search, web fetch, drawing, filming, looking at an image '
  + 'or a document), do not call it twice for the same need, and do not call it for a service the catalog has no '
  + 'entry for. If the user skips, say what you can do without it and move on — do not ask again.'

/** What the tool reads out of its own composition. */
export interface ConnectorOfferOptions {
  /** Console origin and token reader, shared with the account face. */
  readonly access: ConsoleAccess
}

/** What one call returns to the model. */
interface ToolValue {
  /** The sentence the model reads; also what the tool row shows. */
  readonly outcome: string
  /** Connector names now live, so the model can name them without guessing. */
  readonly connected: readonly string[]
}

/** A candidate, scored against what the user asked for. */
interface Candidate extends Match {
  readonly item: CatalogItem
}

/**
 * How one row matched.
 *
 * The two are different kinds of evidence, not two points on one scale: `named`
 * is somebody saying which service this is, and everything else is overlap that
 * might be a coincidence. Kept apart so the shortlist can drop the guesses the
 * moment there is a named row.
 */
interface Match {
  readonly named: boolean
  readonly score: number
}

/**
 * Register the offer tool, when this composition has both seams.
 *
 * Read opportunistically for the reason the media tools are: the account face
 * mounts in compositions that run no tools and in ones with no question
 * provider, and a missing seam should cost this tool rather than sign-in.
 * @param ctx - host context; the registration follows this fiber's lifetime.
 * @param options - console access.
 */
export function registerConnectorOfferTool(ctx: Context, options: ConnectorOfferOptions): void {
  const tools = ctx.get('tools')
  if (tools === undefined) {
    ctx.logger.debug('openlux: no tool runtime in this composition; the connector offer tool stays unregistered')
    return
  }
  if (ctx.get('userQuestions') === undefined) {
    ctx.logger.debug('openlux: no user-questions seam in this composition; the connector offer tool stays unregistered')
    return
  }

  ctx.effect(() => tools.register(defineTool({
    name: CONNECTOR_OFFER_TOOL_NAME,
    description,
    timeoutMs: TOOL_TIMEOUT_MS,
    // Two calls racing for the same panel would leave the user answering one
    // question with another underneath it, and both would mount servers.
    isConcurrencySafe: () => false,
    parameters: {
      need: {
        type: 'string',
        required: true,
        description: 'What the user is trying to do, in their own words and their own language — '
          + '"读我 Notion 里的会议记录", "问一下 vitest 仓库怎么配置". This is shown on the card, so keep it concrete.',
      },
      services: {
        type: 'array',
        description: 'The services you think this needs, by name — ["金山文档"], ["Notion", "Linear"]. '
          + 'Say the vendor\'s name, not a category ("表格工具" matches nothing). Leave it out when you cannot name one; '
          + 'the need is matched against the catalog either way.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outcome: { type: 'string', required: true },
          connected: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: (value as ToolValue).outcome }],
    },
    async execute(args, exec) {
      const need = args.need.trim()
      if (need === '') return { outcome: '没有说要做什么，没什么可推荐的。', connected: [] } satisfies ToolValue
      const named = (args.services ?? []).map(service => service.trim().toLowerCase()).filter(service => service !== '')

      const shelf = await pick(ctx, options.access, { need, named }, exec.signal)
      // Somebody naming a service that is already connected is not asking for
      // a card, and drawing one would answer a question they did not ask. On
      // the machine this is exactly what happened: a model that said
      // 「金山文档」 got a card offering local file access, because the row it
      // meant was filtered out for being installed and never mentioned again.
      if (shelf.known.length > 0) {
        return { outcome: shelf.known.map(report).join('') , connected: [] } satisfies ToolValue
      }
      const candidates = shelf.offerable
      if (candidates.length === 0) {
        return {
          outcome: '目录里没有能一键连上的连接器对得上这件事。要用需要授权的那些（Notion、Linear、'
            + 'Stripe 之类），得让用户自己去市场的「连接器」里连一次。',
          connected: [],
        } satisfies ToolValue
      }

      const answer = await askWhich(ctx, need, candidates, exec)
      if (answer === undefined) {
        // Not «未启用连接器»: a model reading that told the user their connector
        // was disabled, when all that had happened was nobody answered the card.
        return { outcome: '用户没有选，这一次没有连上任何连接器。', connected: [] } satisfies ToolValue
      }

      const chosen = candidates.filter(candidate => answer.includes(candidate.item.name))
      if (chosen.length === 0) {
        // A free-text answer, or a label that no longer matches a row. Either way
        // the user said something rather than nothing, and it belongs to the model.
        return {
          outcome: `用户没有选目录里的选项，他说的是：${answer.join('；')}`,
          connected: [],
        } satisfies ToolValue
      }

      const connected: string[] = []
      const failed: string[] = []
      for (const candidate of chosen) {
        const outcome = await installConnector(ctx, options.access, {
          slug: candidate.item.slug,
          name: candidate.item.name,
          ...candidate.item.version === '' ? {} : { version: candidate.item.version },
        }, exec.signal)
        if (outcome.kind === 'installed') connected.push(candidate.item.name)
        else failed.push(`${candidate.item.name}（${outcome.message}）`)
      }
      return {
        outcome: [
          connected.length === 0 ? undefined : `已连接 ${connected.join('、')}，它的工具从下一步开始就能用。`,
          failed.length === 0 ? undefined : `${failed.join('、')} 连接失败。`,
        ].filter(line => line !== undefined).join('') || '什么都没连上。',
        connected,
      } satisfies ToolValue
    },
  })))
}

/** What the shelf has to say about one ask. */
interface Shelf {
  /** Connectable rows worth a card, best first, at most {@link MAX_CANDIDATES}. */
  readonly offerable: readonly Candidate[]
  /** Rows the ask names that are connected already, so there is nothing to offer. */
  readonly known: readonly InstalledConnector[]
}

/**
 * The connectors worth offering for this need.
 *
 * Matched against the console's own rows rather than through a need → slug table
 * in this build: the catalog grows in the console, and a table here would answer
 * for a shelf it has never seen.
 * @param ctx - host context.
 * @param access - console origin and token reader.
 * @param ask - what the user is trying to do, and the services the model named.
 * @param signal - caller cancellation.
 * @returns what to offer, and what is already connected.
 */
async function pick(
  ctx: Context,
  access: ConsoleAccess,
  ask: { readonly need: string; readonly named: readonly string[] },
  signal?: AbortSignal,
): Promise<Shelf> {
  const [catalog, target] = await Promise.all([
    readCatalog(ctx, { ...access, type: 'connector' }, signal),
    readConnectorTarget(ctx),
  ])
  // Only a naming counts here, never a hint: an installed row has no blurb to
  // match on, and "you already have this" is a claim worth being sure about.
  const known = target.installed.filter(row => score(ask, { name: row.name, slug: row.slug }).named)
  if (known.length > 0) return { offerable: [], known }

  const already = new Set(target.installed.map(row => row.slug))
  const scored = catalog.items
    .filter(item => !already.has(item.slug) && item.unavailable === undefined)
    .map(item => ({ item, ...score(ask, item) }))
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score)
  // One named row makes every guess beside it noise. Measured on the machine: a
  // need saying 金山文档 came back offering Cloudflare's docs and DeepWiki too,
  // because all three blurbs contain 文档 — three plausible-looking rows where
  // the user had already said which one they meant.
  const shortlist = scored.some(candidate => candidate.named)
    ? scored.filter(candidate => candidate.named)
    : scored

  // The credential check is a request per row, so it runs on the few that
  // already matched rather than on the whole shelf.
  const offerable: Candidate[] = []
  for (const candidate of shortlist) {
    if (offerable.length >= MAX_CANDIDATES) break
    const requirement = await readConnectorRequirement(ctx, access, candidate.item.slug, signal)
    if (requirement.refusal !== undefined) continue
    if (requirement.mode === 'none' || requirement.authorized === true) offerable.push(candidate)
  }
  return { offerable, known: [] }
}

/**
 * What to tell the model about a connector it named that is already connected.
 *
 * The three cases are three different next moves, so they are three different
 * sentences: use the tools, send the user to repair the sign-in, or say what
 * broke. Naming the namespace matters in the first — a model that has just been
 * refused by `mcp__kdocs__*` needs to know that those *are* this connector.
 * @param row - the connected row.
 * @returns one sentence for the tool result.
 */
function report(row: InstalledConnector): string {
  if (row.live) {
    return `${row.name} 已经连上了，它的工具就在你的列表里（mcp__${row.serverName}__*），直接用。`
  }
  if (row.needsAuthorization === true) {
    return `${row.name} 连着，但它的授权已经失效了。让用户去市场的「连接器」里点「重新授权」，这一步只能由用户完成。`
  }
  if (row.failure !== undefined) return `${row.name} 连着，但现在用不了：${row.failure}`
  return `${row.name} 连着，但这一次启动没有把它挂起来。让用户去市场的「连接器」里看这一行。`
}

/** Latin runs worth matching on; one or two letters match everything and nothing. */
const LATIN = /[a-z0-9]{3,}/giu

/** Chinese arrives as one unbroken run, so overlap with it is measured in pairs. */
const CJK = /[\u4e00-\u9fa5]{2,}/gu

/**
 * How well one row answers one need.
 *
 * Two signals, and they are not the same kind of thing. *Named* is somebody
 * saying which service this is — the model's `services`, or the user's own words
 * containing the row's name; a named row is offered even if nothing else lines
 * up. *Hinted* is loose overlap with the blurb, which is a guess, so it takes
 * several before it counts as one.
 *
 * The pair scan is what makes the Chinese case work at all. A need arrives as
 * one run — 「帮我看看金山文档里那份表」 is a single token to any word split, so
 * `name.includes(need)` is false for every row on the shelf and the first draft
 * of this function recommended nothing to a user who had named the service in
 * the sentence. Comparing two-character slices finds 金山 / 山文 / 文档 in the
 * row's own name instead.
 * Takes the matchable fields rather than a catalog row, because a connected row
 * has to go through the same rule and carries only its name and slug. With no
 * tags and no blurb, nothing but a naming can score — which is the intended
 * strictness for the claim "you already have this".
 * @param ask - the need, and the service names the model supplied.
 * @param item - one row's matchable text.
 * @returns how it matched; a zero score means "do not offer this".
 */
function score(
  ask: { readonly need: string; readonly named: readonly string[] },
  item: Pick<CatalogItem, 'name' | 'slug'> & Partial<Pick<CatalogItem, 'tags' | 'descriptionZh' | 'descriptionEn'>>,
): Match {
  const needle = ask.need.toLowerCase()
  const name = item.name.toLowerCase()
  const slug = item.slug.toLowerCase()
  const tags = (item.tags ?? []).map(tag => tag.toLowerCase())
  const blurb = `${item.descriptionZh ?? ''} ${item.descriptionEn ?? ''}`.toLowerCase()

  let named = 0
  let hinted = 0

  // Either direction counts, because a row is named "WPS 金山文档" and the model
  // answers "金山文档". Against the *name* only: tags here are category words
  // (办公 / 文档 / 开发), and "the service name contains the tag" is true of every
  // row in that category — on the machine, 「金山文档」named Cloudflare's docs and
  // Context7 as well, all three carrying the 文档 tag.
  for (const service of ask.named) {
    if (touches(service, name) || touches(service, slug)) named += 2
  }
  if (needle.includes(name) || needle.includes(slug)) named += 2

  for (const word of new Set((needle.match(LATIN) ?? []).map(match => match.toLowerCase()))) {
    if (name.includes(word) || slug.includes(word)) named += 1
    else if (tags.some(tag => tag.includes(word))) hinted += 2
    else if (blurb.includes(word)) hinted += 1
  }

  // Measured on the row's *name*, not on the need: how much of the name the need
  // repeats. One pair is a word like 文档 that half the shelf shares — 「金山文档」
  // named Cloudflare's docs that way on the first real run. Two pairs is a
  // three-character run of the name, which is somebody saying it.
  const covered = pairs(name).filter(pair => needle.includes(pair)).length
  if (covered >= 2) named += covered
  else if (covered === 1) hinted += 2

  for (const pair of pairs(needle)) {
    if (tags.some(tag => tag.includes(pair))) hinted += 2
    else if (blurb.includes(pair)) hinted += 1
  }

  if (named > 0) return { named: true, score: 10 + named * 2 + Math.min(hinted, 6) }
  // Three loose overlaps with one blurb is the point where "库存"、"报表"、"订单"
  // stops looking like a coincidence. Below it, offer nothing.
  return { named: false, score: hinted >= 3 ? hinted : 0 }
}

/** Whether two names refer to the same thing, in whichever order they arrived. */
function touches(left: string, right: string): boolean {
  return left !== '' && right !== '' && (left.includes(right) || right.includes(left))
}

/**
 * Every two-character slice of the Chinese in one string.
 * @param text - the need, lowercased.
 * @returns distinct pairs, in no particular order.
 */
function pairs(text: string): readonly string[] {
  const found = new Set<string>()
  for (const run of text.match(CJK) ?? []) {
    for (let at = 0; at + 2 <= run.length; at += 1) found.add(run.slice(at, at + 2))
  }
  return [...found]
}

/**
 * Put the card up and wait.
 *
 * @param ctx - host context.
 * @param need - what the user is trying to do, shown on the card.
 * @param candidates - what to offer, best first.
 * @param exec - the tool's own execution, for the live agent and its signal.
 * @returns the labels the user picked, or `undefined` when they skipped it.
 */
async function askWhich(
  ctx: Context,
  need: string,
  candidates: readonly Candidate[],
  exec: { readonly agent?: AskUserQuestionRequest['agent']; readonly signal: AbortSignal },
): Promise<readonly string[] | undefined> {
  const questions = ctx.get('userQuestions')
  if (questions === undefined) return undefined

  const deadline = AbortSignal.timeout(ASK_DEADLINE_MS)
  const seconds = String(Math.round(ASK_DEADLINE_MS / 1000))
  let answer: AskUserQuestionAnswer
  try {
    answer = await questions.ask({
      questions: [{
        id: QUESTION_ID,
        header: '推荐连接器',
        question: `「${need}」需要一个还没连上的服务，连哪个？`,
        // The candidates are not listed here: the panel draws each option with
        // its own description right below this, and a first real-machine card
        // read every row twice. What is left is what the options cannot say.
        detail: `${seconds} 秒内没有选择就按跳过处理。连上之后它的工具对所有会话都可见，随时可以在市场里断开。`,
        options: candidates.map(candidate => ({
          label: candidate.item.name,
          description: candidate.item.descriptionZh,
        })),
        multiSelect: candidates.length > 1,
      }],
      ...exec.agent === undefined ? {} : { agent: exec.agent },
      signal: AbortSignal.any([exec.signal, deadline]),
    })
  } catch (error: unknown) {
    // The turn being cancelled is not a skip: it must reach the loop as the
    // abort it is, or the model would carry on inside a stopped turn.
    if (exec.signal.aborted) throw error
    if (deadline.aborted) return undefined
    // Anything else — no provider, a delegated caller, a dead agent — is the
    // seam refusing rather than the user answering. See the README's error
    // roster; every one of them means "no card was shown".
    ctx.logger.warn('openlux: connector offer could not ask: %s', error instanceof Error ? error.message : String(error))
    return undefined
  }

  const picked = answer.answers.find(row => row.id === QUESTION_ID)
  if (picked === undefined) return undefined
  const labels = [...picked.selected, ...picked.custom === undefined ? [] : [picked.custom]]
    .map(label => label.trim())
    .filter(label => label !== '')
  return labels.length === 0 ? undefined : labels
}
