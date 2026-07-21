import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

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
      env: { ELECTRON_RUN_AS_NODE: '1' },
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
          env: { ELECTRON_RUN_AS_NODE: '1' },
          useShell: false,
          source: 'env',
          tried
        }
      }
      return {
        command: envBin,
        baseArgs: [],
        env: {},
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
    env: {},
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
        reject(new Error(`openclaw ${args.join(' ')} 退出码 ${code}: ${stderr || stdout}`))
      }
    })

    if (stdin !== undefined) {
      child.stdin.write(stdin)
      child.stdin.end()
    }
  })
}
