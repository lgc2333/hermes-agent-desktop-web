import { test, expect } from './fixtures'
import type { Page } from './fixtures'
import { startMock, stopByPort, waitForHttp } from './helpers/topology'
import { waitForReady, gotoHash } from './helpers/bridge'
import { sendChat } from './helpers/chat'

/**
 * ADR-0028：Web 端链接默认落点 = 外部浏览器（Web 构建默认开启
 * `$alwaysExternalLinks`），且外开不再误报（`noopener` 形态的 `window.open`
 * 恒返回 null，曾被桥当成"弹窗被拦"→ 每次点击都弹「无法打开此链接」）。
 *
 * 断言用真实浏览器行为，不依赖外网：
 *   - 触发：prompt 带 `link-probe` → mock 回一条含 markdown 外链的消息
 *     （见 dev/mock-gateway.mjs）；
 *   - 目标 URL 由 context 级路由兜住（弹窗是新 page，page 级路由抓不到）；
 *   - 内置预览面板打开的判据：DOM 里出现 Electron 专属 `<webview>` 元素
 *     （Web 桥该面归 denied，面板必然空白）。
 */

const TARGET_HOST_RE = /link-target\.test/
const LINK_SELECTOR = 'a[href^="https://link-target.test"]'
const FAILURE_DIALOG_RE = /open this link|无法打开此链接/i

/**
 * 关掉常驻通知浮层。必须在页内点：`getByRole(...).click()` 会被浮层自身拦下而
 * 静默失败（`.catch` 吞掉），点不到关闭按钮。
 */
async function dismissNotices(page: Page): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    const found = await page.evaluate(() => {
      const target = [...document.querySelectorAll('button')].find((button) =>
        /dismiss notification|关闭通知/i.test(
          button.getAttribute('aria-label') ?? button.textContent ?? '',
        ),
      )
      target?.click()

      return Boolean(target)
    })

    if (!found) {
      break
    }

    await page.waitForTimeout(200)
  }
}

/**
 * 点聊天里的外链：先关通知浮层，再把链接滚到视口**中央**（浮层固定在顶部居中，
 * `click()` 只把元素滚到视口边缘 → 元素落在浮层下会一直超时）。
 */
async function clickLink(page: Page, modifiers: 'Control'[] = []): Promise<void> {
  await dismissNotices(page)
  await page.evaluate((selector) => {
    document.querySelector(selector)?.scrollIntoView({ block: 'center' })
  }, LINK_SELECTOR)
  await page.locator(LINK_SELECTOR).first().click({ modifiers })
}

test.describe('links: Web 端默认落点 = 外部浏览器（ADR-0028）', () => {
  test('普通点击与 Ctrl 点击都开外部新标签，不开内置预览、不弹失败对话框', async ({
    page,
    stack,
  }) => {
    startMock(stack.tokenPort)
    await waitForHttp(`${stack.tokenTarget}/api/status`)

    await page
      .context()
      .route('https://link-target.test/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<h1>link target</h1>' }),
      )

    await page.goto(stack.appUrl)
    await waitForReady(page)
    // 与 reconnect/smoke 同款：不清注册表——boot 的默认 seed（VITE_MOCK_GATEWAY_WS）
    // 就指向本 worker 的 token mock；清注册表会把应用打回 onboarding。
    await gotoHash(page, '#/')

    await test.step('聊天回复里的外链渲染为可点击链接', async () => {
      await sendChat(page, 'link-probe: give me a link')
      await expect(page.locator(LINK_SELECTOR).first()).toBeVisible({ timeout: 30000 })
    })

    await test.step('普通点击 → 外部新标签（不开内置预览、不弹失败对话框）', async () => {
      // 用 context 级 `page` 事件而非 `page` 级 `popup`：桥刻意把 `win.opener`
      // 置 null（等价 noopener 隔离），popup 事件因此失去 opener 归属不会触发。
      const popupPromise = page.context().waitForEvent('page')
      await clickLink(page)
      const popup = await popupPromise

      await expect(popup).toHaveURL(TARGET_HOST_RE)
      await popup.close()
      await page.waitForTimeout(800)

      // 内置预览面板未开（<webview> 是 Electron 专属元素，Web 端只可能是空白面板）。
      expect(
        await page.evaluate(() => document.querySelector('webview') === null),
      ).toBe(true)
      // 外开未被误报（修复前这里每次点击都弹对话框）。
      expect(
        await page.evaluate(
          (re) => new RegExp(re, 'i').test(document.body.innerText),
          FAILURE_DIALOG_RE.source,
        ),
      ).toBe(false)
    })

    await test.step('Ctrl 点击也走外部（设置默认开启 = 一律外部）', async () => {
      const popupPromise = page.context().waitForEvent('page')
      await clickLink(page, ['Control'])
      const popup = await popupPromise

      await expect(popup).toHaveURL(TARGET_HOST_RE)
      await popup.close()
      await page.waitForTimeout(800)

      expect(
        await page.evaluate(() => document.querySelector('webview') === null),
      ).toBe(true)
    })

    stopByPort(stack.tokenPort)
  })
})
