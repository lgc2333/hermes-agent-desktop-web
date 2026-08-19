import { test, expect } from './fixtures'
import { startMock, stopByPort, waitForHttp } from './helpers/topology'
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
// A "remote browser" (Node-side fetch) captures the loopback callback URL and
// we paste it into the settings connect view's textarea to complete the exchange.
test.describe('oauth-paste: paste-back login completes an oauth session', () => {
  test('paste-back login completes an oauth session', async ({ page, stack }) => {
    const target = stack.oauthTarget
    const proxyUrl = `http://127.0.0.1:${stack.proxyPort}`
    let callbackUrl = ''

    // Token mock on the default-seed port so a fresh-boot probe succeeds;
    // gated OAuth mock is the paste target.
    startMock(stack.tokenPort)
    startMock(stack.oauthPort, { oauth: true })
    await waitForHttp(`${target}/api/status`)

    await page.goto(stack.appUrl)
    await waitForReady(page)
    // Clear registry WITHOUT reload — still in the boot cycle, so save() lands
    // the app in the OAuth connect/re-auth state for this target.
    await clearRegistry(page)
    const saved = await saveOauthConnection(page, target)
    expect(saved.authMode).toBe('oauth')
    expect(saved.url).toBe(target)

    await test.step('captures the loopback callback URL from the authorize 302', async () => {
      const start = await fetch(`${proxyUrl}/auth/native/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target }),
      })
      expect(start.ok).toBe(true)
      const { authorizeUrl } = (await start.json()) as { authorizeUrl: string }
      // ADR-0023：start 下发 pending cookie（进行中登录在 cookie，不在代理
      // 内存）。本测试的 start 是 Node 侧 fetch——把 pending cookie 注入
      // 浏览器 context，页面后续 paste 请求才能通过 CSRF 校验。
      const pendingSetCookie = start.headers.get('set-cookie') ?? ''
      const pendingMatch = pendingSetCookie.match(/hermes_oauth_pending=([^;]+)/)
      expect(pendingMatch).toBeTruthy()
      const proxyHostname = new URL(proxyUrl).hostname
      await page.context().addCookies([
        {
          name: 'hermes_oauth_pending',
          value: pendingMatch![1] ?? '',
          domain: proxyHostname,
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

    await test.step('renders the paste-back textarea in settings', async () => {
      await gotoHash(page, '#/settings?tab=gateway')
      const placeholder = await waitFor(
        page,
        () => {
          const t = [...document.querySelectorAll('textarea')].find(
            (x) =>
              /callback/i.test(x.placeholder ?? '') || /回调/.test(x.placeholder ?? ''),
          )
          return t ? t.placeholder : null
        },
        { timeout: 30000, label: 'paste textarea' },
      )
      expect(placeholder).toBeTruthy()
    })

    await test.step('pastes the callback URL, submits, and connects', async () => {
      expect(callbackUrl).toBeTruthy()
      // React controlled textarea — use the native setter + input event.
      await page.evaluate((value) => {
        const ta = [...document.querySelectorAll('textarea')].find(
          (x) =>
            /callback/i.test(x.placeholder ?? '') || /回调/.test(x.placeholder ?? ''),
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

    await test.step('keeps the paste session after refresh, then logs out', async () => {
      await page.reload()
      await waitForReady(page, 60000)
      const config = await getConfig(page)
      expect(config.remoteOauthConnected).toBe(true)

      await oauthLogout(page, target)
      const after = await getConfig(page)
      expect(after.remoteOauthConnected).toBe(false)
    })

    stopByPort(stack.tokenPort)
    stopByPort(stack.oauthPort)
  })
})
