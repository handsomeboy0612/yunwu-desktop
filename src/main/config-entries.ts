/**
 * 声明式配置写入的最小工具:一条条「把这个值整体赋到这个点分路径」。
 *
 * 这份文件的前身是 config-patch-plan.ts,那里有一百多行是**专门伺候 config.patch 的**:
 * 删键要补 null 墓碑、数组要逐条声明 replacePaths、删一个供货商还得把子树里的数组一起
 * 声明(照内核 collectBaseArrayPaths 的口径)。改走 config.set 整份写回之后,这些全部消失
 * ——整份提交里「没有这个键」本身就表达了删除,不需要墓碑;数组直接赋值,不存在按 id 合并。
 *
 * 纯函数、不碰 I/O:调用方负责取配置快照,故这份逻辑可脱离网关单独验证。
 */

/** 一条声明式配置写入:把 `value` 整体赋到点分路径 `path`。 */
export interface ConfigEntry {
  path: string
  value: unknown
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 沿点分路径取值;中途缺失返回 undefined。 */
function readPath(root: Record<string, unknown>, path: string): unknown {
  let node: unknown = root
  for (const seg of path.split('.')) {
    if (!isPlainObject(node)) {
      return undefined
    }
    node = node[seg]
  }
  return node
}

/**
 * 这批赋值相对给定快照是否是空操作(每条路径上的现值都已等于要写的值)。
 *
 * 网关那条路已经有更严的判断(setConfig 对整份配置深比,没差异不发请求),这里是给 **CLI
 * 兜底**用的:`openclaw config set` 给什么写什么,没有任何短路。而启动期偏偏总走 CLI
 * (网关还没连上),于是每次启动都白写一次「Updated 5 config paths」,把正在预热的网关
 * 再顶去做一轮热加载——而那几个值其实一次都没变。
 *
 * 比较用 JSON 序列化:这些值都是从配置里读出/构造的纯 JSON,没有 undefined、循环引用或
 * 键序不稳的来源(构造处都是字面量),够用且不必引依赖。
 */
export function configBatchIsNoop(
  batch: ConfigEntry[],
  current: Record<string, unknown>
): boolean {
  return batch.every((e) => JSON.stringify(readPath(current, e.path)) === JSON.stringify(e.value))
}

/** 就地把一批赋值打到配置对象上;路径中缺失的中间层按需建出来。 */
export function applyConfigEntries(config: Record<string, unknown>, batch: ConfigEntry[]): void {
  for (const entry of batch) {
    const segs = entry.path.split('.')
    const leaf = segs.pop() as string
    let node = config
    for (const seg of segs) {
      const child = node[seg]
      if (!isPlainObject(child)) {
        node[seg] = {}
      }
      node = node[seg] as Record<string, unknown>
    }
    node[leaf] = entry.value
  }
}

/** 就地删掉某个点分路径上的键;路径不存在则什么都不做。 */
export function deleteConfigPath(config: Record<string, unknown>, path: string): void {
  const segs = path.split('.')
  const leaf = segs.pop() as string
  let node: unknown = config
  for (const seg of segs) {
    if (!isPlainObject(node)) {
      return
    }
    node = node[seg]
  }
  if (isPlainObject(node)) {
    delete node[leaf]
  }
}
