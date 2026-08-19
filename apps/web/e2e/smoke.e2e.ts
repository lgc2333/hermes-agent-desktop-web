import { test, expect } from './fixtures'
import { startMock, stopByPort, waitForHttp } from './helpers/topology'
import { clearRegistry } from './helpers/registry'
import { waitForReady, waitFor } from './helpers/bridge'

// Reference migration (vitest describe/it → playwright test + step).
// See e2e/AGENTS.md; the per-worker `stack` fixture supplies ports + targets,
// and the proxy/Vite are already up for this worker (see e2e/fixtures.ts).

test.describe('smoke: app boots against the per-worker token-mock topology', () => {
  test('installs the bridge and renders the app', async ({ page, stack }) => {
    startMock(stack.tokenPort)
    await waitForHttp(`${stack.tokenTarget}/api/status`)

    await page.goto(stack.appUrl)
    await waitForReady(page)
    // no cross-test registry pollution — start clean
    await clearRegistry(page)
    await page.reload()
    await waitForReady(page, 60000)

    expect(await page.evaluate(() => !!(window as any).hermesDesktop)).toBe(true)

    // Gateway status appears in the status bar once booted/reconciled.
    await waitFor(page, () => document.body.innerText.includes('Gateway'), {
      timeout: 15000,
      label: 'Gateway status',
    })

    stopByPort(stack.tokenPort)
  })
})
