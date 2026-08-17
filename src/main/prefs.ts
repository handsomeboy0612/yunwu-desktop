import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { AppPreferences } from '@shared/types'

/**
 * 应用级偏好(我们自己的设置,不是 openclaw 的配置)。
 *
 * 单独一份 preferences.json,与 activation / tasks / providers 各自落盘的做法一致。
 */
function prefsFile(): string {
  return join(app.getPath('userData'), 'preferences.json')
}

/**
 * 默认值。
 *
 * `localSkillsMemoryEnabled` 默认开,与 WorkBuddy 同口径:它渲染端默认 `enabled = true`
 * (asar 里 `agent-ui/src/utils/local-skills-memory.ts:getLocalSkillsMemoryEnabled`,
 * 未设置时 return true)。它主进程存的是反向键 `disableLocalSkillsMemory`,那是为了
 * 迁就自家 AppConfig 的 `disable*` 命名约定;我们没有这个约定,存正向语义即可。
 */
const DEFAULTS: AppPreferences = {
  localSkillsMemoryEnabled: true
}

let cache: AppPreferences | null = null

/** 读取偏好(带进程内缓存);文件缺失或坏了都回落默认值。 */
export function loadPrefs(): AppPreferences {
  if (cache) {
    return cache
  }
  const file = prefsFile()
  let stored: Partial<AppPreferences> = {}
  if (existsSync(file)) {
    try {
      stored = JSON.parse(readFileSync(file, 'utf-8')) as Partial<AppPreferences>
    } catch {
      /* 坏了就当没设过:这份数据全是可再选的偏好,没有不可恢复的内容 */
    }
  }
  // 逐字段校验类型:老版本或手改坏的文件不该让开关变成 undefined 再被当成关。
  cache = {
    localSkillsMemoryEnabled:
      typeof stored.localSkillsMemoryEnabled === 'boolean'
        ? stored.localSkillsMemoryEnabled
        : DEFAULTS.localSkillsMemoryEnabled
  }
  return cache
}

/** 改写偏好(按字段合并),返回合并后的完整值。 */
export function savePrefs(patch: Partial<AppPreferences>): AppPreferences {
  const next = { ...loadPrefs(), ...patch }
  cache = next
  writeFileSync(prefsFile(), JSON.stringify(next, null, 2), 'utf-8')
  return next
}
