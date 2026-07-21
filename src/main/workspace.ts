import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'

/**
 * 受管工作区目录:默认放在用户「文档」下的 YunwuDesktop。
 *
 * 设计意图(对齐 WorkBuddy 的"默认权限"模型):
 *  - 用户无需手动选目录,agent 默认在这个受管沙箱目录里读写文件;
 *  - 需要处理其它位置的文件时,用 @ 引用把文件带进来,或切换到"完全访问权限";
 *  - 目录首次访问时自动创建。
 */
export function getWorkspaceDir(): string {
  const dir = join(app.getPath('documents'), 'YunwuDesktop')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 单个 isolated agent 的受管工作区目录:YunwuDesktop/agents/<agentId>。
 *
 * 每个任务组映射一个 agent,拥有独立子目录,实现任务间文件隔离(对齐 OpenClaw
 * 原生 multi-agent 的 per-agent workspace)。目录首次访问时自动创建;OpenClaw
 * `agents add` 会在此目录内初始化 AGENTS.md 等 workspace 模板。
 */
export function getAgentWorkspaceDir(agentId: string): string {
  const dir = join(app.getPath('documents'), 'YunwuDesktop', 'agents', agentId)
  mkdirSync(dir, { recursive: true })
  return dir
}
