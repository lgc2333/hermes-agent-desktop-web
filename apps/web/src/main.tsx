/**
 * Hermes Web entry (M0).
 *
 * The web app is the vendored desktop renderer, running in a browser:
 *   - install a bridge on window.hermesDesktop (dev mock for now; M1 swaps in
 *     the WebCapabilityAdapter), then
 *   - mount the vendored render tree (vendor/hermes-desktop/src/main.tsx).
 *
 * Order matters: the bridge must exist before the renderer's module graph
 * evaluates, because boot-side stores read window.hermesDesktop at module
 * scope. ES module evaluation follows import order, so the side-effect
 * import below runs first.
 */
import './bridge/mock-bridge'

import '../../../vendor/hermes-desktop/src/main'
