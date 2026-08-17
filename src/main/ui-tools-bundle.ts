import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOpenClaw } from './openclaw-cli'

/**
 * 把「平台 UI 工具」登记成内核的一个**插件包**,而不是往 openclaw.json 的 `mcp.servers` 里写。
 *
 * 为什么这么做(实测结论,别再改回去):
 * 旧做法是每次启动把临时端口写进 `mcp.servers.yw`。端口每次都变 ⇒ 那批启动配置永远不是
 * noop ⇒ 每次启动都真落一次盘 ⇒ 每次落盘触发一轮网关热加载,而这一轮正好撞上网关最忙的
 * 预热窗口(实测 provider auth 预热 40.8 秒),后续配置写入撞车就是从这里开始的。
 *
 * 参考实现怎么做的:
 *  - Claude Code(`utils/ide.ts`):IDE 侧 server 用临时端口,把端口编进 `~/.claude/ide/<port>.lock`
 *    的文件名发布,运行时发现后连接,端口从不进持久配置。我们内核没有这种运行期发现能力
 *    (网关连一个 `mcp.*` RPC 都没有),这条抄不了。
 *  - WorkBuddy:把 MCP 登记放在主配置之外的独立 `.mcp.json` 里,主配置不动。这条能抄——
 *    内核原生支持插件包的 `.mcp.json`(`loadEnabledBundleMcpConfig`),且实测放在
 *    `~/.openclaw/extensions/<name>/` 下的 bundle **默认就是 enabled**(注册表里 origin=global、
 *    enabled=true),连 `plugins.entries` 都不用写。WorkBuddy 自己也正是这么往
 *    `~/.openclaw/extensions` 里投插件的(那个 tencent-pptx 就是它装的)。
 *
 * 被逼的差异:内核对 bundle 里的 MCP server **只支持 stdio**(实测 `plugins inspect` 对 url
 * 形式报「stdio only today」),所以不能像 WorkBuddy 那样直接写 http url,得由内核 spawn 一个
 * 中继子进程连回主进程的命名管道(见 ui-tools-server.ts)。
 *
 * 为什么走 `plugins install` 而不是直接把目录塞进 extensions:直接塞进去内核会判
 * 「loaded without install/load-path provenance; treat as untracked local code」,
 * 并建议去主配置里钉 `plugins.allow`。参考实现不是这么解的——WorkBuddy 那条 tencent-pptx
 * 同样躺在 `~/.openclaw/extensions` 下却没有这条告警,因为它是经官方安装路径进来的,
 * 内核记了一份安装档案(inspect 里的 Install 块)。经此路径的代价是主配置里多一条
 * `plugins.entries.<id>.enabled = true`——tencent-pptx 也正是只有这一条。
 *
 * 代价与边界:安装是一次性的(manifest 不变就不重装),之后 `.mcp.json` 与中继脚本直接
 * 就地更新,既不碰主配置也不用重装。首次安装当次内核可能还没加载到这个插件
 * (CLI 自己也提示 "Restart the gateway to load plugins"),下次启动即生效。
 */

/** 插件 id 即目录名;内核按目录名注册(实测注册表 pluginId = 目录名)。 */
const PLUGIN_ID = 'yunwu-ui-tools'

/**
 * 内核侧 MCP server 名。工具名规则是 `<serverName>__<toolName>`,故这里改名等于把
 * 模型看到的 `yw__ask_user` 一起改掉 —— tool-protocol.ts 里的工具名约定与此同源。
 */
export const UI_TOOLS_SERVER_NAME = 'yw'

/**
 * ask_user 会阻塞等用户作答,故 MCP 请求超时必须配大。
 *
 * 内核 bundle-mcp 的 callTool 走 `session.client.callTool(..., { timeout: requestTimeoutMs })`
 * 且**不** resetTimeoutOnProgress,默认仅 60s。沿用默认的话用户答慢就会被判
 * 「MCP error -32001: Request timed out」,模型收到错误后会自作主张把问题当纯文本输出
 * (丢掉「等待用户确认」状态)。15min 略大于 handler 内部的 ASK_TIMEOUT_MS(10min),
 * 让「用户不答」由 handler 自己返回 cancelled,而不是被内核硬超时。
 */
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000

/** 插件包根目录:内核的 global 插件根(`resolvePluginSourceRoots` 里的 `<configDir>/extensions`)。 */
export function uiToolsBundleDir(): string {
  return join(homedir(), '.openclaw', 'extensions', PLUGIN_ID)
}

/**
 * 中继子进程:内核 spawn 它,它把 stdin/stdout 泵到主进程的命名管道上。
 *
 * 只做字节搬运,不碰协议——MCP 会话完全跑在主进程里,工具 handler 才能经 IPC 弹窗等作答。
 * 写进插件目录而不是打进 asar:asar 是虚拟文件系统,只有 Electron 打过补丁的 fs 读得了,
 * 外部 node 进程拿不到里面的文件。
 *
 * 取 net 必须走动态 import:electron-vite 用正则在产物里找「最后一条 import 语句」来决定
 * CommonJS 垫片(__dirname / require)插在哪儿,它分不清代码和字符串。这里若写静态
 * `import net from 'node:net'`,垫片就会被塞进本模板串内部,模块作用域里的 __dirname
 * 随之消失 —— 表现为 createWindow 抛 ReferenceError、主窗口整个建不出来。
 */
const RELAY_SOURCE = `// 由 yunwu-desktop 自动生成,请勿手改。
// 内核 spawn 本进程作为 stdio MCP server,这里只把字节转给主进程的命名管道。
const { connect } = await import('node:net')

const target = process.env.YW_UI_TOOLS_PIPE
if (!target) {
  process.stderr.write('[yw-ui-tools] 缺少 YW_UI_TOOLS_PIPE\\n')
  process.exit(1)
}

const socket = connect(target)
socket.on('error', (err) => {
  process.stderr.write(\`[yw-ui-tools] 连接主进程失败: \${err.message}\\n\`)
  process.exit(1)
})
socket.on('close', () => process.exit(0))
process.stdin.on('end', () => socket.end())
process.stdin.pipe(socket)
socket.pipe(process.stdout)
`

function manifestSource(): string {
  return `${JSON.stringify(
    {
      name: PLUGIN_ID,
      version: '1.0.0',
      description: '云雾平台 UI 工具:向用户提问、展示可视化卡片、交付产物文件',
      mcpServers: './.mcp.json'
    },
    null,
    2
  )}\n`
}

/**
 * `command` 用 Electron 自身充当 node(ELECTRON_RUN_AS_NODE=1)——与 openclaw-cli.ts 拉起内核
 * 的方式同源。我们并不随包分发独立的 node:`~/.openclaw/runtime/node-tools` 只有 npm 生成的
 * shim,node 本体不在里面。
 */
function mcpConfigSource(relayPath: string, pipePath: string): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        [UI_TOOLS_SERVER_NAME]: {
          transport: 'stdio',
          command: process.execPath,
          args: [relayPath],
          env: { ELECTRON_RUN_AS_NODE: '1', YW_UI_TOOLS_PIPE: pipePath },
          requestTimeoutMs: REQUEST_TIMEOUT_MS
        }
      }
    },
    null,
    2
  )}\n`
}

/** 内容一致就不写:避免无谓地动 mtime,manifest 的 mtime 还会被注册表拿去判新旧。 */
function writeIfChanged(path: string, content: string): boolean {
  try {
    if (readFileSync(path, 'utf-8') === content) {
      return false
    }
  } catch {
    /* 读不到就是没有,照写 */
  }
  writeFileSync(path, content, 'utf-8')
  return true
}

/** 把三个文件写进 `dir`,返回 manifest 是否发生变化。 */
function writeBundleFiles(dir: string, pipePath: string): boolean {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeIfChanged(join(dir, 'relay.mjs'), RELAY_SOURCE)
  writeIfChanged(join(dir, '.mcp.json'), mcpConfigSource(join(dir, 'relay.mjs'), pipePath))
  return writeIfChanged(join(dir, '.claude-plugin', 'plugin.json'), manifestSource())
}

/**
 * 落地 / 更新 UI 工具插件包。
 *
 * 已装好就地更新(`.mcp.json` 里的 Electron 路径会随版本升级变),没装或 manifest 变了
 * 才走一次官方安装。安装源必须是另一个目录:`plugins install` 是「从源目录拷进 extensions」,
 * 源和目标同一个目录没有意义。
 */
export async function syncUiToolsBundle(pipePath: string): Promise<void> {
  const installed = uiToolsBundleDir()
  if (existsSync(join(installed, '.claude-plugin', 'plugin.json'))) {
    if (!writeBundleFiles(installed, pipePath)) {
      return
    }
  }

  // manifest 变了(或压根没装):重新走一遍官方安装,让内核刷新安装档案与插件注册表。
  const stage = join(tmpdir(), 'yunwu-ui-tools-install')
  const stageBundle = join(stage, PLUGIN_ID)
  try {
    rmSync(stage, { recursive: true, force: true })
    writeBundleFiles(stageBundle, pipePath)
    await runOpenClaw(['plugins', 'install', stageBundle, '--force'])
  } catch (err) {
    console.warn('[ui-tools] 安装插件包失败,UI 工具可能要到下次启动才生效:', err)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}
