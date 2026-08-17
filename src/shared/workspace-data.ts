/**
 * 工作空间里我方数据目录的约定。
 *
 * 对位 WorkBuddy 的 `.workbuddy`:它在工作目录下放项目级记忆(`memory/`)与项目级技能
 * (`skills/`),目录名由 `WORKBUDDY_DATA_FOLDER_NAME` 覆盖、兜底 `.workbuddy`
 * (2026-08-12 解包 asar 读到的 `packages/workbuddy-server/src/mode/collectors/
 * memory-collector.ts:resolveProjectFolderName`)。它的提示词里还专门有一句
 * *"<数据目录>" folder stores project-related data and is NOT a temporary cache*。
 *
 * 人设插件里有一份同名的默认值(它是独立发的资源文件,import 不到这里),改这里要一起改。
 */
export const WORKSPACE_DATA_FOLDER = '.yunwu-desktop'

/**
 * 这个路径是不是落在工作空间的数据目录里(记忆日志、项目级技能)。
 *
 * 用来把它们挡在**产出物卡片**之外:模型每完成一段实质工作都会往当天日志追加一条,
 * 而 write/edit 一律会聚成产出物,不挡就等于每干一件事多弹一张假交付物卡,
 * 把用户真正要的东西淹掉。步骤行照常显示——那是如实反映它做了什么,不是交付物。
 *
 * 与 WorkBuddy 同口径:它把记忆明确划在交付物之外(提示词原文 *Workspace memory is
 * supplemental only. It does NOT replace ... any user-requested deliverable*),
 * 交付物走的是 `present_files`。
 */
export function isWorkspaceDataPath(path: string): boolean {
  if (!path) {
    return false
  }
  return path
    .replace(/\\/g, '/')
    .split('/')
    .includes(WORKSPACE_DATA_FOLDER)
}
