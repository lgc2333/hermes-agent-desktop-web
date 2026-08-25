import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    vi.restoreAllMocks()
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

  function makeContextMenuEvent(touch: boolean): MouseEvent {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })

    if (touch) {
      // Chromium reports the input source per event; `firesTouchEvents: true`
      // is what a real touch long-press carries.
      Object.defineProperty(event, 'sourceCapabilities', {
        value: { firesTouchEvents: true },
      })
    }

    return event
  }

  function dispatchOn(
    selector: string,
    html: string,
    opts?: { touch?: boolean },
  ): { defaultPrevented: boolean; calls: string[] } {
    const calls: string[] = []

    registerProbe(calls)
    const host = attach(html)

    const event = makeContextMenuEvent(opts?.touch === true)

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

  // ── Touch long-press ────────────────────────────────────────────────────

  it('touch long-press on text being selected keeps the native selection handles', () => {
    // The vendor decides it owns a selection via `window.getSelection`, so a
    // non-empty one is exactly when its copy menu would cover the handles.
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => 'selected words',
    } as unknown as Selection)
    const { defaultPrevented, calls } = dispatchOn('p', '<p>selected words</p>', {
      touch: true,
    })

    expect(defaultPrevented).toBe(false)
    expect(calls).toEqual([])
  })

  it('touch long-press on an editable keeps the native editing menu', () => {
    const { defaultPrevented, calls } = dispatchOn(
      'textarea',
      '<textarea></textarea>',
      {
        touch: true,
      },
    )

    expect(defaultPrevented).toBe(false)
    expect(calls).toEqual([])
  })

  it('touch long-press on a link keeps the app link menu', () => {
    const { defaultPrevented, calls } = dispatchOn(
      'a',
      '<a href="https://example.com">link</a>',
      { touch: true },
    )

    expect(defaultPrevented).toBe(true)
    expect(calls).toEqual(['app-menu'])
  })

  it('touch long-press on blank chrome keeps the app menu (shell verbs not lost)', () => {
    const { defaultPrevented, calls } = dispatchOn('p', '<p>plain chrome</p>', {
      touch: true,
    })

    expect(defaultPrevented).toBe(true)
    expect(calls).toEqual(['app-menu'])
  })

  it('a stale text selection elsewhere does not hijack a touch long-press on a link', () => {
    // The `linkOrImage` guard means a lingering selection on the page (which
    // would otherwise count as "selecting text") must not send a link long-press
    // off to the native menu.
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => 'lingering selection',
    } as unknown as Selection)
    const { defaultPrevented, calls } = dispatchOn(
      'a',
      '<a href="https://example.com">link</a>',
      { touch: true },
    )

    expect(defaultPrevented).toBe(true)
    expect(calls).toEqual(['app-menu'])
  })
})
