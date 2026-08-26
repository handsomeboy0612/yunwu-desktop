/**
 * Browser-safe automation contracts.
 *
 * The first release deliberately keeps calendar semantics small: one local
 * date/time, every local day, or selected local weekdays. There is no RRULE,
 * run-history feed, or notification contract hidden in this type surface.
 */

/** A schedule interpreted in the operating system's current local time. */
export type AutomationSchedule =
  | { readonly kind: 'once'; readonly at: number }
  | { readonly kind: 'daily'; readonly hour: number; readonly minute: number }
  | {
    readonly kind: 'weekly'
    /** JavaScript local weekday numbers: Sunday 0 through Saturday 6. */
    readonly weekdays: number[]
    readonly hour: number
    readonly minute: number
  }

/**
 * Durable execution context. Model, workspace, expert, explicit skills, and
 * permissions are selected in the automation editor (the model defaults to the
 * source conversation's) and do not silently follow later session changes.
 */
export interface AutomationContextSnapshot {
  readonly sourceSessionId: string
  readonly cwd: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly agentPreset?: string
  readonly workspaceId?: string
  readonly skills: readonly string[]
  readonly permissionPreset: string
}

/** Explicit background model choice, validated against the live llm registry. */
export interface AutomationModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** User-editable context applied when a background Agent is composed. */
export interface AutomationExecutionSelection {
  /** Omit to retain the source/task directory when it is not a registered workspace. */
  readonly workspaceId?: string
  /** Installed (market) expert preset; omit to run the default composition. */
  readonly agentPreset?: string
  /** Omit to keep the model copied from the source conversation or stored task. */
  readonly model?: AutomationModelSelection
  /** Human-selected skills injected as instructions before the scheduled prompt. */
  readonly skills: readonly string[]
  readonly permissionPreset: string
}

export interface AutomationWorkspaceOption {
  readonly id: string
  readonly title: string
  readonly path: string
  readonly disabledReason?: string
}

/** One installed expert; built-in system presets are never offered here. */
export interface AutomationExpertOption {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly disabledReason?: string
}

/** One selectable model inside its provider group. */
export interface AutomationModelOption {
  readonly provider: string
  readonly providerName: string
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface AutomationSkillOption {
  readonly name: string
  readonly description: string
  readonly source: string
}

export interface AutomationPermissionOption {
  readonly value: string
  readonly name: string
  readonly description?: string
  readonly dangerous: boolean
}

/** Current option roster and defaults for one create/edit context. */
export interface AutomationContextOptions {
  readonly workspaces: readonly AutomationWorkspaceOption[]
  readonly experts: readonly AutomationExpertOption[]
  readonly models: readonly AutomationModelOption[]
  readonly skills: readonly AutomationSkillOption[]
  readonly permissions: readonly AutomationPermissionOption[]
  readonly defaults: AutomationExecutionSelection & {
    readonly cwd: string
    readonly model: AutomationModelSelection
  }
}

/** Host-resolved query; taskId is used for edit and sourceSessionId for create. */
export interface AutomationOptionsInput {
  readonly taskId?: string
  readonly sourceSessionId?: string
  readonly workspaceId?: string
  /** `null` means "explicitly no expert"; absent falls back to the stored/captured default. */
  readonly agentPreset?: string | null
}

/** The latest execution only; this is not a run-history model. */
export interface AutomationLastRun {
  readonly occurrenceKey: string
  readonly scheduledFor: number
  readonly startedAt: number
  readonly finishedAt: number
  /** Present once the background session reached durable storage. */
  readonly sessionId?: string
  readonly status: 'succeeded' | 'failed'
  readonly error?: string
}

/** One task rendered by the automation page. */
export interface AutomationTask {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly enabled: boolean
  readonly schedule: AutomationSchedule
  readonly nextRunAt: number | null
  readonly context: AutomationContextSnapshot
  readonly createdAt: number
  readonly updatedAt: number
  readonly running: boolean
  readonly lastRun?: AutomationLastRun
}

/** Page snapshot returned by `automations.list`. */
export interface AutomationSnapshot {
  readonly tasks: readonly AutomationTask[]
  readonly localTimeZone: string
  readonly now: number
}

/** Create input. The Host copies the model and validates the selected context. */
export interface AutomationCreateInput {
  readonly sourceSessionId: string
  readonly title: string
  readonly prompt: string
  readonly schedule: AutomationSchedule
  readonly enabled: boolean
  readonly execution: AutomationExecutionSelection
}

/** Editable task fields plus the background Agent's execution context. */
export interface AutomationUpdateInput {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly schedule: AutomationSchedule
  readonly enabled: boolean
  readonly execution: AutomationExecutionSelection
}
