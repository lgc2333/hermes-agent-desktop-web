import { test, expect } from './fixtures'
import fs from 'node:fs'
import path from 'node:path'
import { repoRoot, startMock, stopByPort, waitForHttp } from './helpers/topology'
import { waitForReady, waitForBodyText, bootClean, poll } from './helpers/bridge'

// From cdp-attach.mjs — M8 / ADR-0020: 把非图片文件拖到 composer，出现 chip，发送，
// mock gateway 把字节落盘到 temp/mock-attachments/。应用通过 [data-slot="composer-bounds"]
// 上的 DnD drop handler 接受文件（没有 <input type="file">），所以用携带真实 File 的
// DataTransfer 派发 drop DragEvent——与 cdp-attach.mjs 走 CDP 的机制一致。
// 用 plain token mock。

// mock 会把附件写到这里（mock-gateway.mjs MOCK_ATTACHMENTS_DIR）。
const ATTACH_DIR = path.join(repoRoot, 'temp', 'mock-attachments')
const FILE_NAME = 'quarterly-report.txt'
const FILE_CONTENT = 'M8 attachment payload: hello from attach.e2e 1234567890'

test.describe('attach: non-image file → chip → send → gateway lands it (ADR-0020)', () => {
  test('attach: non-image file → chip → send → gateway lands it (ADR-0020)', async ({
    page,
    stack,
  }) => {
    const tempDir = path.join(repoRoot, 'temp')
    fs.mkdirSync(tempDir, { recursive: true })
    const filePath = path.join(tempDir, FILE_NAME)
    fs.writeFileSync(filePath, FILE_CONTENT, 'utf8')
    fs.rmSync(ATTACH_DIR, { recursive: true, force: true })

    startMock(stack.tokenPort)
    await waitForHttp(`${stack.tokenTarget}/api/status`)
    await page.goto(stack.appUrl)
    await waitForReady(page)
    await bootClean(page)
    await waitForBodyText(page, 'Gateway', { timeout: 60000, label: 'Gateway ready' })

    await test.step('attaches a non-image file via a drop (chip appears)', async () => {
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
            new DragEvent('drop', {
              bubbles: true,
              cancelable: true,
              dataTransfer: dt,
            }),
          )
          return { ok: true }
        },
        { name: FILE_NAME, type: 'text/plain', b64 },
      )
      expect(res.ok).toBe(true)
      // 附件 chip 应在 DOM 里暴露文件名。
      await waitForBodyText(page, FILE_NAME, {
        timeout: 20000,
        label: 'attachment chip visible',
      })
    })

    await test.step('sends the message and the mock gateway lands the file under temp/mock-attachments/', async () => {
      // 聚焦 composer（最大的可见 contenteditable），输入消息并发送。
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

      // 消息流式回复。
      await waitForBodyText(page, 'Hello from the mock gateway', {
        timeout: 30000,
        label: 'streamed reply',
      })

      // mock gateway 应把上传字节写到其附件目录，命名为 <ts>-quarterly-report.txt。
      const landed = await poll(
        () => {
          if (!fs.existsSync(ATTACH_DIR)) return null
          const files = fs
            .readdirSync(ATTACH_DIR)
            .filter((f) => f.endsWith(`-${FILE_NAME}`))
          return files.length ? files[0] : null
        },
        { timeout: 10000, label: 'attachment landed' },
      )
      expect(landed).toBeTruthy()
      expect(fs.readFileSync(path.join(ATTACH_DIR, landed as string))).toEqual(
        fs.readFileSync(filePath),
      )
    })

    stopByPort(stack.tokenPort)
  })
})
