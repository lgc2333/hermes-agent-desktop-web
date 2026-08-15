/**
 * Hermes Web entry (M1).
 *
 * The web app is the vendored desktop renderer, running in a browser:
 *   - install the WebCapabilityAdapter on window.hermesDesktop
 *     (apps/web/src/bridge — three implementation classes), then
 *   - mount the vendored render tree (vendor/hermes-desktop/src/main.tsx).
 *
 * Order matters: the bridge must exist before the renderer's module graph
 * evaluates, because boot-side stores read window.hermesDesktop at module
 * scope. ES module evaluation follows import order, so the side-effect
 * import below runs first.
 */
import { installWebBridge } from './bridge/adapter'

installWebBridge()

import '../../../vendor/hermes-desktop/src/main'
