/**
 * 「做同款」的参考案例落盘与注入。
 *
 * ## 要复现的结果
 *
 * 用户在案例预览里看到的是完整 HTML 跑起来的样子,点「做同款」后模型却只收到
 * `init_prompt` 那一段文字——眼睛和模型消费的不是同一份基准,生成结果自然对不上
 * 预览。WorkBuddy 不传案例本体也能"同款",靠的是每条 prompt 都在它自己的生成管线
 * 上验证过(`docs/desktop-playbook-plan.md` 1.4 节:「先做一遍再存档」);我们的案例
 * 产自另一条批量管线,这个前提不成立,所以把预览用的那份 HTML 原样送到模型面前。
 *
 * ## 为什么是宿主下载,而不是把 URL 交给模型自己抓
 *
 * - 预签名产物链接会过期,而且写进会话正文就会永久留在抄本里、随历史每轮重发;
 * - 内核的 web 抓取工具把内容抽成文本进上下文,不落原始字节,模型侧没有可靠的
 *   "下载到磁盘"动作;
 * - 宿主下载的失败是确定性的:staged 与否在召唤前就有答案,降级路径由代码而不是
 *   模型情绪决定。
 *
 * ## 为什么用 `agent.inject` 而不是拼进输入框草稿
 *
 * 召唤不自动发送(`client/summon.ts`:preset select 后 `setDraft` 预填,用户自己回车),
 * 草稿全程可见可改——把路径句拼进去等于把机制杵到用户脸上,还可能被用户手滑删掉。
 * `Agent.inject` 把指令排进会话的持久 inbox,空闲时挂起,用户发出第一条消息的
 * pre-step 才收进批次(`dsh-agent/lib/types/runtime-types.d.ts:124-132`)。
 * 对话页整行不渲染(`client/index.ts` 的 `__openluxProducerHidden` +
 * `dsh-client-ui-conversation` 补丁):指令内容是绝对路径与阅读规程,对用户是
 * 纯管道噪音;轨迹页保留可见,作为排查窗口。
 * 注入永远发生在文件 rename 完成之后,所以"模型被告知有文件"蕴含"文件完整在盘上"。
 *
 * ## 文件落在哪,为什么按会话命名而不是按案例
 *
 * DSH 的会话按 cwd 归组到工作区,会话 cwd 就是工作区目录(`dsh-workspace` README:
 * `Workspace.sessionIds` 按规范化 cwd 投影成员)。参考文件写进
 * `<cwd>/.openlux/references/reference-case-<会话哈希>.html`。
 *
 * 命名单位是会话,由召唤的复用语义决定(`client/summon.ts` 的 `blankCurrent`):
 * 空白会话会被连续的「做同款」复用,草稿是覆盖式的——输入框永远只剩最后一个案例
 * 的 prompt。参考必须跟上同一语义:同一会话内后续 attach 只原子覆写同一个文件,
 * **不再追加注入**,否则一次发送会带出一摞除路径外全同的「参考案例」折叠行
 * (2026-08-29 用户实测连点三个案例,收进三条注入)。而多个会话共享同一个 cwd,
 * 所以固定名里必须带会话标识:否则新会话的做同款会覆写旧会话指令还指着的文件,
 * 旧会话续轮迭代时模型会读到别人的案例。
 *
 * 产出物卡片只折叠"修改类工具调用"的 locations(`dsh-client-ui-deliverables`
 * README:「读取、删除和失败的调用不贡献任何条目」),宿主直写 + 模型只读,
 * 这个文件永远不会被当成交付物。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { requestBytes } from '../account/http.ts'
import type { ConsoleAccess } from './console.ts'
import { readPlaybookArtifact } from './home-content.ts'

/**
 * 注入消息的生产者名。显示层在 `client/index.ts` 有两处消费:
 * `__openluxProducerHidden` 让对话页整行不渲染,`__openluxProducerLabels`
 * 把轨迹页等其余入口的名字映射成「参考案例」。改这个字符串要连同两张表一起改。
 */
export const CASE_REFERENCE_PRODUCER = 'openlux-case-reference'

/**
 * 单次下载预算。线上 HTML 案例中位数 132KB、最大 1.04MB
 * (`admin-server/service/desktop_market/artifact.go:58`),普通宽带一秒内完成;
 * 15 秒只为烂网兜底,预览打开时的预取让点击时刻通常是缓存命中。
 */
const STAGE_TIMEOUT_MS = 15_000

/** 大小上限。现存最大 1.04MB,放 8 倍余量;超过的按失败降级,不冒进。 */
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024

/** 暂存条目的保鲜期:预览到点击隔着人的阅读节奏,15 分钟绰绰有余。 */
const STAGE_TTL_MS = 15 * 60 * 1000

/** 暂存池上限。一人同时看的案例不会多,超出淘汰最旧的。 */
const STAGE_CAP = 8

/** 会话 agent 就位的重试:窗口侧 agent 随会话打开挂载,给它一点时间。 */
const ATTACH_RETRIES = 5
const ATTACH_RETRY_MS = 300

/** 已注入指令的会话记录上限。会话一旦发过消息就不会再被召唤复用,留 64 个只为封顶。 */
const INSTRUCTED_CAP = 64

/**
 * 参考文件的保留期。会话的活跃迭代期远短于 30 天;过期文件由 attach 顺手清扫
 * (发后即忘,不在关键路径上)。误删的兜底是指令的自愈条款:文件不存在时模型
 * 按文字描述实现、不追问。只清 `reference-case-` 前缀(含写崩留下的 `.tmp`),
 * 旧版按案例命名的 `case-<id>.html` 可能被多个历史会话共享,不碰。
 */
const REFERENCE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** `stage` 的回答:成没成、没成的原因(给日志,不给用户弹窗)。 */
export interface StageOutcome {
  readonly staged: boolean
  readonly reason?: string
}

/** `attach` 的回答。`attached: false` 一律静默降级——召唤照常,只是没有参考。 */
export interface AttachOutcome {
  readonly attached: boolean
  readonly reason?: string
}

/** `detach` 的回答。失败同样静默——最坏也只是残留文件等 TTL 清扫。 */
export interface DetachOutcome {
  readonly detached: boolean
  readonly reason?: string
}

/** 会话 agent 的结构化剪影,与 `automation.ts` 的 `AutomationAgent` 同源。 */
interface ReferenceAgent {
  readonly session: { readonly header: { readonly cwd?: string } }
  inject(message: unknown): void
}

interface ReferenceAgents {
  get(id: string): ReferenceAgent | undefined
}

interface StagedCase {
  readonly html: string
  readonly at: number
}

/**
 * 宿主侧运行时:预览打开时 `stage`(下载进内存暂存),召唤落到会话后 `attach`
 * (原子落盘 + 注入指令)。两步之间隔着安装确认框和会话创建,都是秒级人时,
 * 暂存池的 TTL 覆盖得住。
 */
export class CaseReferenceRuntime {
  private readonly staged = new Map<number, StagedCase>()
  /**
   * 已经收到过阅读指令的会话。
   *
   * 同一空白会话被连续「做同款」复用时,文件内容跟着最后一次选择走(覆写),
   * 指令只注入一次——指令指的是固定路径,内容换了指令依然成立,而重复注入
   * 只会在首条消息发出时渲染出一摞除路径外全同的折叠行。
   */
  private readonly instructed = new Map<string, true>()
  /** 本次进程生命周期里已清扫过的参考目录,避免每次 attach 重复扫盘。 */
  private readonly sweptDirs = new Set<string>()
  private agents: ReferenceAgents | undefined

  constructor(private readonly ctx: Context) {
    // 与 automation.ts 同一取法:agents 服务只在桌面 profile 里有,注入式获取
    // 让市场其余功能在小组合里照常工作,attach 则答"服务缺席"。
    ctx.inject(['agents'], (scope: Context) => {
      this.agents = (scope as unknown as { get(key: string): unknown }).get('agents') as ReferenceAgents
      scope.effect(() => () => { this.agents = undefined }, 'openlux-market: case reference agents')
    })
  }

  /**
   * 下载一个案例的 HTML 进内存暂存。幂等:命中新鲜缓存直接返回。
   * @param access - 控制台地址与凭据。
   * @param id - 案例编号。
   * @param signal - 调用方取消。
   */
  async stage(access: ConsoleAccess, id: number, signal?: AbortSignal): Promise<StageOutcome> {
    if (id <= 0) return { staged: false, reason: 'bad-id' }
    const hit = this.staged.get(id)
    if (hit !== undefined && Date.now() - hit.at < STAGE_TTL_MS) return { staged: true }
    let artifact: { url: string; artifactType: string }
    try {
      artifact = await readPlaybookArtifact(this.ctx, access, id, signal)
    } catch (error: unknown) {
      return { staged: false, reason: messageOf(error) }
    }
    // video 没有可复刻的源码,link 只有外部地址:两者都按"无参考"处理,
    // 召唤照常,模型按文字描述实现——即今天的行为。
    if (artifact.artifactType !== 'html') return { staged: false, reason: `unsupported:${artifact.artifactType}` }
    let bytes: Uint8Array
    try {
      bytes = await requestBytes(this.ctx, artifact.url, STAGE_TIMEOUT_MS, MAX_REFERENCE_BYTES, signal, '参考案例')
    } catch (error: unknown) {
      return { staged: false, reason: messageOf(error) }
    }
    const html = new TextDecoder().decode(bytes)
    if (html.trim() === '') return { staged: false, reason: 'empty' }
    this.remember(id, html)
    return { staged: true }
  }

  /**
   * 把暂存的案例写进会话工作目录并注入阅读指令。
   *
   * 顺序是先 rename 后 inject:注入的存在证明文件完整。任何一步失败都整体放弃
   * ——一条指着空路径的指令比没有指令更糟(模型会追问或编造)。
   * 同一会话第二次 attach(空白会话被下一次「做同款」复用)只覆写文件不再注入,
   * 与召唤对草稿的覆盖语义对齐:模型只收到一条指令,文件内容即最后的选择。
   * @param id - 案例编号。
   * @param sessionId - 召唤落到的会话。
   */
  async attach(id: number, sessionId: string): Promise<AttachOutcome> {
    if (id <= 0 || sessionId === '') return { attached: false, reason: 'bad-request' }
    const hit = this.staged.get(id)
    if (hit === undefined) return { attached: false, reason: 'not-staged' }
    const agent = await this.agentOf(sessionId)
    if (agent === undefined) return { attached: false, reason: 'no-agent' }
    const cwd = agent.session.header.cwd
    if (cwd === undefined || cwd.trim() === '') return { attached: false, reason: 'no-cwd' }
    const file = referencePathFor(cwd, sessionId)
    const dir = dirname(file)
    try {
      await mkdir(dir, { recursive: true })
      // 临时名写完再 rename:同目录内 rename 是原子的,模型任何时刻读到的
      // 要么是不存在、要么是完整文件,不存在"半个 HTML"。覆写同理:读到的
      // 要么是上一个案例的完整文件、要么是新案例的完整文件。
      const tmp = `${file}.${process.pid}-${Date.now()}.tmp`
      await writeFile(tmp, hit.html, 'utf8')
      await rename(tmp, file)
    } catch (error: unknown) {
      return { attached: false, reason: messageOf(error) }
    }
    this.sweep(dir)
    if (this.instructed.has(sessionId)) return { attached: true }
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: instructionFor(file) }],
      source: { kind: 'plugin', plugin: CASE_REFERENCE_PRODUCER, form: 'instructions' },
    }))
    this.instructed.set(sessionId, true)
    while (this.instructed.size > INSTRUCTED_CAP) {
      const oldest = this.instructed.keys().next().value
      if (oldest === undefined) break
      this.instructed.delete(oldest)
    }
    return { attached: true }
  }

  /**
   * 无参考召唤落到会话时,撤掉该会话的参考文件。
   *
   * 场景:做同款 A 后没发消息,回市场召唤了普通专家 B——空白会话被复用,
   * A 的阅读指令还挂在持久收件箱里撤不回(内核没有撤回 API),但指令自带
   * 自愈条款「文件不存在→按文字描述实现、不追问」,删掉文件就把它无害化了。
   * 不以 `instructed` 标记为门槛:注入是持久的,应用重启后内存标记消失而
   * 收件箱还在,所以一律尽力删;文件本就不存在时 unlink 报 ENOENT,照常吞掉。
   * `instructed` 标记本身保留——用户再反悔、在同一空白会话又做同款 C 时,
   * attach 只需重写文件,收件箱里那条指令指着固定路径,文件回来指令即复活。
   * @param sessionId - 被普通召唤复用的会话。
   */
  async detach(sessionId: string): Promise<DetachOutcome> {
    if (sessionId === '') return { detached: false, reason: 'bad-request' }
    const agent = await this.agentOf(sessionId)
    if (agent === undefined) return { detached: false, reason: 'no-agent' }
    const cwd = agent.session.header.cwd
    if (cwd === undefined || cwd.trim() === '') return { detached: false, reason: 'no-cwd' }
    const file = referencePathFor(cwd, sessionId)
    try {
      await unlink(file)
    } catch {
      // 不存在或占用都无所谓:前者本就是目标状态,后者留给 TTL 清扫。
    }
    return { detached: true }
  }

  /**
   * 惰性清扫:删掉参考目录里超过保留期的本方案文件。发后即忘——不 await、
   * 错误全吞(占用删不掉、已被删都留给下次),对 attach 的延迟贡献为零。
   * 每个目录每次进程生命周期只扫一次:TTL 是 30 天,按 app 启动节奏扫绰绰有余。
   */
  private sweep(dir: string): void {
    if (this.sweptDirs.has(dir)) return
    this.sweptDirs.add(dir)
    void (async () => {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        return
      }
      const cutoff = Date.now() - REFERENCE_TTL_MS
      for (const name of names) {
        if (!name.startsWith('reference-case-')) continue
        const path = join(dir, name)
        try {
          const info = await stat(path)
          if (info.mtimeMs < cutoff) await unlink(path)
        } catch {
          // 下次清扫再试;清扫失败不值得打扰任何人。
        }
      }
    })()
  }

  /** 窗口侧 agent 随会话打开挂载,刚召唤完可能还差几拍,轮询等它。 */
  private async agentOf(sessionId: string): Promise<ReferenceAgent | undefined> {
    for (let attempt = 0; attempt < ATTACH_RETRIES; attempt += 1) {
      const agent = this.agents?.get(sessionId)
      if (agent !== undefined) return agent
      await new Promise(resolve => setTimeout(resolve, ATTACH_RETRY_MS))
    }
    return this.agents?.get(sessionId)
  }

  private remember(id: number, html: string): void {
    this.staged.delete(id)
    this.staged.set(id, { html, at: Date.now() })
    while (this.staged.size > STAGE_CAP) {
      const oldest = this.staged.keys().next().value
      if (oldest === undefined) break
      this.staged.delete(oldest)
    }
  }
}

/**
 * 模型看到的指令。措辞四个要点,都有来处:
 * - 「复刻骨架、替换血肉」:复刻结构视觉,但标题/文案/示例数据必须换成用户业务
 *   ——照搬示例数据正是"原样复制"这个失败模式的主要形态;
 * - 甄别注入物:分发管线在物化时往 HTML 头部注入 CSP meta 与预览壳桥接脚本
 *   (`admin-server` 的 playbook 物化;约束史见
 *   `.cursor/skills/align-with-claude-and-workbuddy/references/playbook-artifacts.md`),
 *   那是预览机制不是设计,复刻进用户作品只会带来死代码;
 * - 自愈条款:文件缺失时按文字描述实现且不追问,把"降级"从模型的三种随机结局
 *   (退化/追问/编造)收敛成一种确定行为;
 * - 最后选择条款:同一会话内连续做同款只覆写文件不重复注入(见 `attach`),
 *   指令声明"文件保存的是最后一次选择",让模型信文件而不是信自己的猜测;
 *   "多条以最新为准"保留,兜住本修复之前产生的历史抄本被续轮的情形。
 */
function instructionFor(path: string): string {
  return [
    '【做同款参考】用户从案例市场对一个案例点了「做同款」,该案例的完整 HTML 已下载到:',
    '',
    path,
    '',
    '开始动手前,先完整读取这个文件,把它当作视觉与结构基准:忠实复刻其页面结构、布局比例、',
    '配色、字体层级、组件造型、交互与脚本行为。但注意区分三类内容:',
    '1. 标题、文案、示例数据都是演示内容,一律不要沿用,请替换为用户消息中要求的业务内容;',
    '2. 文件头部若有分发系统注入的 Content-Security-Policy meta 标签,或向父窗口 postMessage',
    '   汇报高度/语言的桥接脚本,那是预览壳的机制而非设计的一部分,不要复刻;',
    '3. 其余结构、样式与交互逻辑属于设计本身,忠实保留。',
    '用户明确提出的修改要求优先于参考文件。',
    '若用户在发消息前连续选过多个案例,该文件保存的是最后一次选择,以文件实际内容为准。',
    '若该文件不存在或读取失败,不要追问,直接按用户的文字描述实现。',
    '若本会话中出现多条【做同款参考】,以最新一条为准。',
  ].join('\n')
}

/**
 * 会话的参考文件路径。attach 写它、detach 删它、收件箱里的指令指着它,
 * 三方必须永远算出同一个名字,所以集中在一处。
 * 会话哈希而不是 sessionId 原文:格式不归我们管,哈希永远是文件名安全的。
 */
function referencePathFor(cwd: string, sessionId: string): string {
  return join(cwd, '.openlux', 'references', `reference-case-${fnv1a(sessionId)}.html`)
}

/** 32 位 FNV-1a,8 位十六进制:把任意格式的会话 id 折成文件名安全的短标识。 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
