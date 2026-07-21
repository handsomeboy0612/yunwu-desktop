import { app, shell, BrowserWindow, Menu } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpc } from './ipc'
import { openClawManager } from './openclaw-manager'
import { gatewayClient, normalizeAgentEvent, type GatewayEventFrame } from './gateway-client'
import { recordAgentEvent } from './event-buffer'
import { preflight } from './preflight'
import type { GatewayStatus, PreflightReport } from '@shared/types'

/** 创建主窗口并加载渲染层(dev 走 vite dev server,prod 走打包后的 index.html)。 */
function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 940,
    minHeight: 640,
    show: false,
    title: 'Yunwu Desktop',
    // 无边框自定义标题栏:隐藏系统标题栏与原生窗口控制按钮,改由渲染层自绘紧凑按钮
    // (最小化/最大化/关闭),使按钮尺寸与整体 UI 对齐、更精致。
    // 顶部拖拽区由渲染层用 -webkit-app-region: drag 提供,按钮区用 no-drag 排除。
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // 自绘窗口按钮需要知道当前是否最大化(切换"最大化/还原"图标)。
  const forwardMaximized = (): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized', mainWindow.isMaximized())
    }
  }
  mainWindow.on('maximize', forwardMaximized)
  mainWindow.on('unmaximize', forwardMaximized)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 把网关状态变化实时转发给渲染层。
  const forward = (status: GatewayStatus): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:status', status)
    }
  }
  openClawManager.on('status', forward)

  // 把网关 agent 运行事件(文字增量/工具步骤/生命周期)归一化后转发给渲染层。
  const forwardAgentEvent = (frame: GatewayEventFrame): void => {
    const evt = normalizeAgentEvent(frame)
    if (evt) {
      /** 旁路缓冲,供断线重连后重放(幂等重放,不依赖 seq)。 */
      recordAgentEvent(evt)
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('agent:event', evt)
      }
    }
  }
  gatewayClient.on('event', forwardAgentEvent)

  // 把自检进度逐步转发给渲染层(启动/新建任务的准备态)。
  const forwardPreflight = (report: PreflightReport): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('preflight:step', report)
    }
  }
  preflight.on('step', forwardPreflight)

  mainWindow.on('closed', () => {
    openClawManager.off('status', forward)
    gatewayClient.off('event', forwardAgentEvent)
    preflight.off('step', forwardPreflight)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('ai.yunwu.desktop')

  // 去掉系统应用菜单栏,配合自定义标题栏获得干净的一体化外观。
  Menu.setApplicationMenu(null)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  // 关闭窗口时先断开网关 WS 客户端,再回收本地网关进程,避免残留。
  gatewayClient.close()
  openClawManager.stop()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
