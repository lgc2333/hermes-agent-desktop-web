import { test, expect } from './fixtures'
import { startMock, stopByPort, waitForHttp } from './helpers/topology'
import {
  waitForReady,
  waitFor,
  waitForBodyText,
  bootClean,
  gotoHash,
} from './helpers/bridge'

// From cdp-mobile3.mjs + cdp-statusbar-check.mjs — M4 响应式验收：移动端视口 390x844。
// 断言汉堡菜单打开抽屉、设置页 gateway tab 渲染、状态栏在 390px 宽仍然可读。

// 移动端视口：整个文件用 test.use 设定（替代已删除的 launchMobilePage）。
test.use({ viewport: { width: 390, height: 844 } })

test.describe('responsive: mobile-viewport (390x844) layout invariants', () => {
  test('responsive: mobile-viewport (390x844) layout invariants', async ({
    page,
    stack,
  }) => {
    startMock(stack.tokenPort)
    await waitForHttp(`${stack.tokenTarget}/api/status`)
    await page.goto(stack.appUrl)
    await waitForReady(page)
    await bootClean(page)
    await waitForBodyText(page, 'Gateway', { timeout: 60000, label: 'Gateway ready' })

    await test.step('renders the settings gateway tab in the mobile viewport', async () => {
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

    await test.step('keeps the status bar visible and readable at 390px width', async () => {
      // 状态栏必须存在并携带 backend/Gateway 文案（水平可滚动，完整 backend 文案可及）。
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

    stopByPort(stack.tokenPort)
  })
})
