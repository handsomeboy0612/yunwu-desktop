import { spawn } from 'child_process'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

/**
 * How to launch the OpenClaw kernel on this machine.
 *
 * Resolution priority (mirrors WorkBuddy's resolveCLIPath):
 *   1. bundled — kernel shipped inside the app (resources/openclaw/openclaw.mjs),
 *      run via the Electron binary acting as Node (ELECTRON_RUN_AS_NODE=1).
 *      This is the zero-install release path; openclaw is pure ESM with no
 *      native .node modules, so there is no ABI risk.
 *   2. env     — OPENCLAW_BIN override (dev / custom install).
 *   3. path    — global `openclaw` on PATH (dev fallback; requires npm i -g).
 */
export interface OpenClawLaunch {
  /** Executable to spawn. */
  command: string
  /** Leading args (e.g. the openclaw.mjs script path) prepended before subcommand args. */
  baseArgs: string[]
  /** Extra env merged over process.env when spawning. */
  env: NodeJS.ProcessEnv
  /** Whether the spawn must go through a shell (needed for PATH .cmd shim on Windows). */
  useShell: boolean
  /** Which branch of the priority chain resolved. */
  source: 'bundled' | 'env' | 'path'
  /** Human-readable resolution paths tried, for diagnostics / preflight display. */
  tried: string[]
}

/**
 * 插件自带引擎的安装目录。
 *
 * 有些技能只是"说明书",真正的引擎随插件以 npm tarball 形式分发(如 tencent-pptx 的
 * `vendor/tencent-slidep-*.tar.gz`,装出来提供 slidep-start / slidep-script 等命令)。
 * 我们把这类引擎统一装到这里,再把本目录前置进内核的 PATH。
 */
export function runtimeToolsDir(): string {
  return join(homedir(), '.openclaw', 'runtime', 'node-tools')
}

/**
 * 插件用的受管 Python 解释器目录(venv 的可执行目录)。
 *
 * 技能文档把「读取用户上传的材料」全押在 Python 上:`python -m markitdown <file>` 提正文、
 * `doc_image_extractor.py` 抽图。二者都只用 python-pptx/docx/openpyxl,**不需要 LibreOffice**
 * ——只有渲染风格预览图的 pptx2image.py 才要 soffice,那是可选加分项(WorkBuddy 也没装)。
 */
export function runtimePythonBinDir(): string {
  const venv = join(homedir(), '.openclaw', 'runtime', 'python')
  return join(venv, process.platform === 'win32' ? 'Scripts' : 'bin')
}

/**
 * spawn 内核时要额外注入的环境变量:插件引擎目录进 PATH,并补齐技能文档约定的 *_BIN_DIR。
 *
 * 为什么必须进 PATH:技能文档里写的是**裸命令**(`slidep-start ...`),不进 PATH 模型
 * 就只能去猜绝对路径,而它猜不到我们的安装位置。
 *
 * 为什么要找 PATH 的真实键名:Windows 上 process.env 里通常是 `Path`。若我们直接写
 * `PATH`,子进程会同时拿到 `Path`(原值)和 `PATH`(新值),取哪个由系统决定——实际表现
 * 就是"注入了但不生效"。按现有键名覆盖可绕开这个坑。
 *
 * NODE_BIN_DIR / NPM_BIN_DIR / PYTHON_BIN_DIR 是 tencent-pptx 这类插件的既定契约(它们的
 * SKILL.md 直接拿 `${PYTHON_BIN_DIR}/python` 拼命令),不给就只能靠模型瞎猜路径。node 本身
 * 不在 node-tools 里,但 npm 生成的 .cmd shim 会在同目录找不到 node.exe 时回落到 PATH,
 * 插件的 ensure-runtime 钩子同样声明了这个回落,所以指向 shim 目录即可。
 *
 * PYTHONIOENCODING:插件脚本的进度输出带 emoji,而 Windows 上 Python 的 stdout 默认是 gbk,
 * 编码失败会直接抛 UnicodeEncodeError 让整个抽图步骤挂掉(实测 doc_image_extractor.py 必踩)。
 */
function pluginRuntimeEnv(): NodeJS.ProcessEnv {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const sep = process.platform === 'win32' ? ';' : ':'
  const current = process.env[key]
  const tools = runtimeToolsDir()
  const python = runtimePythonBinDir()
  const prefix = [tools, python].join(sep)
  return {
    [key]: current ? `${prefix}${sep}${current}` : prefix,
    NODE_BIN_DIR: tools,
    NPM_BIN_DIR: tools,
    PYTHON_BIN_DIR: python,
    PYTHONIOENCODING: 'utf-8'
  }
}

/** Absolute path to the bundled kernel entry, or null when not packaged (dev). */
function bundledKernelEntry(): string | null {
  const base = process.resourcesPath
  if (!base) {
    return null
  }
  const mjs = join(base, 'openclaw', 'openclaw.mjs')
  return existsSync(mjs) ? mjs : null
}

/**
 * 缓存:内核是否已应用「思考流式」补丁(见 scripts/patch-kernel-reasoning.mjs)。
 * undefined 表示尚未检测。内核在进程生命周期内不会换,检测一次即可。
 */
let reasoningPatchState: boolean | undefined

/**
 * 判断当前将要启动的内核是否已解除思考流的回调闸门。
 *
 * 为什么要在运行时再查一遍:`reasoningLevel` 的两档是互斥的 —— 补丁在时必须用 `stream`
 * 才有实时流,补丁不在时若仍用 `stream`,则 includeReasoning 与 streamReasoning 双双为
 * false,深度思考会**彻底消失**(比不修还糟,且运行时毫无提示)。构建链虽已用
 * `patch:kernel` 兜底(匹配不到即非零退出),但绕过 `npm run pack` 手工构建仍可能漏掉,
 * 故这里做一次廉价自检,把"静默全损"降级成"退回非流式"。
 *
 * 只在能廉价定位到内核目录时检测(bundled / OPENCLAW_BIN);走 PATH 的开发态由
 * `predev` 钩子保证已打补丁,直接视为已打,避免在启动路径上跑 `npm root -g`。
 */
export function isReasoningStreamPatched(): boolean {
  if (reasoningPatchState !== undefined) {
    return reasoningPatchState
  }
  const launch = resolveOpenClawLaunch()
  const entry = launch.baseArgs[0]
  if (launch.source === 'path' || !entry || !entry.endsWith('.mjs')) {
    reasoningPatchState = true
    return reasoningPatchState
  }
  const distDir = join(dirname(entry), 'dist')
  if (!existsSync(distDir)) {
    reasoningPatchState = true
    return reasoningPatchState
  }
  try {
    for (const name of readdirSync(distDir)) {
      if (!name.endsWith('.js')) {
        continue
      }
      const src = readFileSync(join(distDir, name), 'utf-8')
      if (!src.includes('emitReasoningStream') || !src.includes('streamReasoning')) {
        continue
      }
      /** 闸门特征还在 → 未打补丁。 */
      reasoningPatchState =
        !/streamReasoning:[^\n]*typeof params\.onReasoningStream === "function"/.test(src)
      if (!reasoningPatchState) {
        console.warn(
          '[openclaw] 内核未应用思考流补丁,本次深度思考将退回「轮末整块输出」。' +
            `请执行 npm run patch:kernel(内核目录:${dirname(entry)})`
        )
      }
      return reasoningPatchState
    }
  } catch {
    /* 读盘失败按已打补丁处理,不阻断启动 */
  }
  reasoningPatchState = true
  return reasoningPatchState
}

/**
 * Resolve how to launch OpenClaw. Always returns a launch descriptor; when
 * nothing bundled/overridden is found it falls back to PATH `openclaw` (a
 * subsequent spawn ENOENT is surfaced by the manager's early-exit diagnostics).
 */
export function resolveOpenClawLaunch(): OpenClawLaunch {
  const tried: string[] = []

  /** 1) Bundled kernel (release): run openclaw.mjs with Electron-as-Node. */
  const resourcesBase = process.resourcesPath
  tried.push(
    `bundled: ${resourcesBase ? join(resourcesBase, 'openclaw', 'openclaw.mjs') : '(no resourcesPath)'}`
  )
  const bundled = bundledKernelEntry()
  if (bundled) {
    return {
      command: process.execPath,
      baseArgs: [bundled],
      env: { ELECTRON_RUN_AS_NODE: '1', ...pluginRuntimeEnv() },
      useShell: false,
      source: 'bundled',
      tried
    }
  }

  /** 2) OPENCLAW_BIN override. */
  const envBin = process.env.OPENCLAW_BIN?.trim()
  if (envBin) {
    tried.push(`OPENCLAW_BIN: ${envBin}`)
    if (existsSync(envBin)) {
      const isScript = /\.(mjs|cjs|js)$/i.test(envBin)
      if (isScript) {
        return {
          command: process.execPath,
          baseArgs: [envBin],
          env: { ELECTRON_RUN_AS_NODE: '1', ...pluginRuntimeEnv() },
          useShell: false,
          source: 'env',
          tried
        }
      }
      return {
        command: envBin,
        baseArgs: [],
        env: pluginRuntimeEnv(),
        useShell: process.platform === 'win32',
        source: 'env',
        tried
      }
    }
  }

  /** 3) PATH fallback (dev): global openclaw shim. */
  tried.push('PATH: openclaw')
  return {
    command: 'openclaw',
    baseArgs: [],
    env: pluginRuntimeEnv(),
    useShell: true,
    source: 'path',
    tried
  }
}

/** Wrap an arg in double quotes when it contains whitespace (shell mode only). */
function quoteShellArg(arg: string): string {
  return /\s/.test(arg) && !/^".*"$/.test(arg) ? `"${arg}"` : arg
}

/**
 * Build the final args array for a spawn, given the launch descriptor and the
 * subcommand args. In shell mode, args with spaces are quoted (shell:true does
 * not auto-quote); in direct mode they are passed verbatim (spawn handles them).
 */
export function finalizeArgs(launch: OpenClawLaunch, extraArgs: string[]): string[] {
  const all = [...launch.baseArgs, ...extraArgs]
  return launch.useShell ? all.map(quoteShellArg) : all
}

/**
 * 从 CLI 输出里提炼一句能给人看的失败原因。
 *
 * 原来是把整段 stderr 原样拼进 Error.message,而这段 stderr 一路会冒到聊天气泡里 ——
 * 用户看到的是带 ANSI 转义的 `[33m[channels] failed to load bundled channel setup entry
 * imessage...`,而真正的原因是最后那行 `ConfigMutationConflictError`。前面那些 channel 警告
 * 每次冷启动都有,与本次失败无关。
 */
function summarizeCliFailure(raw: string): string {
  // eslint-disable-next-line no-control-regex -- CLI 输出带 ANSI 颜色码,只能按控制字符剥
  const plain = raw.replace(/\u001b\[[0-9;]*m/g, '').trim()
  if (!plain) {
    return '(无输出)'
  }
  const lines = plain.split(/\r?\n/).filter((l) => l.trim())
  const meaningful = lines.filter((l) => !/^\[channels\]|^\s*at\s/.test(l.trim()))
  const picked = meaningful.length > 0 ? meaningful : lines
  return picked[picked.length - 1].trim()
}

/**
 * Run a one-shot (non-resident) openclaw subcommand, e.g. `config set`.
 *
 * @param args  subcommand args (do NOT pre-quote; quoting is handled here)
 * @param stdin optional data written to the child's stdin
 */
export function runOpenClaw(args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const launch = resolveOpenClawLaunch()
    const finalArgs = finalizeArgs(launch, args)
    const child = spawn(launch.command, finalArgs, {
      shell: launch.useShell,
      env: { ...process.env, ...launch.env }
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', (err) => {
      reject(new Error(`无法执行 openclaw(${launch.command}): ${err.message}`))
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(
          new Error(
            `openclaw ${args[0] ?? ''} ${args[1] ?? ''} 失败(退出码 ${code}):${summarizeCliFailure(stderr || stdout)}`
          )
        )
      }
    })

    if (stdin !== undefined) {
      child.stdin.write(stdin)
      child.stdin.end()
    }
  })
}
