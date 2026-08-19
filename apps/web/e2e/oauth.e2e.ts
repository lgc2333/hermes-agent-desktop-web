import { test, expect } from './fixtures'
import { startMock, stopByPort, waitForHttp } from './helpers/topology'
import {
  waitForReady,
  waitFor,
  bootClean,
  gotoHash,
  saveOauthConnection,
  oauthLogin,
  oauthLogout,
  getConfig,
  wsJsonRpc,
} from './helpers/bridge'

// From cdp-oauth.mjs — bridge-level OAuth native-PKCE login + chat + refresh.
// Uses the plain token mock (exposes the native OAuth face without the gated
// auth_required probe), chained over one shared page.
test.describe('oauth: bridge-level native login + chat + persistence', () => {
  test('bridge-level native login + chat + persistence', async ({ page, stack }) => {
    const target = stack.tokenTarget

    startMock(stack.tokenPort)
    await waitForHttp(`${target}/api/status`)

    await page.goto(stack.appUrl)
    await waitForReady(page)
    await bootClean(page)

    const oauthConnected = async (): Promise<boolean> => {
      const config = await getConfig(page)
      return config.remoteOauthConnected === true
    }

    await test.step('saves an oauth connection', async () => {
      const saved = await saveOauthConnection(page, target)
      expect(saved.authMode).toBe('oauth')
      expect(saved.url).toBe(target)
    })

    await test.step('logs in via oauthLoginConnectionConfig', async () => {
      const login = await oauthLogin(page, target)
      expect(login.connected).toBe(true)
    })

    await test.step('reflects the connected oauth session in the config', async () => {
      const config = await getConfig(page)
      expect(config.remoteOauthConnected).toBe(true)
      expect(config.remoteTokenPreview).toBeTruthy()
    })

    await test.step('streams a chat reply over the oauth WS session', async () => {
      const out = await wsJsonRpc(page, {
        waitEvent: 'complete',
        text: 'hello oauth m3',
      })
      expect(out.opened).toBe(true)
      expect(out.complete).toBeTruthy()
    })

    await test.step('renders the OAuth sign-in button in settings', async () => {
      await gotoHash(page, '#/settings?tab=gateway')
      const btn = await waitFor(
        page,
        () => {
          const b = [...document.querySelectorAll('button')].find((x) =>
            /sign in|log in|oauth|sign-in/i.test(x.textContent ?? ''),
          )
          return b ? (b.textContent?.trim() ?? null) : null
        },
        { timeout: 30000, label: 'oauth button' },
      )
      expect(btn).toBeTruthy()
    })

    await test.step('keeps the session after a refresh', async () => {
      await page.reload()
      await waitForReady(page, 60000)
      expect(await oauthConnected()).toBe(true)
    })

    await test.step('logs out and reports disconnected', async () => {
      await oauthLogout(page, target)
      expect(await oauthConnected()).toBe(false)
    })

    stopByPort(stack.tokenPort)
  })
})
