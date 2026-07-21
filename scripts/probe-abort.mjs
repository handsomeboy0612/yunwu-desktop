/**
 * Abort discovery probe: start a chat turn, then after a short delay call
 * chat.abort, and dump frames so we confirm the exact abort method/params and
 * whether a `lifecycle aborted:true` event is emitted.
 *
 * Run: node scripts/probe-abort.mjs
 */
import crypto from 'node:crypto'
import WebSocket from 'ws'

const URL = process.env.GATEWAY_URL ?? 'ws://127.0.0.1:18789'
const SESSION_KEY = process.env.SESSION_KEY ?? `agent:main:abort-${Date.now().toString(36)}`
const TEXT = process.env.TEXT ?? '请写一篇 800 字关于春天的散文,慢慢写,分多段。'
const CLIENT_ID = 'cli'
const CLIENT_MODE = 'cli'
const ROLE = 'operator'
const SCOPES = ['operator.read', 'operator.write']
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

const base64Url = (b) => b.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
const normMeta = (v) =>
  typeof v === 'string' && v.trim() ? v.trim().replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)) : ''
const trunc = (s, n = 500) => (s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s)

function rawPub(pem) {
  const spki = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' })
  return spki.length === ED25519_SPKI_PREFIX.length + 32 ? spki.subarray(ED25519_SPKI_PREFIX.length) : spki
}
function makeIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' })
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const raw = rawPub(pubPem)
  return { deviceId: crypto.createHash('sha256').update(raw).digest('hex'), privPem, raw }
}
function payloadV3(p) {
  return ['v3', p.deviceId, CLIENT_ID, CLIENT_MODE, ROLE, SCOPES.join(','), String(p.signedAtMs), '', p.nonce, normMeta(p.platform), ''].join('|')
}

const id = makeIdentity()
const ws = new WebSocket(URL)
let seq = 0
const pending = new Map()
const platform = process.platform

const request = (method, params) =>
  new Promise((resolve, reject) => {
    const rid = `req-${++seq}`
    pending.set(rid, { resolve, reject })
    ws.send(JSON.stringify({ type: 'req', id: rid, method, params: params ?? {} }))
    setTimeout(() => {
      if (pending.has(rid)) {
        pending.delete(rid)
        reject(new Error(`timeout ${method}`))
      }
    }, 90000)
  })

ws.on('open', () => console.log('[abort-probe] open; session =', SESSION_KEY))
ws.on('close', (c, r) => console.log(`[abort-probe] close code=${c} reason=${r?.toString() || '(none)'}`))
ws.on('error', (e) => console.error('[abort-probe] error', e.message))

ws.on('message', async (data) => {
  const frame = JSON.parse(data.toString())

  if (frame.type === 'event' && frame.event === 'connect.challenge') {
    const nonce = frame.payload?.nonce ?? ''
    const signedAtMs = Date.now()
    const sig = base64Url(
      crypto.sign(null, Buffer.from(payloadV3({ deviceId: id.deviceId, signedAtMs, nonce, platform }), 'utf8'), crypto.createPrivateKey(id.privPem))
    )
    const cid = `req-${++seq}`
    pending.set(cid, { resolve: () => run(), reject: (e) => { console.error('connect failed', e); ws.close() } })
    ws.send(JSON.stringify({
      type: 'req', id: cid, method: 'connect',
      params: {
        minProtocol: 4, maxProtocol: 4,
        client: { id: CLIENT_ID, version: '0.0.0', platform, mode: CLIENT_MODE },
        role: ROLE, scopes: SCOPES, caps: [],
        device: { id: id.deviceId, publicKey: base64Url(id.raw), signature: sig, signedAt: signedAtMs, nonce }
      }
    }))
    return
  }

  if (frame.type === 'res') {
    const p = pending.get(frame.id)
    if (p) {
      pending.delete(frame.id)
      frame.ok ? p.resolve(frame.payload) : p.reject(frame.error)
    } else {
      console.log(`[res id=${frame.id} ok=${frame.ok}] ${trunc(JSON.stringify(frame.payload ?? frame.error))}`)
    }
    return
  }

  if (frame.type === 'event') {
    if (frame.event === 'health' || frame.event === 'tick' || frame.event === 'heartbeat') {
      return
    }
    const t = new Date().toISOString().slice(11, 23)
    console.log(`[${t}] [event ${frame.event}${frame.seq != null ? ` seq=${frame.seq}` : ''}] ${trunc(JSON.stringify(frame.payload ?? {}))}`)
  }
})

async function run() {
  console.log('[abort-probe] hello-ok; subscribing + sending...')
  try {
    await request('sessions.messages.subscribe', { key: SESSION_KEY })
  } catch (e) {
    console.error('[abort-probe] subscribe failed:', e?.message ?? JSON.stringify(e))
  }
  request('chat.send', { sessionKey: SESSION_KEY, message: TEXT, idempotencyKey: crypto.randomUUID() })
    .then((res) => console.log('[abort-probe] chat.send RESULT:', trunc(JSON.stringify(res), 800)))
    .catch((e) => console.error('[abort-probe] chat.send failed:', e?.message ?? JSON.stringify(e)))

  // After 4s, attempt abort with candidate param shapes to learn the accepted one.
  setTimeout(async () => {
    console.log('[abort-probe] >>> calling chat.abort { sessionKey }')
    try {
      const r = await request('chat.abort', { sessionKey: SESSION_KEY })
      console.log('[abort-probe] chat.abort OK:', trunc(JSON.stringify(r)))
    } catch (e) {
      console.error('[abort-probe] chat.abort FAILED:', trunc(JSON.stringify(e)))
    }
  }, 4000)

  setTimeout(() => { console.log('[abort-probe] window ended, closing.'); ws.close() }, 20000)
}
