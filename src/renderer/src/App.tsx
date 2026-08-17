import { useEffect, useRef, useState } from 'react'
import { Minus, Square, Copy, MessageSquarePlus, X } from 'lucide-react'
import type { ActivationConfig } from '@shared/types'
import Activate from './pages/Activate'
import Workspace from './pages/Workspace'
import LoadingLottie from './components/LoadingLottie'
import FeedbackModal from './components/FeedbackModal'

/**
 * 应用根组件:根据是否已激活切换页面。
 *  - 未激活 → 激活页(输入云雾地址 + 令牌)
 *  - 已激活 → 工作台页(管理本地 OpenClaw + 聊天)
 *  - 已激活但云雾会话过期 → 还是激活页,措辞换成「登录已过期」,可跳过
 */
export default function App() {
  const [loading, setLoading] = useState(true)
  const [activation, setActivation] = useState<ActivationConfig | null>(null)
  /**
   * 云雾会话(登录时 Set-Cookie 给的那张,30 天)是否已经过期。
   *
   * 过期就先回登录页,而不是让用户在工作台里对着一个应用内的密码框 ——
   * 「登录过期就回登录页」是用户对任何软件的既有预期,我们本来也有这一屏。
   * 会话与 sk- 令牌是两码事:令牌不过期,所以跳过登录后聊天照样能用,
   * 只有账户菜单里的余额取不到数。
   */
  const [sessionExpired, setSessionExpired] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedbackToast, setFeedbackToast] = useState<number | null>(null)
  const helpRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void (async () => {
      const res = await window.api.getActivation()
      if (!res.ok || !res.data) {
        setLoading(false)
        return
      }
      setActivation(res.data)
      // 手上一张会话都没有 → 确定要重新登录,本地就能判(不打网络),直接落到登录页。
      const has = await window.api.hasSession()
      if (has.ok && has.data === false) {
        setSessionExpired(true)
        setLoading(false)
        return
      }
      setLoading(false)
      // 有会话就先进主页面,再在后台问一次服务端认不认(改过密码 / 超过 30 天会提前作废)。
      // **不等它**:这一问要打网络,冷启动时实测 0.8 秒、最坏是两次 8 秒超时,
      // 没有理由让每个人都对着「正在启动」等一个几乎总是「还有效」的答案。
      // 顺带把主进程的余额缓存填热,用户第一次点开账户菜单就有数。
      // 真被判过期时会弹回登录页 —— 那一下我们已经把死凭据清掉了,下次启动就是上面那条快路。
      void window.api.accountSnapshot().then((snap) => {
        if (snap.ok && snap.data?.status === 'expired') {
          setSessionExpired(true)
        }
      })
    })()
  }, [])

  // 同步窗口最大化状态,驱动"最大化/还原"图标切换。
  useEffect(() => {
    void window.api.windowIsMaximized().then((res) => {
      if (res.ok) setMaximized(!!res.data)
    })
    return window.api.onWindowMaximizedChange(setMaximized)
  }, [])

  // 窗口级兜底:拦截落区之外的文件拖放,避免 Electron 默认行为把窗口导航到被拖入的文件。
  // 具体的文件引用由 Composer 的落区处理并 stopPropagation 之外仍会冒泡,故此处只兜底未被处理的拖放。
  useEffect(() => {
    const prevent = (e: DragEvent): void => {
      if (e.defaultPrevented) {
        return
      }
      if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) {
        e.preventDefault()
      }
    }
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

  useEffect(() => {
    if (!helpOpen) return
    const close = (event: MouseEvent): void => {
      if (!helpRef.current?.contains(event.target as Node)) setHelpOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [helpOpen])

  useEffect(() => {
    if (feedbackToast == null) return
    const timer = window.setTimeout(() => setFeedbackToast(null), 4000)
    return () => window.clearTimeout(timer)
  }, [feedbackToast])

  return (
    <div className="app-root">
      {/* 全宽自定义标题栏:左侧品牌 + 菜单,右侧自绘紧凑窗口控制按钮。 */}
      <div className="titlebar">
        <div className="titlebar-left">
          <div className="tb-logo">云</div>
          <span className="tb-title">云雾助手</span>
          <nav className="tb-menu">
            <button className="tb-menu-item" title="即将支持">
              编辑
            </button>
            <button className="tb-menu-item" title="即将支持">
              窗口
            </button>
            <div className="tb-menu-wrap" ref={helpRef}>
              <button
                className={`tb-menu-item${helpOpen ? ' active' : ''}`}
                aria-expanded={helpOpen}
                onClick={() => setHelpOpen((open) => !open)}
              >
                帮助
              </button>
              {helpOpen && (
                <div className="tb-help-menu">
                  <button
                    disabled={!activation}
                    title={activation ? undefined : '登录后可提交反馈'}
                    onClick={() => {
                      setHelpOpen(false)
                      setFeedbackOpen(true)
                    }}
                  >
                    <MessageSquarePlus size={15} />
                    <span>
                      <b>问题反馈</b>
                      <small>报告问题或提出建议</small>
                    </span>
                  </button>
                </div>
              )}
            </div>
          </nav>
        </div>
        <div className="titlebar-right">
          <button
            className="win-btn"
            title="最小化"
            aria-label="最小化"
            onClick={() => void window.api.windowMinimize()}
          >
            <Minus size={14} strokeWidth={1.8} />
          </button>
          <button
            className="win-btn"
            title={maximized ? '还原' : '最大化'}
            aria-label={maximized ? '还原' : '最大化'}
            onClick={() => void window.api.windowToggleMaximize()}
          >
            {maximized ? <Copy size={12} strokeWidth={1.8} /> : <Square size={12} strokeWidth={1.8} />}
          </button>
          <button
            className="win-btn close"
            title="关闭"
            aria-label="关闭"
            onClick={() => void window.api.windowClose()}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      <div className="app-body">
        {loading ? (
          <div className="center-screen">
            <LoadingLottie size="lg" label="正在启动" />
          </div>
        ) : !activation || sessionExpired ? (
          <Activate
            onActivated={(config) => {
              setActivation(config)
              setSessionExpired(false)
            }}
            expired={
              activation && sessionExpired
                ? {
                    username: activation.username ?? '',
                    onSkip: () => setSessionExpired(false)
                  }
                : undefined
            }
          />
        ) : (
          <Workspace
            activation={activation}
            onSignOut={() => setActivation(null)}
            onRelogin={() => setSessionExpired(true)}
            onOpenFeedback={() => setFeedbackOpen(true)}
          />
        )}
      </div>

      <FeedbackModal
        open={feedbackOpen}
        page={activation ? 'workspace' : 'activation'}
        onClose={() => setFeedbackOpen(false)}
        onSuccess={setFeedbackToast}
      />
      {feedbackToast != null && (
        <div className="feedback-toast" role="status">
          反馈已提交，编号 #{feedbackToast}
        </div>
      )}
    </div>
  )
}
