#!/usr/bin/env node
/** M4 响应式验证 3：侧边栏 toggle + 设置页 gateway tab（移动视口）。 */
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

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Runtime.enable', {}, sessionId)
await send('Page.enable', {}, sessionId)
await send(
  'Emulation.setDeviceMetricsOverride',
  { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
  sessionId,
)
await send('Page.navigate', { url: APP }, sessionId)
await waitFor(
  sessionId,
  "document.querySelector('#root')?.children.length > 0",
  40000,
  'root mounted',
)
await new Promise((r) => setTimeout(r, 8000))

// 侧边栏：找 trigger（panel-left 按钮，通常 aria-label 或 data-slot）
const sb = await evalIn(
  sessionId,
  `(() => {
  const triggers = [...document.querySelectorAll('[data-slot="sidebar-trigger"], [aria-label*="sidebar" i], [aria-label*="Sidebar"], button[data-state]')]
  const info = {
    sidebarVisible: (() => {
      const s = document.querySelector('[data-slot="sidebar"]')
      if (!s) return null
      const r = s.getBoundingClientRect()
      const cs = getComputedStyle(s)
      return { w: Math.round(r.width), x: Math.round(r.x), visibility: cs.visibility, transform: cs.transform, display: cs.display }
    })(),
    triggers: triggers.slice(0, 6).map(t => ({ cls: (t.className || '').toString().slice(0, 60), aria: t.getAttribute('aria-label'), title: t.getAttribute('title') }))
  }
  return info
})()`,
)
console.log('sidebar state:', JSON.stringify(sb, null, 1))

// 设置页 gateway tab
await evalIn(sessionId, `location.hash = '#/settings?tab=gateway'`)
await new Promise((r) => setTimeout(r, 4000))
const settings = await evalIn(sessionId, `document.body.innerText.slice(0, 600)`)
console.log('settings gateway tab:', JSON.stringify(settings.slice(0, 400)))
const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
const fs = await import('node:fs')
fs.writeFileSync(
  'temp/e2e-out/mobile-settings-gateway.png',
  Buffer.from(shot.data, 'base64'),
)
await send('Target.closeTarget', { targetId })
process.exit(0)
