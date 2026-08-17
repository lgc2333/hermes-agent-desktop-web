import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Browser, Page } from 'playwright'
import { launchBrowser } from './helpers/browser'
import { APP_URL } from './helpers/topology'
import { waitForReady, waitFor, gotoHash } from './helpers/bridge'
import { clearRegistry } from './helpers/registry'

// From cdp-dev-remote.mjs — the "dev:remote" shape: the SPA boots through the
// shared proxy with NO gateway running, so it reaches the boot-failure recovery
// surface while the settings page must still be usable. No mock is started here:
// the global proxy + Vite are already up (shared), only the gateway is absent.
//
// The assertion is deliberately tolerant: the exact overlay text isn't asserted —
// instead we require that boot resolves to a usable recovery/settings surface and
// that the gateway tab of the settings page renders its connection UI.
describe('dev-remote: no gateway, boot-failure recovery + usable settings', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    const launched = await launchBrowser()
    browser = launched.browser
    page = launched.page
    await page.goto(APP_URL)
    await waitForReady(page, 60000)
    // Start from a clean registry (avoid cross-suite pollution) and re-boot.
    await clearRegistry(page)
    await page.reload()
    await waitForReady(page, 60000)
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('reaches the boot-failure recovery surface when no gateway is available', async () => {
    // Tolerant: either the boot-failure overlay surfaces, or the app is already
    // usable enough that the settings gateway surface renders (e.g. the recovery
    // card embeds the gateway connection form rather than a raw overlay).
    const recovered = await waitFor(
      page,
      () => {
        const bar = document.querySelector('[data-slot="statusbar"]')
        const bootFailure =
          bar && /gateway/i.test(bar.innerText) && document.body.innerText.length > 0
        // Overlay heuristic from cdp-dev-remote: a full-screen fixed recovery card.
        const overlay = [...document.querySelectorAll('.fixed.inset-0')].some(
          (e) => (e.textContent ?? '').length > 0,
        )
        return bootFailure || overlay ? true : null
      },
      { timeout: 45000, label: 'boot-failure recovery surface' },
    )
    expect(recovered).toBe(true)
  })

  it('keeps the settings gateway tab usable with no gateway', async () => {
    await gotoHash(page, '#/settings?tab=gateway')
    const usable = await waitFor(
      page,
      () => {
        // Connection UI: a gateway URL input (placeholder from gateway-settings)
        // or the "Remote gateway" mode label.
        const urlInput = [...document.querySelectorAll('input')].find((i) =>
          /https?:\/\/|gateway/i.test(i.placeholder ?? ''),
        )
        const body = document.body.innerText
        const modeLabel = /remote gateway/i.test(body)
        return urlInput || modeLabel ? true : null
      },
      { timeout: 30000, label: 'settings gateway connection UI' },
    )
    expect(usable).toBe(true)
  })
})
