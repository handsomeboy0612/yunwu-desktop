import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  DesktopApi,
  ActivationConfig,
  GatewayStatus,
  AgentEvent,
  PreflightMode,
  PreflightReport,
  ProviderConfig
} from '@shared/types'

/**
 * 通过 contextBridge 暴露给渲染进程的安全 API(window.api)。
 * 渲染进程无法直接访问 Node/Electron,只能经由这里定义的白名单方法。
 */
const api: DesktopApi = {
  validateToken: (baseUrl, token) => ipcRenderer.invoke('yunwu:validate', baseUrl, token),
  login: (baseUrl, username, password, captchaToken) =>
    ipcRenderer.invoke('yunwu:login', baseUrl, username, password, captchaToken),
  captchaConfig: (baseUrl) => ipcRenderer.invoke('yunwu:captchaConfig', baseUrl),
  captchaFetch: (baseUrl, type) => ipcRenderer.invoke('yunwu:captchaFetch', baseUrl, type),
  captchaVerify: (baseUrl, type, key, answer) =>
    ipcRenderer.invoke('yunwu:captchaVerify', baseUrl, type, key, answer),
  loginWebview: (baseUrl) => ipcRenderer.invoke('yunwu:loginWebview', baseUrl),
  activate: (config: ActivationConfig) => ipcRenderer.invoke('yunwu:activate', config),
  getActivation: () => ipcRenderer.invoke('yunwu:getActivation'),
  clearActivation: () => ipcRenderer.invoke('yunwu:clearActivation'),
  listProviders: () => ipcRenderer.invoke('providers:list'),
  saveProviders: (providers: ProviderConfig[]) => ipcRenderer.invoke('providers:save', providers),
  deleteProvider: (id: string) => ipcRenderer.invoke('providers:delete', id),
  startGateway: () => ipcRenderer.invoke('gateway:start'),
  stopGateway: () => ipcRenderer.invoke('gateway:stop'),
  gatewayStatus: () => ipcRenderer.invoke('gateway:status'),
  gatewayHealth: () => ipcRenderer.invoke('gateway:health'),
  sendAgent: (sessionKey: string, message: string, opts?: { model?: string; thinking?: string }) =>
    ipcRenderer.invoke('agent:send', sessionKey, message, opts),
  abortAgent: (sessionKey: string) => ipcRenderer.invoke('agent:abort', sessionKey),
  replayAgent: (sessionKey: string) => ipcRenderer.invoke('agent:replay', sessionKey),
  ensureTaskAgent: (agentId: string) => ipcRenderer.invoke('task:ensureAgent', agentId),
  deleteTaskAgent: (agentId: string, sessionKey: string) =>
    ipcRenderer.invoke('task:delete', agentId, sessionKey),
  loadTasks: () => ipcRenderer.invoke('tasks:load'),
  saveTasks: (tasks) => ipcRenderer.invoke('tasks:save', tasks),
  getTaskHistory: (agentId: string) => ipcRenderer.invoke('task:history', agentId),
  discoverTaskOrphans: (knownIds: string[]) =>
    ipcRenderer.invoke('tasks:discoverOrphans', knownIds),
  onAgentEvent: (cb: (evt: AgentEvent) => void) => {
    const listener = (_e: unknown, evt: AgentEvent): void => cb(evt)
    ipcRenderer.on('agent:event', listener)
    return () => {
      ipcRenderer.removeListener('agent:event', listener)
    }
  },
  getWorkspaceDir: () => ipcRenderer.invoke('workspace:get'),
  openWorkspaceDir: () => ipcRenderer.invoke('workspace:open'),
  pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  onGatewayStatus: (cb: (status: GatewayStatus) => void) => {
    const listener = (_e: unknown, status: GatewayStatus): void => cb(status)
    ipcRenderer.on('gateway:status', listener)
    return () => {
      ipcRenderer.removeListener('gateway:status', listener)
    }
  },
  runPreflight: (mode?: PreflightMode) => ipcRenderer.invoke('preflight:run', mode),
  onPreflightStep: (cb: (report: PreflightReport) => void) => {
    const listener = (_e: unknown, report: PreflightReport): void => cb(report)
    ipcRenderer.on('preflight:step', listener)
    return () => {
      ipcRenderer.removeListener('preflight:step', listener)
    }
  },
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onWindowMaximizedChange: (cb: (maximized: boolean) => void) => {
    const listener = (_e: unknown, maximized: boolean): void => cb(maximized)
    ipcRenderer.on('window:maximized', listener)
    return () => {
      ipcRenderer.removeListener('window:maximized', listener)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // 关闭 contextIsolation 时的回退(本项目默认开启,这里仅兜底)。
  // @ts-ignore define on window
  window.api = api
}
