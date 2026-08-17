import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Browser, Page } from 'playwright'
import { launchBrowser } from './helpers/browser'
import { APP_URL } from './helpers/topology'
import { waitFor, waitForReady } from './helpers/bridge'
import { setRegistry, tokenRegistry } from './helpers/registry'

// Ported from cdp-deadgw.mjs / cdp-local-btn.mjs / cdp-hide-modes.mjs /
// cdp-hide-local.mjs / cdp-repair-logs.mjs — the Web "boot failure" surface.
//
// The connection target is an intentionally UNREACHABLE URL, so no mock is
// started: the app boots into the boot-failure overlay (web.css hides the
// desktop-only recovery affordances: "Use local gateway", "Repair install",
// "Open logs"). web.css keeps only the remote Connection-mode card.
//
// Default UI locale is English (DEFAULT_LOCALE = 'en'), so assertions use the
// en.ts labels ("Remote gateway", "Retry", "Gateway settings", …).
describe('boot-failure: unreachable gateway overlay + recovery hiding', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    const launched = await launchBrowser()
    browser = launched.browser
    page = launched.page
    await page.goto(APP_URL)
    await waitForReady(page)
    // Seed an unreachable remote target and reload → boots into boot-failure.
    await setRegistry(page, tokenRegistry('http://127.0.0.1:9'))
    await page.reload()
    await waitForReady(page)
  })

  afterAll(async () => {
    await browser?.close()
    // The target gateway is unreachable, so no mock was started here — the
    // shared proxy/Vite stack is torn down by global-teardown.
  })

  it('shows the boot-failure overlay with a recovery button row', async () => {
    const overlayFound = await waitFor(
      page,
      () => {
        const el = [...document.querySelectorAll('.fixed.inset-0')].find(
          (e) =>
            (e.className || '').toString().includes('z-(') &&
            !(e.className || '').toString().includes('onboarding'),
        )
        return el ? (el.innerText || '').includes('Retry') : null
      },
      { timeout: 45000, label: 'boot-failure overlay' },
    )
    expect(overlayFound).toBe(true)

    // The recovery buttons live in a `flex flex-wrap gap-2` row inside the overlay.
    const row = await waitFor(
      page,
      () => {
        const overlay = [...document.querySelectorAll('.fixed.inset-0')].find(
          (e) =>
            (e.className || '').toString().includes('z-(') &&
            !(e.className || '').toString().includes('onboarding'),
        )
        if (!overlay) return null
        const rows = [...overlay.querySelectorAll('.flex.flex-wrap.gap-2')]
        const btns = rows.flatMap((r) => [...r.querySelectorAll(':scope > button')])
        return btns.length > 0 ? btns.map((b) => b.innerText.trim()) : null
      },
      { timeout: 15000, label: 'recovery button row' },
    )
    expect(row.length).toBeGreaterThan(0)
    // Remote unreachable branch renders [Gateway settings, Retry, Use local
    // gateway, Open logs]; web.css hides use-local + open-logs, leaving
    // Gateway settings + Retry visibly mounted.
    expect(row).toContain('Retry')
  })

  it('hides "Use local gateway" from the recovery surface (web.css)', async () => {
    // Overlay is live (Retry visible), so a missing "Use local gateway" is a
    // real assertion and not a false negative from an empty page.
    const retryVisible = await waitFor(
      page,
      () => document.body.innerText.includes('Retry'),
      { timeout: 15000, label: 'overlay still live' },
    )
    expect(retryVisible).toBe(true)

    const noUseLocal = await page.evaluate(
      () => !document.body.innerText.includes('Use local gateway'),
    )
    expect(noUseLocal).toBe(true)
  })

  it('shows only the remote Connection-mode card (no local-gateway entry)', async () => {
    // Open the embedded "Gateway settings" recovery view — it renders the same
    // GatewaySettings mode cards (the `.grid.auto-rows-fr.grid-cols-1`
    // container) that the standalone Settings page does, with web.css hiding
    // all but the remote card.
    await page.evaluate(() => {
      const overlay = [...document.querySelectorAll('.fixed.inset-0')].find(
        (e) =>
          (e.className || '').toString().includes('z-(') &&
          !(e.className || '').toString().includes('onboarding'),
      )
      const btn = overlay
        ? [...overlay.querySelectorAll('button')].find((b) =>
            /gateway settings/i.test(b.textContent ?? ''),
          )
        : null
      btn?.click()
    })

    // Mode card container: 4 buttons [local, cloud, remote, ssh]; only the
    // remote one (3rd) is displayed. Assert the visible card set by computed
    // display, not fragile layout details.
    const visibleCards = await waitFor(
      page,
      () => {
        const cards = [...document.querySelectorAll('.grid.auto-rows-fr.grid-cols-1 > button')]
        if (cards.length === 0) return null
        return cards
          .filter((b) => getComputedStyle(b).display !== 'none')
          .map((b) => b.innerText.trim().split('\n')[0].trim())
      },
      { timeout: 30000, label: 'connection mode cards' },
    )
    expect(visibleCards).toEqual(['Remote gateway'])
  })

  it('is absent of "Repair install" / "Open logs" on the remote unreachable branch', async () => {
    // cdp-repair-logs: on the LOCAL failure branch [Retry, Repair, Settings,
    // Open logs], web.css hides Repair + Open logs; on the REMOTE branch the
    // component never renders "Repair install" at all and "Open logs" is
    // hidden via CSS. Here we assert the remote-branch absence of both.
    const bodyText = await page.evaluate(() => document.body.innerText)
    expect(bodyText).not.toContain('Repair install')
    expect(bodyText).not.toContain('Open logs')
  })
})
