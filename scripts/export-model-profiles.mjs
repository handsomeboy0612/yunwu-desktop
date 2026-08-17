/**
 * 导出「模型参数档案」种子：客户端家族表的判断 + 真机实测结论，合成一份可直接灌进
 * admin-server 的 JSON。
 *
 * 为什么要导这一份：后台那张表第一天必须与客户端**当前行为一致**，否则运营一开总开关，
 * 用户看到的档位就会莫名其妙地变。有了这份种子，开开关是零变化的动作，之后运营改哪条
 * 才变哪条 —— 灰度才有意义。
 *
 * 数据来源两处，**家族表优先，实测只补它没表态的**：
 *   1. `src/main/model-capabilities.ts` 的家族表（直接 import 真实实现，不复制判据）；
 *   2. 真机实测产物（`scripts/probe-thinking-params.mjs` 的输出）。
 *
 * 顺序为什么是这个：实测是原始观测，家族表是**已经吸收了实测、并在之后又更正过**的结论。
 * 反过来会把更正覆盖回去 —— 真踩到过：实测给 `deepseek-v4-flash` 记的方言是 `openai`
 * （当时只知道它认 reasoning_effort），后来发现内核对 DeepSeek V4 自带一层思考包装，
 * 写 `openai` 恰好会把那层关掉，于是家族表改成了 `deepseek`。让实测压家族表，
 * 导出的种子就把这条修复带回了坑里。实测的作用是补空白：家族表没有的那些模型、
 * 以及「平台标了思考却零思考输出」这类只有打过才知道的否定结论。
 *
 * 用法：
 *   node scripts/export-model-profiles.mjs [--models <v1models.json>]
 *        [--measured <thinking-params.json>]... [--out <seed.json>]
 *
 * `--models` 缺省用 `../.tmp-probe/v1models.json`（真机 /v1/models 快照）；没有快照时只导实测那部分。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveModelInfos } from '../src/main/model-capabilities.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')

function parseArgs(argv) {
  const out = { models: resolve(repoRoot, '.tmp-probe/v1models.json'), measured: [], out: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--models') out.models = argv[++i]
    else if (a === '--measured') out.measured.push(argv[++i])
    else if (a === '--out') out.out = argv[++i]
  }
  if (out.measured.length === 0) {
    for (const p of ['.tmp-probe/thinking-params.json', '.tmp-probe/thinking-params-extra.json']) {
      const abs = resolve(repoRoot, p)
      if (existsSync(abs)) out.measured.push(abs)
    }
  }
  if (!out.out) {
    out.out = resolve(repoRoot, 'admin-server/service/desktop_market/model_profiles_seed.json')
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

/** /v1/models 快照 → 原始条目数组。两种形状都接：{data:[...]} 或裸数组。 */
function readModelEntries(path) {
  if (!existsSync(path)) {
    console.log(`（没有 ${path}，跳过家族表导出）`)
    return []
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw.data) ? raw.data : []
  return arr
}

/** 家族表有没有对这条模型「明确表态」——只有表态过的才值得进种子。 */
function hasExplicitOpinion(info) {
  return (
    info.thinkingLevels !== undefined ||
    info.defaultThinkingLevel !== undefined ||
    info.canDisableThinking !== undefined ||
    info.thinkingEffort !== undefined ||
    info.thinkingFormat !== undefined
  )
}

const rows = new Map()

function put(row) {
  const key = `${row.provider_scope}/${row.model_name}`
  rows.set(key, { ...(rows.get(key) ?? {}), ...row })
}

// 1) 家族表
const entries = readModelEntries(args.models)
const derived = deriveModelInfos(entries).filter((m) => m.category === 'chat')
let derivedCount = 0
for (const info of derived) {
  if (!hasExplicitOpinion(info)) continue
  derivedCount++
  put({
    model_name: info.id,
    provider_scope: 'yunwu',
    category: 'chat',
    reasoning: info.reasoning,
    ...(info.thinkingLevels ? { thinking_levels: info.thinkingLevels } : {}),
    ...(info.defaultThinkingLevel ? { default_thinking_level: info.defaultThinkingLevel } : {}),
    ...(info.canDisableThinking === false ? { can_disable_thinking: false } : {}),
    ...(info.thinkingEffort === false ? { thinking_effort: false } : {}),
    ...(info.thinkingFormat ? { thinking_format: info.thinkingFormat } : {}),
    note: '客户端家族表导出'
  })
}

// 2) 真机实测：只补家族表没有的行，已有的行一个字段都不改
let measuredNew = 0
for (const path of args.measured) {
  if (!existsSync(path)) continue
  const arr = JSON.parse(readFileSync(path, 'utf8'))
  for (const m of Array.isArray(arr) ? arr : []) {
    // status:'unknown' = 那一轮全部调用都没打通（429/无权限），**不是**「不思考」。
    // 把它写进种子等于拿中转站的临时故障给模型定性，probe 脚本刻意留了这个状态。
    if (m.status === 'unknown' || typeof m.model_name !== 'string') continue
    if (typeof m.reasoning !== 'boolean') continue
    const key = `yunwu/${m.model_name}`
    if (rows.has(key)) continue
    const probedAt = (m.evidence?.probed_at ?? '').slice(0, 10)
    const row = {
      model_name: m.model_name,
      provider_scope: 'yunwu',
      category: 'chat',
      reasoning: m.reasoning,
      note: `真机实测 ${probedAt || '(无日期)'}`
    }
    if (m.reasoning) {
      if (typeof m.can_disable_thinking === 'boolean') row.can_disable_thinking = m.can_disable_thinking
      if (typeof m.thinking_effort === 'boolean') row.thinking_effort = m.thinking_effort
      if (typeof m.thinking_format === 'string') row.thinking_format = m.thinking_format
    }
    put(row)
    measuredNew++
  }
}

const list = [...rows.values()].sort((a, b) => a.model_name.localeCompare(b.model_name))
writeFileSync(args.out, JSON.stringify(list, null, 2) + '\n', 'utf8')

console.log(`家族表命中 ${derivedCount} 条，实测补充 ${measuredNew} 条，合计写出 ${list.length} 条`)
console.log(`→ ${args.out}`)
const withLevels = list.filter((r) => r.thinking_levels).length
const noEffort = list.filter((r) => r.thinking_effort === false).length
const locked = list.filter((r) => r.can_disable_thinking === false).length
const dialects = new Set(list.map((r) => r.thinking_format).filter(Boolean))
console.log(
  `其中 有档位 ${withLevels} / 不吃档位 ${noEffort} / 关不掉 ${locked} / 方言 ${[...dialects].join(',') || '(无)'}`
)
