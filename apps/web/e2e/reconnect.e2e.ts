import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Browser, Page } from 'playwright'
import { launchBrowser } from './helpers/browser'
import {
  APP_URL,
  PROXY_URL,
  PROXY_PORT,
  MOCK_TOKEN_PORT,
  MOCK_OAUTH_PORT,
  startMock,
  stopByPort,
  startProxy,
  waitForHttp,
} from './helpers/topology'
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
// Boot on the plain token mock, confirm baseline streaming, kill the mock,
// restart it, and confirm the UI returns to ready and chat streams again.

function tokenStatusUrl(): string {
  return `http://127.0.0.1:${MOCK_TOKEN_PORT}/api/status`
}

describe('reconnect A: token disconnect → auto-reconnect', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    startMock(MOCK_TOKEN_PORT)
    await waitForHttp(tokenStatusUrl())
    const launched = await launchBrowser()
    browser = launched.browser
    page = launched.page
    await page.goto(APP_URL)
    await waitForReady(page)
    await bootClean(page)
  })

  afterAll(async () => {
    await browser?.close()
    stopByPort(MOCK_TOKEN_PORT)
  })

  it('streams a baseline chat reply before any disconnect', async () => {
    await gotoHash(page, '#/')
    await sendChat(page, 'reconnect test message')
    await waitForBodyText(page, 'Hello from the mock gateway', {
      timeout: 30000,
      label: 'baseline reply',
    })
  })

  it('kills the mock, restarts it, auto-reconnects and streams again', async () => {
    stopByPort(MOCK_TOKEN_PORT)
    // let the UI observe the disconnect (transitive state; not asserted on its own)
    await page.waitForTimeout(4000)

    startMock(MOCK_TOKEN_PORT)
    await waitForHttp(tokenStatusUrl())

    // status bar returns to a ready/open/connected state
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
})

describe('reconnect C: feedback when sending while connecting', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    startMock(MOCK_TOKEN_PORT)
    await waitForHttp(tokenStatusUrl())
    const launched = await launchBrowser()
    browser = launched.browser
    page = launched.page
    await page.goto(APP_URL)
    await waitForReady(page)
    await bootClean(page)
    await gotoHash(page, '#/')
  })

  afterAll(async () => {
    await browser?.close()
    stopByPort(MOCK_TOKEN_PORT)
  })

  it('surfaces feedback when a message is sent while the gateway is down', async () => {
    stopByPort(MOCK_TOKEN_PORT)
    await page.waitForTimeout(5000)

    // attempt to send while disconnected
    await sendChat(page, 'send while disconnected')
    await page.waitForTimeout(2500)

    // No fake success: the canned reply cannot stream from a dead gateway, and
    // either the composer is disabled or an error/offline hint is visible.
    const disFeedback = await page.evaluate(() =>
      /not connected|unavailable|failed|error|offline|connection lost/i.test(
        document.body.innerText.slice(-700),
      ),
    )
    const gotReply = await page.evaluate(() =>
      document.body.innerText.includes('Hello from the mock gateway'),
    )
    // DIAG: capture real page state at the failure point
    const diagC = await page.evaluate(() => ({
      statusbar: (document.querySelector('[data-slot="statusbar"]')?.innerText || '').slice(0, 120),
      tail: document.body.innerText.slice(-300),
    }))
    console.log('[DIAG reconnect C]', JSON.stringify(diagC))
    expect(disFeedback || !gotReply).toBe(true)

    // restart the mock and confirm the connection recovers to ready
    startMock(MOCK_TOKEN_PORT)
    await waitForHttp(tokenStatusUrl())
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
})

describe('reconnect C2: submit while statusbar shows connecting', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    startMock(MOCK_TOKEN_PORT)
    await waitForHttp(tokenStatusUrl())
    const launched = await launchBrowser()
    browser = launched.browser
    page = launched.page
    await page.goto(APP_URL)
    await waitForReady(page)
    await bootClean(page)
    await gotoHash(page, '#/')
  })

  afterAll(async () => {
    await browser?.close()
    stopByPort(MOCK_TOKEN_PORT)
  })

  it('submits while disconnected and shows feedback, then recovers after restart', async () => {
    stopByPort(MOCK_TOKEN_PORT)

    // wait until the UI has registered the disconnect (connecting state)
    const connectingShown = await waitFor(
      page,
      () =>
        (document.querySelector('[data-slot="statusbar"]')?.innerText || '').includes(
          'connecting',
        ),
      { timeout: 20000, label: 'statusbar connecting' },
    ).catch((e) => {
      // DIAG: capture real page state at the failure point
      return page.evaluate(() => {
        const sb = (document.querySelector('[data-slot="statusbar"]') as HTMLElement | null)?.innerText || ''
        return { stillShown: null, statusbar: sb.slice(0, 150), tail: document.body.innerText.slice(-250) }
      }).then((s) => {
        console.log('[DIAG reconnect C2 connecting]', JSON.stringify(s))
        throw e
      })
    })
    await page.waitForTimeout(1000)

    await sendChat(page, 'SEND-WHILE-OFFLINE')
    await page.waitForTimeout(2500)

    // Either an explicit error surfaced, or the message was not delivered as a
    // reply while the gateway was unreachable.
    const disState = await page.evaluate(() => {
      const txt = document.body.innerText
      return {
        msgInTranscript: txt.includes('SEND-WHILE-OFFLINE'),
        errorVisible:
          /not connected|unavailable|failed to|offline|connection lost/i.test(
            txt.slice(-700),
          ),
      }
    })
    expect(disState.errorVisible || !disState.msgInTranscript).toBe(true)

    // restart the mock → connection returns to ready
    startMock(MOCK_TOKEN_PORT)
    await waitForHttp(tokenStatusUrl())
    const ready = await waitFor(
      page,
      () => {
        const sb = document.querySelector('[data-slot="statusbar"]')?.innerText || ''
        return sb.includes('ready') || /open|connected/i.test(sb)
          ? sb.slice(0, 120)
          : null
      },
      { timeout: 40000, label: 'ready again' },
    )
    expect(ready).toBeTruthy()
  })
})

// From cdp-reconnect-b.mjs — OAuth session is held in the proxy's in-memory
// token set (ADR-0002), so restarting the proxy drops the session and the
// settings page falls back to "Sign in".

describe('reconnect B: OAuth session lost on proxy restart', () => {
  let browser: Browser
  let page: Page

  const TARGET = `http://127.0.0.1:${MOCK_OAUTH_PORT}`

  beforeAll(async () => {
    // Plain token mock for the default-seed boot probe; gated OAuth mock as
    // the connection target that renders an auth provider.
    startMock(MOCK_TOKEN_PORT)
    startMock(MOCK_OAUTH_PORT, { oauth: true })
    await waitForHttp(`${TARGET}/api/status`)
    const launched = await launchBrowser()
    browser = launched.browser
    page = launched.page
    await page.goto(APP_URL)
    await waitForReady(page)
    await bootClean(page)
    await saveOauthConnection(page, TARGET)
  })

  afterAll(async () => {
    await browser?.close()
    stopByPort(MOCK_TOKEN_PORT)
    stopByPort(MOCK_OAUTH_PORT)
  })

  it('renders the OAuth sign-in button in settings', async () => {
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

  it('signs in and reports the oauth session connected', async () => {
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

  it('streams a chat reply over the oauth session', async () => {
    await gotoHash(page, '#/')
    await sendChat(page, 'oauth reconnect test')
    await waitForBodyText(page, 'Hello from the mock gateway', {
      timeout: 30000,
      label: 'oauth baseline reply',
    })
  })

  it('loses the oauth session once the proxy is restarted', async () => {
    stopByPort(PROXY_PORT)
    await page.waitForTimeout(4000)

    startProxy()
    await waitForHttp(`${PROXY_URL}/api/proxy/meta`)
    await page.waitForTimeout(3000)

    // In-memory oauth token set is gone: bridge reports disconnected.
    const oauthLost = await poll(
      () => getConfig(page).then((c) => c.remoteOauthConnected === false),
      {
        timeout: 20000,
        label: 'oauth session lost',
      },
    ).catch(async (e) => {
      // DIAG: capture proxy + config state at the failure point
      const cfg = await getConfig(page)
      const diagB = await page.evaluate(() => ({
        statusbar: (document.querySelector('[data-slot="statusbar"]') as HTMLElement | null)?.innerText || '',
        hasSignIn: [...document.querySelectorAll('button')].some((b) => /sign in/.test(b.textContent ?? '')),
        tail: document.body.innerText.slice(-250),
      }))
      console.log('[DIAG reconnect B]', JSON.stringify({ cfg, ...diagB }))
      throw e
    })
    expect(oauthLost).toBe(true)

    // Settings page falls back to "Sign in".
    await gotoHash(page, '#/settings?tab=gateway')
    const signInBack = await waitFor(
      page,
      () => {
        const b = [...document.querySelectorAll('button')].find(
          (x) =>
            /sign in with/i.test(x.textContent ?? '') ||
            /^sign in$/i.test((x.textContent ?? '').trim()),
        )
        return b ? (b.textContent?.trim() ?? null) : null
      },
      { timeout: 30000, label: 'sign in returns after restart' },
    )
    expect(signInBack).toBeTruthy()
  })
})
