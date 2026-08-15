#!/usr/bin/env node
/** 验证 dev:remote：vite 页面经 proxy，无 mock → boot 失败恢复面 → 设置页可用。 */
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

await evalIn(
  sessionId,
  `window.localStorage.removeItem('hermes-web.connections.v1'); true`,
)
await evalIn(sessionId, `location.reload(); true`)
await waitFor(sessionId, '!!window.hermesDesktop', 60000, 'reload')

const overlay = await waitFor(
  sessionId,
  `(() => {
  const el = [...document.querySelectorAll('.fixed.inset-0')].find(e => (e.className || '').toString().includes('z-(') && !(e.className || '').toString().includes('onboarding'))
  return el ? el.innerText.slice(0, 200) : null
})()`,
  45000,
  'boot-failure overlay',
)
console.log('overlay:', JSON.stringify(overlay))

await evalIn(sessionId, `location.hash = '#/settings?tab=gateway'; true`)
await new Promise((r) => setTimeout(r, 2500))
const settings = await evalIn(
  sessionId,
  `(() => {
  const txt = document.body.innerText
  return {
    hasRemoteMode: txt.includes('Remote gateway'),
    hasLocalMode: txt.includes('Local gateway'),
    hasCloudMode: txt.includes('Hermes Cloud')
  }
})()`,
)
console.log('settings:', JSON.stringify(settings))

const meta = await fetch('http://127.0.0.1:6722/api/proxy/meta')
console.log('proxy meta status:', meta.status)

await send('Target.closeTarget', { targetId })
process.exit(0)
