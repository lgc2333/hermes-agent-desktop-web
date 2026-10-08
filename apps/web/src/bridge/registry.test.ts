import { beforeEach, describe, expect, it } from 'vitest'

import {
  defaultMockConnection,
  getConnectionById,
  getPrimaryConnection,
  loadRegistry,
  removeConnection,
  setLastUsedConnection,
  setLaunchMode,
  setPrimaryConnection,
  upsertConnection,
  writeProfilePreference,
  readProfilePreference,
  DEFAULT_CONNECTION_ID,
} from './registry'

describe('connection registry (ADR-0002: credentials in browser)', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('seeds a default mock connection on first load', () => {
    const registry = loadRegistry()

    expect(registry.version).toBe(1)
    expect(registry.primary).toBe(DEFAULT_CONNECTION_ID)
    expect(registry.connections).toHaveLength(1)
    expect(registry.connections[0].url).toBe('http://127.0.0.1:5180')
    expect(registry.connections[0].token).toBe('mock-token')
  })

  it('persists across reloads (same localStorage)', () => {
    loadRegistry()
    upsertConnection({
      id: 'prod',
      label: 'Prod',
      kind: 'remote',
      url: 'https://hermes.example',
      authMode: 'token',
      token: 'secret-1',
    })

    const reloaded = loadRegistry()
    expect(reloaded.connections.find((c) => c.id === 'prod')?.token).toBe('secret-1')
  })

  it('getPrimaryConnection falls back to the seeded default when registry is empty', () => {
    window.localStorage.clear()
    const conn = getPrimaryConnection()

    expect(conn.id).toBe(DEFAULT_CONNECTION_ID)
  })

  it('getConnectionById resolves named sources and falls back safely', () => {
    loadRegistry()
    upsertConnection({
      id: 'prod',
      label: 'Prod',
      kind: 'remote',
      url: 'https://hermes.example',
      authMode: 'token',
      token: 'prod-token',
    })

    expect(getConnectionById('prod').url).toBe('https://hermes.example')
    expect(getConnectionById('missing').id).toBe(DEFAULT_CONNECTION_ID)
    expect(getConnectionById('local').id).toBe(DEFAULT_CONNECTION_ID)
  })

  it('setPrimaryConnection throws for unknown ids and only changes primary', () => {
    loadRegistry()

    // 未知 id 抛错（上游 setPrimaryConnection 同款），不静默回落 primary。
    expect(() => setPrimaryConnection('nope')).toThrow(/No connection with id "nope"\./)

    upsertConnection({
      id: 'a',
      label: 'A',
      kind: 'remote',
      url: 'http://a',
      authMode: 'token',
      token: '',
    })

    const switched = setPrimaryConnection('a')
    expect(switched.primary).toBe('a')
    // 只改 primary：lastUsed 由渲染层成功切换后单独记（store/connections.ts:176-190）。
    expect(switched.lastUsed).toBe(DEFAULT_CONNECTION_ID)

    // 隐式 local 始终可解析。
    expect(setPrimaryConnection('local').primary).toBe('local')
  })

  it('removeConnection re-points primary to the remaining entry', () => {
    loadRegistry()
    upsertConnection({
      id: 'a',
      label: 'A',
      kind: 'remote',
      url: 'http://a',
      authMode: 'token',
      token: '',
    })
    setPrimaryConnection('a')

    const registry = removeConnection('a')
    expect(registry.primary).toBe(DEFAULT_CONNECTION_ID)
  })

  it('defaultMockConnection derives the base URL from the gateway ws URL', () => {
    const conn = defaultMockConnection()

    expect(conn.url).toBe('http://127.0.0.1:5180')
    expect(conn.authMode).toBe('token')
  })
})

describe('profile preference', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('round-trips null and named profiles', () => {
    expect(readProfilePreference()).toBeNull()
    writeProfilePreference('work')
    expect(readProfilePreference()).toBe('work')
    writeProfilePreference(null)
    expect(readProfilePreference()).toBeNull()
  })
})

/** C 组（ADR-0027）：launchMode / lastUsed 两个注册表字段。 */
describe('launch mode + last used', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('seeds primary launch mode and lastUsed = primary', () => {
    const registry = loadRegistry()

    expect(registry.launchMode).toBe('primary')
    expect(registry.lastUsed).toBe(DEFAULT_CONNECTION_ID)
  })

  it('normalizes a legacy registry without the new fields', () => {
    window.localStorage.setItem(
      'hermes-web.connections.v1',
      JSON.stringify({
        version: 1,
        primary: 'prod',
        connections: [
          {
            id: 'prod',
            label: 'Prod',
            kind: 'remote',
            url: 'https://p',
            authMode: 'token',
            token: 't',
          },
        ],
      }),
    )

    const registry = loadRegistry()
    expect(registry.launchMode).toBe('primary')
    expect(registry.lastUsed).toBe('prod')
  })

  it('falls lastUsed back to primary when it names a removed connection', () => {
    window.localStorage.setItem(
      'hermes-web.connections.v1',
      JSON.stringify({
        version: 1,
        primary: 'a',
        launchMode: 'last-used',
        lastUsed: 'ghost',
        connections: [
          {
            id: 'a',
            label: 'A',
            kind: 'remote',
            url: 'https://a',
            authMode: 'token',
            token: 't',
          },
        ],
      }),
    )

    const registry = loadRegistry()
    expect(registry.launchMode).toBe('last-used')
    expect(registry.lastUsed).toBe('a')
  })

  it('setLaunchMode writes and rejects unknown modes', () => {
    loadRegistry()

    expect(setLaunchMode('last-used').launchMode).toBe('last-used')
    expect(loadRegistry().launchMode).toBe('last-used')
    expect(() => setLaunchMode('bogus')).toThrow(/Unknown connection launch mode/)
    // 非法值不落盘。
    expect(loadRegistry().launchMode).toBe('last-used')
  })

  it('setLastUsedConnection throws for unknown ids and drops on removal', () => {
    loadRegistry()
    upsertConnection({
      id: 'prod',
      label: 'Prod',
      kind: 'remote',
      url: 'https://p',
      authMode: 'token',
      token: 't',
    })

    expect(setLastUsedConnection('prod').lastUsed).toBe('prod')
    // 未知 id 抛错（上游 connection-registry.ts:1570-1576 同款）。
    expect(() => setLastUsedConnection('ghost')).toThrow(
      /No connection with id "ghost"\./,
    )
    expect(() => setLastUsedConnection('')).toThrow(/No connection with id ""\./)
    // 隐式 local 可解析。
    expect(setLastUsedConnection('local').lastUsed).toBe('local')

    setLastUsedConnection('prod')
    expect(removeConnection('prod').lastUsed).toBe(DEFAULT_CONNECTION_ID)
  })
})
