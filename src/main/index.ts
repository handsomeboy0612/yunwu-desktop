import { app, shell, BrowserWindow, Menu, nativeTheme } from "electron";
import { join } from "path";
import { release } from "os";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import { registerIpc } from "./ipc";
import { openClawManager } from "./openclaw-manager";
import {
  gatewayClient,
  normalizeAgentEvent,
  type GatewayEventFrame,
} from "./gateway-client";
import { recordAgentEvent } from "./event-buffer";
import { attachTeamRelay } from "./team-relay";
import { mediaRelay, type MediaTaskProgress } from "./media-relay";
import { attachSessionIndex } from "./session-index";
import { readLatestPlanArgs } from "./session-history";
import { PLAN_TOOL_NAMES, parsePlanSteps } from "@shared/tool-parse";
import { preflight } from "./preflight";
import { startUiToolsServer, uiToolsBridge } from "./ui-tools-server";
import { syncUiToolsBundle } from "./ui-tools-bundle";
import { syncPersonaBundle, syncPersonaData } from "./persona-bundle";
import { syncYunwuVideoBundle } from "./yunwu-video-bundle";
import {
  applyStartupConfig,
  removeLegacyUiToolsMcpEntry,
  removeStaleImageGenerationModel,
  removeStaleTtsProvider,
  removeStaleVideoGenerationModel,
  syncAccountModels,
  resyncKernelProvidersIfMissing,
  setConfigSyncErrorHandler,
} from "./config-writer";
import { loadActivation } from "./store";
import {
  loadModelProfilesFromCache,
  refreshModelProfiles,
} from "./model-profiles";
import { sweepStaleInstallDirs } from "./market/installer";
import { reconcileSkillVisibility } from "./market/skill-visibility";
import {
  pruneUnusedExpertAgents,
  stripAgentSkillFilters,
} from "./agent-manager";
import { autoUpdateMarketAssets } from "./market/auto-update";
import { ensurePluginRuntime } from "./plugin-runtime";
import {
  loadWindowState,
  trackWindowState,
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
} from "./window-state";
import type {
  AgentEvent,
  GatewayStatus,
  PreflightReport,
  AskRequest,
  WidgetRequest,
  PresentRequest,
} from "@shared/types";

/**
 * 为 `update_plan` 事件补齐入参,让运行时也能落成勾选卡。
 *
 * 网关的 embedded 管线不广播 `stream:"tool"` 子流,`stream:"item"` 帧里只有一个被截断的
 * `meta` 字符串,拿不到完整步骤与勾选状态 —— 不补的话运行时**什么都渲染不出来**,
 * 只有重开历史才看得到清单。这里回读会话 jsonl(与历史还原同源)把结构化入参塞回 evt.input,
 * 渲染层无需改动即可解析。
 *
 * 代价可控:仅在命中计划工具且入参确实解析不出步骤时才读盘,计划事件一轮至多数次。
 * 读盘失败或尚未落盘时保持原样(下一帧或重开历史仍会补上),不影响其它事件转发。
 */
function enrichPlanInput(evt: AgentEvent): void {
  if (
    evt.kind !== "tool" ||
    !PLAN_TOOL_NAMES.has((evt.name ?? "").toLowerCase())
  ) {
    return;
  }
  if (parsePlanSteps(evt.input).length > 0) {
    return;
  }
  try {
    const args = readLatestPlanArgs(evt.sessionKey);
    if (args && parsePlanSteps(args).length > 0) {
      evt.input = args;
    }
  } catch {
    /* 补齐失败不影响事件本身的转发 */
  }
}

/** 退出前把窗口状态立刻落一次盘,补上防抖窗口内(最后 500ms)那次改动。 */
let flushWindowState: (() => void) | null = null;

/**
 * Windows 系统绘制的背景材质(云母)。照 WorkBuddy 的 `getWindowsBackgroundMaterial()`,
 * 但门槛按 Electron 43 的实际支持面收紧:它 `setBackgroundMaterial` 的文档写明「仅 Windows 11
 * 22H2 及以上」,所以 WorkBuddy 那条「build ≥ 17763 给 acrylic」的分支在当前 Electron 上是空转的
 * (那段标着来自 craft-agents-oss,写在支持范围收窄之前),这里不跟。22H2 = build 22621。
 *
 * 留 --disable-background-material 开关是因为这东西走 GPU 合成:WorkBuddy 为它专门做了
 * 「GPU 崩过就永久降级」的持久化兜底,我们没有那套崩溃重建管线,至少得给条手动退路。
 */
function getWindowsBackgroundMaterial(): "mica" | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }
  if (app.commandLine.hasSwitch("disable-background-material")) {
    return undefined;
  }
  const build = Number.parseInt(release().split(".")[2] || "0", 10);
  return build >= 22621 ? "mica" : undefined;
}

/** 创建主窗口并加载渲染层(dev 走 vite dev server,prod 走打包后的 index.html)。 */
function createWindow(): void {
  // 恢复上次的窗口位置/尺寸;没存过则用 WorkBuddy 的首启体量 1200×800 居中。
  const savedState = loadWindowState();
  const backgroundMaterial = getWindowsBackgroundMaterial();
  const mainWindow = new BrowserWindow({
    ...savedState.bounds,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    title: "Yunwu Desktop",
    // 无边框自定义标题栏:窗口控制按钮(最小化/最大化/关闭)由渲染层自绘,尺寸与整体 UI 对齐;
    // 顶部拖拽区用 -webkit-app-region: drag 提供,按钮区用 no-drag 排除。
    //
    // 写成 frame:false 是为了和 WorkBuddy 的 Windows 分支同形。**它和原来的
    // titleBarStyle:'hidden' 在 Electron 43 上产出的是同一种窗口**,别以为换了会改变尺寸:
    // 两种配置量下来 Win32 样式位都是 0x14C70000,ClientRect 都正好等于请求的 bounds。
    // 顺带记一笔免得下次又去查:GetWindowRect 会比客户区大 16×8,那是 Chromium 给无边框窗口
    // 留的不可见拖拽边,用户看不见(DWM 可见框只比客户区大 2×1)。
    frame: false,
    // 内容画出来之前先铺一层底色,免得启动瞬间闪一下白。取值必须跟 body 的 --bg-sidebar
    // 一致 —— 主区只切上面两角,露出来的那两块和窗口左侧一整条都是侧栏色,铺纯白会在启动
    // 那一帧闪出一整片白底。
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b1d20" : "#f2f2f2",
    ...(backgroundMaterial ? { backgroundMaterial } : {}),
    // 不抄 WorkBuddy 那项 titleBarOverlay:Electron 43 的类型注释写明它要「有 titleBarStyle
    // 让系统窗口按钮可见」才生效,而 frame:false 下系统按钮根本不显示,所以它在它那边也是
    // 惰性配置;真要生效反而会和我们自绘的那套按钮叠成两份。
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
    },
  });

  flushWindowState = trackWindowState(mainWindow);

  // 用 once 而不是 on:reload 之后 ready-to-show 还会再来一次,那时若又照存档最大化一遍,
  // 就会把用户中途手动还原的窗口重新顶满。
  mainWindow.once("ready-to-show", () => {
    // 最大化/全屏是单独存的:bounds 存的是还原态尺寸,不带这两个标志就永远开在窗口态。
    // 必须放在 show() 前的这一刻,而不是 new BrowserWindow 之后立刻调 —— Windows 上对一个
    // 还没 show 的窗口调 maximize(),会顺带把它显示出来,`show: false` 等于白设,
    // 用户会先看到一个空白窗口再看到内容。
    if (savedState.isFullScreen) {
      mainWindow.setFullScreen(true);
    } else if (savedState.isMaximized) {
      mainWindow.maximize();
    }
    mainWindow.show();
  });

  // 自绘窗口按钮需要知道当前是否最大化(切换"最大化/还原"图标)。
  const forwardMaximized = (): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("window:maximized", mainWindow.isMaximized());
    }
  };
  mainWindow.on("maximize", forwardMaximized);
  mainWindow.on("unmaximize", forwardMaximized);

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  // 把网关状态变化实时转发给渲染层。
  const forward = (status: GatewayStatus): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("gateway:status", status);
    }
  };
  openClawManager.on("status", forward);

  // 把网关 agent 运行事件(文字增量/工具步骤/生命周期)归一化后转发给渲染层。
  const forwardAgentEvent = (frame: GatewayEventFrame): void => {
    const evt = normalizeAgentEvent(frame);
    if (evt) {
      enrichPlanInput(evt);
      /** 旁路缓冲,供断线重连后重放(幂等重放,不依赖 seq)。 */
      recordAgentEvent(evt);
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send("agent:event", evt);
      }
    }
  };
  gatewayClient.on("event", forwardAgentEvent);

  // 专家团成员跑完后,把它的产出投回负责人会话——内核自己那条投递对我们的 `acp:` 会话
  // 必定失败(详见 team-relay.ts 顶部)。挂在同一条事件流上,与上面的渲染转发互不影响。
  attachTeamRelay();

  // 媒体后台任务(出图/出视频)的完成投递同理落空,补一条;顺带把进度推给渲染层做占位卡。
  // 与 team-relay 是同一类修复,原因与证据见 media-relay.ts 顶部。
  const forwardMediaProgress = (progress: MediaTaskProgress): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("media:progress", progress);
    }
  };
  mediaRelay.on("progress", forwardMediaProgress);
  mediaRelay.start();

  // 会话索引跟着同一条事件流走:定位历史实录、判断专家/agent 有没有被用过都靠它。
  // 只挂监听、不在这里拉清单——拉清单是启动链里的一步,别占首屏(详见 session-index.ts)。
  attachSessionIndex();

  // 把自检进度逐步转发给渲染层(启动/新建任务的准备态)。
  const forwardPreflight = (report: PreflightReport): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("preflight:step", report);
    }
  };
  preflight.on("step", forwardPreflight);

  // 平台 UI 工具 ask_user:主进程内工具 handler 发起提问 → 转发渲染层弹表单,
  // 用户作答经 IPC(ui-tool:answer)回填,兑现 handler 的阻塞 Promise 后模型继续。
  const forwardAsk = (req: AskRequest): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("ui-tool:ask", req);
    }
  };
  uiToolsBridge.on("ask", forwardAsk);

  // 平台 UI 工具 show_widget / present_files:非阻塞,直接把事件转发渲染层渲染卡片/抽屉。
  const forwardWidget = (req: WidgetRequest): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("ui-tool:widget", req);
    }
  };
  const forwardPresent = (req: PresentRequest): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("ui-tool:present", req);
    }
  };
  uiToolsBridge.on("widget", forwardWidget);
  uiToolsBridge.on("present", forwardPresent);

  // 模型配置改动是「写完 providers.json 就返回」的,内核下发在后台队列里跑;
  // 只有它失败了才需要打扰用户,故单独走一条事件通道。
  setConfigSyncErrorHandler((message) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("config:sync-error", message);
    }
  });

  mainWindow.on("closed", () => {
    openClawManager.off("status", forward);
    gatewayClient.off("event", forwardAgentEvent);
    preflight.off("step", forwardPreflight);
    uiToolsBridge.off("ask", forwardAsk);
    uiToolsBridge.off("widget", forwardWidget);
    uiToolsBridge.off("present", forwardPresent);
    setConfigSyncErrorHandler(null);
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId("ai.yunwu.desktop");

  // 去掉系统应用菜单栏,配合自定义标题栏获得干净的一体化外观。
  Menu.setApplicationMenu(null);

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  registerIpc();

  // 回收上次安装遗留的临时/墓地目录。放在启动早期:此时内核对旧技能目录的句柄多已随
  // 上次退出释放,是清理 Windows delete-pending 残骸的最佳时机。
  try {
    sweepStaleInstallDirs();
  } catch (err) {
    console.warn("[market] 清扫遗留安装目录失败:", err);
  }

  // 后台下发的模型参数覆盖:启动**只读磁盘缓存**(一次小 JSON 读),网络刷新排到下面那条
  // 资产对齐链上。必须在 syncAccountModels 之前,否则这次启动写进内核的还是没覆盖的能力。
  loadModelProfilesFromCache();

  // 启动主进程内置「平台 UI 工具」MCP server(监听静态命名管道,不碰配置),再把登记
  // 落到内核的插件包里。登记走 ~/.openclaw/extensions 下的 .mcp.json 而非 openclaw.json,
  // 主配置因此在稳态下一次都不用写 —— 每次落盘都会触发一轮网关热加载,而它此时正忙着
  // 预热 provider auth(实测 40.8 秒),多写一次就多堵一轮。详见 ui-tools-bundle.ts。
  void startUiToolsServer()
    .then((pipePath) => syncUiToolsBundle(pipePath))
    .catch((err) => console.warn("[ui-tools] MCP server 启动失败:", err))
    // 人设插件同样投进 ~/.openclaw/extensions。它替掉了「一个专家一个 agent」——
    // 专家人设改由 before_prompt_build 钩子按会话注入,详见 persona-bundle.ts。
    // 排在这里而不是更晚:首次安装当次网关未必加载得到,越早装越可能赶上这次启动。
    .then(() => syncPersonaBundle())
    .catch((err) => console.warn("[persona] 人设插件登记失败:", err))
    // 视频生成插件:走云雾统一异步接口,详见 resources/yunwu-video-plugin。
    // 与人设同口径排在启动早期,首次安装当次才赶得上这次网关加载。
    .then(() => syncYunwuVideoBundle())
    .catch((err) => console.warn("[yunwu-video] 视频插件登记失败:", err))
    // 下发运行期策略(引导文件裁剪 + 供货商请求超时)。
    // best-effort:失败只是回退到内核默认,不阻塞启动。
    .then(() => applyStartupConfig())
    // 存量安装的 mcp.servers.yw 指向早已失效的临时端口,且会盖住插件包那份同名 server。
    // 只在它还在时才写一次,删干净后每次启动都直接返回。
    .then(() => removeLegacyUiToolsMcpEntry())
    // 换过 key / 模型下架后,旧的出图模型选择会让内核照样上架一台坏工具,清掉它。
    .then(() => removeStaleImageGenerationModel())
    .then(() => removeStaleVideoGenerationModel())
    .then(() => removeStaleTtsProvider())
    // 把内置云雾供货商对齐到该账号此刻生效的模型清单。存量安装的那份是激活当时按账号拉的
    // 快照(老版本会截前 40 个),不对齐就一直留着:那 40 个里没有 gpt-image-*,
    // 出图工具从来没被注册过(详见 syncAccountModels)。纯本地比对,未登录时跳过。
    .then(async () => {
      const act = loadActivation();
      if (act) {
        // 激活时的下发失败不再阻断登录,代价是可能留下「已登录但内核不知道有这个账号」的
        // 状态;补渲染放在对齐之前,让后面那步在完整的配置上做增量。
        resyncKernelProvidersIfMissing(act);
        await syncAccountModels(act);
      }
    })
    .catch((err) => console.warn("[config] 启动配置下发失败:", err))
    // 存量专家会话的 skills 白名单会挡住后装的插件技能,启动时清一次(自身幂等且已吞异常)。
    // 串在链上而非并发:两者写的是同一份 openclaw.json,走不同队列,并发会互相覆盖。
    .then(() => stripAgentSkillFilters())
    // 刷新后台下发的模型参数覆盖(这一步才打网络,同一台 admin-server、同一把令牌)。
    // 覆盖表真的变了才重下发一次:syncAccountModels 内部再按能力指纹判 noop,
    // 所以稳态下这里是零落盘。拉不到 / 未登录时沿用缓存,家族表照常工作。
    .then(async () => {
      const act = loadActivation();
      if (!act) {
        return;
      }
      if (await refreshModelProfiles()) {
        await syncAccountModels(act);
      }
    })
    // 已装专家/技能对齐市场最新版(对齐 WorkBuddy 的 autoUpdate,用户无需去点更新按钮)。
    // 自身逐条吞异常,离线/未登录时静默跳过。
    .then(() => autoUpdateMarketAssets())
    // 技能可见性收口:专家带进来的技能藏出全局名录、改由该专家的会话注入,没人再引用的
    // 回收掉。必须排在自动更新**之后** —— 更新是整目录换入,会把 SKILL.md 上的隐藏标记
    // 一起冲掉(归属记在 meta 里,那个能活下来)。详见 skill-visibility.ts。
    .then(() => reconcileSkillVisibility())
    // 自动更新可能换过人设正文,刷一遍插件读的那份数据(内容不变不落盘)。
    // 这一步替掉了从前的「给每个专家补种 agent」:那要写 agents.list、顶一轮网关热加载,
    // 而每多一个 agent 都会让此后每次冷启动的 provider auth 预热更慢(见 persona-bundle.ts)。
    .then(() => syncPersonaData())
    // 再把存量安装攒下的、一次都没用过的专家 agent 删掉——它们正是上面那笔预热开销的来源。
    // 排在最后:它写 agents.list、要分几轮,而前面几步都不能被它拖。
    .then(() => pruneUnusedExpertAgents())
    .catch((err) => console.warn("[market] 启动期资产对齐失败:", err));

  // 装配插件运行时(受管 Python + 插件自带 Node 引擎)。独立于上面那条链:它不写
  // openclaw.json,没有竞争;且首次装包要几分钟,串进去会把 MCP 登记一起拖住。
  void ensurePluginRuntime();

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  // 窗口销毁前存最后一次:防抖还没到点就退出的话,用户最后那次拖拽会丢。
  flushWindowState?.();
});

app.on("window-all-closed", () => {
  // 关闭窗口时先断开网关 WS 客户端,再回收本地网关进程,避免残留。
  gatewayClient.close();
  openClawManager.stop();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
