/**
 * Web-only contextmenu interception.
 *
 * The vendored renderer built its context-menu plumbing for Electron, where the
 * platform shows NO native menu — so the app menu is the only right-click
 * surface, and its global capture listener deliberately never calls
 * preventDefault (it would suppress the main-process `context-menu` event that
 * carries spellcheck/ image-coordinate facts). In a browser the default IS a
 * real native menu, so that same listener lets the browser menu run on top of
 * the app menu: it stacks over it, and for text fields (the composer is a
 * contenteditable host) it opens the app's custom edit menu, whose Radix
 * content is a focus trap that steals the field's focus and, on touch,
 * disturbs the native text-selection handles.
 *
 * This interceptor restores the web-only intent, registered ahead of the vendor
 * AppContextMenu capture listener (import order in main.tsx, before the renderer
 * mounts):
 *  - Text fields (input / textarea / contenteditable host) keep the browser's
 *    OWN editing menu + selection handles. The app menu is equivalent
 *    (cut/copy/paste/select-all) but disruptive, so we stopImmediatePropagation
 *    to keep it from ever opening there and never preventDefault, letting the
 *    native menu appear.
 *  - Everywhere else the app owns the right-click. preventDefault keeps the
 *    browser's native menu out so it never stacks over the app menu.
 */
export function installContextMenuInterceptor(): () => void {
  const onContextMenu = (event: MouseEvent): void => {
    const element = event.target instanceof Element ? event.target : null

    if (isEditableElement(element)) {
      event.stopImmediatePropagation()

      return
    }

    event.preventDefault()
  }

  window.addEventListener('contextmenu', onContextMenu, true)

  return () => window.removeEventListener('contextmenu', onContextMenu, true)
}

/** Mirrors the vendor's `editableFrom` (target.ts): form fields and
 *  `contenteditable` hosts that actually accept editing. */
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
