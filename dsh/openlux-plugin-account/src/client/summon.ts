/**
 * Summon: land one expert on a fresh session with its opening question already
 * in the composer.
 *
 * ## The result being reproduced
 *
 * In WorkBuddy the expert center has no install button — picking an expert
 * opens a new conversation, and its `defaultInitPrompt` is *prefilled* into the
 * input box rather than sent (its own comment: 「解析专家召唤时预填输入框的默认
 * 提示词」, with `quickPrompts[0]` as the fallback). Nothing is auto-sent, so
 * the user still edits and presses Enter.
 *
 * ## Why it is three kernel calls and no mechanism of our own
 *
 * Every step already exists as a published face, and the kernel runs this exact
 * flow itself: `ui-agent-preset`'s Creator-mode entry sits in a settings section
 * and does `seat.stage(id) + workspaces.startSession()`. We cannot reuse that
 * seat (it is private to that package and hardcodes the `cordis` preset), but we
 * can take the same three steps through the faces it is built on:
 *
 * 1. `workspaces.startSession()` — reuse-or-create the workspace's blank
 *    session and open it. Fire-and-forget by design, hence step 2's shape.
 * 2. `agentPresets.select({ sessionId, agentPreset })` — the same RPC the
 *    hero chip's apply uses. It refuses a session that has already run a turn,
 *    which is why we only ever apply to a blank one.
 * 3. `conversation.input.for(actx).setDraft(text)` — the composer's single
 *    draft write path, reached through `sessions.scope(id)`. This is the route
 *    `ui-commands` and the queue dock already use to touch a session's input
 *    from outside the conversation package.
 *
 * ## Why a staged request rather than a straight-line await
 *
 * The session may become current before or after the pick — the workspace
 * connect either creates a blank session or reuses one, and `startSession` does
 * not hand back the id. So the request is staged and applied by whoever sees
 * the current session change, which is the same answer the kernel's seat
 * controller gives (`seat-store.ts`: "the session may appear either before or
 * after the pick").
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  InputTriggerController,
  ReferenceInsert,
  TokenSpan,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'

/** What one summon carries. */
export interface SummonRequest {
  /**
   * Installed preset id (the market slug; the two are the same by design).
   *
   * Absent when the errand is only the composer: «试一试» on an installed skill
   * and «创建技能» both want a blank session holding an opening line, and a
   * skill belongs to no composition — it is read by whichever agent is running.
   * Passing the default's id instead is not available to this caller, and
   * passing an empty one would ask the kernel to switch to a preset that does
   * not exist.
   */
  readonly preset?: string
  /** Opening question to prefill; empty means land on the preset with a clean composer. */
  readonly prompt: string
  /**
   * Name of a leading `/name` token already present in {@link prompt}.
   *
   * The token is the host-side invocation contract. This hint only lets the
   * client prime DSH's native skill lexicon so the same literal text receives
   * its derived chip decoration on a cold session.
   */
  readonly skillToken?: string
  /**
   * The market case this summon is a 「做同款」 of.
   *
   * Carried through to {@link SummonController.apply} because only that point
   * knows which session the summon landed on: the host then writes the staged
   * reference HTML into that session's working directory and injects the
   * reading instruction (`market/case-reference.ts`). Never rides the visible
   * draft — the prompt the user sees stays pure business copy.
   */
  readonly caseReference?: { readonly playbookId: number }
}

/**
 * The composer face we need, named structurally.
 *
 * The plugin does depend on `dsh-client-ui-conversation` for the composer slot's
 * types, but only as types — and this is a *value* reached through the service
 * registry, where the kernel itself types cross-package faces structurally when
 * the dependency direction forbids the import (`ui-conversation`'s own
 * `PopupDismissFace`: "typed structurally to avoid a value import").
 */
interface ConversationFace {
  readonly input: {
    for(actx: ClientContext): SessionComposer
  }
}

/** The composer verbs reached from outside a slot component. */
export interface SessionComposer {
  /** The single draft write path (the machine mirrors it into the persisted chat store). */
  setDraft(text: string): void
  /**
   * Session-routed notice strip; a refused preset switch is reported here, and
   * so is the file button's "this model cannot see, so the picture came in as a
   * path". The kernel's own notice carries either level (`InputNotice`).
   */
  notify(level: 'info' | 'error', text: string): void
  /**
   * Place one inline reference occurrence over a draft range — the verb behind
   * the `@` completion's chips, which the file button uses to show an
   * attachment as a chip instead of a path (`file-reference.ts`).
   *
   * The span is compared against the live `draftRev` before anything is
   * written, and `false` means exactly that check failed: the draft moved under
   * us and nothing happened.
   * @param reference - the occurrence's owner, id, and display projections.
   * @param span - the range to replace, stamped with the revision it was read at.
   * @returns whether the machine applied it.
   */
  insertReference(reference: ReferenceInsert, span: TokenSpan): boolean
  readonly state: { getSnapshot(): { draft: string; draftRev: number } }
}

type SkillTriggerController = Pick<InputTriggerController, 'dismiss' | 'lexicon' | 'track'>

/**
 * Warm the native slash source for one explicit skill token without leaving its
 * candidate menu open.
 *
 * `track` starts each source's candidate call synchronously. DSH's skill source
 * keeps its session catalog single-flight outside the menu abort signal, so an
 * immediate dismiss prevents a menu flash while the settling catalog still
 * publishes the lexicon that drives plain-text chip decoration.
 */
export function primeSkillDecoration(
  controller: SkillTriggerController,
  draft: string,
  draftRev: number,
  skill: string,
): void {
  const token = `/${skill}`
  if (!draft.startsWith(`${token} `)) return
  if (controller.lexicon.getSnapshot().get('/')?.includes(skill) === true) return
  controller.track(draft, token.length, { tier: 'plain' }, draftRev)
  controller.dismiss()
}

/** Structural sessions face shared safely across workspace package junctions. */
interface SummonSessions {
  scope(id: SessionId): ClientContext | undefined
  readonly list: {
    getSnapshot(): {
      readonly current?: SessionId
      readonly byId: Readonly<Record<string, {
        readonly blank: boolean
        readonly agentPreset?: string
      } | undefined>>
    }
  }
}

function sessionsOf(scope: ClientContext): SummonSessions {
  return scope.sessions as unknown as SummonSessions
}

/**
 * One session's composer, or `undefined` while no conversation view is mounted
 * for it.
 *
 * Exported because `notify` is the only channel that puts a message where the
 * user is looking, and it does not ride the session standard kit — the kernel's
 * own dock entries take it through their inject face
 * (`ui-conversation/client/queue/QueueDock.d.ts:7`), which is what the file
 * button does with this.
 * @param scope - the client root context.
 * @param id - the session whose composer is wanted.
 * @returns that composer's facade, when it exists.
 */
export function composerFor(scope: ClientContext, id: SessionId): SessionComposer | undefined {
  const actx = sessionsOf(scope).scope(id)
  if (actx === undefined) return undefined
  const conversation = actx.get('conversation') as ConversationFace | undefined
  return conversation?.input.for(actx)
}

/** Stages one summon and applies it to the blank session it lands on. */
export class SummonController {
  /** Set between the pick and the session that takes it. */
  private pending: SummonRequest | undefined

  /**
   * The last prompt this controller wrote, per session.
   *
   * Consecutive summons reuse one blank session, so the second would find the
   * first one's prompt sitting in the composer. Overwriting our own text keeps
   * the last pick honest; overwriting anything else would eat what the user
   * typed, so that case is left alone.
   */
  private readonly written = new Map<SessionId, string>()

  /**
   * @param scope - a context with `sessions`, `workspaces` and `connection`
   * (the conversation service is read per use, since a session's composer
   * exists only while that session's conversation view is mounted).
   * @param attachCaseReference - hands a landed 「做同款」 to the host, which
   * stages the reference file and injects its instruction. Fire-and-forget:
   * a failure degrades to a summon without reference, never a broken one.
   * @param detachCaseReference - hands a landed reference-less summon to the
   * host, which deletes the session's reference file. A blank session can be
   * reused by any later summon; when the earlier one was a 「做同款」, its
   * reading instruction is already queued in the durable inbox and cannot be
   * withdrawn — deleting the file routes that instruction into its own
   * self-heal clause (file missing → follow the user's text, no questions).
   * Fire-and-forget for the same reason as attach.
   */
  constructor(
    private readonly scope: ClientContext,
    private readonly attachCaseReference?: (playbookId: number, sessionId: string) => void,
    private readonly detachCaseReference?: (sessionId: string) => void,
  ) {}

  /**
   * Take the user to this preset's new session.
   * @param request - preset and opening question.
   */
  summon(request: SummonRequest): void {
    this.pending = request
    // A blank session may already be current (the common case when the user
    // never left the new-session screen), in which case nothing has to start.
    if (this.blankCurrent() !== undefined) {
      void this.apply()
      return
    }
    this.scope.workspaces.startSession()
  }

  /**
   * Hand the staged request to the current session when it can take it.
   *
   * Called from the session-list subscription, because the session that will
   * receive it may not exist yet when {@link summon} returns.
   * @returns once the preset switch settled and the draft was written.
   */
  async apply(): Promise<void> {
    const pending = this.pending
    if (pending === undefined) return
    const session = this.blankCurrent()
    if (session === undefined) return
    // Cleared before the await: the list fires again during the switch, and a
    // second entrant would select the same preset twice.
    this.pending = undefined
    if (pending.preset !== undefined && session.agentPreset !== pending.preset) {
      const api = (this.scope.get('connection') as ConnectionHandle | undefined)?.api
      if (api === undefined) return
      const reply = await api.agentPresets.select({
        sessionId: session.id, agentPreset: pending.preset,
      })
      if (!reply.result.ok) {
        // The preset did not take, so the prompt would land on the wrong agent.
        // The message belongs beside the composer rather than back in settings,
        // which the user has already left by now.
        this.notify(session.id, reply.result.error.message)
        return
      }
      // The `agent-preset/selected` broadcast moves the chip and the header
      // label (ui-agent-preset subscribes to it), so nothing is noted here.
    }
    // Only now is the receiving session known, which is what the host needs to
    // place the reference file (the session's cwd) and to inject into the right
    // inbox. After the preset settled: a refused preset returns above, and a
    // reference without its expert would instruct whatever agent is there.
    // A reference-less summon instead detaches: the reused blank session may
    // still carry a queued reading instruction from an earlier 「做同款」, and
    // deleting the file is the only way to defuse it (see the constructor doc).
    if (pending.caseReference !== undefined) {
      this.attachCaseReference?.(pending.caseReference.playbookId, session.id)
    } else {
      this.detachCaseReference?.(session.id)
    }
    this.draft(session.id, pending.prompt, pending.skillToken)
  }

  /** The current session when it is blank, with the preset it already runs. */
  private blankCurrent(): { id: SessionId; agentPreset: string | undefined } | undefined {
    const state = sessionsOf(this.scope).list.getSnapshot()
    const id = state.current
    if (id === undefined) return undefined
    const summary = state.byId[id]
    // A started session's history was produced under its own composition; the
    // kernel's select refuses it, and hijacking it would be wrong anyway.
    if (summary === undefined || !summary.blank) return undefined
    return { id, agentPreset: summary.agentPreset }
  }

  /**
   * Prefill the composer, unless the user has text of their own there.
   * @param id - the receiving session.
   * @param text - the opening question; empty writes nothing.
   * @param skillToken - explicit leading skill token whose decoration should be primed.
   */
  private draft(id: SessionId, text: string, skillToken?: string): void {
    if (text === '') return
    const input = this.inputFor(id)
    if (input === undefined) return
    const draft = input.state.getSnapshot().draft
    if (draft !== '' && draft !== this.written.get(id)) return
    input.setDraft(text)
    this.written.set(id, text)
    if (skillToken === undefined) return
    const actx = sessionsOf(this.scope).scope(id)
    const inputTriggers = actx?.get('inputTriggers')
    if (actx === undefined || inputTriggers === undefined) return
    const written = input.state.getSnapshot()
    primeSkillDecoration(
      inputTriggers.sessionOf(actx),
      written.draft,
      written.draftRev,
      skillToken,
    )
  }

  /** Route a failure to the session's own composer notice strip. */
  private notify(id: SessionId, message: string): void {
    this.inputFor(id)?.notify('error', message)
  }

  /** The composer of one session, or undefined without a mounted conversation. */
  private inputFor(id: SessionId): SessionComposer | undefined {
    return composerFor(this.scope, id)
  }
}
