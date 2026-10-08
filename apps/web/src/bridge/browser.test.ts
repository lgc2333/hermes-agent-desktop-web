import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MemoryBlobStore, OpfsBlobStore, WEB_BLOBS_DIR } from './blob-store'
import { BrowserAdapter, resetLogRing } from './browser'

/**
 * ADR-0020 桥面 TDD：附件字节存储二分（File 引用 + OPFS）。
 *
 * 用 MemoryBlobStore 注入（jsdom 无 OPFS）验证行为契约；OpfsBlobStore 用
 * fake 目录 handle 验证 OPFS 语义（clearAll / write / read / remove）。
 */

describe('blobStore 抽象', () => {
  it('memoryBlobStore 行为等价：写读删清', async () => {
    const store = new MemoryBlobStore()
    const blob = new Blob(['hello'], { type: 'text/plain' })

    await store.write('a.txt', blob)
    expect(await store.read('a.txt')).not.toBeNull()
    expect((await store.read('a.txt'))?.text).toBeDefined()

    await store.remove('a.txt')
    expect(await store.read('a.txt')).toBeNull()

    await store.write('b.txt', blob)
    await store.clearAll()
    expect(store.names()).toEqual([])
  })

  it('opfsBlobStore 用 navigator.storage.getDirectory 落到 web-blobs/ 目录', async () => {
    const files = new Map<string, { data: string; blob: Blob | null }>()
    const dirHandle = {
      entries: vi.fn(async function* () {
        for (const [name, entry] of files) {
          yield [name, entry]
        }
      }),
      getDirectoryHandle: vi.fn(
        async (name: string, options?: { create?: boolean }) => {
          if (options?.create !== false && options?.create !== undefined) {
            // sub directory handle not exercised here
          }
          throw new Error('not a directory op')
        },
      ),
      getFileHandle: vi.fn(async (name: string) => ({
        createWritable: vi.fn(async () => ({
          write: vi.fn(async (data: Blob) => {
            files.set(name, { data: await data.text(), blob: data })
          }),
          close: vi.fn(async () => undefined),
        })),
        getFile: vi.fn(async () => {
          const entry = files.get(name)

          if (!entry) {
            throw new Error('not found')
          }

          return new Blob([entry.data], { type: 'text/plain' })
        }),
      })),
      removeEntry: vi.fn(async (name: string) => {
        files.delete(name)
      }),
    }
    const rootHandle = {
      getDirectoryHandle: vi.fn(async (name: string) => {
        expect(name).toBe(WEB_BLOBS_DIR)
        return dirHandle
      }),
    }
    const storage = { getDirectory: vi.fn(async () => rootHandle) }
    vi.stubGlobal('navigator', { storage } as never)

    const store = new OpfsBlobStore()

    await store.write(
      'x/1.txt'.replace('/', '-'),
      new Blob(['abc'], { type: 'text/plain' }),
    )
    const readBack = await store.read('x-1.txt')
    expect(await readBack?.text()).toBe('abc')

    await store.clearAll()
    expect(files.size).toBe(0)
    vi.unstubAllGlobals()
  })
})

describe('browserAdapter 附件存储（ADR-0020）', () => {
  const makeAdapter = (store = new MemoryBlobStore()) => new BrowserAdapter(store)

  it('saveImageFile 对 File 保留引用（Map 命中，读回瞬态 b64）', async () => {
    const store = new MemoryBlobStore()
    const adapter = makeAdapter(store)
    const file = new File(['hello'], 'report.pdf', { type: 'application/pdf' })

    const path = await adapter.saveImageFile(file, 'report.pdf')
    expect(path).toMatch(/^web-blob:\/\/attach\/\d+\/report\.pdf$/)

    // File 分支不写 OPFS：web-blobs/ 目录应为空。
    expect(store.names()).toEqual([])

    const dataUrl = await adapter.readFileDataUrl(path)
    expect(dataUrl).toBe('data:application/pdf;base64,aGVsbG8=')
  })

  it('saveImageFile 对 Blob 走 OPFS 落盘（MemoryBlobStore 命中，读回瞬态 b64）', async () => {
    const store = new MemoryBlobStore()
    const adapter = makeAdapter(store)
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })

    const path = await adapter.saveImageFile(blob, 'pasted.png')
    expect(path).toMatch(/^web-blob:\/\/attach\/\d+\/pasted\.png$/)

    // Blob 分支不入 File 引用表：readFileDataUrl 从 OPFS 读。
    expect(store.names()).toHaveLength(1)
    expect(store.names()[0]).toMatch(/^\d+-pasted\.png$/)

    const dataUrl = await adapter.readFileDataUrl(path)
    expect(dataUrl).toBe('data:image/png;base64,AQID')
  })

  it('readFileDataUrl 对虚拟路径未命中返回空串（组合层兜底 gateway REST 不变）', async () => {
    const adapter = makeAdapter()

    expect(await adapter.readFileDataUrl('web-blob://attach/999-nope.pdf')).toBe('')
    expect(await adapter.readFileDataUrl('/repo/real.pdf')).toBe('')
  })

  it('releaseBlobFile 释放 File 引用（Map.delete：再读返回空）', async () => {
    const adapter = makeAdapter()
    const file = new File(['hello'], 'report.pdf', { type: 'application/pdf' })
    const path = await adapter.saveImageFile(file, 'report.pdf')

    await adapter.releaseBlobFile(path)
    expect(await adapter.readFileDataUrl(path)).toBe('')
  })

  it('releaseBlobFile 释放 OPFS 文件（remove：再读返回空）', async () => {
    const store = new MemoryBlobStore()
    const adapter = makeAdapter(store)
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    const path = await adapter.saveImageFile(blob, 'pasted.png')

    await adapter.releaseBlobFile(path)
    expect(await adapter.readFileDataUrl(path)).toBe('')
    expect(store.names()).toEqual([])
  })

  it('saveImageBuffer 保留签名：bytes → Blob → OPFS 写，readFileDataUrl 读回', async () => {
    const store = new MemoryBlobStore()
    const adapter = makeAdapter(store)

    const path = await adapter.saveImageBuffer(new Uint8Array([1, 2, 3]), '.png')
    expect(path).toMatch(/^web-blob:\/\/attach\//)
    expect(store.names()).toHaveLength(1)
    expect(await adapter.readFileDataUrl(path)).toBe('data:image/png;base64,AQID')
  })

  it('savePastedText 写 OPFS 并返回虚拟路径（干净 .txt 名，读回原文）', async () => {
    const store = new MemoryBlobStore()
    const adapter = makeAdapter(store)

    const path = await adapter.savePastedText('hello paste')
    // web-blob://attach/<id>/pasted_content_<时间戳>_<随机>.txt：Blob id 在独立
    // 路径段，末段即上传给 gateway 的干净文件名。
    expect(path).toMatch(/^web-blob:\/\/attach\/\d+\/pasted_content_[\w-]+\.txt$/)
    expect(store.names()).toHaveLength(1)

    const dataUrl = await adapter.readFileDataUrl(path)
    expect(dataUrl.startsWith('data:text/plain;base64,')).toBe(true)
    expect(atob(dataUrl.split(',')[1])).toBe('hello paste')
  })

  it('savePastedText 对空文本返回空串（渲染层退回内联粘贴）', async () => {
    const adapter = makeAdapter()

    expect(await adapter.savePastedText('')).toBe('')
  })

  it('页面载入初始化：构造时清空 web-blobs/ 目录（上一页残留不泄漏）', async () => {
    const store = new MemoryBlobStore()
    store.write('stale-from-previous-page.bin', new Blob(['x']))

    makeAdapter(store)
    expect(store.names()).toEqual([])
  })

  it('虚拟路径末段是干净上传名：pathLabel 取 basename 不带 Blob id（供 file.attach name / image filename）', async () => {
    const adapter = makeAdapter()
    const file = new File(['hello'], 'quarterly report.pdf', {
      type: 'application/pdf',
    })

    const path = await adapter.saveImageFile(file, 'quarterly report.pdf')
    // web-blob://attach/<id>/<name>：末段 = <name>（Blob id 在独立路径段，不污染上传名）。
    const basename = path.split('/').filter(Boolean).pop()
    expect(basename).toBe('quarterly report.pdf')
  })
})

/**
 * A/C 组新增浏览器等价面（ADR-0027）：机器画像、嵌入 host origin、
 * logLine/getRecentLogs 环形缓冲、图片右键复制、外部打开失败广播。
 */
describe('browserAdapter — A/C 组新增面', () => {
  const makeAdapter = (store = new MemoryBlobStore()) => new BrowserAdapter(store)

  beforeEach(() => {
    resetLogRing()
    // getRecentLogs 在环形缓冲为空时回落到 localStorage 的上次错误快照 ——
    // 清掉它，让「缓冲为空」这一断言有确定性。
    window.localStorage.clear()
  })

  it('getMachineProfile 用 navigator.language 推断首启语言（其余字段留空）', async () => {
    const adapter = makeAdapter()
    const profile = await adapter.getMachineProfile()

    expect(profile.locale).toBe(navigator.language)
    expect(profile.locale).toBeTruthy()
    expect(profile.platform).toBe('web')
    expect(profile.ageDays).toBeNull()
    expect(profile.nvidia).toBe(false)
  })

  it('getEmbedHostOrigin 返回当前 origin', async () => {
    const adapter = makeAdapter()

    expect(await adapter.getEmbedHostOrigin()).toBe(window.location.origin)
  })

  it('logLine → getRecentLogs 环形缓冲往返；reportRendererError 也进缓冲', async () => {
    const adapter = makeAdapter()

    expect(adapter.getRecentLogs().lines).toEqual([])

    adapter.logLine('first line')
    adapter.reportRendererError({
      label: 'chat',
      boundary: 'MessageList',
      message: 'boom',
      componentStack: 'at X',
    })

    const logs = adapter.getRecentLogs()
    expect(logs.path).toBe('memory://hermes-web.log')
    expect(logs.lines[0]).toBe('first line')
    expect(logs.lines[1]).toContain('[renderer error:chat]')
  })

  it('logLine 超限丢弃最旧（环形）', async () => {
    const adapter = makeAdapter()

    for (let i = 0; i < 520; i += 1) {
      adapter.logLine(`line-${i}`)
    }

    const lines = adapter.getRecentLogs().lines
    expect(lines).toHaveLength(500)
    expect(lines[0]).toBe('line-20')
    expect(lines.at(-1)).toBe('line-519')
  })

  it('contextMenuCopyImage 复制最近一次右键手势下的同源图片', async () => {
    const adapter = makeAdapter()
    const write = vi.fn(async () => undefined)

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write },
    })
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(readonly items: Record<string, Blob>) {}
      },
    )
    const fetchMock = vi.fn(async () => ({
      // 最小响应形状：**不要**经 `new Response(blob)` —— undici 对 jsdom Blob 的
      // 处理随 Node 版本而变（Node 26 会静默把 body 串成 '[object Blob]'，
      // CI 的 Node 22 直接失败），会掩盖被测逻辑。
      blob: async () => new Blob(['png'], { type: 'image/png' }),
      ok: true,
    }))
    vi.stubGlobal('fetch', fetchMock)

    try {
      // 没有手势 → 什么都不做。
      await adapter.contextMenuCopyImage()
      expect(write).not.toHaveBeenCalled()

      const image = document.createElement('img')
      image.src = `${window.location.origin}/api/fs/read?path=a.png`
      document.body.appendChild(image)
      image.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))

      await adapter.contextMenuCopyImage()

      expect(fetchMock).toHaveBeenCalledWith(image.src, expect.anything())
      expect(write).toHaveBeenCalledTimes(1)
      const [items] = write.mock.calls[0] as unknown as [
        { items: Record<string, Blob> }[],
      ]
      expect(Object.keys(items[0].items)).toEqual(['image/png'])
      image.remove()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('contextMenuCopyImage 跨域/无权限时静默（best-effort，不抛）', async () => {
    const adapter = makeAdapter()

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: vi.fn(async () => {
          throw new Error('NotAllowedError')
        }),
      },
    })
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(readonly items: Record<string, Blob>) {}
      },
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        blob: async () => new Blob(['png'], { type: 'image/png' }),
        ok: true,
      })),
    )

    try {
      const image = document.createElement('img')
      image.src = `${window.location.origin}/x.png`
      document.body.appendChild(image)
      image.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))

      await expect(adapter.contextMenuCopyImage()).resolves.toBeUndefined()
      expect(adapter.getRecentLogs().lines.at(-1)).toContain(
        '[context-menu:copy-image]',
      )
      image.remove()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('contextMenuCopyImage 非 PNG 走 canvas 重编码（Chromium 只收 image/png）', async () => {
    const adapter = makeAdapter()
    const write = vi.fn(async () => undefined)

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write },
    })
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(readonly items: Record<string, Blob>) {}
      },
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        blob: async () => new Blob(['gif'], { type: 'image/gif' }),
        ok: true,
      })),
    )
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ close: vi.fn(), height: 4, width: 4 })),
    )
    const toBlob = vi.fn((cb: (b: Blob | null) => void) =>
      cb(new Blob(['png'], { type: 'image/png' })),
    )
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage: vi.fn() } as never)
    const canvasToBlob = vi
      .spyOn(HTMLCanvasElement.prototype, 'toBlob')
      .mockImplementation(toBlob as never)

    try {
      const image = document.createElement('img')
      image.src = `${window.location.origin}/x.gif`
      document.body.appendChild(image)
      image.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))

      await adapter.contextMenuCopyImage()

      expect(canvasToBlob).toHaveBeenCalled()
      expect(write).toHaveBeenCalledTimes(1)
      image.remove()
    } finally {
      getContext.mockRestore()
      canvasToBlob.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('onExternalOpenFailed 在 window.open 被拦时广播 URL', async () => {
    const adapter = makeAdapter()
    const seen: { url: string }[] = []
    const unsubscribe = adapter.onExternalOpenFailed((payload) => seen.push(payload))

    const openMock = vi.fn(() => null)
    vi.stubGlobal('open', openMock)

    try {
      await adapter.openExternal('https://example.com/deep')
      await adapter.openPreviewInBrowser('https://example.com/preview')

      expect(seen.map((p) => p.url)).toEqual([
        'https://example.com/deep',
        'https://example.com/preview',
      ])
    } finally {
      vi.unstubAllGlobals()
    }

    unsubscribe()
    vi.stubGlobal(
      'open',
      vi.fn(() => null),
    )

    try {
      await adapter.openExternal('https://example.com/after-unsub')
      expect(seen).toHaveLength(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('onExternalOpenFailed 在开窗成功时不广播', async () => {
    const adapter = makeAdapter()
    const seen: unknown[] = []
    adapter.onExternalOpenFailed((payload) => seen.push(payload))

    vi.stubGlobal(
      'open',
      vi.fn(() => ({ closed: false })),
    )

    try {
      await adapter.openExternal('https://example.com/ok')
      expect(seen).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('onNotificationActivate 在通知被点击时回传可跳转字段（C 组）', async () => {
    const adapter = makeAdapter()
    const seen: unknown[] = []
    const unsubscribe = adapter.onNotificationActivate((payload) => seen.push(payload))

    const instances: { onclick?: () => void }[] = []

    class FakeNotification {
      static permission = 'granted'
      static requestPermission = vi.fn(async () => 'granted')
      onclick?: () => void

      constructor(
        readonly title: string,
        readonly options: unknown,
      ) {
        instances.push(this)
      }
    }

    vi.stubGlobal('Notification', FakeNotification)

    try {
      const shown = await adapter.notify({
        activate: '#/chat/1',
        notifyId: 'n1',
        tag: 'plugin-x',
        title: 'Done',
      })

      expect(shown).toBe(true)
      expect(instances).toHaveLength(1)
      expect(typeof instances[0].onclick).toBe('function')

      instances[0].onclick?.()
      // actionId 恒不派发：浏览器通知没有按钮语义。
      expect(seen).toEqual([{ activate: '#/chat/1', notifyId: 'n1', tag: 'plugin-x' }])

      unsubscribe()
      instances[0].onclick?.()
      expect(seen).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('onNotificationActivate 无跳转目标的通知不订阅 onclick', async () => {
    const adapter = makeAdapter()
    const instances: { onclick?: () => void }[] = []

    class FakeNotification {
      static permission = 'granted'
      onclick?: () => void

      constructor() {
        instances.push(this)
      }
    }

    vi.stubGlobal('Notification', FakeNotification)

    try {
      await adapter.notify({ body: 'no target', title: 'Plain' })
      expect(instances).toHaveLength(1)
      expect(instances[0].onclick).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
