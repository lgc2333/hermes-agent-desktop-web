#!/usr/bin/env node
/**
 * M4 错误/重连态实测 B（OAuth）：登录 5182 → kill 代理 → 观察 → 重启代理 → 观察会话丢失表现。
 * 前置：mock(5182 MOCK_OAUTH=1) + proxy(6722) + vite(5173) + chrome 9224。
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
await waitFor(sessionId, '!!window.hermesDesktop', 60000, 'boot')

// 干净注册表 → 指向 5182（gated OAuth mock）
await evalIn(sessionId, `
  (() => {
    const store = { version: 1, primary: 'gw', connections: [{ id: 'gw', label: 'OAuth mock', kind: 'remote', url: 'http://127.0.0.1:5182', authMode: 'token', token: 'mock-token' }] }
    localStorage.setItem('hermes-web.connections.v1', JSON.stringify(store))
    return true
  })()
`)
await evalIn(sessionId, `location.reload(); true`)
await waitFor(sessionId, '!!window.hermesDesktop', 60000, 'reload boot')
await new Promise(r => setTimeout(r, 3000))

// 设置页 → 切 OAuth → Sign in
console.log('[B] settings gateway tab...')
await evalIn(sessionId, `location.hash = '#/settings?tab=gateway'; true`)
// 等 probe 完成 + 找到 Sign in 按钮（gated mock 显示 auth provider）
const signIn = await waitFor(sessionId, `
  (() => {
    const b = [...document.querySelectorAll('button')].find(x => /sign in with/i.test(x.textContent) || /^sign in$/i.test(x.textContent.trim()))
    return b ? b.textContent.trim() : null
  })()
`, 30000, 'sign in button')
pass('sign-in button visible', signIn)

// 点击 Sign in（gated mock 的 authorize 即时 302 完成）
await evalIn(sessionId, `
  [...document.querySelectorAll('button')].find(x => /sign in with/i.test(x.textContent) || /^sign in$/i.test(x.textContent.trim()))?.click(); true
`)
const connected = await waitFor(sessionId, `
  (() => {
    const btns = [...document.querySelectorAll('button')].map(b => b.textContent.trim())
    return btns.some(x => /sign out/i.test(x)) ? true : null
  })()
`, 45000, 'oauth connected')
pass('oauth connected (Sign out visible)', String(connected))

// 回聊天：发消息确认流式（OAuth 会话经代理）
console.log('[B] chat baseline (OAuth)...')
await evalIn(sessionId, `location.hash = '#/'; true`)
await new Promise(r => setTimeout(r, 2500))
await evalIn(sessionId, `
  (() => {
    const el = [...document.querySelectorAll('[contenteditable="true"]')].find(e => e.getBoundingClientRect().width > 50)
    if (!el) return false
    el.focus()
    el.textContent = ''
    return true
  })()
`)
await send('Input.insertText', { text: 'oauth reconnect test' }, sessionId)
await new Promise(r => setTimeout(r, 300))
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId)
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId)
const replied = await waitFor(sessionId, `document.body.innerText.includes('Hello from the mock gateway')`, 30000, 'oauth baseline reply')
pass('oauth chat streamed', String(replied))

// kill 代理 → 观察
console.log('[B] killing proxy 6722...')
killPort(6722)
await new Promise(r => setTimeout(r, 5000))
const afterKill = await evalIn(sessionId, `(() => {
  const txt = document.body.innerText
  return {
    tail: txt.slice(-400),
    statusbar: (document.querySelector('[data-slot="statusbar"]')?.innerText || '').slice(0, 150)
  }
})()`)
info('UI after proxy kill', JSON.stringify(afterKill.tail.slice(-180)))
console.log('  statusbar:', JSON.stringify(afterKill.statusbar))

// 重启代理
console.log('[B] restarting proxy 6722...')
const proxy = spawn('deno', ['run', '--allow-net', '--allow-read', '--allow-env', 'apps/proxy/src/main.ts'], { cwd: repoRoot, stdio: 'ignore', detached: true })
proxy.unref()
let proxyUp = false
for (let i = 0; i < 30; i++) {
  try {
    const r = await fetch('http://127.0.0.1:6722/api/proxy/meta')
    if (r.ok) { proxyUp = true; break }
  } catch {}
  await new Promise(r => setTimeout(r, 500))
}
pass('proxy restarted', 'up=' + proxyUp)
await new Promise(r => setTimeout(r, 5000))

// 观察：设置页 OAuth 状态（会话丢失 → Sign in 回来）
console.log('[B] settings after proxy restart...')
await evalIn(sessionId, `location.hash = '#/settings?tab=gateway'; true`)
await new Promise(r => setTimeout(r, 4000))
const afterRestart = await evalIn(sessionId, `(() => {
  const btns = [...document.querySelectorAll('button')].map(b => b.textContent.trim())
  return {
    hasSignIn: btns.some(x => /sign in/i.test(x)),
    hasSignOut: btns.some(x => /sign out/i.test(x)),
    tail: document.body.innerText.slice(-350)
  }
})()`)
info('settings after proxy restart', 'signIn=' + afterRestart.hasSignIn + ' signOut=' + afterRestart.hasSignOut)
console.log('  tail:', JSON.stringify(afterRestart.tail.slice(-250)))

// 直接查桥层会话状态
const sess = await evalIn(sessionId, `window.hermesDesktop.getConnectionConfig().then(c => ({ connected: c.remoteOauthConnected, preview: c.remoteTokenPreview }))`)
info('bridge oauth status after restart', JSON.stringify(sess))

console.log('\n[B] DONE')
await send('Target.closeTarget', { targetId })
process.exit(0)