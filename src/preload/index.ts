import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  DesktopApi,
  ActivationConfig,
  GatewayStatus,
  AgentEvent,
  MediaSelection,
  MediaTaskProgress,
  ModelInfo,
  PreflightMode,
  PreflightReport,
  ProviderConfig,
  AskRequest,
  WidgetRequest,
  PresentRequest,
  AppPreferences,
  FeedbackSubmission
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
  activate: (config: ActivationConfig) => ipcRenderer.invoke('yunwu:activate', config),
  getActivation: () => ipcRenderer.invoke('yunwu:getActivation'),
  clearActivation: () => ipcRenderer.invoke('yunwu:clearActivation'),
  accountSnapshot: (force) => ipcRenderer.invoke('account:snapshot', force === true),
  hasSession: () => ipcRenderer.invoke('account:hasSession'),
  submitFeedback: (submission: FeedbackSubmission) =>
    ipcRenderer.invoke('feedback:submit', submission),
  modelCatalog: () => ipcRenderer.invoke('models:catalog'),
  availableModels: () => ipcRenderer.invoke('models:available'),
  selectModels: (chat: ModelInfo[]) => ipcRenderer.invoke('models:select', chat),
  availableMediaModels: () => ipcRenderer.invoke('media:available'),
  selectMediaModels: (selection: Partial<MediaSelection>) =>
    ipcRenderer.invoke('media:select', selection),
  listProviders: () => ipcRenderer.invoke('providers:list'),
  saveProviders: (providers: ProviderConfig[]) => ipcRenderer.invoke('providers:save', providers),
  upsertProvider: (provider: ProviderConfig) => ipcRenderer.invoke('providers:upsert', provider),
  deleteProvider: (id: string) => ipcRenderer.invoke('providers:delete', id),
  startGateway: () => ipcRenderer.invoke('gateway:start'),
  stopGateway: () => ipcRenderer.invoke('gateway:stop'),
  gatewayStatus: () => ipcRenderer.invoke('gateway:status'),
  gatewayHealth: () => ipcRenderer.invoke('gateway:health'),
  sendAgent: (
    sessionKey: string,
    message: string,
    opts?: { model?: string; thinking?: string; reasoning?: boolean }
  ) =>
    ipcRenderer.invoke('agent:send', sessionKey, message, opts),
  abortAgent: (sessionKey: string) => ipcRenderer.invoke('agent:abort', sessionKey),
  replayAgent: (sessionKey: string) => ipcRenderer.invoke('agent:replay', sessionKey),
  readArtifact: (sessionKey: string, filePath: string) =>
    ipcRenderer.invoke('artifact:read', sessionKey, filePath),
  statArtifacts: (sessionKey: string, paths: string[]) =>
    ipcRenderer.invoke('artifact:stat', sessionKey, paths),
  ensureTaskSession: (sessionKey: string, expertSlug?: string, workspaceDir?: string) =>
    ipcRenderer.invoke('task:ensureSession', sessionKey, expertSlug, workspaceDir),
  deleteTask: (sessionKey: string) => ipcRenderer.invoke('task:delete', sessionKey),
  loadTasks: () => ipcRenderer.invoke('tasks:load'),
  saveTasks: (tasks) => ipcRenderer.invoke('tasks:save', tasks),
  getTaskHistory: (sessionKey: string) => ipcRenderer.invoke('task:history', sessionKey),
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
  openTaskDir: (sessionKey: string) => ipcRenderer.invoke('workspace:openTask', sessionKey),
  listWorkspaces: () => ipcRenderer.invoke('workspace:list'),
  createWorkspace: (name: string) => ipcRenderer.invoke('workspace:create', name),
  pickWorkspaceDir: () => ipcRenderer.invoke('workspace:pickDir'),
  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  setPrefs: (patch: Partial<AppPreferences>) => ipcRenderer.invoke('prefs:set', patch),
  revealArtifact: (sessionKey: string, filePath: string) =>
    ipcRenderer.invoke('artifact:reveal', sessionKey, filePath),
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
  onConfigSyncError: (cb: (message: string) => void) => {
    const listener = (_e: unknown, message: string): void => cb(message)
    ipcRenderer.on('config:sync-error', listener)
    return () => {
      ipcRenderer.removeListener('config:sync-error', listener)
    }
  },
  onMediaProgress: (cb: (progress: MediaTaskProgress) => void) => {
    const listener = (_e: unknown, progress: MediaTaskProgress): void => cb(progress)
    ipcRenderer.on('media:progress', listener)
    return () => {
      ipcRenderer.removeListener('media:progress', listener)
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
  },
  getMarketSnapshot: (type) => ipcRenderer.invoke('market:snapshot', type),
  marketDetail: (type, slug) => ipcRenderer.invoke('market:detail', type, slug),
  installMarketItem: (item, opts) => ipcRenderer.invoke('market:install', item, opts),
  uninstallMarketItem: (type, slug) => ipcRenderer.invoke('market:uninstall', type, slug),
  listInstalledMarket: (type) => ipcRenderer.invoke('market:installed', type),
  listInstalledExperts: () => ipcRenderer.invoke('expert:list'),
  listScenarios: (kind) => ipcRenderer.invoke('scenario:list', kind),
  scenarioArtifact: (id) => ipcRenderer.invoke('scenario:artifact', id),
  listScenes: () => ipcRenderer.invoke('scene:list'),
  aiFindSkills: (need) => ipcRenderer.invoke('market:aiFind', need),
  aiCreateSkill: (need) => ipcRenderer.invoke('market:aiCreate', need),
  aiInstallGeneratedSkill: (draft) => ipcRenderer.invoke('market:aiInstallGenerated', draft),
  installLocalSkillZip: (filePath) => ipcRenderer.invoke('market:installLocalZip', filePath),
  onAskUser: (cb: (req: AskRequest) => void) => {
    const listener = (_e: unknown, req: AskRequest): void => cb(req)
    ipcRenderer.on('ui-tool:ask', listener)
    return () => {
      ipcRenderer.removeListener('ui-tool:ask', listener)
    }
  },
  answerAskUser: (id: string, answers: unknown) =>
    ipcRenderer.invoke('ui-tool:answer', id, answers),
  onShowWidget: (cb: (req: WidgetRequest) => void) => {
    const listener = (_e: unknown, req: WidgetRequest): void => cb(req)
    ipcRenderer.on('ui-tool:widget', listener)
    return () => {
      ipcRenderer.removeListener('ui-tool:widget', listener)
    }
  },
  onPresentFiles: (cb: (req: PresentRequest) => void) => {
    const listener = (_e: unknown, req: PresentRequest): void => cb(req)
    ipcRenderer.on('ui-tool:present', listener)
    return () => {
      ipcRenderer.removeListener('ui-tool:present', listener)
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
