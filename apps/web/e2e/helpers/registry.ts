import type { Page } from 'playwright'

/** Connection registry lives in localStorage (ADR-0002 / PLAN §6.1). */
export const CONNECTIONS_KEY = 'hermes-web.connections.v1'

export interface WebConnectionRecord {
  id: string
  label: string
  kind: 'cloud' | 'local' | 'remote' | 'ssh'
  url: string
  authMode: 'oauth' | 'token'
  token: string
}

export interface WebConnectionsStore {
  version: 1
  primary: string
  connections: WebConnectionRecord[]
}

export const clearRegistry = (page: Page) =>
  page.evaluate((k) => localStorage.removeItem(k), CONNECTIONS_KEY)

export const setRegistry = (page: Page, store: WebConnectionsStore) =>
  page.evaluate(
    (s) => localStorage.setItem('hermes-web.connections.v1', JSON.stringify(s)),
    store,
  )

export const readRegistry = (page: Page) =>
  page.evaluate(
    (k) => JSON.parse(localStorage.getItem(k) ?? 'null'),
    CONNECTIONS_KEY,
  ) as Promise<WebConnectionsStore>

/** A token-mode registry pointing at a single gateway URL. */
export function tokenRegistry(
  url: string,
  token = 'mock-token',
  id = 'gw',
): WebConnectionsStore {
  return {
    version: 1,
    primary: id,
    connections: [{ id, label: id, kind: 'remote', url, authMode: 'token', token }],
  }
}
