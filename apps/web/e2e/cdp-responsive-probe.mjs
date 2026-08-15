#!/usr/bin/env node
/**
 * M4 响应式探测：移动视口下检查布局问题（横向滚动、侧边栏、聊天区、输入框）。
 * 前置：mock(5180 token) + proxy(6722) + vite(5173) + chrome 9224。
 */
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

console.log('[M4-responsive] opening app with mobile viewport...')
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Runtime.enable', {}, sessionId)
await send('Page.enable', {}, sessionId)

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, sessionId)

await send('Page.navigate', { url: APP }, sessionId)

await waitFor(sessionId, "document.querySelector('#root')?.children.length > 0", 40000, 'root mounted')
await new Promise(r => setTimeout(r, 8000))

const probeExpr = `(() => {
  const d = document.documentElement
  const out = {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollWidth: d.scrollWidth,
    scrollHeight: d.scrollHeight,
    bodyOverflowX: getComputedStyle(document.body).overflowX,
    bodyText: document.body.innerText.slice(0, 300),
    sidebar: null,
    fixedEls: [...document.querySelectorAll('*')].filter(e => getComputedStyle(e).position === 'fixed').slice(0, 8).map(e => ({
      tag: e.tagName, cls: (e.className || '').toString().slice(0, 60),
      rect: (() => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })(),
      visible: e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'
    })),
    textareas: [...document.querySelectorAll('textarea, [contenteditable="true"]')].map(e => {
      const r = e.getBoundingClientRect()
      return { tag: e.tagName, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), visible: r.width > 0 && r.height > 0 }
    })
  }
  const sb = document.querySelector('[class*="sidebar"], [class*="Sidebar"], nav')
  if (sb) {
    const r = sb.getBoundingClientRect()
    out.sidebar = { tag: sb.tagName, cls: (sb.className || '').toString().slice(0, 80), x: Math.round(r.x), w: Math.round(r.width), visible: r.width > 0 }
  }
  return out
})()`
const probe = await evalIn(sessionId, probeExpr)
console.log(JSON.stringify(probe, null, 2))

const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
const fs = await import('node:fs')
fs.writeFileSync('temp/e2e-out/mobile-boot.png', Buffer.from(shot.data, 'base64'))
console.log('[M4-responsive] screenshot: temp/e2e-out/mobile-boot.png')
await send('Target.closeTarget', { targetId })
process.exit(0)