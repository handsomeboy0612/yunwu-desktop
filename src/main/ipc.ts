import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import type {
  ActivationConfig,
  CaptchaType,
  FeedbackSubmission,
  IpcResult,
  MediaSelection,
  ModelInfo,
  PreflightMode,
  ProviderConfig
} from '@shared/types'
import { validateToken } from './yunwu-client'
import { loginWithPassword } from './yunwu-auth'
import { getAccountSnapshot, hasStoredSession, resetAccountCache } from './yunwu-account'
import { clearSessionCookie } from './account-session'
import { fetchCaptchaConfig, fetchCaptcha, verifyCaptcha } from './yunwu-captcha'
import {
  writeOpenClawConfig,
  applyProvidersConfig,
  applyProviderUpsert,
  applyAccountChatModels,
  applyMediaSelection
} from './config-writer'
import {
  fetchAvailableChatModels,
  fetchAvailableMediaModels,
  hasChosenChatModels,
  hasChosenMediaModels,
  presetSelection,
  presetMediaSelection,
  resolveAccountChatModels,
  resolveAccountMediaModels,
  saveSelectedMediaModels,
  resolveActivation
} from './model-catalog'
import { loadProviders, deleteProvider } from './providers-store'
import { loadActivation, saveActivation, clearActivation, loadTasks, saveTasks } from './store'
import { openClawManager } from './openclaw-manager'
import { isReasoningStreamPatched } from './openclaw-cli'
import { gatewayClient } from './gateway-client'
import {
  getWorkspaceDir,
  getSessionWorkspaceDir,
  getTaskWorkspaceDir,
  resolveAgentArtifactPath,
  readAgentArtifact,
  statAgentArtifacts,
  listWorkspaces,
  createWorkspace,
  registerWorkspace,
  bindTaskWorkspace,
  getTaskWorkspaceBinding,
  clearTaskWorkspaceBinding
} from './workspace'
import { preflight } from './preflight'
import { replayAgentEvents, clearSessionBuffer } from './event-buffer'
import { ensureAgent, ensureWorkspaceGuides } from './agent-manager'
import { readSessionHistory, listTaskSessionKeys } from './session-history'
import {
  parseTaskSessionKey,
  withWorkingDirectory,
  DEFAULT_TASK_AGENT_ID
} from '@shared/session-key'
import { syncPersonaData, syncTaskWorkspaceData } from './persona-bundle'
import {
  fetchMarketSnapshot,
  marketDetail,
  listScenarios,
  listScenes,
  scenarioArtifact
} from './market/market-client'
import {
  installSkill,
  uninstallSkill,
  listInstalledSkills,
  installSkillFromLocalZip
} from './market/installer'
import { seedBuiltinSkills } from './market/builtin-skills'
import {
  installConnector,
  uninstallConnector,
  listInstalledConnectors
} from './market/connector-installer'
import {
  installExpert,
  uninstallExpert,
  listInstalledExperts,
  ensureExpertFresh
} from './market/expert-installer'
import { getExpert } from './market/expert-store'
import { teamDelegationRuntimeNote } from './team-roster-prompt'
import { findSkills, generateSkill, installGeneratedSkill } from './market/skill-generator'
import { uiToolsBridge } from './ui-tools-server'
import { loadPrefs, savePrefs } from './prefs'
import { submitFeedback } from './feedback-client'
import type {
  TaskMeta,
  MarketAssetType,
  MarketItem,
  MarketInstallOptions,
  AiSkillDraft,
  AppPreferences,
  DesktopScenarioKind
} from '@shared/types'

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
 * 专家团负责人会话的「派活运行时参数」;不是团队会话返回空串。
 *
 * 判据取 manifest 上**声明**了成员,而不是人设表里真的生成了名册:后者要读整张人设表,
 * 而这是每轮发消息都会走的路径。声明了却因人设缺失没进名册的,顶多多一行没人用的文字。
 */
function delegationNoteFor(sessionKey: string, cwd: string, modelRef?: string): string {
  const slug = parseTaskSessionKey(sessionKey)?.expertSlug
  if (!slug) {
    return ''
  }
  const manifest = getExpert(slug)?.manifest
  const hasTeam = Boolean(manifest?.members?.length || manifest?.memberSlugs?.length)
  return hasTeam ? teamDelegationRuntimeNote({ cwd, modelRef }) : ''
}

/**
 * 注册所有 IPC 处理器。在 app ready 后、创建窗口前调用一次。
 * 所有 handler 均返回 IpcResult,渲染层据此判断成功/失败,避免异常穿透到 IPC 边界。
 */
export function registerIpc(): void {
  // 启动时播种内置引导技能(find-skills / skill-creator),供对话内「查找/创建技能」自动匹配。
  seedBuiltinSkills()

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
        return ok({
          baseUrl: res.baseUrl,
          token: res.token,
          userId: res.userId,
          username: res.username
        })
      } catch (err) {
        // 透传验证码标记,渲染层据此补弹一次应用内验证层(见 Activate 的 doLogin)。
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

  ipcMain.handle('yunwu:activate', async (_e, config: ActivationConfig) => {
    try {
      // 模型清单由主进程按账号解析:它存在 model-catalog.json 里,渲染层不知道这个账号
      // 选过什么。渲染层只递 baseUrl / token / username,清单在这里定(选过就用选的,
      // 没选过先用本地兜底,随后由首启选择器覆盖)。返回解析后的配置,渲染层据它进主界面。
      const resolved = resolveActivation(config)
      // 先落激活态再下发内核。反过来会留下劈叉:下发一抛异常,登录算失败,可 providers.json
      // 已经被改成新账号的了——用户既没进去,本地又已经是半个新账号。内核下发失败本身已
      // 不再抛(见 writeOpenClawConfig),这里的顺序是双保险。
      saveActivation(resolved)
      await writeOpenClawConfig(resolved)
      return ok(resolved)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('yunwu:getActivation', async () => {
    try {
      const act = loadActivation()
      // 平滑迁移:老激活态但尚无 providers.json → 用激活配置补齐单一数据源并重渲染,
      // 使已激活用户升级后无需重新登录即获得模型选择器与思考能力标记(仅首启执行一次)。
      //
      // **不等它**:渲染层拿这个返回值决定首屏,而这一步里下发内核那半段要走网关热加载
      // (网关忙时实测十几秒),等于把升级后的第一次启动锁在「正在启动」上。
      // 补 providers.json 那半段是同步的(saveProviders 在第一个 await 之前),
      // 调用一发出就已经落盘,渲染层随后要用的单一数据源不会缺。
      if (act && loadProviders().length === 0) {
        void writeOpenClawConfig(act).catch((e) =>
          console.warn('[migrate] 供货商迁移失败(不阻塞进入):', e)
        )
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
      // 会话与余额缓存跟着一起清:换账号时下一个人不该先看到上一个人的余额。
      clearSessionCookie()
      resetAccountCache()
      return ok()
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('account:snapshot', async (_e, force?: boolean) => {
    try {
      return ok(await getAccountSnapshot(force === true))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('account:hasSession', async () => {
    try {
      return ok(hasStoredSession())
    } catch (err) {
      return fail(err)
    }
  })


  ipcMain.handle('feedback:submit', async (_e, submission: FeedbackSubmission) => {
    try {
      return ok(await submitFeedback(submission))
    } catch (err) {
      return fail(err)
    }
  })

  // ---- 模型管理:云雾账号的对话模型清单(按账号存,见 model-catalog.ts)----

  /**
   * 设置页/首启选择器要的清单状态。
   *
   * `chosen=false` 表示这个账号还没选过、正在用本地兜底清单——首启引导据此决定要不要
   * 弹选择这一步。没有"服务端推荐"可给:清单完全是用户数据(见 model-catalog.ts)。
   */
  ipcMain.handle('models:catalog', async () => {
    try {
      const act = loadActivation()
      if (!act) {
        return fail(new Error('未登录云雾账号'))
      }
      return ok({
        selected: resolveAccountChatModels(act),
        chosen: hasChosenChatModels(act),
        media: resolveAccountMediaModels(act),
        mediaChosen: hasChosenMediaModels(act)
      })
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * 拉该 key 此刻真能调的对话模型(首启选择器与「添加模型」的可选池)。
   * 每次打开选择器现拉:能不能调到取决于渠道分组与令牌路由,是会变的,缓存住会骗人。
   */
  ipcMain.handle('models:available', async () => {
    try {
      const act = loadActivation()
      if (!act) {
        return fail(new Error('未登录云雾账号'))
      }
      const models = await fetchAvailableChatModels(act)
      return ok({ models, preset: presetSelection(models).map((m) => m.id) })
    } catch (err) {
      return fail(err)
    }
  })

  /** 保存选中的对话模型:落盘 + 重算内置供货商 + 后台下发内核。 */
  ipcMain.handle('models:select', async (_e, chat: ModelInfo[]) => {
    try {
      const act = loadActivation()
      if (!act) {
        return fail(new Error('未登录云雾账号'))
      }
      const next = applyAccountChatModels(act, chat)
      return ok(next)
    } catch (err) {
      return fail(err)
    }
  })

  // ---- 模型管理:媒体模型(出图 / 视频 / 语音)----
  //
  // 与对话模型分开两个通道而不是塞进上面那对:媒体的池子判据不同(按端点类型)、
  // 落盘形态不同(只存 id、不进供货商 models),混在一起只会让两边都带上对方的分支。

  /**
   * 媒体候选池 + 该账号此刻的选择 + 预勾选。
   *
   * 每次打开选择器现拉:能不能调到取决于渠道分组与令牌路由,是会变的,缓存住会骗人。
   */
  ipcMain.handle('media:available', async () => {
    try {
      const act = loadActivation()
      if (!act) {
        return fail(new Error('未登录云雾账号'))
      }
      const pool = await fetchAvailableMediaModels(act)
      return ok({
        pool,
        selected: resolveAccountMediaModels(act),
        preset: presetMediaSelection(pool),
        chosen: hasChosenMediaModels(act)
      })
    } catch (err) {
      return fail(err)
    }
  })

  /** 保存媒体模型选择:落盘 + 后台下发内核(出图/视频的模型引用与 TTS provider)。 */
  ipcMain.handle('media:select', async (_e, selection: Partial<MediaSelection>) => {
    try {
      const act = loadActivation()
      if (!act) {
        return fail(new Error('未登录云雾账号'))
      }
      saveSelectedMediaModels(act, selection)
      await applyMediaSelection()
      return ok(resolveAccountMediaModels(act))
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
      applyProvidersConfig(providers, act ? `yunwu/${act.defaultModel}` : undefined)
      return ok()
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('providers:upsert', async (_e, provider: ProviderConfig) => {
    try {
      const act = loadActivation()
      const next = applyProviderUpsert(provider, act ? `yunwu/${act.defaultModel}` : undefined)
      return ok(next)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('providers:delete', async (_e, id: string) => {
    try {
      const next = deleteProvider(id)
      const act = loadActivation()
      applyProvidersConfig(next, act ? `yunwu/${act.defaultModel}` : undefined)
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
      opts?: { model?: string; thinking?: string; reasoning?: boolean }
    ) => {
      try {
        // 会话级模型覆盖:用户在输入框选了具体模型时,先 patch 该会话的模型(best-effort,
        // 失败不阻塞发送,退回 agent 默认模型)。thinking 档位随本轮 chat.send 传入。
        if (opts?.model) {
          // 思考展示两个开关缺一不可:thinkingLevel(≠off,决定发给模型的 reasoning_effort)
          // + reasoningLevel(决定内核怎么把思考交出来)。仅当本轮启用思考(非 off)时才开启,
          // 避免非推理模型产生无谓开销。
          //
          // 内核对 reasoningLevel 两档的处理是互斥的:
          //   includeReasoning: reasoningMode === "on"     …思考随**最终消息**整块下发(不流式)
          //   streamReasoning:  reasoningMode === "stream" …逐段广播 `stream:"thinking"` 帧
          //
          // 用 `stream` 才有实时流,但它**依赖 scripts/patch-kernel-reasoning.mjs 的内核补丁**:
          // 原版内核把 streamReasoning 额外卡在 `typeof params.onReasoningStream === "function"`
          // 上,而该回调只有 Telegram 等渠道集成会传,走 chat.send 的表面(含我们)都不传,
          // 于是恒为 false。补丁去掉了这个闸门(与上游未合入的 PR #47613 等价)。
          //
          // 所以两者是一套:补丁不在时必须退回 `on`,否则 includeReasoning 与 streamReasoning
          // 双双为 false,思考会**彻底拿不到**。这里不靠人工同步,由 isReasoningStreamPatched()
          // 运行时自检决定,把"静默全损"降级成"退回非流式"。
          //
          // 档位与"要不要思考"是两件事:档位未知的模型(平台标了思考但家族表没命中,以及
          // 不接受 reasoning_effort 的族)不传 thinkingLevel,但仍要 reasoningLevel 开着,
          // 否则思考正文整块拿不到。所以优先听调用方显式给的 reasoning。
          const wantReasoning = opts.reasoning ?? (!!opts.thinking && opts.thinking !== 'off')
          const reasoningLevel = wantReasoning
            ? isReasoningStreamPatched()
              ? 'stream'
              : 'on'
            : 'off'
          try {
            await gatewayClient.patchSession(sessionKey, {
              // opts.model 已是内核完整键 `<provider>/<model>`(如 yunwu/deepseek-r1)。
              model: opts.model,
              thinkingLevel: opts.thinking,
              reasoningLevel
            })
          } catch (patchErr) {
            console.warn('[agent:send] sessions.patch 失败,回退默认模型:', patchErr)
          }
        }
        /**
         * 在正文前拼上本任务的工作目录。
         *
         * 这不是可选的装饰:会话上虽然设了 `spawnedCwd`(它确实成了 run 的 cwd,`exec` 跑
         * `cmd /c cd` 打印出来的就是任务目录),但系统提示里宣告的仍是 agent 的 workspace,
         * 模型据此给写文件工具传**绝对的 workspace 路径**,相对路径解析根本没被触发。
         * 2026-08-09 实测:不拼这行,文件落在 `~/.openclaw/workspace`;拼上之后落进任务目录。
         *
         * 每轮都拼,与内核自己的 ACP 桥(`src/acp/translator.ts`)一致——上下文一长,
         * 只在首条里出现过的目录会被模型忘掉。
         */
        const cwd = getSessionWorkspaceDir(sessionKey)
        /**
         * 专家团负责人还要多拿一段「派活时的运行时参数」(任务目录 + 本轮模型)。
         *
         * 判据取「这个专家声明了成员」而不是「名册真的生成了」:后者要读一遍人设表,
         * 而每轮发消息都读不划算。误判的代价只是给一条永远不派活的会话多一行文字。
         *
         * 为什么这段要在这里拼,而不是写进人设:见 teamDelegationRuntimeNote 的注释——
         * 两个值都是每条会话才知道的,静态人设装不下。
         */
        const teamNote = delegationNoteFor(sessionKey, cwd, opts?.model)
        const sent = await gatewayClient.chatSend(
          sessionKey,
          withWorkingDirectory(teamNote ? `${teamNote}\n\n${message}` : message, cwd),
          { thinking: opts?.thinking }
        )
        return ok(sent)
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

  // 读取某会话产出的文件用于预览(产出物卡片点开时调用;含越权防护与大小上限)。
  ipcMain.handle('artifact:read', (_e, sessionKey: string, filePath: string) => {
    try {
      return ok(readAgentArtifact(sessionKey, filePath))
    } catch (err) {
      return fail(err)
    }
  })

  // 批量取产出物文件大小(卡片副标题;比逐个读全文便宜得多)。
  ipcMain.handle('artifact:stat', (_e, sessionKey: string, paths: string[]) => {
    try {
      return ok(statAgentArtifacts(sessionKey, paths))
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * 首次发消息前把任务就位:建会话 + 指定它的工作目录。
   *
   * 这里是这次改造的核心。过去一个任务等于一个内核 agent,就位要 `agents.create`,
   * 而那会改 `agents.list` 并触发整轮网关热加载(实测堵 15~70 秒)。现在一个任务只是
   * 共享 agent 上的一条会话:`sessions.create` 实测 20~25ms,不碰配置、不触发热加载。
   *
   * 三步都必须做,少一步就有具体后果:
   *  1. 本地先把任务目录建出来 —— 内核不会替我们创建 `spawnedCwd` 指向的目录;
   *  2. `sessions.create` 幂等(同键重复调返回同一个 sessionId,实测),所以每次 ensure 都能安全重放;
   *  3. `sessions.patch` 写 `spawnedCwd`,这条会话此后的 run 就以任务目录为工作目录。
   *
   * 专家任务额外多一步:确保 `expert-<slug>` 这个**常驻** agent 存在。它一个专家只建一次,
   * 之后该专家的所有任务共用 —— 人设、技能、专家团委派都挂在它身上,不再每个任务播种一遍。
   */
  ipcMain.handle(
    'task:ensureSession',
    async (_e, sessionKey: string, expertSlug?: string, workspaceDir?: string) => {
      try {
        const parsed = parseTaskSessionKey(sessionKey)
        if (!parsed) {
          throw new Error(`无法解析任务会话键:${sessionKey}`)
        }
        /**
         * 先落绑定,再取 cwd:下面那行 `getTaskWorkspaceDir` 以及此后所有取工作目录的地方
         * 都从绑定表读,顺序反了这一轮就会用回一次性目录。
         *
         * 只在**传了值**时写。本接口每次发消息都会调,而工作空间只在新建任务那一刻选;
         * 续聊时渲染层不带这个参数,若把"没传"当成"选了不使用",第二条消息就会把
         * 前面绑好的工作空间解掉,任务当场换目录。
         */
        if (workspaceDir) {
          bindTaskWorkspace(parsed.taskId, workspaceDir)
        }
        // 旧任务(一任务一 agent 时代的 `agent:<taskId>:main`)原样沿用:它的 agent、
        // 工作区、实录都还在原处,重新 create 一条会话反而会造出第二份上下文。
        if (parsed.legacy) {
          return ok()
        }
        if (expertSlug && parsed.agentId !== DEFAULT_TASK_AGENT_ID) {
          /**
           * 挂在自己 agent 上的专家(今天只剩专家团,加上存量单体专家任务):
           * 召唤前先对齐市场最新人设(离线/失败时沿用本地副本,见 ensureExpertFresh)。
           */
          await ensureExpertFresh(expertSlug)
          await ensureAgent(parsed.agentId, expertSlug)
        } else if (expertSlug) {
          /**
           * 挂在 `main` 上的单体专家:人设由插件按会话注入,不再建 agent、也不写配置,
           * 于是省掉整轮 `agents.list` 热加载(实测 15 秒,首条消息正好撞在上面)。
           * 这里要做的只有两件:把人设对齐到市场最新,再把它刷进插件读的那份数据文件。
           */
          await ensureExpertFresh(expertSlug)
          syncPersonaData()
          ensureWorkspaceGuides(parsed.agentId)
        } else {
          /**
           * 普通任务挂在内核默认 agent `main` 上,而 `main` 不经我们的 `ensureAgent`,
           * 平台工具规约(TOOLS.md)就没人给它写了 —— 那份规约是 ask_user、卡片这些
           * 平台 UI 工具的使用说明,丢了模型就不会用它们。这里补上,幂等且只读写文件。
           */
          ensureWorkspaceGuides(parsed.agentId)
        }
        const cwd = getTaskWorkspaceDir(parsed.taskId)
        // 插件靠这张表把项目级记忆与技能注进这条会话,见 persona-bundle.ts。
        // 必须在 chat.send 之前落盘 —— 本接口每次发消息都会走,所以它天然是最新的。
        syncTaskWorkspaceData(parsed.taskId, cwd)
        await gatewayClient.createSession(sessionKey)
        await gatewayClient.patchSession(sessionKey, { spawnedCwd: cwd })
        return ok()
      } catch (err) {
        return fail(err)
      }
    }
  )

  /**
   * 删任务:删会话 + 把任务目录移进回收站。
   *
   * 不再走 `agents.delete`(实测 31~56 秒,要清会话绑定再把三个目录移进回收站,
   * 期间整个网关被拖住)。`sessions.delete` 实测 1.1~3.5 秒。
   *
   * 目录用 `shell.trashItem` 而不是 `rm`:与内核删 agent 时的做法一致(它也是移进回收站),
   * 用户误删还能捞回来 —— 里面是他自己的产出物。
   */
  ipcMain.handle('task:delete', async (_e, sessionKey: string) => {
    try {
      const parsed = parseTaskSessionKey(sessionKey)
      if (!parsed) {
        throw new Error(`无法解析任务会话键:${sessionKey}`)
      }
      await gatewayClient.deleteSession(sessionKey)
      /**
       * 只回收**我们自己建的一次性任务目录**。任务若绑了工作空间,那个文件夹是用户的
       * (可能就是他的项目根),删任务把它整个丢进回收站是灾难性的;WorkBuddy 删会话
       * 同样只是让会话消失,不动工作空间。绑定记录随任务一起清掉,但目录留在原地。
       */
      const bound = getTaskWorkspaceBinding(parsed.taskId)
      if (bound) {
        clearTaskWorkspaceBinding(parsed.taskId)
      } else {
        const dir = getTaskWorkspaceDir(parsed.taskId)
        if (existsSync(dir)) {
          await shell.trashItem(dir).catch((err) => {
            // 目录删不掉不该挡住任务从侧栏消失:会话已经删了,留个空目录不影响使用。
            console.warn('[task:delete] 任务目录移入回收站失败:', err)
          })
        }
      }
      clearSessionBuffer(sessionKey)
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
      // 后台向内核校正:找出「内核里有会话、本地元数据没记」的孤儿任务(首次迁移或外部改动),
      // 并行读各自首条消息作标题。此调用不阻塞首屏渲染。
      //
      // 依据从 `agents.list` 换成了会话索引:任务不再是 agent,扫 agents.list 只会翻出
      // 一任务一 agent 时代的存量。新旧两种键都由 listTaskSessionKeys 一并收上来。
      const known = new Set(knownIds)
      const orphanKeys = (await listTaskSessionKeys()).filter((key) => {
        const taskId = parseTaskSessionKey(key)?.taskId
        return taskId ? !known.has(taskId) : false
      })
      const orphans = await Promise.all(
        orphanKeys.map(async (sessionKey) => {
          const id = parseTaskSessionKey(sessionKey)!.taskId
          const history = await readSessionHistory(sessionKey)
          const firstUser = history.find((m) => m.role === 'user')
          return {
            id,
            title: firstUser ? firstUser.content.slice(0, 20) : '历史任务',
            sessionKey,
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

  ipcMain.handle('task:history', async (_e, sessionKey: string) => {
    try {
      return ok(await readSessionHistory(sessionKey))
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

  ipcMain.handle('workspace:openTask', async (_e, sessionKey: string) => {
    try {
      await shell.openPath(getSessionWorkspaceDir(sessionKey))
      return ok()
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('artifact:reveal', async (_e, sessionKey: string, filePath: string) => {
    try {
      const abs = resolveAgentArtifactPath(sessionKey, filePath)
      // showItemInFolder 在文件不存在时可能静默失败,先探测给出明确报错。
      if (!existsSync(abs)) {
        return fail(new Error('文件不存在(可能已被移动或删除)'))
      }
      shell.showItemInFolder(abs)
      return ok()
    } catch (err) {
      return fail(err)
    }
  })

  // ---- 本地 Agent 市场(技能 + 连接器;按 type 分派)----
  ipcMain.handle('market:snapshot', async (_e, type: MarketAssetType) => {
    try {
      return ok(await fetchMarketSnapshot(type))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('market:detail', async (_e, type: MarketAssetType, slug: string) => {
    try {
      return ok(await marketDetail(type, slug))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('market:install', async (_e, item: MarketItem, opts?: MarketInstallOptions) => {
    try {
      if (item.type === 'connector') {
        await installConnector(item, opts)
      } else if (item.type === 'expert') {
        await installExpert(item)
      } else {
        // 用户在市场点的安装:这类技能全局可见,不随任何专家收口(见 skill-visibility.ts)。
        await installSkill(item, true)
      }
      return ok()
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('market:uninstall', async (_e, type: MarketAssetType, slug: string) => {
    try {
      if (type === 'connector') {
        await uninstallConnector(slug)
      } else if (type === 'expert') {
        await uninstallExpert(slug)
      } else {
        uninstallSkill(type, slug)
      }
      return ok()
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('market:installed', async (_e, type: MarketAssetType) => {
    try {
      if (type === 'connector') {
        return ok(listInstalledConnectors())
      }
      if (type === 'expert') {
        // 通用安装态:把已安装专家投影为 MarketInstalledItem(基础字段)。
        return ok(
          listInstalledExperts().map((e) => ({
            type: 'expert' as const,
            slug: e.slug,
            name: e.name,
            version: e.version,
            installedAt: e.installedAt
          }))
        )
      }
      return ok(listInstalledSkills(type))
    } catch (err) {
      return fail(err)
    }
  })

  // 富信息专家列表(含 manifest),供 Composer 选择器/会话头部渲染与播种。
  ipcMain.handle('expert:list', async () => {
    try {
      return ok(listInstalledExperts())
    } catch (err) {
      return fail(err)
    }
  })

  // 精选场景(已上架)。kind 挑形状:专家页要 featured 大卡,首页案例区要 playbook。
  ipcMain.handle('scenario:list', async (_e, kind?: DesktopScenarioKind) => {
    try {
      return ok(await listScenarios(kind))
    } catch (err) {
      return fail(err)
    }
  })

  // 案例产物的预览直链:打开详情弹窗时现换一条(预签名会过期,不能跟列表一起缓存)。
  ipcMain.handle('scenario:artifact', async (_e, id: number) => {
    try {
      return ok(await scenarioArtifact(id))
    } catch (err) {
      return fail(err)
    }
  })

  // 首页场景(已上架,全量),供输入框上方那行胶囊渲染。
  ipcMain.handle('scene:list', async () => {
    try {
      return ok(await listScenes())
    } catch (err) {
      return fail(err)
    }
  })

  // AI 辅助技能:按需求检索市场技能 / 生成技能草稿 / 本地直装草稿。
  ipcMain.handle('market:aiFind', async (_e, need: string) => {
    try {
      return ok(await findSkills(need))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('market:aiCreate', async (_e, need: string) => {
    try {
      return ok(await generateSkill(need))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('market:aiInstallGenerated', async (_e, draft: AiSkillDraft) => {
    try {
      installGeneratedSkill(draft)
      return ok()
    } catch (err) {
      return fail(err)
    }
  })

  // 上传技能:从本地 zip 直装到 ~/.openclaw/skills/<slug>/。
  ipcMain.handle('market:installLocalZip', async (_e, filePath: string) => {
    try {
      return ok(installSkillFromLocalZip(filePath))
    } catch (err) {
      return fail(err)
    }
  })

  // 平台 UI 工具 ask_user:渲染层作答回填,兑现主进程内工具 handler 的阻塞 Promise。
  ipcMain.handle('ui-tool:answer', (_e, id: string, answers: unknown) => {
    try {
      return ok(uiToolsBridge.answer(id, answers))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('workspace:list', async () => {
    try {
      return ok(listWorkspaces())
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('workspace:create', async (_e, name: string) => {
    try {
      return ok(createWorkspace(name))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('workspace:pickDir', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: '选择工作空间文件夹',
        properties: ['openDirectory', 'createDirectory']
      })
      const dir = result.canceled ? '' : (result.filePaths[0] ?? '')
      return ok(dir ? registerWorkspace(dir) : null)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('prefs:get', async () => {
    try {
      return ok(loadPrefs())
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('prefs:set', async (_e, patch: Partial<AppPreferences>) => {
    try {
      return ok(savePrefs(patch))
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
