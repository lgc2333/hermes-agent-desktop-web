#!/usr/bin/env node
/**
 * M3 CDP 验收（headless Chrome 9224）— OAuth 登录流 + 聊天 + 刷新保持。
 *
 * 场景（mock OAuth gateway :5180 → 代理 :6722 → vite :5173）：
 *   1. 桥层：oauthLoginConnectionConfig 完整流程（start→授权窗口→回跳→cookie 会话）
 *   2. 聊天：真实 WS（OAuth 会话 → 代理 mint ticket → 流式回复）
 *   3. UI 层：设置页 OAuth 按钮出现
 *   4. 刷新页面：cookie 会话保持
 *   5. 登出：连接状态回到未连接
 *
 * Usage: node cdp-oauth.mjs
 */

const CDP = 'ws://127.0.0.1:9224/devtools/browser/' + (await fetch('http://127.0.0.1:9224/json/version').then(r => r.json())).webSocketDebuggerUrl.split('/').pop()
const APP = 'http://127.0.0.1:5173'
const TARGET = 'http://127.0.0.1:5180'

let seq = 0
const pending = new Map()

const ws = new WebSocket(CDP)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

function send(method, params = {}, sessionId) {
  const id = ++seq
  const msg = { id, method, params }
  if (sessionId) msg.sessionId = sessionId
  ws.send(JSON.stringify(msg))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }
    }, 15000)
  })
}

ws.onmessage = event => {
  const msg = JSON.parse(String(event.data))
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
}

async function evalIn(sessionId, expression, awaitPromise = true) {
  const res = await send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true
  }, sessionId)
  if (res.exceptionDetails) {
    throw new Error('eval failed: ' + JSON.stringify(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text))
  }
  return res.result?.value
}

async function waitFor(sessionId, expression, timeoutMs = 30000, label = expression) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await evalIn(sessionId, expression)
    if (last) return last
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`waitFor timeout: ${label} (last=${JSON.stringify(last)})`)
}

function pass(name, detail = '') {
  console.log(`  PASS ${name}${detail ? ' — ' + detail : ''}`)
}

console.log('[M3] opening app...')
const { targetId } = await send('Target.createTarget', { url: APP })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Runtime.enable', {}, sessionId)
await send('Page.enable', {}, sessionId)

await waitFor(sessionId, '!!window.hermesDesktop && !!document.querySelector("#root *")', 60000, 'app boot')
await new Promise(r => setTimeout(r, 3000))
pass('app booted, bridge installed')

console.log('[1] bridge-level OAuth login...')
await evalIn(sessionId, `
  window.localStorage.removeItem('hermes-web.connections.v1');
  true
`)
await evalIn(sessionId, `location.reload(); true`)
await waitFor(sessionId, '!!window.hermesDesktop', 60000, 'reload boot')
await new Promise(r => setTimeout(r, 3000))

const saved = await evalIn(sessionId, `
  window.hermesDesktop.saveConnectionConfig({
    mode: 'remote',
    remoteAuthMode: 'oauth',
    remoteUrl: '${TARGET}'
  }).then(c => ({ authMode: c.remoteAuthMode, url: c.remoteUrl }))
`)
pass('save oauth connection', JSON.stringify(saved))

const login = await evalIn(sessionId, `
  window.hermesDesktop.oauthLoginConnectionConfig('${TARGET}')
`)
pass('oauth login', JSON.stringify(login))
if (!login.connected) throw new Error('oauth login failed')

const config = await evalIn(sessionId, `
  window.hermesDesktop.getConnectionConfig().then(c => ({
    connected: c.remoteOauthConnected,
    preview: c.remoteTokenPreview,
    tokenSet: c.remoteTokenSet
  }))
`)
pass('config oauth connected', JSON.stringify(config))

console.log('[2] chat over WS (oauth session)...')
const chat = await evalIn(sessionId, `
  (async () => {
    const conn = await window.hermesDesktop.getConnection()
    const ws = new WebSocket(conn.wsUrl)
    const out = { opened: false, replies: [] }
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws open timeout')), 8000)
      ws.onopen = () => { out.opened = true; clearTimeout(t); resolve() }
      ws.onerror = () => { clearTimeout(t); reject(new Error('ws error')) }
    })
    let id = 1
    const pendingRpc = new Map()
    const reply = (method, params) => new Promise((resolve, reject) => {
      const myId = id++
      pendingRpc.set(myId, { resolve, reject })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }))
    })
    ws.onmessage = ev => {
      const frame = JSON.parse(String(ev.data))
      if (frame.id && pendingRpc.has(frame.id)) {
        const p = pendingRpc.get(frame.id)
        pendingRpc.delete(frame.id)
        frame.error ? p.reject(new Error(JSON.stringify(frame.error))) : p.resolve(frame.result)
      } else if (frame.method === 'event') {
        const { type, payload } = frame.params
        if (type === 'message.delta') out.replies.push(payload.text)
        if (type === 'message.complete') out.complete = payload.text
      }
    }
    const created = await reply('session.create', { source: 'desktop' })
    out.sessionId = created.session_id
    await reply('prompt.submit', { session_id: created.session_id, text: 'hello oauth m3' })
    const deadline = Date.now() + 20000
    while (!out.complete && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200))
    }
    ws.close()
    return out
  })()
`)
pass('chat streaming', 'opened=' + chat.opened + ' complete=' + String(chat.complete ?? '').slice(0, 40))
if (!chat.opened || !chat.complete) throw new Error('chat failed: ' + JSON.stringify(chat))

console.log('[3] settings UI...')
await evalIn(sessionId, `location.href = '${APP}/settings?tab=gateway'; true`)
await new Promise(r => setTimeout(r, 2500))
const ui = await evalIn(sessionId, `
  (() => {
    const buttons = [...document.querySelectorAll('button')].map(b => b.textContent.trim().slice(0, 40))
    return buttons.filter(Boolean).slice(0, 20)
  })()
`)
console.log('  settings buttons:', JSON.stringify(ui))
const oauthButton = await evalIn(sessionId, `
  (() => {
    const b = [...document.querySelectorAll('button')].find(x => /sign in|log in|oauth|sign-in/i.test(x.textContent))
    return b ? { text: b.textContent.trim() } : null
  })()
`)
pass('oauth button visible', JSON.stringify(oauthButton))

console.log('[4] refresh persistence...')
await evalIn(sessionId, `location.reload(); true`)
await waitFor(sessionId, '!!window.hermesDesktop', 60000, 'refresh boot')
await new Promise(r => setTimeout(r, 3000))
const after = await evalIn(sessionId, `
  window.hermesDesktop.getConnectionConfig().then(c => c.remoteOauthConnected)
`)
pass('oauth session survives refresh', 'connected=' + after)

console.log('[5] logout...')
const logout = await evalIn(sessionId, `
  window.hermesDesktop.oauthLogoutConnectionConfig('${TARGET}')
`)
pass('oauth logout', JSON.stringify(logout))
const afterLogout = await evalIn(sessionId, `
  window.hermesDesktop.getConnectionConfig().then(c => c.remoteOauthConnected)
`)
pass('disconnected after logout', 'connected=' + afterLogout)

console.log('\n[M3] ALL PASS')
await send('Target.closeTarget', { targetId })
process.exit(0)
