import { app, screen } from 'electron'
import type { BrowserWindow, Display, Rectangle } from 'electron'
import { join, dirname } from 'path'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'

/**
 * 窗口位置/尺寸持久化。
 *
 * 整体照 WorkBuddy `src/main/window/window-state.ts` 的形状做,包括它注释里点名的两个要点:
 *  - 存的是 `getNormalBounds()`(最大化之前的尺寸),这样从最大化还原时能回到一个合理的大小,
 *    而不是还原成全屏那么大;
 *  - 读回来的位置要拿当前接的显示器校验一遍,否则换过显示器/拔掉扩展屏之后,窗口会开在
 *    看不见的地方,表现为"程序启动了但找不到窗口"。
 *  - 运行期间显示器拓扑变了也要收一次(见 trackDisplayChanges)——上面那条只管启动那一刻。
 *
 * 我们以前完全不持久化,每次启动都硬编码回 1120×800 —— 用户调过的窗口大小一重启就没了。
 */

/** 首次启动的窗体尺寸,取自 WorkBuddy 的 `DEFAULTS = { width: 1200, height: 800 }`。 */
const DEFAULTS = { width: 1200, height: 800 }

/**
 * 最小尺寸这一项**不跟** WorkBuddy(它是 800×600),保留我们原来的 960×680。
 * 它敢放到 800 是因为渲染层有 <1000px 的响应式断点接着;我们的 styles.css 一条 @media 都没有,
 * 抄了数字没抄断点,等于放开一段从没适配过的宽度。等哪天补齐断点再降下来。
 */
export const MIN_WINDOW_WIDTH = 960
export const MIN_WINDOW_HEIGHT = 680

/** 落盘格式版本;对不上就当没存过,走默认值,避免读到旧结构后算出离谱的位置。 */
const STATE_VERSION = 2

export interface WindowState {
  bounds: Rectangle
  isMaximized: boolean
  isFullScreen: boolean
}

function stateFilePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

/** 这块矩形是否至少有一部分落在某个显示器的工作区里。 */
function isVisibleOnAnyDisplay(bounds: Rectangle): boolean {
  return screen.getAllDisplays().some((display) => {
    const { x, y, width, height } = display.workArea
    return (
      bounds.x < x + width &&
      bounds.x + bounds.width > x &&
      bounds.y < y + height &&
      bounds.y + bounds.height > y
    )
  })
}

/** 保持宽高不变,把窗口摆到主显示器工作区正中。 */
function centerOnPrimary(bounds: { width: number; height: number }): Rectangle {
  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: Math.round(workArea.x + (workArea.width - bounds.width) / 2),
    y: Math.round(workArea.y + (workArea.height - bounds.height) / 2),
    width: bounds.width,
    height: bounds.height
  }
}

/** 把矩形收进工作区:超出就先缩到工作区那么大,再推回边界内。 */
function clampBoundsToWorkArea(bounds: Rectangle, workArea: Rectangle): Rectangle {
  const width = Math.min(bounds.width, workArea.width)
  const height = Math.min(bounds.height, workArea.height)
  let x = bounds.x
  let y = bounds.y
  if (x < workArea.x) {
    x = workArea.x
  }
  if (y < workArea.y) {
    y = workArea.y
  }
  if (x + width > workArea.x + workArea.width) {
    x = workArea.x + workArea.width - width
  }
  if (y + height > workArea.y + workArea.height) {
    y = workArea.y + workArea.height - height
  }
  return { x, y, width, height }
}

/** 读取上次的窗口状态;没存过、格式对不上或解析失败时回落到默认尺寸并居中。 */
export function loadWindowState(): WindowState {
  const fallback: WindowState = {
    bounds: centerOnPrimary(DEFAULTS),
    isMaximized: false,
    isFullScreen: false
  }
  try {
    const state = JSON.parse(readFileSync(stateFilePath(), 'utf-8')) as Partial<WindowState> & {
      version?: number
    }
    if (state.version !== STATE_VERSION || !state.bounds) {
      return fallback
    }
    return {
      // 存的位置可能来自一块已经拔掉的显示器,那样窗口会开在视野外 —— 只保留尺寸,重新居中。
      bounds: isVisibleOnAnyDisplay(state.bounds) ? state.bounds : centerOnPrimary(state.bounds),
      isMaximized: !!state.isMaximized,
      isFullScreen: !!state.isFullScreen
    }
  } catch {
    return fallback
  }
}

/** 落盘当前窗口状态。写失败不抛:存不下窗口大小不该影响任何主流程。 */
export function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) {
    return
  }
  try {
    const state = {
      version: STATE_VERSION,
      bounds: win.getNormalBounds(),
      isMaximized: win.isMaximized(),
      isFullScreen: win.isFullScreen()
    }
    mkdirSync(dirname(stateFilePath()), { recursive: true })
    writeFileSync(stateFilePath(), JSON.stringify(state))
  } catch {
    /* 忽略:窗口状态存不下不影响使用 */
  }
}

/**
 * 显示器拓扑变化(改分辨率、改缩放、拔掉扩展屏)之后,把窗口收回新的工作区。
 * 照 WorkBuddy 的 `displayMetricsHandler` 做,包括它那步容易被漏掉的「最小尺寸也要跟着压」:
 * 我们的最小尺寸是 960×680,比 WorkBuddy 的 800×600 更大,一旦工作区比 960 还窄
 * (小屏笔记本开高缩放就会),不把 minimumSize 一起降下来,窗口宽度就卡在 960 收不进屏幕,
 * 钳位算出来的结果也设不进去。所以这一步对我们比对它更要紧。
 */
function trackDisplayChanges(win: BrowserWindow): () => void {
  const onDisplayMetricsChanged = (
    _event: Electron.Event,
    _display: Display,
    changedMetrics: string[]
  ): void => {
    if (win.isDestroyed()) {
      return
    }
    // 只有工作区/分辨率变了才影响窗口能摆在哪;色深、旋转之类的变化不用管。
    if (!changedMetrics.includes('workArea') && !changedMetrics.includes('bounds')) {
      return
    }
    // 最大化/全屏/最小化时窗口尺寸由系统托管,它自己会适配新工作区,这时候插手只会打架。
    if (win.isMaximized() || win.isFullScreen() || win.isMinimized()) {
      return
    }
    const current = win.getBounds()
    const { workArea } = screen.getDisplayMatching(current)

    const minWidth = Math.min(MIN_WINDOW_WIDTH, workArea.width)
    const minHeight = Math.min(MIN_WINDOW_HEIGHT, workArea.height)
    const [currentMinWidth, currentMinHeight] = win.getMinimumSize()
    if (minWidth !== currentMinWidth || minHeight !== currentMinHeight) {
      win.setMinimumSize(minWidth, minHeight)
    }

    const clamped = clampBoundsToWorkArea(current, workArea)
    if (
      clamped.x !== current.x ||
      clamped.y !== current.y ||
      clamped.width !== current.width ||
      clamped.height !== current.height
    ) {
      win.setBounds(clamped)
    }
  }

  screen.on('display-metrics-changed', onDisplayMetricsChanged)
  return () => screen.removeListener('display-metrics-changed', onDisplayMetricsChanged)
}

/**
 * 把窗口的尺寸/位置变化接到防抖落盘上,并返回一个「立即存一次」的函数供退出前调用。
 * 防抖 500ms 取自 WorkBuddy 的 `scheduleSaveState()` —— 拖拽窗口时 resize/move 每帧都在触发,
 * 不防抖就是一秒几十次写盘。
 */
export function trackWindowState(win: BrowserWindow): () => void {
  let timer: NodeJS.Timeout | null = null
  const schedule = (): void => {
    if (timer) {
      clearTimeout(timer)
    }
    timer = setTimeout(() => {
      timer = null
      saveWindowState(win)
    }, 500)
  }

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    saveWindowState(win)
  }

  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('maximize', schedule)
  win.on('unmaximize', schedule)
  win.on('enter-full-screen', schedule)
  win.on('leave-full-screen', schedule)
  // 存最后一次要挂在窗口的 close 上,不能只靠 app 的 before-quit:Windows 点 X 的顺序是
  // close → closed → window-all-closed → app.quit() → before-quit,轮到 before-quit 时
  // 窗口已经销毁,getNormalBounds() 拿不到了,最后一次改动就丢了。
  win.on('close', flush)

  // screen 是进程级的 emitter,不像窗口自己的监听会随窗口一起销毁 —— 不摘掉就会一直攥着
  // 这个已销毁的 win,重建窗口时还会叠一份。
  const untrackDisplays = trackDisplayChanges(win)
  win.on('closed', untrackDisplays)

  return flush
}
