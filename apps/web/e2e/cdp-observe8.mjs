#!/usr/bin/env node
/** M4 观察 v8（完整闭环）：boot → kill mock → checking → 重启 mock → ready → 聊天可用。 */
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
async function waitFor(sessionId, expression, timeoutMs = 40000, label = expression) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await evalIn(sessionId, expression)
    if (last) return last
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error('waitFor timeout: ' + label + ' (last=' + JSON.stringify(last) + ')')
}
const { execSync, spawn } = await import('node:child_process')

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Runtime.enable', {}, sessionId)
await send('Page.enable', {}, sessionId)
await send('Page.navigate', { url: APP }, sessionId)
await waitFor(sessionId, '!!window.hermesDesktop', 60000, 'boot')
await evalIn(sessionId, `window.localStorage.removeItem('hermes-web.connections.v1'); true`)
await evalIn(sessionId, `location.reload(); true`)
await waitFor(sessionId, '!!window.hermesDesktop && document.body.innerText.includes("Gateway") && document.body.innerText.includes("ready")', 60000, 'boot ready')
await new Promise(r => setTimeout(r, 1500))
console.log('[obs8] boot ready (token 5180)')

const gatewayState = async () => {
  return evalIn(sessionId, `(() => {
    const sb = document.querySelector('[data-slot="statusbar"]')?.innerText || ''
    const m = sb.split('Gateway')[1] || ''
    return (m.split(String.fromCharCode(10)).map(function(x){ return x.trim() }).filter(Boolean)[0] || '?').slice(0, 20)
  })()`)
}

// kill mock
const pid = execSync(`powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 5180 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"`).toString().trim()
console.log('[obs8] killing mock pid', pid)
execSync('taskkill /F /PID ' + pid)
await new Promise(r => setTimeout(r, 3000))
console.log('[obs8] after kill: Gateway=' + (await gatewayState()))

// 重启 mock
const mock = spawn(process.execPath, ['apps/web/dev/mock-gateway.mjs', '5180'], { cwd: process.cwd(), stdio: 'ignore', detached: true })
mock.unref()
for (let i = 0; i < 30; i++) {
  try { const r = await fetch('http://127.0.0.1:5180/api/status'); if (r.ok) break } catch {}
  await new Promise(r => setTimeout(r, 500))
}
console.log('[obs8] mock restarted')

// 等 ready（自动重连成功）
let backToReady = false
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 1000))
  const st = await gatewayState()
  if (st === 'ready') { backToReady = true; console.log('[obs8] t+' + (i + 1) + 's Gateway=' + st + ' — reconnected!'); break }
  if (i % 5 === 0) console.log('[obs8] t+' + (i + 1) + 's Gateway=' + st)
}
console.log('[obs8] reconnected:', backToReady)

// 发消息确认可用
await evalIn(sessionId, `location.hash = '#/'; true`)
await new Promise(r => setTimeout(r, 2000))
await evalIn(sessionId, `
  (() => {
    const el = [...document.querySelectorAll('[contenteditable="true"]')].find(e => e.getBoundingClientRect().width > 50)
    if (!el) return false
    el.focus()
    el.textContent = ''
    return true
  })()
`)
await send('Input.insertText', { text: 'post-reconnect-final' }, sessionId)
await new Promise(r => setTimeout(r, 300))
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId)
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId)
const replied = await waitFor(sessionId, `document.body.innerText.includes('Hello from the mock gateway')`, 30000, 'post-reconnect reply')
console.log('[obs8] chat after reconnect:', replied)

console.log('[obs8] DONE')
await send('Target.closeTarget', { targetId })
process.exit(0)