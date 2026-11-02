import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadRegistry } from '../registry'
import { createWebUiPreferences } from './ui-preferences'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const snapshot = { exists: true, generation: 'g1', values: {} }

describe('createWebUiPreferences (gateway /api/ui-preferences 代理读写)', () => {
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

  it('read GETs the gateway endpoint through the proxy with the session token', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, snapshot))

    await expect(createWebUiPreferences().read()).resolves.toEqual(snapshot)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${window.location.origin}/api/ui-preferences`)
    expect(init.method).toBe('GET')
    expect(init.headers['X-Hermes-Session-Token']).toBe('mock-token')
    expect(init.headers['X-Hermes-Target']).toBe('http://127.0.0.1:5180')
  })

  it('write PATCHes the payload as JSON', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, snapshot))
    const payload = { generation: 'g1', values: { 'hermes:theme': 'dark' } }

    await createWebUiPreferences().write(payload)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${window.location.origin}/api/ui-preferences`)
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual(payload)
  })

  it('surfaces gateway errors instead of a silent empty snapshot', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { detail: 'nope' }))

    await expect(createWebUiPreferences().read()).rejects.toThrow(/404/)
  })

  it('onChanged polls on visibility and unsubscribes cleanly', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(jsonResponse(200, snapshot))
    const changes: unknown[] = []
    const stop = createWebUiPreferences().onChanged!((value) => changes.push(value))

    await vi.advanceTimersByTimeAsync(10_000)
    expect(changes).toEqual([snapshot])

    stop()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(changes).toEqual([snapshot])
    vi.useRealTimers()
  })
})
