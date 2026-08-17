import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOpenClaw } from './openclaw-cli'

/**
 * 云雾视频生成插件的安装通道。
 *
 * 形状照 persona-bundle / ui-tools-bundle:`plugins install` 进
 * `~/.openclaw/extensions/yunwu-video`,不要直接塞目录(会被判 untracked local code)。
 *
 * 凭证不进插件配置 —— 运行时读 `models.providers.yunwu`(登录时已写)。
 * 上架开关是 `agents.defaults.videoGenerationModel.primary = yunwu-video/<model>`,
 * 由 config-writer 在启动 / 激活时写;网关靠这条把本插件拉进启动计划
 * (`gateway-startup-plugin-ids.ts` 的 `collectConfiguredGenerationProviderIds`)。
 */

const PLUGIN_ID = 'yunwu-video'
const BUNDLE_FILES = ['index.mjs', 'package.json', 'openclaw.plugin.json']

export function yunwuVideoBundleDir(): string {
  return join(homedir(), '.openclaw', 'extensions', PLUGIN_ID)
}

function pluginSourceDir(): string {
  const packaged = join(process.resourcesPath ?? '', 'yunwu-video-plugin')
  if (existsSync(join(packaged, 'index.mjs'))) {
    return packaged
  }
  return join(app.getAppPath(), 'resources', 'yunwu-video-plugin')
}

function writeIfChanged(path: string, content: string): boolean {
  try {
    if (readFileSync(path, 'utf-8') === content) {
      return false
    }
  } catch {
    /* 没有就写 */
  }
  writeFileSync(path, content, 'utf-8')
  return true
}

function writeBundleFiles(dir: string): boolean {
  const src = pluginSourceDir()
  mkdirSync(dir, { recursive: true })
  let changed = false
  for (const name of BUNDLE_FILES) {
    changed =
      writeIfChanged(join(dir, name), readFileSync(join(src, name), 'utf-8')) || changed
  }
  return changed
}

/**
 * 落地 / 更新视频插件包。入口未变就跳过安装;变了才 `plugins install --force`。
 * 首次安装当次网关未必加载得到,所以要排在启动早期。
 */
export async function syncYunwuVideoBundle(): Promise<void> {
  const installed = yunwuVideoBundleDir()
  const needsInstall = !existsSync(join(installed, 'openclaw.plugin.json'))
  const changed = writeBundleFiles(installed)

  if (!needsInstall && !changed) {
    return
  }

  const stage = join(tmpdir(), 'yunwu-video-install')
  const stageBundle = join(stage, PLUGIN_ID)
  try {
    rmSync(stage, { recursive: true, force: true })
    writeBundleFiles(stageBundle)
    await runOpenClaw(['plugins', 'install', stageBundle, '--force'])
  } catch (err) {
    console.warn(
      '[yunwu-video] 安装视频插件失败,video_generate 可能要到下次启动才生效:',
      err
    )
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}
