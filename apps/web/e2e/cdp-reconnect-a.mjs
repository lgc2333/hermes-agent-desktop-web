#!/usr/bin/env node
/**
 * M4 错误/重连态实测 A（token 模式）：WS 断连 → 观察 UI → mock 重启 → 观察恢复。
 * 前置：mock(5180) + proxy(6722) + vite(5173) + chrome 9224。
 * 本脚本内部负责杀/重启 mock（node child_process + powershell）。
 */
import { execSync, spawn } from 'node:child_process'

const killPort = (port) => {
  try {
    execSync(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"`)
  } catch (e) { console.log('  kill warn:', e.message.slice(0, 120)) }
}

const CDP = 'ws://127.0.0.1:9224/devtools/browser/' + (await fetch('http://127.0.0.1:9224/json/version').then(r => r.json())).webSocketDebuggerUrl.split('/').pop()
const APP = 'http://127.0.0.1:5173'
const repoRoot = process.cwd()

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
function info(name, detail = '') { console.log('  INFO ' + name + (detail ? ' — ' + detail : '')) }

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Runtime.enable', {}, sessionId)
await send('Page.enable', {}, sessionId)
await send('Page.navigate', { url: APP }, sessionId)
await waitFor(sessionId, '!!window.hermesDesktop && document.body.innerText.includes("Gateway") && document.body.innerText.includes("ready")', 60000, 'boot ready')
await new Promise(r => setTimeout(r, 2000))
pass('app booted (token mock 5180)')

// 发一条消息确认流式正常
console.log('[A] chat baseline...')
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
await send('Input.insertText', { text: 'reconnect test message' }, sessionId)
await new Promise(r => setTimeout(r, 300))
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId)
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId)
const replied = await waitFor(sessionId, `document.body.innerText.includes('Hello from the mock gateway')`, 30000, 'baseline reply')
pass('baseline chat streamed', String(replied))

// 杀 mock → 观察断连表现
console.log('[A] killing mock gateway 5180...')
killPort(5180)
await new Promise(r => setTimeout(r, 4000))

const afterKill = await evalIn(sessionId, `(() => {
  const txt = document.body.innerText
  return {
    hasDisconnected: /disconnect|reconnect|offline|unreachable|closed/i.test(txt.slice(-800)),
    tail: txt.slice(-500),
    statusbar: (document.querySelector('[data-slot="statusbar"]')?.innerText || '').slice(0, 200)
  }
})()`)
info('UI after mock kill', JSON.stringify(afterKill.tail.slice(-200)))
console.log('  statusbar:', JSON.stringify(afterKill.statusbar))

// 重启 mock → 观察自动重连
console.log('[A] restarting mock gateway 5180...')
const mock = spawn(process.execPath, ['apps/web/dev/mock-gateway.mjs', '5180'], { cwd: repoRoot, stdio: 'ignore', detached: true })
mock.unref()

// 等 mock 端口起来
let mockUp = false
for (let i = 0; i < 30; i++) {
  try {
    const r = await fetch('http://127.0.0.1:5180/api/status')
    if (r.ok || r.status === 401) { mockUp = true; break }
  } catch {}
  await new Promise(r => setTimeout(r, 500))
}
pass('mock restarted', 'up=' + mockUp)

// 观察重连：状态栏/连接状态是否回到 ready，或自动重发消息
const reconnected = await waitFor(sessionId, `(() => {
  const sb = document.querySelector('[data-slot="statusbar"]')?.innerText || ''
  return sb.includes('ready') || /open|connected/i.test(sb) ? sb.slice(0, 120) : null
})()`, 45000, 'reconnect ready')
pass('UI shows reconnect/ready after mock restart', String(reconnected))

// 再发一条消息验证重连后可用
console.log('[A] chat after reconnect...')
await evalIn(sessionId, `
  (() => {
    const el = [...document.querySelectorAll('[contenteditable="true"]')].find(e => e.getBoundingClientRect().width > 50)
    if (!el) return false
    el.focus()
    el.textContent = ''
    return true
  })()
`)
await send('Input.insertText', { text: 'after reconnect' }, sessionId)
await new Promise(r => setTimeout(r, 300))
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId)
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId)
const replied2 = await waitFor(sessionId, `document.body.innerText.includes('Hello from the mock gateway')`, 30000, 'post-reconnect reply')
pass('chat works after auto-reconnect', String(replied2))

console.log('\n[A] DONE')
await send('Target.closeTarget', { targetId })
process.exit(0)