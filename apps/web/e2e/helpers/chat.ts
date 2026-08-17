import type { Page } from 'playwright'

/** Focus the visible composer (a contenteditable element, largest visible one). */
export async function focusComposer(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll('[contenteditable="true"]')].find(
      (e) => e.getBoundingClientRect().width > 50,
    )
    if (!el) return false
    ;(el as HTMLElement).focus()
    el.textContent = ''
    return true
  })
}

/** Focus the composer, type text and press Enter to submit. */
export async function sendChat(page: Page, text: string): Promise<void> {
  await focusComposer(page)
  await page.keyboard.insertText(text)
  await page.keyboard.press('Enter')
}
