import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Browser, Page } from 'playwright'
import { launchBrowser } from './helpers/browser'
import {
  APP_URL,
  MOCK_TOKEN_PORT,
  startMock,
  stopByPort,
  waitForHttp,
} from './helpers/topology'
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
// Uses the plain mock on 5180 (it exposes the native OAuth face without the
// gated auth_required probe).
const TARGET = `http://127.0.0.1:${MOCK_TOKEN_PORT}`

describe('oauth: bridge-level native login + chat + persistence', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    startMock(MOCK_TOKEN_PORT)
    await waitForHttp(`${TARGET}/api/status`)
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

  it('saves an oauth connection', async () => {
    const saved = await saveOauthConnection(page, TARGET)
    expect(saved.authMode).toBe('oauth')
    expect(saved.url).toBe(TARGET)
  })

  it('logs in via oauthLoginConnectionConfig', async () => {
    const login = await oauthLogin(page, TARGET)
    expect(login.connected).toBe(true)
  })

  it('reflects the connected oauth session in the config', async () => {
    const config = await getConfig(page)
    expect(config.remoteOauthConnected).toBe(true)
    expect(config.remoteTokenPreview).toBeTruthy()
  })

  it('streams a chat reply over the oauth WS session', async () => {
    const out = await wsJsonRpc(page, {
      waitEvent: 'complete',
      text: 'hello oauth m3',
    })
    expect(out.opened).toBe(true)
    expect(out.complete).toBeTruthy()
  })

  it('renders the OAuth sign-in button in settings', async () => {
    await gotoHash(page, '#/settings?tab=gateway')
    const btn = await waitFor(
      page,
      () => {
        const b = [...document.querySelectorAll('button')].find((x) =>
          /sign in|log in|oauth|sign-in/i.test(x.textContent ?? ''),
        )
        return b ? b.textContent?.trim() ?? null : null
      },
      { timeout: 30000, label: 'oauth button' },
    )
    expect(btn).toBeTruthy()
  })

  it('keeps the session after a refresh', async () => {
    await page.reload()
    await waitForReady(page, 60000)
    expect(await oauthConnected()).toBe(true)
  })

  it('logs out and reports disconnected', async () => {
    await oauthLogout(page, TARGET)
    expect(await oauthConnected()).toBe(false)
  })

  async function oauthConnected(): Promise<boolean> {
    const config = await getConfig(page)
    return config.remoteOauthConnected === true
  }
})
