/**
 * Always open links in the system browser — a device-local preference.
 *
 * Off: a clicked web link opens in the in-app browser, and ⌘/Ctrl-click or
 * middle-click escapes to the OS browser. On: every clicked link goes to the OS
 * browser (see `openLink` in `@/lib/external-link`).
 *
 * Web 移植（ADR-0028）：Web 构建默认开启——Web 端内置预览面板是 Electron
 * `<webview>`、桥面归 denied，打开即空白（无出口的死默认）；桌面构建默认仍关。
 *
 * Renderer-owned: it only decides where THIS machine's link clicks land. The
 * `storage` listener keeps every open window in step when one window flips it.
 * Explicit "Open in in-app browser" menu actions and agent-driven previews are
 * not link clicks and stay unaffected.
 */

import { atom } from 'nanostores'

import { persistBoolean, storedBoolean } from '@/lib/storage'

const KEY = 'hermes.desktop.alwaysExternalLinks.v1'

// Web 构建（vite define 注入，同 ADR-0019）默认开启；桌面构建 undefined → false，
// 行为与上游一致（ADR-0028）。
const DEFAULT_ON = import.meta.env.VITE_WEB_BUILD === '1'

export const $alwaysExternalLinks = atom<boolean>(
  typeof window === 'undefined' ? DEFAULT_ON : storedBoolean(KEY, DEFAULT_ON),
)

export function setAlwaysExternalLinks(on: boolean): void {
  $alwaysExternalLinks.set(on)
}

if (typeof window !== 'undefined') {
  $alwaysExternalLinks.subscribe(on => persistBoolean(KEY, on))

  window.addEventListener('storage', event => {
    if (event.key === KEY) {
      $alwaysExternalLinks.set(storedBoolean(KEY, DEFAULT_ON))
    }
  })
}
