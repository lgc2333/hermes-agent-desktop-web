import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Browser, Page } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { launchBrowser } from './helpers/browser'
import {
  APP_URL,
  MOCK_TOKEN_PORT,
  repoRoot,
  startMock,
  stopByPort,
  waitForHttp,
} from './helpers/topology'
import { waitForReady, waitForBodyText, bootClean, poll } from './helpers/bridge'

// From cdp-attach.mjs — M8 / ADR-0020: drag a non-image file onto the composer,
// a chip appears, send it, and the mock gateway lands the bytes under
// temp/mock-attachments/. The app accepts files through the DnD drop handler on
// `[data-slot="composer-bounds"]` (there is no <input type="file">), so we
// attach by dispatching a `drop` DragEvent carrying a DataTransfer with a real
// File — the same mechanism cdp-attach.mjs drives over CDP.
// Uses the plain token mock (MOCK_TOKEN_PORT).
describe('attach: non-image file → chip → send → gateway lands it (ADR-0020)', () => {
  let browser: Browser
  let page: Page

  // The mock writes attachments here (mock-gateway.mjs MOCK_ATTACHMENTS_DIR).
  const ATTACH_DIR = path.join(repoRoot, 'temp', 'mock-attachments')
  const FILE_NAME = 'quarterly-report.txt'
  const FILE_CONTENT = 'M8 attachment payload: hello from attach.e2e 1234567890'
  let filePath = ''

  beforeAll(async () => {
    // Fresh temp file to attach + clear the mock's attachment dir first.
    const tempDir = path.join(repoRoot, 'temp')
    fs.mkdirSync(tempDir, { recursive: true })
    filePath = path.join(tempDir, FILE_NAME)
    fs.writeFileSync(filePath, FILE_CONTENT, 'utf8')
    fs.rmSync(ATTACH_DIR, { recursive: true, force: true })

    startMock(MOCK_TOKEN_PORT)
    await waitForHttp(`http://127.0.0.1:${MOCK_TOKEN_PORT}/api/status`)
    const launched = await launchBrowser()
    browser = launched.browser
    page = launched.page
    await page.goto(APP_URL)
    await waitForReady(page)
    await bootClean(page)
    await waitForBodyText(page, 'Gateway', { timeout: 60000, label: 'Gateway ready' })
  })

  afterAll(async () => {
    await browser?.close()
    stopByPort(MOCK_TOKEN_PORT)
  })

  it('attaches a non-image file via a drop (chip appears)', async () => {
    const bytes = fs.readFileSync(filePath)
    const b64 = bytes.toString('base64')
    const res = await page.evaluate(
      ({ name, type, b64 }) => {
        const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
        const file = new File([raw], name, { type })
        const dt = new DataTransfer()
        dt.items.add(file)
        const target =
          document.querySelector('[data-slot="composer-bounds"]') ||
          document.querySelector('[data-chat-surface]')
        if (!target) return { ok: false, reason: 'no drop-zone element' }
        target.dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
        )
        return { ok: true }
      },
      { name: FILE_NAME, type: 'text/plain', b64 },
    )
    expect(res.ok).toBe(true)
    // The attachment chip should surface the file name in the DOM.
    await waitForBodyText(page, FILE_NAME, { timeout: 20000, label: 'attachment chip visible' })
  })

  it('sends the message and the mock gateway lands the file under temp/mock-attachments/', async () => {
    // Focus the composer (largest visible contenteditable), type a message, send.
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('[contenteditable="true"]')].find(
        (e) => e.getBoundingClientRect().width > 50,
      ) as HTMLElement | undefined
      if (el) {
        el.focus()
        el.textContent = ''
      }
    })
    await page.keyboard.insertText('here is my report file')
    await page.waitForTimeout(300)
    await page.keyboard.press('Enter')

    // Message streams a reply.
    await waitForBodyText(page, 'Hello from the mock gateway', {
      timeout: 30000,
      label: 'streamed reply',
    })

    // The mock gateway should have written the uploaded bytes to its
    // attachments dir, named `<ts>-quarterly-report.txt`.
    const landed = await poll(
      () => {
        if (!fs.existsSync(ATTACH_DIR)) return null
        const files = fs.readdirSync(ATTACH_DIR).filter((f) => f.endsWith(`-${FILE_NAME}`))
        return files.length ? files[0] : null
      },
      { timeout: 10000, label: 'attachment landed' },
    )
    expect(landed).toBeTruthy()
    expect(fs.readFileSync(path.join(ATTACH_DIR, landed as string))).toEqual(
      fs.readFileSync(filePath),
    )
  })
})
