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

// Web 响应式覆盖层（移动端状态栏等；独立于 vendor 渲染树，见 web.css 头注）。
import './web.css'

import '../../../vendor/hermes-desktop/src/main'

installWebBridge()
