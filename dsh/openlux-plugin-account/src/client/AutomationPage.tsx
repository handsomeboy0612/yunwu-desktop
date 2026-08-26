import {
  Button,
  IconAgentPresetOutline16,
  IconCheckOutline14,
  IconChevronDownOutline14,
  IconCloseFill14,
  IconEditOutline16,
  IconFolderOpenOutline16,
  IconPlayOutline16,
  IconPlusOutline16,
  IconSkillOutline16,
  IconSparkle16,
  IconTrashOutline16,
  IconWarningOutline16,
  Input,
  Menu,
  type MenuEntry,
  RiskConfirmation,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import type {
  AutomationContextOptions,
  AutomationCreateInput,
  AutomationExecutionSelection,
  AutomationModelSelection,
  AutomationSchedule,
  AutomationSnapshot,
  AutomationTask,
  AutomationUpdateInput,
} from '../automation-wire.ts'
import type { AutomationKey } from './automation-locales.ts'
import type { AccountHostCaller } from './types.ts'

export interface AutomationSourceSession {
  readonly id: string
  readonly title: string
  readonly cwd?: string
}

type T = (key: AutomationKey, params?: Record<string, unknown>) => string
type AutomationCaller = <TValue>(
  method: string,
  payload: unknown,
  signal?: AbortSignal,
) => Promise<TValue>

export interface AutomationPageProps {
  readonly callHost: AccountHostCaller
  readonly source: AutomationSourceSession | undefined
  /** Preset ids from the persisted summon history, most recent first. */
  readonly recentExperts: readonly string[]
  /** Records one expert summon into that shared history. */
  readonly noteExpertSummon: (agentPreset: string) => void
  readonly t: T
  readonly openResult: (sessionId: string) => Promise<void>
}

/** Task list with in-surface create/edit states; the surrounding overlay stays the only dialog. */
export function AutomationPage(props: AutomationPageProps): ReactNode {
  const { callHost, source, recentExperts, noteExpertSummon, t, openResult } = props
  const [snapshot, setSnapshot] = useState<AutomationSnapshot>()
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string>()
  const [editor, setEditor] = useState<'create' | AutomationTask>()
  const [deleteTarget, setDeleteTarget] = useState<AutomationTask>()
  const [busyId, setBusyId] = useState<string>()
  const [deleting, setDeleting] = useState(false)

  const call = useCallback(async <TValue,>(
    method: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<TValue> => {
    const result = await callHost<TValue>(method, payload, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }, [callHost])

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const next = await call<AutomationSnapshot>('automations.list', {}, signal)
    setSnapshot(next)
  }, [call])

  useEffect(() => {
    const stop = new AbortController()
    setLoading(true)
    load(stop.signal)
      .catch((error: unknown) => {
        if (!stop.signal.aborted) setFailure(messageOf(error))
      })
      .finally(() => {
        if (!stop.signal.aborted) setLoading(false)
      })
    const timer = window.setInterval(() => {
      load(stop.signal).catch((error: unknown) => {
        if (!stop.signal.aborted) setFailure(messageOf(error))
      })
    }, 5_000)
    return () => {
      stop.abort()
      window.clearInterval(timer)
    }
  }, [load])

  const save = async (input: AutomationCreateInput | AutomationUpdateInput): Promise<void> => {
    setFailure(undefined)
    await call('id' in input ? 'automations.update' : 'automations.create', input)
    if (input.execution.agentPreset !== undefined) noteExpertSummon(input.execution.agentPreset)
    await load()
    setEditor(undefined)
  }

  const act = async (task: AutomationTask, action: 'toggle' | 'run'): Promise<void> => {
    setBusyId(task.id)
    setFailure(undefined)
    try {
      if (action === 'toggle') {
        await call('automations.toggle', { id: task.id, enabled: !task.enabled })
      } else {
        await call('automations.run', { id: task.id })
      }
      await load()
    } catch (error: unknown) {
      setFailure(messageOf(error))
    } finally {
      setBusyId(undefined)
    }
  }

  const remove = async (): Promise<void> => {
    if (deleteTarget === undefined) return
    setDeleting(true)
    setFailure(undefined)
    try {
      await call('automations.delete', { id: deleteTarget.id })
      await load()
      setDeleteTarget(undefined)
    } catch (error: unknown) {
      setFailure(messageOf(error))
    } finally {
      setDeleting(false)
    }
  }

  const open = async (sessionId: string): Promise<void> => {
    setFailure(undefined)
    try {
      await openResult(sessionId)
    } catch (error: unknown) {
      setFailure(messageOf(error))
    }
  }

  const startCreate = (): void => {
    setDeleteTarget(undefined)
    setEditor('create')
  }

  const startEdit = (task: AutomationTask): void => {
    setDeleteTarget(undefined)
    setEditor(task)
  }

  if (editor !== undefined) {
    return (
      <AutomationEditor
        key={editor === 'create' ? 'create' : editor.id}
        call={call}
        task={editor === 'create' ? undefined : editor}
        source={source}
        recentExperts={recentExperts}
        t={t}
        onClose={() => setEditor(undefined)}
        onSave={save}
      />
    )
  }

  return (
    <div style={styles.page}>
      <div style={styles.toolbar}>
        <span style={styles.timeNote}>
          {t('localTime')} · {snapshot?.localTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
        </span>
        <Button
          size="sm"
          variant="primary"
          icon={<IconPlusOutline16 size={16} />}
          disabled={source === undefined}
          title={source === undefined ? t('sourceMissing') : undefined}
          onClick={startCreate}
        >
          {t('create')}
        </Button>
      </div>

      {failure === undefined ? null : (
        <div style={styles.error} role="alert">
          <strong>{t('loadFailed')}</strong>
          <span>{failure}</span>
        </div>
      )}

      {deleteTarget === undefined ? null : (
        <div style={styles.deleteConfirm} data-testid="automation-delete-confirm">
          <div style={styles.deleteCopy}>
            <strong style={styles.deleteHeading}>{t('deleteTitle')}</strong>
            <span style={styles.deleteBody}>{t('deleteBody', { name: deleteTarget.title })}</span>
          </div>
          <div style={styles.actions}>
            <Button variant="outline" disabled={deleting} onClick={() => setDeleteTarget(undefined)}>
              {t('cancel')}
            </Button>
            <button
              type="button"
              style={styles.dangerButton}
              disabled={deleting}
              onClick={() => { void remove() }}
            >
              {deleting ? t('saving') : t('confirmDelete')}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div style={styles.empty}>{t('loading')}</div>
      ) : snapshot === undefined || snapshot.tasks.length === 0 ? (
        <div style={styles.empty}>
          <div style={styles.emptyMark}><IconPlayOutline16 size={22} /></div>
          <strong style={styles.emptyTitle}>{t('emptyTitle')}</strong>
          <span style={styles.emptyBody}>{source === undefined ? t('sourceMissing') : t('emptyBody')}</span>
          {source === undefined ? null : (
            <Button size="sm" variant="primary" onClick={startCreate}>
              {t('create')}
            </Button>
          )}
        </div>
      ) : (
        <div style={styles.list}>
          {snapshot.tasks.map(task => (
            <AutomationCard
              key={task.id}
              task={task}
              busy={busyId === task.id}
              t={t}
              onEdit={() => startEdit(task)}
              onDelete={() => setDeleteTarget(task)}
              onToggle={() => { void act(task, 'toggle') }}
              onRun={() => { void act(task, 'run') }}
              onOpenResult={task.lastRun?.sessionId === undefined
                ? undefined
                : () => { void open(task.lastRun?.sessionId ?? '') }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface CardProps {
  readonly task: AutomationTask
  readonly busy: boolean
  readonly t: T
  readonly onEdit: () => void
  readonly onDelete: () => void
  readonly onToggle: () => void
  readonly onRun: () => void
  readonly onOpenResult: (() => void) | undefined
}

function AutomationCard(props: CardProps): ReactNode {
  const { task, busy, t, onEdit, onDelete, onToggle, onRun, onOpenResult } = props
  const state = task.running
    ? { text: t('running'), tone: styles.stateRunning }
    : !task.enabled
      ? { text: task.schedule.kind === 'once' && task.nextRunAt === null ? t('completed') : t('paused'), tone: styles.stateMuted }
      : task.lastRun?.status === 'failed'
        ? { text: t('failed'), tone: styles.stateFailed }
        : { text: t('enable'), tone: styles.stateEnabled }
  return (
    <article style={styles.card} data-testid={`automation-card-${task.id}`}>
      <div style={styles.cardHead}>
        <div style={styles.identity}>
          <div style={styles.titleLine}>
            <strong style={styles.cardTitle}>{task.title}</strong>
            <span style={{ ...styles.state, ...state.tone }}>{state.text}</span>
          </div>
          <div style={styles.scheduleText}>{scheduleText(task.schedule, t)}</div>
        </div>
        <div style={styles.actions}>
          <Button
            size="sm"
            variant="outline"
            disabled={task.running || busy}
            onClick={onToggle}
          >
            {task.enabled ? t('pause') : t('enable')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<IconPlayOutline16 size={14} />}
            disabled={task.running || busy}
            onClick={onRun}
          >
            {task.running ? t('running') : t('runNow')}
          </Button>
        </div>
      </div>

      <p style={styles.prompt}>{task.prompt}</p>

      <div style={styles.metaGrid}>
        <div>
          <span style={styles.metaLabel}>{t('nextRun')}</span>
          <span style={styles.metaValue}>{task.nextRunAt === null ? '—' : formatDate(task.nextRunAt)}</span>
        </div>
        <div>
          <span style={styles.metaLabel}>{t('lastRun')}</span>
          <span style={styles.metaValue}>
            {task.lastRun === undefined
              ? t('neverRun')
              : `${task.lastRun.status === 'succeeded' ? t('succeeded') : t('failed')} · ${formatDate(task.lastRun.finishedAt)}`}
          </span>
        </div>
        <div>
          <span style={styles.metaLabel}>{t('sourceLabel')}</span>
          <span style={styles.metaValue}>
            {task.context.agentPreset ?? task.context.model}
            {task.context.skills.length === 0 ? '' : ` · ${t('skillsSelected', { count: task.context.skills.length })}`}
            {' · '}
            {permissionLabel(task.context.permissionPreset, task.context.permissionPreset, t)}
          </span>
        </div>
      </div>

      {task.lastRun?.error === undefined ? null : (
        <div style={styles.runError}>{task.lastRun.error}</div>
      )}

      <div style={styles.cardFooter}>
        <div style={styles.actions}>
          <Button
            size="sm"
            variant="ghost"
            icon={<IconEditOutline16 size={14} />}
            disabled={task.running}
            onClick={onEdit}
          >
            {t('edit')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<IconTrashOutline16 size={14} />}
            disabled={task.running}
            onClick={onDelete}
          >
            {t('remove')}
          </Button>
        </div>
        {onOpenResult === undefined ? null : (
          <Button size="sm" variant="outline" onClick={onOpenResult}>{t('openResult')}</Button>
        )}
      </div>
    </article>
  )
}

interface EditorProps {
  readonly call: AutomationCaller
  readonly task: AutomationTask | undefined
  readonly source: AutomationSourceSession | undefined
  readonly recentExperts: readonly string[]
  readonly t: T
  readonly onClose: () => void
  readonly onSave: (input: AutomationCreateInput | AutomationUpdateInput) => Promise<void>
}

/** Joins provider and model into one Menu row id; U+0000 appears in neither. */
const MODEL_ID_SEPARATOR = '\u0000'

/** Per-field validation messages, rendered directly under the field. */
interface FieldErrors {
  readonly name?: string | undefined
  readonly prompt?: string | undefined
  readonly schedule?: string | undefined
  readonly weekdays?: string | undefined
}

function AutomationEditor(props: EditorProps): ReactNode {
  const { call, task, source, recentExperts, t, onClose, onSave } = props
  const initial = useMemo(() => editorInitial(task), [task])
  const [name, setName] = useState(initial.name)
  const [prompt, setPrompt] = useState(initial.prompt)
  const [kind, setKind] = useState<AutomationSchedule['kind']>(initial.kind)
  const [once, setOnce] = useState(initial.once)
  const [time, setTime] = useState(initial.time)
  const [weekdays, setWeekdays] = useState<number[]>(initial.weekdays)
  const [enabled, setEnabled] = useState(initial.enabled)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [options, setOptions] = useState<AutomationContextOptions>()
  const [contextReady, setContextReady] = useState(false)
  const [contextLoading, setContextLoading] = useState(true)
  const [workspaceId, setWorkspaceId] = useState(task?.context.workspaceId ?? '')
  const [agentPreset, setAgentPreset] = useState('')
  const [model, setModel] = useState<AutomationModelSelection>()
  const [skills, setSkills] = useState<string[]>(task === undefined ? [] : [...task.context.skills])
  const [permissionPreset, setPermissionPreset] = useState(task?.context.permissionPreset ?? '')
  const [modelMenu, setModelMenu] = useState(false)
  const [expertPicker, setExpertPicker] = useState(false)
  const [expertQuery, setExpertQuery] = useState('')
  const [skillPicker, setSkillPicker] = useState(false)
  const [skillQuery, setSkillQuery] = useState('')
  const [permissionMenu, setPermissionMenu] = useState(false)
  const [workspacePicker, setWorkspacePicker] = useState(false)
  const [workspaceQuery, setWorkspaceQuery] = useState('')
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)
  const [riskAcknowledged, setRiskAcknowledged] = useState(false)
  // 校验错误贴在字段下方（2026-08-27 用户点名：错误不许堆在表单顶部）。
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const nameFieldRef = useRef<HTMLLabelElement | null>(null)
  const promptFieldRef = useRef<HTMLDivElement | null>(null)
  const scheduleFieldRef = useRef<HTMLDivElement | null>(null)

  const executionSource = task === undefined ? source : {
    id: task.context.sourceSessionId,
    title: task.context.model,
    cwd: task.context.cwd,
  }

  useEffect(() => {
    const stop = new AbortController()
    const owner = task === undefined
      ? source === undefined ? undefined : { sourceSessionId: source.id }
      : { taskId: task.id }
    if (owner === undefined) {
      setFailure(t('sourceMissing'))
      setContextLoading(false)
      return () => stop.abort()
    }
    setContextLoading(true)
    call<AutomationContextOptions>('automations.options', {
      ...owner,
      ...(workspaceId === '' ? {} : { workspaceId }),
      // `null` says "explicitly no expert" once the editor owns the choice;
      // before that the Host proposes its default and the editor adopts it.
      ...(contextReady ? { agentPreset: agentPreset === '' ? null : agentPreset } : {}),
    }, stop.signal)
      .then((next) => {
        if (stop.signal.aborted) return
        setOptions(next)
        if (!contextReady) {
          setWorkspaceId(next.defaults.workspaceId ?? '')
          setAgentPreset(next.defaults.agentPreset ?? '')
          setModel(next.defaults.model)
          setSkills([...next.defaults.skills])
          setPermissionPreset(next.defaults.permissionPreset)
          setContextReady(true)
        }
      })
      .catch((error: unknown) => {
        if (!stop.signal.aborted) setFailure(messageOf(error))
      })
      .finally(() => {
        if (!stop.signal.aborted) setContextLoading(false)
      })
    return () => stop.abort()
  }, [agentPreset, call, contextReady, source?.id, task?.id, workspaceId])

  useEffect(() => {
    if (permissionPreset !== 'danger-full-access') {
      setConfirmFullAccess(false)
      setRiskAcknowledged(false)
    }
  }, [permissionPreset])

  const modelItems = useMemo<MenuEntry[]>(() => {
    const items: MenuEntry[] = []
    let lastProvider: string | undefined
    for (const option of options?.models ?? []) {
      if (option.provider !== lastProvider) {
        items.push({ type: 'label', id: `provider:${option.provider}`, text: option.providerName })
        lastProvider = option.provider
      }
      items.push({
        id: `${option.provider}${MODEL_ID_SEPARATOR}${option.id}`,
        label: <MenuOptionLabel title={option.name} description={option.description} />,
      })
    }
    return items
  }, [options])

  // 最近召唤的排最前（安装了却没用过的排后面）；内置模式由 Host 过滤，永远不在这里。
  const orderedExperts = useMemo(() => {
    const experts = options?.experts ?? []
    const recent: AutomationContextOptions['experts'][number][] = []
    for (const id of recentExperts) {
      const expert = experts.find(candidate => candidate.id === id)
      if (expert !== undefined) recent.push(expert)
    }
    const rest = experts.filter(expert => !recentExperts.includes(expert.id))
    return { recent, rest }
  }, [options, recentExperts])

  // 专家面板按查询词过滤，分组保持「最近召唤 → 全部专家」。
  const expertGroups = useMemo(() => ({
    recent: orderedExperts.recent.filter(expert => textMatches(expert.name, expert.description, expertQuery)),
    rest: orderedExperts.rest.filter(expert => textMatches(expert.name, expert.description, expertQuery)),
  }), [expertQuery, orderedExperts])
  // 技能面板同款过滤；已选但已下架的技能仍列出来，能再点一次移除。
  const skillRows = useMemo(() => {
    const available = options?.skills ?? []
    const availableNames = new Set(available.map(skill => skill.name))
    const rows = available.map(skill => ({
      name: skill.name,
      description: skill.description,
      unavailable: false,
    }))
    for (const selected of skills) {
      if (!availableNames.has(selected)) {
        rows.push({ name: selected, description: t('skillUnavailable'), unavailable: true })
      }
    }
    return rows.filter(row => textMatches(row.name, row.description, skillQuery))
  }, [options, skillQuery, skills, t])
  // 内核 PermissionSelect 的菜单形状：图标 + 短标签，行内不放描述
  // （描述像它一样留在触发钮的 title 提示里）。
  const permissionItems = useMemo<MenuEntry[]>(() => (options?.permissions ?? []).map(permission => ({
    id: permission.value,
    label: permissionLabel(permission.value, permission.name, t),
    icon: permission.dangerous
      ? <IconWarningOutline16 size={16} />
      : <IconFolderOpenOutline16 size={16} />,
  })), [options, t])
  const selectedExpert = options?.experts.find(expert => expert.id === agentPreset)
  const selectedPermission = options?.permissions.find(permission => permission.value === permissionPreset)
  const selectedModelOption = model === undefined
    ? undefined
    : options?.models.find(option => option.provider === model.provider && option.id === model.model)
  const selectedWorkspace = options?.workspaces.find(workspace => workspace.id === workspaceId)

  const closeMenus = (): void => {
    setModelMenu(false)
    setExpertPicker(false)
    setSkillPicker(false)
    setPermissionMenu(false)
    setWorkspacePicker(false)
  }

  const expertRow = (expert: AutomationContextOptions['experts'][number]): ReactNode => (
    <button
      key={expert.id}
      type="button"
      style={{
        ...styles.panelItem,
        ...(expert.disabledReason === undefined ? {} : styles.panelItemDisabled),
      }}
      disabled={expert.disabledReason !== undefined}
      onClick={() => {
        setAgentPreset(expert.id)
        setSkills([])
        setExpertPicker(false)
      }}
    >
      <span style={styles.panelItemCopy}>
        <span style={styles.panelItemTitle}>{expert.name}</span>
        {expert.description === undefined || expert.description === ''
          ? null
          : <span style={styles.panelItemDesc}>{expert.description}</span>}
      </span>
      {agentPreset === expert.id ? <IconCheckOutline14 size={14} /> : null}
    </button>
  )

  const submit = async (riskConfirmed = false): Promise<void> => {
    setFailure(undefined)
    // 先在客户端把能查的都查了，错误贴到字段下方并滚过去；
    // 底部的失败条只留给宿主返回的意外错误。
    const schedule = scheduleFromDraft(kind, once, time, weekdays, t)
    const nextErrors: FieldErrors = {
      ...(name.trim() === '' ? { name: t('nameRequired') } : {}),
      ...(prompt.trim() === '' ? { prompt: t('promptRequired') } : {}),
      ...('error' in schedule ? { [schedule.field]: schedule.error } : {}),
    }
    setFieldErrors(nextErrors)
    if (Object.values(nextErrors).some(message => message !== undefined)) {
      const target = nextErrors.name !== undefined
        ? nameFieldRef.current
        : nextErrors.prompt !== undefined ? promptFieldRef.current : scheduleFieldRef.current
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    if ('error' in schedule) return
    try {
      if (!contextReady || model === undefined || permissionPreset === '') {
        throw new Error(t('contextLoading'))
      }
      if (
        permissionPreset === 'danger-full-access'
        && task?.context.permissionPreset !== 'danger-full-access'
        && !riskConfirmed
      ) {
        setConfirmFullAccess(true)
        setRiskAcknowledged(false)
        return
      }
      const execution: AutomationExecutionSelection = {
        ...(workspaceId === '' ? {} : { workspaceId }),
        ...(agentPreset === '' ? {} : { agentPreset }),
        model,
        skills,
        permissionPreset,
      }
      const common = { title: name, prompt, schedule, enabled }
      setSaving(true)
      if (task === undefined) {
        if (source === undefined) throw new Error(t('sourceMissing'))
        await onSave({ sourceSessionId: source.id, execution, ...common })
      } else {
        await onSave({ id: task.id, execution, ...common })
      }
    } catch (error: unknown) {
      setFailure(messageOf(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section
      style={styles.editor}
      aria-labelledby="openlux-automation-editor-title"
      data-testid="automation-editor"
    >
      <header style={styles.editorHeader}>
        <h3 id="openlux-automation-editor-title" style={styles.editorTitle}>
          {task === undefined ? t('createTitle') : t('editTitle')}
        </h3>
      </header>
      <div style={styles.form}>
        <label style={styles.field} ref={nameFieldRef}>
          <span style={styles.fieldLabel}>{t('name')}</span>
          <Input
            value={name}
            maxLength={120}
            placeholder={t('namePlaceholder')}
            onChange={(event) => {
              setName(event.target.value)
              setFieldErrors(current => ({ ...current, name: undefined }))
            }}
          />
          {fieldErrors.name === undefined ? null : (
            <span style={styles.fieldError} data-testid="automation-field-error">{fieldErrors.name}</span>
          )}
        </label>
        <div style={styles.field}>
          <span style={styles.fieldLabel}>{t('workspace')}</span>
          {/* WorkBuddy 的形状：未选时是「+」+ 可搜索下拉，选中变成可关闭的标签。 */}
          <div style={styles.workspaceBox} data-testid="automation-workspace-selector">
            {workspaceId === '' ? (
              <>
                <button
                  type="button"
                  style={styles.workspaceAdd}
                  disabled={contextLoading}
                  aria-label={t('addWorkspace')}
                  data-testid="automation-workspace-add"
                  onClick={() => {
                    const opening = !workspacePicker
                    closeMenus()
                    setWorkspacePicker(opening)
                    setWorkspaceQuery('')
                  }}
                >
                  <IconPlusOutline16 size={14} />
                </button>
                <span style={styles.workspaceHint}>
                  {t(task === undefined ? 'sourceWorkspace' : 'keepWorkspace')} · {options?.defaults.cwd ?? executionSource?.cwd ?? '—'}
                </span>
              </>
            ) : (
              <span style={styles.workspaceTag} data-testid="automation-workspace-tag">
                <IconFolderOpenOutline16 size={14} />
                <span style={styles.workspaceTagText}>
                  {selectedWorkspace === undefined
                    ? `${workspaceId} · ${t('workspaceUnavailable')}`
                    : `${selectedWorkspace.title} · ${selectedWorkspace.path}`}
                </span>
                <button
                  type="button"
                  style={styles.workspaceTagClose}
                  aria-label={t('removeWorkspace')}
                  onClick={() => {
                    setWorkspaceId('')
                    setSkills([])
                    closeMenus()
                  }}
                >
                  <IconCloseFill14 size={12} />
                </button>
              </span>
            )}
            {workspacePicker ? (
              <>
                <button
                  type="button"
                  style={styles.pickerMask}
                  aria-label={t('cancel')}
                  onClick={() => setWorkspacePicker(false)}
                />
                <div
                  style={styles.workspacePopover}
                  role="menu"
                  data-testid="automation-workspace-popover"
                  onKeyDown={(event) => {
                    if (event.key !== 'Escape') return
                    event.stopPropagation()
                    setWorkspacePicker(false)
                  }}
                >
                  <Input
                    autoFocus
                    value={workspaceQuery}
                    placeholder={t('searchWorkspace')}
                    onChange={event => setWorkspaceQuery(event.target.value)}
                  />
                  <div style={styles.workspaceList}>
                    {workspaceMatches(options?.workspaces ?? [], workspaceQuery).length === 0 ? (
                      <span style={styles.workspaceEmpty}>
                        {t(workspaceQuery.trim() === '' ? 'noWorkspaces' : 'noWorkspaceMatch')}
                      </span>
                    ) : workspaceMatches(options?.workspaces ?? [], workspaceQuery).map(workspace => (
                      <button
                        key={workspace.id}
                        type="button"
                        style={{
                          ...styles.workspaceItem,
                          ...(workspace.disabledReason === undefined ? {} : styles.workspaceItemDisabled),
                        }}
                        disabled={workspace.disabledReason !== undefined}
                        onClick={() => {
                          setWorkspaceId(workspace.id)
                          setSkills([])
                          setWorkspacePicker(false)
                        }}
                      >
                        <IconFolderOpenOutline16 size={16} />
                        <span style={styles.workspaceItemCopy}>
                          <span style={styles.workspaceItemTitle}>
                            {workspace.title}
                            {workspace.disabledReason === undefined ? '' : ` · ${t('workspaceUnavailable')}`}
                          </span>
                          <span style={styles.workspaceItemPath}>{workspace.path}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </div>
        <div style={styles.field} ref={promptFieldRef}>
          <span style={styles.fieldLabel}>{t('prompt')}</span>
          <div style={styles.promptComposer}>
            <textarea
              style={styles.promptTextarea}
              value={prompt}
              maxLength={40_000}
              rows={6}
              placeholder={t('promptPlaceholder')}
              onChange={(event) => {
                setPrompt(event.target.value)
                setFieldErrors(current => ({ ...current, prompt: undefined }))
              }}
            />
            {/* WorkBuddy 的上下文栏顺序：模型 · 技能 · 召唤专家 · 权限。 */}
            <div style={styles.contextBar}>
              <Menu
                open={modelMenu}
                portal
                compact
                items={modelItems}
                selectedId={model === undefined
                  ? undefined
                  : `${model.provider}${MODEL_ID_SEPARATOR}${model.model}`}
                onClose={() => setModelMenu(false)}
                onSelect={(id) => {
                  const separator = id.indexOf(MODEL_ID_SEPARATOR)
                  if (separator === -1) return
                  const provider = id.slice(0, separator)
                  const modelId = id.slice(separator + 1)
                  const fallback = options?.defaults.model
                  // Re-picking the source model restores its reasoning effort;
                  // any other model runs with the adapter's own default effort.
                  setModel(fallback !== undefined
                    && fallback.provider === provider
                    && fallback.model === modelId
                    ? fallback
                    : { provider, model: modelId })
                  setModelMenu(false)
                }}
                anchor={(
                  <button
                    type="button"
                    style={styles.contextButton}
                    disabled={contextLoading}
                    data-testid="automation-model-selector"
                    onClick={() => {
                      const opening = !modelMenu
                      closeMenus()
                      setModelMenu(opening)
                    }}
                  >
                    <IconSparkle16 size={16} />
                    <span>{selectedModelOption?.name ?? model?.model ?? t('model')}</span>
                    <IconChevronDownOutline14 size={14} />
                  </button>
                )}
              />
              {/* 技能：与工作空间选择器同款的搜索多选面板，勾选不关面板。 */}
              <span style={styles.pickerAnchor}>
                <button
                  type="button"
                  style={styles.contextButton}
                  disabled={contextLoading}
                  data-testid="automation-skill-selector"
                  onClick={() => {
                    const opening = !skillPicker
                    closeMenus()
                    setSkillPicker(opening)
                    setSkillQuery('')
                  }}
                >
                  <IconSkillOutline16 size={16} />
                  <span>{skills.length === 0 ? t('skills') : t('skillsSelected', { count: skills.length })}</span>
                  <IconChevronDownOutline14 size={14} />
                </button>
                {skillPicker ? (
                  <>
                    <button
                      type="button"
                      style={styles.pickerMask}
                      aria-label={t('cancel')}
                      onClick={() => setSkillPicker(false)}
                    />
                    <div
                      style={styles.panel}
                      role="menu"
                      data-testid="automation-skill-popover"
                      onKeyDown={(event) => {
                        if (event.key !== 'Escape') return
                        event.stopPropagation()
                        setSkillPicker(false)
                      }}
                    >
                      <Input
                        autoFocus
                        value={skillQuery}
                        placeholder={t('searchSkill')}
                        onChange={event => setSkillQuery(event.target.value)}
                      />
                      {skills.length === 0 ? null : (
                        <div style={styles.panelBar}>
                          <span>{t('selectedCount', { count: skills.length })}</span>
                          <button
                            type="button"
                            style={styles.panelClear}
                            onClick={() => setSkills([])}
                          >
                            {t('clearSkills')}
                          </button>
                        </div>
                      )}
                      <div style={styles.panelList}>
                        {skillRows.length === 0 ? (
                          <span style={styles.panelEmpty}>
                            {t(skillQuery.trim() === '' ? 'noSkills' : 'noSkillMatch')}
                          </span>
                        ) : skillRows.map((row) => {
                          const picked = skills.includes(row.name)
                          return (
                            <button
                              key={row.name}
                              type="button"
                              style={styles.panelItem}
                              onClick={() => setSkills(current => (
                                current.includes(row.name)
                                  ? current.filter(name => name !== row.name)
                                  : [...current, row.name]
                              ))}
                            >
                              <span style={{ ...styles.skillBox, ...(picked ? styles.skillBoxOn : {}) }}>
                                {picked ? <IconCheckOutline14 size={11} /> : null}
                              </span>
                              <span style={styles.panelItemCopy}>
                                <span style={styles.panelItemTitle}>{row.name}</span>
                                {row.description === undefined || row.description === ''
                                  ? null
                                  : <span style={styles.panelItemDesc}>{row.description}</span>}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  </>
                ) : null}
              </span>
              {/* 召唤专家：搜索单选面板，「最近召唤 → 全部专家」分组，
                  已召唤时面板头部给「取消召唤」。 */}
              <span style={styles.pickerAnchor}>
                <button
                  type="button"
                  style={{
                    ...styles.contextButton,
                    ...(agentPreset === '' ? {} : styles.contextButtonActive),
                  }}
                  disabled={contextLoading}
                  data-testid="automation-expert-selector"
                  onClick={() => {
                    const opening = !expertPicker
                    closeMenus()
                    setExpertPicker(opening)
                    setExpertQuery('')
                  }}
                >
                  <IconAgentPresetOutline16 size={16} />
                  <span>{agentPreset === '' ? t('expert') : selectedExpert?.name ?? agentPreset}</span>
                  <IconChevronDownOutline14 size={14} />
                </button>
                {expertPicker ? (
                  <>
                    <button
                      type="button"
                      style={styles.pickerMask}
                      aria-label={t('cancel')}
                      onClick={() => setExpertPicker(false)}
                    />
                    <div
                      style={styles.panel}
                      role="menu"
                      data-testid="automation-expert-popover"
                      onKeyDown={(event) => {
                        if (event.key !== 'Escape') return
                        event.stopPropagation()
                        setExpertPicker(false)
                      }}
                    >
                      <Input
                        autoFocus
                        value={expertQuery}
                        placeholder={t('searchExpert')}
                        onChange={event => setExpertQuery(event.target.value)}
                      />
                      {agentPreset === '' ? null : (
                        <div style={styles.panelBar}>
                          <span style={styles.panelBarText}>
                            {selectedExpert?.name ?? `${agentPreset} · ${t('expertUnavailable')}`}
                          </span>
                          <button
                            type="button"
                            style={styles.panelClear}
                            onClick={() => {
                              setAgentPreset('')
                              setSkills([])
                              setExpertPicker(false)
                            }}
                          >
                            {t('clearExpert')}
                          </button>
                        </div>
                      )}
                      <div style={styles.panelList}>
                        {expertGroups.recent.length === 0 && expertGroups.rest.length === 0 ? (
                          <span style={styles.panelEmpty}>
                            {t(expertQuery.trim() === '' ? 'noExperts' : 'noExpertMatch')}
                          </span>
                        ) : (
                          <>
                            {expertGroups.recent.length === 0 ? null : (
                              <span style={styles.panelGroup}>{t('recentExperts')}</span>
                            )}
                            {expertGroups.recent.map(expert => expertRow(expert))}
                            {expertGroups.rest.length === 0 ? null : (
                              <span style={styles.panelGroup}>{t('allExperts')}</span>
                            )}
                            {expertGroups.rest.map(expert => expertRow(expert))}
                          </>
                        )}
                      </div>
                    </div>
                  </>
                ) : null}
              </span>
              <Menu
                open={permissionMenu}
                portal
                compact
                items={permissionItems}
                selectedId={permissionPreset}
                onClose={() => setPermissionMenu(false)}
                onSelect={(id) => {
                  setPermissionPreset(id)
                  setPermissionMenu(false)
                }}
                anchor={(
                  <button
                    type="button"
                    style={{
                      ...styles.contextButton,
                      ...(permissionPreset === 'danger-full-access' ? styles.contextButtonDanger : {}),
                    }}
                    disabled={contextLoading}
                    title={permissionDescription(permissionPreset, selectedPermission?.description, t)}
                    data-testid="automation-permission-selector"
                    onClick={() => {
                      const opening = !permissionMenu
                      closeMenus()
                      setPermissionMenu(opening)
                    }}
                  >
                    {permissionPreset === 'danger-full-access'
                      ? <IconWarningOutline16 size={16} />
                      : <IconFolderOpenOutline16 size={16} />}
                    <span>
                      {permissionLabel(
                        permissionPreset,
                        selectedPermission?.name ?? permissionPreset,
                        t,
                      )}
                    </span>
                    <IconChevronDownOutline14 size={14} />
                  </button>
                )}
              />
            </div>
          </div>
          {fieldErrors.prompt === undefined ? null : (
            <span style={styles.fieldError} data-testid="automation-field-error">{fieldErrors.prompt}</span>
          )}
        </div>
        <div style={styles.field} ref={scheduleFieldRef}>
          <span style={styles.fieldLabel}>{t('schedule')}</span>
          <div style={styles.segmented}>
            {(['once', 'daily', 'weekly'] as const).map(value => (
              <button
                key={value}
                type="button"
                style={{ ...styles.segment, ...(kind === value ? styles.segmentActive : {}) }}
                onClick={() => {
                  setKind(value)
                  setFieldErrors(current => ({ ...current, schedule: undefined, weekdays: undefined }))
                }}
              >
                {t(value)}
              </button>
            ))}
          </div>
        </div>
        {kind === 'once' ? (
          <label style={styles.field}>
            <span style={styles.fieldLabel}>{t('dateTime')}</span>
            <input
              type="datetime-local"
              style={styles.nativeInput}
              value={once}
              onChange={(event) => {
                setOnce(event.target.value)
                setFieldErrors(current => ({ ...current, schedule: undefined }))
              }}
            />
            {fieldErrors.schedule === undefined ? null : (
              <span style={styles.fieldError} data-testid="automation-field-error">{fieldErrors.schedule}</span>
            )}
          </label>
        ) : (
          <label style={styles.field}>
            <span style={styles.fieldLabel}>{t('time')}</span>
            <input
              type="time"
              style={styles.nativeInput}
              value={time}
              onChange={(event) => {
                setTime(event.target.value)
                setFieldErrors(current => ({ ...current, schedule: undefined }))
              }}
            />
            {fieldErrors.schedule === undefined ? null : (
              <span style={styles.fieldError} data-testid="automation-field-error">{fieldErrors.schedule}</span>
            )}
          </label>
        )}
        {kind !== 'weekly' ? null : (
          <div style={styles.field}>
            <span style={styles.fieldLabel}>{t('weekdays')}</span>
            <div style={styles.weekdays}>
              {[1, 2, 3, 4, 5, 6, 0].map(day => (
                <button
                  key={day}
                  type="button"
                  style={{ ...styles.weekday, ...(weekdays.includes(day) ? styles.weekdayActive : {}) }}
                  onClick={() => {
                    setWeekdays(current => (
                      current.includes(day)
                        ? current.filter(candidate => candidate !== day)
                        : [...current, day]
                    ))
                    setFieldErrors(current => ({ ...current, weekdays: undefined }))
                  }}
                >
                  {t(`weekday${String(day)}` as AutomationKey)}
                </button>
              ))}
            </div>
            {fieldErrors.weekdays === undefined ? null : (
              <span style={styles.fieldError} data-testid="automation-field-error">{fieldErrors.weekdays}</span>
            )}
          </div>
        )}
        <label style={styles.checkRow}>
          <input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />
          <span>{t('enable')}</span>
        </label>
        <div style={styles.source}>
          <span style={styles.metaLabel}>{t('sourceLabel')}</span>
          <strong>{executionSource?.title ?? t('sourceMissing')}</strong>
          {executionSource?.cwd === undefined ? null : <span style={styles.sourcePath}>{executionSource.cwd}</span>}
        </div>
      </div>
      {/* 完全访问的风险确认用系统自带的 RiskConfirmation——与内核作曲区
          PermissionSelect 的完全访问门禁同一个原语、同一套样式。 */}
      <RiskConfirmation
        open={confirmFullAccess}
        title={t('fullAccessConfirmTitle')}
        description={t('fullAccessConfirmBody')}
        acknowledgeLabel={t('fullAccessAcknowledge')}
        cancelLabel={t('cancel')}
        confirmLabel={t('confirmFullAccess')}
        acknowledged={riskAcknowledged}
        disabled={saving}
        onAcknowledgedChange={setRiskAcknowledged}
        onCancel={() => {
          setConfirmFullAccess(false)
          setRiskAcknowledged(false)
        }}
        onConfirm={() => {
          setConfirmFullAccess(false)
          setRiskAcknowledged(false)
          void submit(true)
        }}
      />
      <footer style={styles.editorFooter}>
        {/* 宿主返回的意外错误放在保存按钮旁——点保存时视线就在这里。 */}
        {failure === undefined ? null : (
          <span style={styles.footerError} data-testid="automation-editor-failure">{failure}</span>
        )}
        <Button variant="outline" disabled={saving} onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="primary"
          disabled={
            saving
            || confirmFullAccess
            || executionSource === undefined
            || !contextReady
            || contextLoading
          }
          onClick={() => { void submit() }}
        >
          {saving ? t('saving') : t('save')}
        </Button>
      </footer>
    </section>
  )
}

function MenuOptionLabel(props: {
  readonly title: string
  readonly description: string | undefined
}): ReactNode {
  return (
    <span style={styles.menuOption}>
      <span style={styles.menuOptionTitle}>{props.title}</span>
      {props.description === undefined ? null : (
        <span style={styles.menuOptionDescription}>{props.description}</span>
      )}
    </span>
  )
}

function permissionLabel(value: string, fallback: string, t: T): string {
  if (value === 'read-only') return t('permissionReadOnly')
  if (value === 'workspace-write') return t('permissionWorkspace')
  if (value === 'danger-full-access') return t('permissionFullAccess')
  return fallback
}

function permissionDescription(value: string, fallback: string | undefined, t: T): string | undefined {
  if (value === 'read-only') return t('permissionReadOnlyBody')
  if (value === 'workspace-write') return t('permissionWorkspaceBody')
  if (value === 'danger-full-access') return t('permissionFullAccessBody')
  return fallback
}

function textMatches(name: string, description: string | undefined, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return name.toLowerCase().includes(needle)
    || (description ?? '').toLowerCase().includes(needle)
}

function workspaceMatches(
  workspaces: AutomationContextOptions['workspaces'],
  query: string,
): AutomationContextOptions['workspaces'] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return workspaces
  return workspaces.filter(workspace =>
    workspace.title.toLowerCase().includes(needle)
    || workspace.path.toLowerCase().includes(needle))
}

function editorInitial(task: AutomationTask | undefined): {
  name: string
  prompt: string
  kind: AutomationSchedule['kind']
  once: string
  time: string
  weekdays: number[]
  enabled: boolean
} {
  const nextHour = new Date(Date.now() + 60 * 60 * 1_000)
  nextHour.setMinutes(0, 0, 0)
  if (task === undefined) {
    return {
      name: '',
      prompt: '',
      kind: 'daily',
      once: localDateTime(nextHour.getTime()),
      time: `${two(nextHour.getHours())}:${two(nextHour.getMinutes())}`,
      weekdays: [1, 2, 3, 4, 5],
      enabled: true,
    }
  }
  const schedule = task.schedule
  return {
    name: task.title,
    prompt: task.prompt,
    kind: schedule.kind,
    once: schedule.kind === 'once' ? localDateTime(schedule.at) : localDateTime(nextHour.getTime()),
    time: schedule.kind === 'once'
      ? `${two(nextHour.getHours())}:${two(nextHour.getMinutes())}`
      : `${two(schedule.hour)}:${two(schedule.minute)}`,
    weekdays: schedule.kind === 'weekly' ? [...schedule.weekdays] : [1, 2, 3, 4, 5],
    enabled: task.enabled,
  }
}

/** Draft errors are field-tagged so the editor can render them in place. */
type ScheduleDraft =
  | AutomationSchedule
  | { readonly field: 'schedule' | 'weekdays'; readonly error: string }

function scheduleFromDraft(
  kind: AutomationSchedule['kind'],
  once: string,
  time: string,
  weekdays: number[],
  t: T,
): ScheduleDraft {
  if (kind === 'once') {
    const at = new Date(once).getTime()
    if (!Number.isFinite(at)) return { field: 'schedule', error: t('onceInvalid') }
    if (at <= Date.now()) return { field: 'schedule', error: t('oncePast') }
    return { kind: 'once', at }
  }
  const match = /^(\d{2}):(\d{2})$/.exec(time)
  if (match === null) return { field: 'schedule', error: t('timeInvalid') }
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (kind === 'daily') return { kind, hour, minute }
  if (weekdays.length === 0) return { field: 'weekdays', error: t('weekdaysRequired') }
  return { kind, weekdays: [...new Set(weekdays)].sort((a, b) => a - b), hour, minute }
}

function scheduleText(schedule: AutomationSchedule, t: T): string {
  if (schedule.kind === 'once') return t('scheduleOnce', { time: formatDate(schedule.at) })
  const time = `${two(schedule.hour)}:${two(schedule.minute)}`
  if (schedule.kind === 'daily') return t('scheduleDaily', { time })
  return t('scheduleWeekly', {
    days: schedule.weekdays.map(day => t(`weekday${String(day)}` as AutomationKey)).join('、'),
    time,
  })
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

function localDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  return `${String(date.getFullYear()).padStart(4, '0')}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
    + `T${two(date.getHours())}:${two(date.getMinutes())}`
}

function two(value: number): string {
  return String(value).padStart(2, '0')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const styles = {
  page: { display: 'flex', flexDirection: 'column', gap: '14px', minHeight: '100%' },
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
  timeNote: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' },
  error: {
    display: 'flex', flexDirection: 'column', gap: '4px', padding: '10px 12px',
    borderRadius: '10px', background: 'var(--dsw-alias-state-error-tertiary)',
    color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px',
  },
  deleteConfirm: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    flexWrap: 'wrap', gap: '12px', padding: '12px 14px',
    border: '1px solid var(--dsw-alias-state-error-primary)', borderRadius: '12px',
    background: 'var(--dsw-alias-state-error-tertiary)',
  },
  deleteCopy: { display: 'flex', minWidth: '240px', flex: 1, flexDirection: 'column', gap: '4px' },
  deleteHeading: { color: 'var(--dsw-alias-label-primary)', fontSize: '13px' },
  deleteBody: {
    color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: 1.5,
  },
  empty: {
    display: 'flex', flex: 1, minHeight: '320px', alignItems: 'center',
    justifyContent: 'center', flexDirection: 'column', gap: '10px',
    color: 'var(--dsw-alias-label-secondary)', textAlign: 'center',
  },
  emptyMark: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '48px', height: '48px', borderRadius: '16px',
    background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-tertiary)',
  },
  emptyTitle: { color: 'var(--dsw-alias-label-primary)', fontSize: '15px' },
  emptyBody: { maxWidth: '360px', fontSize: '12px', lineHeight: 1.6 },
  list: { display: 'flex', flexDirection: 'column', gap: '12px' },
  card: {
    display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0,
    padding: '16px', border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '16px', background: 'var(--dsw-alias-bg-layer-1)',
  },
  cardHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' },
  identity: { display: 'flex', minWidth: 0, flex: 1, flexDirection: 'column', gap: '5px' },
  titleLine: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 },
  cardTitle: {
    minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    color: 'var(--dsw-alias-label-primary)', fontSize: '14px',
  },
  scheduleText: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
  state: { padding: '2px 7px', borderRadius: '999px', fontSize: '11px', whiteSpace: 'nowrap' },
  stateEnabled: {
    color: 'var(--dsw-alias-state-success-primary)',
    background: 'var(--dsw-alias-state-success-tertiary)',
  },
  stateRunning: {
    color: 'var(--dsw-alias-state-business-primary)',
    background: 'var(--dsw-alias-state-business-tertiary)',
  },
  stateFailed: {
    color: 'var(--dsw-alias-state-error-primary)',
    background: 'var(--dsw-alias-state-error-tertiary)',
  },
  stateMuted: {
    color: 'var(--dsw-alias-label-tertiary)',
    background: 'var(--dsw-alias-interactive-bg-hover)',
  },
  prompt: {
    margin: 0, display: '-webkit-box', overflow: 'hidden', WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical', color: 'var(--dsw-alias-label-secondary)',
    fontSize: '12px', lineHeight: 1.6, whiteSpace: 'pre-wrap',
  },
  metaGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: '12px', padding: '10px 12px', borderRadius: '10px',
    background: 'var(--dsw-alias-interactive-bg-hover)',
  },
  metaLabel: { display: 'block', color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' },
  metaValue: {
    display: 'block', marginTop: '3px', overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-primary)', fontSize: '12px',
  },
  runError: {
    padding: '8px 10px', borderRadius: '8px',
    background: 'var(--dsw-alias-state-error-tertiary)',
    color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', lineHeight: 1.5,
  },
  cardFooter: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: '12px', paddingTop: '2px',
  },
  actions: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px' },
  dangerButton: {
    minHeight: '34px', padding: '6px 14px', border: 0, borderRadius: '10px',
    background: 'var(--dsw-alias-state-error-primary)', color: '#fff',
    cursor: 'pointer', fontSize: '13px',
  },
  editor: {
    display: 'flex', flexDirection: 'column', width: 'min(760px, 100%)',
    minWidth: 0, minHeight: '100%', margin: '0 auto',
  },
  editorHeader: {
    flex: 'none', padding: '2px 0 16px',
    borderBottom: '1px solid var(--dsw-alias-border-l1)',
  },
  editorTitle: {
    margin: 0, color: 'var(--dsw-alias-label-primary)', fontSize: '16px', fontWeight: 600,
  },
  editorFooter: {
    flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
    gap: '8px', paddingTop: '16px', borderTop: '1px solid var(--dsw-alias-border-l1)',
  },
  form: {
    display: 'flex', flex: 1, flexDirection: 'column', gap: '16px',
    width: '100%', minWidth: 0, padding: '20px 0',
  },
  field: { display: 'flex', flexDirection: 'column', gap: '7px' },
  fieldLabel: { color: 'var(--dsw-alias-label-primary)', fontSize: '12px', fontWeight: 600 },
  // 不能 overflow:hidden——技能/专家面板锚在上下文栏里向上弹出，
  // 会被裁掉；内部背景都是透明的，圆角不需要裁剪兜底。
  promptComposer: {
    display: 'flex', flexDirection: 'column', position: 'relative',
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '12px',
    background: 'var(--dsw-alias-bg-layer-1)',
  },
  promptTextarea: {
    boxSizing: 'border-box', width: '100%', resize: 'vertical', minHeight: '150px',
    padding: '12px', border: 0, outline: 'none', background: 'transparent',
    color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: '13px', lineHeight: 1.55,
  },
  contextBar: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px',
    minHeight: '40px', padding: '6px 8px', borderTop: '1px solid var(--dsw-alias-border-l1)',
  },
  contextButton: {
    display: 'inline-flex', alignItems: 'center', gap: '5px', minWidth: 0,
    height: '28px', padding: '0 7px', border: 0, borderRadius: '7px',
    background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
    cursor: 'pointer', fontSize: '12px', whiteSpace: 'nowrap',
  },
  contextButtonActive: {
    color: 'var(--dsw-alias-state-business-primary)',
    background: 'var(--dsw-alias-state-business-tertiary)',
  },
  contextButtonDanger: {
    color: 'var(--dsw-alias-state-warn-primary)',
    background: 'var(--dsw-alias-state-warn-tertiary)',
  },
  workspaceBox: {
    position: 'relative', display: 'flex', alignItems: 'center', gap: '8px',
    minHeight: '40px', padding: '5px 8px',
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '10px',
    background: 'var(--dsw-alias-bg-layer-1)',
  },
  workspaceAdd: {
    display: 'inline-flex', flex: 'none', alignItems: 'center', justifyContent: 'center',
    width: '28px', height: '28px', border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '8px', background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer',
  },
  workspaceHint: {
    minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px',
  },
  workspaceTag: {
    display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: 0,
    maxWidth: '100%', height: '28px', padding: '0 6px 0 9px',
    borderRadius: '8px', background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-primary)', fontSize: '12px',
  },
  workspaceTagText: {
    minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  workspaceTagClose: {
    display: 'inline-flex', flex: 'none', alignItems: 'center', justifyContent: 'center',
    width: '18px', height: '18px', padding: 0, border: 0, borderRadius: '5px',
    background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer',
  },
  pickerMask: {
    position: 'fixed', inset: 0, zIndex: 5, border: 0,
    background: 'transparent', cursor: 'default',
  },
  workspacePopover: {
    position: 'absolute', zIndex: 6, top: 'calc(100% + 4px)', left: 0,
    display: 'flex', flexDirection: 'column', gap: '6px',
    width: 'min(340px, 100%)', maxHeight: '280px', padding: '8px',
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '12px',
    background: 'var(--dsw-alias-bg-layer-2)', boxShadow: 'var(--dsw-shadow-lv2)',
  },
  workspaceList: {
    display: 'flex', flexDirection: 'column', gap: '2px',
    minHeight: 0, overflowY: 'auto',
  },
  workspaceEmpty: {
    padding: '14px 8px', color: 'var(--dsw-alias-label-tertiary)',
    fontSize: '12px', textAlign: 'center',
  },
  workspaceItem: {
    display: 'flex', alignItems: 'flex-start', gap: '8px', minWidth: 0,
    padding: '7px 8px', border: 0, borderRadius: '8px',
    background: 'transparent', color: 'var(--dsw-alias-label-primary)',
    cursor: 'pointer', textAlign: 'left',
  },
  workspaceItemDisabled: { cursor: 'not-allowed', opacity: 0.55 },
  workspaceItemCopy: { display: 'flex', minWidth: 0, flexDirection: 'column', gap: '2px' },
  workspaceItemTitle: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px',
  },
  workspaceItemPath: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px', fontFamily: 'monospace',
  },
  menuOption: {
    display: 'flex', minWidth: 0, flexDirection: 'column', gap: '2px',
  },
  menuOptionTitle: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    color: 'inherit', fontSize: '12px',
  },
  // WorkBuddy 的菜单行形状：描述灰字单行省略，不让长文案撑爆菜单。
  menuOptionDescription: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px', lineHeight: 1.4,
  },
  fieldError: {
    color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', lineHeight: 1.4,
  },
  footerError: {
    marginRight: 'auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
    color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px',
  },
  pickerAnchor: { position: 'relative', display: 'inline-flex' },
  // 技能/专家面板：与工作空间选择器同一形状，锚在上下文栏、向上弹出。
  panel: {
    position: 'absolute', zIndex: 6, bottom: 'calc(100% + 6px)', left: 0,
    display: 'flex', flexDirection: 'column', gap: '6px',
    width: '300px', maxHeight: '320px', padding: '8px',
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '12px',
    background: 'var(--dsw-alias-bg-layer-2)', boxShadow: 'var(--dsw-shadow-lv2)',
  },
  panelBar: {
    display: 'flex', flex: 'none', alignItems: 'center', justifyContent: 'space-between',
    gap: '8px', padding: '0 2px', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px',
  },
  panelBarText: {
    minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  panelClear: {
    flex: 'none', padding: '3px 8px', border: 0, borderRadius: '7px',
    background: 'transparent', color: 'var(--dsw-alias-state-business-primary)',
    cursor: 'pointer', fontSize: '12px',
  },
  panelList: {
    display: 'flex', flexDirection: 'column', gap: '2px',
    minHeight: 0, overflowY: 'auto',
  },
  panelGroup: {
    padding: '6px 8px 2px', color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px',
  },
  panelItem: {
    display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0,
    padding: '6px 8px', border: 0, borderRadius: '8px',
    background: 'transparent', color: 'var(--dsw-alias-label-primary)',
    cursor: 'pointer', textAlign: 'left',
  },
  panelItemDisabled: { cursor: 'not-allowed', opacity: 0.55 },
  panelItemCopy: { display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column', gap: '2px' },
  panelItemTitle: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px',
  },
  panelItemDesc: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px',
  },
  panelEmpty: {
    padding: '14px 8px', color: 'var(--dsw-alias-label-tertiary)',
    fontSize: '12px', textAlign: 'center',
  },
  skillBox: {
    display: 'inline-flex', flex: 'none', alignItems: 'center', justifyContent: 'center',
    boxSizing: 'border-box', width: '15px', height: '15px',
    border: '1.5px solid var(--dsw-alias-border-l3)', borderRadius: '4px',
    background: 'transparent', color: 'transparent',
  },
  skillBoxOn: {
    border: 0, background: 'var(--dsw-alias-button-primary-fill)',
    color: 'var(--dsw-alias-button-primary-label)',
  },
  nativeInput: {
    boxSizing: 'border-box', width: '100%', height: '36px', padding: '6px 10px',
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '10px',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
    colorScheme: 'light dark',
  },
  segmented: {
    display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '3px',
    padding: '3px', borderRadius: '10px', background: 'var(--dsw-alias-interactive-bg-hover)',
  },
  segment: {
    height: '32px', border: 0, borderRadius: '8px', background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: '12px',
  },
  segmentActive: {
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
    boxShadow: 'var(--dsw-shadow-lv1)',
  },
  weekdays: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '6px' },
  weekday: {
    height: '32px', padding: 0, border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '9px', background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: '12px',
  },
  weekdayActive: {
    borderColor: 'var(--dsw-alias-state-business-primary)',
    background: 'var(--dsw-alias-state-business-tertiary)',
    color: 'var(--dsw-alias-state-business-primary)',
  },
  checkRow: {
    display: 'flex', alignItems: 'center', gap: '8px',
    color: 'var(--dsw-alias-label-primary)', fontSize: '13px',
  },
  source: {
    display: 'flex', flexDirection: 'column', gap: '4px', padding: '10px 12px',
    borderRadius: '10px', background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-primary)', fontSize: '12px',
  },
  sourcePath: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'monospace',
  },
} satisfies Record<string, CSSProperties>
