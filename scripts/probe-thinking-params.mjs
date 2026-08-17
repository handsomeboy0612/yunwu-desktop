/**
 * 实测每个对话模型的思考能力,产出可直接灌进「桌面端模型能力覆盖层」的 JSON。
 *
 * **为什么必须实测**:思考能力没有权威静态来源。平台 tags 的「思考」既有漏标(Claude 30 条里
 * 18 条没标)也有错标(`qwq-32b` 标了却一个思考字都不回);而思考参数的方言又是逐模型不同的
 * —— 2026-08-16 实测同一族里 `qwen3.5-plus` 的思考能用 `enable_thinking:false` 关掉、
 * `qwen3-vl-32b-thinking` 关不掉,`deepseek-v4-pro` 只认 `reasoning_effort` 而不认
 * `thinking:{type}`(与 new-yunwu-api `dto/openai_request.go:92` 那句 `// doubao,zhipu_v4`
 * 注释暗示的方向相反)。所以这层数据只能跑出来,不能按族推。
 *
 * 每个模型最多打 6 发流式 `/chat/completions`,判据是流里有没有
 * `reasoning_content` / `reasoning` / `reasoning_text`:
 *
 *   base      什么都不传        —— 默认思不思考
 *   effort    reasoning_effort  —— OpenAI 方言(我们今天对所有模型的行为)
 *   qwen_off  enable_thinking:false      —— 阿里方言,关
 *   ds_off    thinking:{type:disabled}   —— doubao / zhipu_v4 方言,关
 *   qwen_on / ds_on                      —— 仅当上面都没思考时才补打,找出怎么开
 *
 * **必须流式**:非流式在这个中转上等于挂着(推理模型首块回的是 `reasoning_content`,
 * 实测同 key 同模型 `stream:true` 2.1 秒回首字节、不传 stream 则两次 90/120 秒零响应)。
 * 见到第一块思考内容就主动收流 —— 问的是「思考有没有被触发」,不是「答得对不对」,
 * 等它想完既慢又白烧 token。
 *
 * 用法(key 只从环境变量读,不写进仓库):
 *   $env:YUNWU_KEY="sk-..."; node scripts/probe-thinking-params.mjs
 *   node scripts/probe-thinking-params.mjs --all                # 连已覆盖的族一起复验
 *   node scripts/probe-thinking-params.mjs --models qwen3.5-plus,glm-4.7
 *   node scripts/probe-thinking-params.mjs --snapshot ../.tmp-probe/v1models.json
 *
 * 环境变量:YUNWU_KEY(必填)、YUNWU_BASE_URL(默认 https://api.openlux.ai/v1)。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveModelInfos } from '../src/main/model-capabilities.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const KEY = process.env.YUNWU_KEY?.trim()
const BASE_URL = (process.env.YUNWU_BASE_URL ?? 'https://api.openlux.ai/v1').replace(/\/+$/, '')

if (!KEY) {
  console.error('缺 YUNWU_KEY:请用真实用户令牌跑,例 $env:YUNWU_KEY="sk-..."')
  process.exit(1)
}

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const CONCURRENCY = Number(opt('concurrency', '3'))
const OUT = opt('out', path.join(HERE, '..', '..', '.tmp-probe', 'thinking-params.json'))
const SNAPSHOT = opt('snapshot', '')
const ONLY = opt('models', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/**
 * 提问要能稳定触发思考又足够短。这条实测在 7 个族上都触发了思考,
 * 而正文只有 3~4 个字符(答案是一个数字),所以早收流几乎不浪费。
 */
const PROMPT = '9.11 和 9.9 哪个大?先想清楚再答,答案只要一个数字。'
const MAX_TOKENS = 256
/** 一个字都没回时的上限。见到思考就提前收,正常路径 2~7 秒。 */
const HARD_TIMEOUT_MS = 60_000
const RETRY_BACKOFF_MS = [2_000, 5_000, 12_000]

const SHAPES = {
  base: {},
  effort: { reasoning_effort: 'high' },
  qwen_off: { enable_thinking: false },
  ds_off: { thinking: { type: 'disabled' } },
  qwen_on: { enable_thinking: true },
  ds_on: { thinking: { type: 'enabled' } }
}

async function loadCatalog() {
  if (SNAPSHOT) {
    const raw = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'))
    return Array.isArray(raw) ? raw : (raw.data ?? [])
  }
  const res = await fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${KEY}` } })
  if (!res.ok) {
    throw new Error(`拉 /v1/models 失败:HTTP ${res.status}`)
  }
  const json = await res.json()
  return json.data ?? []
}

/** 打一发,返回 { think, content, err }。见到思考立刻收流。 */
async function callOnce(model, extra) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), HARD_TIMEOUT_MS)
  let think = 0
  let content = 0
  let err = ''
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: PROMPT }],
        ...extra
      }),
      signal: ctrl.signal
    })
    if (!res.ok) {
      const body = await res.text()
      err = `HTTP ${res.status} ${body.slice(0, 160).replace(/\s+/g, ' ')}`
    } else {
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      outer: for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          let evt
          try {
            evt = JSON.parse(payload)
          } catch {
            continue
          }
          // 上游把错误塞在 200 的流里也是常见形状,别当成"没思考"。
          if (evt.error?.message && !err) {
            err = `stream ${String(evt.error.message).slice(0, 160).replace(/\s+/g, ' ')}`
          }
          const delta = evt.choices?.[0]?.delta ?? {}
          for (const field of ['reasoning_content', 'reasoning', 'reasoning_text']) {
            if (typeof delta[field] === 'string') think += delta[field].length
          }
          if (typeof delta.content === 'string') content += delta.content.length
        }
        if (think > 0) {
          await reader.cancel()
          break outer
        }
      }
    }
  } catch (e) {
    err = e.name === 'AbortError' ? `${HARD_TIMEOUT_MS / 1000}s 内无响应` : String(e.message ?? e).slice(0, 160)
  }
  clearTimeout(timer)
  return { think, content, err }
}

/** 429 / 5xx / 无响应都重试:渠道饱和是中转站的事,不该被记成"这个模型不会思考"。 */
async function call(model, shape) {
  let last = { think: 0, content: 0, err: '未执行' }
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    last = await callOnce(model, SHAPES[shape])
    const retryable = last.err && /HTTP (429|5\d\d)|无响应|fetch failed|ECONN|socket/i.test(last.err)
    if (!last.err || !retryable) return last
    if (attempt < RETRY_BACKOFF_MS.length) {
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt]))
    }
  }
  return last
}

/**
 * 从四到六发的结果推出覆盖层字段。
 *
 * 两处刻意保守:
 * - `thinkingEffort` 只在**能证明 effort 是开关**时才给 true(base 不思考、传了 effort 才思考)。
 *   base 本来就思考的情况下,这条探针证明不了"档位被采纳",给 true 就是在界面上放一排
 *   点了没反应的档位 —— 假档位比没档位更糟。要给档位得另设计判据(比如比对 reasoning_tokens)。
 * - 关不掉就如实写 `canDisableThinking:false`,不猜"也许换个参数能关"。
 */
function verdict(model, r) {
  const think = (k) => (r[k] ? r[k].think > 0 : false)
  const failed = (k) => Boolean(r[k]?.err)
  // 上游把「这个参数只能是 True」当 400 报回来,那是**结论**不是故障:它比任何推断都硬。
  const lockedOn = (k) => /restricted to True|only.*true/i.test(r[k]?.err ?? '')
  // 传了 effort 就 400 的模型,今天我们照样给它写 supportsReasoningEffort:true —— 用户一开
  // 思考整条消息就失败。单独记出来,填 profile 时必须置 false。
  const effortRejected = /reasoning_effort.*not supported|not support.*reasoning_effort/i.test(
    r.effort?.err ?? ''
  )
  const reasoning = think('base') || think('effort') || think('qwen_on') || think('ds_on')

  // 一次思考都没见到,而"该看到思考"的那几发全是错的 → 无结论。
  // 这条不能省:把打不通记成「这个模型不会思考」再下发给所有用户,比不下发糟得多。
  const onPathsFailed = ['base', 'effort', 'qwen_on', 'ds_on'].filter((k) => r[k]).every(failed)
  if (!reasoning && onPathsFailed) {
    return {
      model_name: model,
      status: 'unknown',
      evidence: { probed_at: new Date().toISOString(), base_url: BASE_URL, shapes: shapesOf(r) },
      unresolved: errsOf(r)
    }
  }

  let format = ''
  if (think('base') && (lockedOn('qwen_off') || (!failed('qwen_off') && !think('qwen_off')))) {
    format = 'qwen'
  } else if (think('base') && !failed('ds_off') && !think('ds_off')) format = 'deepseek'
  else if (!think('base') && think('qwen_on')) format = 'qwen'
  else if (!think('base') && think('ds_on')) format = 'deepseek'
  else if (!think('base') && think('effort')) format = 'openai'

  const canDisable = reasoning
    ? !think('base') ||
      (!lockedOn('qwen_off') && !failed('qwen_off') && !think('qwen_off')) ||
      (!failed('ds_off') && !think('ds_off'))
    : true
  const effortIsSwitch = !think('base') && think('effort')

  // 只留下"仍未解释"的错误:被当成结论用掉的那条(restricted to True)不算悬案。
  const errs = errsOf(r).filter((e) => !/restricted to True/i.test(e))

  return {
    model_name: model,
    reasoning,
    ...(reasoning
      ? { can_disable_thinking: canDisable, thinking_effort: effortRejected ? false : effortIsSwitch }
      : {}),
    ...(format ? { thinking_format: format } : {}),
    evidence: {
      probed_at: new Date().toISOString(),
      base_url: BASE_URL,
      shapes: shapesOf(r),
      // 探针只证明了开关,没证明档位;填 profile 的人要知道这一点。
      effort_levels_unverified: reasoning,
      ...(effortRejected ? { effort_rejected_by_upstream: true } : {})
    },
    ...(errs.length ? { unresolved: errs } : {})
  }
}

function shapesOf(r) {
  return Object.fromEntries(
    Object.entries(r).map(([k, v]) => [
      k,
      v.err ? { error: v.err } : { think: v.think, content: v.content }
    ])
  )
}

function errsOf(r) {
  return Object.entries(r)
    .filter(([, v]) => v.err)
    .map(([k, v]) => `${k}: ${v.err}`)
}

async function probeModel(model) {
  const r = {}
  r.base = await call(model, 'base')
  r.effort = await call(model, 'effort')
  r.qwen_off = await call(model, 'qwen_off')
  r.ds_off = await call(model, 'ds_off')
  if (r.base.think === 0 && r.effort.think === 0) {
    r.qwen_on = await call(model, 'qwen_on')
    r.ds_on = await call(model, 'ds_on')
  }
  return verdict(model, r)
}

async function runPool(items, worker) {
  const out = []
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, Math.min(CONCURRENCY, items.length)) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await worker(items[i], i)
    }
  })
  await Promise.all(runners)
  return out
}

const raw = await loadCatalog()
const chat = deriveModelInfos(raw).filter((m) => m.category === 'chat')
const gaps = chat.filter(
  (m) => m.reasoning && !(m.thinkingLevels?.length || m.thinkingEffort === false)
)
const targets = ONLY.length
  ? ONLY
  : (flag('all') ? chat.filter((m) => m.reasoning) : gaps).map((m) => m.id)

console.log(
  `底表 ${raw.length} 条 → 对话 ${chat.length}｜判为会思考 ${chat.filter((m) => m.reasoning).length}｜` +
    `档位不明的缺口 ${gaps.length}｜本轮实测 ${targets.length} 条,并发 ${CONCURRENCY}`
)

let done = 0
const results = await runPool(targets, async (model) => {
  const v = await probeModel(model)
  done++
  const desc =
    v.status === 'unknown'
      ? '无结论(打不通)'
      : !v.reasoning
        ? '不思考'
        : `会思考｜${v.can_disable_thinking ? '可关' : '关不掉'}｜${v.thinking_effort ? 'effort 是开关' : '档位不可控'}${v.thinking_format ? '｜方言=' + v.thinking_format : ''}${v.evidence?.effort_rejected_by_upstream ? '｜⚠ effort 被上游 400 顶回' : ''}`
  console.log(`[${String(done).padStart(3)}/${targets.length}] ${model.padEnd(38)} ${desc}${v.unresolved ? '  ⚠ ' + v.unresolved[0] : ''}`)
  return v
})

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf-8')

const unresolved = results.filter((r) => r.unresolved || r.status === 'unknown')
console.log(`\n落盘 ${OUT}`)
console.log(
  `会思考 ${results.filter((r) => r.reasoning).length}｜其中可关 ${results.filter((r) => r.can_disable_thinking).length}｜` +
    `effort 能当开关 ${results.filter((r) => r.thinking_effort).length}｜` +
    `判为不思考 ${results.filter((r) => r.status !== 'unknown' && !r.reasoning).length}｜` +
    `无结论 ${results.filter((r) => r.status === 'unknown').length}`
)
const rejected = results.filter((r) => r.evidence?.effort_rejected_by_upstream)
if (rejected.length) {
  console.log(
    `\n⚠ ${rejected.length} 条模型的上游明确拒收 reasoning_effort(400),而我们今天照样给它们写\n` +
      `  compat.supportsReasoningEffort:true —— 用户一开思考整条消息就失败:\n  ` +
      rejected.map((r) => r.model_name).join(', ')
  )
}
if (unresolved.length) {
  console.log(
    `\n有 ${unresolved.length} 条带错误(多半是渠道饱和,属中转站侧),重跑这些即可:\n  --models ` +
      unresolved.map((r) => r.model_name).join(',')
  )
}
