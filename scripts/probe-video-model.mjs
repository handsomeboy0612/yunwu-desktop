/**
 * Ask the running desktop client to film with a model the user named, and watch
 * it through to the file.
 *
 * Two things are being judged, and neither is the reply text. First, whether the
 * name survived into the tool call — the defect this exists for is the agent
 * quietly dropping `model` and filming with the delivered default, which reads
 * as success on screen. Second, whether the vendor adapter behind that name
 * actually produces an mp4, which only shows up minutes later as a file, so the
 * probe watches the artifact directory rather than the conversation.
 *
 * Run: node scripts/probe-video-model.mjs --text "用 X 拍一段…" [--port 9333] [--wait 480]
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
const TEXT = argOf('text', '用 MiniMax-Hailuo-02 拍一段 6 秒的视频：一只橘猫在雨后的青石板路上慢走')
const WAIT_S = Number(argOf('wait', '480'))
const VIDEO_DIR = join(homedir(), '.dsh', 'media', 'video')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Every mp4 in the artifact directory, by name, with size and mtime. */
function snapshot() {
  const seen = new Map()
  try {
    for (const name of readdirSync(VIDEO_DIR)) {
      if (!name.endsWith('.mp4')) continue
      const info = statSync(join(VIDEO_DIR, name))
      seen.set(name, { size: info.size, at: info.mtimeMs })
    }
  } catch {
    // The directory appears with the first clip; absence is a valid start state.
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

const main = async () => {
  const before = snapshot()
  console.log(`[probe] ${before.size} clip(s) already in ${VIDEO_DIR}`)

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
  let announced = false
  while ((Date.now() - startedAt) / 1000 < WAIT_S) {
    await sleep(5000)
    const seconds = Math.round((Date.now() - startedAt) / 1000)

    if (!announced) {
      const tail = await evaluate(cdp, 'document.body.innerText')
      const job = /视频任务已在后台开始（([^）]*)）/.exec(tail)
      if (job !== null) {
        console.log(`[probe] ${seconds}s: tool call accepted → ${job[1]}`)
        announced = true
      } else if (seconds % 20 === 0) {
        console.log(`[probe] ${seconds}s: waiting for the tool call…`)
      }
    }

    const now = snapshot()
    for (const [name, info] of now) {
      const was = before.get(name)
      if (was !== undefined && was.size === info.size) continue
      console.log(`[probe] ${seconds}s: FILE ${name} — ${(info.size / 1024 / 1024).toFixed(2)} MB`)
      const tail = await evaluate(cdp, `document.body.innerText.split('\\n').filter(l => l.trim()).slice(-25).join('\\n')`)
      console.log('\n===== last 25 visible lines =====')
      console.log(tail)
      cdp.close()
      return
    }
  }

  const tail = await evaluate(cdp, `document.body.innerText.split('\\n').filter(l => l.trim()).slice(-30).join('\\n')`)
  console.log(`\n[probe] no new clip within ${String(WAIT_S)}s. Last 30 visible lines:`)
  console.log(tail)
  cdp.close()
}

await main()
