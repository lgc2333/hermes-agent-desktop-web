import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Vitest config for the browser e2e suite (migrated from the old CDP
 * cdp-*.mjs scripts). See e2e/AGENTS.md for the topology contract.
 *
 * Runs in a Node environment and drives real Chromium through the Playwright
 * client (no hand-rolled CDP, no separate @playwright/test runner). The SPA
 * talks through the same-origin Deno proxy (ADR-0016). The e2e stack uses
 * its own ports (E2E_*_PORT, distinct from `pnpm dev`) and must run serially:
 * the proxy + Vite dev server are started once by global-setup and shared,
 * and each spec starts/tears down its own mocks.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['e2e/**/*.e2e.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Distinct ports + shared proxy/Vite ⇒ serial, single worker.
    pool: 'threads',
    fileParallelism: false,
    maxWorkers: 1,
    globalSetup: [path.join(here, 'e2e', 'global-setup.ts')],
  },
})

