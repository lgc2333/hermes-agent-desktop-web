#!/usr/bin/env node
/** M4 观察：kill mock 后逐秒采样状态栏，看状态序列（关键词匹配版）。 */
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

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Runtime.enable', {}, sessionId)
await send('Page.enable', {}, sessionId)
await send('Page.navigate', { url: APP }, sessionId)
await waitFor(sessionId, '!!window.hermesDesktop && document.body.innerText.includes("Gateway") && document.body.innerText.includes("ready")', 60000, 'boot ready')
await new Promise(r => setTimeout(r, 1500))

const sample = async (label) => {
  const s = await evalIn(sessionId, `(() => {
    const sb = document.querySelector('[data-slot="statusbar"]')?.innerText || ''
    const m = sb.split('Gateway')[1] || ''
    return { after: (m.split(String.fromCharCode(10)).map(function(s){ return s.trim() }).filter(Boolean)[0] || '').slice(0, 20) }
  })()`)
  console.log('  t+' + label + ': Gateway=' + s.after)
  return s
}

console.log('[obs] baseline:')
await sample('0s')

const { execSync } = await import('node:child_process')
try { execSync(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 5180 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"`) } catch (e) { console.log('  kill warn:', e.message.slice(0, 100)) }
console.log('[obs] mock killed, sampling...')
for (let i = 1; i <= 14; i++) {
  await new Promise(r => setTimeout(r, 1000))
  await sample(i + 's')
}

const overlays = await evalIn(sessionId, `(() => {
  const txt = document.body.innerText
  return {
    bootArea: /failed|retry|sign in/i.test(txt.slice(0, 600)) ? txt.slice(0, 200) : null,
    toasts: [...document.querySelectorAll('[data-slot="toast"], [role="status"]')].map(e => e.innerText.slice(0, 80))
  }
})()`)
console.log('[obs] overlays:', JSON.stringify(overlays, null, 1))

const { spawn } = await import('node:child_process')
const mock = spawn(process.execPath, ['apps/web/dev/mock-gateway.mjs', '5180'], { cwd: process.cwd(), stdio: 'ignore', detached: true })
mock.unref()
for (let i = 0; i < 30; i++) {
  try { const r = await fetch('http://127.0.0.1:5180/api/status'); if (r.ok || r.status === 401) break } catch {}
  await new Promise(r => setTimeout(r, 500))
}
console.log('[obs] mock restarted, sampling recovery...')
for (let i = 1; i <= 12; i++) {
  await new Promise(r => setTimeout(r, 1000))
  await sample((15 + i) + 's')
}

console.log('[obs] DONE')
await send('Target.closeTarget', { targetId })
process.exit(0)