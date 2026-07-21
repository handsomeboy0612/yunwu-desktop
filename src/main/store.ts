import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs'
import type { ActivationConfig, ModelInfo, TaskMeta } from '@shared/types'
import { inferModelInfoFromId } from './model-capabilities'

/** 激活配置持久化到用户数据目录下的 activation.json。 */
function activationFile(): string {
  return join(app.getPath('userData'), 'activation.json')
}

/** 任务列表元数据持久化到用户数据目录下的 tasks.json。 */
function tasksFile(): string {
  return join(app.getPath('userData'), 'tasks.json')
}

/**
 * 归一化 models 字段:兼容老配置(models 为 string[])→ 升级为带能力的 ModelInfo[]。
 * 老配置无能力信息,按模型名启发式兜底推导;用户下次登录会用后端 tags 覆盖为准确值。
 */
function normalizeModels(models: unknown): ModelInfo[] {
  if (!Array.isArray(models)) {
    return []
  }
  return models
    .map((m) => {
      if (typeof m === 'string') {
        return inferModelInfoFromId(m)
      }
      if (m && typeof m === 'object' && typeof (m as ModelInfo).id === 'string') {
        const mi = m as Partial<ModelInfo>
        return {
          id: mi.id as string,
          reasoning: !!mi.reasoning,
          vision: !!mi.vision,
          tools: mi.tools !== false,
          category: mi.category ?? 'chat'
        } as ModelInfo
      }
      return null
    })
    .filter((m): m is ModelInfo => m !== null)
}

/** 读取已保存的激活配置;不存在或解析失败时返回 null。 */
export function loadActivation(): ActivationConfig | null {
  const file = activationFile()
  if (!existsSync(file)) {
    return null
  }
  try {
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as ActivationConfig
    if (!parsed.baseUrl || !parsed.token) {
      return null
    }
    return { ...parsed, models: normalizeModels(parsed.models) }
  } catch {
    return null
  }
}

/** 保存激活配置(覆盖写)。 */
export function saveActivation(config: ActivationConfig): void {
  writeFileSync(activationFile(), JSON.stringify(config, null, 2), 'utf-8')
}

/** 清除激活配置(退出登录)。文件不存在时静默返回。 */
export function clearActivation(): void {
  const file = activationFile()
  if (existsSync(file)) {
    rmSync(file)
  }
}

/** 读取持久化的任务元数据列表;不存在或解析失败时返回空数组。 */
export function loadTasks(): TaskMeta[] {
  const file = tasksFile()
  if (!existsSync(file)) {
    return []
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    return Array.isArray(parsed) ? (parsed as TaskMeta[]) : []
  } catch {
    return []
  }
}

/** 覆盖写入任务元数据列表。 */
export function saveTasks(tasks: TaskMeta[]): void {
  writeFileSync(tasksFile(), JSON.stringify(tasks, null, 2), 'utf-8')
}
