import { test, expect } from './fixtures'
import { waitForReady, waitFor, gotoHash } from './helpers/bridge'
import { clearRegistry } from './helpers/registry'

// From cdp-dev-remote.mjs — "dev:remote" 形态：SPA 经共享代理 boot，但无任何 gateway 在跑，
// 因此到达 boot-failure 恢复面，同时设置页仍须可用。这里不启 mock：全局 proxy + Vite 已就位，
// 只是缺 gateway。
//
// 断言刻意宽容：不断言覆盖层精确文案，只要求 boot 解析到可用的 recovery/settings 面，
// 且设置页 gateway tab 渲染其连接 UI。
test.describe('dev-remote: no gateway, boot-failure recovery + usable settings', () => {
  test('dev-remote: no gateway, boot-failure recovery + usable settings', async ({
    page,
    stack,
  }) => {
    await page.goto(stack.appUrl)
    await waitForReady(page, 60000)
    // 从干净注册表出发（避免跨套件污染）再重新 boot。
    await clearRegistry(page)
    await page.reload()
    await waitForReady(page, 60000)

    await test.step('reaches the boot-failure recovery surface when no gateway is available', async () => {
      // 宽容：要么 boot-failure 覆盖层浮现，要么应用已足够可用、设置 gateway 面渲染
      // （例如恢复卡内嵌 gateway 连接表单而非裸覆盖层）。
      const recovered = await waitFor(
        page,
        () => {
          const bar = document.querySelector('[data-slot="statusbar"]')
          const bootFailure =
            bar && /gateway/i.test(bar.innerText) && document.body.innerText.length > 0
          // cdp-dev-remote 的覆盖层启发式：全屏 fixed 恢复卡。
          const overlay = [...document.querySelectorAll('.fixed.inset-0')].some(
            (e) => (e.textContent ?? '').length > 0,
          )
          return bootFailure || overlay ? true : null
        },
        { timeout: 45000, label: 'boot-failure recovery surface' },
      )
      expect(recovered).toBe(true)
    })

    await test.step('keeps the settings gateway tab usable with no gateway', async () => {
      await gotoHash(page, '#/settings?tab=gateway')
      const usable = await waitFor(
        page,
        () => {
          // 连接 UI：gateway URL 输入框（placeholder 来自 gateway-settings）或
          // "Remote gateway" mode 标签。
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
})
