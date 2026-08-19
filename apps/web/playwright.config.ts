import { defineConfig } from '@playwright/test'
import process from 'node:process'

/**
 * Playwright Test runner for the browser e2e suite (migrated from the old
 * vitest + hand-rolled `playwright` client setup — see e2e/AGENTS.md).
 *
 * Isolation model: each Playwright WORKER gets its OWN Deno proxy + Vite dev
 * server + mock ports, built by the worker-scoped `stack` fixture in
 * `e2e/fixtures.ts`. Because the topology is per-worker, a spec that restarts
 * its own proxy (reconnect B) can never disturb another worker's connections —
 * this is what makes file parallelism safe (the old code shared ONE proxy
 * singleton that reconnect B restarted mid-run, forcing serial execution).
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  // One file per worker at a time (files may share a worker sequentially);
  // the per-worker `stack` fixture gives safe isolation for parallelism.
  fullyParallel: false,
  workers: 4,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  // Flakiness multiplier only outside CI; CI is the source of truth.
  retries: process.env.CI ? 0 : 1,
  reporter: [['list']],
  use: {
    headless: true,
    // `window.open` from a non-gesture context must open the OAuth popup.
    launchOptions: {
      args: [
        '--disable-popup-blocking',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
      ],
    },
  },
})
