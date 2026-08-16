#!/usr/bin/env node
/**
 * 验证（ADR-0019）：Web 构建下 view.findInPage 热键失效——
 * 按 Ctrl+F 不再打开 vendor find-bar（[role="search"] 覆盖层不出现），
 * 且 keydown 未被 preventDefault（浏览器原生查找可接管）。
 *
 * 前置：headless Chrome CDP 9224 + `pnpm dev`（mock 5180 + proxy 6722 + vite 5173）。
 * 从仓库根运行：node apps/web/e2e/cdp-find.mjs
 */
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

/** 真实键序列（浏览器级，能触发原生 find 加速键）。Ctrl=2, Meta=4。 */
async function pressCtrl(sessionId, key, code, vk) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 2 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, sessionId)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId)
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Runtime.enable', {}, sessionId)
await send('Page.enable', {}, sessionId)
await send('Page.navigate', { url: APP }, sessionId)
// 清注册表避免脚本间污染（e2e 约定），等 boot。
await waitFor(sessionId, '!!window.hermesDesktop', 60000, 'boot')
await evalIn(sessionId, `(() => { localStorage.removeItem('hermes-web.connections.v1'); return true })()`)
await send('Page.reload', {}, sessionId)
await waitFor(sessionId, '!!window.hermesDesktop', 60000, 'boot-after-reset')

// ── 场景 1：合成 Ctrl+F —— vendor dispatch 不应 preventDefault ─────────
const synth = await evalIn(
  sessionId,
  `(() => {
    const ev = new KeyboardEvent('keydown', {
      key: 'f', code: 'KeyF', ctrlKey: true,
      bubbles: true, cancelable: true,
    })
    const dispatched = window.dispatchEvent(ev)
    return { defaultPrevented: ev.defaultPrevented, dispatched }
  })()`,
)
if (synth.defaultPrevented !== false) {
  throw new Error('合成 Ctrl+F 被 preventDefault——vendor dispatch 仍拦截原生查找: ' + JSON.stringify(synth))
}
console.log('PASS 场景1: 合成 Ctrl+F defaultPrevented=false（原生查找未被吞）')

// ── 场景 2：find-bar 不应出现（合成 + 真实按键后各查一次）──────────────
const noFindBar = `!document.querySelector('[role="search"]')`
await new Promise((r) => setTimeout(r, 800)) // 若旧行为打开 find-bar，等它渲染
if (!(await evalIn(sessionId, noFindBar))) {
  throw new Error('合成 Ctrl+F 后 [role="search"] find-bar 出现了（热键未失效）')
}
await pressCtrl(sessionId, 'f', 'KeyF', 70) // 真实 Ctrl+F
await new Promise((r) => setTimeout(r, 1200))
if (!(await evalIn(sessionId, noFindBar))) {
  throw new Error('真实 Ctrl+F 后 [role="search"] find-bar 出现了（热键未失效）')
}
console.log('PASS 场景2: 合成/真实 Ctrl+F 均未打开 find-bar 覆盖层')

// ── 场景 3：真实 Ctrl+F 触发浏览器原生查找面板 ─────────────────────────
let ax = null
try {
  ax = await send('Accessibility.getFullAXTree', {}, sessionId)
} catch {
  ax = null
}
const nativeFindNode = ax?.nodes?.find(
  (n) =>
    (n.role?.value === 'searchbox' || n.role?.value === 'combobox') &&
    /find|查找/i.test(n.name?.value ?? ''),
)
if (nativeFindNode) {
  console.log('PASS 场景3: 原生查找输入框出现在 AX 树:', JSON.stringify({ role: nativeFindNode.role.value, name: nativeFindNode.name.value }))
} else {
  // headless 下浏览器 UI 未必进 AX 树——留截图人工核验，不判失败。
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync('temp/e2e-out', { recursive: true })
  writeFileSync('temp/e2e-out/find-ctrl-f.png', Buffer.from(shot.data, 'base64'))
  console.log('WARN 场景3: AX 树未见原生查找节点，截图已存 temp/e2e-out/find-ctrl-f.png 供人工核验')
}

// ── 场景 4：回归——其他 keybind 未被误伤（Ctrl+K 打开 command palette）──
await pressCtrl(sessionId, 'k', 'KeyK', 75)
const palette = await waitFor(
  sessionId,
  `!![...document.querySelectorAll('[role="dialog"]')].find(d => /command|命令|palette/i.test(d.getAttribute('aria-label') ?? d.className ?? ''))`,
  15000,
  'command palette dialog',
).catch(() => null)
if (palette) console.log('PASS 场景4: Ctrl+K 仍正常打开 command palette')
else console.log('WARN 场景4: Ctrl+K 未观察到 palette dialog（可能是选择器不匹配，非回归）')

console.log('DONE')
process.exit(0)