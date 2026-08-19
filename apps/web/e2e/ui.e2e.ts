import { test, expect } from './fixtures'
import { startMock, stopByPort, waitForHttp } from './helpers/topology'
import {
  waitForReady,
  waitFor,
  waitForBodyText,
  gotoHash,
  getConfig,
  saveOauthConnection,
} from './helpers/bridge'
import { sendChat } from './helpers/chat'
import { readRegistry } from './helpers/registry'

// From cdp-ui.mjs — UI-layer OAuth: settings "Sign in" → chat → refresh keep.
// Uses the gated mock (MOCK_OAUTH=1), mirror of reconnect B's working flow.

test.describe('ui: settings OAuth sign-in + chat + persistence', () => {
  test('ui: settings OAuth sign-in + chat + persistence', async ({ page, stack }) => {
    // 默认 seed boot 探测用普通 token mock；gated OAuth mock 作连接目标。
    startMock(stack.tokenPort)
    startMock(stack.oauthPort, { oauth: true })
    await waitForHttp(`${stack.oauthTarget}/api/status`)
    await page.goto(stack.appUrl)
    await waitForReady(page)
    await saveOauthConnection(page, stack.oauthTarget)

    await test.step('renders the OAuth sign-in button in settings', async () => {
      await gotoHash(page, '#/settings?tab=gateway')
      const signIn = await waitFor(
        page,
        () => {
          const b = [...document.querySelectorAll('button')].find(
            (x) =>
              /sign in with/i.test(x.textContent ?? '') ||
              /^sign in$/i.test((x.textContent ?? '').trim()),
          )
          return b ? (b.textContent?.trim() ?? null) : null
        },
        { timeout: 30000, label: 'sign in button' },
      )
      expect(signIn).toBeTruthy()
    })

    await test.step('signs in through the popup and shows connected state', async () => {
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find(
          (x) =>
            /sign in with/i.test(x.textContent ?? '') ||
            /^sign in$/i.test((x.textContent ?? '').trim()),
        )
        b?.click()
      })
      const connected = await waitFor(
        page,
        () => {
          const btns = [...document.querySelectorAll('button')].map(
            (b) => b.textContent?.trim() ?? '',
          )
          return btns.some((x) => /sign out/i.test(x)) ||
            btns.some((x) => /signed in|connected to/i.test(x))
            ? true
            : null
        },
        { timeout: 45000, label: 'oauth connected UI' },
      )
      expect(connected).toBe(true)
    })

    await test.step('migrates the registry connection to oauth mode', async () => {
      const registry = await readRegistry(page)
      expect(registry.connections[0].authMode).toBe('oauth')
      expect(registry.connections[0].token).toBeFalsy()
    })

    await test.step('streams a chat reply typed in the composer', async () => {
      await gotoHash(page, '#/')
      await sendChat(page, 'hello from m3 ui')
      await waitForBodyText(page, 'Hello from the mock gateway', {
        timeout: 30000,
        label: 'reply',
      })
    })

    await test.step('keeps the oauth session across a refresh', async () => {
      // 刷新重启页面；OAuth httpOnly 代理会话须存活（proxy cookie, ADR-0002）。
      await page.reload()
      await waitForReady(page, 60000)
      const config = await getConfig(page)
      expect(config.remoteOauthConnected).toBe(true)
    })

    stopByPort(stack.tokenPort)
    stopByPort(stack.oauthPort)
  })
})
