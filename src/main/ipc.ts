import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import type {
  ActivationConfig,
  CaptchaType,
  IpcResult,
  PreflightMode,
  ProviderConfig
} from '@shared/types'
import { validateToken } from './yunwu-client'
import { loginWithPassword, loginViaWebview } from './yunwu-auth'
import { fetchCaptchaConfig, fetchCaptcha, verifyCaptcha } from './yunwu-captcha'
import { writeOpenClawConfig, applyProvidersConfig } from './config-writer'
import { loadProviders, deleteProvider } from './providers-store'
import { loadActivation, saveActivation, clearActivation, loadTasks, saveTasks } from './store'
import { openClawManager } from './openclaw-manager'
import { gatewayClient } from './gateway-client'
import { getWorkspaceDir } from './workspace'
import { preflight } from './preflight'
import { replayAgentEvents, clearSessionBuffer } from './event-buffer'
import { ensureAgent, deleteAgent, listTaskAgentIds } from './agent-manager'
import { readSessionHistory } from './session-history'
import type { TaskMeta } from '@shared/types'

/** 从 taskId(t<13位毫秒时间戳><随机>)解析创建时间;无法解析时回退 0。 */
function parseCreatedAt(id: string): number {
  const m = id.match(/^t(\d{13})/)
  return m ? Number(m[1]) : 0
}

/** 统一封装成功返回。 */
function ok<T>(data?: T): IpcResult<T> {
  return { ok: true, data }
}

/** 统一封装失败返回,提取可读错误消息。 */
function fail(err: unknown): IpcResult {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

/**
 * 注册所有 IPC 处理器。在 app ready 后、创建窗口前调用一次。
 * 所有 handler 均返回 IpcResult,渲染层据此判断成功/失败,避免异常穿透到 IPC 边界。
 */
export function registerIpc(): void {
  // ---- 自定义标题栏窗口控制(最小化/最大化-还原/关闭)----
  // 通过事件 sender 反查所属窗口,避免耦合具体窗口实例。
  ipcMain.handle('window:minimize', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize()
    return ok()
  })
  ipcMain.handle('window:toggleMaximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return ok(false)
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
    return ok(win.isMaximized())
  })
  ipcMain.handle('window:close', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
    return ok()
  })
  ipcMain.handle('window:isMaximized', (e) => ok(BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false))

  ipcMain.handle('yunwu:validate', async (_e, baseUrl: string, token: string) => {
    try {
      return ok(await validateToken(baseUrl, token))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    'yunwu:login',
    async (_e, baseUrl: string, username: string, password: string, captchaToken?: string) => {
      try {
        const res = await loginWithPassword(baseUrl, username, password, captchaToken)
        return ok({ baseUrl: res.baseUrl, token: res.token, username: res.username })
      } catch (err) {
        // 透传验证码标记,便于渲染层自动引导到网页登录。
        const needCaptcha = (err as { needCaptcha?: boolean })?.needCaptcha === true
        return { ...fail(err), needCaptcha } as IpcResult<never> & { needCaptcha: boolean }
      }
    }
  )

  ipcMain.handle('yunwu:captchaConfig', async (_e, baseUrl: string) => {
    try {
      return ok(await fetchCaptchaConfig(baseUrl))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('yunwu:captchaFetch', async (_e, baseUrl: string, type: CaptchaType) => {
    try {
      return ok(await fetchCaptcha(baseUrl, type))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    'yunwu:captchaVerify',
    async (_e, baseUrl: string, type: CaptchaType, key: string, answer: string) => {
      try {
        return ok({ token: await verifyCaptcha(baseUrl, type, key, answer) })
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle('yunwu:loginWebview', async (_e, baseUrl: string) => {
    try {
      const res = await loginViaWebview(baseUrl)
      return ok({ baseUrl: res.baseUrl, token: res.token, username: res.username })
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('yunwu:activate', async (_e, config: ActivationConfig) => {
    try {
      await writeOpenClawConfig(config)
      saveActivation(config)
      return ok()
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('yunwu:getActivation', async () => {
    try {
      const act = loadActivation()
      // 平滑迁移:老激活态但尚无 providers.json → 用激活配置补齐单一数据源并重渲染,
      // 使已激活用户升级后无需重新登录即获得模型选择器与思考能力标记(仅首启执行一次)。
      if (act && loadProviders().length === 0) {
        try {
          await writeOpenClawConfig(act)
        } catch (e) {
          console.warn('[migrate] 供货商迁移失败(不阻塞进入):', e)
        }
      }
      return ok(act)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('yunwu:clearActivation', async () => {
    try {
      openClawManager.stop()
      clearActivation()
      return ok()
    } catch (err) {
      return fail(err)
    }
  })

  // ---- 模型管理:供货商配置(单一数据源 providers.json,声明式渲染进 openclaw.json)----
  ipcMain.handle('providers:list', async () => {
    try {
      return ok(loadProviders())
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('providers:save', async (_e, providers: ProviderConfig[]) => {
    try {
      const act = loadActivation()
      await applyProvidersConfig(providers, act ? `yunwu/${act.defaultModel}` : undefined)
      return ok()
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('providers:delete', async (_e, id: string) => {
    try {
      const next = deleteProvider(id)
      const act = loadActivation()
      await applyProvidersConfig(next, act ? `yunwu/${act.defaultModel}` : undefined)
      return ok(next)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('gateway:start', async () => {
    try {
      const status = openClawManager.start()
      // 网关启动后主动预热 WS 连接(自带重连兜底就绪窗口),
      // 使首条消息无需"现连现等",规避启动瞬间的 1006 异常关闭。
      void gatewayClient.ensureConnected().catch(() => {
        /* 预热失败无妨:真正发送时会再次尝试连接 */
      })
      return ok(status)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('gateway:stop', async () => {
    try {
      return ok(openClawManager.stop())
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('gateway:status', async () => ok(openClawManager.status()))

  ipcMain.handle('preflight:run', async (_e, mode?: PreflightMode) => {
    try {
      return ok(await preflight.run(mode))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('gateway:health', async () => {
    try {
      return ok(await gatewayClient.request('health', {}, { timeoutMs: 12000 }))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    'agent:send',
    async (
      _e,
      sessionKey: string,
      message: string,
      opts?: { model?: string; thinking?: string }
    ) => {
      try {
        // 会话级模型覆盖:用户在输入框选了具体模型时,先 patch 该会话的模型(best-effort,
        // 失败不阻塞发送,退回 agent 默认模型)。thinking 档位随本轮 chat.send 传入。
        if (opts?.model) {
          try {
            await gatewayClient.patchSession(sessionKey, {
              // opts.model 已是内核完整键 `<provider>/<model>`(如 yunwu/deepseek-r1)。
              model: opts.model,
              thinkingLevel: opts.thinking
            })
          } catch (patchErr) {
            console.warn('[agent:send] sessions.patch 失败,回退默认模型:', patchErr)
          }
        }
        return ok(
          await gatewayClient.chatSend(sessionKey, message, {
            thinking: opts?.thinking
          })
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle('agent:abort', async (_e, sessionKey: string) => {
    try {
      await gatewayClient.abortChat(sessionKey)
      return ok()
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('agent:replay', async (_e, sessionKey: string) => {
    try {
      return ok(replayAgentEvents(sessionKey))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('task:ensureAgent', async (_e, agentId: string) => {
    try {
      await ensureAgent(agentId)
      return ok()
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('task:delete', async (_e, agentId: string, sessionKey: string) => {
    try {
      await deleteAgent(agentId)
      if (sessionKey) {
        clearSessionBuffer(sessionKey)
      }
      return ok()
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('tasks:load', async () => {
    try {
      // 仅读本地元数据(同步、毫秒级),保证首屏秒开;孤儿发现由 tasks:discoverOrphans 后台补。
      return ok(loadTasks())
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('tasks:discoverOrphans', async (_e, knownIds: string[]) => {
    try {
      // 后台向内核校正:找出"内核里存在但本地未记录"的孤儿 agent(如首次迁移或外部改动),
      // 并行读取各自首条消息作标题。此调用不阻塞首屏渲染。
      const known = new Set(knownIds)
      const agentIds = await listTaskAgentIds()
      const orphanIds = agentIds.filter((id) => !known.has(id))
      const orphans = await Promise.all(
        orphanIds.map(async (id) => {
          const history = await readSessionHistory(id)
          const firstUser = history.find((m) => m.role === 'user')
          return {
            id,
            title: firstUser ? firstUser.content.slice(0, 20) : '历史任务',
            sessionKey: `agent:${id}:main`,
            createdAt: parseCreatedAt(id)
          } as TaskMeta
        })
      )
      return ok(orphans)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('tasks:save', async (_e, tasks: TaskMeta[]) => {
    try {
      saveTasks(tasks)
      return ok()
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('task:history', async (_e, agentId: string) => {
    try {
      return ok(await readSessionHistory(agentId))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('workspace:get', async () => {
    try {
      return ok(getWorkspaceDir())
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('workspace:open', async () => {
    try {
      await shell.openPath(getWorkspaceDir())
      return ok()
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('dialog:pickFiles', async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections']
      })
      if (result.canceled) {
        return ok<string[]>([])
      }
      return ok(result.filePaths)
    } catch (err) {
      return fail(err)
    }
  })
}
