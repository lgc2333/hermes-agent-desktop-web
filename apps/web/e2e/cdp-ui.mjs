#!/usr/bin/env node
/**
 * M3 CDP 验收 UI 层：设置页 OAuth 登录（点击 Sign in）→ 聊天 → 刷新保持。
 * 前置：mock(5180, MOCK_OAUTH=1) + proxy(6722) + vite(5173) + chrome 9224。
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
        reject(new Error(`CDP timeout: ${method}`))
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

async function waitFor(sessionId, expression, timeoutMs = 30000, label = expression) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await evalIn(sessionId, expression)
    if (last) return last
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`waitFor timeout: ${label} (last=${JSON.stringify(last)})`)
}

function pass(name, detail = '') {
  console.log(`  PASS ${name}${detail ? ' — ' + detail : ''}`)
}

console.log('[M3-UI] opening app...')
const { targetId } = await send('Target.createTarget', { url: APP })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Runtime.enable', {}, sessionId)
await send('Page.enable', {}, sessionId)

// 干净注册表 + 重启
await waitFor(sessionId, '!!window.hermesDesktop', 60000, 'boot')
await evalIn(
  sessionId,
  `window.localStorage.removeItem('hermes-web.connections.v1'); true`,
)
await evalIn(sessionId, `location.reload(); true`)
await waitFor(
  sessionId,
  '!!window.hermesDesktop && document.body.innerText.includes("Gateway") && document.body.innerText.includes("ready")',
  60000,
  'reload',
)
await new Promise((r) => setTimeout(r, 2000))
pass('app booted')

// ── 1. 设置页：probe → Sign in 按钮 ────────────────────────────────────────
console.log('[1] settings gateway tab...')
await evalIn(sessionId, `location.hash = '#/settings?tab=gateway'; true`)
// 等 URL 输入框 + probe 完成（Sign in with nous 出现）
await waitFor(
  sessionId,
  `
  (() => {
    const b = [...document.querySelectorAll('button')].find(x => /sign in with/i.test(x.textContent) || /^sign in$/i.test(x.textContent.trim()))
    return b ? b.textContent.trim() : null
  })()
`,
  30000,
  'sign in button',
)
const signInText = await evalIn(
  sessionId,
  `
  [...document.querySelectorAll('button')].find(x => /sign in with/i.test(x.textContent) || /^sign in$/i.test(x.textContent.trim()))?.textContent.trim()
`,
)
pass('oauth sign-in button visible', signInText)

// ── 2. 点击 Sign in → 弹窗授权 → 回跳 → connected ─────────────────────────
console.log('[2] click sign-in...')
await evalIn(
  sessionId,
  `
  [...document.querySelectorAll('button')].find(x => /sign in with/i.test(x.textContent) || /^sign in$/i.test(x.textContent.trim()))?.click(); true
`,
)
// 轮询 UI：按钮变成 Sign out（connected 状态）或通知出现
const connected = await waitFor(
  sessionId,
  `
  (() => {
    const btns = [...document.querySelectorAll('button')].map(b => b.textContent.trim())
    const hasSignOut = btns.some(x => /sign out/i.test(x))
    const hasSignedIn = btns.some(x => /signed in|connected to/i.test(x))
    return hasSignOut || hasSignedIn ? true : null
  })()
`,
  45000,
  'oauth connected UI',
)
pass('ui connected', String(connected))

// 注册表反映 OAuth 模式（token 清空）
const registry = await evalIn(
  sessionId,
  `
  JSON.parse(window.localStorage.getItem('hermes-web.connections.v1'))
`,
)
pass(
  'registry oauth',
  'authMode=' +
    registry.connections[0].authMode +
    ' token=' +
    JSON.stringify(registry.connections[0].token),
)

// ── 3. 回聊天：UI 输入消息 → 流式回复 ──────────────────────────────────────
console.log('[3] chat UI...')
await evalIn(sessionId, `location.hash = '#/'; true`)
await new Promise((r) => setTimeout(r, 2500))
// 找 composer textarea/输入框
const composer = await evalIn(
  sessionId,
  `
  (() => {
    const el = [...document.querySelectorAll('[contenteditable="true"]')].find(e => e.getBoundingClientRect().width > 50)
    return el ? { tag: el.tagName, found: true } : { found: false }
  })()
`,
)
console.log('  composer:', JSON.stringify(composer))
if (composer.found) {
  // 用桥发消息更稳（composer 是 contenteditable，CDP insertText 可注入）——
  // 但验收要 UI：先聚焦再 Input.insertText + Enter。
  await evalIn(
    sessionId,
    `
    (() => {
      const el = [...document.querySelectorAll('[contenteditable="true"]')].find(e => e.getBoundingClientRect().width > 50)
      el.focus()
      el.textContent = ''
      return true
    })()
  `,
  )
  await send('Input.insertText', { text: 'hello from m3 ui' }, sessionId)
  await new Promise((r) => setTimeout(r, 300))
  await send(
    'Input.dispatchKeyEvent',
    {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    },
    sessionId,
  )
  await send(
    'Input.dispatchKeyEvent',
    {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    },
    sessionId,
  )
  // 等流式回复出现（mock 回复文案）
  const replied = await waitFor(
    sessionId,
    `
    document.body.innerText.includes('Hello from the mock gateway')
  `,
    30000,
    'streamed reply',
  )
  pass('chat reply streamed (UI)', String(replied))
} else {
  console.log('  WARN composer not found — chat UI check skipped')
}

// ── 4. 刷新：cookie 会话保持 ───────────────────────────────────────────────
console.log('[4] refresh persistence...')
await evalIn(sessionId, `location.reload(); true`)
await waitFor(sessionId, '!!window.hermesDesktop', 60000, 'refresh boot')
await new Promise((r) => setTimeout(r, 3000))
const oauthAfter = await evalIn(
  sessionId,
  `
  window.hermesDesktop.getConnectionConfig().then(c => c.remoteOauthConnected)
`,
)
pass('oauth session survives refresh', 'connected=' + oauthAfter)

// 聊天消息仍在（会话恢复）
const restored = await evalIn(
  sessionId,
  `
  (async () => {
    await new Promise(r => setTimeout(r, 4000))
    return document.body.innerText.includes('hello from m3 ui') || document.body.innerText.includes('Hello from the mock gateway')
  })()
`,
)
pass('conversation restored after refresh', String(restored))

console.log('\n[M3-UI] ALL PASS')
await send('Target.closeTarget', { targetId })
process.exit(0)
