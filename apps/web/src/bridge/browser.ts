/**
 * Class 1 — 浏览器原生等价的桥面。
 *
 * 这些能力在浏览器里直接有对应物，不做布尔门：
 *   - clipboard：navigator.clipboard + execCommand('copy') 降级；
 *   - openExternal / openPreviewInBrowser：window.open；
 *   - fetchLinkTitle：fetch + DOMParser（CORS 受限时返回 ''，与桌面语义一致）；
 *   - notify：Notification API（权限拒绝时静默降级）；
 *   - selectPaths：浏览器 File 拿不到 gateway 侧路径 → 打开本机文件选择框，
 *     选中文件经 saveImageFile 转为 web-blob:// 虚拟路径返回（File 仅存内存
 *     引用、随用随读零落盘；「＋」菜单文件/图片入口）；selectSavePath 返回空；
 *   - zoom：浏览器级缩放（document.body.style.zoom）；
 *   - reportRendererError：console.error（错误边界兜底日志）；
 *   - saveImageFromUrl：fetch → blob → a[download] 浏览器下载（ADR-0010，
 *     此前 denied 返回 false 会吞掉渲染层的下载 fallback）；
 *   - getOnBattery/onBatteryChanged：navigator.getBattery（无 API 时恒 AC）。
 *   - saveImageFile / saveImageBuffer / readFileDataUrl / releaseBlobFile：
 *     附件字节存储二分（ADR-0020，见下方实现注释）。
 */

import type {
  DesktopMarketplaceSearchItem,
  DesktopMarketplaceThemeResult,
  HermesNotification,
  HermesSelectPathsOptions,
} from '@/global'

import { OpfsBlobStore, type AttachmentBlobStore } from './blob-store'
import { fetchMarketplaceThemes, searchMarketplaceThemes } from './vscode-marketplace'

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
  /** 扩展名 → MIME（虚拟 blob 文件的类型推断）。 */
  static readonly EXT_MIME_TYPES: Record<string, string> = {
    '.bmp': 'image/bmp',
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  }

  /** 下载文件名兜底扩展名（blob MIME → 扩展名，与 vendor use-image-download 一致）。 */
  static readonly IMAGE_MIME_EXTENSIONS: Record<string, string> = Object.fromEntries(
    Object.entries(BrowserAdapter.EXT_MIME_TYPES).map(([ext, mime]) => [mime, ext]),
  )

  /** 虚拟路径 → File 引用（ADR-0020：拖入文件保留引用，零常驻字节，
   *  随用随读 arrayBuffer() 瞬态 b64 读完即弃；页面消亡即清）。 */
  static readonly blobFiles = new Map<string, File>()
  static nextBlobId = 0

  /**
   * VS Code Marketplace 主题供应商（vscode-marketplace.ts，浏览器直连官方
   * gallery 接口 + VSIX CDN，二者均回显 Access-Control-Allow-Origin:*）。
   * 渲染层拿到原始主题 JSON 后自行转换/持久化（与桌面同一套 install.ts）。
   */
  readonly themes = {
    searchMarketplace: (query: string): Promise<DesktopMarketplaceSearchItem[]> =>
      searchMarketplaceThemes(query),
    fetchMarketplace: (id: string): Promise<DesktopMarketplaceThemeResult> =>
      fetchMarketplaceThemes(id),
  }

  private readonly blobStore: AttachmentBlobStore

  constructor(blobStore: AttachmentBlobStore = new OpfsBlobStore()) {
    this.blobStore = blobStore
    // 页面载入初始化：清空 web-blobs/ 目录（上一页残留附件，ADR-0020）。
    void this.blobStore.clearAll().catch(() => undefined)
  }

  async requestMicrophoneAccess(): Promise<boolean> {
    // ADR-0022：语音放行——浏览器 getUserMedia 原生处理权限（一次性弹窗）；
    // 无 MediaDevices/录音环境时返回 false（use-mic-recorder 拒绝启动）。
    return Boolean(navigator.mediaDevices?.getUserMedia)
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

  // ── 窗口：用「新 tab」实现桌面「新窗口」语义 ───────────────────────────────
  // 桌面 `openWindow()`（⌘⇧N）开一个完整对等 BrowserWindow；`openSessionWindow`
  // 开一个 `?win=secondary#/<id>` 的副会话窗口。两者在浏览器里都是开一个**同源
  // 新 tab**：同源自动继承 localStorage 连接注册表 + httpOnly 认证 cookie（代理域
  // per-target），天然是同一 gateway 的 peer 实例，凭证零搬运。副会话 URL 契约与
  // 桌面 buildSessionWindowUrl 完全同构（query 在 `#` 前，HashRouter 路由在 `#` 后）。

  /** 当前 SPA 基址（含部署子路径），用于开新 tab。 */
  private windowBaseUrl(): string {
    const path = window.location.pathname.replace(/\/$/, '')
    return `${window.location.origin}${path}/`
  }

  async openSessionWindow(
    sessionId: string,
    opts?: { watch?: boolean },
  ): Promise<{ error?: string; ok: boolean }> {
    const query = `?win=secondary${opts?.watch ? '&watch=1' : ''}`
    const route = `#/${encodeURIComponent(sessionId)}`
    // 同步段开窗（保留用户手势，避免弹窗拦截——见 AGENTS 常见坑）。
    const win = window.open(`${this.windowBaseUrl()}${query}${route}`, '_blank')

    if (!win) {
      return {
        ok: false,
        error: 'Hermes Web: the new tab was blocked by the browser',
      }
    }

    return { ok: true }
  }

  async openWindow(): Promise<{ error?: string; ok: boolean }> {
    const win = window.open(this.windowBaseUrl(), '_blank')

    if (!win) {
      return {
        ok: false,
        error: 'Hermes Web: the new tab was blocked by the browser',
      }
    }

    return { ok: true }
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

  async selectPaths(options?: HermesSelectPathsOptions): Promise<string[]> {
    // 浏览器 File 没有 gateway 侧路径。选中文件经 saveImageFile 持久化为
    // web-blob:// 虚拟路径返回，让渲染层的路径型附加链路（attachContextFilePath /
    // attachImagePath → readFileDataUrl 组合层，ADR-0020）在 Web 走通——「＋」
    // 菜单的文件/图片即此入口。目录（directories）对远端聊天无意义 → 空。
    if (options?.directories) {
      return []
    }

    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = options?.multiple !== false

    const accept = options?.filters
      ?.map((f) => f.extensions.map((ext) => `.${ext.replace(/^\./, '')}`).join(','))
      .filter(Boolean)
      .join(',')

    if (accept) {
      input.accept = accept
    }

    const files = await new Promise<File[]>((resolve) => {
      input.addEventListener('change', () => resolve(Array.from(input.files ?? [])))
      input.addEventListener('cancel', () => resolve([]))
      input.click()
    })

    const paths: string[] = []

    for (const file of files) {
      const saved = await this.saveImageFile(file, file.name || 'file')

      if (saved) {
        paths.push(saved)
      }
    }

    return paths
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

  // ── 附件字节存储（ADR-0020：File 引用 + OPFS；0012 的存储介质延伸）────────
  // 浏览器 File 没有 gateway 侧路径；把附件字节存成“虚拟路径”让渲染层的本地
  // 路径模型（attachImageBlob/attachFileBlob → attachImagePath/attachContextFilePath
  // → attachmentPreviewDataUrl → readFileDataUrl）在 Web 上走通，提交时
  // image.attach_bytes / file.attach 复用 data_url（上游 remote 链路原生支持）。
  //
  // 存储模型二分（ADR-0020）：
  //   - 拖入的 File 磁盘-backed、零常驻字节 → 保留引用存 blobFiles Map，
  //     读时 arrayBuffer() 瞬态进 b64，读完即弃；chip 移除 releaseBlobFile
  //     释放（Map.delete），残留由页面刷新兜底（Map 随页面消亡）。
  //   - 纯内存字节（粘贴图片 / HTML 预览拼接）→ OPFS web-blobs/ 目录落盘
  //     （页面载入初始化清空，无 TTL）；读时 getFile() 瞬态进 b64。
  // 虚拟路径统一 web-blob://attach/<id>/<name>：<id> 仅 Web 内部存储身份
  // （blobFiles Map / OPFS 扁平键唯一），真实文件名永远落在末段——渲染层的
  // pathLabel / imageFilenameFromPath 取 basename 即得干净文件名，不把 <id>
  // 泄漏进上传到 gateway 的 name / filename（桌面端无此前缀）。

  /**
   * 保存附件 File/Blob：File → 保留引用；Blob → OPFS 流式写盘。
   * 返回虚拟路径（web-blob://attach/<id>/<name>）；失败返回 ''。
   */
  async saveImageFile(blob: Blob, name: string): Promise<string> {
    try {
      const id = ++BrowserAdapter.nextBlobId
      const safeName = sanitizeBlobName(name)
      // 分隔符用 '/'：打散到独立路径段，pathLabel / imageFilenameFromPath 取
      // basename 得到干净文件名（<id> 不污染上传名）；OPFS 扁平键仍用 <id>-<name>。
      const path = 'web-blob://attach/' + id + '/' + safeName

      if (blob instanceof File) {
        BrowserAdapter.blobFiles.set(path, blob)
      } else {
        await this.blobStore.write(id + '-' + safeName, blob)
      }

      return path
    } catch {
      return ''
    }
  }

  /** 保存图片字节（保持签名，兼容 HTML 预览调用方）：bytes → Blob → OPFS 写。 */
  async saveImageBuffer(data: ArrayBuffer | Uint8Array, ext: string): Promise<string> {
    try {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
      const mime =
        BrowserAdapter.EXT_MIME_TYPES[ext.toLowerCase()] ?? 'application/octet-stream'
      // slice 出独立 ArrayBuffer：Uint8Array<ArrayBufferLike> 不能直接作 BlobPart。
      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer
      const extSafe = ext.startsWith('.') ? ext : '.' + ext

      return this.saveImageFile(new Blob([buffer], { type: mime }), 'image' + extSafe)
    } catch {
      return ''
    }
  }

  /** 释放虚拟附件字节：File → Map.delete；OPFS → remove()。 */
  async releaseBlobFile(filePath: string): Promise<void> {
    if (BrowserAdapter.blobFiles.delete(filePath)) {
      return
    }

    const name = blobNameFromPath(filePath)

    if (name) {
      await this.blobStore.remove(name).catch(() => undefined)
    }
  }

  /** 虚拟路径命中返回 dataURL（File 瞬态 b64 / OPFS getFile 瞬态 b64）；
   *  非虚拟路径返回 ''（adapter 组合层 fallback 到 gateway REST）。 */
  async readFileDataUrl(filePath: string): Promise<string> {
    try {
      const file = BrowserAdapter.blobFiles.get(filePath)

      if (file) {
        return await blobToDataUrl(file)
      }

      const name = blobNameFromPath(filePath)

      if (name) {
        const blob = await this.blobStore.read(name)

        if (blob) {
          return await blobToDataUrl(blob)
        }
      }
    } catch {
      // 读失败按未命中处理（与桌面取不到返回空一致）。
    }

    return ''
  }

  /** 粘贴剪贴板图片：ClipboardItem → 虚拟路径（无图片 / 无权限返回 ''，
   *  渲染层提示 noClipboardImage，与桌面一致）。 */
  async saveClipboardImage(): Promise<string> {
    try {
      const items = await navigator.clipboard?.read?.()

      if (!items) {
        return ''
      }

      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'))

        if (!type) {
          continue
        }

        const blob = await item.getType(type)
        const ext =
          Object.entries(BrowserAdapter.EXT_MIME_TYPES).find(
            ([, mime]) => mime === blob.type,
          )?.[0] ?? '.png'

        return this.saveImageFile(blob, 'pasted' + ext)
      }

      return ''
    } catch {
      return ''
    }
  }
}

/** FileReader 读 Blob 为 data URL。 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('blob read failed'))
    reader.readAsDataURL(blob)
  })
}

/** 虚拟路径里的文件名消毒：去掉路径分隔符与危险字符（嵌进虚拟路径要可被
 *  pathLabel 当 basename 解析，且 OPFS 文件名不能含 '/' 或 NUL）。 */
function sanitizeBlobName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/^\.+$/, 'file')
      .slice(0, 200) || 'file'
  )
}

/** 从虚拟路径提取 OPFS 扁平文件名（web-blob://attach/<id>/<name> → <id>-<name>，
 *  与 saveImageFile 的 OPFS 写键一致）；非虚拟路径返回 ''。 */
function blobNameFromPath(path: string): string {
  const prefix = 'web-blob://attach/'

  return path.startsWith(prefix) ? path.slice(prefix.length).replace('/', '-') : ''
}

interface BatteryLike {
  charging: boolean
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

type BatteryNavigator = Navigator & { getBattery?: () => Promise<BatteryLike> }
