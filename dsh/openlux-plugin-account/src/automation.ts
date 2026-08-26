import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type ModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  isUserInvocable,
  renderSkillContent,
  type SkillDefinition,
  type SkillSummary,
} from '@deepseek-ai/dsh-skill'
import {
  defineDomain,
  domainTable,
  type Domain,
  type KvTable,
} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-workspace'
import { z } from 'zod'
import {
  automationOccurrenceKey,
  automationScheduleOf,
  localTimeFingerprint,
  localTimeZoneName,
  nextAutomationRun,
} from './automation-schedule.ts'
import type {
  AutomationContextOptions,
  AutomationContextSnapshot,
  AutomationCreateInput,
  AutomationExecutionSelection,
  AutomationLastRun,
  AutomationModelSelection,
  AutomationOptionsInput,
  AutomationSchedule,
  AutomationSnapshot,
  AutomationTask,
  AutomationUpdateInput,
} from './automation-wire.ts'

const POLL_INTERVAL_MS = 30_000
const MISSED_RUN_WINDOW_MS = 24 * 60 * 60 * 1_000
const MAX_PARALLEL_RUNS = 2
const TITLE_MAX_CHARS = 120
const PROMPT_MAX_CHARS = 40_000
const MAX_SELECTED_SKILLS = 32

const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.number().int().positive() }),
  z.object({
    kind: z.literal('daily'),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    kind: z.literal('weekly'),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
])

const contextSchema = z.object({
  sourceSessionId: z.string().min(1),
  cwd: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
  agentPreset: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  skills: z.array(z.string().min(1)).default([]),
  permissionPreset: z.string().min(1).default('workspace-write'),
})

const lastRunSchema = z.object({
  occurrenceKey: z.string().min(1),
  scheduledFor: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative(),
  sessionId: z.string().min(1).optional(),
  status: z.enum(['succeeded', 'failed']),
  error: z.string().min(1).optional(),
})

const activeRunSchema = z.object({
  occurrenceKey: z.string().min(1),
  scheduledFor: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
  manual: z.boolean(),
})

const storedAutomationSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().min(1),
  enabled: z.boolean(),
  schedule: scheduleSchema,
  nextRunAt: z.number().int().nonnegative().nullable(),
  context: contextSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  lastRun: lastRunSchema.optional(),
  activeRun: activeRunSchema.optional(),
})

type StoredAutomation = z.infer<typeof storedAutomationSchema>
type ActiveRun = z.infer<typeof activeRunSchema>

const automationDomainSpec = defineDomain({
  name: 'openlux_automations',
  version: 1,
  tables: {
    tasks: domainTable<string, StoredAutomation>(storedAutomationSchema),
  },
})

type AutomationDomain = Domain<typeof automationDomainSpec>
type AutomationTable = KvTable<string, StoredAutomation>

interface AutomationSessionEvent {
  readonly type: string
  readonly data: unknown
}

interface AutomationSession {
  readonly header: {
    readonly cwd?: string
    readonly agentPreset?: string
  }
  readonly events: readonly AutomationSessionEvent[]
  requestHeader(): {
    readonly config: {
      readonly provider: string
      readonly model: string
      readonly reasoningEffort?: string
    }
  } | undefined
}

interface AutomationAgent {
  readonly id: string
  readonly ctx: Context
  readonly session: AutomationSession
  followup(message: unknown): void
  inject(message: unknown): void
  whenIdle(): Promise<void>
}

interface AutomationAgentHandle {
  readonly agent: AutomationAgent
  dispose(): Promise<void>
}

interface AutomationAgents {
  create(options: {
    readonly sessionId: string
    readonly agentOptions: { readonly provider: string; readonly model: string }
    readonly meta: {
      readonly cwd: string
      readonly agentPreset?: string
    }
    readonly setup: (agentCtx: Context) => Promise<void>
  }): Promise<AutomationAgentHandle>
  get(id: string): AutomationAgent | undefined
}

interface AutomationAgentPresets {
  readonly defaultId: string
  mount(agentCtx: Context, id?: string): Promise<unknown>
  composedPreset(agentCtx: Context): string | undefined
  list(): Promise<readonly AutomationPreset[]>
  resolve(id?: string): Promise<AutomationPreset>
  standingKeyFor(id?: string): Promise<unknown>
}

interface AutomationPreset {
  readonly id: string
  /** `system` presets ship with the deployment; `user` ones are installed experts. */
  readonly trust: string
  readonly name?: string
  readonly description?: string
  readonly broken?: string
}

/** The llm registry faces the gateway's own model catalog and selection use. */
interface AutomationLlm {
  listProviders(): readonly { readonly id: string; readonly name: string }[]
  listModels(provider: string): Promise<readonly {
    readonly id: string
    readonly name: string
    readonly description?: string
  }[]>
  resolveCallConfig(config: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }): Promise<{
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }>
}

interface AutomationWorkspace {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  attachSession(sessionId: string): Promise<void>
  status(): Promise<'ok' | 'missing-dir'>
}

interface AutomationWorkspaceRegistry {
  list(): AutomationWorkspace[]
  get(id: string): AutomationWorkspace | undefined
  resolveByPath(path: string): Promise<AutomationWorkspace | undefined>
}

interface AutomationSkills {
  list(options?: { readonly cwd?: string; readonly scope?: unknown }): Promise<SkillSummary[]>
  get(
    name: string,
    options?: { readonly cwd?: string; readonly scope?: unknown },
  ): Promise<SkillDefinition | undefined>
}

interface AutomationPermissionPresets {
  readonly names: readonly string[]
  readonly defaultPreset: string
  current(events: readonly AutomationSessionEvent[]): string
  optionOf(name: string): {
    readonly value: string
    readonly name: string
    readonly description?: string
  }
  set(session: unknown, name: string): void
}

interface AutomationSessionPersistence {
  list(): Promise<readonly { readonly id: string }[]>
  inspect(id: string): Promise<{ readonly events: readonly AutomationSessionEvent[] }>
}

interface AutomationStorageDomain {
  open(spec: typeof automationDomainSpec): Promise<AutomationDomain>
}

interface AutomationServices {
  readonly agents: AutomationAgents
  readonly agentDefaultModel: { currentSelection(): ModelSelection }
  readonly agentPresets: AutomationAgentPresets
  readonly llm: AutomationLlm
  readonly permissionPresets: AutomationPermissionPresets
  readonly sessionPersistence: AutomationSessionPersistence
  readonly skills: AutomationSkills
  readonly storageDomain: AutomationStorageDomain
  readonly workspaceRegistry: AutomationWorkspaceRegistry
}

/** Runtime resolver installed without making account/login depend on Agent services. */
export interface AutomationRuntimeResolver {
  /** Resolve the mounted runtime or reject when this composition has no automation services. */
  get(): Promise<AutomationRuntime>
}

/**
 * Mount automation only when its DSH services are available.
 *
 * The account and market surfaces remain usable in smaller compositions; the
 * desktop profile supplies every service named here.
 */
export function installAutomationRuntime(ctx: Context): AutomationRuntimeResolver {
  let opening: Promise<AutomationRuntime> | undefined

  ctx.inject([
    'agents',
    'agentDefaultModel',
    'agentPresets',
    'llm',
    'permissionPresets',
    'sessionPersistence',
    'skills',
    'storageDomain',
    'workspaceRegistry',
  ], (scope) => {
    const current = AutomationRuntime.open(scope)
    opening = current
    void current.catch((error: unknown) => {
      scope.logger.error('openlux automation runtime failed to open')
      scope.logger.error(error)
    })
    scope.effect(
      () => () => current.then(runtime => runtime.close()).catch((error: unknown) => {
        scope.logger.warn('openlux automation runtime failed to close cleanly')
        scope.logger.warn(error)
      }),
      'openlux-automation: runtime',
    )
  })

  return {
    async get(): Promise<AutomationRuntime> {
      if (opening === undefined) throw new Error('当前内核组合未提供自动化所需服务')
      return await opening
    },
  }
}

/** Host-side scheduler, durable task store, and background-session executor. */
export class AutomationRuntime {
  private readonly table: AutomationTable
  private readonly handles = new Set<AutomationAgentHandle>()
  private readonly work = new Set<Promise<void>>()
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking = false
  private closed = false
  private timeFingerprint = localTimeFingerprint()

  private constructor(
    private readonly ctx: Context,
    private readonly domain: AutomationDomain,
    private readonly services: AutomationServices,
  ) {
    this.table = domain.table('tasks')
  }

  /** Open durable state, reconcile interrupted leases, then start polling. */
  static async open(ctx: Context): Promise<AutomationRuntime> {
    const services = automationServices(ctx)
    const domain = await services.storageDomain.open(automationDomainSpec)
    const runtime = new AutomationRuntime(ctx, domain, services)
    try {
      await runtime.recoverActiveRuns()
      runtime.timer = setInterval(() => { void runtime.tick() }, POLL_INTERVAL_MS)
      runtime.timer.unref?.()
      void runtime.tick()
      return runtime
    } catch (error: unknown) {
      await domain.close()
      throw error
    }
  }

  /** Stop live work before closing the domain handle owned by this consumer. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    await Promise.allSettled([...this.handles].map(handle => handle.dispose()))
    await Promise.allSettled([...this.work])
    await this.domain.close()
  }

  /** Dispatch one browser RPC endpoint and return its pure-data result. */
  async call(endpoint: string, payload: unknown): Promise<unknown> {
    switch (endpoint) {
      case 'automations.list':
        return this.snapshot()
      case 'automations.options':
        return await this.contextOptions(payload)
      case 'automations.create':
        return await this.create(payload)
      case 'automations.update':
        return await this.update(payload)
      case 'automations.toggle':
        return await this.toggle(payload)
      case 'automations.delete':
        return await this.remove(payload)
      case 'automations.run':
        return await this.runNow(payload)
      default:
        throw new Error(`unknown automation endpoint: ${endpoint}`)
    }
  }

  private async contextOptions(payload: unknown): Promise<AutomationContextOptions> {
    const input = optionsInputOf(payload)
    const creating = input.taskId === undefined
    const base = input.taskId === undefined
      ? this.captureContext(input.sourceSessionId as string)
      : publicContext(this.requireTask(input.taskId).context)
    const requestedWorkspace = input.workspaceId === undefined
      ? undefined
      : this.requireWorkspace(input.workspaceId)
    if (requestedWorkspace !== undefined && await requestedWorkspace.status() !== 'ok') {
      throw new Error('所选工作区目录当前不可用')
    }
    const cwd = requestedWorkspace?.path ?? base.cwd
    const workspaceId = requestedWorkspace === undefined
      ? base.workspaceId
      : String(requestedWorkspace.id)

    const [workspaceOptions, presets, modelOptions] = await Promise.all([
      Promise.all(this.services.workspaceRegistry.list().map(async (workspace) => ({
        id: String(workspace.id),
        title: workspace.title,
        path: workspace.path,
        ...(await workspace.status() === 'ok' ? {} : { disabledReason: 'missing-dir' }),
      }))),
      this.services.agentPresets.list(),
      this.modelOptions(),
    ])

    // Only market-installed experts are summonable; the deployment's own
    // system presets (标准/PTC/创造模式) are how the product is assembled and
    // never appear as a choice — same rule as the composer's preset seat.
    const experts = presets.filter(preset => preset.trust === 'user')
    const agentPreset = input.agentPreset === null
      ? undefined
      : input.agentPreset
        ?? (experts.some(expert => expert.id === base.agentPreset) ? base.agentPreset : undefined)

    let skillOptions: SkillSummary[] = []
    try {
      const scope = await this.services.agentPresets.standingKeyFor(agentPreset)
      skillOptions = (await this.services.skills.list({ cwd, scope })).filter(isUserInvocable)
    } catch {
      // Keep the editor recoverable when a stored expert was removed or broke.
      // Saving still validates the selected replacement against the live roster.
    }

    const permissionNames = this.services.permissionPresets.names
    const permissionPreset = creating && permissionNames.includes('danger-full-access')
      ? 'danger-full-access'
      : base.permissionPreset
    return {
      workspaces: workspaceOptions,
      experts: experts.map(preset => ({
        id: preset.id,
        name: preset.name ?? preset.id,
        ...(preset.description === undefined ? {} : { description: preset.description }),
        ...(preset.broken === undefined ? {} : { disabledReason: preset.broken }),
      })),
      models: modelOptions,
      skills: skillOptions.map(skill => ({
        name: skill.name,
        description: skill.description,
        source: skill.source,
      })),
      permissions: permissionNames.map((name) => {
        const option = this.services.permissionPresets.optionOf(name)
        return {
          value: option.value,
          name: option.name,
          ...(option.description === undefined ? {} : { description: option.description }),
          dangerous: option.value === 'danger-full-access',
        }
      }),
      defaults: {
        cwd,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(agentPreset === undefined ? {} : { agentPreset }),
        model: {
          provider: base.provider,
          model: base.model,
          ...(base.reasoningEffort === undefined ? {} : { reasoningEffort: base.reasoningEffort }),
        },
        skills: base.skills,
        permissionPreset,
      },
    }
  }

  /**
   * The same advisory catalog the gateway's `sessions.models` serves, read
   * from the same `llm` registry; a provider whose lookup fails is skipped
   * rather than failing the whole editor.
   */
  private async modelOptions(): Promise<AutomationContextOptions['models']> {
    const groups = await Promise.all(this.services.llm.listProviders().map(async (provider) => {
      try {
        const models = await this.services.llm.listModels(provider.id)
        return models.map(model => ({
          provider: provider.id,
          providerName: provider.name,
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
        }))
      } catch {
        return []
      }
    }))
    return groups.flat()
  }

  private snapshot(): AutomationSnapshot {
    const tasks = [...this.table.entries()]
      .map(([, record]) => publicTask(record))
      .sort((left, right) => right.createdAt - left.createdAt)
    return {
      tasks,
      localTimeZone: localTimeZoneName(),
      now: Date.now(),
    }
  }

  private async create(payload: unknown): Promise<AutomationTask> {
    const input = createInputOf(payload)
    const now = Date.now()
    assertFutureOnce(input.schedule, now, input.enabled)
    const context = await this.resolveExecutionContext(
      this.captureContext(input.sourceSessionId),
      input.execution,
    )
    const id = randomUUID()
    const record: StoredAutomation = {
      id,
      title: input.title,
      prompt: input.prompt,
      enabled: input.enabled,
      schedule: input.schedule,
      nextRunAt: input.enabled ? nextAutomationRun(input.schedule, now) : null,
      context,
      createdAt: now,
      updatedAt: now,
    }
    await this.table.put(id, record)
    return publicTask(record)
  }

  private async update(payload: unknown): Promise<AutomationTask> {
    const input = updateInputOf(payload)
    const now = Date.now()
    assertFutureOnce(input.schedule, now, input.enabled)
    const current = this.requireTask(input.id)
    if (current.activeRun !== undefined) throw new Error('自动化正在执行，请完成后再编辑')
    const context = await this.resolveExecutionContext(publicContext(current.context), input.execution)
    const updated = await this.table.update(input.id, current => {
      if (current.activeRun !== undefined) throw new Error('自动化正在执行，请完成后再编辑')
      return {
        ...current,
        title: input.title,
        prompt: input.prompt,
        enabled: input.enabled,
        schedule: input.schedule,
        nextRunAt: input.enabled ? nextAutomationRun(input.schedule, now) : null,
        context,
        updatedAt: now,
      }
    })
    return publicTask(updated)
  }

  private async toggle(payload: unknown): Promise<AutomationTask> {
    const { id, enabled } = toggleInputOf(payload)
    const now = Date.now()
    const updated = await this.table.update(id, current => {
      if (current.activeRun !== undefined) throw new Error('自动化正在执行，暂时不能切换状态')
      assertFutureOnce(current.schedule, now, enabled)
      return {
        ...current,
        enabled,
        nextRunAt: enabled ? nextAutomationRun(current.schedule, now) : null,
        updatedAt: now,
      }
    })
    return publicTask(updated)
  }

  private async remove(payload: unknown): Promise<{ readonly removed: boolean }> {
    const id = taskIdOf(payload)
    const current = this.table.get(id)
    if (current?.activeRun !== undefined) throw new Error('自动化正在执行，请完成后再删除')
    return { removed: await this.table.delete(id) }
  }

  private async runNow(payload: unknown): Promise<AutomationTask> {
    if (this.work.size >= MAX_PARALLEL_RUNS) throw new Error('已有自动化正在执行，请稍后再试')
    const id = taskIdOf(payload)
    const now = Date.now()
    const run: ActiveRun = {
      occurrenceKey: `manual:${randomUUID()}`,
      scheduledFor: now,
      startedAt: now,
      sessionId: randomUUID(),
      manual: true,
    }
    const claimed = await this.claim(id, run)
    this.launch(claimed, run)
    return publicTask(claimed)
  }

  /** Poll due tasks and recalculate recurring tasks after an OS timezone change. */
  private async tick(): Promise<void> {
    if (this.closed || this.ticking) return
    this.ticking = true
    try {
      const now = Date.now()
      if (localTimeFingerprint(now) !== this.timeFingerprint) {
        this.timeFingerprint = localTimeFingerprint(now)
        await this.rebaseRecurringTasks(now)
      }
      const due = [...this.table.entries()]
        .map(([, record]) => record)
        .filter(record => record.enabled
          && record.activeRun === undefined
          && record.nextRunAt !== null
          && record.nextRunAt <= now)
        .sort((left, right) => (left.nextRunAt ?? 0) - (right.nextRunAt ?? 0))

      for (const record of due) {
        if (this.closed || this.work.size >= MAX_PARALLEL_RUNS) break
        const scheduledFor = record.nextRunAt
        if (scheduledFor === null) continue
        if (now - scheduledFor > MISSED_RUN_WINDOW_MS) {
          await this.skipExpiredOccurrence(record.id, scheduledFor, now)
          continue
        }
        const occurrenceKey = automationOccurrenceKey(record.schedule, scheduledFor)
        if (record.lastRun?.occurrenceKey === occurrenceKey) {
          await this.advanceWithoutRun(record.id, scheduledFor, now)
          continue
        }
        const run: ActiveRun = {
          occurrenceKey,
          scheduledFor,
          startedAt: now,
          sessionId: randomUUID(),
          manual: false,
        }
        try {
          const claimed = await this.claim(record.id, run)
          this.launch(claimed, run)
        } catch (error: unknown) {
          this.ctx.logger.warn(`openlux automation ${record.id} could not claim its due occurrence`)
          this.ctx.logger.warn(error)
        }
      }
    } finally {
      this.ticking = false
    }
  }

  private async rebaseRecurringTasks(now: number): Promise<void> {
    for (const [id, record] of this.table.entries()) {
      if (!record.enabled || record.activeRun !== undefined || record.schedule.kind === 'once') continue
      await this.table.update(id, current => {
        if (!current.enabled || current.activeRun !== undefined || current.schedule.kind === 'once') return current
        return { ...current, nextRunAt: nextAutomationRun(current.schedule, now), updatedAt: now }
      })
    }
  }

  private async skipExpiredOccurrence(id: string, scheduledFor: number, now: number): Promise<void> {
    await this.table.update(id, current => {
      if (current.nextRunAt !== scheduledFor || current.activeRun !== undefined) return current
      if (current.schedule.kind === 'once') {
        return { ...current, enabled: false, nextRunAt: null, updatedAt: now }
      }
      return { ...current, nextRunAt: nextAutomationRun(current.schedule, now), updatedAt: now }
    })
  }

  private async advanceWithoutRun(id: string, scheduledFor: number, now: number): Promise<void> {
    await this.table.update(id, current => {
      if (current.nextRunAt !== scheduledFor || current.activeRun !== undefined) return current
      if (current.schedule.kind === 'once') {
        return { ...current, enabled: false, nextRunAt: null, updatedAt: now }
      }
      return { ...current, nextRunAt: nextAutomationRun(current.schedule, now), updatedAt: now }
    })
  }

  /** Persist a lease before creating any session-side effect. */
  private async claim(id: string, run: ActiveRun): Promise<StoredAutomation> {
    return await this.table.update(id, current => {
      if (current.activeRun !== undefined) throw new Error('自动化已经在执行')
      if (!run.manual) {
        if (!current.enabled || current.nextRunAt !== run.scheduledFor) {
          throw new Error('计划执行时间已经变化')
        }
        if (current.lastRun?.occurrenceKey === run.occurrenceKey) {
          throw new Error('本次计划已经执行')
        }
      }
      return { ...current, activeRun: run, updatedAt: run.startedAt }
    })
  }

  private launch(record: StoredAutomation, run: ActiveRun): void {
    const operation = this.execute(record, run)
      .catch((error: unknown) => {
        this.ctx.logger.error(`openlux automation ${record.id} execution escaped its result boundary`)
        this.ctx.logger.error(error)
      })
      .finally(() => { this.work.delete(operation) })
    this.work.add(operation)
  }

  /**
   * Execute one occurrence in a new background session.
   *
   * WorkBuddy does the same at
   * `automation-service.ts:457-485`: preallocate a UUID, create a session with
   * the automation marker and task title, then submit the prompt. DSH exposes
   * that shape through `AgentRegistry.create`.
   *
   * The handle is deliberately KEPT after the run: `dispose()` removes the
   * session from the live store (`dsh-agent/lib/types/index.d.ts:147-148`),
   * the host then broadcasts `host/session-removed`, and the client drops the
   * row — while the merged live+cold list is only refetched on reconnect
   * (`dsh-host-apiproxy/lib/index.js:2160`), so「查看结果」would 404 until an
   * app restart (2026-08-27, seen live). An idle handle keeps the result
   * session listed and immediately open-able; `close()` disposes them all.
   */
  private async execute(record: StoredAutomation, run: ActiveRun): Promise<void> {
    let handle: AutomationAgentHandle | undefined
    let outcome: RunOutcome = { status: 'failed', error: '执行未开始' }
    let materialized = false
    try {
      const selection = modelSelection(publicContext(record.context))
      const selectionRef: ModelSelectionRef = { current: selection, assembled: undefined }
      handle = await this.services.agents.create({
        sessionId: run.sessionId,
        agentOptions: { provider: selection.provider, model: selection.model },
        meta: {
          cwd: record.context.cwd,
          ...(record.context.agentPreset === undefined
            ? {}
            : { agentPreset: record.context.agentPreset }),
        },
        setup: async (agentCtx) => {
          ;(installModelSelection as unknown as (
            target: unknown,
            selection: ModelSelectionRef,
          ) => void)(agentCtx, selectionRef)
          await this.services.agentPresets.mount(agentCtx, record.context.agentPreset)
        },
      })
      this.handles.add(handle)

      const workspace = await this.services.workspaceRegistry.resolveByPath(record.context.cwd)
      if (workspace !== undefined) await workspace.attachSession(handle.agent.id)
      const sessionTitle = rawService(this.ctx, 'sessionTitle') as {
        rename(session: unknown, title: string): unknown
      } | undefined
      sessionTitle?.rename(handle.agent.session, record.title)

      this.services.permissionPresets.set(
        handle.agent.session,
        record.context.permissionPreset,
      )
      for (const name of record.context.skills) {
        const skill = await this.services.skills.get(name, {
          cwd: record.context.cwd,
          scope: handle.agent.ctx,
        })
        if (skill === undefined || !isUserInvocable(skill)) {
          throw new Error(`自动化所选技能“${name}”已不可用`)
        }
        handle.agent.inject(createUserMessage({
          content: [{ type: 'text', text: renderSkillContent(skill) }],
          source: { kind: 'skill-invocation', name, form: 'instructions' },
        }))
      }
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: record.prompt }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
      outcome = outcomeOf(handle.agent.session.events)
    } catch (error: unknown) {
      outcome = { status: 'failed', error: messageOf(error) }
      // 只有失败路径才立即收尾：半成品会话没有可看的结果。
      if (handle !== undefined) {
        await handle.dispose().catch(() => {})
        this.handles.delete(handle)
      }
      handle = undefined
    } finally {
      materialized = await this.sessionMaterialized(run.sessionId)
    }
    await this.finish(record.id, run, outcome, materialized)
  }

  /**
   * Reconcile the persisted lease before accepting new due work.
   *
   * A materialized session proves the side effect began, so it is never
   * duplicated after restart. An absent session is safe to retry with the
   * preallocated id because session persistence may omit never-appended creates.
   */
  private async recoverActiveRuns(): Promise<void> {
    const active = [...this.table.entries()]
      .map(([, record]) => record)
      .filter((record): record is StoredAutomation & { activeRun: ActiveRun } => record.activeRun !== undefined)
    if (active.length === 0) return
    const materialized = new Set(
      (await this.services.sessionPersistence.list()).map(header => String(header.id)),
    )
    for (const record of active) {
      const run = record.activeRun
      if (!materialized.has(run.sessionId)) {
        this.launch(record, run)
        continue
      }
      try {
        const inspection = await this.services.sessionPersistence.inspect(run.sessionId)
        const outcome = outcomeOf(inspection.events)
        await this.finish(record.id, run, outcome, true)
      } catch (error: unknown) {
        await this.finish(record.id, run, {
          status: 'failed',
          error: `恢复执行状态失败：${messageOf(error)}`,
        }, true)
      }
    }
  }

  private async finish(
    id: string,
    run: ActiveRun,
    outcome: RunOutcome,
    materialized: boolean,
  ): Promise<void> {
    const finishedAt = Date.now()
    await this.table.update(id, current => {
      if (current.activeRun?.sessionId !== run.sessionId) return current
      const { activeRun: _activeRun, ...rest } = current
      const lastRun: AutomationLastRun = {
        occurrenceKey: run.occurrenceKey,
        scheduledFor: run.scheduledFor,
        startedAt: run.startedAt,
        finishedAt,
        status: outcome.status,
        ...(materialized ? { sessionId: run.sessionId } : {}),
        ...(outcome.status === 'failed' ? { error: outcome.error } : {}),
      }
      const scheduledNext = run.manual
        ? current.nextRunAt
        : current.schedule.kind === 'once'
          ? null
          : nextAutomationRun(current.schedule, Math.max(finishedAt, run.scheduledFor))
      return {
        ...rest,
        enabled: run.manual ? current.enabled : current.schedule.kind === 'once' ? false : current.enabled,
        nextRunAt: scheduledNext,
        lastRun,
        updatedAt: finishedAt,
      }
    })
    // Every run's session stays visible in the sidebar. An earlier revision
    // archived the superseded run here (2026-08-27), which read as "重复执行
    // 覆盖了上次的对话" — WorkBuddy keeps one conversation per run record
    // (automation-inbox-detail.tsx), so we match that result and never touch
    // prior sessions.
  }

  private requireTask(id: string): StoredAutomation {
    const task = this.table.get(id)
    if (task === undefined) throw new Error('自动化不存在')
    return task
  }

  private requireWorkspace(id: string): AutomationWorkspace {
    const workspace = this.services.workspaceRegistry.get(id)
    if (workspace === undefined) throw new Error('所选工作区不存在')
    return workspace
  }

  private async resolveExecutionContext(
    base: AutomationContextSnapshot,
    selection: AutomationExecutionSelection,
  ): Promise<StoredAutomation['context']> {
    let cwd = base.cwd
    let workspaceId = base.workspaceId
    if (selection.workspaceId !== undefined) {
      const workspace = this.requireWorkspace(selection.workspaceId)
      if (await workspace.status() !== 'ok') throw new Error('所选工作区目录当前不可用')
      cwd = workspace.path
      workspaceId = String(workspace.id)
    }

    // No expert selected runs the default composition; a named one must be an
    // installed (user-trust) expert, never a deployment system preset.
    let preset: AutomationPreset | undefined
    if (selection.agentPreset !== undefined) {
      preset = await this.services.agentPresets.resolve(selection.agentPreset)
      if (preset.broken !== undefined) throw new Error(`所选专家不可用：${preset.broken}`)
      if (preset.trust !== 'user') throw new Error('只能召唤已安装的专家')
    }

    let provider = base.provider
    let model = base.model
    let reasoningEffort = base.reasoningEffort
    if (selection.model !== undefined) {
      const resolved = await this.services.llm.resolveCallConfig({
        provider: selection.model.provider,
        model: selection.model.model,
        ...(selection.model.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selection.model.reasoningEffort }),
      })
      provider = resolved.provider
      model = resolved.model
      reasoningEffort = resolved.reasoningEffort
    }

    const scope = await this.services.agentPresets.standingKeyFor(preset?.id)
    const skills = [...new Set(selection.skills)]
    const definitions = await Promise.all(skills.map(name => this.services.skills.get(name, {
      cwd,
      scope,
    })))
    for (const [index, definition] of definitions.entries()) {
      if (definition === undefined || !isUserInvocable(definition)) {
        throw new Error(`所选技能“${skills[index] ?? ''}”不可用`)
      }
    }

    if (!this.services.permissionPresets.names.includes(selection.permissionPreset)) {
      throw new Error('所选权限模式不可用')
    }
    return {
      sourceSessionId: base.sourceSessionId,
      cwd,
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(preset === undefined ? {} : { agentPreset: preset.id }),
      ...(workspaceId === undefined ? {} : { workspaceId }),
      skills,
      permissionPreset: selection.permissionPreset,
    }
  }

  private captureContext(sourceSessionId: string): AutomationContextSnapshot {
    const agent = this.services.agents.get(sourceSessionId)
    if (agent === undefined) throw new Error('请先打开一个会话，再创建自动化')
    const cwd = agent.session.header.cwd
    if (cwd === undefined || cwd.trim() === '') throw new Error('当前会话没有可用的工作目录')
    const logged = agent.session.requestHeader()?.config
    const selection = logged === undefined
      ? this.services.agentDefaultModel.currentSelection()
      : {
        provider: logged.provider,
        model: logged.model,
        ...(logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort }),
      }
    const preset = this.services.agentPresets.composedPreset(agent.ctx)
      ?? agent.session.header.agentPreset
      ?? this.services.agentPresets.defaultId
    const workspace = this.services.workspaceRegistry.list()
      .find(candidate => candidate.sessionIds.includes(agent.id))
    const effort = selection.reasoningEffort
    return {
      sourceSessionId,
      cwd,
      provider: selection.provider,
      model: selection.model,
      ...(effort === undefined ? {} : { reasoningEffort: String(effort) }),
      agentPreset: preset,
      ...(workspace === undefined ? {} : { workspaceId: String(workspace.id) }),
      skills: [],
      permissionPreset: this.permissionPresetOf(agent.session),
    }
  }

  private permissionPresetOf(session: AutomationSession): string {
    const current = this.services.permissionPresets.current(session.events)
    return this.services.permissionPresets.names.includes(current)
      ? current
      : this.services.permissionPresets.defaultPreset
  }

  private async sessionMaterialized(id: string): Promise<boolean> {
    try {
      return (await this.services.sessionPersistence.list()).some(header => String(header.id) === id)
    } catch {
      return false
    }
  }
}

type RunOutcome =
  | { readonly status: 'succeeded' }
  | { readonly status: 'failed'; readonly error: string }

function outcomeOf(events: readonly AutomationSessionEvent[]): RunOutcome {
  const end = [...events].reverse().find(event => event.type === 'turn/end')
  if (end === undefined) {
    return { status: 'failed', error: '执行中断，未形成完整结果' }
  }
  const data = typeof end.data === 'object' && end.data !== null
    ? end.data as Record<string, unknown>
    : {}
  const reason = typeof data.reason === 'object' && data.reason !== null
    ? data.reason as Record<string, unknown>
    : {}
  if (reason.kind === 'completed' || reason.kind === 'max-tokens') return { status: 'succeeded' }
  if (reason.kind === 'error') {
    const error = typeof reason.error === 'object' && reason.error !== null
      ? reason.error as Record<string, unknown>
      : {}
    return {
      status: 'failed',
      error: typeof error.message === 'string' ? error.message : '模型执行失败',
    }
  }
  if (reason.kind === 'aborted') return { status: 'failed', error: '执行已中止' }
  if (reason.kind === 'blocked') return { status: 'failed', error: '执行被内核阻止' }
  return { status: 'failed', error: '应用退出时执行尚未完成' }
}

function modelSelection(context: AutomationContextSnapshot): ModelSelection {
  if (context.reasoningEffort === undefined) {
    return { provider: context.provider, model: context.model }
  }
  return {
    provider: context.provider,
    model: context.model,
    reasoningEffort: context.reasoningEffort as NonNullable<ModelSelection['reasoningEffort']>,
  }
}

function publicTask(record: StoredAutomation): AutomationTask {
  return {
    id: record.id,
    title: record.title,
    prompt: record.prompt,
    enabled: record.enabled,
    schedule: record.schedule,
    nextRunAt: record.nextRunAt,
    context: publicContext(record.context),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    running: record.activeRun !== undefined,
    ...(record.lastRun === undefined ? {} : { lastRun: publicLastRun(record.lastRun) }),
  }
}

function publicLastRun(lastRun: NonNullable<StoredAutomation['lastRun']>): AutomationLastRun {
  const sessionId = lastRun.sessionId
  const error = lastRun.error
  return {
    occurrenceKey: lastRun.occurrenceKey,
    scheduledFor: lastRun.scheduledFor,
    startedAt: lastRun.startedAt,
    finishedAt: lastRun.finishedAt,
    status: lastRun.status,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(error === undefined ? {} : { error }),
  }
}

function publicContext(context: StoredAutomation['context']): AutomationContextSnapshot {
  const effort = context.reasoningEffort
  const preset = context.agentPreset
  const workspaceId = context.workspaceId
  return {
    sourceSessionId: context.sourceSessionId,
    cwd: context.cwd,
    provider: context.provider,
    model: context.model,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    ...(preset === undefined ? {} : { agentPreset: preset }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    skills: context.skills,
    permissionPreset: context.permissionPreset,
  }
}

function createInputOf(payload: unknown): AutomationCreateInput {
  const raw = objectOf(payload)
  return {
    sourceSessionId: requiredText(raw.sourceSessionId, '来源会话', 200),
    title: requiredText(raw.title, '名称', TITLE_MAX_CHARS),
    prompt: requiredText(raw.prompt, '执行内容', PROMPT_MAX_CHARS),
    schedule: automationScheduleOf(raw.schedule),
    enabled: raw.enabled !== false,
    execution: executionSelectionOf(raw.execution),
  }
}

function updateInputOf(payload: unknown): AutomationUpdateInput {
  const raw = objectOf(payload)
  return {
    id: requiredText(raw.id, '自动化编号', 200),
    title: requiredText(raw.title, '名称', TITLE_MAX_CHARS),
    prompt: requiredText(raw.prompt, '执行内容', PROMPT_MAX_CHARS),
    schedule: automationScheduleOf(raw.schedule),
    enabled: raw.enabled !== false,
    execution: executionSelectionOf(raw.execution),
  }
}

type ResolvedAutomationOptionsInput = AutomationOptionsInput & (
  | { readonly taskId: string; readonly sourceSessionId?: never }
  | { readonly taskId?: never; readonly sourceSessionId: string }
)

function optionsInputOf(payload: unknown): ResolvedAutomationOptionsInput {
  const raw = objectOf(payload)
  const taskId = optionalText(raw.taskId, '自动化编号', 200)
  const sourceSessionId = optionalText(raw.sourceSessionId, '来源会话', 200)
  if ((taskId === undefined) === (sourceSessionId === undefined)) {
    throw new Error('必须指定一个自动化或来源会话')
  }
  const workspaceId = optionalText(raw.workspaceId, '工作区', 200)
  // `null` is the editor saying "no expert" out loud, as opposed to "use the default".
  const agentPreset = raw.agentPreset === null ? null : optionalText(raw.agentPreset, '专家', 200)
  if (taskId !== undefined) {
    return {
      taskId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
    }
  }
  return {
    sourceSessionId: sourceSessionId as string,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(agentPreset === undefined ? {} : { agentPreset }),
  }
}

function executionSelectionOf(value: unknown): AutomationExecutionSelection {
  const raw = objectOf(value)
  const workspaceId = optionalText(raw.workspaceId, '工作区', 200)
  const agentPreset = optionalText(raw.agentPreset, '专家', 200)
  const model = modelSelectionInputOf(raw.model)
  return {
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(agentPreset === undefined ? {} : { agentPreset }),
    ...(model === undefined ? {} : { model }),
    skills: textListOf(raw.skills, '技能', MAX_SELECTED_SKILLS, 200),
    permissionPreset: requiredText(raw.permissionPreset, '权限模式', 200),
  }
}

function modelSelectionInputOf(value: unknown): AutomationModelSelection | undefined {
  if (value === undefined) return undefined
  const raw = objectOf(value)
  const reasoningEffort = optionalText(raw.reasoningEffort, '思考力度', 200)
  return {
    provider: requiredText(raw.provider, '模型提供方', 200),
    model: requiredText(raw.model, '模型', 200),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

function toggleInputOf(payload: unknown): { readonly id: string; readonly enabled: boolean } {
  const raw = objectOf(payload)
  if (typeof raw.enabled !== 'boolean') throw new Error('启用状态不正确')
  return {
    id: requiredText(raw.id, '自动化编号', 200),
    enabled: raw.enabled,
  }
}

function taskIdOf(payload: unknown): string {
  return requiredText(objectOf(payload).id, '自动化编号', 200)
}

function objectOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('请求格式不正确')
  }
  return value as Record<string, unknown>
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${label}不能为空`)
  const text = value.trim()
  if (text === '') throw new Error(`${label}不能为空`)
  if (text.length > max) throw new Error(`${label}不能超过 ${String(max)} 个字符`)
  return text
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  return value === undefined ? undefined : requiredText(value, label, max)
}

function textListOf(value: unknown, label: string, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) throw new Error(`${label}列表格式不正确`)
  if (value.length > maxItems) throw new Error(`${label}最多选择 ${String(maxItems)} 项`)
  const result = value.map(item => requiredText(item, label, maxChars))
  return [...new Set(result)]
}

function assertFutureOnce(schedule: AutomationSchedule, now: number, enabled: boolean): void {
  if (enabled && schedule.kind === 'once' && schedule.at <= now) {
    throw new Error('单次执行时间必须晚于当前系统时间')
  }
}

function automationServices(ctx: Context): AutomationServices {
  return {
    agents: requiredService(ctx, 'agents') as AutomationAgents,
    agentDefaultModel: requiredService(ctx, 'agentDefaultModel') as AutomationServices['agentDefaultModel'],
    agentPresets: requiredService(ctx, 'agentPresets') as AutomationAgentPresets,
    llm: requiredService(ctx, 'llm') as AutomationLlm,
    permissionPresets: requiredService(ctx, 'permissionPresets') as AutomationPermissionPresets,
    sessionPersistence: requiredService(ctx, 'sessionPersistence') as AutomationSessionPersistence,
    skills: requiredService(ctx, 'skills') as AutomationSkills,
    storageDomain: requiredService(ctx, 'storageDomain') as AutomationStorageDomain,
    workspaceRegistry: requiredService(ctx, 'workspaceRegistry') as AutomationWorkspaceRegistry,
  }
}

function requiredService(ctx: Context, name: string): unknown {
  const service = rawService(ctx, name)
  if (service === undefined) throw new Error(`自动化缺少内核服务 ${name}`)
  return service
}

function rawService(ctx: Context, name: string): unknown {
  return (ctx as unknown as { get(key: string): unknown }).get(name)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
