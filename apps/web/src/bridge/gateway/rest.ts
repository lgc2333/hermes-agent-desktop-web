/**
 * Gateway 桥面 — REST 转发与 URL 构造。
 *
 * 从 gateway.ts 拆出（目录化重构）：代理基址解析、网关 base URL / WS 拨号
 * URL、HermesConnection 映射、错误形状、webApi REST 转发、代理 meta 查询。
 */

import type { HermesApiRequest, HermesConnection } from '@/global'
import type { GatewayWsUrlResult } from '@hermes/shared'

import { getPrimaryConnection, type WebConnectionRecord } from '../registry'

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
export function proxyFetch(input: string, init: RequestInit = {}): Promise<Response> {
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
export function wsUrlFor(conn: WebConnectionRecord): string {
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
    windowButtonPosition: null,
  }
}

/** 错误形状与桌面 Electron 桥一致，渲染层的 isEndpointMissingError 等靠它识别。 */
export function apiError(status: number, path: string, body: string): Error {
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
      new Blob([request.upload.bytes], {
        type: request.upload.contentType ?? 'application/octet-stream',
      }),
      request.upload.filename,
    )
    init = { method, body: form }
  } else {
    init = {
      method,
      ...(request.body !== undefined && method !== 'GET' && method !== 'HEAD'
        ? { body: JSON.stringify(request.body) }
        : {}),
    }
  }

  // M3：OAuth 模式浏览器不持静态 token（代理按会话注入 Bearer），
  // 只带目标；token 模式照旧带 X-Hermes-Session-Token。
  const oauth = conn.authMode === 'oauth'
  init.headers = {
    ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    ...(oauth ? {} : { 'X-Hermes-Session-Token': conn.token }),
    // M2：目标 gateway 由每次请求携带（代理无状态，见 PLAN §6）。
    'X-Hermes-Target': conn.url.replace(/\/+$/, ''),
  }

  const controller = new AbortController()
  const timer = request.timeoutMs
    ? window.setTimeout(() => controller.abort(), request.timeoutMs)
    : undefined

  try {
    const res = await proxyFetch(`${base}${path}`, {
      ...init,
      signal: controller.signal,
    })

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

/** 读代理 /api/proxy/meta（默认 gateway URL 预填 + 出站白名单下发）。 */
export async function fetchProxyMeta(): Promise<{
  defaultGatewayUrl: string | null
  allowedTargets: string[]
} | null> {
  const proxy = proxyBaseUrl()

  if (!proxy) {
    return null
  }

  try {
    const res = await fetch(`${proxy}/api/proxy/meta`)
    if (!res.ok) {
      return null
    }

    return (await res.json()) as {
      defaultGatewayUrl: string | null
      allowedTargets: string[]
    }
  } catch {
    return null
  }
}
/** 目标 gateway 的规范化 base URL（去尾斜杠）。 */
export function normalizeTargetUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * M5：密码 "dashboard login" 登录（经代理 /api/proxy/session/login）。
 * 成功 → 代理内存存 cookie jar 并回发 hermes_session httpOnly cookie；
 * 失败 → 抛带 gateway detail 的错误（如 "HTTP 401: Invalid credentials"）。
 */
export async function proxySessionLogin(
  target: string,
  provider: string,
  username: string,
  password: string,
): Promise<void> {
  const proxy = proxyBaseUrl()
  if (!proxy) {
    throw new Error('password login requires the proxy (proxy mode only)')
  }

  const res = await proxyFetch(`${proxy}/api/proxy/session/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      target: normalizeTargetUrl(target),
      provider,
      username,
      password,
    }),
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null
    throw new Error(`HTTP ${res.status}${body?.detail ? `: ${body.detail}` : ''}`)
  }
}

/** M5：清密码会话（代理转发 /auth/logout + 清 jar 与 cookie）。 */
export async function proxySessionLogout(): Promise<void> {
  const proxy = proxyBaseUrl()
  if (!proxy) {
    return
  }

  await proxyFetch(`${proxy}/api/proxy/session/logout`, { method: 'POST' })
}

/** M5：查询密码会话状态（cookie + target 匹配才 connected）。 */
export async function proxySessionStatus(target: string): Promise<{
  connected: boolean
  provider: string
  username: string
}> {
  const proxy = proxyBaseUrl()
  if (!proxy) {
    return { connected: false, provider: '', username: '' }
  }

  try {
    const res = await proxyFetch(
      `${proxy}/api/proxy/session/status?target=${encodeURIComponent(normalizeTargetUrl(target))}`,
    )
    if (!res.ok) {
      return { connected: false, provider: '', username: '' }
    }

    const json = (await res.json()) as {
      connected?: boolean
      provider?: string
      username?: string
    }

    return {
      connected: Boolean(json.connected),
      provider: json.provider ?? '',
      username: json.username ?? '',
    }
  } catch {
    return { connected: false, provider: '', username: '' }
  }
}

/**
 * M5：探测 provider 形状（supports_password / display_name）。
 * 走代理（同 /api/status 探测），public 端点无鉴权。失败 → null（调用方
 * 回退到 /api/status 的 auth_providers 名字列表）。
 */
export async function probeAuthProviders(
  remoteUrl: string,
): Promise<{ name: string; displayName: string; supportsPassword: boolean }[] | null> {
  const proxy = proxyBaseUrl()
  const base = proxy ?? normalizeTargetUrl(remoteUrl)

  try {
    const res = await proxyFetch(`${base}/api/auth/providers`, {
      headers: proxy ? { 'X-Hermes-Target': normalizeTargetUrl(remoteUrl) } : {},
    })
    if (!res.ok) {
      return null
    }

    const json = (await res.json()) as {
      providers?: {
        name?: unknown
        display_name?: unknown
        supports_password?: unknown
      }[]
    }

    if (!Array.isArray(json.providers)) {
      return null
    }

    return json.providers
      .map((p) => ({
        name: String(p.name ?? ''),
        displayName: String(p.display_name ?? p.name ?? ''),
        supportsPassword: Boolean(p.supports_password),
      }))
      .filter((p) => p.name)
  } catch {
    return null
  }
}
