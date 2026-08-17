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
import { waitForReady, waitFor, waitForBodyText, bootClean } from './helpers/bridge'

// From cdp-find.mjs — ADR-0019: under the web build the vendor find.shortcut is
// disabled, so Ctrl+F must NOT open the vendor find-bar (the [role="search"]
// overlay). The web build lets the browser native find take over, so no such
// overlay may appear after Ctrl+F.
// Uses the plain token mock (MOCK_TOKEN_PORT) so boot works without login.
describe('find: Ctrl+F does not open the vendor find-bar (ADR-0019)', () => {
  let browser: Browser
  let page: Page

  // Self-contained page expression (only page globals) — the find overlay is a
  // `[role="search"]` element.
  const noFindBar = () => !document.querySelector('[role="search"]')

  beforeAll(async () => {
    startMock(MOCK_TOKEN_PORT)
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

  it('does not preventDefault a synthetic Ctrl+F keydown (native find not swallowed)', async () => {
    // Vendor dispatch must leave defaultPrevented=false so the browser-native
    // find accelerator can take over (scenario 1 of cdp-find.mjs).
    const notPrevented = await waitFor(
      page,
      () => {
        const ev = new KeyboardEvent('keydown', {
          key: 'f',
          code: 'KeyF',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
        window.dispatchEvent(ev)
        return ev.defaultPrevented === false ? true : null
      },
      { timeout: 20000, label: 'synthetic Ctrl+F not prevented' },
    )
    expect(notPrevented).toBe(true)
    // No find-bar after the synthetic press either.
    await expect(page.evaluate(noFindBar)).resolves.toBe(true)
  })

  it('shows no find-bar overlay after a real Control+f', async () => {
    await page.keyboard.press('Control+f')
    await page.waitForTimeout(1200)
    await expect(page.evaluate(noFindBar)).resolves.toBe(true)
  })

  it('regression: Ctrl+K still opens the command palette dialog', async () => {
    // The palette is a Radix dialog; the stable semantic anchor is the search
    // input placeholder inside it (scenario 4 of cdp-find.mjs).
    await page.keyboard.press('Control+k')
    const palette = await waitFor(
      page,
      () =>
        [...document.querySelectorAll('[role="dialog"]')].some((d) =>
          /search sessions/i.test(d.querySelector('input')?.placeholder ?? ''),
        )
          ? true
          : null,
      { timeout: 15000, label: 'command palette dialog' },
    ).catch(() => null)
    expect(palette).toBe(true)
  })
})
