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

export const WEB_VERSION = '0.1.0-web-m1'

/** 网关 base URL：M1 = 注册表里连接的 url；M2 = 同源代理（本函数是唯一落点）。 */
export function gatewayBaseUrl(conn?: WebConnectionRecord): string {
  const record = conn ?? getPrimaryConnection()

  return record.url.replace(/\/+$/, '')
}

function wsUrlFor(conn: WebConnectionRecord): string {
  const base = gatewayBaseUrl(conn).replace(/^http/, 'ws')

  return `${base}/gateway?token=${encodeURIComponent(conn.token)}`
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

  init.headers = {
    ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    'X-Hermes-Session-Token': conn.token
  }

  const controller = new AbortController()
  const timer = request.timeoutMs
    ? window.setTimeout(() => controller.abort(), request.timeoutMs)
    : undefined

  try {
    const res = await fetch(`${base}${path}`, { ...init, signal: controller.signal })

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

  async getConnectionConfig(): Promise<DesktopConnectionConfig> {
    return this.toConfig(getPrimaryConnection())
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
      const status = await fetch(`${remoteUrl.replace(/\/+$/, '')}/api/status`, {
        headers: { 'X-Hermes-Session-Token': getPrimaryConnection().token }
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

      const json = (await status.json().catch(() => null)) as { version?: string; auth_mode?: string } | null

      return {
        baseUrl: remoteUrl,
        reachable: true,
        authMode: json?.auth_mode === 'oauth' ? 'oauth' : json?.auth_mode === 'token' ? 'token' : 'unknown',
        providers: [],
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

  async oauthLoginConnectionConfig(_remoteUrl: string): Promise<DesktopOauthLoginResult> {
    // OAuth 是 M3 里程碑；M1 直拒。
    return { ok: false, baseUrl: getPrimaryConnection().url, connected: false }
  }

  async oauthLogoutConnectionConfig(): Promise<DesktopOauthLogoutResult> {
    return { ok: false, connected: false }
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
      token: payload.token ?? getPrimaryConnection().token
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


