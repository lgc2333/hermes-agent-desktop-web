import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildWebBridge, installWebBridge } from './adapter'
import { MemoryBlobStore } from './blob-store'
import { loadRegistry } from './registry'

type Bridge = Window['hermesDesktop']

describe('buildWebBridge / installWebBridge', () => {
  beforeEach(() => {
    window.localStorage.clear()
    delete (window as { hermesDesktop?: unknown }).hermesDesktop
  })

  it('installWebBridge mounts the full typed surface', () => {
    const bridge = installWebBridge()

    expect(window.hermesDesktop).toBe(bridge)
    expect(typeof bridge.getConnection).toBe('function')
    expect(typeof bridge.api).toBe('function')
    expect(typeof bridge.getBootProgress).toBe('function')
    expect(typeof bridge.petOverlay.open).toBe('function')
    expect(typeof bridge.git!.review.list).toBe('function')
    expect(typeof bridge.terminal.start).toBe('function')
  })

  it('bridge satisfies the global type contract (compile-time check)', () => {
    const bridge = buildWebBridge()
    const typed: Bridge = bridge
    expect(typed).toBeDefined()
  })

  it('getConnection returns the seeded mock connection', async () => {
    loadRegistry()
    const bridge = buildWebBridge()
    const conn = await bridge.getConnection()

    expect(conn.baseUrl).toBe(window.location.origin)
    expect(conn.token).toBe('mock-token')
  })

  it('denied members return safe empty shapes instead of undefined', async () => {
    const bridge = buildWebBridge()

    expect(await bridge.petOverlay.open({} as never)).toEqual({ ok: false })
    expect(await bridge.openSessionWindow('s1')).toMatchObject({ ok: false })
    expect(await bridge.quickEntry.getSettings()).toMatchObject({ enabled: false })
    expect(await bridge.updates.check()).toMatchObject({ supported: false })
    expect(await bridge.requestMicrophoneAccess()).toBe(false)
    expect(await bridge.selectPaths()).toEqual([])
  })

  it('denied terminal.start rejects with a clear message (callers show an error state)', async () => {
    const bridge = buildWebBridge()

    await expect(bridge.terminal.start()).rejects.toThrow(
      /not available in the browser/,
    )
  })

  it('subscription members return unsubscribe functions', () => {
    const bridge = buildWebBridge()

    expect(typeof bridge.onBootProgress(() => undefined)).toBe('function')
    expect(typeof bridge.onBackendExit(() => undefined)).toBe('function')
    expect(typeof bridge.petOverlay.onState(() => undefined)).toBe('function')
    expect(typeof bridge.quickEntry.onSubmit(() => undefined)).toBe('function')
  })

  it('browser-native members work without throwing', async () => {
    const bridge = buildWebBridge()

    expect(typeof bridge.openExternal).toBe('function')
    expect(await bridge.fetchLinkTitle('http://127.0.0.1:1/nope')).toBe('')
    expect(bridge.getPathForFile({} as File)).toBe('')
    // 无 Battery API 的测试环境：恒 AC。
    expect(await bridge.getOnBattery!()).toBe(false)
    expect(typeof bridge.onBatteryChanged!(() => undefined)).toBe('function')
  })
})

describe('browser virtual blob files (ADR-0020: saveImageBuffer/saveClipboardImage)', () => {
  // jsdom 无 OPFS：blob 存储注入内存 fake（ADR-0020 存储层抽象）。
  const makeBridge = () => buildWebBridge({}, new MemoryBlobStore())

  it('saveImageBuffer returns a virtual path whose bytes read back as a data URL (no gateway fetch)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const bridge = makeBridge()

    const path = await bridge.saveImageBuffer(new Uint8Array([1, 2, 3]), '.png')
    expect(path).toMatch(/^web-blob:\/\/attach\//)

    const dataUrl = await bridge.readFileDataUrl(path)
    expect(dataUrl).toBe('data:image/png;base64,AQID')
    // 虚拟路径命中内存缓存，不发任何 gateway 请求。
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('readFileDataUrl falls through to gateway REST for non-virtual paths', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ dataUrl: 'data:image/png;base64,AAAA' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const bridge = makeBridge()

    const dataUrl = await bridge.readFileDataUrl('/repo/a.png')
    expect(dataUrl).toBe('data:image/png;base64,AAAA')
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${window.location.origin}/api/fs/read-data-url?path=%2Frepo%2Fa.png`,
    )
    vi.unstubAllGlobals()
  })

  it('saveImageBuffer accepts ArrayBuffer input', async () => {
    const bridge = makeBridge()

    const path = await bridge.saveImageBuffer(new Uint8Array([255]).buffer, '.jpg')
    expect(path).toMatch(/^web-blob:\/\/attach\//)
    expect(await bridge.readFileDataUrl(path)).toBe('data:image/jpeg;base64,/w==')
  })

  it('saveClipboardImage returns empty when the clipboard API is unavailable', async () => {
    const bridge = makeBridge()

    expect(await bridge.saveClipboardImage()).toBe('')
  })

  it('saveClipboardImage reads an image from navigator.clipboard into a virtual path', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    const item = {
      types: ['text/plain', 'image/png'],
      getType: vi.fn(async (type: string) =>
        type === 'image/png' ? blob : new Blob(),
      ),
    }
    ;(navigator as { clipboard?: unknown }).clipboard = {
      read: vi.fn(async () => [item]),
    }
    const bridge = makeBridge()

    const path = await bridge.saveClipboardImage()
    expect(path).toMatch(/^web-blob:\/\/attach\//)
    expect(await bridge.readFileDataUrl(path)).toBe('data:image/png;base64,AQID')
    delete (navigator as { clipboard?: unknown }).clipboard
  })
})
