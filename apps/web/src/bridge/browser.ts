/**
 * Class 1 — 浏览器原生等价的桥面。
 *
 * 这些能力在浏览器里直接有对应物，不做布尔门：
 *   - clipboard：navigator.clipboard + execCommand('copy') 降级；
 *   - openExternal / openPreviewInBrowser：window.open；
 *   - fetchLinkTitle：fetch + DOMParser（CORS 受限时返回 ''，与桌面语义一致）；
 *   - notify：Notification API（权限拒绝时静默降级）；
 *   - selectPaths/selectSavePath：返回空 —— 浏览器拿不到"gateway 侧路径"，
 *     选了也没意义（M2 起可用 `<input type=file>` 走附件上传管道）；
 *   - zoom：浏览器级缩放（document.body.style.zoom）；
 *   - reportRendererError：console.error（错误边界兜底日志）；
 *   - saveImageFromUrl：fetch → blob → a[download] 浏览器下载（ADR-0010，
 *     此前 denied 返回 false 会吞掉渲染层的下载 fallback）；
 *   - getOnBattery/onBatteryChanged：navigator.getBattery（无 API 时恒 AC）。
 */

import type { HermesNotification } from '@/global'

function safeLocalStorageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // ignore
  }
}

function safeLocalStorageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/** execCommand 降级：旧浏览器 / 非安全上下文没有 navigator.clipboard。 */
function legacyWriteClipboard(text: string): boolean {
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.focus()
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)

    return ok
  } catch {
    return false
  }
}

function legacyReadClipboard(): string {
  try {
    const area = document.createElement('textarea')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.focus()
    document.execCommand('paste')
    const text = area.value
    document.body.removeChild(area)

    return text
  } catch {
    return ''
  }
}

export class BrowserAdapter {
  /** 下载文件名兜底扩展名（blob MIME → 扩展名，与 vendor use-image-download 一致）。 */
  static readonly IMAGE_MIME_EXTENSIONS: Record<string, string> = {
    'image/bmp': '.bmp',
    'image/gif': '.gif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/svg+xml': '.svg',
    'image/webp': '.webp',
  }

  async readClipboard(): Promise<string> {
    try {
      if (navigator.clipboard?.readText) {
        return await navigator.clipboard.readText()
      }
    } catch {
      // Permission denied or insecure context — fall through to legacy.
    }

    return legacyReadClipboard()
  }

  async writeClipboard(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)

        return true
      }
    } catch {
      // fall through to legacy
    }

    return legacyWriteClipboard(text)
  }

  async openExternal(url: string): Promise<void> {
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  async openPreviewInBrowser(url: string): Promise<void> {
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  async fetchLinkTitle(url: string): Promise<string> {
    try {
      const res = await fetch(url, {
        mode: 'cors',
        signal: AbortSignal.timeout(10_000),
      })

      if (!res.ok) {
        return ''
      }

      const html = await res.text()
      const doc = new DOMParser().parseFromString(html, 'text/html')
      const title = doc.querySelector('title')?.textContent?.trim()

      return title ?? ''
    } catch {
      // CORS 受限 / 网络失败 —— 与桌面"取不到就空"语义一致。
      return ''
    }
  }

  async notify(payload: HermesNotification): Promise<boolean> {
    if (!('Notification' in window)) {
      return false
    }

    try {
      if (Notification.permission === 'granted') {
        new Notification(payload.title ?? 'Hermes', {
          body: payload.body,
          silent: payload.silent ?? true,
          tag: payload.tag,
        })

        return true
      }

      if (Notification.permission === 'default') {
        const permission = await Notification.requestPermission()

        if (permission === 'granted') {
          new Notification(payload.title ?? 'Hermes', {
            body: payload.body,
            silent: payload.silent ?? true,
            tag: payload.tag,
          })

          return true
        }
      }
    } catch {
      // Some browsers throw on Notification construction in odd contexts.
    }

    return false
  }

  async selectPaths(): Promise<string[]> {
    // 浏览器 File 对象没有 gateway 侧路径；选择对远端聊天无意义 → 空。
    return []
  }

  async selectSavePath(): Promise<string | null> {
    return null
  }

  getPathForFile(): string {
    return ''
  }

  async getZoom(): Promise<{ level: number; percent: number }> {
    return { level: 1, percent: 100 }
  }

  setZoomPercent(_percent: number): void {
    // Browser pages can't meaningfully zoom the Electron window; the layout
    // is responsive. Keep the interface present so the statusbar zoom pill
    // stays truthful (always 100%).
  }

  onZoomChanged(
    _callback: (payload: { level: number; percent: number }) => void,
  ): () => void {
    return () => undefined
  }

  reportRendererError(report: {
    label: string
    boundary: string
    message: string
    componentStack: string
  }): void {
    console.error(
      '[hermes-web renderer error]',
      report.label,
      report.boundary,
      report.message,
      report.componentStack,
    )
    safeLocalStorageSet(
      'hermes-web.last-renderer-error',
      JSON.stringify({ ...report, at: Date.now() }).slice(0, 4000),
    )
  }

  getRecentLogs(): { path: string; lines: string[] } {
    const raw = safeLocalStorageGet('hermes-web.last-renderer-error')

    return {
      path: 'localStorage://hermes-web.last-renderer-error',
      lines: raw ? [raw] : [],
    }
  }

  /**
   * 保存图片 = 浏览器下载（ADR-0010：此前 denied 返回 false 被渲染层当作
   * "用户取消"，use-image-download 的浏览器下载 fallback 永远走不到）。
   * 语义与桌面"保存对话框"对齐：成功返回 true（渲染层通知已保存），失败
   * 返回 false（静默，与桌面取消一致）。
   */
  async saveImageFromUrl(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })

      if (!res.ok) {
        return false
      }

      const blob = await res.blob()
      const base =
        decodeURIComponent(url.split(/[\\/]/).pop() ?? '').split('?')[0] || 'image'
      const ext =
        BrowserAdapter.IMAGE_MIME_EXTENSIONS[
          blob.type.split(';')[0].trim().toLowerCase()
        ] ?? ''
      const href = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = href
      link.download = /\.[a-z0-9]{2,5}$/i.test(base) ? base : base + ext
      link.rel = 'noopener noreferrer'
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(href), 30_000)

      return true
    } catch {
      return false
    }
  }

  // ── 电池（navigator.getBattery，非标准 API，类型自行声明）───────────────

  async getOnBattery(): Promise<boolean> {
    try {
      const battery = await (navigator as BatteryNavigator).getBattery?.()

      return battery ? !battery.charging : false
    } catch {
      return false
    }
  }

  onBatteryChanged(callback: (onBattery: boolean) => void): () => void {
    let unsub = () => undefined

    try {
      void (navigator as BatteryNavigator)
        .getBattery?.()
        .then((battery) => {
          if (!battery) {
            return
          }

          const onChange = () => callback(!battery.charging)
          battery.addEventListener('chargingchange', onChange)
          battery.addEventListener('levelchange', onChange)
          unsub = () => {
            battery.removeEventListener('chargingchange', onChange)
            battery.removeEventListener('levelchange', onChange)
          }
        })
        .catch(() => undefined)
    } catch {
      // 无 Battery API —— 保持恒 AC（false），与 denied 行为一致。
    }

    return unsub
  }
}

interface BatteryLike {
  charging: boolean
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

type BatteryNavigator = Navigator & { getBattery?: () => Promise<BatteryLike> }
