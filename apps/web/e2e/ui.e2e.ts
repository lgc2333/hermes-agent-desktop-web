import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Browser, Page } from 'playwright'
import { launchBrowser } from './helpers/browser'
import { APP_URL, MOCK_TOKEN_PORT, startMock, stopByPort, waitForHttp } from './helpers/topology'
import {
  waitForReady,
  waitFor,
  waitForBodyText,
  bootClean,
  gotoHash,
  getConfig,
} from './helpers/bridge'
import { sendChat } from './helpers/chat'
import { readRegistry } from './helpers/registry'

// From cdp-ui.mjs — UI-layer OAuth: settings "Sign in" → chat → refresh keep.
// Uses the gated mock (MOCK_OAUTH=1) on 5180 so the settings page renders an
// auth provider ("Sign in with …") and a full OAuth round-trip.
describe('ui: settings OAuth sign-in + chat + persistence', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    startMock(MOCK_TOKEN_PORT, { oauth: true })
    await waitForHttp(`http://127.0.0.1:${MOCK_TOKEN_PORT}/api/status`)
    const launched = await launchBrowser()
    browser = launched.browser
    page = launched.page
    await page.goto(APP_URL)
    await waitForReady(page)
    await bootClean(page)
    await waitForBodyText(page, 'Gateway', { timeout: 60000, label: 'Gateway ready' })
  })

  afterAll(async () => {
    await browser?.close()
    stopByPort(MOCK_TOKEN_PORT)
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
        return b ? b.textContent?.trim() ?? null : null
      },
      { timeout: 30000, label: 'sign in button' },
    )
    expect(signIn).toBeTruthy()
  })

  it('signs in through the popup and shows connected state', async () => {
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
        const btns = [...document.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '')
        return btns.some((x) => /sign out/i.test(x)) || btns.some((x) => /signed in|connected to/i.test(x))
          ? true
          : null
      },
      { timeout: 45000, label: 'oauth connected UI' },
    )
    expect(connected).toBe(true)
  })

  it('migrates the registry connection to oauth mode', async () => {
    const registry = await readRegistry(page)
    expect(registry.connections[0].authMode).toBe('oauth')
    expect(registry.connections[0].token).toBeFalsy()
  })

  it('streams a chat reply typed in the composer', async () => {
    await gotoHash(page, '#/')
    await sendChat(page, 'hello from m3 ui')
    await waitForBodyText(page, 'Hello from the mock gateway', { timeout: 30000, label: 'reply' })
  })

  it('keeps the oauth session across a refresh and restores the chat', async () => {
    await page.reload()
    await waitForReady(page, 60000)
    const config = await getConfig(page)
    expect(config.remoteOauthConnected).toBe(true)
    await waitForBodyText(page, 'Hello from the mock gateway', { timeout: 20000 })
    expect(await page.evaluate(() => document.body.innerText)).toMatch(/hello from m3 ui/i)
  })
})
