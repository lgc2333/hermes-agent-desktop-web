import { test, expect } from './fixtures'
import { startMock, stopByPort, waitForHttp } from './helpers/topology'
import { waitForReady, waitForBodyText, bootClean, gotoHash } from './helpers/bridge'
import { sendChat } from './helpers/chat'

// Regression for the mobile composer overflow fix (apps/web/src/web.css §6b).
// 窄视口下宽 controls 簇会把 grid 撑出 surface，overflow-hidden 裁掉 Send。
// 注入一组 nowrap controls 复现，断言其仍落在 surface 内。

test.describe('composer: mobile right-hand controls stay inside the surface', () => {
  test('composer: mobile double-check surface, keep Send/controls visible', async ({
    page,
    stack,
  }) => {
    // 等价旧 launchMobilePage 的移动视口（390x844）。
    await page.setViewportSize({ width: 390, height: 844 })
    startMock(stack.tokenPort)
    await waitForHttp(`${stack.tokenTarget}/api/status`)
    await page.goto(stack.appUrl)
    await waitForReady(page)
    await bootClean(page)
    await waitForBodyText(page, 'Gateway', { timeout: 60000, label: 'Gateway ready' })
    // 落到聊天页使 composer 挂载。
    await gotoHash(page, '#/')
    await sendChat(page, 'hi')
    await waitForBodyText(page, 'Hello from the mock gateway', {
      timeout: 30000,
      label: 'reply',
    })
    // 注入一次真实较宽的 controls 簇（nowrap 按钮）。
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

    await test.step('keeps Send/controls visible inside the surface with a wide controls cluster', async () => {
      const measure = () =>
        page.evaluate(() => {
          const surface = document.querySelector<HTMLElement>(
            '[data-slot="composer-surface"]',
          )
          const fade = surface?.querySelector<HTMLElement>(
            '[data-slot="composer-fade"]',
          )
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
        // surface 自身不得溢出自身盒…
        expect(
          r!.surfaceScrollW,
          `width ${w}: surface not overflowing`,
        ).toBeLessThanOrEqual(r!.surfaceClientW + 1)
        // …内层 grid 也不得溢出…
        expect(
          r!.gridScrollW,
          `width ${w}: inner grid not overflowing`,
        ).toBeLessThanOrEqual(r!.gridClientW + 1)
        // …controls 簇须可换行…
        expect(r!.controlsWrap, `width ${w}: controls cell wraps`).toBe('wrap')
        // …且 Send 按钮须落在 surface 右缘内。
        expect(r!.sendRight, `width ${w}: Send inside surface`).toBeLessThanOrEqual(
          r!.surfaceRight + 1,
        )
      }
    })

    stopByPort(stack.tokenPort)
  })
})
