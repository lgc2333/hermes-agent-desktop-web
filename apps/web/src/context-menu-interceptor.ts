/**
 * Web-only contextmenu interception.
 *
 * The vendored renderer built its context-menu plumbing for Electron, where the
 * platform shows NO native menu — so the app menu is the only right-click
 * surface, and its global capture listener deliberately never calls
 * preventDefault (it would suppress the main-process `context-menu` event that
 * carries spellcheck/ image-coordinate facts). In a browser the default IS a
 * real native menu, so that same listener lets the browser menu run on top of
 * the app menu: it stacks over it, and for text (the composer is a
 * contenteditable host, message bodies are selectable) it opens the app's
 * custom menu over the browser's selection handles.
 *
 * This interceptor restores the web-only intent, registered ahead of the vendor
 * AppContextMenu capture listener (import order in main.tsx, before the renderer
 * mounts):
 *  - Surfaces with their own Radix context menu (pane tabs, status bar, file
 *    tree, session rows, …) are LEFT ALONE. Radix preventDefaults the native
 *    menu and opens its own, and it owns its touch long-press timer — any
 *    interference here breaks e.g. the pane tab close menu on touch.
 *  - Touch long-press: text selection and editables keep the browser's OWN
 *    selection handles + editing affordance (the app menu would sit over the
 *    handles and block selection). Blank chrome, links and images keep the app
 *    menu, so touch never loses it. The "selecting text" signal is the same
 *    `window.getSelection()` the vendor uses to decide it owns a selection
 *    (`target.selectionText`), so the two can never disagree.
 *  - Mouse right-click: text fields keep the browser's own editing menu; every
 *    other surface owns the right-click and we preventDefault so the native
 *    menu never stacks over the app menu.
 */
export function installContextMenuInterceptor(): () => void {
  const onContextMenu = (event: MouseEvent): void => {
    const element = event.target instanceof Element ? event.target : null

    // Surfaces with their own Radix context menu (pane tabs, status bar, file
    // tree, session rows, …) must keep the WHOLE gesture. Radix preventDefaults
    // the native menu itself and opens its own, and it has its own touch
    // long-press timer — so any preventDefault/stopImmediatePropagation here
    // fights it (a pane tab loses its close menu on touch). Leave them alone.
    if (
      element?.closest(
        '[data-hermes-context-menu-trigger], [data-slot="context-menu-trigger"]',
      )
    ) {
      return
    }

    if (isTouchContext(event)) {
      // Touch drives the platform's own text selection: handles + a floating
      // copy affordance. The app menu opening here would sit over the handles
      // and stop selection, so text (and editables) keep native behavior. Blank
      // chrome, links and images are unaffected and keep the app menu — the
      // `linkOrImage` guard also stops a stale text selection elsewhere on the
      // page from hijacking a link long-press.
      const linkOrImage = Boolean(
        element?.closest('a[href]') || element?.closest('img'),
      )
      const selectingText = (window.getSelection()?.toString() ?? '').trim().length > 0

      if (!linkOrImage && (isEditableElement(element) || selectingText)) {
        event.stopImmediatePropagation()

        return
      }

      event.preventDefault()

      return
    }

    // Mouse right-click: text fields keep the browser's own editing menu; every
    // other surface owns the right-click and we suppress the native menu so it
    // never stacks.
    if (isEditableElement(element)) {
      event.stopImmediatePropagation()

      return
    }

    event.preventDefault()
  }

  window.addEventListener('contextmenu', onContextMenu, true)

  return () => window.removeEventListener('contextmenu', onContextMenu, true)
}

/**
 * Mirrors the vendor's `editableFrom` (target.ts): form fields and
 * `contenteditable` hosts that actually accept editing.
 */
function isEditableElement(element: Element | null): boolean {
  if (!element) {
    return false
  }

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return !element.disabled && !element.readOnly
  }

  const host = element.closest('[contenteditable]')

  // `isContentEditable` is the authoritative computed value in a real browser;
  // jsdom does not implement it, so fall back to the attribute check.
  return (
    host instanceof HTMLElement &&
    (host.isContentEditable === true ||
      host.getAttribute('contenteditable') !== 'false')
  )
}

/**
 * Whether the context-menu gesture came from touch. Chromium reports the input
 * source per event (`sourceCapabilities.firesTouchEvents`), which is exact.
 * Where that's unavailable (Safari/Firefox) we fall back to the device's primary
 * pointer being coarse — true on phones/tablets, false on fine-pointer desktops,
 * so a touchscreen laptop's mouse right-click stays a mouse gesture.
 */
function isTouchContext(event: MouseEvent): boolean {
  const cap = (
    event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }
  ).sourceCapabilities

  if (cap !== undefined) {
    return cap.firesTouchEvents === true
  }

  // `matchMedia` can be absent (or throw) in stripped/worker environments;
  // treat an unavailable signal as a mouse gesture so the menu logic never breaks.
  try {
    return (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches
    )
  } catch {
    return false
  }
}
