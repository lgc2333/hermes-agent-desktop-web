import { beforeEach, describe, expect, it } from 'vitest'

import {
  defaultMockConnection,
  getPrimaryConnection,
  loadRegistry,
  removeConnection,
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

  it('setPrimaryConnection only accepts known ids', () => {
    loadRegistry()
    const registry = setPrimaryConnection('nope')
    expect(registry.primary).toBe(DEFAULT_CONNECTION_ID)

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
