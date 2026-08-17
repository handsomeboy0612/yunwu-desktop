import { useEffect, useState } from 'react'
import {
  X,
  User,
  Boxes,
  SlidersHorizontal,
  Keyboard,
  Database,
  Info,
  CircleHelp,
  MessageSquarePlus,
  FolderOpen,
  LogOut
} from 'lucide-react'
import type { ActivationConfig } from '@shared/types'
import FloatingMask from '../../components/FloatingMask'
import ModelsPage from './Models'

interface Props {
  activation: ActivationConfig
  /** 关闭整个设置外壳。 */
  onClose: () => void
  /** 退出登录(清理激活并回到登录页)。 */
  onSignOut: () => void
  /** 模型配置变更后回调(父级刷新可选模型)。 */
  onModelsChanged?: () => void
  /** 打开全局反馈弹窗。 */
  onOpenFeedback: () => void
  /** 首次打开时定位到的页签(默认账户)。 */
  initial?: PageId
}

export type PageId =
  | 'account'
  | 'models'
  | 'system'
  | 'shortcuts'
  | 'data'
  | 'help'
  | 'about'

interface NavItem {
  id: PageId
  label: string
  icon: typeof User
  /** 占位页(即将上线),点击不可用。 */
  soon?: boolean
}

const NAV: NavItem[] = [
  { id: 'account', label: '账户管理', icon: User },
  { id: 'models', label: '模型', icon: Boxes },
  { id: 'system', label: '系统设置', icon: SlidersHorizontal },
  { id: 'shortcuts', label: '快捷键', icon: Keyboard, soon: true },
  { id: 'data', label: '数据管理', icon: Database, soon: true },
  { id: 'help', label: '帮助与反馈', icon: CircleHelp },
  { id: 'about', label: '关于', icon: Info }
]

/**
 * 设置外壳(对齐 WorkBuddy):左侧导航 + 右侧内容区,套一层全屏遮罩。
 *  - 模型管理并入其中,不再是独立浮窗;
 *  - 账户/系统/关于集中在一处,后续新增页只需往 NAV 与 renderPage 里加。
 */
export default function Settings({
  activation,
  onClose,
  onSignOut,
  onModelsChanged,
  onOpenFeedback,
  initial = 'account'
}: Props) {
  const [page, setPage] = useState<PageId>(initial)
  const current = NAV.find((n) => n.id === page) ?? NAV[0]

  return (
    <FloatingMask className="settings-mask" onClick={onClose}>
      <div className="settings-shell" onClick={(e) => e.stopPropagation()}>
        <aside className="settings-nav">
          <div className="settings-nav-brand">设置</div>
          {NAV.map((n) => (
            <button
              key={n.id}
              className={`settings-nav-item${n.id === page ? ' active' : ''}${n.soon ? ' soon' : ''}`}
              onClick={() => !n.soon && setPage(n.id)}
              title={n.soon ? '即将上线' : undefined}
            >
              <n.icon size={16} strokeWidth={1.8} />
              <span>{n.label}</span>
              {n.soon && <span className="settings-nav-soon">即将上线</span>}
            </button>
          ))}
        </aside>

        <section className="settings-main">
          <header className="settings-main-head">
            <span className="settings-main-title">{current.label}</span>
            <button className="icon-btn" title="关闭" onClick={onClose}>
              <X size={16} strokeWidth={1.8} />
            </button>
          </header>

          <div className="settings-main-body">
            {page === 'account' && (
              <AccountPage activation={activation} onSignOut={onSignOut} />
            )}
            {page === 'models' && <ModelsPage onChanged={onModelsChanged} />}
            {page === 'system' && <SystemPage />}
            {page === 'help' && <HelpPage onOpenFeedback={onOpenFeedback} />}
            {page === 'about' && <AboutPage />}
          </div>
        </section>
      </div>
    </FloatingMask>
  )
}

/** 帮助与反馈页:入口复用标题栏的同一个反馈弹窗，不维护第二份表单状态。 */
function HelpPage({ onOpenFeedback }: { onOpenFeedback: () => void }): React.JSX.Element {
  return (
    <>
      <div className="settings-card">
        <div className="settings-row settings-row-toggle">
          <div className="settings-row-text">
            <span className="settings-row-title">问题反馈</span>
            <span className="settings-row-desc">
              遇到异常或有产品建议时告诉我们，可附上截图与可选诊断信息。
            </span>
          </div>
          <button className="btn-ghost settings-feedback-btn" onClick={onOpenFeedback}>
            <MessageSquarePlus size={15} />
            提交反馈
          </button>
        </div>
      </div>
      <p className="settings-hint">
        诊断信息默认不上传；开启时也不会包含对话、工作区文件或访问令牌。
      </p>
    </>
  )
}

/** 账户管理页:当前账号信息 + 工作区 + 退出登录。 */
function AccountPage({
  activation,
  onSignOut
}: {
  activation: ActivationConfig
  onSignOut: () => void
}): React.JSX.Element {
  const maskedToken = activation.token
    ? `${activation.token.slice(0, 6)}••••${activation.token.slice(-4)}`
    : '—'
  return (
    <>
      <div className="settings-card settings-account">
        <div className="settings-account-avatar">云</div>
        <div className="settings-account-info">
          <div className="settings-account-name">云雾账户</div>
          <div className="settings-account-sub">已登录 · {activation.baseUrl}</div>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-row">
          <span>云雾地址</span>
          <b className="mono">{activation.baseUrl}</b>
        </div>
        <div className="settings-row">
          <span>访问令牌</span>
          <b className="mono">{maskedToken}</b>
        </div>
        <div className="settings-row">
          <span>默认模型</span>
          <b className="mono">{activation.defaultModel}</b>
        </div>
        <div className="settings-row">
          <span>可用模型</span>
          <b>{activation.models.length}</b>
        </div>
      </div>

      <div className="settings-actions">
        <button className="btn-ghost" onClick={() => window.api.openWorkspaceDir()}>
          <FolderOpen size={15} strokeWidth={1.8} />
          打开工作区文件夹
        </button>
        <button
          className="btn-ghost danger"
          onClick={async () => {
            await window.api.clearActivation()
            onSignOut()
          }}
        >
          <LogOut size={15} strokeWidth={1.8} />
          退出登录
        </button>
      </div>
    </>
  )
}

/** 系统设置页:开关 + 工作区与本地引擎信息(只读)+ 打开工作区。 */
function SystemPage(): React.JSX.Element {
  /**
   * 先按默认值(开)渲染,再用主进程的真值覆盖。
   *
   * 与 WorkBuddy 同口径:它渲染端也是默认 `enabled = true`,并把主进程的值镜像进
   * localStorage 以免开关闪一下(asar 里 `local-skills-memory.ts`)。我们这一跳是本地
   * IPC,快得多,所以不做镜像;但在读回来之前不接受点击,免得把默认值当成用户选择写回去。
   */
  const [memoryOn, setMemoryOn] = useState(true)
  const [prefsReady, setPrefsReady] = useState(false)

  useEffect(() => {
    void (async () => {
      const res = await window.api.getPrefs()
      if (res.ok && res.data) {
        setMemoryOn(res.data.localSkillsMemoryEnabled)
      }
      setPrefsReady(true)
    })()
  }, [])

  return (
    <>
      <div className="settings-card">
        <div className="settings-row settings-row-toggle">
          <div className="settings-row-text">
            <span className="settings-row-title">本地技能与记忆沉淀</span>
            <span className="settings-row-desc">
              自动记录本地记忆、工作日志,自动沉淀和优化技能。数据本地存储,仅在你的设备和工作空间中保留。
            </span>
          </div>
          <button
            className="settings-switch-btn"
            role="switch"
            aria-checked={memoryOn}
            aria-label="本地技能与记忆沉淀"
            disabled={!prefsReady}
            onClick={() => {
              const next = !memoryOn
              setMemoryOn(next)
              void window.api.setPrefs({ localSkillsMemoryEnabled: next })
            }}
          >
            <span className={`switch${memoryOn ? ' on' : ''}`}>
              <span className="switch-dot" />
            </span>
          </button>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-row">
          <span>版本</span>
          <b className="mono">v0.1.0</b>
        </div>
        <div className="settings-row">
          <span>运行模式</span>
          <b>本地引擎 · 零安装</b>
        </div>
      </div>
      <div className="settings-actions">
        <button className="btn-ghost" onClick={() => window.api.openWorkspaceDir()}>
          <FolderOpen size={15} strokeWidth={1.8} />
          打开工作区文件夹
        </button>
      </div>
      <p className="settings-hint">
        文档、表格、图片等任务产物都保存在本地工作区,可随时在文件夹中查看与备份。
      </p>
    </>
  )
}

/** 关于页。 */
function AboutPage(): React.JSX.Element {
  return (
    <div className="settings-about">
      <div className="settings-about-logo">云</div>
      <div className="settings-about-name">云雾助手</div>
      <div className="settings-about-ver">v0.1.0</div>
      <p className="settings-hint">本地办公 Agent · 一次登录,文档 / 表格 / PPT 全在本机搞定。</p>
    </div>
  )
}
