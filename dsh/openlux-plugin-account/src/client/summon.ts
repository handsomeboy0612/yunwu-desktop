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

/** What one summon carries. */
export interface SummonRequest {
  /** Installed preset id (the market slug; the two are the same by design). */
  readonly preset: string
  /** Opening question to prefill; empty means land on the preset with a clean composer. */
  readonly prompt: string
}

/**
 * The composer face we need, named structurally.
 *
 * `IConversation` lives in `dsh-client-ui-conversation`, which this plugin does
 * not depend on — and the kernel itself types cross-package faces this way when
 * the dependency direction forbids the import (`ui-conversation`'s own
 * `PopupDismissFace`: "typed structurally to avoid a value import").
 */
interface ConversationFace {
  readonly input: {
    for(actx: ClientContext): SessionComposer
  }
}

/** The two composer verbs a summon needs: write the draft, and report a failure beside it. */
interface SessionComposer {
  /** The single draft write path (the machine mirrors it into the persisted chat store). */
  setDraft(text: string): void
  /** Session-routed notice strip; a refused preset switch is reported here. */
  notify(level: 'error', text: string): void
  readonly state: { getSnapshot(): { draft: string } }
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
   * (the conversation service is read per use, since the composer is only
   * mounted in the advanced desktop composition).
   */
  constructor(private readonly scope: ClientContext) {}

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
    if (session.agentPreset !== pending.preset) {
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
    this.draft(session.id, pending.prompt)
  }

  /** The current session when it is blank, with the preset it already runs. */
  private blankCurrent(): { id: SessionId; agentPreset: string | undefined } | undefined {
    const state = this.scope.sessions.list.getSnapshot()
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
   */
  private draft(id: SessionId, text: string): void {
    if (text === '') return
    const input = this.inputFor(id)
    if (input === undefined) return
    const draft = input.state.getSnapshot().draft
    if (draft !== '' && draft !== this.written.get(id)) return
    input.setDraft(text)
    this.written.set(id, text)
  }

  /** Route a failure to the session's own composer notice strip. */
  private notify(id: SessionId, message: string): void {
    this.inputFor(id)?.notify('error', message)
  }

  /** The composer of one session, or undefined without a mounted conversation. */
  private inputFor(id: SessionId): SessionComposer | undefined {
    const actx = this.scope.sessions.scope(id)
    if (actx === undefined) return undefined
    const conversation = actx.get('conversation') as ConversationFace | undefined
    return conversation?.input.for(actx)
  }
}
