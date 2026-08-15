/**
 * M0 dev-only mock bridge — placeholder for the real WebCapabilityAdapter (M1).
 *
 * The desktop renderer only talks to the outside world through
 * window.hermesDesktop. This stub gives a pure-browser boot the same surface:
 *   - getConnection()        → a fake remote connection whose wsUrl points at
 *                              the local mock gateway (apps/web/dev/mock-gateway.mjs)
 *   - api()                  → canned REST for the boot burst (config/sessions/status)
 *   - subscriptions          → no-op unsubscribers
 *
 * M1 replaces this file with the WebCapabilityAdapter (three implementation
 * classes) and moves the gateway URL behind the real proxy protocol.
 */

const MOCK_GATEWAY_WS =
  (import.meta.env.VITE_MOCK_GATEWAY_WS as string | undefined) ?? 'ws://127.0.0.1:5180/gateway'

type Bridge = Window['hermesDesktop']

const noopUnsub = () => () => undefined

function subscribe<T>(_cb: (payload: T) => void): () => void {
  return () => undefined
}

function buildBridge(): Bridge {
  return {
    getConnection: async () => ({
      baseUrl: 'http://127.0.0.1:5180',
      isFullscreen: false,
      mode: 'remote',
      authMode: 'token',
      nativeOverlayWidth: 0,
      token: 'mock-token',
      wsUrl: MOCK_GATEWAY_WS,
      windowButtonPosition: null,
      logs: []
    }),
    getGatewayWsUrl: async () => ({ ok: true, wsUrl: MOCK_GATEWAY_WS }),
    revalidateConnection: async () => ({ ok: true, rebuilt: false }),
    touchBackend: async () => ({ ok: true }),
    getBootProgress: async () => ({
      error: null,
      fakeMode: false,
      message: '',
      phase: 'idle',
      progress: 0,
      running: false,
      timestamp: Date.now()
    }),
    onBootProgress: subscribe,
    onPowerResume: subscribe,
    onConnectionApplied: subscribe,
    onWindowStateChanged: subscribe,
    onBackendExit: subscribe,
    onPreviewFileChanged: subscribe,
    profile: {
      get: async () => ({ profile: null }),
      set: async () => ({ profile: null })
    },
    api: async request => mockApi(request),
    notify: async () => true,
    openExternal: async () => undefined,
    fetchLinkTitle: async () => '',
    readClipboard: async () => '',
    writeClipboard: async () => true,
    getPathForFile: () => '',
    // Keep the boot burst from throwing on anything we didn't stub.
    ...(globalThis as { __hermesMockCalls?: string[] }).__hermesMockCalls
      ? {}
      : {}
  } as Bridge
}

// ── Canned REST (enough for boot: config + defaults + empty sidebar) ──

async function mockApi(request: {
  path: string
  method?: string
  body?: unknown
}): Promise<unknown> {
  const { path, method = 'GET' } = request

  if (path === '/api/config' && method === 'GET') {
    return { config: {} }
  }

  if (path === '/api/config/defaults') {
    return {}
  }

  if (path === '/api/status') {
    return { ok: true, version: '0.0.0-mock', auth_mode: 'token' }
  }

  if (path.startsWith('/api/profiles/sessions/sidebar')) {
    return {
      recents: { sessions: [], profiles_truncated: {} },
      cron: { sessions: [] },
      messaging: { sessions: [] }
    }
  }

  if (path.startsWith('/api/sessions') && method === 'GET') {
    return { sessions: [], total: 0, offset: 0 }
  }

  if (path === '/api/model/info') {
    return { model: 'mock-model', provider: 'mock' }
  }

  if (path === '/api/model/options') {
    return { options: [] }
  }

  if (path === '/api/profiles') {
    return { profiles: [] }
  }

  if (path === '/api/cron/jobs') {
    return []
  }

  if (path === '/api/env') {
    return {}
  }

  if (path === '/api/skills') {
    return []
  }

  // Unknown endpoint → 404 shape like the backend catch-all.
  throw new Error('404: {"detail":"No such API endpoint: ' + path + '"}')
}

window.hermesDesktop = buildBridge()
