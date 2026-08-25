/**
 * Class 3 — 拒绝类空实现（denied bridge）。
 *
 * 覆盖 global.d.ts 桥成员的桌面原生面（voice / 终端 / 窗口 / preview /
 * pet / hud / updates / 主题市场 / 安装 …），保证渲染层任何调用都不拿到
 * undefined（可选链安全），且返回形状合法：
 * 判定标准（ADR-0010）：仅当浏览器环境不可实现 **且** remote gateway 不
 * 支持（无对应 REST 端点）才归入本类；fs/git 面已按 REST 移入 gateway.ts，
 * saveImageFromUrl / 电池已按浏览器等价移入 browser.ts。
 *   - 查询面返回"空但合法"（[] / null / { ok:false } …），UI 呈现空态；
 *   - 会破坏状态的调用显式 reject（Error 消息 = 能力不可用），让调用方走
 *     既有错误路径，而不是拿假数据渲染。
 *
 * 拒绝面以本文件硬编码为准（gates.ts 已于 ADR-0009 删除：isDenied 无
 * 消费方，纯文档清单；语义权威 = PATCHES.md §4）。
 * 入口层的 `if (false)` 门在 vendor 导航/路由（PATCHES.md §4 登记）。
 */

import type {
  DesktopMarketplaceSearchItem,
  DesktopMarketplaceThemeResult,
  DesktopUninstallMode,
  DesktopUninstallResult,
  DesktopUninstallSummary,
  DesktopUpdateApplyResult,
  DesktopUpdateProgress,
  DesktopUpdateStatus,
  HermesActiveWork,
  HermesPreviewTarget,
  HermesPreviewWatch,
  HermesTitleBarTheme,
} from '@/global'
import type { WakeIndicatorState } from '@/lib/wake-indicator'
// 上游 2026-08-18 起 translucency 走 @hermes/shared/translucency（窗口玻璃
// 效果）；Web 无桌面窗口面（拒绝），仅同步参数类型以匹配 global.d.ts。
import type { TranslucencyState } from '@hermes/shared/translucency'
// global.d.ts 只 import 这些类型而不 re-export —— 直接从源模块取。
import type {
  PetOverlayBounds,
  PetOverlayControl,
  PetOverlayOpenRequest,
  PetOverlayStatePayload,
} from '@/store/pet-overlay'
import type {
  QuickEntryStatePush,
  QuickEntryStatus,
  QuickEntrySubmitPayload,
} from '@/store/quick-entry'

function UNAVAILABLE(what: string) {
  return new Error(`Hermes Web: ${what} is not available in the browser`)
}

const noopUnsub = () => () => undefined

export class DeniedAdapter {
  // ── 窗口 ─────────────────────────────────────────────────────────────────

  async openSessionWindow(
    _sessionId: string,
  ): Promise<{ error?: string; ok: boolean }> {
    return {
      ok: false,
      error: 'Hermes Web: multi-window is not available in the browser',
    }
  }

  async openSessionInTerminal(
    _sessionId: string,
    _opts?: { cwd?: string; profile?: string },
  ): Promise<{ error?: string; ok: boolean }> {
    return {
      ok: false,
      error: 'Hermes Web: the external terminal is not available in the browser',
    }
  }

  async openWindow(): Promise<{ error?: string; ok: boolean }> {
    return {
      ok: false,
      error: 'Hermes Web: multi-window is not available in the browser',
    }
  }

  async claimAmbientCue(_key: string): Promise<boolean> {
    return false
  }

  wakeIndicator = {
    async getState(): Promise<WakeIndicatorState> {
      return 'hidden'
    },
    setState(_state: WakeIndicatorState): void {
      // no-op
    },
    onState: noopUnsub,
  }

  petOverlay = {
    async open(
      _request: PetOverlayOpenRequest,
    ): Promise<{ bounds?: PetOverlayBounds; ok: boolean }> {
      return { ok: false }
    },
    async close(): Promise<{ ok: boolean }> {
      return { ok: false }
    },
    setBounds(_bounds: PetOverlayBounds): void {
      // no-op
    },
    setIgnoreMouse(_ignore: boolean): void {
      // no-op
    },
    setFocusable(_focusable: boolean): void {
      // no-op
    },
    pushState(_payload: PetOverlayStatePayload): void {
      // no-op
    },
    control(_payload: PetOverlayControl): void {
      // no-op
    },
    onState: noopUnsub,
    onControl: noopUnsub,
  }

  hud = {
    nativeDrag: false,
    windowing: {
      clientPlacement: false,
      controlDrag: false,
      nativeDrag: false,
      workspaceTransfer: false,
    },
    async open(): Promise<{ ok: boolean }> {
      return { ok: false }
    },
    async close(): Promise<{ ok: boolean }> {
      return { ok: false }
    },
    setIgnoreMouse(_ignore: boolean): void {
      // no-op
    },
    moveBy(_delta: { height: number; width: number; x: number; y: number }): void {
      // no-op
    },
    setWorkspaceTransfer(_transferring: boolean): void {
      // no-op
    },
    setBounds(_bounds: { height: number; width: number; x: number; y: number }): void {
      // no-op
    },
    async resetLayout(): Promise<{ ok: boolean }> {
      return { ok: false }
    },
    async setFrost(_on: boolean): Promise<{ ok: boolean }> {
      return { ok: false }
    },
    setSession(_sessionId: null | string): void {
      // no-op
    },
    onGoto: noopUnsub,
    onChanged: noopUnsub,
    onCursor: noopUnsub,
    onGameOverlay: noopUnsub,
  }

  quickEntry = {
    async getSettings(): Promise<QuickEntryStatus> {
      return { enabled: false, error: null, registered: false, shortcut: '' }
    },
    async setSettings(patch: {
      enabled?: boolean
      shortcut?: string
    }): Promise<QuickEntryStatus> {
      return {
        enabled: patch.enabled ?? false,
        error: null,
        registered: false,
        shortcut: patch.shortcut ?? '',
      }
    },
    submit(_payload: QuickEntrySubmitPayload): void {
      // no-op
    },
    dismiss(): void {
      // no-op
    },
    pushState(_payload: QuickEntryStatePush): void {
      // no-op
    },
    onState: noopUnsub,
    onSubmit: noopUnsub,
    onShown: noopUnsub,
  }

  // ── 语音 ─────────────────────────────────────────────────────────────────

  async requestMicrophoneAccess(): Promise<boolean> {
    return false
  }

  // ── 文件系统（仅剩余本地磁盘面；fs/git REST 面在 gateway.ts，虚拟 blob 面在 browser.ts）──

  async normalizePreviewTarget(_target: string): Promise<HermesPreviewTarget | null> {
    return null
  }

  async watchPreviewFile(_url: string): Promise<HermesPreviewWatch> {
    // A watch handle that never fires beats a crash: the preview rail is
    // gated, so this only keeps callers from throwing on absent watchers.
    return { id: 'denied', path: '' }
  }

  async stopPreviewFileWatch(_id: string): Promise<boolean> {
    return true
  }

  async revealLogs(): Promise<{ error?: string; ok: boolean; path: string }> {
    return { ok: false, path: '', error: 'Hermes Web: no local log file' }
  }

  settings = {
    async getDefaultProjectDir(): Promise<{
      defaultLabel: string
      dir: null | string
      resolvedCwd: string
    }> {
      return { defaultLabel: 'Web', dir: null, resolvedCwd: '' }
    },
    async pickDefaultProjectDir(): Promise<{ canceled: boolean; dir: null | string }> {
      return { canceled: true, dir: null }
    },
    async setDefaultProjectDir(_dir: null | string): Promise<{ dir: null | string }> {
      return { dir: null }
    },
  }

  async sanitizeWorkspaceCwd(
    cwd?: null | string,
  ): Promise<{ cwd: string; sanitized: boolean }> {
    return { cwd: cwd ?? '', sanitized: false }
  }

  async revealPath(_path: string): Promise<boolean> {
    return false
  }

  async openDir(_path: string): Promise<{ error?: string; ok: boolean }> {
    return { ok: false, error: 'Hermes Web: no OS file manager' }
  }

  // 空字符串（falsy）：runtime-loader 的 diskRoots() 看到空根就整体跳过，
  // 比 throw 干净（抛错会让 scan 走异常路径并弹 toast）。
  async desktopPluginsRoot(): Promise<string> {
    return ''
  }

  async agentPluginsRoot(): Promise<string> {
    return ''
  }

  async renamePath(_path: string, _newName: string): Promise<{ path: string }> {
    throw UNAVAILABLE('file renaming')
  }

  // ── 终端 ─────────────────────────────────────────────────────────────────

  terminal = {
    async cwd(_id: string): Promise<string | null> {
      return null
    },
    async dispose(_id: string): Promise<boolean> {
      return true
    },
    onData: noopUnsub,
    onExit: noopUnsub,
    async resize(_id: string, _size: { cols: number; rows: number }): Promise<boolean> {
      return false
    },
    async start(): Promise<never> {
      throw UNAVAILABLE('the terminal')
    },
    async write(_id: string, _data: string): Promise<boolean> {
      return false
    },
  }

  // ── 事件（桌面侧驱动的通道，浏览器永不触发）──────────────────────────────
  // 注意：类字段必须用 `=` 初始化（`:` 会被解析成类型注解 → 运行时 undefined）。

  onClosePreviewRequested = noopUnsub
  onOpenFolderRequested = noopUnsub
  onOpenUpdatesRequested = noopUnsub
  onDeepLink = noopUnsub
  onFocusSession = noopUnsub
  onNotificationAction = noopUnsub
  onFoundInPage = noopUnsub
  onOpenFindBarRequested = noopUnsub

  async signalDeepLinkReady(): Promise<{ ok: boolean }> {
    return { ok: true }
  }

  // ── 主题 / 外观 / 系统 ───────────────────────────────────────────────────

  async setActiveWork(_payload: HermesActiveWork): Promise<void> {
    // no-op
  }

  setTitleBarTheme(_payload: HermesTitleBarTheme): void {
    // no-op
  }

  setNativeTheme(_mode: 'dark' | 'light' | 'system'): void {
    // no-op
  }

  setTranslucency(_payload: TranslucencyState): void {
    // no-op（Web 无桌面窗口玻璃面，拒绝）
  }

  setKeepAwake(_on: boolean): void {
    // no-op
  }

  setPreviewShortcutActive(_active: boolean): void {
    // no-op
  }

  // ── 更新 / 卸载 / 主题市场 / 页内查找 ────────────────────────────────────

  updates = {
    async check(): Promise<DesktopUpdateStatus> {
      return {
        supported: false,
        error: 'Hermes Web: updates are managed by the deployment',
      }
    },
    async apply(): Promise<DesktopUpdateApplyResult> {
      return { ok: false, error: 'Hermes Web: updates are managed by the deployment' }
    },
    async getBranch(): Promise<{ branch: string }> {
      return { branch: 'web' }
    },
    async setBranch(_name: string): Promise<{ branch: string }> {
      return { branch: 'web' }
    },
    onProgress(_callback: (payload: DesktopUpdateProgress) => void): () => void {
      return () => undefined
    },
  }

  uninstall = {
    async summary(): Promise<DesktopUninstallSummary> {
      return {
        hermes_home: '',
        agent_installed: false,
        gui_installed: false,
        source_built_artifacts: [],
        packaged_app_paths: [],
        userdata_dir: '',
        userdata_exists: false,
        platform: 'web',
      }
    },
    async run(_mode: DesktopUninstallMode): Promise<DesktopUninstallResult> {
      return { ok: false, error: 'Hermes Web: nothing to uninstall' }
    },
  }

  themes = {
    async fetchMarketplace(_id: string): Promise<DesktopMarketplaceThemeResult> {
      throw UNAVAILABLE('the VS Code Marketplace')
    },
    async searchMarketplace(_query: string): Promise<DesktopMarketplaceSearchItem[]> {
      return []
    },
  }

  async findInPage(_query: string): Promise<{ count: number }> {
    return { count: 0 }
  }

  async stopFindInPage(): Promise<void> {
    // no-op
  }

  // ── bootstrap ────────────────────────────────────────────────────────────

  async continueBootstrapLocal(): Promise<{ ok: boolean }> {
    return { ok: false }
  }

  async resetBootstrap(): Promise<{ ok: boolean }> {
    return { ok: false }
  }

  async repairBootstrap(): Promise<{ ok: boolean }> {
    return { ok: false }
  }

  async cancelBootstrap(): Promise<{ cancelled: boolean; ok: boolean }> {
    return { ok: true, cancelled: true }
  }

  // ── preview 变更通知（门控面，gateway.ts 提供实现，永不触发）──────────────
}
