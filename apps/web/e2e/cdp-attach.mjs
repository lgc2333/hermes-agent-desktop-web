#!/usr/bin/env node
/**
 * M8 CDP 验收（ADR-0020）：拖入非图片文件 → chip → 发送 → gateway 落盘。
 *
 * 前置：headless Chrome CDP 9224 + pnpm dev（mock 5180 + proxy 6722 + vite 5173）。
 * 从仓库根运行：node apps/web/e2e/cdp-attach.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CDP =
  'ws://127.0.0.1:9224/devtools/browser/' +
  (await fetch('http://127.0.0.1:9224/json/version').then((r) => r.json()))
    .webSocketDebuggerUrl.split('/').pop()
const APP = 'http://127.0.0.1:5173'
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const ATTACH_DIR = path.join(REPO_ROOT, 'temp', 'mock-attachments')

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
  const res = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId)
  if (res.exceptionDetails)
    throw new Error('eval failed: ' + JSON.stringify(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text))
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

const pass = (name, detail = '') => console.log('  PASS ' + name + (detail ? ' — ' + detail : ''))

// 内嵌页面 JS 骨架（base64 存字面，运行时解码 + 替换占位，避免引号转义海）
const DROP_TMPL = 'KGFzeW5jICgpID0+IHsKICBjb25zdCBieXRlcyA9IFVpbnQ4QXJyYXkuZnJvbShhdG9iKCJfX0I2NF9fIiksIChjKSA9PiBjLmNoYXJDb2RlQXQoMCkpOwogIGNvbnN0IGZpbGUgPSBuZXcgRmlsZShbYnl0ZXNdLCAiX19OQU1FX18iLCB7IHR5cGU6ICJ0ZXh0L3BsYWluIiB9KTsKICBjb25zdCBkdCA9IG5ldyBEYXRhVHJhbnNmZXIoKTsKICBkdC5pdGVtcy5hZGQoZmlsZSk7CiAgY29uc3Qgc3VyZmFjZSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoIltkYXRhLXNsb3Q9XCJjb21wb3Nlci1ib3VuZHNcIl0iKSB8fCBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCJbZGF0YS1jaGF0LXN1cmZhY2VdIik7CiAgaWYgKCFzdXJmYWNlKSByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogIm5vIGRyb3Atem9uZSBlbCIgfTsKICBjb25zdCByZXQgPSB7IHN1cmZhY2VUYWc6IHN1cmZhY2UudGFnTmFtZSwgZGF0YVNsb3Q6IHN1cmZhY2UuZ2V0QXR0cmlidXRlKCJkYXRhLXNsb3QiKSB9OwogIGNvbnN0IGV2ID0gbmV3IERyYWdFdmVudCgiZHJvcCIsIHsgYnViYmxlczogdHJ1ZSwgY2FuY2VsYWJsZTogdHJ1ZSwgZGF0YVRyYW5zZmVyOiBkdCB9KTsKICBzdXJmYWNlLmRpc3BhdGNoRXZlbnQoZXYpOwogIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDgwMCkpOwogIGNvbnN0IHRleHQgPSBkb2N1bWVudC5ib2R5LmlubmVyVGV4dDsKICByZXR1cm4geyBvazogdHJ1ZSwgaGFzRmlsZVRleHQ6IHRleHQuaW5jbHVkZXMoIl9fTkFNRV9fIiksIHRleHRTbmlwcGV0OiB0ZXh0LnNsaWNlKC02MDApLCByZXQ6IHJldCB9Owp9KSgp'
const FOCUS_JS = 'KCgpID0+IHsKICBjb25zdCBlbCA9IFsuLi5kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCJbY29udGVudGVkaXRhYmxlPVwidHJ1ZVwiXSIpXS5maW5kKChlKSA9PiBlLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLndpZHRoID4gNTApOwogIGlmICghZWwpIHJldHVybiBmYWxzZTsKICBlbC5mb2N1cygpOwogIGVsLnRleHRDb250ZW50ID0gIiI7CiAgcmV0dXJuIHRydWU7Cn0pKCk='
const PROBE_JS = 'KGFzeW5jICgpID0+IHsKICB0cnkgewogICAgY29uc3Qgcm9vdCA9IGF3YWl0IG5hdmlnYXRvci5zdG9yYWdlPy5nZXREaXJlY3Rvcnk/LigpOwogICAgcmV0dXJuIHsgb3Bmc0F2YWlsYWJsZTogdHlwZW9mIHJvb3Q/LmdldERpcmVjdG9yeUhhbmRsZSA9PT0gImZ1bmN0aW9uIiB9OwogIH0gY2F0Y2ggewogICAgcmV0dXJuIHsgb3Bmc0F2YWlsYWJsZTogZmFsc2UgfTsKICB9Cn0pKCk='

// ── 启动 + 干净注册表 ─────────────────────────────────────────────────────
console.log('[attach] opening app...')
const { targetId } = await send('Target.createTarget', { url: APP })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Runtime.enable', {}, sessionId)
await send('Page.enable', {}, sessionId)

await waitFor(sessionId, '!!window.hermesDesktop', 60000, 'boot')
await evalIn(sessionId, "window.localStorage.removeItem('hermes-web.connections.v1'); true")
await evalIn(sessionId, 'location.reload(); true')
await waitFor(
  sessionId,
  '!!window.hermesDesktop && document.body.innerText.includes("Gateway") && document.body.innerText.includes("ready")',
  60000,
  'reload+ready',
)
// 等 composer 输入框可见（session 建好后 chat-bar enable，dropHandler 绑定）
await waitFor(
  sessionId,
  '[...document.querySelectorAll("[contenteditable] ")].length > 0 || document.body.innerText.includes("Type a task")',
  40000,
  'composer ready',
)
await new Promise((r) => setTimeout(r, 2500))
pass('app booted + composer ready')

// ── 拖入非图片文件（合成 drop，走 attachDroppedItems 非图片分支）──────────
console.log('[attach] dispatching non-image file drop...')
const name = 'quarterly-report.txt'
const bytes = Buffer.from('M8 attachment payload: hello from cdp-attach 1234567890')
const payloadB64 = bytes.toString('base64')

const dropExpr = atob(DROP_TMPL).replace('__B64__', payloadB64).replace('__NAME__', name)
const dropResult = await evalIn(sessionId, dropExpr)
console.log('  drop result:', JSON.stringify(dropResult))
if (!dropResult?.ok) {
  throw new Error('drop dispatch failed: ' + JSON.stringify(dropResult))
}
// chip 应已加入 composer：轮询等到文件名（虚拟路径嵌真实文件名）出现在 DOM
await waitFor(
  sessionId,
  'document.body.innerText.includes("' + name + '") || document.body.innerText.includes("web-blob://attach/")',
  15000,
  'attachment chip visible',
)
pass('non-image file attached (chip visible)')

// ── 发送消息 ──────────────────────────────────────────────────────────────
console.log('[attach] sending message...')
await evalIn(sessionId, atob(FOCUS_JS))
await send('Input.insertText', { text: 'here is my report file' }, sessionId)
await new Promise((r) => setTimeout(r, 300))
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId)
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId)
const replied = await waitFor(sessionId, 'document.body.innerText.includes("Hello from the mock gateway")', 30000, 'streamed reply')
pass('message sent + streamed reply', String(replied))

// ── 验证 gateway 落盘（temp/mock-attachments/）────────────────────────────
console.log('[attach] verifying mock gateway landed the file...')
let landed = null
const deadline = Date.now() + 10000
while (Date.now() < deadline) {
  if (fs.existsSync(ATTACH_DIR)) {
    const files = fs.readdirSync(ATTACH_DIR).filter((f) => f.endsWith('-quarterly-report.txt'))
    if (files.length > 0) { landed = files; break }
  }
  await new Promise((r) => setTimeout(r, 500))
}
if (!landed) throw new Error('mock gateway did not land the attachment at ' + ATTACH_DIR)
const landedPath = path.join(ATTACH_DIR, landed[0])
const landedBytes = fs.readFileSync(landedPath)
if (!landedBytes.equals(bytes)) throw new Error('landed bytes mismatch')
pass('gateway attachments/ landed', landed[0] + ' (' + landedBytes.length + ' bytes)')

// ── OPFS 探测（参考信息）───────────────────────────────────────────────
console.log('  OPFS probe:', JSON.stringify(await evalIn(sessionId, atob(PROBE_JS))))

console.log('\n[M8-attach] ALL PASS')
await send('Target.closeTarget', { targetId })
process.exit(0)