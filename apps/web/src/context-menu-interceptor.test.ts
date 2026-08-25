import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { installContextMenuInterceptor } from './context-menu-interceptor'

function attach(html: string): HTMLElement {
  const host = document.createElement('div')

  host.innerHTML = html
  document.body.appendChild(host)

  return host
}

describe('context-menu-interceptor (web)', () => {
  let uninstall: () => void
  // A capture listener registered AFTER the interceptor — this is the vendor
  // AppContextMenu listener in production (it mounts in a React effect). A
  // `stopImmediatePropagation` from the interceptor must shut it out.
  let probeListener: ((event: Event) => void) | null = null

  beforeEach(() => {
    uninstall = installContextMenuInterceptor()
  })

  afterEach(() => {
    uninstall()
    if (probeListener) {
      window.removeEventListener('contextmenu', probeListener, true)
      probeListener = null
    }
    document.body.innerHTML = ''
  })

  function registerProbe(calls: string[]): void {
    probeListener = () => calls.push('app-menu')
    window.addEventListener('contextmenu', probeListener, true)
  }

  function dispatchOn(
    selector: string,
    html: string,
  ): { defaultPrevented: boolean; calls: string[] } {
    const calls: string[] = []

    registerProbe(calls)
    const host = attach(html)

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })

    host.querySelector(selector)!.dispatchEvent(event)

    return { defaultPrevented: event.defaultPrevented, calls }
  }

  it('suppresses the native menu on non-text surfaces and lets the app menu run', () => {
    const { defaultPrevented, calls } = dispatchOn('p', '<p>plain chrome</p>')

    // preventDefault keeps the browser menu out; propagation continues so the
    // app menu (the later listener) still opens.
    expect(defaultPrevented).toBe(true)
    expect(calls).toEqual(['app-menu'])
  })

  it('keeps the native text menu on an editable: no preventDefault, no app menu', () => {
    const { defaultPrevented, calls } = dispatchOn('textarea', '<textarea></textarea>')

    expect(defaultPrevented).toBe(false)
    expect(calls).toEqual([])
  })

  it('treats a contenteditable host as an editable', () => {
    const { defaultPrevented, calls } = dispatchOn(
      'span',
      '<div contenteditable="true"><span>text</span></div>',
    )

    expect(defaultPrevented).toBe(false)
    expect(calls).toEqual([])
  })

  it('keeps the app menu on a contenteditable=false host', () => {
    const { defaultPrevented, calls } = dispatchOn(
      'span',
      '<div contenteditable="false"><span>text</span></div>',
    )

    expect(defaultPrevented).toBe(true)
    expect(calls).toEqual(['app-menu'])
  })

  it('treats readonly inputs as non-editable (matches the vendor resolver)', () => {
    const { defaultPrevented, calls } = dispatchOn('input', '<input readonly>')

    expect(defaultPrevented).toBe(true)
    expect(calls).toEqual(['app-menu'])
  })

  it('suppresses the native menu on links so the app link menu does not stack', () => {
    const { defaultPrevented, calls } = dispatchOn(
      'a',
      '<a href="https://example.com">link</a>',
    )

    expect(defaultPrevented).toBe(true)
    expect(calls).toEqual(['app-menu'])
  })
})
