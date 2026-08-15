#!/usr/bin/env node
/**
 * M4 响应式探测 2：聊天页 + 侧边栏抽屉 + 设置页（移动视口 390x844）。
 * 前置：mock(5180) + proxy(6722) + vite(5173) + chrome 9224。
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
function pass(name, detail = '') { console.log('  PASS ' + name + (detail ? ' — ' + detail : '')) }
function fail(name, detail = '') { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')) }

async function screenshot(sessionId, name) {
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
  const fs = await import('node:fs')
  fs.writeFileSync('temp/e2e-out/' + name, Buffer.from(shot.data, 'base64'))
  console.log('  [shot] temp/e2e-out/' + name)
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Runtime.enable', {}, sessionId)
await send('Page.enable', {}, sessionId)
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, sessionId)
await send('Page.navigate', { url: APP }, sessionId)
await waitFor(sessionId, "document.querySelector('#root')?.children.length > 0", 40000, 'root mounted')
await new Promise(r => setTimeout(r, 8000))

console.log('[M4-r2] boot done; probing status bar...')
const statusBar = await evalIn(sessionId, `(() => {
  // 底部状态栏：找含 Gateway/Remote 文本的元素
  const els = [...document.querySelectorAll('*')].filter(e => /Gateway|Remote:/.test(e.textContent || '') && e.children.length <= 2)
  const out = []
  for (const e of els.slice(0, 6)) {
    const r = e.getBoundingClientRect()
    out.push({
      cls: (e.className || '').toString().slice(0, 70),
      rect: { x: Math.round(r.x), w: Math.round(r.width), y: Math.round(r.y), h: Math.round(r.height) },
      overflow: getComputedStyle(e).overflowX + '/' + getComputedStyle(e).overflowY,
      text: (e.textContent || '').slice(0, 80)
    })
  }
  return out
})()`)
console.log('statusBar:', JSON.stringify(statusBar, null, 1))

// 聊天页：找 composer 输入并发送消息
console.log('[M4-r2] chat composer...')
const composer = await evalIn(sessionId, `(() => {
  const ta = document.querySelector('textarea')
  if (!ta) return null
  const r = ta.getBoundingClientRect()
  return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), placeholder: ta.placeholder || '' }
})()`)
console.log('composer:', JSON.stringify(composer))

// 输入消息并提交
const typed = await evalIn(sessionId, `(() => {
  const ta = document.querySelector('textarea')
  if (!ta) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, 'hello from m4 mobile')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  return ta.value
})()`)
console.log('typed:', JSON.stringify(typed))
await new Promise(r => setTimeout(r, 800))
// 找提交按钮（Enter 或按钮点击）
const submitted = await evalIn(sessionId, `(() => {
  const ta = document.querySelector('textarea')
  if (!ta) return false
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  return true
})()`)
console.log('submit dispatched:', submitted)
await new Promise(r => setTimeout(r, 6000))
await screenshot(sessionId, 'mobile-chat.png')

// 检查消息区文本
const chatText = await evalIn(sessionId, `document.body.innerText.slice(-600)`)
console.log('chat tail:', JSON.stringify(chatText.slice(-300)))

// 侧边栏：找 toggle 按钮（通常有 panel-left / menu 图标）
console.log('[M4-r2] sidebar toggle...')
const sidebarInfo = await evalIn(sessionId, `(() => {
  const sb = document.querySelector('[class*="sidebar-wrapper"]')
  if (!sb) return null
  const r = sb.getBoundingClientRect()
  return { w: Math.round(r.width), x: Math.round(r.x), cls: (sb.className || '').toString().slice(0, 100), display: getComputedStyle(sb).display }
})()`)
console.log('sidebar:', JSON.stringify(sidebarInfo))

// 设置页（HashRouter）
console.log('[M4-r2] settings page...')
await evalIn(sessionId, `location.hash = '#/settings'`)
await new Promise(r => setTimeout(r, 4000))
await screenshot(sessionId, 'mobile-settings.png')
const settingsText = await evalIn(sessionId, `document.body.innerText.slice(0, 500)`)
console.log('settings text:', JSON.stringify(settingsText.slice(0, 300)))
await send('Target.closeTarget', { targetId })
process.exit(0)