import { useState } from 'react'
import { AnimatePresence, MotionConfig, motion, useAnimationControls } from 'motion/react'
import { Clapperboard, FolderOpen, Users } from 'lucide-react'
import type { ActivationConfig, CaptchaType, MediaSelection, ModelInfo } from '@shared/types'
import { PUBLIC_DEFAULT_MODEL, PUBLIC_MODELS } from '@shared/public-models'
import Mascot from '../components/Mascot'
import Captcha, { isNativeCaptcha } from '../components/Captcha'
import LoadingLottie from '../components/LoadingLottie'
import ModelPicker from '../components/ModelPicker'
import MediaPicker from '../components/MediaPicker'

/**
 * 云雾服务地址(登录 + 模型对话打的用户端 new-yunwu-api):
 *  - 生产:固定主站 yunwu.ai;
 *  - 开发(vite dev):海外站 api.openlux.ai。
 *
 * 开发期为什么不指本地 localhost:3001:那台本地用户端**没有承载渠道,模型一律打不通**
 * (2026-08-13 实测 `/v1/models` 只有 103 条、走统一接口的视频模型 0 条,打 veo_3_1-fast
 * 回「无可用渠道」)。而模型的地址与 key 必须同站 —— key 是发证站签的,换站即失效 ——
 * 所以要模型能用,登录就得走线上。
 *
 * 代价是市场那一层要单独给令牌:市场挂在本地 admin-server:3000 上,它的 `tokens` 表在
 * `jishu_test` 库,认不出海外站的令牌。用 `YUNWU_MARKET_TOKEN` 覆盖即可,
 * 见 `main/market/market-client.ts` 的 `requireToken`。已装好的专家不受影响
 * (persona 落在 `~/.openclaw/skills`,运行时不碰市场)。
 *
 * 私有化/改端口用 setState 里的输入或后续设置项覆盖。
 */
const YUNWU_BASE_URL = import.meta.env.DEV ? 'https://api.openlux.ai' : 'https://yunwu.ai'

interface Props {
  onActivated: (config: ActivationConfig) => void
  /**
   * 会话过期后回到这一屏时带上的上下文(见 App 的 sessionExpired)。
   *
   * 只影响这一屏的说辞与预填:本地激活态还在(sk- 令牌、模型清单、任务都没动),
   * 用户重登一次只是换一张新会话,不是从零激活。
   */
  expired?: {
    /** 上次登录的账号名,预填进用户名框。 */
    username: string
    /** 先不登录,直接回工作台(余额那一格会显示「登录已过期」)。 */
    onSkip: () => void
  }
}

/** 入场缓动:先快后稳的 ease-out,与页面其它 0.15~0.2s 过渡同一手感。 */
const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1]
/** 父层只排时序,位移写在子层(见 RISE);两者分工是 motion 的 variants 传播约定。 */
const STAGGER = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.05 } }
}
const RISE = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.42, ease: EASE_OUT } }
}
/** 整屏切换时上一屏的退场。给对象而不是变体名,免得被子层当成变体标签继承下去。 */
const LEAVE = {
  opacity: 0,
  y: -8,
  transition: { duration: 0.2, ease: EASE_OUT }
}

/**
 * 欢迎屏上的三条要点。写的是这个产品真有的能力,不是凑数的卖点 ——
 * WorkBuddy 那一屏用三张带封面图的样例卡讲「产出长什么样」,我们没有那批位图素材
 * (`src/renderer` 下一个 PNG 都没有,动画技能里定的),改用 lucide 图标 + 一行字,
 * 形状不同但要复现的结果一样:动手挑之前先知道这一步是为了什么。
 */
const POINTS = [
  { icon: Users, title: '专家与专家团', desc: '召唤角色替你把活干完' },
  { icon: FolderOpen, title: '本地文件', desc: '直接读写你电脑上的文件夹' },
  { icon: Clapperboard, title: '出图与出视频', desc: '按需调用云雾的媒体模型' }
]

/**
 * 四步:登录 → 欢迎 → 选对话模型 → 选媒体模型。老用户登录完直接进主界面,只走第一步。
 *
 * 媒体单独一步而不是跟对话挤在一屏:两者的候选池判据不同(对话看 tags,媒体看
 * `supported_endpoint_types`)、勾选语义也不同(媒体是三档、语音还是单选),
 * 塞进同一个列表用户会以为随手勾一个视频模型就能拿去对话。
 */
type Phase = 'login' | 'welcome' | 'models' | 'media'

/**
 * 登录 / 激活页:登录 → 选模型 → 进入。
 *  云雾账号密码登录 → 自动换取 sk- 令牌 → 写入本地 OpenClaw → 首次登录多一步选对话模型。
 *  站点开着人机验证也在应用内做完(go-captcha 五种模式全部原生渲染,见 components/Captcha);
 *  内嵌官方登录页那条旁路已删,理由见 main/yunwu-auth.ts 文件头。
 *
 * **模型从用户自己的 key 里选,不是我们下发的**:桌面端每次调用都记在他自己的云雾余额上,
 * 我们没有公共模型,替他钦定一份清单既不省钱也不保证调得通(理由见 `shared/public-models.ts`
 * 与方案 P5)。选完就固化,以后要加去设置→模型页。这一处**刻意不跟 WorkBuddy** ——
 * 它的官方模型是腾讯自家掏钱的,前提不同。
 *
 * **但「首次配置长什么样」是跟它的**:登录完不弹框,而是原地换成欢迎屏、再换成选择屏。
 * 依据是它的 `OnboardingModal`(`inspiration-<hash>.js`)—— 名字叫 Modal,根类名却是
 * `ob-inline`,CSS 注释写着 *2-step inline flow*,而「之后再改」才是真弹窗 `SettingsModal`。
 * 一件必须做完才能进主界面的事,做成「盖在上面、带个关闭叉」的框是自相矛盾的。
 *
 * 顺带纠正一处容易被语言包误导的地方:它的 zh-cn 里有 `onboarding.stepLabels`
 * (「欢迎,兴趣偏好,开始」)和 `上一步`/`下一步`,但 `inspiration-*.js` 里**一个消费者都没有**
 * ——那是没上线的残留。上线的实现是两步、没有步骤指示器,所以我们也不做那根进度条。
 */
export default function Activate({ onActivated, expired }: Props) {
  const [baseUrl, setBaseUrl] = useState(YUNWU_BASE_URL)
  const [username, setUsername] = useState(expired?.username ?? '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // 非空时弹出对应类型的人机验证码;通过后带 token 登录。
  const [captchaType, setCaptchaType] = useState<CaptchaType | null>(null)
  const [phase, setPhase] = useState<Phase>('login')
  /**
   * 登录换来的激活配置,在引导那两步里存着:令牌已经写进去了,只差选模型这一步才进主界面。
   * 跳过或选完都拿它 onActivated。
   */
  const [pending, setPending] = useState<ActivationConfig | null>(null)
  /** 后端回的规范用户名,只用来在欢迎屏上称呼一声。 */
  const [who, setWho] = useState('')
  const shake = useAnimationControls()

  /**
   * 报错的统一出口:出文案的同时抖一下输入区。
   * 密码错这类高频失败只弹一行小字容易被忽略,而位移比配色更抓眼(且不依赖颜色,
   * 对色觉障碍同样成立)。
   */
  function fail(message: string): void {
    setError(message)
    void shake.start({
      x: [0, -9, 8, -6, 4, 0],
      transition: { duration: 0.4 }
    })
  }

  /**
   * 校验令牌可用 → 写入本地 OpenClaw → 首次登录再选一次模型 → 进入。
   * 用局部变量而非 state,避免异步 setState 未及时生效。
   *
   * 这里仍打一次 `/v1/models`,但**只为确认这个令牌真能调 API**(登录成功不等于令牌有模型
   * 权限,分组配错时会在这一步就报出来,而不是等用户发第一条消息才失败)。返回的清单不参与
   * 落盘 —— 以前是拿它截前 40 个写进配置,而那 40 个实际是接口返回顺序的前 40 个
   * (`tts-1`、`davinci-002`、一堆视频模型)。
   *
   * 递进去的 `models` / `defaultModel` 只是占位:真正落盘的清单由主进程**按账号**解析
   * (`main/model-catalog.ts`),这里不知道这个账号选过什么。所以下面一律用返回的
   * `act.data`,别用手上这份 config —— 用错会把老用户的选择冲成兜底清单。
   */
  async function fetchAndActivate(
    bUrl: string,
    tk: string,
    uid: number,
    user: string
  ): Promise<void> {
    const res = await window.api.validateToken(bUrl, tk)
    if (!res.ok) {
      fail(res.error ?? '校验失败')
      return
    }
    const config: ActivationConfig = {
      baseUrl: bUrl,
      token: tk,
      userId: uid,
      username: user,
      models: PUBLIC_MODELS,
      defaultModel: PUBLIC_DEFAULT_MODEL
    }
    const act = await window.api.activate(config)
    if (!act.ok || !act.data) {
      fail(act.error ?? '激活失败')
      return
    }
    const resolved = act.data
    // 没选过对话模型 → 从欢迎屏走整条引导;对话选过但媒体没选过(这个账号是媒体选择器
    // 上线之前登录的)→ 只补媒体那一步,不必再让他看一遍欢迎屏和已经选好的对话清单。
    const catalog = await window.api.modelCatalog()
    if (catalog.ok && catalog.data && !catalog.data.chosen) {
      setPending(resolved)
      setWho(user)
      setPhase('welcome')
      return
    }
    if (catalog.ok && catalog.data && !catalog.data.mediaChosen) {
      setPending(resolved)
      setWho(user)
      setPhase('media')
      return
    }
    onActivated(resolved)
  }

  /**
   * 对话模型选完:落盘,然后进媒体那一步。
   *
   * 主进程回的新配置先存着而不是立刻 `onActivated` —— 对话清单已经生效了,进主界面这个动作
   * 要等媒体那一步走完(或跳过)再做,否则用户会先看到主界面、再被一个选择器盖住。
   */
  async function confirmModels(models: ModelInfo[]): Promise<void> {
    const res = await window.api.selectModels(models)
    if (!res.ok || !res.data) {
      // 选择器自己没有报错位,失败就退回登录页把话说清楚(令牌已写好,重登即可)。
      setPending(null)
      setPhase('login')
      fail(res.error ?? '保存模型清单失败')
      return
    }
    setPending(res.data)
    setPhase('media')
  }

  /**
   * 媒体三档选完:落盘后进主界面。
   *
   * 这一步失败**不退回登录页**:对话模型已经存好了,媒体只是让三个工具能不能上架,
   * 拿现有配置进去比把人踢回登录页更合理(他可以在设置→模型里重试)。
   */
  async function confirmMedia(selection: MediaSelection): Promise<void> {
    await window.api.selectMediaModels(selection)
    if (pending) onActivated(pending)
  }

  /** 跳过选择:令牌那时已经写好了,跳过只是不写选择,下次登录会再问一次。 */
  function skipModels(): void {
    if (pending) onActivated(pending)
  }

  /**
   * 携带(可选)验证码 token 直连登录。
   *
   * 后端以人机验证为由拒绝、而这次又没带 token,多半是 `/api/status` 那份开关读到了旧值
   * (管理员刚打开验证码)。这时按站点当前类型补弹一次验证层,而不是把错误甩给用户。
   * 带着 token 还被拒就是真过不去了,如实报错——后端换了验证方式的话,该来改这里。
   */
  async function doLogin(captchaToken?: string): Promise<void> {
    setError('')
    setBusy(true)
    try {
      const res = await window.api.login(baseUrl, username, password, captchaToken)
      if (!res.ok || !res.data) {
        if (res.needCaptcha && !captchaToken) {
          const cfg = await window.api.captchaConfig(baseUrl)
          if (cfg.ok && cfg.data && isNativeCaptcha(cfg.data.type)) {
            setCaptchaType(cfg.data.type)
            return
          }
        }
        fail(res.error ?? '登录失败')
        return
      }
      setBaseUrl(res.data.baseUrl)
      // 身份用后端回的 userId(清单按它分账号存),用户名只拿来在欢迎屏上称呼一声 ——
      // 后端没给名字时退回输入框里的那个,反正它不参与存储键。
      await fetchAndActivate(
        res.data.baseUrl,
        res.data.token,
        res.data.userId,
        res.data.username || username.trim()
      )
    } finally {
      setBusy(false)
    }
  }

  /**
   * 点「登录」:先查站点验证码开关。
   *  未开 → 直接登录;开且是我们认识的模式 → 弹应用内验证层;开但模式不认识 → 如实报错。
   *
   * 2026-08-14 实测 yunwu.ai 与 api.openlux.ai 都是 `captcha_login_enabled: true` +
   * `captcha_type: click-shape`,两站的 `turnstile_check` 均为 false。五种模式我们全都
   * 原生渲染,所以最后那支只会在后端**换了新验证方式**时命中——那时该做的是来这儿适配,
   * 不是绕道走。
   */
  async function handleLogin(): Promise<void> {
    setError('')
    setBusy(true)
    try {
      const cfg = await window.api.captchaConfig(baseUrl)
      if (cfg.ok && cfg.data?.enabled) {
        if (isNativeCaptcha(cfg.data.type)) {
          setCaptchaType(cfg.data.type)
          return
        }
        fail(`站点启用了暂不支持的验证方式(${cfg.data.type}),请升级客户端`)
        return
      }
      await doLogin()
    } finally {
      setBusy(false)
    }
  }

  const canLogin = !!username.trim() && !!password

  return (
    // reducedMotion="user" 跟随系统「减少动态效果」,开了就只保留透明度过渡。
    <MotionConfig reducedMotion="user">
      <div className="login-screen">
        <div className="login-glow login-glow--a" aria-hidden="true" />
        <div className="login-glow login-glow--b" aria-hidden="true" />
        <div className="login-dots" aria-hidden="true" />

        {/* mode="wait" 让上一屏退干净再进下一屏,两屏同时在场会互相盖住。 */}
        <AnimatePresence mode="wait">
          {phase === 'login' && (
            <motion.div
              key="login"
              className="login-body"
              variants={STAGGER}
              initial="hidden"
              animate="show"
              exit={LEAVE}
            >
              <motion.div className="login-mascot-lg" variants={RISE}>
                <div className="login-mascot-float">
                  <Mascot />
                </div>
              </motion.div>
              <motion.h1 className="login-title" variants={RISE}>
                {expired ? '登录已过期' : '云雾桌面客户端'}
              </motion.h1>
              <motion.p className="login-sub" variants={RISE}>
                {expired
                  ? '云雾的登录有效期 30 天。重新登录一次即可,本地的模型配置与任务都还在。'
                  : '在本地运行你的 OpenClaw,像助手一样处理本地文件'}
              </motion.p>

              <motion.div className="login-form" variants={RISE}>
                {/* 抖动挂在内层:外层那个 transform 归入场动画所有,同一元素上两者会互相覆盖。 */}
                <motion.div className="login-fields" animate={shake}>
                  <div className="login-line">
                    <input
                      type="text"
                      value={username}
                      placeholder="云雾用户名 / 邮箱"
                      disabled={busy}
                      onChange={(e) => setUsername(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && canLogin) void handleLogin()
                      }}
                    />
                  </div>
                  <div className="login-line">
                    <input
                      type="password"
                      value={password}
                      placeholder="登录密码"
                      disabled={busy}
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && canLogin) void handleLogin()
                      }}
                    />
                  </div>
                </motion.div>

                <AnimatePresence initial={false}>
                  {error && (
                    <motion.div
                      className="login-error"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.22, ease: EASE_OUT }}
                    >
                      {error}
                    </motion.div>
                  )}
                </AnimatePresence>

                <button className="login-cta" onClick={handleLogin} disabled={busy || !canLogin}>
                  {busy ? (
                    <>
                      <LoadingLottie size="xs" />
                      登录中…
                    </>
                  ) : (
                    '登录'
                  )}
                </button>
              </motion.div>

              {expired ? (
                /* 留一条出口:密码一时想不起来也不该被关在门外 —— sk- 令牌没过期,
                   聊天、任务、模型全都照用,只有余额那一格取不到数。 */
                <motion.p className="login-note" variants={RISE}>
                  <button className="login-skip" disabled={busy} onClick={expired.onSkip}>
                    暂不登录,先继续用
                  </button>
                  （账户菜单里的余额会显示「登录已过期」,其余功能不受影响）
                </motion.p>
              ) : (
                <motion.p className="login-note" variants={RISE}>
                  登录后自动创建专用令牌,并让你从账号可用的模型里挑几个常用的;以后随时在「设置 →
                  模型」里增删。
                </motion.p>
              )}
            </motion.div>
          )}

          {phase === 'welcome' && (
            <motion.div
              key="welcome"
              className="login-body ob-body"
              variants={STAGGER}
              initial="hidden"
              animate="show"
              exit={LEAVE}
            >
              <motion.div className="login-mascot-lg" variants={RISE}>
                <div className="login-mascot-float">
                  <Mascot />
                </div>
              </motion.div>
              <motion.h1 className="login-title" variants={RISE}>
                欢迎使用云雾助手{who && `,${who}`}
              </motion.h1>
              <motion.p className="login-sub" variants={RISE}>
                专用令牌已经准备好了。开始之前挑一下要用的对话模型和媒体模型,之后随时能改。
              </motion.p>

              <motion.div className="ob-points" variants={RISE}>
                {POINTS.map((p) => (
                  <div className="ob-point" key={p.title}>
                    <span className="ob-point-icon">
                      <p.icon size={17} strokeWidth={1.8} />
                    </span>
                    <div className="ob-point-text">
                      <b>{p.title}</b>
                      <span>{p.desc}</span>
                    </div>
                  </div>
                ))}
              </motion.div>

              <motion.div className="ob-actions" variants={RISE}>
                <button className="login-cta" onClick={() => setPhase('models')}>
                  挑选我的模型
                </button>
                <button className="login-alt" onClick={skipModels}>
                  先跳过,之后在设置里选
                </button>
              </motion.div>
            </motion.div>
          )}

          {phase === 'models' && (
            <motion.div
              key="models"
              className="ob-picker"
              initial={{ opacity: 0, y: 12 }}
              animate={{
                opacity: 1,
                y: 0,
                transition: { duration: 0.42, ease: EASE_OUT }
              }}
              exit={LEAVE}
            >
              <ModelPicker
                inline
                title="挑几个你常用的对话模型"
                hint="这些模型消耗的是你自己云雾账号的余额,清单的第一条会作为默认模型(拖动已选标签可换)。之后随时在「设置 → 模型」里增删。"
                confirmText="下一步"
                dismissible={false}
                onConfirm={confirmModels}
                // 拉不到可选池时的退路:令牌已经写好了,先拿兜底清单进去,下次登录再问一次。
                onSkip={skipModels}
              />
            </motion.div>
          )}

          {phase === 'media' && (
            <motion.div
              key="media"
              className="ob-picker"
              initial={{ opacity: 0, y: 12 }}
              animate={{
                opacity: 1,
                y: 0,
                transition: { duration: 0.42, ease: EASE_OUT }
              }}
              exit={LEAVE}
            >
              <MediaPicker
                inline
                title="再挑出图、视频和朗读用的模型"
                hint="预勾的是常用的那几个,不想要的取消掉即可。一档都不选就等于关掉那个能力,之后随时在「设置 → 模型」里改。"
                confirmText="开始使用"
                dismissible={false}
                onConfirm={confirmMedia}
                // 媒体不是必需项:跳过就是三档都不接,专家手上没有这三样工具而已。
                onSkip={skipModels}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {captchaType && (
          <Captcha
            baseUrl={baseUrl}
            type={captchaType}
            onSuccess={(token) => {
              setCaptchaType(null)
              void doLogin(token)
            }}
            onClose={() => setCaptchaType(null)}
          />
        )}
      </div>
    </MotionConfig>
  )
}
