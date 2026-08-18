import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Browser, Page } from 'playwright'
import { launchBrowser } from './helpers/browser'
import {
  APP_URL,
  PROXY_URL,
  MOCK_TOKEN_PORT,
  MOCK_OAUTH_PORT,
  startMock,
  stopByPort,
  waitForHttp,
} from './helpers/topology'
import {
  waitForReady,
  waitFor,
  poll,
  gotoHash,
  saveOauthConnection,
  getConfig,
  oauthLogout,
} from './helpers/bridge'
import { clearRegistry } from './helpers/registry'

// From cdp-oauth-paste.mjs (ADR-0017) — paste-back login for remote browsers.
// A Node-side "remote browser" captures the loopback callback URL and we paste
// it into the settings connect view's textarea to complete the exchange.
const TARGET = `http://127.0.0.1:${MOCK_OAUTH_PORT}`
let callbackUrl = ''

describe('oauth-paste: paste-back login completes an oauth session', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    // Token mock on the default-seed port so a fresh-boot probe succeeds;
    // gated OAuth mock is the paste target.
    startMock(MOCK_TOKEN_PORT)
    startMock(MOCK_OAUTH_PORT, { oauth: true })
    await waitForHttp(`${TARGET}/api/status`)
    const launched = await launchBrowser()
    browser = launched.browser
    page = launched.page
    await page.goto(APP_URL)
    await waitForReady(page)
    // Clear registry WITHOUT reload — still in the boot cycle, so save() lands
    // the app in the OAuth connect/re-auth state for this target.
    await clearRegistry(page)
    const saved = await saveOauthConnection(page, TARGET)
    expect(saved.authMode).toBe('oauth')
    expect(saved.url).toBe(TARGET)
  })

  afterAll(async () => {
    await browser?.close()
    stopByPort(MOCK_TOKEN_PORT)
    stopByPort(MOCK_OAUTH_PORT)
  })

  it('captures the loopback callback URL from the authorize 302', async () => {
    const start = await fetch(`${PROXY_URL}/auth/native/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: TARGET }),
    })
    expect(start.ok).toBe(true)
    const { authorizeUrl } = (await start.json()) as { authorizeUrl: string }
    // ADR-0023：start 下发 pending cookie（进行中登录在 cookie，不在代理
    // 内存）。本测试的 start 是 Node 侧 fetch——把 pending cookie 注入
    // 浏览器 context，页面后续 paste 请求才能通过 CSRF 校验。
    const pendingSetCookie = start.headers.get('set-cookie') ?? ''
    const pendingMatch = pendingSetCookie.match(/hermes_oauth_pending=([^;]+)/)
    expect(pendingMatch).toBeTruthy()
    const proxyUrl = new URL(PROXY_URL)
    await page.context().addCookies([
      {
        name: 'hermes_oauth_pending',
        value: pendingMatch![1] ?? '',
        domain: proxyUrl.hostname,
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ])
    const hop = await fetch(authorizeUrl, { redirect: 'manual' })
    expect(hop.status).toBe(302)
    callbackUrl = hop.headers.get('location') ?? ''
    expect(callbackUrl.startsWith('http://127.0.0.1:')).toBe(true)
    expect(callbackUrl).toContain('/auth/native/callback?code=')
  })

  it('renders the paste-back textarea in settings', async () => {
    await gotoHash(page, '#/settings?tab=gateway')
    const placeholder = await waitFor(
      page,
      () => {
        const t = [...document.querySelectorAll('textarea')].find(
          (x) =>
            /callback/i.test(x.placeholder ?? '') || /回调/i.test(x.placeholder ?? ''),
        )
        return t ? t.placeholder : null
      },
      { timeout: 30000, label: 'paste textarea' },
    )
    expect(placeholder).toBeTruthy()
  })

  it('pastes the callback URL, submits, and connects', async () => {
    expect(callbackUrl).toBeTruthy()
    // React controlled textarea — use the native setter + input event.
    await page.evaluate((value) => {
      const ta = [...document.querySelectorAll('textarea')].find(
        (x) =>
          /callback/i.test(x.placeholder ?? '') || /回调/i.test(x.placeholder ?? ''),
      ) as HTMLTextAreaElement
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set
      setter?.call(ta, value)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    }, callbackUrl)
    await page.waitForTimeout(400)
    const clicked = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) =>
        /complete sign.?in|完成登录/i.test(x.textContent ?? ''),
      )
      if (!b) return false
      b.click()
      return true
    })
    expect(clicked).toBe(true)
    const connected = await poll(
      () => getConfig(page).then((c) => c.remoteOauthConnected === true),
      {
        timeout: 15000,
        label: 'oauth connected after paste',
      },
    )
    expect(connected).toBe(true)
  })

  it('keeps the paste session after refresh, then logs out', async () => {
    await page.reload()
    await waitForReady(page, 60000)
    const config = await getConfig(page)
    expect(config.remoteOauthConnected).toBe(true)

    await oauthLogout(page, TARGET)
    const after = await getConfig(page)
    expect(after.remoteOauthConnected).toBe(false)
  })
})
