import { beforeEach, describe, expect, it } from 'vitest'

import { buildWebBridge, installWebBridge } from './adapter'
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

    expect(conn.baseUrl).toBe('http://127.0.0.1:5180')
    expect(conn.token).toBe('mock-token')
  })

  it('denied members return safe empty shapes instead of undefined', async () => {
    const bridge = buildWebBridge()

    expect(await bridge.readDir('/')).toEqual({ entries: [] })
    expect(await bridge.git!.repoStatus('/repo')).toBeNull()
    expect(await bridge.git!.worktreeList('/repo')).toEqual([])
    expect(await bridge.petOverlay.open({} as never)).toEqual({ ok: false })
    expect(await bridge.openSessionWindow('s1')).toMatchObject({ ok: false })
    expect(await bridge.quickEntry.getSettings()).toMatchObject({ enabled: false })
    expect(await bridge.updates.check()).toMatchObject({ supported: false })
    expect(await bridge.requestMicrophoneAccess()).toBe(false)
    expect(await bridge.selectPaths()).toEqual([])
  })

  it('denied terminal.start rejects with a clear message (callers show an error state)', async () => {
    const bridge = buildWebBridge()

    await expect(bridge.terminal.start()).rejects.toThrow(/not available in the browser/)
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
  })
})
