/**
 * 任务批量操作的纯逻辑。形状照 WorkBuddy
 * `packages/agent-ui/src/components/conversation-list/batch-operations/`
 * （asar 解包核对）的三个文件:selection.ts / operation-runner.ts / use-batch-operations.tsx。
 *
 * 刻意跟住的三条:
 *  - 选择态是「动作中立」的:进入批量后先按「能不能操作」勾选,点删除或归档时再按该动作过滤一次;
 *  - 运行中 / 待确认不可选(它的 workingStatuses + PENDING_STATUS);
 *  - 执行是**受限并发**,不是 Promise.all 也不是纯串行;单条失败不打断其它条。
 */

import type { TaskFilterStatus } from './task-filter'

export type BatchAction = 'delete' | 'archive'

/** 并发上限,原样取它的 `DEFAULT_CONCURRENCY`。 */
export const BATCH_CONCURRENCY: Record<BatchAction, number> = {
  delete: 3,
  archive: 5
}

/** 没有可执行目标:确认框保持打开并改文案,而不是静默关掉(它的 NO_EFFECTIVE_TASK_ERROR)。 */
export const BATCH_NO_EFFECTIVE_TASK = 'BATCH_NO_EFFECTIVE_TASK'

/**
 * 一条任务在批量态下是否可选。
 *
 * 它的规则是「运行中家族 + pending 不可选」,我们没有 canDelete/canArchive 那层
 * （云端助理 / 项目任务才有区别,我们每条任务两种操作都支持),所以只剩状态这一条。
 */
export function isBatchSelectable(status: TaskFilterStatus): boolean {
  return status !== 'working' && status !== 'planning' && status !== 'pending'
}

/** 不可选的原因,文案取它的 `batch.disabled.running`。 */
export function batchDisabledReason(status: TaskFilterStatus): string | null {
  return isBatchSelectable(status) ? null : '该任务正在运行中,请结束后再操作'
}

export function toggleSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  return next
}

export function collectSelectableIds<T extends { id: string }>(
  items: readonly T[],
  statusOf: (item: T) => TaskFilterStatus
): Set<string> {
  const ids = new Set<string>()
  for (const item of items) {
    if (isBatchSelectable(statusOf(item))) {
      ids.add(item.id)
    }
  }
  return ids
}

export function isAllSelectableSelected(
  selected: ReadonlySet<string>,
  selectableIds: ReadonlySet<string>
): boolean {
  if (selectableIds.size === 0) {
    return false
  }
  for (const id of selectableIds) {
    if (!selected.has(id)) {
      return false
    }
  }
  return true
}

/**
 * 全选框的三态。`allSelected` 要求「可选项全被选中」**且**可选项覆盖了整个可见列表 ——
 * 列表里混着不可选的任务时不显示成全选,这条是它的原文判断。
 */
export function getSelectAllState<T extends { id: string }>(
  visible: readonly T[],
  selected: ReadonlySet<string>,
  statusOf: (item: T) => TaskFilterStatus
): { allSelected: boolean; indeterminate: boolean } {
  const selectableIds = collectSelectableIds(visible, statusOf)
  const allSelected =
    isAllSelectableSelected(selected, selectableIds) && selectableIds.size === visible.length
  return { allSelected, indeterminate: !allSelected && selected.size > 0 }
}

/** 执行前兜底:只保留仍然可选的 id(批量态里任务状态会变)。 */
export function filterEffectiveSelection(
  selected: ReadonlySet<string>,
  selectableIds: ReadonlySet<string>
): Set<string> {
  const next = new Set<string>()
  for (const id of selected) {
    if (selectableIds.has(id)) {
      next.add(id)
    }
  }
  return next
}

export interface BatchItemResult {
  id: string
  success: boolean
}

export interface BatchSummary {
  action: BatchAction
  totalCount: number
  successIds: string[]
  failedIds: string[]
}

/** 受限并发:按输入顺序调度,同时运行数不超过 limit。 */
export async function runWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  const safeLimit = Math.max(1, Math.min(limit, items.length || 1))
  let cursor = 0
  const runNext = async (): Promise<void> => {
    while (cursor < items.length) {
      const current = cursor
      cursor += 1
      results[current] = await worker(items[current], current)
    }
  }
  const runners: Promise<void>[] = []
  for (let i = 0; i < safeLimit; i += 1) {
    runners.push(runNext())
  }
  await Promise.all(runners)
  return results
}

/** 执行批量删除 / 归档并汇总。单条抛异常按失败计入,不打断其它条。 */
export async function runBatchOperation<T extends { id: string }>(params: {
  action: BatchAction
  items: readonly T[]
  worker: (item: T) => Promise<BatchItemResult>
  onProgress?: (completed: number, total: number) => void
  concurrency?: number
}): Promise<BatchSummary> {
  const { action, items, worker, onProgress } = params
  const total = items.length
  if (total === 0) {
    throw new Error(BATCH_NO_EFFECTIVE_TASK)
  }
  const concurrency = params.concurrency ?? BATCH_CONCURRENCY[action]
  let completed = 0
  const results = await runWithConcurrencyLimit(items, concurrency, async (item) => {
    let result: BatchItemResult
    try {
      result = await worker(item)
    } catch {
      result = { id: item.id, success: false }
    }
    completed += 1
    onProgress?.(completed, total)
    return result
  })

  const summary: BatchSummary = { action, totalCount: total, successIds: [], failedIds: [] }
  for (const result of results) {
    if (result.success) {
      summary.successIds.push(result.id)
    } else {
      summary.failedIds.push(result.id)
    }
  }
  return summary
}

/** 结果提示,文案取它的 `batch.toast.*`。 */
export function batchSummaryMessage(summary: BatchSummary): string {
  const successCount = summary.successIds.length
  const failedCount = summary.failedIds.length
  const isDelete = summary.action === 'delete'
  if (successCount === 0 && failedCount > 0) {
    return '操作失败,请稍后重试'
  }
  if (failedCount > 0) {
    return isDelete
      ? `已删除 ${successCount} 项,${failedCount} 项失败`
      : `已归档 ${successCount} 项,${failedCount} 项失败`
  }
  return isDelete ? `已删除 ${successCount} 项任务` : `已归档 ${successCount} 项任务`
}
