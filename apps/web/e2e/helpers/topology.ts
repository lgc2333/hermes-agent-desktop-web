import { spawn, execSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * Topology management for Playwright e2e.
 *
 * Ports are fixed (the SPA, proxy and gateway all bind concrete loopback
 * ports), so the suite runs with a single worker and each spec starts the
 * mocks it needs in beforeAll and tears them down in afterAll. The Deno proxy
 * and Vite dev server are long-lived and shared across the whole run
 * (started in global-setup, stopped in global-teardown).
 *
 * Deliberately NOT `dev/dev.mjs`: that driver kills every sibling child the
 * moment one exits, so killing the mock mid-test (reconnect scenarios) would
 * cascade into killing the proxy and Vite. Here each process is tracked
 * independently and `stopByPort` only touches that one port.
 */

export const here = path.dirname(fileURLToPath(import.meta.url)) // apps/web/e2e/helpers
export const repoRoot = path.resolve(here, '..', '..', '..', '..')
export const appRoot = path.resolve(here, '..', '..')

/**
 * E2E topology ports. These deliberately differ from the `pnpm dev` defaults
 * (mock 5180 / proxy 6722 / vite 5173) so the suite never collides with a dev
 * stack you are already running. Each is overridable via env (E2E_*_PORT).
 */
function portOf(name: string, fallback: number): number {
  const raw = process.env[name]
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const VITE_PORT = portOf('E2E_VITE_PORT', 5213)
export const PROXY_PORT = portOf('E2E_PROXY_PORT', 6813)
export const APP_URL = `http://127.0.0.1:${VITE_PORT}`
export const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`
// Plain token mock; gated OAuth mock; password mock.
export const MOCK_TOKEN_PORT = portOf('E2E_MOCK_TOKEN_PORT', 5190)
export const MOCK_OAUTH_PORT = portOf('E2E_MOCK_OAUTH_PORT', 5192)
export const MOCK_PASSWORD_PORT = portOf('E2E_MOCK_PASSWORD_PORT', 5193)

export const proxyEntry = path.join(repoRoot, 'apps', 'proxy', 'src', 'main.ts')
// The workspace uses pnpm's hoisted nodeLinker, so vite lives at the repo-root
// node_modules, not apps/web/node_modules. Resolve whichever exists (CI installs
// fresh; the hoisted root is where `pnpm install --frozen-lockfile` puts it).
export const viteBin = [
  path.join(appRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
  path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
].find((p) => existsSync(p))!
export const mockEntry = path.join(appRoot, 'dev', 'mock-gateway.mjs')

const children = new Map<string, ChildProcess>()

/** system tool to enumerate PIDs listening on `port`; returns [] if none. */
function pidsByPortSystem(port: number): number[] {
  // ss -ltnp lines look like:
  //   LISTEN 0 511 127.0.0.1:5190 0.0.0.0:* users:(("node-MainThread",pid=123,fd=18))
  // Match line-by-line so we only take pids from the exact port.
  try {
    const out = execSync(`ss -ltnp 2>/dev/null || true`, { encoding: 'utf8' })
    const pids = new Set<number>()
    for (const line of out.split('\n')) {
      if (!new RegExp(`:${port}\\b`, 'i').test(line)) continue
      for (const m of line.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]))
    }
    if (pids.size) return [...pids]
  } catch {
    /* ss unavailable — fall through to fuser */
  }
  // fallback: fuser PORT/tcp prints "6305/tcp:  123"
  try {
    const out = execSync(`fuser ${port}/tcp 2>/dev/null || true`, { encoding: 'utf8' })
    const pids = new Set<number>()
    for (const tok of out.split(/[\s(),"pid=]+/)) {
      const n = Number(tok)
      if (Number.isInteger(n) && n > 0) pids.add(n)
    }
    return [...pids]
  } catch {
    return []
  }
}

/**
 * PIDs of processes listening on `port` (TCP). Uses the system socket tools
 * (`ss`/`fuser`, reliable on Linux/CI runners) rather than a hand-rolled
 * /proc scan (the inode-to-FD walk is brittle: permission denials on other
 * users' proc dirs abort it, and reaped FDs are mishandled). Windows: via
 * PowerShell. Returns [] if none.
 */
export function pidsByPort(port: number): number[] {
  return process.platform === 'win32' ? [] : pidsByPortSystem(port)
}

/** Kill every process listening on `port` (system tools on Linux/macOS; PowerShell on Windows). */
export function killPort(port: number): void {
  const pids = process.platform === 'win32' ? [] : pidsByPortSystem(port)
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  if (process.platform === 'win32') {
    try {
      execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"`,
        { stdio: 'ignore' },
      )
    } catch {
      /* nothing listening on that port — fine */
    }
  }
}

function track(key: string, child: ChildProcess): void {
  children.set(key, child)
  child.on('error', (e) => {
    console.error(`[e2e-topology] ${key} spawn error: ${e.code ?? e.message}`)
  })
  child.on('exit', () => children.delete(key))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitForHttp(url: string, timeoutMs = 40000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url)
      // 401 is "up" too (e.g. a gated mock rejecting an anonymous probe).
      if (r.ok || r.status === 401) return
      last = r.status
    } catch (e) {
      last = (e as Error).message
    }
    await sleep(500)
  }
  throw new Error(`waitForHttp timeout: ${url} (last=${String(last)})`)
}

/** Spawn the Deno thin proxy (idempotent per port — kills existing first). */
export function startProxy(port = PROXY_PORT): ChildProcess {
  killPort(port)
  const c = spawn(
    'deno',
    ['run', '--allow-net', '--allow-read', '--allow-env', proxyEntry],
    {
      cwd: repoRoot,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PORT: String(port) },
    },
  )
  c.unref()
  track(`proxy:${port}`, c)
  return c
}

/** Spawn the Vite dev server for the SPA (with the e2e proxy + mock injected). */
export function startVite(opts?: {
  vitePort?: number
  proxyPort?: number
  mockGatewayWs?: string
}): ChildProcess {
  const vitePort = opts?.vitePort ?? VITE_PORT
  const proxyUrl = `http://127.0.0.1:${opts?.proxyPort ?? PROXY_PORT}`
  const mockGatewayWs =
    opts?.mockGatewayWs ?? `ws://127.0.0.1:${MOCK_TOKEN_PORT}/gateway`
  killPort(vitePort)
  const c = spawn(
    process.execPath,
    [viteBin, '--host', '127.0.0.1', '--port', String(vitePort)],
    {
      cwd: appRoot,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        VITE_PROXY_URL: proxyUrl,
        // Seeded default connection (registry.ts) already points at the e2e
        // token mock, so a cleared-registry boot probes the right port.
        VITE_MOCK_GATEWAY_WS: mockGatewayWs,
      },
    },
  )
  c.unref()
  track(`vite:${vitePort}`, c)
  return c
}

/**
 * Per-worker port block (Playwright migration). Each worker owns a disjoint,
 * deterministic slice so its mock/proxy/Vite never collide with another
 * worker's, even when a spec restarts its own proxy. `workerIndex` is 0-based.
 */
export function portsFor(workerIndex: number): {
  tokenPort: number
  oauthPort: number
  passwordPort: number
  proxyPort: number
  vitePort: number
} {
  const tokenPort = 30000 + workerIndex * 3
  return {
    tokenPort,
    oauthPort: tokenPort + 1,
    passwordPort: tokenPort + 2,
    proxyPort: 28100 + workerIndex,
    vitePort: 27100 + workerIndex,
  }
}

export interface MockOptions {
  oauth?: boolean
  password?: boolean
}

/** Spawn the mock gateway on `port` with optional OAuth/password gating. */
export function startMock(port: number, opts: MockOptions = {}): ChildProcess {
  killPort(port)
  const env: Record<string, string> = { ...(process.env as NodeJS.ProcessEnv) }
  if (opts.oauth) env.MOCK_OAUTH = '1'
  if (opts.password) env.MOCK_PASSWORD = '1'
  const c = spawn(process.execPath, [mockEntry, String(port)], {
    cwd: appRoot,
    detached: true,
    stdio: 'ignore',
    env,
  })
  c.unref()
  track(`mock:${port}`, c)
  return c
}

/** Stop whatever this suite started on `port` (kills the tracked child + port). */
export function stopByPort(port: number): void {
  const keys = [...children.keys()].filter((k) => k.endsWith(`:${port}`))
  for (const k of keys) {
    try {
      children.get(k)?.kill()
    } catch {
      /* already gone */
    }
    children.delete(k)
  }
  killPort(port)
}

/** Start the shared long-lived stack: proxy + Vite. Used by global-setup. */
export async function startSharedStack(): Promise<void> {
  startProxy()
  await waitForHttp(`${PROXY_URL}/api/proxy/meta`)
  startVite()
  await waitForHttp(APP_URL)
}

/** Teardown everything (shared + any leaked ports). Used by global-teardown. */
export function teardownAll(): void {
  for (const c of children.values()) {
    try {
      c.kill()
    } catch {
      /* already gone */
    }
  }
  children.clear()
  for (const port of [
    PROXY_PORT,
    VITE_PORT,
    MOCK_TOKEN_PORT,
    MOCK_OAUTH_PORT,
    MOCK_PASSWORD_PORT,
  ]) {
    killPort(port)
  }
}
