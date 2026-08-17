import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type { AskQuestion, AskRequest, WidgetRequest, PresentRequest } from '@shared/types'

/**
 * 主进程内置「平台 UI 工具」MCP server。
 *
 * 工具 handler 必须跑在 Electron 主进程内 —— 只有这里能经 IPC 与渲染层做「阻塞式往返」
 * (问用户 → 等作答 → 回填模型)。
 *
 * 传输为什么是「命名管道 + stdio 中继」而不是回环 HTTP:
 * 登记走的是插件包的 `.mcp.json`(见 ui-tools-bundle.ts),而内核对 bundle 里的 MCP server
 * **今天只支持 stdio**——实测 `openclaw plugins inspect` 对 url 形式直接报
 * 「bundle MCP servers use unsupported transports or incomplete configs (stdio only today)」。
 * 于是由内核 spawn 一个中继子进程,它把自己的 stdin/stdout 泵到本进程的命名管道上,
 * MCP 会话仍在主进程内跑。管道路径是静态的,配置因此写一次就永不变动——这正是把登记
 * 挪出 openclaw.json 的全部意义(旧做法是每次启动重写临时端口,每次落盘都触发一轮网关热加载)。
 *
 * 帧格式与 stdio 完全一致(换行分隔 JSON),故直接复用 SDK 的 StdioServerTransport:
 * 它的构造签名就是 `(stdin?: Readable, stdout?: Writable)`,而 net.Socket 两者兼具。
 *
 * 内核侧工具名规则(实测 agent-bundle-mcp-names):`<serverName>__<toolName>`。
 * 本 server 登记名为 `yw` → 模型看到的工具即 `yw__ask_user`。
 */

/** 单次 ask_user 阻塞的最长等待(10 分钟);超时按用户放弃处理,回填占位结果。 */
const ASK_TIMEOUT_MS = 10 * 60 * 1000

/**
 * ask_user 往返桥:工具 handler 调 `ask()` 发起提问并等待;渲染层作答后主进程调
 * `answer()` 兑现对应 Promise。以 EventEmitter 的 'ask' 事件把提问外抛给 index.ts 转发渲染层。
 */
class UiToolsBridge extends EventEmitter {
  private readonly pending = new Map<
    string,
    { resolve: (answers: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >()

  /** 发起一次提问,返回将在渲染层作答(或超时)后兑现的 Promise。 */
  ask(questions: AskQuestion[]): Promise<unknown> {
    const id = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve({ cancelled: true, reason: 'timeout' })
        }
      }, ASK_TIMEOUT_MS)
      this.pending.set(id, { resolve, timer })
      this.emit('ask', { id, questions } satisfies AskRequest)
    })
  }

  /** 渲染层作答回填;命中 pending 返回 true。 */
  answer(id: string, answers: unknown): boolean {
    const p = this.pending.get(id)
    if (!p) {
      return false
    }
    clearTimeout(p.timer)
    this.pending.delete(id)
    p.resolve(answers)
    return true
  }

  /** 展示一张可视化卡(fire-and-forget):把 SVG/HTML 片段外抛给渲染层内联渲染。 */
  showWidget(title: string, widgetCode: string): void {
    this.emit('widget', { id: randomUUID(), title, widgetCode } satisfies WidgetRequest)
  }

  /** 交付产物文件(fire-and-forget):外抛绝对路径列表,渲染层渲染产物卡并打开预览抽屉。 */
  presentFiles(files: string[], explanation?: string): void {
    this.emit('present', { id: randomUUID(), files, explanation } satisfies PresentRequest)
  }
}

/** 单例桥:主进程共享。 */
export const uiToolsBridge = new UiToolsBridge()

/** 构造一个只含 ask_user 工具的 McpServer 实例(每个会话一个)。 */
function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'yunwu-ui-tools', version: '0.1.0' },
    { capabilities: { tools: {} } }
  )
  server.registerTool(
    'ask_user',
    {
      title: 'Ask the user',
      description:
        '向用户提出一个或多个选择题以澄清需求,并阻塞等待用户作答后再继续。' +
        '每个问题可带 header(短标签)、options(候选项,含 label 与可选 description)、' +
        'multiSelect(是否多选)。**每题必须 2-4 个选项、互斥且精炼;不要自带「其他」选项**' +
        '(UI 会自动提供自由输入)。当需求不明确、需要用户在若干方案中做选择时使用。' +
        '返回用户所选内容的 JSON。',
      inputSchema: {
        questions: z
          .array(
            z.object({
              question: z.string().describe('题干,清晰具体、以问号结尾'),
              header: z
                .string()
                .max(12)
                .optional()
                .describe('很短的标签,作为 chip 展示(最多 12 字)'),
              multiSelect: z.boolean().optional().describe('是否多选'),
              options: z
                .array(
                  z.object({
                    label: z.string().describe('选项显示文案,简洁 1-6 字,首尾不留空格'),
                    description: z
                      .string()
                      .optional()
                      .describe('该选项的一句话补充说明')
                  })
                )
                .min(2)
                .max(4)
                .describe(
                  '候选项,每题必须 2-4 个、互斥。不要自带「其他/Other」选项——' +
                    'UI 会自动在下方提供自由输入框,重复添加会导致重复元素。'
                )
            })
          )
          .max(4)
          .describe('一个或多个选择题(建议不超过 4 题)')
      }
    },
    async (args) => {
      const answers = await uiToolsBridge.ask(args.questions as AskQuestion[])
      return { content: [{ type: 'text', text: JSON.stringify(answers) }] }
    }
  )

  // show_widget:展示一张自包含可视化卡(对齐 WorkBuddy「展示详情」)。
  // 模型需在 widget_code 里现写「完整、自包含的内联 SVG」(可含 <title>/<desc>,
  // 不要引用外部资源、不要 <script>)。非阻塞:立刻返回,由渲染层内联展示。
  server.registerTool(
    'show_widget',
    {
      title: 'Show a visual widget',
      description:
        '在对话中展示一张自包含的可视化卡片(流程 / 阶段拆解 / 结构关系 / 对比)。' +
        '当可视化比纯文字更能说清结构时主动使用。' +
        '复杂主题请拆成多张 widget 分步展示,**每两张之间必须夹一段文字**把上下文串起来,' +
        '不要连续堆叠多次调用。展示后继续用文字把每一步讲透。\n' +
        '【结构要求】widget_code 必须是完整、自包含的内联 SVG:根元素带 role="img"、' +
        'viewBox 与 width="100%";首两个子元素为 <title> 与 <desc>;' +
        '禁止外部资源、<script> 与注释(浪费 token 且破坏流式渲染)。\n' +
        '【视觉规范 · 必须遵守】\n' +
        '- 禁渐变、阴影、发光、emoji,只用纯色平铺;外层不要铺深色或彩色底(卡片底色由宿主提供)。\n' +
        '- 字号:主标题 14px、盒内标题 14px、说明文字 12px,**最小不低于 11px**;' +
        '字重**只用 400 与 500,禁止 600/700**;句子式大小写,不要全大写。\n' +
        '- 配色:**每图最多 2 套色阶**,按语义取色——最浅色作填充、中深色作 0.5~1px 描边、' +
        '深色作文字。可选色阶(填充 / 描边 / 文字):' +
        '粉 #FBEAF0 / #D4537E / #72243E;橙 #FAECE7 / #D85A30 / #712B13;' +
        '蓝 #E9EFFB / #3B6FD4 / #1B355F;绿 #E8F3EC / #2F8F52 / #17462A;' +
        '紫 #EEEDFE / #7F77DD / #332F73;中性 #F4F4F5 / #9A9AA2 / #3F3F46。\n' +
        '- 布局:圆角 rx=10;盒内说明 ≤5 个词;横排最多 4 个盒子;箭头用 <marker> 绘制。',
      inputSchema: {
        title: z.string().describe('卡片标题,简洁概括这张图讲什么'),
        widget_code: z
          .string()
          .describe('完整、自包含的内联 SVG 代码,严格遵守描述中的视觉规范')
      }
    },
    async (args) => {
      uiToolsBridge.showWidget(args.title, args.widget_code)
      return { content: [{ type: 'text', text: 'widget shown' }] }
    }
  )

  // present_files:显式「交付产物」(对齐 WorkBuddy present_files)。
  // 传入已落盘文件的绝对路径列表;渲染层据此渲染产物卡并自动打开右侧预览抽屉。
  server.registerTool(
    'present_files',
    {
      title: 'Present generated files',
      description:
        '把已经写好的产物文件正式交付给用户。当完成一份可交付的文档/文件后调用,' +
        '用户将看到产物卡并可在右侧预览、打开所在文件夹。files 为文件的绝对路径列表。',
      inputSchema: {
        files: z.array(z.string()).describe('已落盘产物文件的绝对路径列表'),
        explanation: z.string().optional().describe('对交付内容的一句话说明')
      }
    },
    async (args) => {
      uiToolsBridge.presentFiles(args.files, args.explanation)
      return { content: [{ type: 'text', text: 'files presented' }] }
    }
  )
  return server
}

/**
 * 中继子进程要连的管道路径。**必须是静态的**——它会被写进插件包的 `.mcp.json`,
 * 一变就又回到「每次启动重写配置」的老路。
 *
 * Windows 的命名管道命名空间是全机器共享的(不像 unix socket 落在用户目录下),
 * 故带上用户名做隔离,避免多用户登录时互相抢占。
 */
export function uiToolsPipePath(): string {
  const user = (userInfo().username || 'default').replace(/[^A-Za-z0-9_-]/g, '') || 'default'
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\yunwu-desktop-ui-tools-${user}`
  }
  return join(homedir(), '.openclaw', 'runtime', `yunwu-ui-tools-${user}.sock`)
}

let pipeServer: Server | null = null

/**
 * 一条连接 = 一个 MCP 会话。内核为每个会话 spawn 一个中继子进程,中继连上来后
 * 直接在这条 socket 上跑 MCP 协议,工具 handler 仍在主进程内执行。
 */
function handleConnection(socket: Socket): void {
  socket.on('error', () => socket.destroy())
  const server = buildMcpServer()
  const transport = new StdioServerTransport(socket, socket)
  socket.on('close', () => {
    void server.close().catch(() => {
      /* 会话已断,关闭失败无处可报 */
    })
  })
  void server.connect(transport).catch((err) => {
    console.warn('[ui-tools] MCP 会话建立失败:', err)
    socket.destroy()
  })
}

/**
 * 上一个实例退出到管道真正释放之间有窗口期,开发时反复重启必踩(实测 EADDRINUSE)。
 * 5 秒足够覆盖一次正常退出;还占着就是真有另一个实例活着。
 */
const LISTEN_RETRIES = 10
const LISTEN_RETRY_DELAY_MS = 500

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 管道上还有活着的属主吗?连得上就是有。 */
function hasLiveOwner(pipePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(pipePath)
    const done = (alive: boolean): void => {
      probe.destroy()
      resolve(alive)
    }
    probe.once('connect', () => done(true))
    probe.once('error', () => done(false))
  })
}

/** 监听一次,失败即 reject(错误带 code,供上层判 EADDRINUSE)。 */
function listenOnce(pipePath: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const srv = createServer(handleConnection)
    srv.once('error', reject)
    srv.listen(pipePath, () => {
      srv.removeListener('error', reject)
      srv.on('error', (err) => console.warn('[ui-tools] 管道监听异常:', err))
      resolve(srv)
    })
  })
}

/**
 * 启动 UI 工具 MCP server(幂等)。监听静态命名管道,返回其路径供 `.mcp.json` 登记。
 *
 * 管道名是静态的(配置才能写一次就不动),代价是同一时刻只能有一个实例持有它。
 * 被占用时先重试——多数情况是上一个实例正在退出;确实还有活属主就放弃,不去抢:
 * 抢过来只会让 ask_user 弹到错误的那个窗口上。
 */
export async function startUiToolsServer(): Promise<string> {
  const pipePath = uiToolsPipePath()
  if (pipeServer) {
    return pipePath
  }
  if (process.platform !== 'win32') {
    mkdirSync(join(homedir(), '.openclaw', 'runtime'), { recursive: true })
    // unix socket 文件在进程崩溃后会残留,没有活属主就是残骸,删掉才能重新监听。
    if (existsSync(pipePath) && !(await hasLiveOwner(pipePath))) {
      try {
        unlinkSync(pipePath)
      } catch {
        /* 已被别人清掉,照常继续 */
      }
    }
  }
  for (let attempt = 0; ; attempt++) {
    try {
      pipeServer = await listenOnce(pipePath)
      return pipePath
    } catch (err) {
      const inUse = (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
      if (!inUse || attempt >= LISTEN_RETRIES) {
        if (inUse && (await hasLiveOwner(pipePath))) {
          throw new Error(`UI 工具管道已被另一个实例持有(${pipePath}),本窗口不提供 UI 工具`)
        }
        throw err
      }
      await delay(LISTEN_RETRY_DELAY_MS)
    }
  }
}
