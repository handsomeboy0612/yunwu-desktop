/**
 * 验证探针:证实回环网关是否允许客户端申领 operator.admin,
 * 以及带 admin 后 sessions.patch 是否不再报 missing scope。
 *
 * 用法:
 *   node scripts/probe-scope.mjs read       # 仅 read/write(复现 missing scope)
 *   node scripts/probe-scope.mjs admin      # read/write/admin(期望不再 missing scope)
 */
import crypto from 'node:crypto'
import WebSocket from 'ws'

const URL = process.env.GATEWAY_URL ?? 'ws://127.0.0.1:18789'
const MODE = process.argv[2] === 'admin' ? 'admin' : 'read'
const SCOPES =
  MODE === 'admin'
    ? ['operator.read', 'operator.write', 'operator.admin']
    : ['operator.read', 'operator.write']
const SESSION_KEY = process.env.SESSION_KEY ?? `agent:main:scope-probe-${Date.now().toString(36)}`
const CLIENT_ID = 'cli'
const CLIENT_MODE = 'cli'
const ROLE = 'operator'
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

const base64Url = (b) =>
  b.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
const normMeta = (v) =>
  typeof v === 'string' && v.trim()
    ? v.trim().replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))
    : ''

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
  return [
    'v3', p.deviceId, CLIENT_ID, CLIENT_MODE, ROLE, SCOPES.join(','),
    String(p.signedAtMs), '', p.nonce, normMeta(p.platform), ''
  ].join('|')
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
    }, 30000)
  })

ws.on('open', () => console.log(`[scope-probe] open; mode=${MODE} scopes=${SCOPES.join(',')}`))
ws.on('close', (c, r) => console.log(`[scope-probe] close code=${c} reason=${r?.toString() || '(none)'}`))
ws.on('error', (e) => console.error('[scope-probe] error', e.message))

ws.on('message', async (data) => {
  const frame = JSON.parse(data.toString())
  if (frame.type === 'event' && frame.event === 'connect.challenge') {
    const nonce = frame.payload?.nonce ?? ''
    const signedAtMs = Date.now()
    const sig = base64Url(
      crypto.sign(
        null,
        Buffer.from(payloadV3({ deviceId: id.deviceId, signedAtMs, nonce, platform }), 'utf8'),
        crypto.createPrivateKey(id.privPem)
      )
    )
    const cid = `req-${++seq}`
    pending.set(cid, {
      resolve: (hello) => runProbe(hello),
      reject: (e) => {
        console.error('[scope-probe] connect FAILED:', JSON.stringify(e))
        ws.close()
      }
    })
    ws.send(
      JSON.stringify({
        type: 'req', id: cid, method: 'connect',
        params: {
          minProtocol: 4, maxProtocol: 4,
          client: { id: CLIENT_ID, version: '0.0.0', platform, mode: CLIENT_MODE },
          role: ROLE, scopes: SCOPES, caps: [],
          device: { id: id.deviceId, publicKey: base64Url(id.raw), signature: sig, signedAt: signedAtMs, nonce }
        }
      })
    )
    return
  }
  if (frame.type === 'res') {
    const p = pending.get(frame.id)
    if (p) {
      pending.delete(frame.id)
      frame.ok ? p.resolve(frame.payload) : p.reject(frame.error)
    }
  }
})

async function runProbe(hello) {
  const granted = hello?.grantedScopes ?? hello?.scopes ?? hello?.session?.scopes ?? '(未在 hello 中回显)'
  console.log('[scope-probe] hello-ok; grantedScopes =', JSON.stringify(granted))
  try {
    await request('sessions.messages.subscribe', { key: SESSION_KEY })
  } catch (e) {
    console.log('[scope-probe] subscribe err:', e?.message ?? JSON.stringify(e))
  }
  // 取一个真实已配置的模型键,验证真实世界的 patch 路径。
  let realModel = process.env.MODEL
  try {
    const ml = await request('models.list')
    const models = Array.isArray(ml?.models) ? ml.models : []
    console.log('[scope-probe] models.list count =', models.length)
    if (!realModel && models.length) {
      const m0 = models[0]
      realModel = m0.key ?? (m0.provider && m0.id ? `${m0.provider}/${m0.id}` : m0.id)
    }
    console.log('[scope-probe] using model =', realModel, '| sample =', JSON.stringify(models[0] ?? null).slice(0, 200))
  } catch (e) {
    console.log('[scope-probe] models.list err:', e?.message ?? JSON.stringify(e))
  }
  try {
    const res = await request('sessions.patch', {
      key: SESSION_KEY,
      ...(realModel ? { model: realModel } : {}),
      thinkingLevel: 'high'
    })
    console.log('[scope-probe] sessions.patch OK ->', JSON.stringify(res))
  } catch (e) {
    console.log('[scope-probe] sessions.patch ERR ->', JSON.stringify(e))
  }
  ws.close()
}
