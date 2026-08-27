import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GatewayAdapter, WEB_VERSION, toHermesConnection, webApi } from './index'
import { proxyBaseUrl } from './rest'
import { loadRegistry, upsertConnection, writeProfilePreference } from '../registry'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function textResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers })
}

function stubBrowserDownload(href: string) {
  const createObjectUrl = vi.fn((_blob: Blob) => href)
  const revokeObjectUrl = vi.fn()
  const NativeURL = URL

  class StubURL extends NativeURL {
    static createObjectURL = createObjectUrl
    static revokeObjectURL = revokeObjectUrl
  }

  vi.stubGlobal('URL', StubURL)
  vi.useFakeTimers()

  const click = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(click)

  return { click, createObjectUrl, revokeObjectUrl }
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

  it('gETs the gateway base URL with the session-token header', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }))

    await webApi({ path: '/api/status' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${window.location.origin}/api/status`)
    expect(init.headers['X-Hermes-Session-Token']).toBe('mock-token')
    expect(init.headers['X-Hermes-Target']).toBe('http://127.0.0.1:5180')
    expect(init.method).toBe('GET')
  })

  it('routes REST calls with connectionId through the selected registry target', async () => {
    upsertConnection({
      id: 'prod',
      label: 'Prod',
      kind: 'remote',
      url: 'https://hermes.example',
      authMode: 'token',
      token: 'prod-token',
    })
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }))

    await webApi({ path: '/api/status', connectionId: 'prod' })

    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers['X-Hermes-Session-Token']).toBe('prod-token')
    expect(init.headers['X-Hermes-Target']).toBe('https://hermes.example')
  })

  it('normalizes 404 into the desktop endpoint-missing error shape', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, { detail: 'No such API endpoint: /api/nope' }),
    )

    await expect(webApi({ path: '/api/nope' })).rejects.toThrow(
      '404: {"detail":"No such API endpoint: /api/nope"}',
    )
  })

  it('normalizes other HTTP errors with status + detail', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { detail: 'boom' }))

    await expect(webApi({ path: '/api/boom' })).rejects.toThrow(
      'HTTP 500: {"detail":"boom"}',
    )
  })

  it('parses JSON bodies and returns them', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { sessions: [], total: 0 }))

    const result = await webApi<{ sessions: unknown[]; total: number }>({
      path: '/api/sessions',
    })
    expect(result.total).toBe(0)
  })

  it('pOSTs JSON bodies with the JSON content type', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }))

    await webApi({
      path: '/api/sessions/s1',
      method: 'PATCH',
      body: { archived: true },
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${window.location.origin}/api/sessions/s1`)
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ archived: true })
  })

  it('sends uploads as multipart FormData', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }))

    await webApi({
      path: '/api/attach',
      method: 'POST',
      upload: {
        filename: 'a.png',
        contentType: 'image/png',
        bytes: new Uint8Array([1, 2, 3]).buffer,
      },
    })

    const [, init] = fetchMock.mock.calls[0]
    expect(init.body).toBeInstanceOf(FormData)
    expect(init.headers['Content-Type']).toBeUndefined() // FormData sets its own boundary
  })
})

describe('gatewayAdapter', () => {
  beforeEach(() => {
    window.localStorage.clear()
    loadRegistry()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('getConnection exposes every field the renderer reads', async () => {
    const adapter = new GatewayAdapter()
    const conn = await adapter.getConnection()

    expect(conn.baseUrl).toBe(window.location.origin)
    expect(conn.token).toBe('mock-token')
    expect(conn.wsUrl).toBe(
      `${window.location.origin.replace(/^http/, 'ws')}/api/ws?token=mock-token&target=${encodeURIComponent('http://127.0.0.1:5180')}`,
    )
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

    expect(result).toEqual({
      ok: true,
      wsUrl: expect.stringContaining('/api/ws?token='),
    })
  })

  it('revalidate/touch are cheap no-ops with ok:true', async () => {
    const adapter = new GatewayAdapter()

    expect(await adapter.revalidateConnection()).toEqual({ ok: true, rebuilt: false })
    expect(await adapter.touchBackend()).toEqual({ ok: true })
  })

  it('saveGatewayFile downloads through /api/fs/download and triggers a browser download', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      textResponse(200, 'hello', {
        'Content-Disposition': "attachment; filename*=UTF-8''report%20final.txt",
        'Content-Type': 'text/plain',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { click, createObjectUrl, revokeObjectUrl } =
      stubBrowserDownload('blob:download')

    const adapter = new GatewayAdapter()
    const result = await adapter.saveGatewayFile({
      path: '/tmp/report.txt',
      suggestedName: 'fallback.txt',
    })

    expect(result).toEqual({ path: 'report final.txt', saved: true })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      `${window.location.origin}/api/fs/download?path=%2Ftmp%2Freport.txt`,
    )
    expect(init.credentials).toBe('include')
    expect(init.headers['X-Hermes-Session-Token']).toBe('mock-token')
    expect(init.headers['X-Hermes-Target']).toBe('http://127.0.0.1:5180')
    const firstCall = createObjectUrl.mock.calls[0] as [Blob] | undefined
    const downloaded = firstCall?.[0]
    expect(downloaded).toBeTruthy()
    if (!downloaded) {
      throw new Error('missing downloaded blob')
    }
    expect(downloaded.type).toBe('text/plain')
    expect(downloaded.size).toBe(5)
    await expect(downloaded.text()).resolves.toBe('hello')
    expect(click).toHaveBeenCalledTimes(1)
    expect(document.querySelector('a[download="report final.txt"]')).toBeNull()
    vi.runOnlyPendingTimers()
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:download')
  })

  it('saveGatewayFile falls back to read-data-url only when /api/fs/download is missing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { detail: 'missing' }))
      .mockResolvedValueOnce(
        jsonResponse(200, { dataUrl: 'data:text/plain;base64,aGVsbG8=' }),
      )
    vi.stubGlobal('fetch', fetchMock)
    stubBrowserDownload('blob:fallback')

    const adapter = new GatewayAdapter()
    const result = await adapter.saveGatewayFile({
      path: '/tmp/legacy.md',
      suggestedName: 'legacy.md',
    })

    expect(result).toEqual({ path: 'legacy.md', saved: true })
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${window.location.origin}/api/fs/read-data-url?path=%2Ftmp%2Flegacy.md`,
    )
  })

  it('saveGatewayFile preserves a requested profile scope on both transports', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { detail: 'missing' }))
      .mockResolvedValueOnce(
        jsonResponse(200, { dataUrl: 'data:text/plain;base64,aGVsbG8=' }),
      )
    vi.stubGlobal('fetch', fetchMock)
    stubBrowserDownload('blob:profile')

    const adapter = new GatewayAdapter()
    await adapter.saveGatewayFile({
      path: '/tmp/profile.md',
      profile: 'reviewer',
      suggestedName: 'profile.md',
    })

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${window.location.origin}/api/fs/download?path=%2Ftmp%2Fprofile.md&profile=reviewer`,
    )
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${window.location.origin}/api/fs/read-data-url?path=%2Ftmp%2Fprofile.md&profile=reviewer`,
    )
  })

  it('saveGatewayFile routes connectionId-scoped downloads to that registry target', async () => {
    upsertConnection({
      id: 'prod',
      label: 'Prod',
      kind: 'remote',
      url: 'https://hermes.example',
      authMode: 'token',
      token: 'prod-token',
    })
    const fetchMock = vi.fn().mockResolvedValue(textResponse(200, 'hello'))
    vi.stubGlobal('fetch', fetchMock)
    stubBrowserDownload('blob:prod')

    const adapter = new GatewayAdapter()
    await adapter.saveGatewayFile({
      connectionId: 'prod',
      path: '/tmp/prod.txt',
      suggestedName: 'prod.txt',
    })

    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers['X-Hermes-Session-Token']).toBe('prod-token')
    expect(init.headers['X-Hermes-Target']).toBe('https://hermes.example')
  })

  it('saveGatewayFile falls back to the active profile preference when no profile is passed', async () => {
    writeProfilePreference('coder')
    const fetchMock = vi.fn().mockResolvedValue(textResponse(200, 'hello'))
    vi.stubGlobal('fetch', fetchMock)
    stubBrowserDownload('blob:active-profile')

    const adapter = new GatewayAdapter()
    await adapter.saveGatewayFile({ path: '/tmp/current.md' })

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${window.location.origin}/api/fs/download?path=%2Ftmp%2Fcurrent.md&profile=coder`,
    )
  })

  it('saveGatewayFile surfaces non-404 download errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, { detail: 'boom' }))
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new GatewayAdapter()

    await expect(adapter.saveGatewayFile({ path: '/tmp/bad.txt' })).rejects.toThrow(
      'HTTP 500',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('saveGatewayFile omits the token header for cookie-backed sessions', async () => {
    const adapter = new GatewayAdapter()
    await adapter.saveConnectionConfig({
      mode: 'remote',
      remoteAuthMode: 'oauth',
      remoteUrl: 'http://127.0.0.1:9119',
    })
    const fetchMock = vi.fn().mockResolvedValue(textResponse(200, 'hello'))
    vi.stubGlobal('fetch', fetchMock)
    stubBrowserDownload('blob:oauth')

    await adapter.saveGatewayFile({ path: '/tmp/oauth.txt' })

    const [, init] = fetchMock.mock.calls[0]
    expect(init.credentials).toBe('include')
    expect(init.headers['X-Hermes-Session-Token']).toBeUndefined()
    expect(init.headers['X-Hermes-Target']).toBe('http://127.0.0.1:9119')
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
      remoteToken: 'fresh-token',
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

  it('connections.onChanged fires saved for a new connection and removed on delete', async () => {
    const adapter = new GatewayAdapter()
    const events: Array<{
      connectionId: string
      reason: 'removed' | 'saved' | 'updated'
    }> = []
    const off = adapter.onConnectionsChanged((payload) => events.push(payload))

    await adapter.connectionsSave({
      id: 'conn-new',
      kind: 'remote',
      label: 'new',
      url: 'http://127.0.0.1:9999',
      authMode: 'token',
      token: 't',
    })
    // 新建 → 'saved'
    expect(events).toEqual([{ connectionId: 'conn-new', reason: 'saved' }])

    // 纯 label 改名 → 仍是 'saved'（#95393 refresh push）
    await adapter.connectionsSave({
      id: 'conn-new',
      kind: 'remote',
      label: 'renamed',
      url: 'http://127.0.0.1:9999',
      authMode: 'token',
      token: 't',
    })
    expect(events[1]).toEqual({ connectionId: 'conn-new', reason: 'saved' })

    // 端点实质编辑 → 'updated'
    await adapter.connectionsSave({
      id: 'conn-new',
      kind: 'remote',
      label: 'renamed',
      url: 'http://127.0.0.1:8888',
      authMode: 'token',
      token: 't',
    })
    expect(events[2]).toEqual({ connectionId: 'conn-new', reason: 'updated' })

    await adapter.connectionsRemove('conn-new')
    expect(events[3]).toEqual({ connectionId: 'conn-new', reason: 'removed' })

    off()
    await adapter.connectionsRemove('local')
    expect(events).toHaveLength(4)
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
      token: 't',
    })

    expect(conn.baseUrl).toBe(window.location.origin)
    expect(conn.authMode).toBe('oauth')
    expect(conn.remoteKind).toBe('url')
    expect(conn.source).toBe('settings')
    expect(conn.wsUrl).toBe(
      `${window.location.origin.replace(/^http/, 'ws')}/api/ws?target=${encodeURIComponent('http://h:9119')}`,
    )
  })
})

describe('proxy mode (VITE_PROXY_URL set)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    loadRegistry()
    vi.stubEnv('VITE_PROXY_URL', 'http://127.0.0.1:8787')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('webApi targets the proxy and carries X-Hermes-Target', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await webApi({ path: '/api/status' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8787/api/status')
    expect(init.headers['X-Hermes-Target']).toBe('http://127.0.0.1:5180')
    expect(init.headers['X-Hermes-Session-Token']).toBe('mock-token')
    vi.unstubAllGlobals()
  })

  it('wsUrl encodes the gateway target into the query', async () => {
    const adapter = new GatewayAdapter()
    const conn = await adapter.getConnection()

    expect(conn.baseUrl).toBe('http://127.0.0.1:8787')
    expect(conn.wsUrl).toBe(
      `ws://127.0.0.1:8787/api/ws?token=mock-token&target=${encodeURIComponent(
        'http://127.0.0.1:5180',
      )}`,
    )
  })

  it('probeConnectionConfig goes through the proxy', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { version: '0.19.1', auth_mode: 'token' }))
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new GatewayAdapter()
    const result = await adapter.probeConnectionConfig('http://127.0.0.1:9119')

    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8787/api/status')
    expect(fetchMock.mock.calls[0][1].headers['X-Hermes-Target']).toBe(
      'http://127.0.0.1:9119',
    )
    expect(result.reachable).toBe(true)
    expect(result.version).toBe('0.19.1')
    vi.unstubAllGlobals()
  })
})

describe('same-origin proxy (no VITE_PROXY_URL — ADR-0016)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    loadRegistry()
  })

  it('proxyBaseUrl falls back to window.location.origin (never null)', () => {
    expect(proxyBaseUrl()).toBe(window.location.origin)
  })

  it('webApi targets same-origin proxy and carries X-Hermes-Target', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await webApi({ path: '/api/status' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${window.location.origin}/api/status`)
    expect(init.headers['X-Hermes-Target']).toBe('http://127.0.0.1:5180')
    vi.unstubAllGlobals()
  })

  it('getConnectionConfig prefills default gateway from same-origin /api/proxy/meta', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        defaultGatewayUrl: 'http://hermes:9119',
        allowedTargets: [],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new GatewayAdapter()

    const config = await adapter.getConnectionConfig()

    expect(fetchMock.mock.calls[0][0]).toBe(`${window.location.origin}/api/proxy/meta`)
    expect(config.remoteUrl).toBe('http://hermes:9119')
    vi.unstubAllGlobals()
  })
})

describe('m3 OAuth (proxy mode)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    loadRegistry()
    vi.stubEnv('VITE_PROXY_URL', 'http://127.0.0.1:6722')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('probeConnectionConfig reads real gateway auth fields (auth_required + auth_flows)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        version: '0.19.1',
        auth_required: true,
        auth_flows: ['cookie', 'native_pkce'],
        auth_providers: ['nous'],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new GatewayAdapter()
    const result = await adapter.probeConnectionConfig('http://127.0.0.1:9119')

    expect(result.authMode).toBe('oauth')
    expect(result.providers).toEqual([{ name: 'nous', displayName: 'nous' }])
  })

  it('probeConnectionConfig: loopback gateway (no gate) reports token', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, { version: '0.19.1', auth_required: false }),
        ),
    )

    const adapter = new GatewayAdapter()
    const result = await adapter.probeConnectionConfig('http://127.0.0.1:9119')

    expect(result.authMode).toBe('token')
  })

  it('webApi in oauth mode omits the static token header and sends credentials', async () => {
    const adapter = new GatewayAdapter()
    await adapter.saveConnectionConfig({
      mode: 'remote',
      remoteUrl: 'http://127.0.0.1:9119',
      remoteAuthMode: 'oauth',
    })

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await webApi({ path: '/api/status' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:6722/api/status')
    expect(init.headers['X-Hermes-Session-Token']).toBeUndefined()
    expect(init.headers['X-Hermes-Target']).toBe('http://127.0.0.1:9119')
    expect(init.credentials).toBe('include')
  })

  it('wsUrl for oauth mode carries no token query (cookie + ws-ticket instead)', async () => {
    const adapter = new GatewayAdapter()
    await adapter.saveConnectionConfig({
      mode: 'remote',
      remoteUrl: 'http://127.0.0.1:9119',
      remoteAuthMode: 'oauth',
    })
    const conn = await adapter.getConnection()

    expect(conn.wsUrl).toBe(
      `ws://127.0.0.1:6722/api/ws?target=${encodeURIComponent(
        'http://127.0.0.1:9119',
      )}`,
    )
    expect(conn.wsUrl.includes('token=')).toBe(false)
  })

  it('oauthLoginConnectionConfig: popup unavailable (window.open null) → ok:false', async () => {
    const adapter = new GatewayAdapter()
    const result = await adapter.oauthLoginConnectionConfig('http://127.0.0.1:9119')

    expect(result).toEqual({
      ok: false,
      baseUrl: 'http://127.0.0.1:9119',
      connected: false,
    })
  })

  it('oauthLoginConnectionConfig: start → open window → poll session until connected', async () => {
    const adapter = new GatewayAdapter()
    const fakeWin = {
      closed: false,
      close: vi.fn(),
      location: { href: '' },
    }
    const openMock = vi.fn(() => fakeWin)
    vi.stubGlobal('open', openMock)
    ;(window as unknown as { open: typeof openMock }).open = openMock

    const fetchMock = vi
      .fn()
      // start
      .mockResolvedValueOnce(
        jsonResponse(200, {
          authorizeUrl: 'http://127.0.0.1:9119/auth/native/authorize?state=s1',
        }),
      )
      // session 轮询：第一次未连接，第二次已连接
      .mockResolvedValueOnce(jsonResponse(200, { connected: false }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          connected: true,
          provider: 'nous',
          userId: 'u1',
          expiresAt: 9999,
          tokenPreview: 'mock…',
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()

    const promise = adapter.oauthLoginConnectionConfig('http://127.0.0.1:9119')
    // 推进两轮轮询：第一轮未连接，第二轮已连接。
    await vi.advanceTimersByTimeAsync(600)
    await vi.advanceTimersByTimeAsync(600)
    const result = await promise

    vi.useRealTimers()

    expect(result).toEqual({
      ok: true,
      baseUrl: 'http://127.0.0.1:9119',
      connected: true,
    })
    // start 请求形状
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:6722/auth/native/start')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      target: 'http://127.0.0.1:9119',
    })
    // 授权窗口导航到 authorize URL
    expect(fakeWin.location.href).toBe(
      'http://127.0.0.1:9119/auth/native/authorize?state=s1',
    )
  })

  it('oauthLogoutConnectionConfig posts logout to the proxy', async () => {
    const adapter = new GatewayAdapter()
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.oauthLogoutConnectionConfig('http://127.0.0.1:9119')

    expect(result).toEqual({ ok: true, connected: false })
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:6722/auth/native/logout')
    expect(fetchMock.mock.calls[0][1].credentials).toBe('include')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      target: 'http://127.0.0.1:9119',
    })
  })

  it('oauthPasteConnectionConfig posts the pasted callback URL to the proxy', async () => {
    const adapter = new GatewayAdapter()
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.oauthPasteConnectionConfig(
      'http://127.0.0.1:9119',
      'http://127.0.0.1:6722/auth/native/callback?code=gw-code&state=st1',
    )

    expect(result).toEqual({
      ok: true,
      baseUrl: 'http://127.0.0.1:9119',
      connected: true,
    })
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:6722/auth/native/paste')
    expect(fetchMock.mock.calls[0][1].credentials).toBe('include')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      target: 'http://127.0.0.1:9119',
      url: 'http://127.0.0.1:6722/auth/native/callback?code=gw-code&state=st1',
    })
  })

  it('oauthPasteConnectionConfig surfaces the proxy detail on failure', async () => {
    const adapter = new GatewayAdapter()
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(400, { detail: 'Unknown or expired login state' }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      adapter.oauthPasteConnectionConfig(
        'http://127.0.0.1:9119',
        '?code=x&state=forged',
      ),
    ).rejects.toThrow('Unknown or expired login state')
  })

  it('getConnectionConfig prefills default gateway from /api/proxy/meta (untouched registry)', async () => {
    const adapter = new GatewayAdapter()
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        defaultGatewayUrl: 'http://hermes:9119',
        allowedTargets: ['http://hermes:9119'],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const config = await adapter.getConnectionConfig()

    expect(config.remoteUrl).toBe('http://hermes:9119')
    // 未保存：registry 仍是出厂 mock 连接。
    expect(loadRegistry().connections[0].url).toBe('http://127.0.0.1:5180')
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:6722/api/proxy/meta')
  })

  it('getConnectionConfig queries oauth session status for oauth connections', async () => {
    const adapter = new GatewayAdapter()
    // save 现在也查实时会话（M5 修复）——先给她一个空会话 stub，测试保持封闭。
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          connected: false,
          provider: '',
          userId: '',
          expiresAt: 0,
          tokenPreview: null,
        }),
      ),
    )
    await adapter.saveConnectionConfig({
      mode: 'remote',
      remoteUrl: 'http://127.0.0.1:9119',
      remoteAuthMode: 'oauth',
    })
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        connected: true,
        provider: 'nous',
        userId: 'u1',
        expiresAt: 9999,
        tokenPreview: 'mock…',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const config = await adapter.getConnectionConfig()

    expect(config.remoteOauthConnected).toBe(true)
    expect(config.remoteTokenPreview).toBe('mock…')
    expect(config.remoteTokenSet).toBe(false)
  })

  it('getConnectionConfig reports disconnected when proxy lost the oauth session (restart)', async () => {
    // M4 错误/重连态：代理重启后内存 token set 清空，但浏览器 httpOnly cookie
    // 仍在——session 查询必须如实回未连接（UI 回到 Sign in，而不是假 connected）。
    const adapter = new GatewayAdapter()
    // save 现在也查实时会话（M5 修复）——先给她一个空会话 stub，测试保持封闭。
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          connected: false,
          provider: '',
          userId: '',
          expiresAt: 0,
          tokenPreview: null,
        }),
      ),
    )
    await adapter.saveConnectionConfig({
      mode: 'remote',
      remoteUrl: 'http://127.0.0.1:9119',
      remoteAuthMode: 'oauth',
    })
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        connected: false,
        provider: '',
        userId: '',
        expiresAt: 0,
        tokenPreview: null,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const config = await adapter.getConnectionConfig()

    expect(config.remoteOauthConnected).toBe(false)
    expect(config.remoteTokenPreview).toBe(null)
    expect(config.remoteTokenSet).toBe(false)
    // 会话查询走代理同源（credentials include 随 cookie），带 target 匹配。
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://127.0.0.1:6722/auth/native/session?target=http%3A%2F%2F127.0.0.1%3A9119',
    )
    expect(fetchMock.mock.calls[0][1].credentials).toBe('include')
  })

  it('oauth mode save clears leftover static token', async () => {
    const adapter = new GatewayAdapter()
    await adapter.saveConnectionConfig({
      mode: 'remote',
      remoteUrl: 'http://127.0.0.1:5199',
      remoteAuthMode: 'token',
      remoteToken: 'fresh-token',
    })
    // save 现在也查实时会话（M5 修复）——补空会话 stub，测试保持封闭。
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          connected: false,
          provider: '',
          userId: '',
          expiresAt: 0,
          tokenPreview: null,
        }),
      ),
    )
    const switched = await adapter.saveConnectionConfig({
      mode: 'remote',
      remoteUrl: 'http://127.0.0.1:5199',
      remoteAuthMode: 'oauth',
    })

    expect(switched.remoteTokenSet).toBe(false)
    expect(loadRegistry().connections[0].token).toBe('')
  })

  it('saveConnectionConfig refreshes the live oauth session (no false disconnected after save)', async () => {
    const adapter = new GatewayAdapter()
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        connected: true,
        provider: 'nous',
        userId: 'u1',
        expiresAt: 9999,
        tokenPreview: 'mock…',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const saved = await adapter.saveConnectionConfig({
      mode: 'remote',
      remoteUrl: 'http://127.0.0.1:9119',
      remoteAuthMode: 'oauth',
    })

    expect(saved.remoteOauthConnected).toBe(true)
    expect(saved.remoteTokenPreview).toBe('mock…')
    expect(saved.remoteTokenSet).toBe(false)
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://127.0.0.1:6722/auth/native/session?target=http%3A%2F%2F127.0.0.1%3A9119',
    )
    vi.unstubAllGlobals()
  })

  it('saveConnectionConfig reports connected via a live password session (dashboard login)', async () => {
    const adapter = new GatewayAdapter()
    const fetchMock = vi
      .fn()
      // /auth/native/session → OAuth 会话空
      .mockResolvedValueOnce(
        jsonResponse(200, {
          connected: false,
          provider: '',
          userId: '',
          expiresAt: 0,
          tokenPreview: null,
        }),
      )
      // /api/proxy/session/status → 密码会话已连接
      .mockResolvedValueOnce(
        jsonResponse(200, { connected: true, provider: 'password', username: 'alice' }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const saved = await adapter.saveConnectionConfig({
      mode: 'remote',
      remoteUrl: 'http://127.0.0.1:9119',
      remoteAuthMode: 'oauth',
    })

    expect(saved.remoteOauthConnected).toBe(true)
    expect(fetchMock.mock.calls[1][0]).toBe(
      'http://127.0.0.1:6722/api/proxy/session/status?target=http%3A%2F%2F127.0.0.1%3A9119',
    )
    vi.unstubAllGlobals()
  })

  it('applyConnectionConfig (save-and-reconnect) keeps the live connected state', async () => {
    const adapter = new GatewayAdapter()
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        connected: true,
        provider: 'nous',
        userId: 'u1',
        expiresAt: 9999,
        tokenPreview: 'mock…',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const applied = await adapter.applyConnectionConfig({
      mode: 'remote',
      remoteUrl: 'http://127.0.0.1:9119',
      remoteAuthMode: 'oauth',
    })

    expect(applied.remoteOauthConnected).toBe(true)
    // 应用即保存：registry 同步更新。
    expect(loadRegistry().connections[0].url).toBe('http://127.0.0.1:9119')
    vi.unstubAllGlobals()
  })

  it('applyConnectionConfig emits connectionApplied (renderer softSwitch re-dials; save does not)', async () => {
    const adapter = new GatewayAdapter()
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        connected: true,
        provider: 'nous',
        userId: 'u1',
        expiresAt: 9999,
        tokenPreview: 'mock…',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const onApplied = vi.fn()
    const unsubscribe = adapter.onConnectionApplied(onApplied)

    await adapter.applyConnectionConfig({
      mode: 'remote',
      remoteUrl: 'http://127.0.0.1:9119',
      remoteAuthMode: 'oauth',
    })

    // "保存并重连" → 广播事件，渲染层 use-gateway-boot 据此 softSwitch 重拨。
    expect(onApplied).toHaveBeenCalledTimes(1)

    // "仅保存（Save for next restart）" 不触发重连事件——只有 apply 会。
    onApplied.mockClear()
    await adapter.saveConnectionConfig({
      mode: 'remote',
      remoteUrl: 'http://127.0.0.1:9119',
    })
    expect(onApplied).not.toHaveBeenCalled()

    // 退订后不再收到事件。
    unsubscribe()
    await adapter.applyConnectionConfig({
      mode: 'remote',
      remoteUrl: 'http://127.0.0.1:9119',
    })
    expect(onApplied).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('saveConnectionConfig reports disconnected when no proxy session exists', async () => {
    const adapter = new GatewayAdapter()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          connected: false,
          provider: '',
          userId: '',
          expiresAt: 0,
          tokenPreview: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { connected: false, provider: '', username: '' }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const saved = await adapter.saveConnectionConfig({
      mode: 'remote',
      remoteUrl: 'http://127.0.0.1:9119',
      remoteAuthMode: 'oauth',
    })

    expect(saved.remoteOauthConnected).toBe(false)
    expect(saved.remoteTokenPreview).toBe(null)
    vi.unstubAllGlobals()
  })
})

describe('gatewayAdapter fs/git REST parity (remote-mode members, ADR-0010)', () => {
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

  it('readDir hits GET /api/fs/list with the query path', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        entries: [{ name: 'a', path: '/repo/a', isDirectory: true }],
      }),
    )
    const adapter = new GatewayAdapter()
    const result = await adapter.readDir('/repo')

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${window.location.origin}/api/fs/list?path=%2Frepo`,
    )
    expect(result.entries).toEqual([{ name: 'a', path: '/repo/a', isDirectory: true }])
  })

  it('readFileText hits GET /api/fs/read-text', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { path: '/repo/a.txt', text: 'hi', language: 'text' }),
    )
    const adapter = new GatewayAdapter()
    const result = await adapter.readFileText('/repo/a.txt')

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${window.location.origin}/api/fs/read-text?path=%2Frepo%2Fa.txt`,
    )
    expect(result.text).toBe('hi')
  })

  it('writeTextFile POSTs /api/fs/write-text with path + content', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { ok: true, path: '/repo/a.txt', byteSize: 2 }),
    )
    const adapter = new GatewayAdapter()
    const result = await adapter.writeTextFile('/repo/a.txt', 'hi')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${window.location.origin}/api/fs/write-text`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ content: 'hi', path: '/repo/a.txt' })
    expect(result.path).toBe('/repo/a.txt')
  })

  it('readFileDataUrl unwraps the dataUrl field', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { dataUrl: 'data:image/png;base64,AAAA' }),
    )
    const adapter = new GatewayAdapter()
    const result = await adapter.readFileDataUrl('/a.png')

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${window.location.origin}/api/fs/read-data-url?path=%2Fa.png`,
    )
    expect(result).toBe('data:image/png;base64,AAAA')
  })

  it('gitRoot hits GET /api/fs/git-root', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { root: '/repo' }))
    const adapter = new GatewayAdapter()

    expect(await adapter.gitRoot('/repo/a')).toBe('/repo')
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${window.location.origin}/api/fs/git-root?path=%2Frepo%2Fa`,
    )
  })

  it('git.repoStatus hits GET /api/git/status', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { branch: 'main', changes: [] }))
    const adapter = new GatewayAdapter()
    const status = await adapter.git!.repoStatus('/repo')

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${window.location.origin}/api/git/status?path=%2Frepo`,
    )
    expect(status).toEqual({ branch: 'main', changes: [] })
  })

  it('git.branchSwitch POSTs /api/git/branch/switch', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { branch: 'feat' }))
    const adapter = new GatewayAdapter()
    await adapter.git!.branchSwitch('/repo', 'feat')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${window.location.origin}/api/git/branch/switch`)
    expect(JSON.parse(init.body)).toEqual({ branch: 'feat', path: '/repo' })
  })

  it('git.worktreeList unwraps { worktrees }', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        worktrees: [
          { path: '/wt', branch: 'x', isMain: false, detached: false, locked: false },
        ],
      }),
    )
    const adapter = new GatewayAdapter()
    const list = await adapter.git!.worktreeList('/repo')

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${window.location.origin}/api/git/worktrees?path=%2Frepo`,
    )
    expect(list).toHaveLength(1)
    expect(list[0].path).toBe('/wt')
  })

  it('git.review.list sends scope and skips null base', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { files: [], base: null }))
    const adapter = new GatewayAdapter()
    await adapter.git!.review.list('/repo', 'branch', null)

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${window.location.origin}/api/git/review/list?path=%2Frepo&scope=branch`,
    )
  })

  it('git.review.commit POSTs message + push', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }))
    const adapter = new GatewayAdapter()
    await adapter.git!.review.commit('/repo', 'msg', false)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${window.location.origin}/api/git/review/commit`)
    expect(JSON.parse(init.body)).toEqual({
      message: 'msg',
      path: '/repo',
      push: false,
    })
  })

  it('git.scanRepos is a no-op [] and review.fetchPrComment resolves null (no requests)', async () => {
    const adapter = new GatewayAdapter()

    expect(await adapter.git!.scanRepos(['/home'])).toEqual([])
    expect(
      await adapter.git!.review.fetchPrComment(
        '/repo',
        'https://github.com/x/y/pull/1',
      ),
    ).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fs/git requests carry the session token header', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { entries: [] }))
    const adapter = new GatewayAdapter()
    await adapter.readDir('/')

    expect(fetchMock.mock.calls[0][1].headers['X-Hermes-Session-Token']).toBe(
      'mock-token',
    )
    expect(fetchMock.mock.calls[0][1].headers['X-Hermes-Target']).toBe(
      'http://127.0.0.1:5180',
    )
  })
})

describe('m5 password login ("dashboard login", proxy mode)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    loadRegistry()
    vi.stubEnv('VITE_PROXY_URL', 'http://127.0.0.1:6722')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('probe: password-gated gateway (no native_pkce) resolves to oauth with supportsPassword', async () => {
    const fetchMock = vi
      .fn()
      // /api/status
      .mockResolvedValueOnce(
        jsonResponse(200, {
          version: '0.19.1',
          auth_required: true,
          auth_flows: ['cookie'],
          auth_providers: ['password'],
        }),
      )
      // /api/auth/providers
      .mockResolvedValueOnce(
        jsonResponse(200, {
          providers: [
            {
              name: 'password',
              display_name: 'Username & Password',
              supports_password: true,
            },
          ],
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new GatewayAdapter()
    const result = await adapter.probeConnectionConfig('http://127.0.0.1:9119')

    expect(result.authMode).toBe('oauth')
    expect(result.providers).toEqual([
      { name: 'password', displayName: 'Username & Password', supportsPassword: true },
    ])
    // providers 探测走代理 + target
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:6722/api/auth/providers')
    expect(fetchMock.mock.calls[1][1].headers['X-Hermes-Target']).toBe(
      'http://127.0.0.1:9119',
    )
  })

  it('probe: gated gateway with providers endpoint failure stays token (no native_pkce)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          version: '0.19.1',
          auth_required: true,
          auth_flows: ['cookie'],
          auth_providers: ['password'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(503, { detail: 'no auth providers registered' }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new GatewayAdapter()
    const result = await adapter.probeConnectionConfig('http://127.0.0.1:9119')

    expect(result.authMode).toBe('token')
    expect(result.providers).toEqual([{ name: 'password', displayName: 'password' }])
  })

  it('passwordLoginConnectionConfig posts credentials to the proxy and reports connected', async () => {
    const adapter = new GatewayAdapter()
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.passwordLoginConnectionConfig(
      'http://127.0.0.1:9119',
      'password',
      'alice',
      's3cret',
    )

    expect(result).toEqual({
      ok: true,
      baseUrl: 'http://127.0.0.1:9119',
      connected: true,
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:6722/api/proxy/session/login')
    expect(init.credentials).toBe('include')
    expect(JSON.parse(init.body)).toEqual({
      target: 'http://127.0.0.1:9119',
      provider: 'password',
      username: 'alice',
      password: 's3cret',
    })
  })

  it('passwordLoginConnectionConfig surfaces gateway 401 detail as a readable error', async () => {
    const adapter = new GatewayAdapter()
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(401, { detail: 'Invalid credentials' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      adapter.passwordLoginConnectionConfig(
        'http://127.0.0.1:9119',
        'password',
        'alice',
        'wrong',
      ),
    ).rejects.toThrow('HTTP 401: Invalid credentials')
  })

  it('oauthLogoutConnectionConfig clears BOTH oauth and password sessions', async () => {
    const adapter = new GatewayAdapter()
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.oauthLogoutConnectionConfig('http://127.0.0.1:9119')

    expect(result).toEqual({ ok: true, connected: false })
    const calls = fetchMock.mock.calls.map((call) => ({
      body: JSON.parse(call[1].body),
      url: call[0],
    }))
    expect(calls).toContainEqual({
      url: 'http://127.0.0.1:6722/auth/native/logout',
      body: { target: 'http://127.0.0.1:9119' },
    })
    expect(calls).toContainEqual({
      url: 'http://127.0.0.1:6722/api/proxy/session/logout',
      body: { target: 'http://127.0.0.1:9119' },
    })
  })

  it('getConnectionConfig reports connected when a password session exists (oauth endpoint empty)', async () => {
    const adapter = new GatewayAdapter()
    await adapter.saveConnectionConfig({
      mode: 'remote',
      remoteUrl: 'http://127.0.0.1:9119',
      remoteAuthMode: 'oauth',
    })
    const fetchMock = vi
      .fn()
      // /auth/native/session → 未连接
      .mockResolvedValueOnce(
        jsonResponse(200, {
          connected: false,
          provider: '',
          userId: '',
          expiresAt: 0,
          tokenPreview: null,
        }),
      )
      // /api/proxy/session/status → 密码会话已连接
      .mockResolvedValueOnce(
        jsonResponse(200, { connected: true, provider: 'password', username: 'alice' }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const config = await adapter.getConnectionConfig()

    expect(config.remoteOauthConnected).toBe(true)
    expect(fetchMock.mock.calls[1][0]).toBe(
      'http://127.0.0.1:6722/api/proxy/session/status?target=http%3A%2F%2F127.0.0.1%3A9119',
    )
  })

  it('getConnectionConfig reports disconnected when neither session exists', async () => {
    const adapter = new GatewayAdapter()
    await adapter.saveConnectionConfig({
      mode: 'remote',
      remoteUrl: 'http://127.0.0.1:9119',
      remoteAuthMode: 'oauth',
    })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          connected: false,
          provider: '',
          userId: '',
          expiresAt: 0,
          tokenPreview: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { connected: false, provider: '', username: '' }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const config = await adapter.getConnectionConfig()

    expect(config.remoteOauthConnected).toBe(false)
  })
})

describe('wEB_VERSION (build-injected client identity, ADR-0014)', () => {
  // 项目标识：HEAD 打 tag → 版本号；否则 → g<短sha>（无 git 时退回项目版本号）。
  it('follows the <desktop version>+web.<tag version | g<sha>> shape', () => {
    expect(WEB_VERSION).toMatch(/^\d+\.\d+\.\d+\+web\.(?:g[0-9a-f]+|\d+\.\d+\.\d+)$/)
  })
})

describe('gatewayAdapter.streamMediaUrl (ADR-0022)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    loadRegistry()
  })

  it('builds a same-origin proxy media-stream URL with target/path/token', async () => {
    const adapter = new GatewayAdapter()
    const url = await adapter.streamMediaUrl('/tmp/a.ogg')
    const parsed = new URL(String(url))
    expect(parsed.origin).toBe(window.location.origin)
    expect(parsed.pathname).toBe('/api/proxy/media-stream')
    expect(parsed.searchParams.get('target')).toBe('http://127.0.0.1:5180')
    expect(parsed.searchParams.get('path')).toBe('/tmp/a.ogg')
    expect(parsed.searchParams.get('token')).toBe('mock-token')
    expect(parsed.searchParams.has('profile')).toBe(false)
  })

  it('strips file: prefix and adds profile when set', async () => {
    window.localStorage.setItem('hermes-web.profile.v1', 'voice reviewer')
    const adapter = new GatewayAdapter()
    const url = await adapter.streamMediaUrl('file:///tmp/voice.ogg')
    const parsed = new URL(String(url))
    expect(parsed.searchParams.get('path')).toBe('/tmp/voice.ogg')
    expect(parsed.searchParams.get('profile')).toBe('voice reviewer')
  })

  it('omits token for oauth connections (cookie-session auth)', async () => {
    const { upsertConnection, setPrimaryConnection } = await import('../registry')
    upsertConnection({
      id: 'c2',
      label: 'g',
      kind: 'remote',
      url: 'https://gw.example.com',
      authMode: 'oauth',
      token: '',
    })
    setPrimaryConnection('c2')
    const adapter = new GatewayAdapter()
    const url = await adapter.streamMediaUrl('/tmp/a.ogg')
    const parsed = new URL(String(url))
    expect(parsed.searchParams.has('token')).toBe(false)
    expect(parsed.searchParams.get('target')).toBe('https://gw.example.com')
  })

  it('returns null when the primary connection has no url', async () => {
    const { upsertConnection, setPrimaryConnection } = await import('../registry')
    upsertConnection({
      id: 'c3',
      label: 'x',
      kind: 'remote',
      url: '',
      authMode: 'token',
      token: '',
    })
    setPrimaryConnection('c3')
    const adapter = new GatewayAdapter()
    expect(await adapter.streamMediaUrl('/tmp/a.ogg')).toBeNull()
  })
})
