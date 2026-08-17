import { useEffect, useRef, useState } from 'react'
import {
  X,
  Plus,
  Trash2,
  Pencil,
  Sparkles,
  Image as ImageIcon,
  Wrench,
  Eye,
  EyeOff,
  ChevronDown,
  Search,
  Check,
  AudioLines,
  Video
} from 'lucide-react'
import {
  PROVIDER_PRESETS,
  THINKING_LEVELS,
  THINKING_LABELS,
  type ChatThinking,
  type MediaSelection,
  type ModelInfo,
  type ProviderConfig,
  type ProviderModel,
  type ProviderPreset,
  type ProviderPresetId
} from '@shared/types'
import LoadingLottie from '../../components/LoadingLottie'
import FloatingMask from '../../components/FloatingMask'
import ModelPicker from '../../components/ModelPicker'
import MediaPicker from '../../components/MediaPicker'

interface Props {
  /** 模型配置发生变更并成功落盘后回调(父级据此刷新可选模型)。 */
  onChanged?: () => void
}

/**
 * 媒体三档在小节里的回显顺序与「不选的后果」。
 *
 * 后果要写出来:这三档都是「不选就不上架对应工具」(内核对 `imageGenerationModel` /
 * `videoGenerationModel` 是没配就不注册),用户看不到这句话时会以为空白只是没显示。
 */
const MEDIA_ROWS: {
  id: string
  label: string
  icon: typeof ImageIcon
  off: string
  pick: (m: MediaSelection) => string[]
}[] = [
  {
    id: 'image',
    label: '出图',
    icon: ImageIcon,
    off: '专家没有 image_generate 工具',
    pick: (m) => m.image
  },
  {
    id: 'video',
    label: '视频',
    icon: Video,
    off: '专家没有 video_generate 工具',
    pick: (m) => m.video
  },
  {
    id: 'audio',
    label: '语音',
    icon: AudioLines,
    off: '朗读功能不可用',
    pick: (m) => (m.audio ? [m.audio] : [])
  }
]

/** 输入/输出 Token 快捷档位(对齐 WorkBuddy)。 */
const INPUT_TOKEN_PRESETS = [32000, 64000, 128000, 256000]
const OUTPUT_TOKEN_PRESETS = [8000, 16000, 32000, 64000]
function tokenLabel(n: number): string {
  return `${Math.round(n / 1000)}K`
}

/** 提供商下拉的分组(对齐 WorkBuddy 的分组式选择器)。 */
const PROVIDER_GROUPS: { title: string; ids: ProviderPresetId[] }[] = [
  { title: '云雾', ids: ['yunwu'] },
  { title: '自定义 API', ids: ['openai', 'deepseek', 'anthropic', 'gemini', 'openrouter'] },
  { title: '本地', ids: ['ollama'] },
  { title: '其他', ids: ['custom'] }
]

/** 提供商头像底色(用首字母色块代替品牌 logo,零素材依赖)。 */
const PROVIDER_COLORS: Record<string, string> = {
  yunwu: '#2b6cff',
  openai: '#10a37f',
  deepseek: '#4d6bfe',
  anthropic: '#d97757',
  gemini: '#1a73e8',
  openrouter: '#6b7280',
  ollama: '#111827',
  custom: '#8b5cf6'
}

/**
 * 一条自定义模型(对齐 WorkBuddy:每个模型自带接口地址 + 独立 API Key + 能力)。
 * 落盘时映射为一个"单模型供货商"(OpenClaw 的 key 按 provider 存,故每模型独立成 provider),
 * 由此天然支持"同账号不同模型用不同 key"。
 */
interface CustomEntry {
  /** 稳定的 openclaw provider id(保持编辑前后不变,避免选中模型键漂移)。 */
  provId: string
  preset: ProviderPresetId
  api: string
  baseUrl: string
  apiKey: string
  model: ProviderModel
}

function presetById(id: ProviderPresetId): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id)
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'model'
}

/** 生成不与现有集合冲突的 provider id。 */
function uniqueId(base: string, taken: Set<string>): string {
  let id = `cm-${base}`
  let n = 2
  while (taken.has(id)) {
    id = `cm-${base}-${n++}`
  }
  return id
}

function emptyEntry(): CustomEntry {
  // 默认云雾:最常见诉求是"同一云雾账号、不同模型用不同 key",预填 yunwu 接口地址。
  const preset = PROVIDER_PRESETS.find((p) => p.id === 'yunwu') ?? PROVIDER_PRESETS[1]
  return {
    provId: '',
    preset: preset.id,
    api: preset.api,
    baseUrl: preset.baseUrl,
    apiKey: '',
    model: {
      id: '',
      reasoning: false,
      vision: false,
      tools: true,
      category: 'chat',
      canDisableThinking: true
    }
  }
}

/** 把一条自定义模型条目转换为 openclaw provider(每模型独立供货商)。 */
function entryToProvider(e: CustomEntry): ProviderConfig {
  return {
    id: e.provId,
    label: e.model.name || e.model.id,
    preset: e.preset,
    api: e.api,
    baseUrl: e.baseUrl,
    apiKey: e.apiKey,
    models: [e.model]
  }
}

/**
 * 设置 → 模型页(作为设置外壳内的一页):
 *  - 顶部:「云雾账号」模型组,用户从**自己 key 真能调的**清单里选,与首次登录那一步同一个
 *    选择器组件(`ModelPicker`)。这里刻意不跟 WorkBuddy 的只读「官方模型」——它那份是腾讯
 *    自家掏钱的,我们这份花的是用户自己的余额,凭什么由我们钦定(见 shared/public-models.ts);
 *  - 下方:自定义模型列表,每条自带接口地址 / 独立 API Key / 模型 ID / 能力,支持增删改;
 *  - 增/删/改即时落盘到 providers.json(单一数据源)→ 声明式渲染进 openclaw.json 热加载。
 */
export default function ModelsPage({ onChanged }: Props) {
  const [builtin, setBuiltin] = useState<ProviderConfig | null>(null)
  const [custom, setCustom] = useState<CustomEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  /** 正在删除的那条自定义模型的 provId(空串表示没有);用于把等待状态落到具体那一行。 */
  const [pendingId, setPendingId] = useState('')
  const [error, setError] = useState('')
  // 编辑弹窗:draft 非空时打开;editingId 为被编辑条目的 provId(新增为 null)。
  const [draft, setDraft] = useState<CustomEntry | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  /** 待确认删除的条目(非空时弹确认框);删除不可撤销,对齐 WorkBuddy 先问再删。 */
  const [deleteTarget, setDeleteTarget] = useState<CustomEntry | null>(null)
  /** 打开云雾账号模型选择器(与首次登录那一步是同一个组件)。 */
  const [picking, setPicking] = useState(false)
  /** 打开媒体模型选择器;media 是此刻生效的三档,用来在小节里回显。 */
  const [pickingMedia, setPickingMedia] = useState(false)
  const [media, setMedia] = useState<MediaSelection | null>(null)

  useEffect(() => {
    void (async () => {
      // 媒体三档是本地读,跟供货商一起取;拉可选池要打网络,等用户真点开选择器再说。
      const cat = await window.api.modelCatalog()
      if (cat.ok && cat.data) {
        setMedia(cat.data.media)
      }
      const res = await window.api.listProviders()
      if (res.ok && res.data) {
        const bi = res.data.find((p) => p.builtin) ?? null
        setBuiltin(bi)
        // 非内置供货商展开为「每模型一条」(兼容旧的多模型供货商)。
        const entries: CustomEntry[] = []
        for (const p of res.data.filter((x) => !x.builtin)) {
          p.models.forEach((m, i) => {
            entries.push({
              provId: p.models.length === 1 ? p.id : `${p.id}-${slug(m.id)}-${i}`,
              preset: p.preset,
              api: p.api,
              baseUrl: p.baseUrl,
              apiKey: p.apiKey,
              model: { canDisableThinking: true, ...m }
            })
          })
        }
        setCustom(entries)
      }
      setLoading(false)
    })()
  }, [])

  // 保存/删除写完 providers.json 就返回了,下发内核在后台跑;失败经此通道补报。
  useEffect(() => window.api.onConfigSyncError((msg) => setError(`已保存,但内核未生效:${msg}`)), [])

  /**
   * 即时落盘单条自定义模型(对齐 WorkBuddy 的即时保存,无需全局保存按钮)。
   *
   * 按 id 单条 upsert,而不是把整张表覆盖写回:后者会让"改一个模型"重写**所有**模型的 Key,
   * 页面内存里任何一条状态不对都会连累其它条目(实测出现过 A 的 Key 被写成 B 的)。
   */
  async function saveEntry(entry: CustomEntry): Promise<void> {
    setError('')
    setSaving(true)
    try {
      const res = await window.api.upsertProvider(entryToProvider(entry))
      if (!res.ok) {
        setError(res.error ?? '保存失败')
        return
      }
      onChanged?.()
    } finally {
      setSaving(false)
    }
  }

  /**
   * 保存云雾账号的对话模型清单。
   *
   * 只重读内置那一条 —— 自定义模型这次没动,整份重读会把用户正在编辑的状态一起冲掉。
   */
  async function saveAccountModels(models: ModelInfo[]): Promise<void> {
    setError('')
    setSaving(true)
    try {
      const res = await window.api.selectModels(models)
      if (!res.ok) {
        setError(res.error ?? '保存失败')
        return
      }
      const list = await window.api.listProviders()
      if (list.ok && list.data) {
        setBuiltin(list.data.find((p) => p.builtin) ?? null)
      }
      setPicking(false)
      onChanged?.()
    } finally {
      setSaving(false)
    }
  }

  /**
   * 保存媒体模型三档。
   *
   * 与对话模型分开一个通道:这三档不落在 `models.providers` 里(出图与视频走
   * `yunwu-video` 插件自己的清单,语音走 `messages.tts`),所以保存完不必重读供货商。
   */
  async function saveMediaModels(selection: MediaSelection): Promise<void> {
    setError('')
    setSaving(true)
    try {
      const res = await window.api.selectMediaModels(selection)
      if (!res.ok || !res.data) {
        setError(res.error ?? '保存失败')
        return
      }
      setMedia(res.data)
      setPickingMedia(false)
      onChanged?.()
    } finally {
      setSaving(false)
    }
  }

  function openAdd(): void {
    setEditingId(null)
    setDraft(emptyEntry())
  }

  function openEdit(e: CustomEntry): void {
    setEditingId(e.provId)
    setDraft({ ...e, model: { ...e.model } })
  }

  /**
   * 删除单条(走 providers:delete,同样只动这一条)。
   *
   * 记住正在删的是哪一条:这次写入要经内核落配置,网关刚启动尚未连上时会退回 CLI 子进程,
   * 实测能到 9 秒。只在小节标题旁转个圈的话,用户看着那一行毫无变化,会以为点了没反应
   * (且按钮还能接着点,连点就是并发写同一份配置)。
   */
  async function removeEntry(provId: string): Promise<void> {
    if (saving) {
      return
    }
    setError('')
    setSaving(true)
    setPendingId(provId)
    try {
      const res = await window.api.deleteProvider(provId)
      if (!res.ok) {
        setError(res.error ?? '删除失败')
        return
      }
      setCustom(custom.filter((e) => e.provId !== provId))
      onChanged?.()
    } finally {
      setSaving(false)
      setPendingId('')
    }
  }

  function commitDraft(): void {
    if (!draft) {
      return
    }
    const taken = new Set(custom.map((e) => e.provId).filter((id) => id !== editingId))
    if (builtin) {
      taken.add(builtin.id)
    }
    const finalized: CustomEntry = {
      ...draft,
      provId: editingId ?? uniqueId(slug(draft.model.id), taken),
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim(),
      model: {
        ...draft.model,
        id: draft.model.id.trim(),
        name: draft.model.name?.trim() || undefined
      }
    }
    const next = editingId
      ? custom.map((e) => (e.provId === editingId ? finalized : e))
      : [...custom, finalized]
    setCustom(next)
    void saveEntry(finalized)
    setDraft(null)
    setEditingId(null)
  }

  const builtinChat = builtin?.models.filter((m) => m.category === 'chat') ?? []

  if (loading) {
    return (
      <div className="settings-loading">
        <LoadingLottie size="sm" label="正在加载" />
        正在加载…
      </div>
    )
  }

  return (
    <>
      {error && <div className="settings-error settings-error-banner">{error}</div>}

      {/* 云雾账号模型组:用户自己从账号可用清单里选,不是我们下发的 */}
      {builtin && (
        <section className="cm-section">
          <div className="cm-section-head">
            <span>云雾账号模型</span>
            <span className="cm-muted">
              消耗账号余额 · {builtinChat.length} 个对话模型 · 第一个是默认模型
            </span>
            <button className="btn-primary sm cm-add" disabled={saving} onClick={() => setPicking(true)}>
              <Plus size={13} strokeWidth={2} />
              选择模型
            </button>
          </div>
          <div className="cm-builtin-chips">
            {builtinChat.map((m) => (
              <span key={m.id} className="cm-chip">
                {m.id}
                {m.reasoning && <Sparkles size={11} strokeWidth={2} className="cap-ico think" />}
                {m.vision && <ImageIcon size={11} strokeWidth={2} className="cap-ico" />}
              </span>
            ))}
          </div>
        </section>
      )}

      {/*
        媒体模型:出图 / 视频 / 语音三档单独一节,不混进上面的对话清单。
        两者的可选池判据不同(对话看 tags,媒体看 supported_endpoint_types)、落配置的路径也不同,
        混在一个列表里用户会以为随手勾一个视频模型就能拿去对话。
      */}
      {builtin && (
        <section className="cm-section">
          <div className="cm-section-head">
            <span>媒体模型</span>
            <span className="cm-muted">出图 / 视频 / 语音,决定专家手上有没有这三样工具</span>
            <button
              className="btn-primary sm cm-add"
              disabled={saving}
              onClick={() => setPickingMedia(true)}
            >
              <Plus size={13} strokeWidth={2} />
              选择模型
            </button>
          </div>
          <div className="cm-media-rows">
            {MEDIA_ROWS.map((r) => {
              const ids = media ? r.pick(media) : []
              return (
                <div className="cm-media-row" key={r.id}>
                  <span className="cm-media-label">
                    <r.icon size={13} strokeWidth={1.9} />
                    {r.label}
                  </span>
                  {ids.length === 0 ? (
                    <span className="cm-muted">未选择 · {r.off}</span>
                  ) : (
                    <span className="cm-builtin-chips">
                      {ids.map((id, i) => (
                        <span key={id} className="cm-chip" title={i === 0 ? `${id}（主用）` : id}>
                          {id}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* 自定义模型 */}
      <section className="cm-section">
        <div className="cm-section-head">
          <span>自定义模型</span>
          <span className="cm-muted">每个模型可单独填写接口地址与 API Key</span>
          {/* 删除时等待状态已落在具体那一行,这里只管新增/编辑保存(它们没有对应的行)。 */}
          {saving && !pendingId && <LoadingLottie size="xs" className="cm-saving" />}
          <button className="btn-primary sm cm-add" disabled={saving} onClick={openAdd}>
            <Plus size={13} strokeWidth={2} />
            添加模型
          </button>
        </div>

        {custom.length === 0 ? (
          <div className="cm-empty">
            还没有自定义模型。点击「添加模型」,为每个模型填写各自的接口地址与 API Key
            (同一云雾账号也可为不同模型使用不同的 key)。
          </div>
        ) : (
          <div className="cm-list">
            {custom.map((e) => (
              <div key={e.provId} className="cm-item">
                <div className="cm-item-main">
                  <div className="cm-item-title">
                    {e.model.name || e.model.id}
                    {e.model.reasoning && (
                      <Sparkles size={12} strokeWidth={2} className="cap-ico think" />
                    )}
                    {e.model.vision && <ImageIcon size={12} strokeWidth={2} className="cap-ico" />}
                    {e.model.tools && <Wrench size={12} strokeWidth={2} className="cap-ico" />}
                  </div>
                  <div className="cm-item-sub">
                    {presetById(e.preset)?.label ?? e.preset} · {e.baseUrl || '未填接口地址'} ·{' '}
                    {e.apiKey ? 'Key 已设置' : '无 Key'}
                  </div>
                </div>
                {pendingId === e.provId ? (
                  <LoadingLottie size="xs" className="cm-item-pending" label="正在删除" />
                ) : (
                  <>
                    <button
                      className="icon-btn"
                      title="编辑"
                      disabled={saving}
                      onClick={() => openEdit(e)}
                    >
                      <Pencil size={14} strokeWidth={1.8} />
                    </button>
                    <button
                      className="icon-btn"
                      title="删除"
                      disabled={saving}
                      onClick={() => setDeleteTarget(e)}
                    >
                      <Trash2 size={14} strokeWidth={1.8} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {picking && (
        <ModelPicker
          initial={builtinChat}
          title="云雾账号模型"
          hint="这些模型消耗你自己云雾账号的余额,清单的第一条会作为默认模型(拖动已选标签可换)"
          confirmText="保存"
          dismissible
          onCancel={() => setPicking(false)}
          onConfirm={saveAccountModels}
        />
      )}

      {pickingMedia && (
        <MediaPicker
          title="媒体模型"
          hint="出图、出视频、朗读各自用哪些模型。同样消耗你自己云雾账号的余额,一档都不选就等于关掉那个能力。"
          confirmText="保存"
          dismissible
          onCancel={() => setPickingMedia(false)}
          onConfirm={saveMediaModels}
        />
      )}

      {draft && (
        <ModelEditor
          draft={draft}
          isNew={!editingId}
          onChange={setDraft}
          onCancel={() => {
            setDraft(null)
            setEditingId(null)
          }}
          onConfirm={commitDraft}
        />
      )}

      {deleteTarget && (
        <FloatingMask className="modal-mask" onClick={() => setDeleteTarget(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            onClick={(ev) => ev.stopPropagation()}
          >
            <h3 className="modal-title">删除模型</h3>
            <p className="modal-text">
              确认删除模型 {deleteTarget.model.name || deleteTarget.model.id} 吗?
            </p>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setDeleteTarget(null)}>
                取消
              </button>
              <button
                className="btn-danger"
                onClick={() => {
                  const target = deleteTarget
                  setDeleteTarget(null)
                  void removeEntry(target.provId)
                }}
              >
                删除
              </button>
            </div>
          </div>
        </FloatingMask>
      )}
    </>
  )
}

interface EditorProps {
  draft: CustomEntry
  isNew: boolean
  onChange: (next: CustomEntry) => void
  onCancel: () => void
  onConfirm: () => void
}

/** 添加/编辑单个自定义模型的弹窗(对齐 WorkBuddy:提供商 / 接口 / Key / 模型名 / 高级配置)。 */
function ModelEditor({ draft, isNew, onChange, onCancel, onConfirm }: EditorProps) {
  const [showKey, setShowKey] = useState(false)
  const [err, setErr] = useState('')
  const preset = presetById(draft.preset)
  const needsKey = preset?.needsKey !== false
  // 自定义模型的提供商可选云雾(同账号不同 key)+ 各第三方。
  const addable = PROVIDER_PRESETS.filter((p) => p.addable || p.id === 'yunwu')

  function patch(p: Partial<CustomEntry>): void {
    onChange({ ...draft, ...p })
  }
  function patchModel(p: Partial<ProviderModel>): void {
    onChange({ ...draft, model: { ...draft.model, ...p } })
  }
  function onPresetChange(id: ProviderPresetId): void {
    const pr = presetById(id)
    onChange({
      ...draft,
      preset: id,
      api: pr?.api ?? draft.api,
      // 换供货商时用其默认地址覆盖(自定义预设为空,保留用户已填)。
      baseUrl: pr && pr.baseUrl ? pr.baseUrl : draft.baseUrl
    })
  }

  function confirm(): void {
    if (!draft.model.id.trim()) {
      setErr('请输入模型名称')
      return
    }
    if (!draft.baseUrl.trim()) {
      setErr('请输入接口地址')
      return
    }
    if (needsKey && !draft.apiKey.trim()) {
      setErr('请输入 API Key')
      return
    }
    if (/[\s\u3000]/.test(draft.apiKey)) {
      setErr('API Key 不能包含空格/换行/全角字符')
      return
    }
    setErr('')
    onConfirm()
  }

  return (
    <FloatingMask className="cm-modal-mask" onClick={onCancel}>
      <div className="cm-modal" onClick={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <span className="settings-title">{isNew ? '添加模型' : '编辑模型'}</span>
          <span className="cm-notice-inline">仅支持 OpenAI 兼容协议 API</span>
          <button className="icon-btn cm-modal-x" title="关闭" onClick={onCancel}>
            <X size={16} strokeWidth={1.8} />
          </button>
        </header>

        <div className="cm-modal-body">
          <div className="field">
            <span>提供商</span>
            <ProviderSelect value={draft.preset} options={addable} onChange={onPresetChange} />
          </div>

          <label className="field">
            <span>接口地址</span>
            <input
              type="text"
              value={draft.baseUrl}
              placeholder="https://yunwu.ai/v1"
              onChange={(e) => patch({ baseUrl: e.target.value })}
            />
          </label>

          <label className="field">
            <span>API Key</span>
            <div className="cm-key-row">
              <input
                type={showKey ? 'text' : 'password'}
                value={draft.apiKey}
                placeholder={needsKey ? '输入你的 API Key' : '本地部署无需 API Key'}
                onChange={(e) => patch({ apiKey: e.target.value })}
              />
              <button className="icon-btn" title={showKey ? '隐藏' : '显示'} onClick={() => setShowKey((v) => !v)}>
                {showKey ? <EyeOff size={15} strokeWidth={1.8} /> : <Eye size={15} strokeWidth={1.8} />}
              </button>
            </div>
          </label>

          <label className="field">
            <span>模型名称</span>
            <input
              type="text"
              value={draft.model.id}
              placeholder="模型参数值,如 gpt-4o 或 openai/gpt-4o"
              onChange={(e) => patchModel({ id: e.target.value })}
            />
          </label>

          <div className="cm-adv-head">高级配置</div>

          <div className="cm-checks">
            <label className="cm-check">
              <input
                type="checkbox"
                checked={draft.model.tools}
                onChange={(e) => patchModel({ tools: e.target.checked })}
              />
              <Wrench size={13} strokeWidth={1.8} /> 工具调用
            </label>
            <label className="cm-check">
              <input
                type="checkbox"
                checked={draft.model.vision}
                onChange={(e) => patchModel({ vision: e.target.checked })}
              />
              <ImageIcon size={13} strokeWidth={1.8} /> 图片输入
            </label>
            <label className="cm-check">
              <input
                type="checkbox"
                checked={draft.model.reasoning}
                onChange={(e) => patchModel({ reasoning: e.target.checked })}
              />
              <Sparkles size={13} strokeWidth={1.8} /> 思考模式
            </label>
          </div>
          {draft.model.reasoning && (
            <>
              <div className="cm-checks cm-checks-sub">
                <label className="cm-check">
                  <input
                    type="checkbox"
                    checked={draft.model.canDisableThinking !== false}
                    onChange={(e) => patchModel({ canDisableThinking: e.target.checked })}
                  />
                  允许关闭思考
                </label>
                <label className="cm-check">
                  <input
                    type="checkbox"
                    checked={!!draft.model.onlyReasoning}
                    onChange={(e) => patchModel({ onlyReasoning: e.target.checked })}
                  />
                  仅思考模式
                </label>
              </div>
              <p className="cm-adv-hint">
                默认只按思考开关运行;若该模型支持强度调节,请在「支持的思考强度」中勾选可用档位。
              </p>
              <label className="field">
                <span>默认思考强度</span>
                <select
                  className="model-cat"
                  value={draft.model.defaultThinkingLevel ?? ''}
                  onChange={(e) =>
                    patchModel({
                      defaultThinkingLevel: e.target.value
                        ? (e.target.value as Exclude<ChatThinking, 'off'>)
                        : undefined
                    })
                  }
                >
                  <option value="">自动(使用请求层默认值)</option>
                  {THINKING_LEVELS.map((lv) => (
                    <option key={lv} value={lv}>
                      {THINKING_LABELS[lv]}
                    </option>
                  ))}
                </select>
              </label>
              <div className="field">
                <span>支持的思考强度</span>
                <div className="cm-checks">
                  {THINKING_LEVELS.map((lv) => {
                    const on = (draft.model.thinkingLevels ?? []).includes(lv)
                    return (
                      <label key={lv} className="cm-check">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => {
                            const cur = new Set(draft.model.thinkingLevels ?? [])
                            if (e.target.checked) {
                              cur.add(lv)
                            } else {
                              cur.delete(lv)
                            }
                            const next = THINKING_LEVELS.filter((x) => cur.has(x))
                            patchModel({ thinkingLevels: next.length ? next : undefined })
                          }}
                        />
                        {THINKING_LABELS[lv]}
                      </label>
                    )
                  })}
                </div>
              </div>
            </>
          )}

          <div className="cm-tokens">
            <TokenField
              label="输入"
              value={draft.model.contextWindow}
              presets={INPUT_TOKEN_PRESETS}
              onChange={(v) => patchModel({ contextWindow: v })}
            />
            <TokenField
              label="输出"
              value={draft.model.maxTokens}
              presets={OUTPUT_TOKEN_PRESETS}
              onChange={(v) => patchModel({ maxTokens: v })}
            />
          </div>

          {err && <div className="settings-error">{err}</div>}
        </div>

        <footer className="settings-foot">
          <button className="btn-ghost" onClick={onCancel}>
            取消
          </button>
          <button className="btn-primary" onClick={confirm}>
            {isNew ? '添加' : '保存'}
          </button>
        </footer>
      </div>
    </FloatingMask>
  )
}

interface TokenFieldProps {
  label: string
  value?: number
  presets: number[]
  onChange: (v: number | undefined) => void
}

/** Token 数值输入 + 快捷档位(留空用提供商默认值)。 */
function TokenField({ label, value, presets, onChange }: TokenFieldProps) {
  const numOrUndef = (v: string): number | undefined => {
    const n = parseInt(v, 10)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  return (
    <div className="cm-token">
      <span className="cm-token-label">{label}</span>
      <input
        type="number"
        value={value ?? ''}
        placeholder="使用提供商默认值"
        onChange={(e) => onChange(numOrUndef(e.target.value))}
      />
      <div className="cm-token-chips">
        {presets.map((n) => (
          <button
            key={n}
            className={`cm-token-chip${value === n ? ' on' : ''}`}
            onClick={() => onChange(value === n ? undefined : n)}
          >
            {tokenLabel(n)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 提供商首字母色块头像(代替品牌 logo)。 */
function ProviderAvatar({ id, label }: { id: string; label: string }): React.JSX.Element {
  return (
    <span className="cm-prov-ava" style={{ background: PROVIDER_COLORS[id] ?? '#6b7280' }}>
      {label.slice(0, 1)}
    </span>
  )
}

interface ProviderSelectProps {
  value: ProviderPresetId
  options: ProviderPreset[]
  onChange: (id: ProviderPresetId) => void
}

/** 提供商选择器(对齐 WorkBuddy:头像 + 搜索 + 分组下拉)。 */
function ProviderSelect({ value, options, onChange }: ProviderSelectProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const selected = options.find((o) => o.id === value)
  const available = new Set(options.map((o) => o.id))
  const q = query.trim().toLowerCase()

  // 分组 → 过滤(仅保留可用且命中搜索的项),空组不显示。
  const groups = PROVIDER_GROUPS.map((g) => ({
    title: g.title,
    items: g.ids
      .filter((id) => available.has(id))
      .map((id) => options.find((o) => o.id === id)!)
      .filter((p) => !q || p.label.toLowerCase().includes(q) || p.id.includes(q))
  })).filter((g) => g.items.length > 0)

  function pick(id: ProviderPresetId): void {
    onChange(id)
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="cm-prov">
      <button className="cm-prov-trigger" onClick={() => setOpen((v) => !v)}>
        {selected && <ProviderAvatar id={selected.id} label={selected.label} />}
        <span className="cm-prov-label">{selected?.label ?? '选择提供商'}</span>
        <ChevronDown size={16} strokeWidth={2} className="cm-prov-caret" />
      </button>

      {open && (
        <>
          <FloatingMask className="cm-prov-mask" onClick={() => setOpen(false)} />
          <div className="cm-prov-panel">
            <div className="cm-prov-search">
              <Search size={14} strokeWidth={2} />
              <input
                ref={inputRef}
                autoFocus
                value={query}
                placeholder="提供商"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="cm-prov-list">
              {groups.length === 0 && <div className="cm-prov-empty">无匹配提供商</div>}
              {groups.map((g) => (
                <div key={g.title} className="cm-prov-group">
                  <div className="cm-prov-group-title">{g.title}</div>
                  {g.items.map((p) => (
                    <button
                      key={p.id}
                      className={`cm-prov-opt${p.id === value ? ' on' : ''}`}
                      onClick={() => pick(p.id)}
                    >
                      <ProviderAvatar id={p.id} label={p.label} />
                      <span className="cm-prov-opt-label">{p.label}</span>
                      {p.id === value && <Check size={14} strokeWidth={2.4} className="cm-prov-check" />}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
