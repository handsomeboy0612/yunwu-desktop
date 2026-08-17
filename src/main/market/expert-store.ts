import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { InstalledExpert } from '@shared/types'

/**
 * 本地已安装专家注册表(单一数据源)。
 *
 * 设计:专家的 persona 正文以技能形式装在 `~/.openclaw/skills/<personaSkillSlug>`,
 * 而"哪些专家已安装 + 其清单(职业/模型/工具/头像/快捷提示)"这类内核不感知的
 * 展示与播种元数据,集中登记到用户数据目录下的 experts.json。Composer 专家选择器、
 * 「我的专家」列表、以及会话播种(按 slug 取清单套用到任务 agent)都读它。
 */

/** 专家注册表持久化到用户数据目录下的 experts.json。 */
function expertsFile(): string {
  return join(app.getPath('userData'), 'experts.json')
}

/** 读取已安装专家列表;不存在或解析失败返回空数组。 */
export function loadExperts(): InstalledExpert[] {
  const file = expertsFile()
  if (!existsSync(file)) {
    return []
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    return Array.isArray(parsed) ? (parsed as InstalledExpert[]) : []
  } catch {
    return []
  }
}

/** 覆盖写入专家列表。 */
function saveExperts(list: InstalledExpert[]): void {
  writeFileSync(expertsFile(), JSON.stringify(list, null, 2), 'utf-8')
}

/** 按 slug 取单个已安装专家。 */
export function getExpert(slug: string): InstalledExpert | undefined {
  return loadExperts().find((e) => e.slug === slug)
}

/** upsert 一个专家(按 slug 覆盖同名条目)。 */
export function upsertExpert(expert: InstalledExpert): void {
  const list = loadExperts().filter((e) => e.slug !== expert.slug)
  list.push(expert)
  saveExperts(list)
}

/** 移除一个专家登记(幂等)。 */
export function removeExpert(slug: string): void {
  saveExperts(loadExperts().filter((e) => e.slug !== slug))
}
