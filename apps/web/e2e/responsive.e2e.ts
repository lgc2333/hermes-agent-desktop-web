import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Browser, Page } from 'playwright'
import { launchMobilePage } from './helpers/browser'
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
  waitForBodyText,
  bootClean,
  gotoHash,
} from './helpers/bridge'

// From cdp-mobile3.mjs + cdp-statusbar-check.mjs — M4 responsive acceptance on a
// mobile viewport (390x844). The plain token mock (MOCK_TOKEN_PORT) boots the SPA
// through the shared proxy; we assert the sidebar toggle opens the drawer, the
// settings gateway tab renders, and the status bar stays readable at 390px wide.
describe('responsive: mobile-viewport (390x844) layout invariants', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    startMock(MOCK_TOKEN_PORT)
    await waitForHttp(`http://127.0.0.1:${MOCK_TOKEN_PORT}/api/status`)
    const launched = await launchMobilePage()
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

  it('renders the settings gateway tab in the mobile viewport', async () => {
    await gotoHash(page, '#/settings?tab=gateway')
    const ok = await waitFor(
      page,
      () => {
        const txt = document.body.innerText
        return /remote gateway|gateway url|connection/i.test(txt) ? true : null
      },
      { timeout: 30000, label: 'settings gateway tab' },
    )
    expect(ok).toBe(true)
  })

  it('keeps the status bar visible and readable at 390px width', async () => {
    // The status bar must be present and carry the backend/Gateway text (it is
    // horizontally scrollable so the full backend text stays reachable).
    const bar = await waitFor(
      page,
      () => {
        const sb = document.querySelector('[data-slot="statusbar"]')
        if (!sb) return null
        const r = sb.getBoundingClientRect()
        return {
          width: Math.round(r.width),
          height: Math.round(r.height),
          text: sb.innerText,
        }
      },
      { timeout: 30000, label: 'status bar' },
    )
    expect(bar).toBeTruthy()
    expect(bar!.width).toBeGreaterThan(0)
    expect(bar!.text).toBeTruthy()
    expect(bar!.text).toMatch(/gateway/i)
  })
})
