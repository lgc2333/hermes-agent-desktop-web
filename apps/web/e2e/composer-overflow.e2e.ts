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
import { waitForReady, waitForBodyText, bootClean, gotoHash } from './helpers/bridge'
import { sendChat } from './helpers/chat'

// Regression for the mobile composer overflow fix (apps/web/src/web.css §6b).
//
// The composer surface ([data-slot="composer-surface"]) is grid-rows-[auto_1fr];
// it fits its parent, but the inner grid row (menu/input/controls) sizes its
// auto columns to min-content. On a narrow viewport a wide controls cluster
// (send + model/voice/contrib buttons, all nowrap) pushes that grid past the
// surface, whose `overflow-hidden` clips the right-hand send/controls.
//
// The plain token mock boots a sparse composer, so to reproduce the real
// gateway's wider control cluster we inject extra nowrap buttons into the
// controls cell (same set that triggered the bug) and assert they still fit
// inside the surface. web.css's mobile overrides give the grid items
// `min-width:0` and let menu/controls cells wrap, keeping Send visible.
describe('composer: mobile right-hand controls stay inside the surface', () => {
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
    // Land on a chat so the composer is mounted.
    await gotoHash(page, '#/')
    await sendChat(page, 'hi')
    await waitForBodyText(page, 'Hello from the mock gateway', {
      timeout: 30000,
      label: 'reply',
    })
    // Inject a realistically wide controls cluster (nowrap buttons) once.
    await page.evaluate(() => {
      const fade = document.querySelector<HTMLElement>('[data-slot="composer-fade"]')
      const grid = fade
        ? [...fade.querySelectorAll('*')].find((el) => {
            const e = el as HTMLElement
            return (
              e.children.length >= 2 &&
              getComputedStyle(e).display === 'grid' &&
              [...e.children].some((c) =>
                /controls/.test(getComputedStyle(c).gridArea || ''),
              )
            )
          })
        : null
      const controls = grid
        ? [...grid.children].find((c) =>
            /controls/.test(getComputedStyle(c).gridArea || ''),
          )
        : null
      if (grid && controls && !grid.querySelector('[data-repro="ctrl"]')) {
        for (const label of [
          'Attach',
          'Code',
          'Send message',
          'Voice',
          'Skip',
          'Tools wide',
        ]) {
          const b = Object.assign(document.createElement('button'), {
            'data-repro': 'ctrl',
            ariaLabel: label,
          })
          b.textContent = label
          b.style.cssText =
            'white-space:nowrap;padding:0 8px;font-size:12px;height:24px;flex:none;'
          controls.appendChild(b)
        }
      }
    })
  })

  afterAll(async () => {
    await browser?.close()
    stopByPort(MOCK_TOKEN_PORT)
  })

  it('keeps Send/controls visible inside the surface with a wide controls cluster', async () => {
    const measure = () =>
      page.evaluate(() => {
        const surface = document.querySelector<HTMLElement>(
          '[data-slot="composer-surface"]',
        )
        const fade = surface?.querySelector<HTMLElement>('[data-slot="composer-fade"]')
        const grid = fade
          ? [...fade.querySelectorAll('*')].find((el) => {
              const e = el as HTMLElement
              return (
                e.children.length >= 2 &&
                getComputedStyle(e).display === 'grid' &&
                [...e.children].some((c) =>
                  /controls/.test(getComputedStyle(c).gridArea || ''),
                )
              )
            })
          : null
        const controls = grid
          ? [...grid.children].find((c) =>
              /controls/.test(getComputedStyle(c).gridArea || ''),
            )
          : null
        if (!surface || !grid) return null
        const sR = Math.round(surface.getBoundingClientRect().right)
        const send = controls
          ? [...controls.querySelectorAll('button')].find((b) =>
              (b.textContent || '').includes('Send message'),
            )
          : null
        const sendR = send ? Math.round(send.getBoundingClientRect().right) : null
        return {
          surfaceClientW: surface.clientWidth,
          surfaceScrollW: surface.scrollWidth,
          gridClientW: (grid as HTMLElement).clientWidth,
          gridScrollW: (grid as HTMLElement).scrollWidth,
          controlsWrap: controls
            ? getComputedStyle(controls as HTMLElement).flexWrap
            : null,
          surfaceRight: sR,
          sendRight: sendR,
        }
      })

    const widths = [390, 360, 320] as const
    const results: Record<string, unknown> = {}
    for (const w of widths) {
      await page.setViewportSize({ width: w, height: 700 })
      await page.waitForTimeout(300)
      results[String(w)] = await measure()
    }

    for (const w of widths) {
      const r = results[String(w)] as unknown as {
        surfaceClientW: number
        surfaceScrollW: number
        gridClientW: number
        gridScrollW: number
        controlsWrap: string
        surfaceRight: number
        sendRight: number
      } | null
      expect(r, `width ${w}: composer grid located`).toBeTruthy()
      // The composer surface itself must not overflow its own box…
      expect(
        r!.surfaceScrollW,
        `width ${w}: surface not overflowing`,
      ).toBeLessThanOrEqual(r!.surfaceClientW + 1)
      // …the inner grid must not overflow either…
      expect(
        r!.gridScrollW,
        `width ${w}: inner grid not overflowing`,
      ).toBeLessThanOrEqual(r!.gridClientW + 1)
      // …the controls cluster must be allowed to wrap…
      expect(r!.controlsWrap, `width ${w}: controls cell wraps`).toBe('wrap')
      // …and the Send button must stay at or inside the surface's right edge.
      expect(r!.sendRight, `width ${w}: Send inside surface`).toBeLessThanOrEqual(
        r!.surfaceRight + 1,
      )
    }
  })
})
