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
import { clearRegistry } from './helpers/registry'
import { waitForReady, waitFor } from './helpers/bridge'

describe('smoke: app boots against the shared token-mock topology', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    startMock(MOCK_TOKEN_PORT)
    await waitForHttp(`http://127.0.0.1:${MOCK_TOKEN_PORT}/api/status`)
    const launched = await launchBrowser()
    browser = launched.browser
    page = launched.page
    await page.goto(APP_URL)
    await waitForReady(page)
    // no cross-test registry pollution — start clean
    await clearRegistry(page)
    await page.reload()
    await waitForReady(page, 60000)
  })

  afterAll(async () => {
    await browser?.close()
    stopByPort(MOCK_TOKEN_PORT)
  })

  it('installs the bridge and renders the app', async () => {
    expect(await page.evaluate(() => !!window.hermesDesktop)).toBe(true)
    // Gateway status appears in the status bar once booted/reconciled.
    await waitFor(page, () => document.body.innerText.includes('Gateway'), {
      timeout: 15000,
      label: 'Gateway status',
    })
  })
})
