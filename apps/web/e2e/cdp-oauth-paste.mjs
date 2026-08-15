#!/usr/bin/env node
/**
 * M6 CDP 验收（headless Chrome 9224）— OAuth paste-back 登录（ADR-0017）。
 *
 * 场景（mock gateway :5180 → 代理 :6722 → vite :5173）：
 *   1. Node 侧模拟"远端浏览器"：start → 跟随 authorize 302，捕获地址栏
 *      会出现的那条 loopback 回调 URL（?code=..&state=..，本机连接失败是预期）
 *   2. UI 层：设置页渲染 paste-back 提示（Textarea + 提交按钮）
 *   3. 把回调 URL 粘贴进 Textarea → 提交 → 代理完成交换 → 会话 connected
 *   4. 刷新保持 + 登出
 *
 * 拓扑同 cdp-oauth.mjs（mock native 面不受 MOCK_OAUTH 门控）。
 * Usage: node apps/web/e2e/cdp-oauth-paste.mjs
 */

const CDP =
  'ws://127.0.0.1:9224/devtools/browser/' +
  (
    await fetch('http://127.0.0.1:9224/json/version').then((r) => r.json())
  ).webSocketDebuggerUrl
    .split('/')
    .pop()
const APP = 'http://127.0.0.1:5173'
const PROXY = 'http://127.0.0.1:6722'
// gated mock（MOCK_OAUTH=1，auth_required=true → probe 归 oauth 分支）。
const TARGET = 'http://127.0.0.1:5182'

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
    {
      expression,
      awaitPromise,
      returnByValue: true,
    },
    sessionId,
  )
  if (res.exceptionDetails) {
    throw new Error(
      'eval failed: ' +
        JSON.stringify(
          res.exceptionDetails.exception?.description ?? res.exceptionDetails.text,
        ),
    )
  }
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

console.log('[M6] opening app...')
const { targetId } = await send('Target.createTarget', { url: APP })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Runtime.enable', {}, sessionId)
await send('Page.enable', {}, sessionId)

await waitFor(
  sessionId,
  '!!window.hermesDesktop && !!document.querySelector("#root *")',
  60000,
  'app boot',
)
await new Promise((r) => setTimeout(r, 3000))
pass('app booted, bridge installed')

// 清注册表后不 reload：boot 仍在初始周期内，save 才会触发重跑并进入 reauth。
await evalIn(sessionId, `window.localStorage.removeItem('hermes-web.connections.v1'); true`)

const saved = await evalIn(
  sessionId,
  `window.hermesDesktop.saveConnectionConfig({
    mode: 'remote',
    remoteAuthMode: 'oauth',
    remoteUrl: '${TARGET}',
  }).then(c => ({ authMode: c.remoteAuthMode, url: c.remoteUrl }))`,
)
pass('save oauth connection', JSON.stringify(saved))

// ── 模拟"远端浏览器"：start → 捕获 loopback 回调 URL（不落地）──────
console.log('[1] capture loopback callback URL (remote topology)...')
const start = await fetch(`${PROXY}/auth/native/start`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ target: TARGET }),
})
if (!start.ok) throw new Error('start failed: ' + start.status)
const { authorizeUrl } = await start.json()
const hop = await fetch(authorizeUrl, { redirect: 'manual' })
if (hop.status !== 302) throw new Error('authorize did not 302: ' + hop.status)
const callbackUrl = hop.headers.get('location') ?? ''
if (!callbackUrl.startsWith('http://127.0.0.1:') || !callbackUrl.includes('/auth/native/callback?code=')) {
  throw new Error('unexpected callback URL: ' + callbackUrl)
}
pass('loopback callback URL captured', callbackUrl.slice(0, 80) + '…')

// ── UI 层：设置页 paste-back 提示 + 粘贴 + 提交 ──────────────────────
console.log('[2] boot overlay reauth to embedded settings...')
// M6：OAuth reauth 也路由到嵌入式 connect 视图（paste 提示只此一处）。
const overlay = await waitFor(
  sessionId,
  `(() => {
    const b = [...document.querySelectorAll('button')].find(x => /sign out.?.*sign in|重新登录|退出并登录/i.test(x.textContent))
    return b ? { text: b.textContent.trim() } : null
  })()`,
  30000,
  'reauth overlay sign-in button',
)
pass('reauth overlay visible', JSON.stringify(overlay))
await evalIn(
  sessionId,
  `(() => {
    const b = [...document.querySelectorAll('button')].find(x => /sign out.?.*sign in|重新登录|退出并登录/i.test(x.textContent))
    if (b) b.click()
    return !!b
  })()`,
)
await new Promise((r) => setTimeout(r, 2500))
const hint = await waitFor(
  sessionId,
  `(() => {
    const ta = [...document.querySelectorAll('textarea')].find(x =>
      /callback/i.test(x.placeholder || '') ||
      /回调/i.test(x.placeholder || '')
    )
    return ta ? { placeholder: ta.placeholder } : null
  })()`,
  30000,
  'paste textarea',
)
pass('paste textarea rendered', JSON.stringify(hint))
if (!hint) throw new Error('paste-back UI not rendered')

// React 受控组件：用原生 setter + input 事件写入粘贴内容。
await evalIn(
  sessionId,
  `(() => {
    const ta = [...document.querySelectorAll('textarea')].find(x =>
      /callback/i.test(x.placeholder || '') ||
      /回调/i.test(x.placeholder || '')
    )
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, ${JSON.stringify('__CALLBACK__')})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`.replace('__CALLBACK__', callbackUrl),
)
await new Promise((r) => setTimeout(r, 400))
const clicked = await evalIn(
  sessionId,
  `(() => {
    const b = [...document.querySelectorAll('button')].find(x =>
      /complete sign.?in|完成登录/i.test(x.textContent)
    )
    if (!b) return false
    b.click()
    return true
  })()`,
)
pass('paste submitted', 'clicked=' + clicked)
if (!clicked) throw new Error('paste submit button not found')

// ── 会话生效 ─────────────────────────────────────────────────────────
console.log('[3] session connected...')
const connected = await waitFor(
  sessionId,
  'window.hermesDesktop.getConnectionConfig().then(c => c.remoteOauthConnected)',
  15000,
  'oauth connected after paste',
)
pass('oauth session connected via paste', 'connected=' + connected)
const config = await evalIn(
  sessionId,
  'window.hermesDesktop.getConnectionConfig().then(c => ({ preview: c.remoteTokenPreview, tokenSet: c.remoteTokenSet }))',
)
pass('config oauth connected', JSON.stringify(config))

console.log('[4] refresh persistence...')
await evalIn(sessionId, 'location.reload(); true')
await waitFor(sessionId, '!!window.hermesDesktop', 60000, 'refresh boot')
await new Promise((r) => setTimeout(r, 3000))
const after = await evalIn(
  sessionId,
  'window.hermesDesktop.getConnectionConfig().then(c => c.remoteOauthConnected)',
)
pass('paste session survives refresh', 'connected=' + after)

console.log('[5] logout...')
const logout = await evalIn(
  sessionId,
  `window.hermesDesktop.oauthLogoutConnectionConfig('${TARGET}')`,
)
pass('oauth logout', JSON.stringify(logout))
const afterLogout = await evalIn(
  sessionId,
  'window.hermesDesktop.getConnectionConfig().then(c => c.remoteOauthConnected)',
)
pass('disconnected after logout', 'connected=' + afterLogout)

console.log('\n[M6] ALL PASS')
await send('Target.closeTarget', { targetId })
process.exit(0)