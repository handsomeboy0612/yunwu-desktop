import { useState, type DragEvent as ReactDragEvent } from 'react'
import {
  Palette,
  CircleHelp,
  ListChecks,
  Puzzle,
  GraduationCap,
  Cable,
  Paperclip,
  Cpu,
  Sparkles,
  ShieldCheck,
  Shield,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Plus,
  X,
  Mic,
  ArrowUp,
  Square,
  FileText,
  Check,
  FolderOpen,
  type LucideIcon
} from 'lucide-react'
import type { PermissionMode, ChatMode, ChatModelOption } from '@shared/types'

interface Props {
  permission: PermissionMode
  onPermissionChange: (mode: PermissionMode) => void
  /** 当前对话行为模式(Craft/Ask/Plan)。 */
  mode: ChatMode
  onModeChange: (mode: ChatMode) => void
  onSend: (text: string, files: string[]) => void
  /** 当前是否有正在运行的任务(决定发送键是否切换为终止键)。 */
  running?: boolean
  /** 终止当前任务运行。 */
  onAbort?: () => void
  /** 可选对话模型(来自模型管理配置,内核完整键 `<provider>/<model>`)。 */
  models?: ChatModelOption[]
  /** 当前选中的模型键 `<provider>/<model>`。 */
  model: string
  onModelChange: (model: string) => void
  /** 打开模型管理设置页。 */
  onOpenModelSettings?: () => void
  /** Max 模式:开=本轮把思考强度拉到最高档(max);关=按模型默认强度(Auto)。 */
  maxMode: boolean
  onMaxModeChange: (on: boolean) => void
}

/** 对话模式清单:图标 + 名称 + 说明,用于「+」菜单的模式子面板。 */
const MODES: { id: ChatMode; label: string; desc: string; icon: LucideIcon }[] = [
  { id: 'craft', label: 'Craft', desc: '完整执行:可读写文件、运行命令', icon: Palette },
  { id: 'ask', label: 'Ask', desc: '仅问答:只读分析,不改动文件', icon: CircleHelp },
  { id: 'plan', label: 'Plan', desc: '先规划:先出方案,确认后执行', icon: ListChecks }
]

/** 占位技能清单(接通网关后替换为真实技能注册表)。 */
const SKILLS = [
  { id: 'pptx', label: '生成 PPT' },
  { id: 'docx', label: '编辑 Word' },
  { id: 'xlsx', label: '处理表格' },
  { id: 'image', label: '图片处理' }
]

/** 「+」菜单的当前视图:根 / 模式子面板 / 技能子面板。 */
type AddView = 'root' | 'mode' | 'skills'

/**
 * 富输入框(对齐 WorkBuddy 新版 composer 布局):
 *  - 左下:单个「+」按钮 → 菜单(添加文件 / 模式 / 技能 / 专家 / 连接器);
 *  - 右下:模型选择(Auto) + 语音 + 圆形发送键;
 *  - 卡片下方 subbar:选择工作空间 / 权限;
 *  - 回车发送,Shift+回车换行。
 */
export default function Composer({
  permission,
  onPermissionChange,
  mode,
  onModeChange,
  onSend,
  running = false,
  onAbort,
  models = [],
  model,
  onModelChange,
  onOpenModelSettings,
  maxMode,
  onMaxModeChange
}: Props) {
  const activeModel = models.find((m) => m.key === model)
  const modelLabel = activeModel?.label ?? (model ? model.split('/').pop() : '选择模型')
  // 推理模型默认按其"默认思考强度"思考(Auto);快捷区只提供 Max 一键拉满,不铺细档位。
  const modelIsReasoning = activeModel?.reasoning ?? false
  const [text, setText] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [addView, setAddView] = useState<AddView>('root')
  const [modelOpen, setModelOpen] = useState(false)
  const [wsOpen, setWsOpen] = useState(false)
  const [permOpen, setPermOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const activeMode = MODES.find((m) => m.id === mode) ?? MODES[0]
  const ActiveModeIcon = activeMode.icon

  function submit(): void {
    if (running) return
    const t = text.trim()
    if (!t && files.length === 0) return
    onSend(t, files)
    setText('')
    setFiles([])
  }

  /** 关闭「+」菜单并复位到根视图。 */
  function closeAdd(): void {
    setAddOpen(false)
    setAddView('root')
  }

  /** 合并追加文件路径(去重、过滤空值),供"+"选择与拖拽共用。 */
  function addFiles(paths: string[]): void {
    const valid = paths.filter((p) => p)
    if (!valid.length) return
    setFiles((prev) => Array.from(new Set([...prev, ...valid])))
  }

  async function pickFiles(): Promise<void> {
    const res = await window.api.pickFiles()
    if (res.ok && res.data && res.data.length) {
      addFiles(res.data)
    }
  }

  /** 拖拽悬停:阻止默认(允许放置)并高亮落区。 */
  function handleDragOver(e: ReactDragEvent): void {
    if (Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      if (!dragOver) setDragOver(true)
    }
  }

  /** 离开落区时取消高亮(仅当真正移出容器,避免子元素间抖动)。 */
  function handleDragLeave(e: ReactDragEvent): void {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDragOver(false)
    }
  }

  /** 放置:经 webUtils 取每个文件的本地绝对路径,加入附件。 */
  function handleDrop(e: ReactDragEvent): void {
    e.preventDefault()
    setDragOver(false)
    const dropped = Array.from(e.dataTransfer.files)
    if (!dropped.length) {
      return
    }
    const paths = dropped
      .map((f) => {
        try {
          return window.api.getPathForFile?.(f) ?? ''
        } catch {
          return ''
        }
      })
      .filter((p) => p)
    if (paths.length) {
      addFiles(paths)
    } else {
      console.warn('[composer] 拖拽未能解析文件路径,请完全退出并重启应用以加载新的 preload')
    }
  }

  function baseName(p: string): string {
    return p.split(/[\\/]/).pop() || p
  }

  return (
    <div
      className={`composer${dragOver ? ' drag-over' : ''}`}
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className="composer-drop-hint">
          <Paperclip size={18} strokeWidth={1.8} />
          松开以引用文件
        </div>
      )}
      <div className="composer-card">
        <div className="composer-input-row">
          {files.map((f) => (
            <span key={f} className="file-chip removable" title={f}>
              <FileText size={14} strokeWidth={1.8} className="file-chip-icon" />
              <span className="file-chip-name">{baseName(f)}</span>
              <button
                className="file-chip-x"
                aria-label="移除"
                onClick={() => setFiles((prev) => prev.filter((x) => x !== f))}
              >
                ×
              </button>
            </span>
          ))}
          <textarea
            className="composer-input"
            value={text}
            placeholder="今天帮你做些什么? @ 引用对话文件, / 调用技能与指令"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />
        </div>

        <div className="composer-toolbar">
          <div className="tool-left">
            <div className="tool-wrap">
              <button
                className={`icon-btn round add-btn${addOpen ? ' active' : ''}`}
                onClick={() => {
                  setAddOpen((v) => !v)
                  setAddView('root')
                }}
                title="添加"
                aria-label="添加"
              >
                {addOpen ? (
                  <X size={19} strokeWidth={2} />
                ) : (
                  <Plus size={19} strokeWidth={1.8} />
                )}
              </button>
              {addOpen && (
                <>
                  <div className="menu-mask" onClick={closeAdd} />
                  <div className="pop-menu up add-menu">
                    {addView === 'root' && (
                      <>
                        <button
                          className="add-item"
                          onClick={() => {
                            closeAdd()
                            void pickFiles()
                          }}
                        >
                          <Paperclip size={15} strokeWidth={1.8} className="add-ico" />
                          <span className="add-name">添加文件</span>
                        </button>
                        <button className="add-item" onClick={() => setAddView('mode')}>
                          <ActiveModeIcon size={15} strokeWidth={1.8} className="add-ico" />
                          <span className="add-name">模式</span>
                          <span className="add-val">{activeMode.label}</span>
                          <ChevronRight size={14} strokeWidth={2} className="add-arrow" />
                        </button>
                        <button className="add-item" onClick={() => setAddView('skills')}>
                          <Puzzle size={15} strokeWidth={1.8} className="add-ico" />
                          <span className="add-name">技能</span>
                          <ChevronRight size={14} strokeWidth={2} className="add-arrow" />
                        </button>
                        <button className="add-item" disabled title="即将上线">
                          <GraduationCap size={15} strokeWidth={1.8} className="add-ico" />
                          <span className="add-name">专家</span>
                          <span className="add-soon">即将上线</span>
                        </button>
                        <button className="add-item" disabled title="即将上线">
                          <Cable size={15} strokeWidth={1.8} className="add-ico" />
                          <span className="add-name">连接器</span>
                          <span className="add-soon">即将上线</span>
                        </button>
                      </>
                    )}
                    {addView === 'mode' && (
                      <>
                        <button className="add-back" onClick={() => setAddView('root')}>
                          <ChevronLeft size={15} strokeWidth={2} />
                          模式
                        </button>
                        {MODES.map((m) => {
                          const Icon = m.icon
                          return (
                            <button
                              key={m.id}
                              className={`add-item${m.id === mode ? ' active' : ''}`}
                              title={m.desc}
                              onClick={() => {
                                onModeChange(m.id)
                                closeAdd()
                              }}
                            >
                              <Icon size={15} strokeWidth={1.8} className="add-ico" />
                              <span className="add-name">{m.label}</span>
                              {m.id === mode && (
                                <Check size={14} strokeWidth={2.4} className="add-check" />
                              )}
                            </button>
                          )
                        })}
                      </>
                    )}
                    {addView === 'skills' && (
                      <>
                        <button className="add-back" onClick={() => setAddView('root')}>
                          <ChevronLeft size={15} strokeWidth={2} />
                          技能
                        </button>
                        {SKILLS.map((s) => (
                          <button
                            key={s.id}
                            className="add-item"
                            onClick={() => {
                              setText((t) => (t ? `${t} /${s.id} ` : `/${s.id} `))
                              closeAdd()
                            }}
                          >
                            <span className="add-name">{s.label}</span>
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="tool-right">
            <div className="tool-wrap">
              <button
                className="pill model-pill"
                onClick={() => setModelOpen((v) => !v)}
                title="模型与深度思考"
              >
                <Cpu size={15} strokeWidth={1.8} />
                {modelLabel}
                {modelIsReasoning && (
                  <Sparkles size={12} strokeWidth={2} className="model-think-dot" />
                )}
                <ChevronDown size={13} strokeWidth={2} className="pill-caret" />
              </button>
              {modelOpen && (
                <>
                  <div className="menu-mask" onClick={() => setModelOpen(false)} />
                  <div className="pop-menu up model-menu">
                    <button
                      className={`think-toggle${modelIsReasoning ? '' : ' disabled'}`}
                      disabled={!modelIsReasoning}
                      title={
                        modelIsReasoning
                          ? 'Max 模式:本轮把思考强度拉到最高档;关闭则按模型默认强度(Auto)'
                          : '当前模型不支持深度思考'
                      }
                      onClick={() => onMaxModeChange(!maxMode)}
                    >
                      <Sparkles size={15} strokeWidth={1.8} className="think-ico" />
                      <span className="think-name">Max 模式</span>
                      <span className={`switch${modelIsReasoning && maxMode ? ' on' : ''}`}>
                        <span className="switch-dot" />
                      </span>
                    </button>
                    <div className="mode-menu-sep" />
                    <div className="model-list">
                      {models.length === 0 && (
                        <div className="model-empty-hint">尚无可用模型,请在模型管理中配置。</div>
                      )}
                      {models.map((m) => (
                        <button
                          key={m.key}
                          className={`model-item${model === m.key ? ' active' : ''}`}
                          onClick={() => {
                            onModelChange(m.key)
                            setModelOpen(false)
                          }}
                        >
                          {model === m.key ? (
                            <Check size={14} strokeWidth={2.4} className="model-check" />
                          ) : (
                            <span className="model-check-spacer" />
                          )}
                          <span className="model-name">{m.label}</span>
                          {m.reasoning && (
                            <Sparkles size={11} strokeWidth={2} className="model-item-think" />
                          )}
                        </button>
                      ))}
                    </div>
                    {onOpenModelSettings && (
                      <>
                        <div className="mode-menu-sep" />
                        <button
                          className="model-item manage"
                          onClick={() => {
                            setModelOpen(false)
                            onOpenModelSettings()
                          }}
                        >
                          <span className="model-check-spacer" />
                          <span className="model-name">管理模型…</span>
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>

            <button className="icon-btn round" title="语音">
              <Mic size={17} strokeWidth={1.8} />
            </button>
            {running ? (
              <button
                className="send-btn stop"
                onClick={onAbort}
                title="终止任务"
                aria-label="终止任务"
              >
                <Square size={13} strokeWidth={0} fill="currentColor" />
              </button>
            ) : (
              <button
                className="send-btn"
                onClick={submit}
                disabled={!text.trim() && files.length === 0}
                title="发送"
                aria-label="发送"
              >
                <ArrowUp size={18} strokeWidth={2.4} />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="composer-subbar">
        <div className="tool-wrap">
          <button className="subbar-pill" onClick={() => setWsOpen((v) => !v)} title="工作空间">
            <FolderOpen size={14} strokeWidth={1.8} />
            选择工作空间
            <ChevronDown size={12} strokeWidth={2} className="pill-caret" />
          </button>
          {wsOpen && (
            <>
              <div className="menu-mask" onClick={() => setWsOpen(false)} />
              <div className="pop-menu up ws-menu">
                <button
                  className="pop-item"
                  onClick={() => {
                    void window.api.openWorkspaceDir()
                    setWsOpen(false)
                  }}
                >
                  <span className="pop-item-title">
                    <FolderOpen size={15} strokeWidth={1.8} />
                    打开本地文件夹
                  </span>
                </button>
                <button className="pop-item" disabled title="即将上线">
                  <span className="pop-item-title">新建工作空间</span>
                  <span className="pop-desc">即将上线</span>
                </button>
              </div>
            </>
          )}
        </div>

        <div className="tool-wrap">
          <button
            className={`subbar-pill${permission === 'full' ? ' warn' : ''}`}
            onClick={() => setPermOpen((v) => !v)}
            title="文件访问权限"
          >
            {permission === 'full' ? (
              <Shield size={14} strokeWidth={1.8} />
            ) : (
              <ShieldCheck size={14} strokeWidth={1.8} />
            )}
            {permission === 'full' ? '完全访问权限' : '默认权限'}
            <ChevronDown size={12} strokeWidth={2} className="pill-caret" />
          </button>
          {permOpen && (
            <>
              <div className="menu-mask" onClick={() => setPermOpen(false)} />
              <div className="pop-menu up">
                <button
                  className="pop-item"
                  onClick={() => {
                    onPermissionChange('default')
                    setPermOpen(false)
                  }}
                >
                  <span className="pop-item-title">默认权限</span>
                  <span className="pop-desc">仅在受管工作区内读写</span>
                </button>
                <button
                  className="pop-item"
                  onClick={() => {
                    onPermissionChange('full')
                    setPermOpen(false)
                  }}
                >
                  <span className="pop-item-title">完全访问权限</span>
                  <span className="pop-desc">允许访问整台电脑(高风险)</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
