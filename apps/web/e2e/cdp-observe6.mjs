#!/usr/bin/env node
/** M4 观察 v6：直接用 taskkill /PID 杀 mock，逐秒采样状态栏。 */
const CDP =
  'ws://127.0.0.1:9224/devtools/browser/' +
  (
    await fetch('http://127.0.0.1:9224/json/version').then((r) => r.json())
  ).webSocketDebuggerUrl
    .split('/')
    .pop()
const APP = 'http://127.0.0.1:5173'
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
        reject(new Error('CDP timeout: ' + method))
      }
    }, 15000)
  })
}
ws.onmessage = (event) => {
  const msg = JSON.parse(String(event.data))
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
}
async function evalIn(sessionId, expression, awaitPromise = true) {
  const res = await send(
    'Runtime.evaluate',
    { expression, awaitPromise, returnByValue: true },
    sessionId,
  )
  if (res.exceptionDetails)
    throw new Error(
      'eval failed: ' +
        JSON.stringify(
          res.exceptionDetails.exception?.description ?? res.exceptionDetails.text,
        ),
    )
  return res.result?.value
}
async function waitFor(sessionId, expression, timeoutMs = 40000, label = expression) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await evalIn(sessionId, expression)
    if (last) return last
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('waitFor timeout: ' + label + ' (last=' + JSON.stringify(last) + ')')
}
const { execSync } = await import('node:child_process')

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Runtime.enable', {}, sessionId)
await send('Page.enable', {}, sessionId)
await send('Page.navigate', { url: APP }, sessionId)
await waitFor(
  sessionId,
  '!!window.hermesDesktop && document.body.innerText.includes("Gateway") && document.body.innerText.includes("ready")',
  60000,
  'boot ready',
)
await new Promise((r) => setTimeout(r, 1500))

const sample = async (label) => {
  const s = await evalIn(
    sessionId,
    `(() => {
    const sb = document.querySelector('[data-slot="statusbar"]')?.innerText || ''
    const m = sb.split('Gateway')[1] || ''
    const tok = m.split(String.fromCharCode(10)).map(function(x){ return x.trim() }).filter(Boolean)[0] || ''
    return tok.slice(0, 20)
  })()`,
  )
  console.log('  t+' + label + ': Gateway=' + s)
  return s
}

console.log('[obs6] baseline:')
await sample('0s')

// 拿 5180 监听 PID 并 taskkill
let pid = null
try {
  const out = execSync(
    `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 5180 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"`,
  )
    .toString()
    .trim()
  pid = out || null
} catch (e) {
  console.log('  get pid warn:', e.message.slice(0, 80))
}
console.log('[obs6] mock pid:', pid)
if (pid) {
  try {
    execSync('taskkill /F /PID ' + pid)
  } catch (e) {
    console.log('  kill warn:', e.message.slice(0, 100))
  }
}
console.log('[obs6] mock killed, sampling...')
for (let i = 1; i <= 15; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  await sample(i + 's')
}

const state = await evalIn(
  sessionId,
  `(() => {
  const txt = document.body.innerText
  return {
    bootArea: /failed|retry|sign in|reconnect|offline/i.test(txt.slice(0, 900)) ? txt.slice(0, 300) : null,
    toasts: [...document.querySelectorAll('[data-slot="toast"], [role="status"]')].map(e => e.innerText.slice(0, 100))
  }
})()`,
)
console.log('[obs6] overlays:', JSON.stringify(state, null, 1))

console.log('[obs6] DONE')
await send('Target.closeTarget', { targetId })
process.exit(0)
