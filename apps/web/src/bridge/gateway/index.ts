/**
 * Class 2 — 走代理 RPC 的桥面（M1 直连 mock gateway，M2 换同源代理协议）。
 *
 * 职责（PLAN §3 / handoff §3）：
 *   - 连接面：getConnection/getGatewayWsUrl/revalidateConnection/touchBackend，
 *     数据源 = 连接注册表（registry.ts，localStorage，ADR-0002）；
 *   - REST 面：api() 转发（rest.ts：webApi，M1 直连 baseUrl +
 *     X-Hermes-Session-Token；M2 同源代理 + X-Hermes-Target，错误形状不变）；
 *   - boot 面：getBootProgress/onBootProgress/onBackendExit 等 —— 浏览器无
 *     后端进程，语义简化为连接探测；
 *   - 连接设置面：getConnectionConfig/save/apply/test/probe + profile +
 *     connections 注册表 + cloud/ssh 空面；
 *   - fs/git REST 面：fs-git.ts（ADR-0010）；OAuth 中转：oauth.ts。
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
  HermesWindowState,
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
  type WebConnectionRecord,
} from '../registry'

import { RemoteFsGit } from './fs-git'
import { OauthBroker } from './oauth'
import {
  fetchProxyMeta,
  probeAuthProviders,
  proxyBaseUrl,
  proxySessionLogin,
  proxySessionLogout,
  toHermesConnection,
  webApi,
  wsUrlFor,
} from './rest'

export const WEB_VERSION = '0.1.0-web-m3'

// 保持 './gateway' 既有导入面（gateway.test.ts / adapter.ts）。
export { toHermesConnection, webApi } from './rest'
export type { BridgeApi } from './fs-git'

export interface WebBridgeOptions {
  /** M1 默认目标 = 注册表主连接（mock gateway）；M2 注入同源代理地址。 */
  api?: typeof webApi
}

export class GatewayAdapter {
  private readonly apiImpl: typeof webApi
  private readonly fsGit: RemoteFsGit
  private readonly oauth: OauthBroker

  constructor(options: WebBridgeOptions = {}) {
    this.apiImpl = options.api ?? webApi
    this.fsGit = new RemoteFsGit(this.apiImpl)
    this.oauth = new OauthBroker()
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
      timestamp: Date.now(),
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
      mode:
        conn.kind === 'local' ? 'local' : conn.kind === 'remote' ? 'remote' : conn.kind,
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
      sshRemoteProfile: '',
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
      const session = await this.oauth.sessionStatus(conn.url)
      config.remoteOauthConnected = session.connected
      if (session.connected && session.tokenPreview) {
        config.remoteTokenPreview = session.tokenPreview
      }
    }

    // 默认连接预填（只在仍是出厂 mock 地址时生效）。
    if (conn.id === DEFAULT_CONNECTION_ID && conn.url === defaultMockConnection().url) {
      const meta = await fetchProxyMeta().catch(() => null)
      if (meta?.defaultGatewayUrl) {
        config.remoteUrl = meta.defaultGatewayUrl
      }
    }

    return config
  }

  async saveConnectionConfig(
    payload: DesktopConnectionConfigInput,
  ): Promise<DesktopConnectionConfig> {
    const current = getPrimaryConnection()
    const next = this.applyConfigToRecord(current, payload)
    upsertConnection(next)

    return this.toConfig(next)
  }

  async applyConnectionConfig(
    payload: DesktopConnectionConfigInput,
  ): Promise<DesktopConnectionConfig> {
    // M1：保存即应用（浏览器无进程需要重启；M2 换代理后此处触发重连）。
    return this.saveConnectionConfig(payload)
  }

  async testConnectionConfig(
    payload: DesktopConnectionConfigInput,
  ): Promise<DesktopConnectionTestResult> {
    return this.probe(payload.remoteUrl ?? getPrimaryConnection().url)
  }

  async probeConnectionConfig(
    remoteUrl: string,
  ): Promise<DesktopConnectionProbeResult> {
    try {
      // M2：探测也走代理（dev 跨源 / 生产同源都通），转发正确性一并验证。
      const proxy = proxyBaseUrl()
      const base = proxy ?? remoteUrl.replace(/\/+$/, '')
      const status = await fetch(`${base}/api/status`, {
        headers: {
          'X-Hermes-Session-Token': getPrimaryConnection().token,
          ...(proxy ? { 'X-Hermes-Target': remoteUrl.replace(/\/+$/, '') } : {}),
        },
      })

      if (!status.ok) {
        return {
          baseUrl: remoteUrl,
          reachable: false,
          authMode: 'unknown',
          providers: [],
          version: null,
          error: `HTTP ${status.status}`,
        }
      }

      const json = (await status.json().catch(() => null)) as {
        version?: string
        auth_mode?: string
        auth_required?: boolean
        auth_flows?: string[]
        auth_providers?: string[]
      } | null

      // M5：/api/auth/providers（public）下发 provider 形状——supports_password
      // 驱动 UI 显示 "dashboard login" 用户名/密码表单（桌面端同款判定：
      // 全部 provider 支持密码才视为密码门禁）。失败回退到 status 的名字列表。
      const enriched = await probeAuthProviders(remoteUrl)
      const fallbackProviders: DesktopAuthProvider[] = (json?.auth_providers ?? []).map(
        (name) => ({ name, displayName: name }),
      )
      const providers: DesktopAuthProvider[] = (enriched ?? fallbackProviders).map(
        (p) => ({
          name: p.name,
          displayName: p.displayName,
          supportsPassword: p.supportsPassword,
        }),
      )
      const supportsPassword = providers.some((p) => p.supportsPassword)

      // M3：真 gateway 无 auth_mode 字段，按 auth_required + auth_flows 判定；
      // M5：密码门禁（gated + 无 native_pkce 的旧网关或纯密码 provider）
      // 归入 oauth 分支——cookie/ws-ticket 机制与 OAuth 完全一致，只是
      // 登录换成了用户名/密码表单；旧 mock 的 auth_mode 字段保留兼容。
      const authMode =
        json?.auth_required === true
          ? (json.auth_flows ?? []).includes('native_pkce') || supportsPassword
            ? 'oauth'
            : 'token'
          : json?.auth_required === false
            ? 'token'
            : json?.auth_mode === 'oauth'
              ? 'oauth'
              : json?.auth_mode === 'token'
                ? 'token'
                : 'unknown'

      return {
        baseUrl: remoteUrl,
        reachable: true,
        authMode,
        providers,
        version: json?.version ?? null,
        error: null,
      }
    } catch (error) {
      return {
        baseUrl: remoteUrl,
        reachable: false,
        authMode: 'unknown',
        providers: [],
        version: null,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  // ── OAuth 中转（实现拆到 oauth.ts）───────────────────────────────────────

  async oauthLoginConnectionConfig(
    remoteUrl: string,
  ): Promise<DesktopOauthLoginResult> {
    return this.oauth.login(remoteUrl)
  }

  async oauthLogoutConnectionConfig(
    remoteUrl?: string,
  ): Promise<DesktopOauthLogoutResult> {
    // M5：登出同时清两种代理会话（OAuth token set + 密码 cookie jar）——
    // UI 不区分登出的是哪一种，幂等即可。
    const [oauth] = await Promise.all([
      this.oauth.logout(remoteUrl),
      proxySessionLogout().catch(() => undefined),
    ])

    return oauth
  }

  // ── M5：密码 "dashboard login" 会话（经代理 /api/proxy/session/*）──────

  async passwordLoginConnectionConfig(
    remoteUrl: string,
    provider: string,
    username: string,
    password: string,
  ): Promise<DesktopOauthLoginResult> {
    const baseUrl = remoteUrl.replace(/\/+$/, '')

    try {
      await proxySessionLogin(baseUrl, provider, username, password)

      return { ok: true, baseUrl, connected: true }
    } catch (error) {
      // 失败抛 readable 错误（带 gateway detail），渲染层 notifyError 展示。
      throw new Error(error instanceof Error ? error.message : String(error))
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

  async connectionsSave(payload: DesktopRegistryConnectionInput): Promise<{
    ok: boolean
    connection: DesktopRegistryConnection
    registry: DesktopConnectionsRegistry
  }> {
    const id = payload.id ?? `conn-${Date.now().toString(36)}`
    const record: WebConnectionRecord = {
      id,
      kind: payload.kind,
      label: payload.label,
      url: payload.url ?? '',
      authMode: payload.authMode ?? 'token',
      token:
        payload.authMode === 'oauth'
          ? ''
          : (payload.token ?? getPrimaryConnection().token),
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
        tokenPreview: record.token ? `${record.token.slice(0, 4)}…` : null,
      },
      registry: await this.connectionsList(),
    }
  }

  private toRegistry(
    store: import('../registry').WebConnectionsStore,
  ): DesktopConnectionsRegistry {
    return {
      version: store.version,
      primary: store.primary,
      secureTokenStorage: true,
      connections: store.connections.map((c) => ({
        id: c.id,
        kind: c.kind,
        label: c.label,
        url: c.url,
        authMode: c.authMode,
        tokenSet: Boolean(c.token),
        tokenPreview: c.token ? `${c.token.slice(0, 4)}…` : null,
      })),
    }
  }

  async connectionsRemove(
    id: string,
  ): Promise<{ ok: boolean; registry: DesktopConnectionsRegistry }> {
    return { ok: true, registry: this.toRegistry(removeConnection(id)) }
  }

  async connectionsSetPrimary(
    id: string,
  ): Promise<{ ok: boolean; registry: DesktopConnectionsRegistry }> {
    return { ok: true, registry: this.toRegistry(setPrimaryConnection(id)) }
  }

  async connectionsTest(id: string): Promise<DesktopConnectionTestResult> {
    const record = loadRegistry().connections.find((c) => c.id === id)

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
      hermesRoot: '',
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
      unsupportedPlatform: null,
    }
  }

  onBootstrapEvent(_callback: (payload: DesktopBootstrapEvent) => void): () => void {
    return () => undefined
  }

  // ── fs / git REST 面（实现拆到 fs-git.ts，ADR-0010）──────────────────────

  readDir(path: string) {
    return this.fsGit.readDir(path)
  }

  readFileText(filePath: string) {
    return this.fsGit.readFileText(filePath)
  }

  writeTextFile(filePath: string, content: string) {
    return this.fsGit.writeTextFile(filePath, content)
  }

  readFileDataUrl(filePath: string) {
    return this.fsGit.readFileDataUrl(filePath)
  }

  gitRoot(path: string) {
    return this.fsGit.gitRoot(path)
  }

  get git(): NonNullable<NonNullable<Window['hermesDesktop']>['git']> {
    return this.fsGit.git
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private applyConfigToRecord(
    record: WebConnectionRecord,
    payload: DesktopConnectionConfigInput,
  ): WebConnectionRecord {
    const mode =
      payload.mode === 'local'
        ? 'local'
        : payload.mode === 'ssh'
          ? 'ssh'
          : payload.mode === 'cloud'
            ? 'cloud'
            : 'remote'
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
      error: probe.error,
    }
  }
}
