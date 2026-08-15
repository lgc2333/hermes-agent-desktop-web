/**
 * Connection registry — 连接定义 + 凭证全在浏览器（ADR-0002 / PLAN §6.1）。
 *
 * localStorage 键 `hermes-web.connections.v1`：
 *   - 一个默认连接指向本地 mock gateway（M1），M2 换成手填 URL + 代理协议；
 *   - token 静态长期凭证按连接存储，绝不进入任何代理/后端；
 *   - 换设备/换浏览器需重新填写（代价，ADR-0002 已接受）。
 *
 * 本模块只负责存取，不依赖 window.hermesDesktop；可单测。
 */

const CONNECTIONS_KEY = 'hermes-web.connections.v1'
const PROFILE_KEY = 'hermes-web.profile.v1'

export const DEFAULT_CONNECTION_ID = 'local'

export interface WebConnectionRecord {
  id: string
  label: string
  kind: 'cloud' | 'local' | 'remote' | 'ssh'
  /** Gateway base URL, e.g. http://127.0.0.1:5180 */
  url: string
  authMode: 'oauth' | 'token'
  /** Static session token (token auth mode). Stored in the browser only. */
  token: string
}

export interface WebConnectionsStore {
  version: 1
  primary: string
  connections: WebConnectionRecord[]
}

export function defaultMockConnection(): WebConnectionRecord {
  const ws = (import.meta.env.VITE_MOCK_GATEWAY_WS as string | undefined) ?? 'ws://127.0.0.1:5180/gateway'
  const base = ws.replace(/^ws/, 'http').replace(/\/gateway$/, '')

  return {
    id: DEFAULT_CONNECTION_ID,
    label: 'Mock gateway',
    kind: 'remote',
    url: base,
    authMode: 'token',
    token: 'mock-token'
  }
}

function readRaw(): WebConnectionsStore | null {
  try {
    const raw = window.localStorage.getItem(CONNECTIONS_KEY)

    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw) as WebConnectionsStore

    return parsed?.version === 1 && Array.isArray(parsed.connections) ? parsed : null
  } catch {
    return null
  }
}

function writeRaw(store: WebConnectionsStore): void {
  try {
    window.localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(store))
  } catch {
    // localStorage unavailable (private mode / quota) — registry stays in-memory.
  }
}

/** Registry 读取；首次访问时播种默认 mock 连接（幂等）。 */
export function loadRegistry(): WebConnectionsStore {
  const existing = readRaw()

  if (existing) {
    return existing
  }

  const seeded: WebConnectionsStore = {
    version: 1,
    primary: DEFAULT_CONNECTION_ID,
    connections: [defaultMockConnection()]
  }
  writeRaw(seeded)

  return seeded
}

export function getPrimaryConnection(): WebConnectionRecord {
  const registry = loadRegistry()

  return (
    registry.connections.find(c => c.id === registry.primary) ??
    registry.connections[0] ??
    defaultMockConnection()
  )
}

export function saveRegistry(store: WebConnectionsStore): void {
  writeRaw(store)
}

export function upsertConnection(record: WebConnectionRecord): WebConnectionsStore {
  const registry = loadRegistry()
  const index = registry.connections.findIndex(c => c.id === record.id)

  if (index >= 0) {
    registry.connections[index] = record
  } else {
    registry.connections.push(record)
  }
  saveRegistry(registry)

  return registry
}

export function removeConnection(id: string): WebConnectionsStore {
  const registry = loadRegistry()
  registry.connections = registry.connections.filter(c => c.id !== id)

  if (registry.primary === id) {
    registry.primary = registry.connections[0]?.id ?? DEFAULT_CONNECTION_ID
  }
  saveRegistry(registry)

  return registry
}

export function setPrimaryConnection(id: string): WebConnectionsStore {
  const registry = loadRegistry()
  registry.primary = registry.connections.some(c => c.id === id) ? id : registry.primary
  saveRegistry(registry)

  return registry
}

// ── Profile preference (renderer's DesktopActiveProfile twin) ──────────────

export function readProfilePreference(): string | null {
  try {
    return window.localStorage.getItem(PROFILE_KEY)
  } catch {
    return null
  }
}

export function writeProfilePreference(name: string | null): void {
  try {
    if (name) {
      window.localStorage.setItem(PROFILE_KEY, name)
    } else {
      window.localStorage.removeItem(PROFILE_KEY)
    }
  } catch {
    // ignore — preference is best-effort
  }
}
