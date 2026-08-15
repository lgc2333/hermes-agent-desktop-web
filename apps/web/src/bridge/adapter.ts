/**
 * WebCapabilityAdapter — 组装三类桥实现并安装 window.hermesDesktop。
 *
 * 三类（PLAN §3 / handoff §3）：
 *   1. browser.ts   —— 浏览器原生等价（剪贴板 / openExternal / 通知 / …）
 *   2. gateway.ts   —— 走代理 RPC（连接注册表 / api() REST 转发 / boot 面 /
 *                      连接设置面）
 *   3. denied.ts    —— 布尔门空实现（voice / 终端 / 文件 / 窗口 / git /
 *                      preview / pet / hud / …）
 *
 * 安装顺序：必须在渲染层模块图求值前完成（main.tsx 的 ESM import 顺序保证），
 * 因为 boot 侧 store 在模块作用域就读 window.hermesDesktop。
 */

import type {
  BackendExit,
  HermesApiRequest,
  HermesWindowState,
  DesktopBootProgress,
} from '@/global'

import { BrowserAdapter } from './browser'
import { DeniedAdapter } from './denied'
import { GatewayAdapter, type WebBridgeOptions } from './gateway'

type Bridge = Window['hermesDesktop']

export function buildWebBridge(options: WebBridgeOptions = {}): Bridge {
  const gateway = new GatewayAdapter(options)
  const browser = new BrowserAdapter()
  const denied = new DeniedAdapter()

  const bridge: Bridge = {
    // ── 连接面（类 2）──────────────────────────────────────────────────────
    getConnection: () => gateway.getConnection(),
    revalidateConnection: () => gateway.revalidateConnection(),
    touchBackend: () => gateway.touchBackend(),
    getGatewayWsUrl: () => gateway.getGatewayWsUrl(),

    // ── REST（类 2）────────────────────────────────────────────────────────
    api: <T>(request: HermesApiRequest) => gateway.api<T>(request),

    // ── boot 面（类 2）─────────────────────────────────────────────────────
    getBootProgress: () => gateway.getBootProgress(),
    onBootProgress: (cb: (payload: DesktopBootProgress) => void) =>
      gateway.onBootProgress(cb),
    onBackendExit: (cb: (payload: BackendExit) => void) => gateway.onBackendExit(cb),
    onConnectionApplied: (cb) => gateway.onConnectionApplied(cb),
    onPowerResume: (cb) => gateway.onPowerResume(cb),
    onWindowStateChanged: (cb: (payload: HermesWindowState) => void) =>
      gateway.onWindowStateChanged(cb),
    // onPreviewFileChanged 由 GatewayAdapter 提供（类型面要求回调参数）。
    onPreviewFileChanged: (cb: (payload: never) => void) =>
      gateway.onPreviewFileChanged(cb),

    // ── 连接设置面（类 2）──────────────────────────────────────────────────
    getConnectionConfig: () => gateway.getConnectionConfig(),
    saveConnectionConfig: (payload) => gateway.saveConnectionConfig(payload),
    applyConnectionConfig: (payload) => gateway.applyConnectionConfig(payload),
    testConnectionConfig: (payload) => gateway.testConnectionConfig(payload),
    probeConnectionConfig: (url) => gateway.probeConnectionConfig(url),
    oauthLoginConnectionConfig: (url) => gateway.oauthLoginConnectionConfig(url),
    oauthLogoutConnectionConfig: () => gateway.oauthLogoutConnectionConfig(),
    connections: {
      list: () => gateway.connectionsList(),
      save: (payload) => gateway.connectionsSave(payload),
      remove: (id) => gateway.connectionsRemove(id),
      setPrimary: (id) => gateway.connectionsSetPrimary(id),
      test: (id) => gateway.connectionsTest(id),
    },
    sshConfigHosts: () => gateway.sshConfigHosts(),
    sshResolveHost: (host) => gateway.sshResolveHost(host),
    cloud: {
      status: () => gateway.cloudStatus(),
      login: async () => ({ ...(await gateway.cloudStatus()), ok: false }),
      logout: async () => ({ ...(await gateway.cloudStatus()), ok: false }),
      discover: async () => ({ agents: [] }),
      agentSignIn: async () => ({ baseUrl: '', connected: false }),
    },
    profile: {
      get: () => gateway.getProfile(),
      set: (name) => gateway.setProfile(name),
    },

    // ── 版本 / bootstrap（类 2）────────────────────────────────────────────
    getVersion: () => gateway.getVersion(),
    getRemoteDisplayReason: () => gateway.getRemoteDisplayReason(),
    getBootstrapState: () => gateway.getBootstrapState(),
    onBootstrapEvent: (cb) => gateway.onBootstrapEvent(cb),
    continueBootstrapLocal: () => denied.continueBootstrapLocal(),
    resetBootstrap: () => denied.resetBootstrap(),
    repairBootstrap: () => denied.repairBootstrap(),
    cancelBootstrap: () => denied.cancelBootstrap(),

    // ── 浏览器等价（类 1）──────────────────────────────────────────────────
    readClipboard: () => browser.readClipboard(),
    writeClipboard: (text) => browser.writeClipboard(text),
    openExternal: (url) => browser.openExternal(url),
    openPreviewInBrowser: (url) => browser.openPreviewInBrowser(url),
    fetchLinkTitle: (url) => browser.fetchLinkTitle(url),
    notify: (payload) => browser.notify(payload),
    selectPaths: () => browser.selectPaths(),
    selectSavePath: () => browser.selectSavePath(),
    getPathForFile: () => browser.getPathForFile(),
    zoom: {
      get: () => browser.getZoom(),
      setPercent: (percent) => browser.setZoomPercent(percent),
      onChanged: (cb) => browser.onZoomChanged(cb),
    },
    reportRendererError: (report) => browser.reportRendererError(report),
    revealLogs: () => denied.revealLogs(),
    getRecentLogs: async () => browser.getRecentLogs(),

    // ── 布尔门空实现（类 3）────────────────────────────────────────────────
    openSessionWindow: (sessionId) => denied.openSessionWindow(sessionId),
    openSessionInTerminal: (sessionId, opts) =>
      denied.openSessionInTerminal(sessionId, opts),
    openWindow: () => denied.openWindow(),
    claimAmbientCue: (key) => denied.claimAmbientCue(key),
    wakeIndicator: denied.wakeIndicator,
    petOverlay: denied.petOverlay,
    hud: denied.hud,
    quickEntry: denied.quickEntry,
    requestMicrophoneAccess: () => denied.requestMicrophoneAccess(),
    readFileDataUrl: (path) => denied.readFileDataUrl(path),
    readFileText: (path) => denied.readFileText(path),
    saveImageFromUrl: (url) => denied.saveImageFromUrl(url),
    saveImageBuffer: (data, ext) => denied.saveImageBuffer(data, ext),
    saveClipboardImage: () => denied.saveClipboardImage(),
    normalizePreviewTarget: (target) => denied.normalizePreviewTarget(target),
    watchPreviewFile: (url) => denied.watchPreviewFile(url),
    stopPreviewFileWatch: (id) => denied.stopPreviewFileWatch(id),
    readDir: (path) => denied.readDir(path),
    gitRoot: (path) => denied.gitRoot(path),
    revealPath: (path) => denied.revealPath(path),
    openDir: (path) => denied.openDir(path),
    desktopPluginsRoot: () => denied.desktopPluginsRoot(),
    agentPluginsRoot: () => denied.agentPluginsRoot(),
    renamePath: (path, newName) => denied.renamePath(path, newName),
    writeTextFile: (path, content) => denied.writeTextFile(path, content),
    trashPath: (path) => denied.trashPath(path),
    git: denied.git,
    terminal: denied.terminal,
    sanitizeWorkspaceCwd: (cwd) => denied.sanitizeWorkspaceCwd(cwd),
    settings: denied.settings,
    updates: denied.updates,
    uninstall: denied.uninstall,
    themes: denied.themes,
    findInPage: (query) => denied.findInPage(query),
    stopFindInPage: () => denied.stopFindInPage(),
    // denied 的 on* 订阅成员是 0 参 noopUnsub；直接透传（少参数函数可赋值给
    // 带参签名），避免包一层再把回调吞掉。
    onFoundInPage: denied.onFoundInPage,
    onClosePreviewRequested: denied.onClosePreviewRequested,
    onOpenFolderRequested: denied.onOpenFolderRequested,
    onOpenUpdatesRequested: denied.onOpenUpdatesRequested,
    onDeepLink: denied.onDeepLink,
    signalDeepLinkReady: () => denied.signalDeepLinkReady(),
    onFocusSession: denied.onFocusSession,
    onNotificationAction: denied.onNotificationAction,
    getOnBattery: () => denied.getOnBattery(),
    onBatteryChanged: denied.onBatteryChanged,
    setActiveWork: (payload) => denied.setActiveWork(payload),
    setTitleBarTheme: (payload) => denied.setTitleBarTheme(payload),
    setNativeTheme: (mode) => denied.setNativeTheme(mode),
    setTranslucency: (payload) => denied.setTranslucency(payload),
    setKeepAwake: (on) => denied.setKeepAwake(on),
    setPreviewShortcutActive: (active) => denied.setPreviewShortcutActive(active),
    readWindowBelow: async () => null,
  }

  return bridge
}

/** 安装桥到 window.hermesDesktop（必须在渲染树挂载前执行）。返回桥实例。 */
export function installWebBridge(options: WebBridgeOptions = {}): Bridge {
  const bridge = buildWebBridge(options)
  window.hermesDesktop = bridge

  return bridge
}
