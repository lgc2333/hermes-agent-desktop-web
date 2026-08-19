import { test, expect } from './fixtures'
import { startMock, stopByPort, waitForHttp } from './helpers/topology'
import { waitForReady, waitFor, waitForBodyText, bootClean } from './helpers/bridge'

// From cdp-find.mjs — ADR-0019: web build 下 vendor find.shortcut 被禁用，Ctrl+F 不得
// 打开 vendor find-bar（[role="search"] 覆盖层），应交给浏览器原生查找接管。
// 用 plain token mock，免登录即可 boot。

// 自包含页面表达式（只用页面全局）——find 覆盖层是一个 [role="search"] 元素。
const noFindBar = () => !document.querySelector('[role="search"]')

test.describe('find: Ctrl+F does not open the vendor find-bar (ADR-0019)', () => {
  test('find: Ctrl+F does not open the vendor find-bar (ADR-0019)', async ({
    page,
    stack,
  }) => {
    startMock(stack.tokenPort)
    await waitForHttp(`${stack.tokenTarget}/api/status`)
    await page.goto(stack.appUrl)
    await waitForReady(page)
    await bootClean(page)
    await waitForBodyText(page, 'Gateway', { timeout: 60000, label: 'Gateway ready' })

    await test.step('does not preventDefault a synthetic Ctrl+F keydown (native find not swallowed)', async () => {
      // vendor dispatch 必须保留 defaultPrevented=false，浏览器原生 find 才能接管。
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
      // 合成按键之后也不出现 find-bar。
      expect(await page.evaluate(noFindBar)).toBe(true)
    })

    await test.step('shows no find-bar overlay after a real Control+f', async () => {
      await page.keyboard.press('Control+f')
      await page.waitForTimeout(1200)
      expect(await page.evaluate(noFindBar)).toBe(true)
    })

    await test.step('regression: Ctrl+K still opens the command palette dialog', async () => {
      // 调色板是 Radix dialog；稳定语义锚点是其内部 search input 的 placeholder。
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

    stopByPort(stack.tokenPort)
  })
})
