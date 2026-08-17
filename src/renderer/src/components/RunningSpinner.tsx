import type { ReactNode } from 'react'

/** 辐条角度:6 条 60° 均分,与 WorkBuddy LoadingIcon 的 path 逐点等价。 */
const SPOKES = [0, 60, 120, 180, 240, 300]

/**
 * 任务「正在执行」的行内指示器。
 *
 * 形状取自 WorkBuddy 的 `LoadingIcon`(agent-ui 图标集),它在侧栏任务卡
 * `conversation-agent-card` 的 trailingStatus 槽位上就是这个:
 * `<LoadingIcon spin color="var(--wb-palette-brand-8)" />`,
 * 转速照它的 `.wb-icon--spin`(1.2s linear infinite,见 styles.css)。
 * 原图是一条 fill-rule=evenodd 的 path,这里换成 6 个 rect 绕 (8,8) 旋转 ——
 * 几何完全相同(内半径 2.5、外半径 6.5、条宽 1.2),但改条数/粗细不用重算贝塞尔。
 *
 * 这里**不用** LoadingLottie,是这个尺寸下实测过的:我们那份 loading.lottie.json 是
 * 429×451 的四层彩色动画(橙 #ff7d00 / 棕 #78290f / 深青 #15616d / 米 #ffecd1),
 * 缩到 14px 只剩一个橙色小方块,既看不出在转,也和侧栏一水儿的单色线性图标打架。
 * 动画规范里「单元素 spinner 走 CSS」正是留给这种情况的。
 */
export default function RunningSpinner({ className }: { className?: string }): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {SPOKES.map((deg) => (
        <rect key={deg} x="7.4" y="1.5" width="1.2" height="4" transform={`rotate(${deg} 8 8)`} />
      ))}
    </svg>
  )
}
