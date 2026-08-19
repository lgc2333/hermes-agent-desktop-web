import { test as base } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import {
  portsFor,
  startProxy,
  startVite,
  stopByPort,
  killPort,
  waitForHttp,
} from './helpers/topology'

/**
 * Playwright fixtures for the e2e suite.
 *
 * `stack` is a WORKER-scoped fixture: each Playwright worker gets its OWN Deno
 * proxy + Vite dev server, with mock ports derived from the worker index. This
 * is the isolation that makes file parallelism safe — a spec that restarts its
 * own proxy (reconnect B) never touches another worker's connections.
 *
 * Migrated specs import `{ test, expect }` from HERE (not from
 * `@playwright/test`), so they get the `stack` fixture for free. Per-worker
 * proxy/Vite are spawned once per worker; each spec starts/tears down the
 * mocks it needs via `startMock/stopByPort` (see helpers/topology).
 */

export type { Page } from '@playwright/test'
export const expect = base.expect

export interface E2EStack {
  /** 0-based Playwright worker index. */
  worker: number
  tokenPort: number
  oauthPort: number
  passwordPort: number
  proxyPort: number
  vitePort: number
  /** http://127.0.0.1:<vitePort> — boot target for this worker's SPA. */
  appUrl: string
  /** http://127.0.0.1:<tokenPort> — plain token mock target. */
  tokenTarget: string
  /** http://127.0.0.1:<oauthPort> — gated OAuth mock target. */
  oauthTarget: string
  /** Start a mock on `port` (token by default; oauth/password via opts). */
  startMock: (
    port: number,
    opts?: { oauth?: boolean; password?: boolean },
  ) => ChildProcess
  /** Kill whatever is listening on `port` (this worker's own process). */
  stopMock: (port: number) => void
}

export const test = base.extend<{ stack: E2EStack }>({
  stack: [
    // Playwright requires the first fixture arg to be an object destructuring
    // pattern; an empty `{}` is exactly that, but eslint flags it.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, workerInfo) => {
      const p = portsFor(workerInfo.workerIndex)

      // This worker's own long-lived stack (started once per worker).
      startProxy(p.proxyPort)
      await waitForHttp(`http://127.0.0.1:${p.proxyPort}/api/proxy/meta`)
      // Each worker's Vite bakes ITS OWN proxy URL + default-seed mock WS, so a
      // cleared-registry boot auto-probes this worker's token mock (no app
      // change needed — VITE_MOCK_GATEWAY_WS stays the seed source).
      startVite({
        vitePort: p.vitePort,
        proxyPort: p.proxyPort,
        mockGatewayWs: `ws://127.0.0.1:${p.tokenPort}/gateway`,
      })
      await waitForHttp(`http://127.0.0.1:${p.vitePort}`)

      const stack: E2EStack = {
        worker: workerInfo.workerIndex,
        ...p,
        appUrl: `http://127.0.0.1:${p.vitePort}`,
        tokenTarget: `http://127.0.0.1:${p.tokenPort}`,
        oauthTarget: `http://127.0.0.1:${p.oauthPort}`,
        startMock: (port, opts) => startMock(port, opts),
        stopMock: (port) => stopByPort(port),
      }

      await use(stack)

      // Worker-scoped teardown: kill this worker's proxy + Vite + any mocks.
      killPort(p.vitePort)
      killPort(p.proxyPort)
      killPort(p.tokenPort)
      killPort(p.oauthPort)
      killPort(p.passwordPort)
    },
    { scope: 'worker' },
  ],
})
