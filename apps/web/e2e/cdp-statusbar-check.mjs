#!/usr/bin/env node
/** M4 响应式验证：状态栏窄视口可滚动（390px 下能看到 Gateway/backend 全文）。 */
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
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, sessionId)
await send('Page.navigate', { url: APP }, sessionId)
await waitFor(sessionId, "document.querySelector('#root')?.children.length > 0", 40000, 'root mounted')
await new Promise(r => setTimeout(r, 8000))

const probe = await evalIn(sessionId, `(() => {
  const sb = document.querySelector('[data-slot="statusbar"]')
  if (!sb) return null
  const inner = sb.querySelectorAll(':scope > div')
  const r = sb.getBoundingClientRect()
  return {
    barRect: { x: Math.round(r.x), w: Math.round(r.width), y: Math.round(r.y), h: Math.round(r.height) },
    children: [...inner].map(d => ({
      overflowX: getComputedStyle(d).overflowX,
      scrollWidth: d.scrollWidth,
      clientWidth: d.clientWidth,
      text: d.innerText.slice(0, 200)
    })),
    fullBarText: sb.innerText
  }
})()`)
console.log('statusbar:', JSON.stringify(probe, null, 1))

// 验证可滚动：右滚到底部看 backend 是否可见
const scrolled = await evalIn(sessionId, `(() => {
  const sb = document.querySelector('[data-slot="statusbar"]')
  if (!sb) return null
  const left = sb.querySelector(':scope > div:first-child')
  if (!left) return null
  left.scrollLeft = left.scrollWidth
  return { scrollLeft: left.scrollLeft, scrollWidth: left.scrollWidth, clientWidth: left.clientWidth }
})()`)
console.log('after scroll:', JSON.stringify(scrolled))
const visibleText = await evalIn(sessionId, `(() => {
  const sb = document.querySelector('[data-slot="statusbar"]')
  return sb ? sb.innerText : ''
})()`)
console.log('bar text:', JSON.stringify(visibleText))
const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
const fs = await import('node:fs')
fs.writeFileSync('temp/e2e-out/mobile-statusbar-fixed.png', Buffer.from(shot.data, 'base64'))
await send('Target.closeTarget', { targetId })
process.exit(0)