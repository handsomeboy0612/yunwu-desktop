/**
 * Ask the running desktop client to draw with a model the user named, and watch
 * it through to the file.
 *
 * Same judgement as the video probe and for the same reason: the reply text is
 * not evidence. The defect this exists for is the agent quietly dropping `model`
 * and drawing with the delivered default, which looks like success on screen —
 * so what counts is a new file in the artifact directory, plus the model name
 * the result itself reports.
 *
 * Run: node scripts/probe-image-model.mjs --text "用 X 画…" [--port 9333] [--wait 300]
 */

import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}

const PORT = argOf('port', '9333')
const TEXT = argOf('text', '用 gemini-3-pro-image 画一张竖构图的插画：雪夜里的小木屋，窗里透出暖光')
const WAIT_S = Number(argOf('wait', '300'))
const IMAGE_DIR = join(homedir(), '.dsh', 'media', 'image')
const KINDS = ['.png', '.jpg', '.jpeg', '.webp', '.gif']

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Every picture in the artifact directory, by name, with size. */
function snapshot() {
  const seen = new Map()
  try {
    for (const name of readdirSync(IMAGE_DIR)) {
      if (!KINDS.some(kind => name.toLowerCase().endsWith(kind))) continue
      seen.set(name, statSync(join(IMAGE_DIR, name)).size)
    }
  } catch {
    // The directory appears with the first picture; absence is a valid start.
  }
  return seen
}

async function targetUrl() {
  const reply = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  const targets = await reply.json()
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
  if (page === undefined) throw new Error('no page target; is the client running with --remote-debugging-port?')
  return page.webSocketDebuggerUrl
}

function connect(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let seq = 0
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => { resolve() })
    socket.addEventListener('error', e => { reject(new Error(`cdp socket error: ${String(e.message ?? e.type)}`)) })
  })
  socket.addEventListener('message', event => {
    const frame = JSON.parse(event.data)
    const slot = pending.get(frame.id)
    if (slot === undefined) return
    pending.delete(frame.id)
    if (frame.error) slot.reject(new Error(`${frame.error.message} (${JSON.stringify(frame.error.data ?? null)})`))
    else slot.resolve(frame.result)
  })
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params: params ?? {} }))
    setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      reject(new Error(`timeout ${method}`))
    }, 60_000)
  })
  return { ready, send, close: () => { socket.close() } }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) {
    throw new Error(`page threw: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`)
  }
  return result.result.value
}

async function pressEnter(cdp) {
  for (const type of ['rawKeyDown', 'char', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      ...type === 'char' ? { text: '\r' } : {},
    })
  }
}

const tailOf = async (cdp, lines) =>
  await evaluate(cdp, `document.body.innerText.split('\\n').filter(l => l.trim()).slice(-${String(lines)}).join('\\n')`)

const main = async () => {
  const before = snapshot()
  console.log(`[probe] ${before.size} picture(s) already in ${IMAGE_DIR}`)

  const cdp = connect(await targetUrl())
  await cdp.ready
  await cdp.send('Runtime.enable')

  const focused = await evaluate(cdp, `(() => {
    const nodes = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter(n => n.offsetParent !== null)
    if (nodes.length === 0) return { ok: false, why: 'no visible editable' }
    const box = nodes[nodes.length - 1]
    box.focus()
    return { ok: true, tag: box.tagName }
  })()`)
  if (focused.ok !== true) throw new Error(`could not focus the composer: ${focused.why}`)

  await cdp.send('Input.insertText', { text: TEXT })
  await sleep(300)
  await pressEnter(cdp)
  console.log(`[probe] sent: ${TEXT}`)

  const startedAt = Date.now()
  while ((Date.now() - startedAt) / 1000 < WAIT_S) {
    await sleep(4000)
    const seconds = Math.round((Date.now() - startedAt) / 1000)

    const now = snapshot()
    const fresh = [...now].filter(([name, size]) => before.get(name) !== size)
    if (fresh.length > 0) {
      for (const [name, size] of fresh) {
        console.log(`[probe] ${seconds}s: FILE ${name} — ${(size / 1024).toFixed(1)} KB`)
      }
      // The text is read after the file so the result line is already rendered:
      // it carries the model that was actually used and any "could not honour"
      // notes, which is the half a file cannot prove.
      await sleep(2000)
      console.log('\n===== last 30 visible lines =====')
      console.log(await tailOf(cdp, 30))
      cdp.close()
      return
    }

    // A refusal is a result too, and it produces no file — so the loop watches
    // for one instead of running out the clock on a deliberate rejection.
    const text = await evaluate(cdp, 'document.body.innerText')
    if (/这个账号的出图接口上没有/.test(text)) {
      console.log(`[probe] ${seconds}s: refused by name (no file, as intended)`)
      console.log('\n===== last 30 visible lines =====')
      console.log(await tailOf(cdp, 30))
      cdp.close()
      return
    }
    if (seconds % 20 === 0) console.log(`[probe] ${seconds}s: waiting…`)
  }

  console.log(`\n[probe] no new picture within ${String(WAIT_S)}s. Last 30 visible lines:`)
  console.log(await tailOf(cdp, 30))
  cdp.close()
}

await main()
