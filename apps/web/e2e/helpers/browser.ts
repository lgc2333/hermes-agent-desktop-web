import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

/**
 * Launch a headless Chromium context for one e2e test file.
 * Flags mirror the old headless-Chrome setup: popups must open without a user
 * gesture for the OAuth login window; no first-run dialogs.
 */
export async function launchBrowser(): Promise<{
  browser: Browser
  context: BrowserContext
  page: Page
}> {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-popup-blocking',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
    ],
  })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()
  return { browser, context, page }
}

export async function launchMobilePage(): Promise<{
  browser: Browser
  context: BrowserContext
  page: Page
}> {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-popup-blocking',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
    ],
  })
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  })
  const page = await context.newPage()
  return { browser, context, page }
}
