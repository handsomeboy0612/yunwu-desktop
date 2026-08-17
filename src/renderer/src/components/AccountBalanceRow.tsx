import { CircleAlert, RefreshCw, Wallet } from 'lucide-react'
import type { AccountSnapshot } from '@shared/types'

interface Props {
  /** 主进程给的快照;null 表示还没取过(显示「获取中」)。 */
  snapshot: AccountSnapshot | null
  /** 是否有请求在飞(有旧值时旧值继续显示,只让刷新按钮转起来)。 */
  fetching: boolean
  onRefresh: () => void
  /** 会话过期时点「重新登录」:只为把余额取回来,不影响聊天。 */
  onRelogin: () => void
}

/**
 * 账户菜单里的余额区:余额一行 + 已用 / 分组两行。
 *
 * 形状照 WorkBuddy 的 credits 区(`account-panel__credits-*`):左边是带图标的标签,
 * 右边是大号数字,数字按取数状态分档显示 ——
 *
 * | 它的状态 | 显示 | 我们对应 |
 * |---|---|---|
 * | `loading` | 绿色「获取中」 | 同 |
 * | `success` | 数字(低额度标红 `--low`) | 同,低额度判据由主进程按 quota_per_unit 折算 |
 * | `stale` | 数字 + 绿底小徽章「缓存」 | 同,徽章文案「缓存」 |
 * | `failed-no-cache` | 红色「获取失败」+ 下方一条警示 | 同,并给一个重试按钮 |
 *
 * 多出来的一档是 `expired`:点它回登录页(WorkBuddy 的 `isAuthExpired` 也是把入口换成
 * 「重新登录」,只不过它整颗触发器都换掉 —— 它的会话一过期整个产品就用不了)。
 * 我们的会话独立于 sk- 令牌,过期时聊天照常,所以只换这一行;但**重登一律走登录页**,
 * 不在工作台里弹密码框 —— 「登录过期就回登录页」是用户对任何软件的既有预期,
 * 应用内突然要密码反而像钓鱼。
 *
 * **任何一档都不显示 0** —— 余额显示成 0 会被读成「我的钱没了」,
 * 而这一格恰好是最容易让人误判的地方。
 */
export default function AccountBalanceRow({ snapshot, fetching, onRefresh, onRelogin }: Props) {
  const balance = snapshot?.balance ?? null
  // 还没有任何结果 → 获取中;有旧值时即便在飞也先把旧值画出来(照它:stale 也照样显示数字)。
  const kind = !snapshot ? 'loading' : snapshot.status

  return (
    <>
      <div className="account-balance">
        <span className="account-balance-label">
          <Wallet size={14} strokeWidth={1.8} />
          余额
        </span>
        <span className="account-balance-value">
          {kind === 'loading' && <span className="account-balance-hint">获取中…</span>}

          {(kind === 'ok' || kind === 'stale') && balance && (
            <>
              <b className={`account-balance-num${balance.low ? ' low' : ''}`}>
                {balance.display}
              </b>
              {kind === 'stale' && (
                <span
                  className="account-balance-badge"
                  title={snapshot?.message || '这次没取到最新余额,显示的是上次的数'}
                >
                  缓存
                </span>
              )}
            </>
          )}

          {kind === 'expired' && (
            <button className="account-balance-link" onClick={onRelogin}>
              登录已过期,重新登录
            </button>
          )}

          {kind === 'unavailable' && (
            <span
              className="account-balance-failed"
              title={snapshot?.message || '取余额失败'}
            >
              <CircleAlert size={13} strokeWidth={1.9} />
              获取失败
            </span>
          )}

          {kind !== 'expired' && (
            <button
              className="account-balance-refresh"
              title="刷新余额"
              aria-label="刷新余额"
              disabled={fetching}
              onClick={onRefresh}
            >
              <RefreshCw size={12} strokeWidth={1.9} className={fetching ? 'spin' : undefined} />
            </button>
          )}
        </span>
      </div>

      {balance && (
        <>
          <div className="account-row">
            <span>累计已用</span>
            <b>{balance.usedDisplay}</b>
          </div>
          {balance.group && (
            <div className="account-row">
              <span>用户分组</span>
              <b>{balance.group}</b>
            </div>
          )}
        </>
      )}
    </>
  )
}