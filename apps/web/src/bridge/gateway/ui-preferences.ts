/**
 * UI 偏好共享存储（上游 2026-11-03 新增可选桥面 `uiPreferences`）。
 *
 * 桌面端 preload 走 IPC 直连本机 store；浏览器等价物就是 gateway 的
 * `/api/ui-preferences`（GET 读、PATCH 写，经代理转发并带会话凭证）。浏览器没有
 * 推送通道，另一设备 / 原生 Desktop 的改动靠「可见时轮询 + 聚焦即读」拉取
 * （与上游 webapp bridge 同策略，见 vendor `lib/browser-ui-preferences.ts`）。
 *
 * 该面缺席时上游退回 localStorage 快照（boot.ts 的 browserSnapshot 需要 webapp
 * 注入的 bootstrap，本仓为空），故这里必须提供，否则跨设备偏好同步不生效。
 */
import type {
  UiPreferencesBridge,
  UiPreferencesSnapshot,
} from '@/lib/ui-preferences/sync'

import { webApi } from './rest'

const PATH = '/api/ui-preferences'
const POLL_MS = 10_000
const TIMEOUT_MS = 10_000

export function createWebUiPreferences(): UiPreferencesBridge {
  const read = () =>
    webApi<UiPreferencesSnapshot>({ path: PATH, timeoutMs: TIMEOUT_MS })

  return {
    read,
    write: (payload) =>
      webApi<UiPreferencesSnapshot>({
        body: payload,
        method: 'PATCH',
        path: PATH,
        timeoutMs: TIMEOUT_MS,
      }),
    // 聚焦/可见即读，另加低频轮询：gateway 不能推。
    onChanged: (callback) => {
      const poll = () => {
        if (document.visibilityState === 'visible') {
          read().then(callback, () => undefined)
        }
      }

      const timer = window.setInterval(poll, POLL_MS)
      window.addEventListener('focus', poll)
      document.addEventListener('visibilitychange', poll)

      return () => {
        window.clearInterval(timer)
        window.removeEventListener('focus', poll)
        document.removeEventListener('visibilitychange', poll)
      }
    },
  }
}
