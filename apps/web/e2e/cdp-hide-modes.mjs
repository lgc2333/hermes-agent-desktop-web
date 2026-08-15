#!/usr/bin/env node
/** 验证：设置页 Connection mode 只显示 remote；boot-failure overlay 无 Use local gateway。 */
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
await waitFor(sessionId, '!!window.hermesDesktop', 60000, 'boot')
await new Promise(r => setTimeout(r, 4000))

// 设置页 gateway tab
await evalIn(sessionId, `location.hash = '#/settings?tab=gateway'; true`)
await new Promise(r => setTimeout(r, 3000))

const modeCards = await evalIn(sessionId, `(() => {
  const cards = [...document.querySelectorAll('.grid.auto-rows-fr.grid-cols-1 > button')]
  return cards.map(b => ({
    text: b.innerText.split(String.fromCharCode(10))[0].trim(),
    display: getComputedStyle(b).display,
    rect: (() => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })()
  }))
})()`)
console.log('mode cards:', JSON.stringify(modeCards, null, 1))

// boot-failure overlay：当前无 gateway → boot 失败应有 recovery 按钮行
const recovery = await evalIn(sessionId, `(() => {
  const row = document.querySelector('.z-\(--z-setup\) .flex.flex-wrap.gap-2')
  if (!row) return { found: false }
  const btns = [...row.querySelectorAll(':scope > button')].map(b => ({
    text: b.innerText.trim().slice(0, 30),
    variant: b.getAttribute('data-variant'),
    display: getComputedStyle(b).display
  }))
  return { found: true, btns }
})()`)
console.log('recovery row:', JSON.stringify(recovery, null, 1))

// 页面整体文本里不应再出现 'Use local gateway'（按钮被隐藏）
const bodyText = await evalIn(sessionId, `document.body.innerText.includes('Use local gateway')`)
console.log('body has Use local gateway text:', bodyText)

await send('Target.closeTarget', { targetId })
process.exit(0)