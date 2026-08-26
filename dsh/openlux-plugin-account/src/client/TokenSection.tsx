import {
  Button, DisclosureRow, IconSearchOutline16, IconSettingsOutline16,
  Input, Modal, useAnchoredMaxHeight,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type DragEvent, type KeyboardEvent,
} from 'react'
import type {
  ManagedToken,
  RoutingPriority,
  TokenDraft,
  TokenGroup,
  TokenListSnapshot,
  TokenQuotaUnit,
  TokenUpdateDraft,
} from '../token-wire.ts'
import type { AccountHostCaller } from './types.ts'

export const TOKEN_SECTION_ID = 'openlux-token-section'
export const TOKEN_SECTION_ORDER = -5

export interface TokenSectionInjected {
  readonly callHost: AccountHostCaller
}

type TokenSectionProps = PropsRuntime<'settings.section'> & InjectFace<TokenSectionInjected>
type PendingAction = { readonly kind: 'close' } | { readonly kind: 'edit'; readonly id: number }

const ROUTES: ReadonlyArray<{
  readonly id: Exclude<RoutingPriority, ''>
  readonly label: string
  readonly detail: string
}> = [
  { id: 'auto', label: '自动选择', detail: '综合价格、速度和成功率' },
  { id: 'price', label: '价格优先', detail: '优先尝试倍率更低的渠道' },
  { id: 'speed', label: '速度优先', detail: '优先尝试响应更快的渠道' },
  { id: 'success_rate', label: '成功率优先', detail: '优先尝试近期更稳定的渠道' },
]

/** Scheme A: relaxed token rows with one inline editor at a time. */
export function TokenSection(props: TokenSectionProps) {
  const [snapshot, setSnapshot] = useState<TokenListSnapshot>()
  const [groups, setGroups] = useState<readonly TokenGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string>()
  const [busyId, setBusyId] = useState<number>()
  const [editingId, setEditingId] = useState<number>()
  const [dirtyId, setDirtyId] = useState<number>()
  const [pending, setPending] = useState<PendingAction>()
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ManagedToken>()
  const [deleting, setDeleting] = useState(false)
  const [syncingModels, setSyncingModels] = useState(false)
  const [modelsRefreshedAt, setModelsRefreshedAt] = useState<number>()

  const call = useCallback(async <T,>(method: string, payload: unknown, signal?: AbortSignal): Promise<T> => {
    const result = await props.callHost<T>(method, payload, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }, [props.callHost])

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setFailure(undefined)
    const [next, available] = await Promise.all([
      call<TokenListSnapshot>('tokens.list', {}, signal),
      call<readonly TokenGroup[]>('tokens.groups', {}, signal),
    ])
    setSnapshot(next)
    setGroups(available)
  }, [call])

  useEffect(() => {
    const stop = new AbortController()
    setLoading(true)
    load(stop.signal).catch(error => {
      if (!stop.signal.aborted) setFailure(messageOf(error))
    }).finally(() => {
      if (!stop.signal.aborted) setLoading(false)
    })
    return () => stop.abort()
  }, [load])

  const requestEdit = (id: number): void => {
    if (editingId === id) {
      if (dirtyId === id) {
        setPending({ kind: 'close' })
      } else {
        setEditingId(undefined)
      }
      return
    }
    if (editingId !== undefined && dirtyId === editingId) {
      setPending({ kind: 'edit', id })
      return
    }
    setEditingId(id)
    setPending(undefined)
  }

  const discardPending = (): void => {
    if (pending?.kind === 'edit') setEditingId(pending.id)
    else setEditingId(undefined)
    setDirtyId(undefined)
    setPending(undefined)
  }

  const save = async (draft: TokenDraft | TokenUpdateDraft): Promise<void> => {
    const update = 'id' in draft
    await call(update ? 'tokens.update' : 'tokens.create', draft)
    await load()
    if (update) {
      setEditingId(undefined)
      setDirtyId(undefined)
      setPending(undefined)
    } else {
      setCreating(false)
    }
  }

  const useToken = async (id: number): Promise<void> => {
    setBusyId(id)
    setFailure(undefined)
    try {
      await call('tokens.use', { id })
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
      await call('tokens.delete', { id: deleteTarget.id })
      await load()
      if (editingId === deleteTarget.id) setEditingId(undefined)
      setDeleteTarget(undefined)
    } catch (error: unknown) {
      setFailure(messageOf(error))
    } finally {
      setDeleting(false)
    }
  }

  const refreshModels = async (): Promise<void> => {
    setSyncingModels(true)
    setFailure(undefined)
    try {
      const result = await call<{ refreshedAt?: number }>('models.sync', {})
      setModelsRefreshedAt(result.refreshedAt ?? Date.now())
    } catch (error: unknown) {
      setFailure(messageOf(error))
    } finally {
      setSyncingModels(false)
    }
  }

  const setDirty = useCallback((id: number, dirty: boolean): void => {
    setDirtyId(current => dirty ? id : current === id ? undefined : current)
  }, [])

  const ordered = useMemo(() => {
    if (snapshot === undefined) return []
    const current = snapshot.tokens.find(token => token.id === snapshot.currentId)
    return current === undefined
      ? [...snapshot.tokens]
      : [current, ...snapshot.tokens.filter(token => token.id !== current.id)]
  }, [snapshot])

  return (
    <div style={styles.section}>
      <div style={styles.headingRow}>
        <div>
          <h2 style={styles.title}>令牌</h2>
          <p style={styles.intro}>切换当前令牌，或在这里创建和编辑中转站令牌。密钥不会显示在客户端。</p>
        </div>
        <div style={styles.headingActions}>
          {modelsRefreshedAt === undefined ? null : (
            <span style={styles.count}>模型刷新于 {new Date(modelsRefreshedAt).toLocaleTimeString('zh-CN')}</span>
          )}
          <Button size="sm" variant="outline" disabled={syncingModels} onClick={() => { void refreshModels() }}>
            {syncingModels ? '刷新中…' : '刷新模型配置'}
          </Button>
          {snapshot === undefined ? null : <span style={styles.count}>{snapshot.tokens.length} 把</span>}
        </div>
      </div>

      {snapshot?.credentialWritable === false ? (
        <Notice tone="warn">
          当前密钥由只读来源 {snapshot.credentialSource ?? 'environment'} 提供，令牌可管理，但不能在客户端切换。
        </Notice>
      ) : null}
      {failure === undefined ? null : <Notice tone="error">{failure}</Notice>}

      {loading ? (
        <div style={styles.empty}>正在读取令牌…</div>
      ) : snapshot === undefined ? (
        <div style={styles.empty}>暂时无法读取令牌。</div>
      ) : (
        <>
          <div style={styles.rows}>
            {ordered.map((token, index) => {
              const active = token.id === snapshot.currentId
              const open = token.id === editingId
              const sectionLabel = active
                ? '当前令牌'
                : index === 0 || ordered[index - 1]?.id === snapshot.currentId
                  ? snapshot.currentId === undefined ? '全部令牌' : '其他令牌'
                  : undefined
              return (
                <div key={token.id} style={styles.tokenBlock}>
                  {sectionLabel === undefined ? null : <div style={styles.listLabel}>{sectionLabel}</div>}
                  <article style={{ ...styles.card, ...(active ? styles.activeCard : {}) }}>
                  <div style={styles.cardHead}>
                    <div style={styles.identity}>
                      <div style={styles.nameLine}>
                        <span style={styles.tokenName}>{token.name}</span>
                        {active ? <Tag accent>正在使用</Tag> : <StatusTag token={token} />}
                      </div>
                      <div style={styles.meta}>
                        <span style={styles.mono}>{token.maskedKey}</span>
                        <span>·</span>
                        <span>{routingSummary(token)}</span>
                        <span>·</span>
                        <span>已用 {formatQuota(token.usedQuota, snapshot.quotaUnit)}</span>
                      </div>
                    </div>
                    <div style={styles.actions}>
                      <Button size="sm" variant="outline" onClick={() => requestEdit(token.id)}>
                        {open ? '收起' : '编辑'}
                      </Button>
                      <Button
                        size="sm"
                        variant={active ? 'ghost' : 'primary'}
                        disabled={active || busyId !== undefined || !snapshot.credentialWritable
                          || token.status !== 1 || isTokenExpired(token)}
                        onClick={() => { void useToken(token.id) }}
                      >
                        {active ? '当前令牌' : busyId === token.id ? '切换中…' : '使用'}
                      </Button>
                    </div>
                  </div>

                  {open ? (
                    <div style={styles.editorWrap}>
                      {pending === undefined ? null : (
                        <div style={styles.unsaved}>
                          <div>
                            <strong style={styles.unsavedTitle}>当前修改尚未保存</strong>
                            <div style={styles.unsavedText}>切换编辑对象会丢弃下面的草稿。</div>
                          </div>
                          <div style={styles.actions}>
                            <Button size="sm" variant="outline" onClick={() => setPending(undefined)}>继续编辑</Button>
                            <Button size="sm" variant="primary" onClick={discardPending}>放弃并切换</Button>
                          </div>
                        </div>
                      )}
                      <TokenEditor
                        key={token.id}
                        token={token}
                        groups={groups}
                        quotaUnit={snapshot.quotaUnit}
                        onDirtyChange={dirty => setDirty(token.id, dirty)}
                        onCancel={() => {
                          setEditingId(undefined)
                          setDirtyId(undefined)
                          setPending(undefined)
                        }}
                        onSave={save}
                        {...(active ? {} : { onDelete: () => setDeleteTarget(token) })}
                      />
                    </div>
                  ) : null}
                  </article>
                </div>
              )
            })}
          </div>

          {creating ? (
            <article style={{ ...styles.card, ...styles.createCard }}>
              <div style={styles.createHeading}>新建令牌</div>
              <TokenEditor
                groups={groups}
                quotaUnit={snapshot.quotaUnit}
                onDirtyChange={() => {}}
                onCancel={() => setCreating(false)}
                onSave={save}
              />
            </article>
          ) : (
            <button type="button" style={styles.addButton} onClick={() => setCreating(true)}>
              ＋ 新建令牌
            </button>
          )}
        </>
      )}

      <Modal
        open={deleteTarget !== undefined}
        onClose={() => { if (!deleting) setDeleteTarget(undefined) }}
        title="删除令牌"
        closeLabel="关闭"
        description={deleteTarget === undefined ? '' : `确定删除“${deleteTarget.name}”吗？此操作无法撤销。`}
        footer={(
          <div style={styles.actions}>
            <Button variant="outline" disabled={deleting} onClick={() => setDeleteTarget(undefined)}>取消</Button>
            <button type="button" style={styles.dangerButton} disabled={deleting} onClick={() => { void remove() }}>
              {deleting ? '删除中…' : '删除'}
            </button>
          </div>
        )}
      />
    </div>
  )
}

function TokenEditor(props: {
  readonly token?: ManagedToken
  readonly groups: readonly TokenGroup[]
  readonly quotaUnit: TokenQuotaUnit
  readonly onDirtyChange: (dirty: boolean) => void
  readonly onCancel: () => void
  readonly onSave: (draft: TokenDraft | TokenUpdateDraft) => Promise<void>
  readonly onDelete?: () => void
}) {
  const initial = useMemo(() => editorInitial(props.token, props.quotaUnit), [props.quotaUnit, props.token])
  const [name, setName] = useState(initial.name)
  const [routing, setRouting] = useState<RoutingPriority>(initial.routing)
  const [groupIds, setGroupIds] = useState<readonly number[]>(initial.groupIds)
  const [unlimited, setUnlimited] = useState(initial.unlimited)
  const [quota, setQuota] = useState(initial.quota)
  const [neverExpires, setNeverExpires] = useState(initial.neverExpires)
  const [expiry, setExpiry] = useState(initial.expiry)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const dirty = name !== initial.name
    || routing !== initial.routing
    || JSON.stringify(groupIds) !== JSON.stringify(initial.groupIds)
    || unlimited !== initial.unlimited
    || quota !== initial.quota
    || neverExpires !== initial.neverExpires
    || expiry !== initial.expiry

  useEffect(() => { props.onDirtyChange(dirty) }, [dirty, props.onDirtyChange])

  const save = async (): Promise<void> => {
    const cleanName = name.trim()
    if (cleanName === '') {
      setFailure('请填写令牌名称')
      return
    }
    if (routing === '' && groupIds.length === 0) {
      setFailure('关闭智能路由后，至少选择一个渠道分组')
      return
    }
    const expiredTime = neverExpires ? -1 : fromLocalDateTime(expiry)
    if (!neverExpires && expiredTime <= 0) {
      setFailure('请选择有效期')
      return
    }
    setSaving(true)
    setFailure(undefined)
    try {
      const draft: TokenDraft = {
        name: cleanName,
        routingPriority: routing,
        groupIds,
        unlimitedQuota: unlimited,
        remainQuota: unlimited ? 0 : amountToQuota(Number(quota), props.quotaUnit),
        expiredTime,
      }
      if (props.token === undefined) {
        await props.onSave(draft)
      } else {
        const changes: Partial<TokenDraft> = {
          ...cleanName === initial.name ? {} : { name: draft.name },
          ...routing === initial.routing ? {} : { routingPriority: draft.routingPriority },
          ...JSON.stringify(groupIds) === JSON.stringify(initial.groupIds) ? {} : { groupIds: draft.groupIds },
          ...unlimited === initial.unlimited ? {} : { unlimitedQuota: draft.unlimitedQuota },
          ...quota === initial.quota && unlimited === initial.unlimited ? {} : { remainQuota: draft.remainQuota },
          ...neverExpires === initial.neverExpires && expiry === initial.expiry ? {} : { expiredTime: draft.expiredTime },
        }
        await props.onSave({ id: props.token.id, changes })
      }
    } catch (error: unknown) {
      setFailure(messageOf(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <Field label="令牌名称">
        <Input
          value={name}
          maxLength={30}
          placeholder="例如：云雾桌面客户端"
          disabled={saving}
          onChange={event => setName(event.target.value)}
          style={styles.fullWidth}
        />
      </Field>

      <div style={styles.field}>
        <div style={styles.switchLine}>
          <div>
            <div style={styles.fieldLabel}>智能路由</div>
            <div style={styles.help}>开启后由中转站按策略动态选择渠道。</div>
          </div>
          <div style={styles.switchControl}>
            <span style={styles.switchStatus}>{routing === '' ? '已关闭' : '智能路由已开启'}</span>
            <Switch
              checked={routing !== ''}
              disabled={saving}
              label="智能路由"
              onChange={checked => setRouting(checked ? 'auto' : '')}
            />
          </div>
        </div>
        {routing === '' ? (
          <Notice tone="neutral">智能路由已关闭，请按优先级选择渠道分组。</Notice>
        ) : (
          <div style={styles.routeGrid}>
            {ROUTES.map(route => (
              <button
                key={route.id}
                type="button"
                disabled={saving}
                aria-pressed={routing === route.id}
                style={{ ...styles.routeCard, ...(routing === route.id ? styles.routeCardActive : {}) }}
                onClick={() => setRouting(route.id)}
              >
                <span style={styles.routeTitle}>{route.label}</span>
                <span style={styles.routeDetail}>{route.detail}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={styles.customized}>
        <DisclosureRow
          icon={<IconSettingsOutline16 />}
          title="更多设置"
          open={advancedOpen}
          expandable
          expandOnRowClick
          collapsedContent={<span style={styles.disclosureHint}>额度与有效期</span>}
          onToggle={() => setAdvancedOpen(open => !open)}
        >
          <div style={styles.customizedBody}>
            <div style={styles.twoColumn}>
              <div style={styles.field}>
                <div style={styles.switchLine}>
                  <div>
                    <div style={styles.fieldLabel}>无限额度</div>
                    <div style={styles.help}>关闭后按剩余额度限制。</div>
                  </div>
                  <Switch checked={unlimited} disabled={saving} label="无限额度" onChange={setUnlimited} />
                </div>
                {unlimited ? null : (
                  <div style={styles.amountInput}>
                    <span style={styles.prefix}>{props.quotaUnit.tokens ? '' : props.quotaUnit.symbol}</span>
                    <input
                      type="number"
                      min={0}
                      step={props.quotaUnit.tokens ? 1 : 0.01}
                      value={quota}
                      disabled={saving}
                      aria-label="剩余额度"
                      style={{ ...styles.nativeInput, paddingLeft: props.quotaUnit.tokens ? 10 : 28 }}
                      onChange={event => setQuota(event.target.value)}
                    />
                  </div>
                )}
              </div>

              <div style={styles.field}>
                <div style={styles.switchLine}>
                  <div>
                    <div style={styles.fieldLabel}>永不过期</div>
                    <div style={styles.help}>关闭后设置到期时间。</div>
                  </div>
                  <Switch checked={neverExpires} disabled={saving} label="永不过期" onChange={setNeverExpires} />
                </div>
                {neverExpires ? null : (
                  <input
                    type="datetime-local"
                    value={expiry}
                    disabled={saving}
                    aria-label="有效期"
                    style={styles.nativeInput}
                    onChange={event => setExpiry(event.target.value)}
                  />
                )}
              </div>
            </div>
          </div>
        </DisclosureRow>
      </div>

      {routing !== '' ? null : (
        <Field label="渠道分组" hint="拖拽已选分组即可调整尝试顺序。">
          <GroupPicker
            groups={props.groups}
            selected={groupIds}
            disabled={saving}
            onChange={setGroupIds}
          />
        </Field>
      )}

      {failure === undefined ? null : <div style={styles.formError}>{failure}</div>}

      <div style={styles.editorActions}>
        {props.onDelete === undefined ? <span /> : (
          <button type="button" style={styles.linkDanger} disabled={saving} onClick={props.onDelete}>删除令牌</button>
        )}
        <div style={styles.actions}>
          <Button variant="outline" size="sm" disabled={saving} onClick={props.onCancel}>取消</Button>
          <Button variant="primary" size="sm" disabled={saving || !dirty} onClick={() => { void save() }}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function GroupPicker(props: {
  readonly groups: readonly TokenGroup[]
  readonly selected: readonly number[]
  readonly disabled: boolean
  readonly onChange: (ids: readonly number[]) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const searchAnchor = useRef<HTMLSpanElement>(null)
  const dropdown = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [composing, setComposing] = useState(false)
  const [dragging, setDragging] = useState<number>()
  const [dropIndex, setDropIndex] = useState<number>()
  const draggingRef = useRef<number>()
  const dropIndexRef = useRef<number>()
  const dropdownMaxHeight = useAnchoredMaxHeight(dropdown, 320, open)

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', dismiss)
    return () => window.removeEventListener('pointerdown', dismiss)
  }, [open])

  useEffect(() => {
    if (!open) return
    root.current
      ?.querySelector<HTMLElement>(`[data-group-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const byId = useMemo(() => new Map(props.groups.map(group => [group.id, group])), [props.groups])
  const filtered = props.groups.filter(group => {
    const needle = query.trim().toLowerCase()
    return needle === '' || `${group.name} ${group.label} ${group.description}`.toLowerCase().includes(needle)
  })

  const toggle = (id: number): void => {
    props.onChange(props.selected.includes(id)
      ? props.selected.filter(value => value !== id)
      : [...props.selected, id])
    requestAnimationFrame(() => searchAnchor.current?.querySelector('input')?.focus())
  }

  const keyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (composing) return
    if (event.key === 'Escape') {
      setOpen(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActive(index => Math.max(0, Math.min(filtered.length - 1, index + delta)))
      return
    }
    if (event.key === 'Enter' && open && filtered[active] !== undefined) {
      event.preventDefault()
      toggle(filtered[active].id)
    }
  }

  const drop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const dragged = draggingRef.current
    const nextIndex = dropIndexRef.current
    if (dragged === undefined || nextIndex === undefined) return
    const next = props.selected.filter(id => id !== dragged)
    const sourceIndex = props.selected.indexOf(dragged)
    const adjusted = sourceIndex < nextIndex ? nextIndex - 1 : nextIndex
    next.splice(Math.max(0, Math.min(next.length, adjusted)), 0, dragged)
    props.onChange(next)
    draggingRef.current = undefined
    dropIndexRef.current = undefined
    setDragging(undefined)
    setDropIndex(undefined)
  }

  const endDrag = (): void => {
    draggingRef.current = undefined
    dropIndexRef.current = undefined
    setDragging(undefined)
    setDropIndex(undefined)
  }

  return (
    <div ref={root} style={styles.picker}>
      {props.selected.length === 0 ? null : (
        <div style={styles.priority}>
          <div style={styles.priorityTitle}>当前优先级</div>
          <div
            role="list"
            aria-label="渠道分组优先级"
            onDragOver={event => event.preventDefault()}
            onDrop={drop}
          >
            {props.selected.map((id, index) => {
              const group = byId.get(id)
              return (
                <div key={id}>
                  {dropIndex === index ? <div style={styles.dropLine} /> : null}
                  <div
                    draggable={!props.disabled}
                    role="listitem"
                    aria-label={`优先级 ${index + 1}：${group?.label ?? `分组 ${id}`}`}
                    style={{ ...styles.priorityRow, ...(dragging === id ? styles.dragging : {}) }}
                    onDragStart={event => {
                      draggingRef.current = id
                      setDragging(id)
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', String(id))
                    }}
                    onDragEnd={endDrag}
                    onDragOver={event => {
                      event.preventDefault()
                      const rect = event.currentTarget.getBoundingClientRect()
                      const nextIndex = index + (event.clientY > rect.top + rect.height / 2 ? 1 : 0)
                      dropIndexRef.current = nextIndex
                      setDropIndex(nextIndex)
                    }}
                  >
                    <span style={styles.dragHandle} aria-hidden>⋮⋮</span>
                    <span style={styles.priorityNumber}>{index + 1}</span>
                    {group === undefined ? null : (
                      <span
                        aria-label={availabilityLabel(group.availability)}
                        title={availabilityLabel(group.availability)}
                        style={{ ...styles.availability, ...availabilityStyle(group.availability) }}
                      />
                    )}
                    <span style={styles.groupName}>{group?.label ?? `分组 ${id}`}</span>
                    <span style={styles.groupRatio}>{group === undefined ? '' : `${group.ratio}×`}</span>
                    <button
                      type="button"
                      aria-label={`移除 ${group?.label ?? id}`}
                      disabled={props.disabled}
                      style={styles.removeGroup}
                      onClick={() => toggle(id)}
                    >×</button>
                  </div>
                </div>
              )
            })}
            {dropIndex === props.selected.length ? <div style={styles.dropLine} /> : null}
          </div>
        </div>
      )}

      <span ref={searchAnchor} style={styles.searchAnchor}>
        <Input
          type="text"
          value={query}
          size={80}
          icon={<IconSearchOutline16 />}
          disabled={props.disabled}
          role="combobox"
          aria-expanded={open}
          aria-controls="openlux-token-groups"
          aria-activedescendant={filtered[active] === undefined ? undefined : `openlux-token-group-${filtered[active].id}`}
          placeholder="搜索并选择渠道分组"
          style={styles.fullWidth}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={event => {
            setQuery(event.target.value)
            setActive(0)
            setOpen(true)
          }}
          onKeyDown={keyDown}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
        />
      </span>

      {open ? (
        <div
          ref={dropdown}
          id="openlux-token-groups"
          role="listbox"
          aria-multiselectable
          style={{ ...styles.dropdown, maxHeight: dropdownMaxHeight }}
        >
          {filtered.length === 0 ? (
            <div style={styles.noResults}>没有匹配的渠道分组</div>
          ) : filtered.map((group, index) => {
            const checked = props.selected.includes(group.id)
            return (
              <button
                key={group.id}
                id={`openlux-token-group-${group.id}`}
                type="button"
                role="option"
                aria-selected={checked}
                data-group-index={index}
                style={{ ...styles.option, ...(active === index ? styles.optionActive : {}) }}
                onMouseEnter={() => setActive(index)}
                onMouseDown={event => event.preventDefault()}
                onClick={() => toggle(group.id)}
              >
                <span style={{ ...styles.checkbox, ...(checked ? styles.checkboxChecked : {}) }}>{checked ? '✓' : ''}</span>
                <span
                  aria-label={availabilityLabel(group.availability)}
                  title={availabilityLabel(group.availability)}
                  style={{ ...styles.availability, ...availabilityStyle(group.availability) }}
                />
                <span style={styles.optionCopy}>
                  <span style={styles.optionTitle}>{group.label}</span>
                  <span style={styles.optionDetail}>{group.description || group.name}</span>
                </span>
                <span style={styles.groupRatio}>{group.ratio}×</span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function Field(props: { readonly label: string; readonly hint?: string; readonly children: React.ReactNode }) {
  return (
    <label style={styles.field}>
      <span style={styles.fieldLabel}>{props.label}</span>
      {props.children}
      {props.hint === undefined ? null : <span style={styles.help}>{props.hint}</span>}
    </label>
  )
}

function Switch(props: {
  readonly checked: boolean
  readonly disabled: boolean
  readonly label: string
  readonly onChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={props.label}
      aria-checked={props.checked}
      disabled={props.disabled}
      style={{ ...styles.switch, ...(props.checked ? styles.switchOn : {}) }}
      onClick={() => props.onChange(!props.checked)}
    >
      <span style={{ ...styles.switchKnob, transform: props.checked ? 'translateX(16px)' : 'translateX(0)' }} />
    </button>
  )
}

function Notice(props: { readonly tone: 'neutral' | 'warn' | 'error'; readonly children: React.ReactNode }) {
  const tone = props.tone === 'error'
    ? styles.noticeError
    : props.tone === 'warn'
      ? styles.noticeWarn
      : styles.noticeNeutral
  return <div style={{ ...styles.notice, ...tone }}>{props.children}</div>
}

function Tag(props: { readonly accent?: boolean; readonly children: React.ReactNode }) {
  return <span style={{ ...styles.tag, ...(props.accent ? styles.tagAccent : {}) }}>{props.children}</span>
}

function StatusTag({ token }: { readonly token: ManagedToken }) {
  if (token.status !== 1) return <Tag>已停用</Tag>
  if (isTokenExpired(token)) return <Tag>已过期</Tag>
  return null
}

function isTokenExpired(token: ManagedToken): boolean {
  return token.expiredTime !== -1 && token.expiredTime <= Math.floor(Date.now() / 1000)
}

function routingSummary(token: ManagedToken): string {
  if (token.routingPriority === '') {
    return token.groupNames.length === 0 ? '手动分组' : `手动 · ${token.groupNames.join(' → ')}`
  }
  return ROUTES.find(route => route.id === token.routingPriority)?.label ?? '智能路由'
}

function editorInitial(token: ManagedToken | undefined, unit: TokenQuotaUnit) {
  return {
    name: token?.name ?? '',
    routing: token?.routingPriority ?? 'auto' as RoutingPriority,
    groupIds: token?.groupIds ?? [],
    unlimited: token?.unlimitedQuota ?? true,
    quota: token === undefined ? '0' : String(quotaToAmount(token.remainQuota, unit)),
    neverExpires: token === undefined || token.expiredTime === -1,
    expiry: token === undefined || token.expiredTime === -1 ? '' : toLocalDateTime(token.expiredTime),
  }
}

function quotaToAmount(quota: number, unit: TokenQuotaUnit): number {
  if (unit.tokens) return quota
  return Number(((quota / unit.perUnit) * unit.rate).toFixed(2))
}

function amountToQuota(amount: number, unit: TokenQuotaUnit): number {
  if (!Number.isFinite(amount) || amount < 0) return 0
  if (unit.tokens) return Math.round(amount)
  return Math.round((amount / unit.rate) * unit.perUnit)
}

function formatQuota(quota: number, unit: TokenQuotaUnit): string {
  if (unit.tokens) return Math.round(quota).toLocaleString('zh-CN')
  return unit.symbol + ((quota / unit.perUnit) * unit.rate).toFixed(2)
}

function toLocalDateTime(seconds: number): string {
  const date = new Date(seconds * 1000)
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return shifted.toISOString().slice(0, 16)
}

function fromLocalDateTime(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function availabilityLabel(status: TokenGroup['availability']): string {
  switch (status) {
    case 'healthy': return '运行正常'
    case 'degraded': return '部分降级'
    case 'unhealthy': return '当前不稳定'
    case 'unavailable': return '暂无可用渠道'
    default: return '状态数据不足'
  }
}

function availabilityStyle(status: TokenGroup['availability']): CSSProperties {
  switch (status) {
    case 'healthy': return { background: 'var(--dsw-alias-state-success-primary)' }
    case 'degraded': return { background: 'var(--dsw-alias-state-warn-primary)' }
    case 'unhealthy':
    case 'unavailable':
      return { background: 'var(--dsw-alias-state-error-primary)' }
    default: return { background: 'var(--dsw-alias-label-dimmed)' }
  }
}

const styles: Record<string, CSSProperties> = {
  section: { color: 'var(--dsw-alias-label-primary)', paddingBottom: 24 },
  headingRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 },
  headingActions: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' },
  title: { margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 600 },
  intro: { margin: '4px 0 0', color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: '20px' },
  count: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: '28px' },
  rows: { display: 'grid', gap: 10, marginTop: 16 },
  tokenBlock: { display: 'grid', gap: 6 },
  listLabel: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, fontWeight: 500, lineHeight: '18px' },
  card: {
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 12,
    background: 'var(--dsw-alias-bg-layer-1)',
    overflow: 'visible',
  },
  activeCard: { borderColor: 'var(--dsw-alias-state-info-primary)' },
  createCard: { marginTop: 10, padding: '14px 16px' },
  createHeading: { fontSize: 14, fontWeight: 600, marginBottom: 14 },
  cardHead: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px' },
  identity: { flex: 1, minWidth: 0 },
  nameLine: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
  tokenName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, fontWeight: 600 },
  tag: {
    display: 'inline-flex',
    flex: 'none',
    alignItems: 'center',
    minHeight: 20,
    padding: '0 7px',
    borderRadius: 999,
    background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: 11,
  },
  tagAccent: {
    background: 'color-mix(in srgb, var(--dsw-alias-state-info-primary) 14%, transparent)',
    color: 'var(--dsw-alias-state-info-primary)',
  },
  meta: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 5,
    marginTop: 4,
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: 12,
    lineHeight: '18px',
  },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' },
  actions: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 },
  editorWrap: { borderTop: '1px solid var(--dsw-alias-border-l2)', padding: '16px 16px 14px' },
  field: { display: 'grid', gap: 7, marginBottom: 16 },
  fieldLabel: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, fontWeight: 500 },
  help: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, lineHeight: '17px' },
  fullWidth: { width: '100%', boxSizing: 'border-box' },
  switchLine: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  switchControl: { display: 'flex', alignItems: 'center', gap: 8, flex: 'none' },
  switchStatus: {
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: 11,
    lineHeight: '18px',
    whiteSpace: 'nowrap',
  },
  switch: {
    position: 'relative',
    flex: '0 0 36px',
    width: 36,
    height: 20,
    boxSizing: 'border-box',
    padding: 2,
    border: 0,
    borderRadius: 999,
    background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 42%, transparent)',
    cursor: 'pointer',
    transition: 'background 120ms ease',
  },
  switchOn: { background: 'hsl(217 91% 60%)' },
  switchKnob: {
    display: 'block',
    width: 16,
    height: 16,
    borderRadius: '50%',
    background: 'white',
    transition: 'transform 120ms ease',
  },
  routeGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginTop: 4 },
  routeCard: {
    display: 'grid',
    gap: 3,
    padding: '10px 11px',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 9,
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    textAlign: 'left',
    cursor: 'pointer',
  },
  routeCardActive: {
    borderColor: 'var(--dsw-alias-state-info-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-info-primary) 8%, transparent)',
  },
  routeTitle: { fontSize: 13, fontWeight: 600 },
  routeDetail: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, lineHeight: '17px' },
  customized: {
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 10,
    background: 'var(--dsw-alias-bg-layer-1)',
    padding: '5px 8px',
    marginBottom: 16,
  },
  disclosureHint: {
    marginLeft: 'auto',
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: 11,
    lineHeight: '18px',
  },
  customizedBody: {
    borderTop: '1px solid var(--dsw-alias-border-l2)',
    marginTop: 5,
    padding: '12px 4px 0',
  },
  twoColumn: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 },
  nativeInput: {
    width: '100%',
    minHeight: 36,
    boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 8,
    background: 'var(--dsw-specific-input-major)',
    color: 'var(--dsw-alias-label-primary)',
    padding: '7px 10px',
    outline: 0,
    font: 'inherit',
    fontSize: 13,
  },
  amountInput: { position: 'relative' },
  prefix: {
    position: 'absolute',
    left: 10,
    top: '50%',
    zIndex: 1,
    transform: 'translateY(-50%)',
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: 13,
  },
  editorActions: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 4 },
  linkDanger: {
    border: 0,
    background: 'transparent',
    color: 'var(--dsw-alias-state-error-primary)',
    fontSize: 12,
    cursor: 'pointer',
  },
  dangerButton: {
    minHeight: 36,
    padding: '0 16px',
    border: 0,
    borderRadius: 999,
    background: 'var(--dsw-alias-state-error-primary)',
    color: 'white',
    fontWeight: 600,
    cursor: 'pointer',
  },
  formError: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, margin: '-6px 0 12px' },
  addButton: {
    width: '100%',
    minHeight: 42,
    marginTop: 10,
    border: '1px dashed var(--dsw-alias-border-l1)',
    borderRadius: 11,
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    cursor: 'pointer',
    fontSize: 13,
  },
  empty: {
    marginTop: 16,
    padding: 32,
    border: '1px dashed var(--dsw-alias-border-l1)',
    borderRadius: 12,
    color: 'var(--dsw-alias-label-tertiary)',
    textAlign: 'center',
    fontSize: 13,
  },
  notice: { marginTop: 12, padding: '9px 11px', borderRadius: 8, fontSize: 12, lineHeight: '18px' },
  noticeNeutral: {
    background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-secondary)',
  },
  noticeWarn: {
    background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent)',
    color: 'var(--dsw-alias-state-warn-primary)',
  },
  noticeError: {
    background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)',
    color: 'var(--dsw-alias-state-error-primary)',
  },
  unsaved: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 14,
    padding: 10,
    borderRadius: 8,
    background: 'var(--dsw-alias-interactive-bg-hover)',
  },
  unsavedTitle: { display: 'block', fontSize: 12 },
  unsavedText: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, marginTop: 2 },
  picker: { position: 'relative' },
  priority: {
    marginBottom: 8,
    padding: '8px 9px',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 9,
    background: 'var(--dsw-alias-bg-layer-2)',
  },
  priorityTitle: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, marginBottom: 5 },
  priorityRow: { display: 'flex', alignItems: 'center', gap: 7, minHeight: 32, borderRadius: 6, padding: '0 4px' },
  dragHandle: { color: 'var(--dsw-alias-label-tertiary)', cursor: 'grab', letterSpacing: -2 },
  dragging: { opacity: 0.45 },
  priorityNumber: {
    display: 'inline-grid',
    placeItems: 'center',
    width: 18,
    height: 18,
    borderRadius: 5,
    background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: 10,
  },
  groupName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 },
  groupRatio: { flex: 'none', color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 },
  availability: {
    flex: '0 0 7px',
    width: 7,
    height: 7,
    borderRadius: '50%',
  },
  removeGroup: {
    width: 24,
    height: 24,
    border: 0,
    background: 'transparent',
    color: 'var(--dsw-alias-label-tertiary)',
    cursor: 'pointer',
    fontSize: 17,
  },
  dropLine: { height: 2, margin: '0 4px', borderRadius: 2, background: 'var(--dsw-alias-state-info-primary)' },
  searchAnchor: { display: 'block', width: '100%', overflow: 'hidden' },
  searchWrap: { position: 'relative' },
  searchIcon: {
    position: 'absolute',
    left: 10,
    top: '50%',
    zIndex: 1,
    transform: 'translateY(-50%)',
    color: 'var(--dsw-alias-label-tertiary)',
    pointerEvents: 'none',
  },
  dropdown: {
    position: 'absolute',
    zIndex: 20,
    bottom: 'calc(100% + 4px)',
    left: 0,
    width: '100%',
    maxHeight: 238,
    overflowY: 'auto',
    boxSizing: 'border-box',
    padding: 5,
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 10,
    background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2))',
    boxShadow: '0 12px 28px rgba(0,0,0,.18)',
  },
  option: {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    gap: 8,
    padding: '8px 9px',
    border: 0,
    borderRadius: 7,
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    textAlign: 'left',
    cursor: 'pointer',
  },
  optionActive: { background: 'var(--dsw-alias-interactive-bg-hover)' },
  checkbox: {
    display: 'inline-grid',
    flex: '0 0 16px',
    placeItems: 'center',
    width: 16,
    height: 16,
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 4,
    color: 'white',
    fontSize: 10,
  },
  checkboxChecked: {
    borderColor: 'var(--dsw-alias-state-info-primary)',
    background: 'var(--dsw-alias-state-info-primary)',
  },
  optionCopy: { display: 'grid', flex: 1, minWidth: 0, gap: 2 },
  optionTitle: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 500 },
  optionDetail: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 },
  noResults: { padding: 18, color: 'var(--dsw-alias-label-tertiary)', textAlign: 'center', fontSize: 12 },
}
