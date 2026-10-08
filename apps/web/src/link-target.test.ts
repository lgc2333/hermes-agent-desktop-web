import { describe, expect, it, vi } from 'vitest'

/**
 * ADR-0028：Web 构建（`VITE_WEB_BUILD='1'`，vite/vitest define 注入）下
 * `$alwaysExternalLinks` 默认开启 → 链接点击一律走外部浏览器。理由：Web 端内置
 * 预览面板渲染 Electron `<webview>`、桥面归 denied，打开即空白（无出口的死默认）。
 *
 * 这两条断言同时是**上游同步的护栏**：vendor `store/external-links.ts` 的补丁被
 * subtree pull 覆盖掉时它会红（PATCHES.md §4 登记的补丁）。
 */

const KEY = 'hermes.desktop.alwaysExternalLinks.v1'

describe('link target 默认落点（ADR-0028）', () => {
  it('无存储值时 Web 构建默认开启', async () => {
    window.localStorage.removeItem(KEY)
    vi.resetModules()

    const { $alwaysExternalLinks } = await import('@/store/external-links')

    expect($alwaysExternalLinks.get()).toBe(true)
  })

  it('用户显式关闭的存储值优先于默认值', async () => {
    window.localStorage.setItem(KEY, 'false')
    vi.resetModules()

    const { $alwaysExternalLinks } = await import('@/store/external-links')

    expect($alwaysExternalLinks.get()).toBe(false)
  })
})
