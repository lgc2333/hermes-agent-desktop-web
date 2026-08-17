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
import type { AttachmentBlobStore } from './blob-store'
import { DeniedAdapter } from './denied'
import { GatewayAdapter, type WebBridgeOptions } from './gateway'

type Bridge = Window['hermesDesktop']

export function buildWebBridge(
  options: WebBridgeOptions = {},
  blobStore?: AttachmentBlobStore,
): Bridge {
  const gateway = new GatewayAdapter(options)
  // ADR-0020：附件字节存储默认 OPFS；测试注入 MemoryBlobStore（jsdom 无 OPFS）。
  const browser = new BrowserAdapter(blobStore)
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
    oauthPasteConnectionConfig: (url, pasted) =>
      gateway.oauthPasteConnectionConfig(url, pasted),
    oauthLogoutConnectionConfig: () => gateway.oauthLogoutConnectionConfig(),
    passwordLoginConnectionConfig: (url, provider, username, password) =>
      gateway.passwordLoginConnectionConfig(url, provider, username, password),
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

    // ── fs / git REST 面（类 2，ADR-0010：remote 模式有后端端点）────────────
    readDir: (path) => gateway.readDir(path),
    readFileText: (path) => gateway.readFileText(path),
    writeTextFile: (path, content) => gateway.writeTextFile(path, content),
    // 虚拟 blob 路径（web-blob://，ADR-0020）优先浏览器存储（File 引用 /
    // OPFS）；其余走 gateway REST。
    readFileDataUrl: async (path) =>
      (await browser.readFileDataUrl(path)) || gateway.readFileDataUrl(path),
    saveImageFile: (blob, name) => browser.saveImageFile(blob, name),
    releaseBlobFile: (path) => browser.releaseBlobFile(path),
    gitRoot: (path) => gateway.gitRoot(path),
    git: gateway.git,

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
    // ADR-0022：语音放行——requestMicrophoneAccess 从 denied 切到浏览器等价
    // （getUserMedia 原生处理权限）；denied.ts 保留布尔门实现便于隔离测试。
    requestMicrophoneAccess: () => browser.requestMicrophoneAccess(),
    // ADR-0022：媒体播放入口——Web 桥返回同源代理流 URL（/api/proxy/media-stream）。
    streamMediaUrl: (path) => gateway.streamMediaUrl(path),
    saveImageFromUrl: (url) => browser.saveImageFromUrl(url),
    saveImageBuffer: (data, ext) => browser.saveImageBuffer(data, ext),
    saveClipboardImage: () => browser.saveClipboardImage(),
    // ADR-0020 附件字节存储：File 引用 / OPFS 落盘（见 browser.ts）。
    normalizePreviewTarget: (target) => denied.normalizePreviewTarget(target),
    watchPreviewFile: (url) => denied.watchPreviewFile(url),
    stopPreviewFileWatch: (id) => denied.stopPreviewFileWatch(id),
    revealPath: (path) => denied.revealPath(path),
    openDir: (path) => denied.openDir(path),
    desktopPluginsRoot: () => denied.desktopPluginsRoot(),
    agentPluginsRoot: () => denied.agentPluginsRoot(),
    renamePath: (path, newName) => denied.renamePath(path, newName),
    // trashPath 摘除（global.d.ts 可选）：浏览器无回收站语义，渲染层
    // desktop-fs.trashDesktopPath 已有 !desktop.trashPath 兜底抛错。
    terminal: denied.terminal,
    sanitizeWorkspaceCwd: (cwd) => denied.sanitizeWorkspaceCwd(cwd),
    settings: denied.settings,
    updates: denied.updates,
    uninstall: denied.uninstall,
    // ADR-0021：主题供应商从 denied 空实现切到浏览器直连（官方接口 CORS
    // 放行 *，无代理、无凭证）。denied.ts 仍保留布尔门实现便于隔离测试。
    themes: browser.themes,
    findInPage: (query) => denied.findInPage(query),
    stopFindInPage: () => denied.stopFindInPage(),
    // denied 的 on* 订阅成员是 0 参 noopUnsub；直接透传（少参数函数可赋值给
    // 带参签名），避免包一层再把回调吞掉。
    onFoundInPage: denied.onFoundInPage,
    onOpenFindBarRequested: denied.onOpenFindBarRequested,
    onClosePreviewRequested: denied.onClosePreviewRequested,
    onOpenFolderRequested: denied.onOpenFolderRequested,
    onOpenUpdatesRequested: denied.onOpenUpdatesRequested,
    onDeepLink: denied.onDeepLink,
    signalDeepLinkReady: () => denied.signalDeepLinkReady(),
    onFocusSession: denied.onFocusSession,
    onNotificationAction: denied.onNotificationAction,
    getOnBattery: () => browser.getOnBattery(),
    onBatteryChanged: browser.onBatteryChanged,
    setActiveWork: (payload) => denied.setActiveWork(payload),
    setTitleBarTheme: (payload) => denied.setTitleBarTheme(payload),
    setNativeTheme: (mode) => denied.setNativeTheme(mode),
    setTranslucency: (payload) => denied.setTranslucency(payload),
    setKeepAwake: (on) => denied.setKeepAwake(on),
    setPreviewShortcutActive: (active) => denied.setPreviewShortcutActive(active),
    // main 新增桥面：桌面插件 profile 路由表（跨联合注册表免凭证路由）。Web 无
    // 桌面主进程/插件层，恒返回空表（类 3 空实现）。
    getProfileRoutes: async () => [],
    readWindowBelow: async () => null,
  }

  return bridge
}

/** 安装桥到 window.hermesDesktop（必须在渲染树挂载前执行）。返回桥实例。 */
export function installWebBridge(
  options: WebBridgeOptions = {},
  blobStore?: AttachmentBlobStore,
): Bridge {
  const bridge = buildWebBridge(options, blobStore)
  window.hermesDesktop = bridge

  return bridge
}
