import { useEffect, useState } from 'react'
import { Minus, Square, Copy, X } from 'lucide-react'
import type { ActivationConfig } from '@shared/types'
import Activate from './pages/Activate'
import Workspace from './pages/Workspace'

/**
 * 应用根组件:根据是否已激活切换页面。
 *  - 未激活 → 激活页(输入云雾地址 + 令牌)
 *  - 已激活 → 工作台页(管理本地 OpenClaw + 聊天)
 */
export default function App() {
  const [loading, setLoading] = useState(true)
  const [activation, setActivation] = useState<ActivationConfig | null>(null)
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void (async () => {
      const res = await window.api.getActivation()
      if (res.ok && res.data) {
        setActivation(res.data)
      }
      setLoading(false)
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
            <button className="tb-menu-item" title="即将支持">
              帮助
            </button>
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
            <div className="spinner" />
          </div>
        ) : !activation ? (
          <Activate onActivated={setActivation} />
        ) : (
          <Workspace activation={activation} onSignOut={() => setActivation(null)} />
        )}
      </div>
    </div>
  )
}
