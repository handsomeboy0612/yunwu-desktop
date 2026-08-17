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
          category: mi.category ?? 'chat',
          // 协议覆盖必须原样带过来:丢了它,只吃 /v1/responses 的那批模型会被当成
          // 普通 completions 模型下发,上游直接回「不是 chat 模型」。
          ...(mi.api ? { api: mi.api } : {}),
          // 思考声明同理:掉在这里的话,界面会退回"只有开关"、配置层也写不出
          // thinkingLevelMap,`gpt-5-pro` 这种"只收 high"的族就会被按普通三档下发。
          ...(mi.thinkingLevels?.length ? { thinkingLevels: mi.thinkingLevels } : {}),
          ...(mi.defaultThinkingLevel ? { defaultThinkingLevel: mi.defaultThinkingLevel } : {}),
          ...(mi.canDisableThinking === false ? { canDisableThinking: false } : {}),
          ...(mi.thinkingEffort === false ? { thinkingEffort: false } : {}),
          ...(mi.thinkingFormat ? { thinkingFormat: mi.thinkingFormat } : {})
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
    // userId 缺失(早期版本写的激活态)一律当作未激活,让用户重登一次换到新身份口径。
    // 这一步换来的是「有激活态就一定有 userId」,模型清单那侧因此不需要任何回退分支。
    if (!parsed.baseUrl || !parsed.token || typeof parsed.userId !== 'number') {
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
