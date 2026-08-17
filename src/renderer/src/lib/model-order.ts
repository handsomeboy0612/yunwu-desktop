/**
 * 已选模型清单的顺序运算。
 *
 * 顺序在这个产品里**不是显示问题**:清单第一条会被写成内核的兜底档
 * (`resolvePrimary` → `agents.defaults.model.primary`,`config-writer.ts:274`),
 * 也决定对话框里下拉的先后。所以它是数据,得有一份能离线跑的判据
 * (`scripts/verify-model-order.mjs`),而不是散在组件的 setState 回调里。
 */

/**
 * 勾选/取消:新勾的**追加到末尾**。
 *
 * 这条决定了「默认模型只在用户动了它自己那条时才变」——在设置里随手加一个模型不会把
 * 默认模型换掉(若按池子的字母序回传就会,而用户既没要求也看不出来)。
 * 取消再勾等于重新加入,回到末尾,不保留原来的位置:位置是用户能看见的东西,
 * 悄悄记住一个看不见的旧位置更让人费解。
 */
export function togglePicked(order: readonly string[], id: string): string[] {
  return order.includes(id) ? order.filter((x) => x !== id) : [...order, id]
}

/**
 * 把 `dragged` 挪到 `target` 现在的位置(其余相对次序不变)。
 *
 * 语义是「占掉目标的位置」而不是「插到目标之前」:chips 会换行,「之前/之后」得先判
 * 指针落在目标的左半还是右半,而拖动途中就换位没有这个歧义 —— 往左拖是插在目标前面,
 * 往右拖是插在目标后面,两个方向都符合直觉。
 *
 * 不认识的 id、同一个 id、没变化的一律返回**原数组本身**,让 React 的浅比较能短路掉
 * 一次重渲染(dragenter 在拖动途中会连发很多次)。
 */
export function moveBefore(order: readonly string[], dragged: string, target: string): string[] {
  if (dragged === target) {
    return order as string[]
  }
  const from = order.indexOf(dragged)
  const to = order.indexOf(target)
  if (from < 0 || to < 0 || from === to) {
    return order as string[]
  }
  const next = order.slice()
  next.splice(from, 1)
  next.splice(to, 0, dragged)
  return next
}
