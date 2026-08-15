import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GatewayAdapter, toHermesConnection, webApi } from './gateway'
import { loadRegistry } from './registry'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('webApi (REST forwarding)', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    window.localStorage.clear()
    loadRegistry()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('GETs the gateway base URL with the session-token header', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }))

    await webApi({ path: '/api/status' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:5180/api/status')
    expect(init.headers['X-Hermes-Session-Token']).toBe('mock-token')
    expect(init.method).toBe('GET')
  })

  it('normalizes 404 into the desktop endpoint-missing error shape', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { detail: 'No such API endpoint: /api/nope' }))

    await expect(webApi({ path: '/api/nope' })).rejects.toThrow('404: {"detail":"No such API endpoint: /api/nope"}')
  })

  it('normalizes other HTTP errors with status + detail', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { detail: 'boom' }))

    await expect(webApi({ path: '/api/boom' })).rejects.toThrow('HTTP 500: {"detail":"boom"}')
  })

  it('parses JSON bodies and returns them', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { sessions: [], total: 0 }))

    const result = await webApi<{ sessions: unknown[]; total: number }>({ path: '/api/sessions' })
    expect(result.total).toBe(0)
  })

  it('POSTs JSON bodies with the JSON content type', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }))

    await webApi({ path: '/api/sessions/s1', method: 'PATCH', body: { archived: true } })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:5180/api/sessions/s1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ archived: true })
  })

  it('sends uploads as multipart FormData', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }))

    await webApi({
      path: '/api/attach',
      method: 'POST',
      upload: { filename: 'a.png', contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]).buffer }
    })

    const [, init] = fetchMock.mock.calls[0]
    expect(init.body).toBeInstanceOf(FormData)
    expect(init.headers['Content-Type']).toBeUndefined() // FormData sets its own boundary
  })
})

describe('GatewayAdapter', () => {
  beforeEach(() => {
    window.localStorage.clear()
    loadRegistry()
  })

  it('getConnection exposes every field the renderer reads', async () => {
    const adapter = new GatewayAdapter()
    const conn = await adapter.getConnection()

    expect(conn.baseUrl).toBe('http://127.0.0.1:5180')
    expect(conn.token).toBe('mock-token')
    expect(conn.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:5180\/gateway\?token=mock-token$/)
    expect(conn.authMode).toBe('token')
    expect(conn.mode).toBe('remote')
    expect(conn.nativeOverlayWidth).toBe(0)
    expect(conn.isFullscreen).toBe(false)
    expect(conn.windowButtonPosition).toBeNull()
    expect(Array.isArray(conn.logs)).toBe(true)
  })

  it('getGatewayWsUrl returns the minted ws url', async () => {
    const adapter = new GatewayAdapter()
    const result = await adapter.getGatewayWsUrl()

    expect(result).toEqual({ ok: true, wsUrl: expect.stringContaining('/gateway?token=') })
  })

  it('revalidate/touch are cheap no-ops with ok:true', async () => {
    const adapter = new GatewayAdapter()

    expect(await adapter.revalidateConnection()).toEqual({ ok: true, rebuilt: false })
    expect(await adapter.touchBackend()).toEqual({ ok: true })
  })

  it('boot progress is an idle snapshot (the renderer drives its own steps)', async () => {
    const adapter = new GatewayAdapter()
    const progress = await adapter.getBootProgress()

    expect(progress.phase).toBe('idle')
    expect(progress.running).toBe(false)
    expect(progress.error).toBeNull()
  })

  it('connection config round-trips through the registry', async () => {
    const adapter = new GatewayAdapter()
    const saved = await adapter.saveConnectionConfig({
      mode: 'remote',
      remoteUrl: 'http://127.0.0.1:5199',
      remoteAuthMode: 'token',
      remoteToken: 'fresh-token'
    })

    expect(saved.remoteUrl).toBe('http://127.0.0.1:5199')
    expect(saved.remoteTokenSet).toBe(true)

    const conn = await adapter.getConnection()
    expect(conn.token).toBe('fresh-token')
  })

  it('probeConnectionConfig reports unreachable with a reason, not a throw', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('fetch failed'))
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new GatewayAdapter()
    const result = await adapter.probeConnectionConfig('http://127.0.0.1:5999')

    expect(result.reachable).toBe(false)
    expect(result.error).toBe('fetch failed')
    vi.unstubAllGlobals()
  })

  it('connections registry surface returns the seeded single connection', async () => {
    const adapter = new GatewayAdapter()
    const registry = await adapter.connectionsList()

    expect(registry.connections).toHaveLength(1)
    expect(registry.connections[0].tokenPreview).toBe('mock…')
    expect(registry.connections[0].tokenSet).toBe(true)
  })
})

describe('toHermesConnection', () => {
  it('maps registry records to the renderer contract', () => {
    const conn = toHermesConnection({
      id: 'x',
      label: 'X',
      kind: 'remote',
      url: 'http://h:9119/',
      authMode: 'oauth',
      token: 't'
    })

    expect(conn.baseUrl).toBe('http://h:9119')
    expect(conn.authMode).toBe('oauth')
    expect(conn.remoteKind).toBe('url')
    expect(conn.source).toBe('settings')
    expect(conn.wsUrl.startsWith('ws://h:9119/gateway?token=')).toBe(true)
  })
})
