import { useState } from 'react'
import type { ActivationConfig, CaptchaType, ModelInfo } from '@shared/types'
import Mascot from '../components/Mascot'
import Captcha, { isNativeCaptcha } from '../components/Captcha'

/** 云雾服务地址(固定主站,无需用户填写;私有化部署可后续在设置中开放)。 */
const YUNWU_BASE_URL = 'https://yunwu.ai'

interface Props {
  onActivated: (config: ActivationConfig) => void
}

/**
 * 登录 / 激活页:单步流程。
 *  云雾账号密码登录 → 自动换取 sk- 令牌 → 拉取可用模型 → 自动选默认(优先推理模型,开箱即见深度思考)
 *  → 写入本地 OpenClaw → 直接进入。默认模型可随时在「模型管理」中调整。
 *  站点开启人机验证时自动切换到网页登录(官方登录页内完成验证)。
 */
export default function Activate({ onActivated }: Props) {
  const [baseUrl, setBaseUrl] = useState(YUNWU_BASE_URL)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // 非空时弹出对应类型的人机验证码;通过后带 token 登录。
  const [captchaType, setCaptchaType] = useState<CaptchaType | null>(null)

  /**
   * 拉取可用模型 → 自动选默认(优先推理模型)→ 写入本地 OpenClaw → 进入。
   * 用局部变量而非 state,避免异步 setState 未及时生效。
   */
  async function fetchAndActivate(bUrl: string, tk: string): Promise<void> {
    const res = await window.api.validateToken(bUrl, tk)
    if (!res.ok || !res.data) {
      setError(res.error ?? '校验失败')
      return
    }
    const chatModels = res.data.models.filter((m) => m.category === 'chat')
    if (chatModels.length === 0) {
      setError('未发现可用的对话模型')
      return
    }
    const preferred = chatModels.find((m) => m.reasoning) ?? chatModels[0]
    const defaultModel = preferred.id
    const byId = new Map(chatModels.map((m) => [m.id, m]))
    const orderedIds = Array.from(
      new Set([defaultModel, ...chatModels.map((m) => m.id)])
    ).filter((id) => byId.has(id))
    const chosen = orderedIds.slice(0, 40).map((id) => byId.get(id) as ModelInfo)
    const config: ActivationConfig = { baseUrl: bUrl, token: tk, models: chosen, defaultModel }
    const act = await window.api.activate(config)
    if (!act.ok) {
      setError(act.error ?? '激活失败')
      return
    }
    onActivated(config)
  }

  /** 携带(可选)验证码 token 直连登录;后端仍要求验证码时回落网页登录。 */
  async function doLogin(captchaToken?: string): Promise<void> {
    setError('')
    setBusy(true)
    try {
      const res = await window.api.login(baseUrl, username, password, captchaToken)
      if (!res.ok || !res.data) {
        if (res.needCaptcha) {
          await handleWebLogin()
          return
        }
        setError(res.error ?? '登录失败')
        return
      }
      setBaseUrl(res.data.baseUrl)
      await fetchAndActivate(res.data.baseUrl, res.data.token)
    } finally {
      setBusy(false)
    }
  }

  /**
   * 点「登录」:先查站点验证码开关。
   *  未开 → 直接登录;开且为原生支持类型 → 弹验证码弹层;开且为 rotate/未知 → 直接走网页登录。
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
        await handleWebLogin()
        return
      }
      await doLogin()
    } finally {
      setBusy(false)
    }
  }

  /** 网页登录:打开内嵌官方登录页完成(账号密码 + 人机验证),成功后换取令牌并继续。 */
  async function handleWebLogin(): Promise<void> {
    setError('')
    setBusy(true)
    try {
      const res = await window.api.loginWebview(baseUrl)
      if (!res.ok || !res.data) {
        setError(res.error ?? '网页登录失败')
        return
      }
      setBaseUrl(res.data.baseUrl)
      await fetchAndActivate(res.data.baseUrl, res.data.token)
    } finally {
      setBusy(false)
    }
  }

  const canLogin = !!username.trim() && !!password

  return (
    <div className="center-screen">
      <div className="card activate-card">
        <div className="login-hero">
          <div className="login-mascot">
            <Mascot />
          </div>
          <h1>云雾桌面客户端</h1>
          <p className="muted">在本地运行你的 OpenClaw,像助手一样处理本地文件</p>
        </div>

        <label className="field">
          <span>账号</span>
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
        </label>
        <label className="field">
          <span>密码</span>
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
        </label>
        {error && <div className="alert-error">{error}</div>}
        <div className="login-actions">
          <button className="btn-primary" onClick={handleLogin} disabled={busy || !canLogin}>
            {busy ? '登录中…' : '登录'}
          </button>
          <button className="btn-ghost" onClick={handleWebLogin} disabled={busy}>
            网页登录(需人机验证时)
          </button>
          <span className="muted small">
            登录后自动创建专用令牌并选好默认模型,可随时在「模型管理」中调整;若需人机验证会先弹出验证。
          </span>
        </div>
      </div>

      {captchaType && (
        <Captcha
          baseUrl={baseUrl}
          type={captchaType}
          onSuccess={(token) => {
            setCaptchaType(null)
            void doLogin(token)
          }}
          onClose={() => setCaptchaType(null)}
          onFallback={() => {
            setCaptchaType(null)
            void handleWebLogin()
          }}
        />
      )}
    </div>
  )
}
