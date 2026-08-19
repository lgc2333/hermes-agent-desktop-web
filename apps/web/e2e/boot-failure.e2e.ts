import { test, expect } from './fixtures'
import { waitFor, waitForReady } from './helpers/bridge'
import { setRegistry, tokenRegistry } from './helpers/registry'

// Ported from cdp-deadgw.mjs / cdp-local-btn.mjs / cdp-hide-modes.mjs /
// cdp-hide-local.mjs / cdp-repair-logs.mjs — Web「boot failure」面。
//
// 连接目标是刻意不可达的 URL，所以不启 mock：应用 boot 进 boot-failure 覆盖层
// （web.css 隐藏桌面专属恢复入口："Use local gateway" / "Repair install" /
// "Open logs"，只留 remote Connection-mode 卡）。
//
// 默认 UI locale 是 English（DEFAULT_LOCALE = 'en'），断言用 en.ts 文案
// （"Remote gateway" / "Retry" / "Gateway settings" …）。
test.describe('boot-failure: unreachable gateway overlay + recovery hiding', () => {
  test('boot-failure: unreachable gateway overlay + recovery hiding', async ({
    page,
    stack,
  }) => {
    await page.goto(stack.appUrl)
    await waitForReady(page)
    // 注入不可达 remote target 后 reload → boot 进 boot-failure。
    await setRegistry(page, tokenRegistry('http://127.0.0.1:9'))
    await page.reload()
    await waitForReady(page)

    await test.step('shows the boot-failure overlay with a recovery button row', async () => {
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

      // 恢复按钮在覆盖层内的 flex flex-wrap gap-2 行里。
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
      // remote 不可达分支渲染 [Gateway settings, Retry, Use local gateway, Open logs]；
      // web.css 隐藏 use-local + open-logs，只留 Gateway settings + Retry 可见。
      expect(row).toContain('Retry')
    })

    await test.step('hides "Use local gateway" from the recovery surface (web.css)', async () => {
      // 覆盖层已活跃（Retry 可见），缺失 "Use local gateway" 是真实断言而非空页误报。
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

    await test.step('shows only the remote Connection-mode card (no local-gateway entry)', async () => {
      // 打开内嵌的 "Gateway settings" 恢复视图——它渲染与独立设置页相同的
      // GatewaySettings mode 卡（.grid.auto-rows-fr.grid-cols-1 容器），web.css 只留 remote。
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

      // Mode 卡容器：4 个按钮 [local, cloud, remote, ssh]，只显示 remote（第 3 个）。
      // 按 computed display 断言可见卡集合，而非脆弱的布局细节。
      const visibleCards = await waitFor(
        page,
        () => {
          const cards = [
            ...document.querySelectorAll('.grid.auto-rows-fr.grid-cols-1 > button'),
          ]
          if (cards.length === 0) return null
          return cards
            .filter((b) => getComputedStyle(b).display !== 'none')
            .map((b) => b.innerText.trim().split('\n')[0].trim())
        },
        { timeout: 30000, label: 'connection mode cards' },
      )
      expect(visibleCards).toEqual(['Remote gateway'])
    })

    await test.step('is absent of "Repair install" / "Open logs" on the remote unreachable branch', async () => {
      // cdp-repair-logs：LOCAL 失败分支是 [Retry, Repair, Settings, Open logs]，
      // web.css 隐藏 Repair + Open logs；REMOTE 分支根本不渲染 "Repair install"，
      // "Open logs" 被 CSS 隐藏。此处断言 remote 分支两者都缺席。
      const bodyText = await page.evaluate(() => document.body.innerText)
      expect(bodyText).not.toContain('Repair install')
      expect(bodyText).not.toContain('Open logs')
    })
  })
})
