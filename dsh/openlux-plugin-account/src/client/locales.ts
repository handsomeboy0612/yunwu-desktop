/**
 * Copy for the sign-in step.
 *
 * Registered as its own locale namespace and read through the bound `t`, the
 * way every kernel feature does it (`ui-settings-models/src/client/index.ts:68,75`).
 * Hardcoding the Chinese would leave this one surface unchanged when the user
 * switches the app to English — and the host half already answers the console
 * in whichever language this same preference selects.
 */

/** Simplified Chinese dictionary; the key set every other locale is checked against. */
export const zh = {
  'title': '登录 OpenLux',
  'description': '登录后自动配置密钥，随即可以开始对话。',
  'account': '账号',
  'accountPlaceholder': '用户名或邮箱',
  'password': '密码',
  'passwordPlaceholder': '请输入密码',
  'submit': '登录',
  'submitting': '登录中…',
  'later': '稍后',
  'needAccount': '还没有账号？到 openlux.ai 注册后回来登录。',
  'emptyFields': '请输入账号与密码',

  'captchaClickTitle': '按提示顺序点击图中内容',
  'captchaSlideTitle': '拖动拼块完成拼图',
  'captchaRotateTitle': '拖动滑条把图片转正',
  'captchaOrder': '点击顺序：',
  'captchaLoading': '加载中…',
  'captchaLoadFailed': '获取验证码失败',
  'captchaRefresh': '换一张',
  'captchaUndo': '撤销',
  'captchaConfirm': '确认',
  'captchaVerifying': '验证中…',
  'captchaNoPoints': '请按提示顺序点击',
  'captchaRetry': '验证未通过，请重试',
  'captchaRetryAgain': '还是没过，换一张试试',
  'captchaAngle': '旋转角度',

  'triggerAria': '账号与余额',
  'panelAria': '账号',
  'signedIn': '已登录',
  'signedOut': '未登录',
  'signIn': '登录',
  'signOut': '退出登录',
  'sessionExpired': '登录已过期，重新登录',
  'balance': '余额',
  'balanceLoading': '获取中…',
  'balanceStale': '缓存',
  'balanceStaleTitle': '这次没取到最新余额，显示的是上次的数',
  'balanceFailed': '获取失败',
  'refresh': '刷新余额',
  'used': '累计已用',
  'group': '用户分组',
} satisfies Record<string, string>

/** Key union of this package's copy. */
export type AccountKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'title': 'Sign in to OpenLux',
  'description': 'Signing in configures your key, so you can start right away.',
  'account': 'Account',
  'accountPlaceholder': 'Username or email',
  'password': 'Password',
  'passwordPlaceholder': 'Enter your password',
  'submit': 'Sign in',
  'submitting': 'Signing in…',
  'later': 'Later',
  'needAccount': 'No account yet? Register at openlux.ai, then come back.',
  'emptyFields': 'Enter your account and password',

  'captchaClickTitle': 'Click the items in the order shown',
  'captchaSlideTitle': 'Drag the piece into the gap',
  'captchaRotateTitle': 'Drag the slider to straighten the image',
  'captchaOrder': 'Click order:',
  'captchaLoading': 'Loading…',
  'captchaLoadFailed': 'Could not load the challenge',
  'captchaRefresh': 'New challenge',
  'captchaUndo': 'Undo',
  'captchaConfirm': 'Confirm',
  'captchaVerifying': 'Checking…',
  'captchaNoPoints': 'Click the items in the order shown',
  'captchaRetry': 'That was not right — try again',
  'captchaRetryAgain': 'Still not right; here is a new challenge',
  'captchaAngle': 'Rotation angle',

  'triggerAria': 'Account and balance',
  'panelAria': 'Account',
  'signedIn': 'Signed in',
  'signedOut': 'Not signed in',
  'signIn': 'Sign in',
  'signOut': 'Sign out',
  'sessionExpired': 'Session expired — sign in again',
  'balance': 'Balance',
  'balanceLoading': 'Loading…',
  'balanceStale': 'cached',
  'balanceStaleTitle': 'This refresh failed; showing the previous value',
  'balanceFailed': 'Could not read',
  'refresh': 'Refresh balance',
  'used': 'Total used',
  'group': 'User group',
} satisfies Record<AccountKey, string>
