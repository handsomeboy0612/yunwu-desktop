import { execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { runtimeToolsDir, runtimePythonBinDir } from './openclaw-cli'

const run = promisify(execFile)

/** pip / npm 装包都可能跑几分钟(首次要编译 wheel),给足超时,免得半途被砍出坏环境。 */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 插件技能依赖的 Python 包。
 *
 * 这些**不是**插件,而是插件跑起来的底座:tencent-pptx 的技能文档把「读取用户上传的材料」
 * 全押在 Python 上(`python -m markitdown` 提正文、`doc_image_extractor.py` 抽图)。
 * 版本对齐 WorkBuddy 的托管环境(markitdown 0.1.7 / python-pptx 1.0.2 / pillow 12.3.0),
 * 免得同一份技能文档在两边跑出不同结果。
 */
const PYTHON_PACKAGES = [
  'markitdown[pptx,docx,xlsx,pdf]==0.1.7',
  'python-pptx==1.0.2',
  'pillow==12.3.0'
]

/** 记录已装配内容的指纹,避免每次启动都空跑一遍 pip / npm。 */
interface RuntimeMarker {
  python?: string
  engines?: Record<string, number>
}

function runtimeRoot(): string {
  return join(homedir(), '.openclaw', 'runtime')
}

function markerFile(): string {
  return join(runtimeRoot(), 'provisioned.json')
}

function readMarker(): RuntimeMarker {
  try {
    return JSON.parse(readFileSync(markerFile(), 'utf-8')) as RuntimeMarker
  } catch {
    return {}
  }
}

function writeMarker(next: RuntimeMarker): void {
  mkdirSync(runtimeRoot(), { recursive: true })
  writeFileSync(markerFile(), JSON.stringify(next, null, 2), 'utf-8')
}

const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name)

/** venv 里的解释器路径(可能尚不存在)。 */
function venvPython(): string {
  return join(runtimePythonBinDir(), exe('python'))
}

/**
 * 找一个能用来建 venv 的系统 Python。
 *
 * 刻意不自己下载解释器:那是几十 MB 的分发物 + 平台矩阵,而绝大多数开发机本就有 Python。
 * 一个都找不到时只告警——纯 Node 的技能(如 slidep 建 PPT)不受影响,只有「读取上传材料」
 * 这类需要 Python 的步骤会缺能力,不该因此拦住整个应用启动。
 */
async function findSystemPython(): Promise<string | null> {
  const candidates = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']
  for (const cmd of candidates) {
    try {
      const { stdout } = await run(cmd, ['--version'], { timeout: 15_000, windowsHide: true })
      // markitdown 要求 3.10+,低于此版本装不上,继续找下一个。
      const m = /(\d+)\.(\d+)/.exec(stdout)
      if (m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 10))) {
        return cmd
      }
    } catch {
      /* 该候选不存在,继续 */
    }
  }
  return null
}

/**
 * 装配受管 Python 环境:建 venv + 装包。
 *
 * 用 venv 而不是往系统 Python 里装:用户机器上的解释器可能被别的项目占着,往里塞包既可能
 * 撞版本,也可能被对方的 requirements 覆盖掉。独立 venv 让插件依赖与用户环境完全隔离。
 */
async function ensurePython(marker: RuntimeMarker): Promise<boolean> {
  const spec = PYTHON_PACKAGES.join(' ')
  const py = venvPython()
  if (marker.python === spec && existsSync(py)) {
    return false
  }

  if (!existsSync(py)) {
    const system = await findSystemPython()
    if (!system) {
      console.warn('[runtime] 未找到 Python 3.10+,跳过 Python 装配(读取上传材料的技能将不可用)')
      return false
    }
    console.log(`[runtime] 用 ${system} 创建受管 Python 环境…`)
    const args = system === 'py' ? ['-3', '-m', 'venv', join(runtimeRoot(), 'python')] : ['-m', 'venv', join(runtimeRoot(), 'python')]
    await run(system, args, { timeout: INSTALL_TIMEOUT_MS, windowsHide: true })
  }

  console.log('[runtime] 安装插件所需 Python 包(首次约需数分钟)…')
  await run(py, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', ...PYTHON_PACKAGES], {
    timeout: INSTALL_TIMEOUT_MS,
    windowsHide: true
  })
  marker.python = spec
  console.log('[runtime] Python 环境就绪')
  return true
}

/**
 * 装配插件自带的 Node 引擎。
 *
 * 有些技能只是"说明书",真正干活的引擎随插件以 npm tarball 形式分发(tencent-pptx 的
 * `vendor/tencent-slidep-*.tar.gz` 装出来才有 slidep-start 等命令)。插件自己带了
 * PreToolUse 钩子做这件事,但那个钩子按 WorkBuddy 的托管目录布局写的,在我们这儿(尤其
 * Windows)找不到路径。与其改插件,不如由宿主统一装配——插件包保持原样可随时整包替换。
 */
async function ensureNodeEngines(marker: RuntimeMarker): Promise<boolean> {
  const extRoot = join(homedir(), '.openclaw', 'extensions')
  if (!existsSync(extRoot)) {
    return false
  }
  const engines = marker.engines ?? {}
  let changed = false

  for (const plugin of readdirSync(extRoot)) {
    const vendor = join(extRoot, plugin, 'vendor')
    if (!existsSync(vendor)) {
      continue
    }
    for (const file of readdirSync(vendor)) {
      if (!/\.(tar\.gz|tgz)$/i.test(file)) {
        continue
      }
      const tarball = join(vendor, file)
      // 用体积当指纹:插件整包更新后 tarball 换版本、体积必变,足以触发重装。
      const size = statSync(tarball).size
      if (engines[file] === size) {
        continue
      }
      console.log(`[runtime] 安装插件引擎 ${plugin}/${file}…`)
      try {
        await npmInstallGlobal(tarball)
        engines[file] = size
        changed = true
      } catch (err) {
        console.warn(`[runtime] 引擎 ${file} 安装失败(该插件的相关技能将不可用):`, msgOf(err))
      }
    }
  }
  if (changed) {
    marker.engines = engines
  }
  return changed
}

/**
 * 把一个 tarball 装进受管引擎目录。
 *
 * Windows 必须走 shell:Node 自 18.20/20.12 起禁止直接 spawn `.cmd`(会抛 EINVAL),而 npm
 * 在 Windows 上正是 `npm.cmd`。走 shell 后参数是拼接而非转义的,所以路径一律加引号——
 * 用户主目录带空格(`C:\Users\John Doe`)时不加就会被拆成两个参数。
 */
async function npmInstallGlobal(tarball: string): Promise<void> {
  const win = process.platform === 'win32'
  const q = (s: string): string => (win ? `"${s}"` : s)
  const args = ['install', '-g', '--prefix', q(runtimeToolsDir()), q(tarball)]
  await run(win ? 'npm.cmd' : 'npm', args, {
    timeout: INSTALL_TIMEOUT_MS,
    windowsHide: true,
    shell: win
  })
}

const msgOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * 启动时装配插件运行时(受管 Python + 插件自带 Node 引擎)。
 *
 * 幂等:两部分各自按指纹短路,已装配则整个函数不落一次子进程调用。首次或插件更新后才真装。
 * 全程 best-effort——装配失败只是相应技能缺能力,不该拦住应用启动,故只告警不抛。
 */
export async function ensurePluginRuntime(): Promise<void> {
  const marker = readMarker()
  let changed = false
  try {
    changed = (await ensurePython(marker)) || changed
  } catch (err) {
    console.warn('[runtime] Python 装配失败:', msgOf(err))
  }
  try {
    changed = (await ensureNodeEngines(marker)) || changed
  } catch (err) {
    console.warn('[runtime] Node 引擎装配失败:', msgOf(err))
  }
  if (changed) {
    writeMarker(marker)
  }
}
