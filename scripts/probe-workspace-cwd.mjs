/**
 * 验证探针:证实网关接受**受管根目录以外**的绝对路径作为会话 `spawnedCwd`。
 *
 * 这是「选择工作空间」整条链路的地基假设 —— 用户挑的是自己的项目文件夹
 * (如 D:\work\my-project),不在 Documents\YunwuDesktop 之下。内核对
 * `spawnedCwd` 有两道已知约束(见 openclaw src/gateway/sessions-patch.ts):
 *   1. 只对 `subagent:*` / `acp:*` 前缀的会话键放行;
 *   2. 一旦设定不可更改(`cannot be changed once set`),同值重复写则放行。
 * 路径是否必须落在某个根之内,代码里看不到限制 —— 本探针就是来证实这一点的。
 *
 * 用完即删:探针会话建在一个专用键上,验完调 sessions.delete 清掉,不碰真实任务。
 *
 * 用法:node scripts/probe-workspace-cwd.mjs [目标目录]
 */
import crypto from 'node:crypto'
import path from 'node:path'
import WebSocket from 'ws'

const URL = process.env.GATEWAY_URL ?? 'ws://127.0.0.1:18789'
const SCOPES = ['operator.read', 'operator.write', 'operator.admin']
/** 刻意选在受管根之外(仓库同级的临时目录),正是用户「打开本地文件夹」的形状。 */
const TARGET_CWD = path.resolve(process.argv[2] ?? 'd:\\work\\yunwu-jihe\\.probe-workspace')
const SESSION_KEY = `agent:main:acp:t${Date.now()}wsp0`
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
  return spki.length === ED25519_SPKI_PREFIX.length + 32
    ? spki.subarray(ED25519_SPKI_PREFIX.length)
    : spki
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

ws.on('error', (e) => console.error('[ws-probe] error', e.message))

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
      resolve: () => runProbe(),
      reject: (e) => {
        console.error('[ws-probe] connect FAILED:', JSON.stringify(e))
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
          device: {
            id: id.deviceId, publicKey: base64Url(id.raw),
            signature: sig, signedAt: signedAtMs, nonce
          }
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

async function runProbe() {
  console.log('[ws-probe] 目标 cwd =', TARGET_CWD)
  console.log('[ws-probe] 探针会话 =', SESSION_KEY)
  let patched = false
  try {
    await request('sessions.create', { key: SESSION_KEY })
    console.log('[ws-probe] sessions.create OK')

    const res = await request('sessions.patch', { key: SESSION_KEY, spawnedCwd: TARGET_CWD })
    console.log('[ws-probe] sessions.patch(spawnedCwd) OK ->', JSON.stringify(res).slice(0, 200))
    patched = true

    // 同值重复写:证实每次发消息都调 ensureSession 不会撞上「不可更改」。
    await request('sessions.patch', { key: SESSION_KEY, spawnedCwd: TARGET_CWD })
    console.log('[ws-probe] 同值重复 patch OK(幂等成立)')

    // 回读,确认落库的就是那个目录。
    const listed = await request('sessions.list', { agentId: 'main' })
    const rows = listed?.sessions ?? listed?.entries ?? []
    const hit = (Array.isArray(rows) ? rows : []).find(
      (r) => r.key === SESSION_KEY || r.sessionKey === SESSION_KEY
    )
    console.log('[ws-probe] 回读 spawnedCwd =', hit ? hit.spawnedCwd : '(sessions.list 未回显该字段)')

    // 反证:换一个不同的值应当被拒,证明我们读到的约束是真的。
    try {
      await request('sessions.patch', { key: SESSION_KEY, spawnedCwd: TARGET_CWD + '-other' })
      console.log('[ws-probe] 意外:改值竟被接受(与源码读到的不可变语义不符)')
    } catch (e) {
      console.log('[ws-probe] 改值被拒(符合预期) ->', e?.message ?? JSON.stringify(e))
    }
  } catch (e) {
    console.log(`[ws-probe] 失败(patched=${patched}) ->`, e?.message ?? JSON.stringify(e))
  } finally {
    try {
      await request('sessions.delete', { key: SESSION_KEY })
      console.log('[ws-probe] 探针会话已删除')
    } catch (e) {
      console.log('[ws-probe] 删除探针会话失败:', e?.message ?? JSON.stringify(e))
    }
    ws.close()
  }
}
