import { test, expect } from './fixtures'
import { startMock, stopByPort, startProxy, waitForHttp } from './helpers/topology'
import {
  waitForReady,
  waitFor,
  waitForBodyText,
  bootClean,
  gotoHash,
  getConfig,
  saveOauthConnection,
  poll,
} from './helpers/bridge'
import { sendChat } from './helpers/chat'

// From cdp-reconnect-a.mjs — token-mode WS disconnect → auto-reconnect.

test.describe('reconnect A: token disconnect → auto-reconnect', () => {
  test('reconnect A: token disconnect → auto-reconnect', async ({ page, stack }) => {
    startMock(stack.tokenPort)
    await waitForHttp(`${stack.tokenTarget}/api/status`)
    await page.goto(stack.appUrl)
    await waitForReady(page)
    await bootClean(page)

    await test.step('streams a baseline chat reply before any disconnect', async () => {
      await gotoHash(page, '#/')
      await sendChat(page, 'reconnect test message')
      await waitForBodyText(page, 'Hello from the mock gateway', {
        timeout: 30000,
        label: 'baseline reply',
      })
    })

    await test.step('kills the mock, restarts it, auto-reconnects and streams again', async () => {
      stopByPort(stack.tokenPort)
      // 让 UI 观察到断连（transitive 状态，不单独断言）。
      await page.waitForTimeout(4000)

      startMock(stack.tokenPort)
      await waitForHttp(`${stack.tokenTarget}/api/status`)

      // 状态栏回到 ready/open/connected。
      const reconnected = await waitFor(
        page,
        () => {
          const sb = document.querySelector('[data-slot="statusbar"]')?.innerText || ''
          return sb.includes('ready') || /open|connected/i.test(sb)
            ? sb.slice(0, 120)
            : null
        },
        { timeout: 45000, label: 'reconnect ready' },
      )
      expect(reconnected).toBeTruthy()

      await gotoHash(page, '#/')
      await sendChat(page, 'after reconnect')
      await waitForBodyText(page, 'Hello from the mock gateway', {
        timeout: 30000,
        label: 'post-reconnect reply',
      })
    })

    stopByPort(stack.tokenPort)
  })
})

test.describe('reconnect C: feedback when sending while connecting', () => {
  test('reconnect C: feedback when sending while connecting', async ({
    page,
    stack,
  }) => {
    startMock(stack.tokenPort)
    await waitForHttp(`${stack.tokenTarget}/api/status`)
    await page.goto(stack.appUrl)
    await waitForReady(page)
    await bootClean(page)
    await gotoHash(page, '#/')

    await test.step('surfaces feedback when a message is sent while the gateway is down', async () => {
      stopByPort(stack.tokenPort)
      await page.waitForTimeout(5000)

      // 断连时尝试发送。
      await sendChat(page, 'send while disconnected')
      await page.waitForTimeout(2500)

      // 无假成功：dead gateway 无法流出 canned reply，composer 禁用或出现错误/离线提示。
      const disFeedback = await page.evaluate(() =>
        /not connected|unavailable|failed|error|offline|connection lost/i.test(
          document.body.innerText.slice(-700),
        ),
      )
      const gotReply = await page.evaluate(() =>
        document.body.innerText.includes('Hello from the mock gateway'),
      )
      expect(disFeedback || !gotReply).toBe(true)

      // 重启 mock 并确认连接恢复 ready。
      startMock(stack.tokenPort)
      await waitForHttp(`${stack.tokenTarget}/api/status`)
      const ready = await waitFor(
        page,
        () => {
          const sb = document.querySelector('[data-slot="statusbar"]')?.innerText || ''
          return sb.includes('ready') || /open|connected/i.test(sb)
            ? sb.slice(0, 120)
            : null
        },
        { timeout: 45000, label: 'mock recovered' },
      )
      expect(ready).toBeTruthy()
    })

    stopByPort(stack.tokenPort)
  })
})

// From cdp-reconnect-b.mjs — OAuth session held in the browser's httpOnly
// cookie (ADR-0023), so restarting the proxy keeps the session (ADR-0023).

test.describe('reconnect B: OAuth session survives proxy restart (ADR-0023)', () => {
  test('reconnect B: OAuth session survives proxy restart (ADR-0023)', async ({
    page,
    stack,
  }) => {
    // 默认 seed boot 探测用普通 token mock；gated OAuth mock 作连接目标。
    startMock(stack.tokenPort)
    startMock(stack.oauthPort, { oauth: true })
    await waitForHttp(`${stack.oauthTarget}/api/status`)
    await page.goto(stack.appUrl)
    await waitForReady(page)
    await bootClean(page)
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

    await test.step('signs in and reports the oauth session connected', async () => {
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
      expect(
        await poll(() => getConfig(page).then((c) => c.remoteOauthConnected === true), {
          timeout: 15000,
          label: 'bridge oauth connected',
        }),
      ).toBe(true)
    })

    await test.step('streams a chat reply over the oauth session', async () => {
      await gotoHash(page, '#/')
      await sendChat(page, 'oauth reconnect test')
      await waitForBodyText(page, 'Hello from the mock gateway', {
        timeout: 30000,
        label: 'oauth baseline reply',
      })
    })

    await test.step('keeps the oauth session once the proxy is restarted', async () => {
      // 本 worker 独享代理：重启本 worker 自己的 proxyPort，不影响其它 worker。
      stopByPort(stack.proxyPort)
      await page.waitForTimeout(4000)

      startProxy(stack.proxyPort)
      await waitForHttp(`http://127.0.0.1:${stack.proxyPort}/api/proxy/meta`)
      await page.waitForTimeout(3000)

      // ADR-0023：凭证在浏览器 cookie，新代理实例解码恢复——会话保持连接。
      expect(
        await poll(() => getConfig(page).then((c) => c.remoteOauthConnected === true), {
          timeout: 20000,
          label: 'oauth session survives restart',
        }),
      ).toBe(true)

      // 聊天继续可用（WS 经 cookie 恢复的会话拨号）。
      await gotoHash(page, '#/')
      await sendChat(page, 'after proxy restart')
      await waitForBodyText(page, 'Hello from the mock gateway', {
        timeout: 30000,
        label: 'post-restart reply',
      })
    })

    stopByPort(stack.tokenPort)
    stopByPort(stack.oauthPort)
  })
})
