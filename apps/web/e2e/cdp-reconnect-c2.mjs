#!/usr/bin/env node
/** M4 错误态验证 C2：断连（connecting）期间提交消息 → 精确检查是否有反馈。 */
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
function info(name, detail = '') { console.log('  INFO ' + name + (detail ? ' — ' + detail : '')) }

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Runtime.enable', {}, sessionId)
await send('Page.enable', {}, sessionId)
await send('Page.navigate', { url: APP }, sessionId)
await waitFor(sessionId, '!!window.hermesDesktop && document.body.innerText.includes("Gateway") && document.body.innerText.includes("ready")', 60000, 'boot ready')
await new Promise(r => setTimeout(r, 2000))

const { execSync } = await import('node:child_process')
execSync(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 5180 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"`)

// 等状态栏变 connecting（确认断连被 UI 感知）
await waitFor(sessionId, `(document.querySelector('[data-slot="statusbar"]')?.innerText || '').includes('connecting')`, 20000, 'statusbar connecting')
info('statusbar shows connecting')
await new Promise(r => setTimeout(r, 1000))

// 提交消息
await evalIn(sessionId, `
  (() => {
    const el = [...document.querySelectorAll('[contenteditable="true"]')].find(e => e.getBoundingClientRect().width > 50)
    if (!el) return false
    el.focus()
    el.textContent = ''
    return true
  })()
`)
await send('Input.insertText', { text: 'SEND-WHILE-OFFLINE' }, sessionId)
await new Promise(r => setTimeout(r, 300))
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId)
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId)
await new Promise(r => setTimeout(r, 2500))

const r1 = await evalIn(sessionId, `(() => {
  const txt = document.body.innerText
  return {
    msgInTranscript: txt.includes('SEND-WHILE-OFFLINE'),
    composerStillHas: (() => { const el = [...document.querySelectorAll('[contenteditable="true"]')].find(e => e.getBoundingClientRect().width > 50); return el ? el.textContent.slice(0, 60) : null })(),
    errorVisible: /not connected|unavailable|failed to|offline|connection lost/i.test(txt.slice(-700))
    ? (txt.match(/(.{0,60}(?:not connected|unavailable|failed to|offline|connection lost).{0,60})/i) || [null])[0] : null,
    tail: txt.slice(-300)
  }
})()`)
info('after submit while offline', JSON.stringify(r1))

// 重启 mock，等 ready，检查消息是否补发
const { spawn } = await import('node:child_process')
const mock = spawn(process.execPath, ['apps/web/dev/mock-gateway.mjs', '5180'], { cwd: process.cwd(), stdio: 'ignore', detached: true })
mock.unref()
for (let i = 0; i < 30; i++) {
  try { const r = await fetch('http://127.0.0.1:5180/api/status'); if (r.ok || r.status === 401) break } catch {}
  await new Promise(r => setTimeout(r, 500))
}
await waitFor(sessionId, `(document.querySelector('[data-slot="statusbar"]')?.innerText || '').includes('ready')`, 40000, 'ready again')
await new Promise(r => setTimeout(r, 3000))
const r2 = await evalIn(sessionId, `(() => {
  const txt = document.body.innerText
  return {
    msgInTranscript: txt.includes('SEND-WHILE-OFFLINE'),
    tail: txt.slice(-300)
  }
})()`)
info('after reconnect', JSON.stringify(r2))

console.log('\n[C2] DONE')
await send('Target.closeTarget', { targetId })
process.exit(0)