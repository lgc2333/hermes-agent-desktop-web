import type { Page } from 'playwright'
import { clearRegistry } from './registry'

/** window.hermesDesktop — the WebCapabilityAdapter surface installed at boot. */
export interface HermesDesktop {
  saveConnectionConfig(cfg: unknown): Promise<Record<string, unknown>>
  getConnectionConfig(): Promise<Record<string, unknown>>
  getConnection(): Promise<{ wsUrl: string }>
  oauthLoginConnectionConfig(url: string): Promise<Record<string, unknown>>
  oauthLogoutConnectionConfig(url: string): Promise<Record<string, unknown>>
}

declare global {
  interface Window {
    hermesDesktop?: HermesDesktop
  }
}

/** Poll page.evaluate(fn) until it returns truthy; resolve with that value. */
export async function waitFor<T>(
  page: Page,
  fn: () => T | Promise<T>,
  opts: { timeout?: number; label?: string } = {},
): Promise<T> {
  const { timeout = 40000, label = String(fn).slice(0, 60) } = opts
  const deadline = Date.now() + timeout
  let last: unknown
  while (Date.now() < deadline) {
    last = await page.evaluate(fn)
    if (last) return last as T
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`waitFor timeout: ${label} (last=${JSON.stringify(last)})`)
}

export async function waitForReady(page: Page, timeout = 60000): Promise<void> {
  await waitFor(
    page,
    () => !!window.hermesDesktop && !!document.querySelector('#root *'),
    { timeout, label: 'app boot' },
  )
  await page.waitForTimeout(3000)
}

/** Wait until a plain substring appears anywhere in the body text. */
export async function waitForBodyText(
  page: Page,
  text: string,
  opts: { timeout?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeout ?? 30000)
  while (Date.now() < deadline) {
    const found = await page.evaluate((t) => document.body.innerText.includes(t), text)
    if (found) return
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`waitForBodyText timeout: ${opts.label ?? text}`)
}

/** Poll an async (Node-side) fn until it returns truthy. Use for checks that
 *  cannot be expressed as a serializable page expression (e.g. `getConfig`). */
export async function poll<T>(
  fn: () => Promise<T>,
  opts: { timeout?: number; label?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeout ?? 40000)
  let last: unknown
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last as T
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`poll timeout: ${opts.label} (last=${JSON.stringify(last)})`)
}

/** Navigate via the app's HashRouter (pushState does not work — see AGENTS). */
export async function gotoHash(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    location.hash = h
  }, hash)
  await page.waitForTimeout(2500)
}

/** Clear the registry, reload, and wait for a clean boot. */
export async function bootClean(page: Page, timeout = 60000): Promise<void> {
  await clearRegistry(page)
  await page.reload()
  await waitForReady(page, timeout)
}

export const saveOauthConnection = (page: Page, target: string) =>
  page.evaluate(
    (t) =>
      window
        .hermesDesktop!.saveConnectionConfig({
          mode: 'remote',
          remoteAuthMode: 'oauth',
          remoteUrl: t,
        })
        .then((c) => ({ authMode: c.remoteAuthMode, url: c.remoteUrl })),
    target,
  )

export const oauthLogin = (page: Page, target: string) =>
  page.evaluate((t) => window.hermesDesktop!.oauthLoginConnectionConfig(t), target)

export const oauthLogout = (page: Page, target: string) =>
  page.evaluate((t) => window.hermesDesktop!.oauthLogoutConnectionConfig(t), target)

export const getConfig = (page: Page) =>
  page.evaluate(() => window.hermesDesktop!.getConnectionConfig().then((c) => c))

/** Run a chat round-trip over the connection's WebSocket (JSON-RPC), waiting
 *  for a streaming event (e.g. `message.complete`) to arrive. */
export async function wsJsonRpc(
  page: Page,
  opts: { waitEvent?: string; text?: string; timeout?: number } = {},
): Promise<Record<string, unknown>> {
  const { waitEvent, text, timeout = 20000 } = opts
  return page.evaluate(
    async ({ waitEvent, text, timeout }) => {
      const conn = await window.hermesDesktop!.getConnection()
      const ws = new WebSocket(conn.wsUrl)
      const out: Record<string, unknown> = { opened: false, replies: [] }
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('ws open timeout')), 8000)
        ws.onopen = () => {
          out.opened = true
          clearTimeout(t)
          resolve(null)
        }
        ws.onerror = () => {
          clearTimeout(t)
          reject(new Error('ws error'))
        }
      })
      let id = 1
      const pending = new Map<
        number,
        { resolve: (v: unknown) => void; reject: (e: Error) => void }
      >()
      const reply = (m: string, p: unknown) =>
        new Promise((resolve, reject) => {
          const myId = id++
          pending.set(myId, { resolve, reject })
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: myId, method: m, params: p }))
        })
      ws.onmessage = (ev) => {
        const frame = JSON.parse(String(ev.data))
        if (frame.id && pending.has(frame.id)) {
          const p = pending.get(frame.id)!
          pending.delete(frame.id)
          frame.error
            ? p.reject(new Error(JSON.stringify(frame.error)))
            : p.resolve(frame.result)
        } else if (frame.method === 'event') {
          const { type, payload } = frame.params
          if (type === 'message.delta') (out.replies as string[]).push(payload.text)
          if (type === 'message.complete') out.complete = payload.text
        }
      }
      const created = await reply('session.create', { source: 'desktop' })
      out.sessionId = (created as { session_id: string }).session_id
      await reply('prompt.submit', {
        session_id: out.sessionId,
        text: text ?? 'hello',
      })
      const deadline = Date.now() + timeout
      while (waitEvent && !out[waitEvent] && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200))
      }
      ws.close()
      return out
    },
    { waitEvent, text, timeout },
  )
}
