#!/usr/bin/env node
/** 模拟不可达 gateway → boot 失败 → boot-failure overlay 的 recovery 按钮行验证。 */
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
await send('Page.navigate', { url: APP }, sessionId)
await waitFor(sessionId, '!!window.hermesDesktop', 60000, 'boot')

// 注册表指向不可达 gateway（127.0.0.1:9）并 reload
await evalIn(
  sessionId,
  `
  (() => {
    const store = { version: 1, primary: 'gw', connections: [{ id: 'gw', label: 'unreachable', kind: 'remote', url: 'http://127.0.0.1:9', authMode: 'token', token: 'x' }] }
    localStorage.setItem('hermes-web.connections.v1', JSON.stringify(store))
    return true
  })()
`,
)
await evalIn(sessionId, `location.reload(); true`)
await waitFor(sessionId, '!!window.hermesDesktop', 60000, 'reload')

// 等 boot-failure overlay（z-(--z-setup)）
const overlay = await waitFor(
  sessionId,
  `(() => {
  const el = [...document.querySelectorAll('.fixed.inset-0')].find(e => (e.className || '').toString().includes('z-(') && !(e.className || '').toString().includes('onboarding'))
  return el ? el.innerText.slice(0, 300) : null
})()`,
  45000,
  'boot-failure overlay',
)
console.log('overlay text:', JSON.stringify(overlay))
await new Promise((r) => setTimeout(r, 1500))

const btns = await evalIn(
  sessionId,
  `(() => {
  const overlay = [...document.querySelectorAll('.fixed.inset-0')].find(e => (e.className || '').toString().includes('z-(') && !(e.className || '').toString().includes('onboarding'))
  if (!overlay) return null
  const rows = [...overlay.querySelectorAll('.flex.flex-wrap.gap-2')]
  return {
    rowCount: rows.length,
    btns: rows.flatMap(row => [...row.querySelectorAll(':scope > button')]).map(b => ({
      text: b.innerText.trim().slice(0, 30),
      variant: b.getAttribute('data-variant'),
      display: getComputedStyle(b).display
    }))
  }
})()`,
)
console.log('recovery row:', JSON.stringify(btns, null, 1))

const bodyHas = await evalIn(
  sessionId,
  `document.body.innerText.includes('Use local gateway')`,
)
console.log('body contains Use local gateway:', bodyHas)

await send('Target.closeTarget', { targetId })
process.exit(0)
