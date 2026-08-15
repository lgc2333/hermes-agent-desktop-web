/**
 * Class 2 — 走代理 RPC 的桥面（M1 直连 mock gateway，M2 换同源代理协议）。
 *
 * 职责（PLAN §3 / handoff §3）：
 *   - 连接面：getConnection/getGatewayWsUrl/revalidateConnection/touchBackend，
 *     数据源 = 连接注册表（registry.ts，localStorage，ADR-0002）；
 *   - REST 面：api() 转发（M1 直连 baseUrl + X-Hermes-Session-Token；
 *     M2 改为同源代理 + X-Hermes-Target，错误形状不变）；
 *   - boot 面：getBootProgress/onBootProgress/onBackendExit 等 —— 浏览器无
 *     后端进程，语义简化为连接探测；
 *   - 连接设置面：getConnectionConfig/save/apply/test/probe + profile +
 *     connections 注册表 + cloud/ssh 空面。
 */

import type {
  BackendExit,
  DesktopActiveProfile,
  DesktopAuthProvider,
  DesktopBootProgress,
  DesktopBootstrapEvent,
  DesktopBootstrapState,
  DesktopCloudStatus,
  DesktopConnectionConfig,
  DesktopConnectionConfigInput,
  DesktopConnectionProbeResult,
  DesktopConnectionTestResult,
  DesktopConnectionsRegistry,
  DesktopOauthLoginResult,
  DesktopOauthLogoutResult,
  DesktopRegistryConnection,
  DesktopRegistryConnectionInput,
  DesktopSshHostsResult,
  DesktopSshResolveResult,
  DesktopVersionInfo,
  HermesApiRequest,
  HermesConnection,
  HermesWindowState
} from '@/global'
import type { GatewayWsUrlResult } from '@hermes/shared'

import {
  DEFAULT_CONNECTION_ID,
  defaultMockConnection,
  getPrimaryConnection,
  loadRegistry,
  readProfilePreference,
  removeConnection,
  saveRegistry,
  setPrimaryConnection,
  upsertConnection,
  writeProfilePreference,
  type WebConnectionRecord
} from './registry'

export const WEB_VERSION = '0.1.0-web-m3'

/** OAuth 授权窗口名（同名复用，避免多开）。 */
const OAUTH_WINDOW_NAME = 'hermes-oauth-login'
/** 授权轮询：500ms 间隔，最长 5 分钟（与 gateway pending TTL 对齐）。 */
const OAUTH_POLL_INTERVAL_MS = 500
const OAUTH_POLL_TIMEOUT_MS = 5 * 60_000

/**
 * M2 代理基址（唯一落点，handoff M2 §4）：
 *   - VITE_PROXY_URL 设置（dev：vite :5173 页面 → 代理 :8787）→ 用它；
 *   - 生产：SPA 由代理同源托管 → window.location.origin；
 *   - 都没配置 → null，回退 M1 直连（conn.url，mock CORS 开放可直连）。
 */
export function proxyBaseUrl(): string | null {
  const env = import.meta.env.VITE_PROXY_URL as string | undefined

  if (env && env.trim()) {
    return env.replace(/\/+$/, '')
  }

  return null
}

/**
 * M3：经代理的 fetch —— credentials: 'include'，让 httpOnly OAuth 会话
 * cookie（hermes_oauth_session）随请求携带（dev 跨端口同站 / 生产同源）。
 */
function proxyFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, credentials: 'include' })
}

/** 网关 base URL：M2 = 代理（目标 gateway 经 X-Hermes-Target 头指定）。 */
export function gatewayBaseUrl(conn?: WebConnectionRecord): string {
  const record = conn ?? getPrimaryConnection()

  return proxyBaseUrl() ?? record.url.replace(/\/+$/, '')
}

/**
 * WS 拨号 URL：
 *   - 经代理：浏览器 WebSocket 无法携带自定义头，目标编码进 query
 *     （ws://proxy/api/ws?token=..&target=<encoded gateway url>）；
 *   - 直连回退：真 gateway 形态 ws(s)://gw/api/ws?token=..（M1 是
 *     mock 特有的 /gateway 路径，M2 mock 已对齐 /api/ws）。
 */
function wsUrlFor(conn: WebConnectionRecord): string {
  const proxy = proxyBaseUrl()

  if (proxy) {
    const wsBase = proxy.replace(/^http/, 'ws')

    // M3：OAuth 模式凭证在代理（httpOnly cookie + ws-ticket），WS 握手经
    // cookie 认证、代理 mint 单次 ticket，不带 ?token=（gated gateway 拒绝
    // token query）。
    if (conn.authMode === 'oauth') {
      return `${wsBase}/api/ws?target=${encodeURIComponent(conn.url.replace(/\/+$/, ''))}`
    }

    return `${wsBase}/api/ws?token=${encodeURIComponent(conn.token)}&target=${encodeURIComponent(conn.url.replace(/\/+$/, ''))}`
  }

  const base = conn.url.replace(/\/+$/, '').replace(/^http/, 'ws')

  return `${base}/api/ws?token=${encodeURIComponent(conn.token)}`
}

/** HermesConnection 渲染层实读字段（handoff §2 已核实）。 */
export function toHermesConnection(conn: WebConnectionRecord): HermesConnection {
  return {
    baseUrl: gatewayBaseUrl(conn),
    isFullscreen: false,
    mode: 'remote',
    authMode: conn.authMode,
    nativeOverlayWidth: 0,
    remoteHost: new URL(conn.url).hostname,
    // HermesConnection.remoteKind 只接受 'cloud' | 'ssh' | 'url' ——
    // local/remote 连接都落 'url'（手填 URL 连接）。
    remoteKind: conn.kind === 'cloud' || conn.kind === 'ssh' ? conn.kind : 'url',
    source: 'settings',
    token: conn.token,
    wsUrl: wsUrlFor(conn),
    logs: [],
    windowButtonPosition: null
  }
}

/** 错误形状与桌面 Electron 桥一致，渲染层的 isEndpointMissingError 等靠它识别。 */
function apiError(status: number, path: string, body: string): Error {
  const detail = (() => {
    try {
      return JSON.stringify(JSON.parse(body))
    } catch {
      return body || 'Unknown error'
    }
  })()

  if (status === 404) {
    return new Error(`404: {"detail":"No such API endpoint: ${path}"}`)
  }

  return new Error(`HTTP ${status}: ${detail}`)
}

/**
 * REST 转发。桌面端 `hermes:api` IPC 的浏览器等价物：
 *   - token 模式：X-Hermes-Session-Token 头；
 *   - 非 2xx：抛与桌面一致的错误（404 特判为 endpoint-missing）；
 *   - upload：单文件 multipart（FastAPI UploadFile 端点）。
 */
export async function webApi<T>(request: HermesApiRequest): Promise<T> {
  const conn = getPrimaryConnection()
  const base = gatewayBaseUrl(conn)
  const path = request.path.startsWith('/') ? request.path : `/${request.path}`
  const method = (request.method ?? 'GET').toUpperCase()

  let init: RequestInit

  if (request.upload) {
    const form = new FormData()
    form.append(
      'file',
      new Blob([request.upload.bytes], { type: request.upload.contentType ?? 'application/octet-stream' }),
      request.upload.filename
    )
    init = { method, body: form }
  } else {
    init = {
      method,
      ...(request.body !== undefined && method !== 'GET' && method !== 'HEAD'
        ? { body: JSON.stringify(request.body) }
        : {})
    }
  }

  // M3：OAuth 模式浏览器不持静态 token（代理按会话注入 Bearer），
  // 只带目标；token 模式照旧带 X-Hermes-Session-Token。
  const oauth = conn.authMode === 'oauth'
  init.headers = {
    ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    ...(oauth ? {} : { 'X-Hermes-Session-Token': conn.token }),
    // M2：目标 gateway 由每次请求携带（代理无状态，见 PLAN §6）。
    'X-Hermes-Target': conn.url.replace(/\/+$/, '')
  }

  const controller = new AbortController()
  const timer = request.timeoutMs
    ? window.setTimeout(() => controller.abort(), request.timeoutMs)
    : undefined

  try {
    const res = await proxyFetch(`${base}${path}`, { ...init, signal: controller.signal })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw apiError(res.status, path, body)
    }

    if (res.status === 204) {
      return undefined as T
    }

    const text = await res.text()

    if (!text) {
      return undefined as T
    }

    try {
      return JSON.parse(text) as T
    } catch {
      return text as T
    }
  } finally {
    if (timer !== undefined) {
      window.clearTimeout(timer)
    }
  }
}

export interface WebBridgeOptions {
  /** M1 默认目标 = 注册表主连接（mock gateway）；M2 注入同源代理地址。 */
  api?: typeof webApi
}

export class GatewayAdapter {
  private readonly apiImpl: typeof webApi

  constructor(options: WebBridgeOptions = {}) {
    this.apiImpl = options.api ?? webApi
  }

  // ── 连接面 ───────────────────────────────────────────────────────────────

  async getConnection(): Promise<HermesConnection> {
    return toHermesConnection(getPrimaryConnection())
  }

  async getGatewayWsUrl(): Promise<GatewayWsUrlResult> {
    return { ok: true, wsUrl: wsUrlFor(getPrimaryConnection()) }
  }

  async revalidateConnection(): Promise<{ ok: boolean; rebuilt: boolean }> {
    // 浏览器无缓存的后端描述符可失效——注册表就是真相，永远是 fresh。
    return { ok: true, rebuilt: false }
  }

  async touchBackend(): Promise<{ ok: boolean }> {
    return { ok: true }
  }

  // ── REST ─────────────────────────────────────────────────────────────────

  api<T>(request: HermesApiRequest): Promise<T> {
    return this.apiImpl<T>(request)
  }

  // ── boot 面（无后端进程，语义 = 连接探测，渲染层自己推进 renderer.* 步骤）──

  async getBootProgress(): Promise<DesktopBootProgress> {
    return {
      error: null,
      fakeMode: false,
      message: '',
      phase: 'idle',
      progress: 0,
      running: false,
      timestamp: Date.now()
    }
  }

  onBootProgress(_callback: (payload: DesktopBootProgress) => void): () => void {
    return () => undefined
  }

  onBackendExit(_callback: (payload: BackendExit) => void): () => void {
    // 浏览器没有后端子进程——永不触发。
    return () => undefined
  }

  onConnectionApplied(_callback: () => void): () => void {
    return () => undefined
  }

  onPowerResume(_callback: () => void): () => void {
    return () => undefined
  }

  onWindowStateChanged(_callback: (payload: HermesWindowState) => void): () => void {
    return () => undefined
  }

  onPreviewFileChanged(_callback: (payload: never) => void): () => void {
    return () => undefined
  }

  // ── 连接设置面 ───────────────────────────────────────────────────────────

  private toConfig(conn: WebConnectionRecord): DesktopConnectionConfig {
    return {
      envOverride: false,
      mode: conn.kind === 'local' ? 'local' : conn.kind === 'remote' ? 'remote' : conn.kind,
      profile: null,
      remoteAuthMode: conn.authMode,
      remoteOauthConnected: conn.authMode === 'oauth' && Boolean(conn.token),
      remoteTokenPreview: conn.token ? `${conn.token.slice(0, 4)}…` : null,
      remoteTokenSet: Boolean(conn.token),
      secureTokenStorage: true,
      remoteTokenPlainText: false,
      remoteUrl: conn.url,
      cloudOrg: '',
      sshHost: '',
      sshUser: '',
      sshPort: null,
      sshKeyPath: '',
      sshRemoteHermesPath: '',
      sshRemoteProfile: ''
    }
  }

  /**
   * M3：连接配置 = registry 快照 + 运行时增强：
   *   - OAuth 连接：向代理查询 httpOnly 会话状态（connected + tokenPreview）；
   *   - 默认连接从未配置过且代理下发 defaultGatewayUrl（/api/proxy/meta，
   *     compose env HERMES_DEFAULT_GATEWAY_URL）→ 表单预填默认 URL（用户
   *     保存才落盘，不动 registry）。
   */
  async getConnectionConfig(): Promise<DesktopConnectionConfig> {
    const conn = getPrimaryConnection()
    const config = this.toConfig(conn)

    if (conn.authMode === 'oauth') {
      const session = await this.oauthSessionStatus(conn.url)
      config.remoteOauthConnected = session.connected
      if (session.connected && session.tokenPreview) {
        config.remoteTokenPreview = session.tokenPreview
      }
    }

    // 默认连接预填（只在仍是出厂 mock 地址时生效）。
    if (conn.id === DEFAULT_CONNECTION_ID && conn.url === defaultMockConnection().url) {
      const meta = await this.fetchProxyMeta().catch(() => null)
      if (meta?.defaultGatewayUrl) {
        config.remoteUrl = meta.defaultGatewayUrl
      }
    }

    return config
  }

  async saveConnectionConfig(payload: DesktopConnectionConfigInput): Promise<DesktopConnectionConfig> {
    const current = getPrimaryConnection()
    const next = this.applyConfigToRecord(current, payload)
    upsertConnection(next)

    return this.toConfig(next)
  }

  async applyConnectionConfig(payload: DesktopConnectionConfigInput): Promise<DesktopConnectionConfig> {
    // M1：保存即应用（浏览器无进程需要重启；M2 换代理后此处触发重连）。
    return this.saveConnectionConfig(payload)
  }

  async testConnectionConfig(payload: DesktopConnectionConfigInput): Promise<DesktopConnectionTestResult> {
    return this.probe(payload.remoteUrl ?? getPrimaryConnection().url)
  }

  async probeConnectionConfig(remoteUrl: string): Promise<DesktopConnectionProbeResult> {
    try {
      // M2：探测也走代理（dev 跨源 / 生产同源都通），转发正确性一并验证。
      const proxy = proxyBaseUrl()
      const base = proxy ?? remoteUrl.replace(/\/+$/, '')
      const status = await fetch(`${base}/api/status`, {
        headers: {
          'X-Hermes-Session-Token': getPrimaryConnection().token,
          ...(proxy ? { 'X-Hermes-Target': remoteUrl.replace(/\/+$/, '') } : {})
        }
      })

      if (!status.ok) {
        return {
          baseUrl: remoteUrl,
          reachable: false,
          authMode: 'unknown',
          providers: [],
          version: null,
          error: `HTTP ${status.status}`
        }
      }

      const json = (await status.json().catch(() => null)) as {
        version?: string
        auth_mode?: string
        auth_required?: boolean
        auth_flows?: string[]
        auth_providers?: string[]
      } | null

      // M3：真 gateway 无 auth_mode 字段，按 auth_required + auth_flows 判定
      // （gated + native_pkce → oauth；loopback → token）；旧 mock 的
      // auth_mode 字段保留兼容。
      const authMode =
        json?.auth_required === true
          ? (json.auth_flows ?? []).includes('native_pkce')
            ? 'oauth'
            : 'token'
          : json?.auth_required === false
            ? 'token'
            : json?.auth_mode === 'oauth'
              ? 'oauth'
              : json?.auth_mode === 'token'
                ? 'token'
                : 'unknown'
      const providers: DesktopAuthProvider[] = (json?.auth_providers ?? []).map(name => ({
        name,
        displayName: name
      }))

      return {
        baseUrl: remoteUrl,
        reachable: true,
        authMode,
        providers,
        version: json?.version ?? null,
        error: null
      }
    } catch (error) {
      return {
        baseUrl: remoteUrl,
        reachable: false,
        authMode: 'unknown',
        providers: [],
        version: null,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * M3：native OAuth 登录（经代理中转，PKCE 全程在代理侧）。
   *
   * 流程：POST /auth/native/start（代理生成 PKCE/state + authorize URL）→
   * 新窗口打开 gateway 授权页 → gateway 完成授权后 302 回代理 callback →
   * 代理换 token set 并存 httpOnly cookie → 本窗口轮询 /auth/native/session
   * 直到 connected（或窗口关闭 / 超时）。
   */
  async oauthLoginConnectionConfig(remoteUrl: string): Promise<DesktopOauthLoginResult> {
    const proxy = proxyBaseUrl()
    const baseUrl = remoteUrl.replace(/\/+$/, '')

    if (!proxy) {
      // 直连模式无代理中转（token 在浏览器侧才能转发）——OAuth 不可用。
      return { ok: false, baseUrl, connected: false }
    }

    // 同步段先开窗（保留用户手势，避免弹窗拦截），拿到 authorize URL 后再导航。
    const win = window.open('', OAUTH_WINDOW_NAME, 'popup,width=560,height=680')

    if (!win) {
      return { ok: false, baseUrl, connected: false }
    }

    try {
      const start = await proxyFetch(`${proxy}/auth/native/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: baseUrl })
      })

      if (!start.ok) {
        win.close()

        return { ok: false, baseUrl, connected: false }
      }

      const { authorizeUrl } = (await start.json()) as { authorizeUrl?: string }

      if (!authorizeUrl) {
        win.close()

        return { ok: false, baseUrl, connected: false }
      }

      // 授权窗口导航（gateway → IDP → 代理 callback → 自动关闭）。
      win.location.href = authorizeUrl

      const connected = await this.pollOauthSession(baseUrl, win)

      return { ok: true, baseUrl, connected }
    } catch {
      try {
        win.close()
      } catch {
        // already closed
      }

      return { ok: false, baseUrl, connected: false }
    }
  }

  async oauthLogoutConnectionConfig(remoteUrl?: string): Promise<DesktopOauthLogoutResult> {
    const proxy = proxyBaseUrl()

    if (!proxy) {
      return { ok: false, connected: false }
    }

    try {
      const res = await proxyFetch(`${proxy}/auth/native/logout`, { method: 'POST' })

      return { ok: res.ok, connected: false }
    } catch {
      return { ok: false, connected: false }
    }
  }

  /** 轮询代理会话状态：窗口关闭即停（最后一查）；最多 OAUTH_POLL_TIMEOUT_MS。 */
  private async pollOauthSession(remoteUrl: string, win: Window | null): Promise<boolean> {
    const deadline = Date.now() + OAUTH_POLL_TIMEOUT_MS

    while (Date.now() < deadline) {
      await new Promise(resolve => window.setTimeout(resolve, OAUTH_POLL_INTERVAL_MS))

      if (win && win.closed) {
        // 窗口已关闭：最后一查确认结果（登录成功时 callback 页自动关闭）。
        return this.oauthSessionStatus(remoteUrl).then(s => s.connected)
      }

      const session = await this.oauthSessionStatus(remoteUrl)
      if (session.connected) {
        return true
      }
    }

    return false
  }

  /** 查询代理 OAuth 会话状态（cookie + target 匹配才 connected）。 */
  private async oauthSessionStatus(remoteUrl: string): Promise<{
    connected: boolean
    provider: string
    userId: string
    expiresAt: number
    tokenPreview: string | null
  }> {
    const proxy = proxyBaseUrl()

    if (!proxy) {
      return { connected: false, provider: '', userId: '', expiresAt: 0, tokenPreview: null }
    }

    try {
      const res = await proxyFetch(
        `${proxy}/auth/native/session?target=${encodeURIComponent(remoteUrl.replace(/\/+$/, ''))}`
      )

      if (!res.ok) {
        return { connected: false, provider: '', userId: '', expiresAt: 0, tokenPreview: null }
      }

      const json = (await res.json()) as {
        connected?: boolean
        provider?: string
        userId?: string
        expiresAt?: number
        tokenPreview?: string | null
      }

      return {
        connected: Boolean(json.connected),
        provider: json.provider ?? '',
        userId: json.userId ?? '',
        expiresAt: json.expiresAt ?? 0,
        tokenPreview: json.tokenPreview ?? null
      }
    } catch {
      return { connected: false, provider: '', userId: '', expiresAt: 0, tokenPreview: null }
    }
  }

  /** 读代理 /api/proxy/meta（默认 gateway URL 预填）。 */
  private async fetchProxyMeta(): Promise<{ defaultGatewayUrl: string | null; requiresPassphrase: boolean } | null> {
    const proxy = proxyBaseUrl()

    if (!proxy) {
      return null
    }

    try {
      const res = await fetch(`${proxy}/api/proxy/meta`)
      if (!res.ok) {
        return null
      }

      return (await res.json()) as { defaultGatewayUrl: string | null; requiresPassphrase: boolean }
    } catch {
      return null
    }
  }

  // ── profile ──────────────────────────────────────────────────────────────

  async getProfile(): Promise<DesktopActiveProfile> {
    return { profile: readProfilePreference() }
  }

  async setProfile(name: string | null): Promise<DesktopActiveProfile> {
    writeProfilePreference(name)

    return { profile: name }
  }

  // ── v2 连接注册表（M2 起做 UI；这里提供最小可用存储面）────────────────────

  async connectionsList(): Promise<DesktopConnectionsRegistry> {
    return this.toRegistry(loadRegistry())
  }

  async connectionsSave(
    payload: DesktopRegistryConnectionInput
  ): Promise<{ ok: boolean; connection: DesktopRegistryConnection; registry: DesktopConnectionsRegistry }> {
    const id = payload.id ?? `conn-${Date.now().toString(36)}`
    const record: WebConnectionRecord = {
      id,
      kind: payload.kind,
      label: payload.label,
      url: payload.url ?? '',
      authMode: payload.authMode ?? 'token',
      token: payload.authMode === 'oauth' ? '' : (payload.token ?? getPrimaryConnection().token)
    }
    upsertConnection(record)

    return {
      ok: true,
      connection: {
        id,
        kind: record.kind,
        label: record.label,
        url: record.url,
        authMode: record.authMode,
        tokenSet: Boolean(record.token),
        tokenPreview: record.token ? `${record.token.slice(0, 4)}…` : null
      },
      registry: await this.connectionsList()
    }
  }

  private toRegistry(store: import('./registry').WebConnectionsStore): DesktopConnectionsRegistry {
    return {
      version: store.version,
      primary: store.primary,
      secureTokenStorage: true,
      connections: store.connections.map(c => ({
        id: c.id,
        kind: c.kind,
        label: c.label,
        url: c.url,
        authMode: c.authMode,
        tokenSet: Boolean(c.token),
        tokenPreview: c.token ? `${c.token.slice(0, 4)}…` : null
      }))
    }
  }

  async connectionsRemove(id: string): Promise<{ ok: boolean; registry: DesktopConnectionsRegistry }> {
    return { ok: true, registry: this.toRegistry(removeConnection(id)) }
  }

  async connectionsSetPrimary(id: string): Promise<{ ok: boolean; registry: DesktopConnectionsRegistry }> {
    return { ok: true, registry: this.toRegistry(setPrimaryConnection(id)) }
  }

  async connectionsTest(id: string): Promise<DesktopConnectionTestResult> {
    const record = loadRegistry().connections.find(c => c.id === id)

    if (!record) {
      return { ok: false, error: 'unknown connection', reachable: false, version: null }
    }

    return this.probe(record.url)
  }

  // ── ssh / cloud 空面 ─────────────────────────────────────────────────────

  async sshConfigHosts(): Promise<DesktopSshHostsResult> {
    return { hosts: [] }
  }

  async sshResolveHost(_host: string): Promise<DesktopSshResolveResult> {
    return { hostname: null, identityFile: null, port: null, user: null }
  }

  async cloudStatus(): Promise<DesktopCloudStatus> {
    return { portalBaseUrl: '', signedIn: false }
  }

  // ── 版本 / bootstrap 状态 ─────────────────────────────────────────────────

  async getVersion(): Promise<DesktopVersionInfo> {
    return {
      appVersion: WEB_VERSION,
      electronVersion: 'web',
      nodeVersion: 'web',
      platform: 'web',
      hermesRoot: ''
    }
  }

  async getRemoteDisplayReason(): Promise<string | null> {
    return 'web'
  }

  async getBootstrapState(): Promise<DesktopBootstrapState> {
    return {
      active: false,
      manifest: null,
      stages: {},
      error: null,
      log: [],
      startedAt: null,
      completedAt: null,
      setupChoice: null,
      unsupportedPlatform: null
    }
  }

  onBootstrapEvent(_callback: (payload: DesktopBootstrapEvent) => void): () => void {
    return () => undefined
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private applyConfigToRecord(record: WebConnectionRecord, payload: DesktopConnectionConfigInput): WebConnectionRecord {
    const mode = payload.mode === 'local' ? 'local' : payload.mode === 'ssh' ? 'ssh' : payload.mode === 'cloud' ? 'cloud' : 'remote'
    const next: WebConnectionRecord = { ...record }

    if (payload.remoteUrl !== undefined) {
      next.url = payload.remoteUrl
    }

    if (payload.remoteAuthMode !== undefined) {
      next.authMode = payload.remoteAuthMode
      if (payload.remoteAuthMode === 'oauth') {
        // OAuth 凭证在代理 httpOnly 会话；清掉 token 模式残留的静态 token。
        next.token = ''
      }
    }

    if (payload.remoteToken !== undefined && payload.remoteToken !== '') {
      next.token = payload.remoteToken
    }

    next.kind = mode

    return next
  }

  private async probe(remoteUrl: string): Promise<DesktopConnectionTestResult> {
    const probe = await this.probeConnectionConfig(remoteUrl)

    return {
      ok: probe.reachable,
      baseUrl: remoteUrl,
      version: probe.version,
      reachable: probe.reachable,
      error: probe.error
    }
  }
}
