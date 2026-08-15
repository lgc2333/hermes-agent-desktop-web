#!/usr/bin/env node
/** M4 决定性实验：mock 5180 完全不可达 → 新开页面 → 采样状态栏 20 秒 + 记录 boot 区文本。 */
const CDP = 'ws://127.0.0.1:9224/devtools/browser/' + (await fetch('http://127.0.0.1:9224/json/version').then(r => r.json())).webSocketDebuggerUrl.split('/').pop()
const APP = 'http://127.0.0.1:5173'
let seq = 0
const pending = new Map()
const ws = new WebSocket(CDP)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
function send(method, params = {}, sessionId) {
  const id = ++seq
  const msg = { id, method, params }
  if (sessionId) msg.sessionId = sessionId
  ws.send(JSON.stringify(msg))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP timeout: ' + method)) } }, 15000)
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
  const res = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId)
  if (res.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text))
  return res.result?.value
}
async function waitFor(sessionId, expression, timeoutMs = 60000, label = expression) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await evalIn(sessionId, expression)
    if (last) return last
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error('waitFor timeout: ' + label + ' (last=' + JSON.stringify(last) + ')')
}

// 确认 mock 已死
try { const r = await fetch('http://127.0.0.1:5180/api/status'); console.log('[exp] mock ALIVE:', r.status) } catch { console.log('[exp] mock dead confirmed') }

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Runtime.enable', {}, sessionId)
await send('Page.enable', {}, sessionId)
await send('Page.navigate', { url: APP }, sessionId)
await waitFor(sessionId, '!!window.hermesDesktop', 60000, 'bridge boot')
await evalIn(sessionId, `window.localStorage.removeItem('hermes-web.connections.v1'); true`)
await evalIn(sessionId, `location.reload(); true`)
await waitFor(sessionId, '!!window.hermesDesktop', 60000, 'bridge after reload')
await new Promise(r => setTimeout(r, 2000))

console.log('[exp] sampling statusbar 20s (mock dead):')
for (let i = 0; i < 20; i++) {
  const s = await evalIn(sessionId, `(() => {
    const sb = document.querySelector('[data-slot="statusbar"]')?.innerText || ''
    const m = sb.split('Gateway')[1] || ''
    const tok = (m.split(String.fromCharCode(10)).map(function(x){ return x.trim() }).filter(Boolean)[0] || '?').slice(0, 20)
    return { tok, bootArea: document.body.innerText.slice(0, 300) }
  })()`)
  console.log('  t+' + i + 's: Gateway=' + s.tok)
  await new Promise(r => setTimeout(r, 1000))
}

const final = await evalIn(sessionId, `(() => {
  const txt = document.body.innerText
  return {
    bootArea: txt.slice(0, 400),
    composerCount: [...document.querySelectorAll('[contenteditable="true"]')].filter(e => e.getBoundingClientRect().width > 50).length,
    overlayVisible: document.querySelector('[data-slot="overlay"], [role="dialog"]') ? true : false
  }
})()`)
console.log('[exp] final:', JSON.stringify(final, null, 1))

console.log('[exp] DONE')
await send('Target.closeTarget', { targetId })
process.exit(0)