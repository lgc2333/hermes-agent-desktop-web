/**
 * oauth.ts — M3 native PKCE 中转（RFC 8252 / RFC 7636），ADR-0023 凭证模型。
 *
 * 浏览器侧完成 OAuth 登录（gateway 的 `/auth/native/*` 面，Hermes
 * Cloud/Privy 由 gateway 的 auth_flows 自动适配），代理负责：
 *
 *   1. `/auth/native/start`    —— 生成 PKCE pair + state，构建 gateway
 *      authorize URL 返回给浏览器（浏览器开新窗口导航过去）；redirect_uri
 *      默认是代理自身的 loopback 字面量（ADR-0017，gateway 只收 loopback）；
 *   2. `/auth/native/callback` —— gateway 完成授权后 302 回代理（dev 拓扑
 *      弹窗自动关闭）；代理校验 state（CSRF），用 code + verifier 换
 *      token set，编码进 httpOnly 会话 cookie（ADR-0023）；
 *   3. `/auth/native/paste`    —— 远端部署的粘贴回跳（ADR-0017）：浏览器
 *      跳到本机 127.0.0.1 失败（预期），用户把地址栏完整 URL 粘贴回来，
 *      代理校验 state + target 后走与 callback 完全相同的 code 交换路径；
 *   4. `/auth/native/session`  —— 浏览器带 cookie 查询连接状态（不暴露
 *      token 本体，只回显 provider/userId/过期时间/前 4 位预览）；
 *   5. `/auth/native/logout`   —— 清浏览器会话 cookie（尽力转发登出）。
 *
 * 凭证生命周期（ADR-0023）：token set **编码进浏览器 httpOnly cookie**
 * （`hermes_oauth_<targetHash>`，per-target，Max-Age=30d），代理进程零凭证
 * 内存态——重启后浏览器 cookie 仍在，会话无感恢复。进行中的登录（PKCE
 * pending）同样进 cookie（`hermes_oauth_pending`，Max-Age=600，对齐上游
 * `hermes_session_pkce`）。转发面（relay.ts / main.ts）从请求 cookie 解码
 * token set 注入 Bearer；WS 拨号前经 `POST /api/auth/ws-ticket` 换单次
 * ticket（gated gateway 拒绝 `?token=`）。token 过期前自动经
 * `/auth/native/refresh` 轮换，新 token set 编码成新 cookie 值随响应写回
 * （REST Set-Cookie / WS 101 升级响应，Portal RT 旋转 + reuse-detection
 * 要求每次 refresh 后立即写回）。
 *
 * 本模块零依赖纯逻辑（除注入的 fetch），全部可单测（oauth_test.ts）。
 *
 * 协议（对照 hermes 0.19.x dashboard_auth/native_flow.py 核实）：
 *   GET  <target>/auth/native/authorize?code_challenge=S256..&state=..&redirect_uri=..
 *        → gateway 走自己的上游 PKCE 流程，最终 302 到 redirect_uri?code=<gw_code>&state=<state>
 *   POST <target>/auth/native/token  { code, code_verifier } → { access_token,
 *        refresh_token, token_type, expires_at, provider, user_id }
 *   POST <target>/auth/native/refresh { refresh_token, provider? } → 同上
 *   POST <target>/api/auth/ws-ticket (Bearer) → { ticket, ttl_seconds }
 *
 * 拓扑（ADR-0017 paste-back）：真 gateway 校验 redirect_uri 必须是 loopback
 * （127.0.0.1/::1，见 native_flow 的 _validate_loopback_redirect_uri），故
 * start 默认用代理自身的 loopback 字面量 127.0.0.1:<port>——dev（浏览器与
 * 代理同机）弹窗自动完成；远端部署时浏览器跳到本机 127.0.0.1 失败（预期），
 * 用户复制地址栏完整 URL 经 /auth/native/paste 粘贴完成，无需隧道。
 * WEB_OAUTH_REDIRECT_URI 仍可整体覆盖 redirect_uri（部署场景）。
 */

/** PKCE pair（S256，RFC 7636）。verifier 43 chars，challenge 43 chars。 */
export interface NativePkcePair {
  verifier: string
  challenge: string
  method: 'S256'
}

/** 规范化后的 token set（camelCase，与上游 native-oauth.ts 一致）。 */
export interface NativeTokenSet {
  accessToken: string
  refreshToken: string
  expiresAt: number
  provider: string
  userId: string
}

/** 一次进行中的登录（start 到 callback 之间；编码进 pending cookie）。 */
export interface PendingLogin {
  /** CSRF state（callback 校验用）。 */
  state: string
  target: string
  verifier: string
  redirectUri: string
  createdAt: number
}

export interface OAuthStartResult {
  /** gateway authorize URL（浏览器新窗口导航）。 */
  authorizeUrl: string
  /** pending cookie 值（编码后的进行中登录；调用方 Set-Cookie 下发）。 */
  pendingValue: string
}

export interface OAuthSessionInfo {
  connected: boolean
  provider: string
  userId: string
  expiresAt: number
  /** access_token 前 4 位 + …（UI 展示用，不下发 token 本体）。 */
  tokenPreview: string | null
}

/** 注入面（测试可换）。 */
export interface OAuthDeps {
  /** POST JSON 并返回解析后的 body（生产 = global fetch）。 */
  postJson: (
    url: string,
    body: unknown,
    opts?: { timeoutMs?: number; headers?: Record<string, string> },
  ) => Promise<unknown>
  /** 时钟（秒），测试可控。 */
  now?: () => number
  /** 刷新窗口提前量（秒），默认 60。 */
  refreshSkewSeconds?: number
}

const DEFAULT_PENDING_TTL_MS = 10 * 60_000 // 与 gateway 的 _PENDING_TTL_SECONDS 对齐
const DEFAULT_REFRESH_SKEW_SECONDS = 60
const TOKEN_EXCHANGE_TIMEOUT_MS = 15_000
const WS_TICKET_TIMEOUT_MS = 10_000
/** ADR-0017：loopback redirect_uri 默认端口（与 main.ts PORT 默认 6722 对齐）。 */
const DEFAULT_LOOPBACK_PORT = 6722

// ── ADR-0023 cookie 常量 ───────────────────────────────────────────────────

/** 会话 cookie 名前缀：`hermes_oauth_<targetHash>`（per-target，多连接共存）。 */
export const SESSION_COOKIE_PREFIX = 'hermes_oauth_'
/** 进行中登录（PKCE pending）cookie 名（单值：同时只有一个进行中的登录）。 */
export const PENDING_COOKIE_NAME = 'hermes_oauth_pending'
/** 会话 cookie Max-Age（30 天，对齐上游 RT cookie TTL）。 */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
/** pending cookie Max-Age（10 分钟，对齐 gateway _PENDING_TTL_SECONDS）。 */
export const PENDING_MAX_AGE_SECONDS = 10 * 60
/** 单 cookie 值上限（RFC 6265 建议 4096 bytes；留名字/属性余量）。 */
const MAX_COOKIE_VALUE_CHARS = 3500

// ── PKCE / 随机数（Web Crypto，Deno 原生）──────────────────────────────────

function b64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  const binary = atob(b64 + pad)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n)
  crypto.getRandomValues(bytes)

  return bytes
}

async function sha256B64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))

  return b64urlEncode(new Uint8Array(digest))
}

/** 生成 PKCE pair（S256）。verifier = 32 随机字节 b64url（43 chars）。 */
export async function generatePkcePair(): Promise<NativePkcePair> {
  const verifier = b64urlEncode(randomBytes(32))
  const challenge = await sha256B64url(verifier)

  return { verifier, challenge, method: 'S256' }
}

/** 高熵 CSRF state（24 随机字节 b64url）。 */
export function generateState(): string {
  return b64urlEncode(randomBytes(24))
}

// ── target hash / cookie 名（ADR-0023 per-target）──────────────────────────

/**
 * target → 稳定短 hash（FNV-1a 64-bit hex）。用于 per-target cookie 名
 * （`hermes_oauth_<hash>` / `hermes_session_<hash>`）与 target 内嵌校验，
 * 多连接各自独立 cookie 共存（ADR-0023 决策 2）。
 */
export function targetHash(target: string): string {
  let h = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (const byte of new TextEncoder().encode(target)) {
    h ^= BigInt(byte)
    h = (h * prime) & 0xffffffffffffffffn
  }

  return h.toString(16).padStart(16, '0')
}

/** OAuth 会话 cookie 名：`hermes_oauth_<targetHash>`。 */
export function oauthSessionCookieName(target: string): string {
  return `${SESSION_COOKIE_PREFIX}${targetHash(target)}`
}

// ── 会话 cookie 编解码（ADR-0023）──────────────────────────────────────────

interface SessionCookiePayload {
  v: 1
  t: string // target
  a: string // accessToken
  r: string // refreshToken
  e: number // expiresAt
  p: string // provider
  u: string // userId
}

/** 编码 token set → cookie 值（base64url(JSON)，target 内嵌防串连）。 */
export function encodeSessionCookie(target: string, ts: NativeTokenSet): string {
  const payload: SessionCookiePayload = {
    v: 1,
    t: target,
    a: ts.accessToken,
    r: ts.refreshToken,
    e: ts.expiresAt,
    p: ts.provider,
    u: ts.userId,
  }
  const value = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  if (value.length > MAX_COOKIE_VALUE_CHARS) {
    throw new Error(
      `Session cookie too large (${value.length} chars > ${MAX_COOKIE_VALUE_CHARS}): ` +
        'provider issued an unusually long token set',
    )
  }

  return value
}

/** 解码 cookie 值 → { target, tokenSet }；非法/版本不符 → null。 */
export function decodeSessionCookie(value: string): {
  target: string
  tokenSet: NativeTokenSet
} | null {
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(b64urlDecode(value)),
    ) as Partial<SessionCookiePayload>
    if (payload.v !== 1 || typeof payload.t !== 'string' || !payload.a) {
      return null
    }

    return {
      target: payload.t,
      tokenSet: {
        accessToken: payload.a,
        refreshToken: payload.r ?? '',
        expiresAt: Number(payload.e) || 0,
        provider: payload.p ?? '',
        userId: payload.u ?? '',
      },
    }
  } catch {
    return null
  }
}

// ── pending cookie 编解码（ADR-0023 决策 4，对齐上游 hermes_session_pkce）──

/** 编码进行中登录 → pending cookie 值。 */
export function encodePendingCookie(pending: PendingLogin): string {
  return b64urlEncode(new TextEncoder().encode(JSON.stringify(pending)))
}

/** 解码 pending cookie 值；非法 → null。 */
export function decodePendingCookie(value: string): PendingLogin | null {
  try {
    const p = JSON.parse(new TextDecoder().decode(b64urlDecode(value))) as PendingLogin
    if (typeof p.state !== 'string' || typeof p.target !== 'string' || !p.verifier) {
      return null
    }

    return {
      state: p.state,
      target: p.target,
      verifier: p.verifier,
      redirectUri: p.redirectUri ?? '',
      createdAt: Number(p.createdAt) || 0,
    }
  } catch {
    return null
  }
}

// ── Cookie 头值构造（Secure 生产自动加，ADR-0023）──────────────────────────

/**
 * 会话 cookie 的 Set-Cookie 值。HttpOnly + SameSite=Lax（跨端口/同源携带；
 * 跨站不发送）；`secure` 为 true 时加 `Secure`（生产 HTTPS 自动启用）。
 */
export function sessionCookieValue(
  name: string,
  value: string,
  opts: { maxAgeSeconds?: number; secure?: boolean } = {},
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${opts.maxAgeSeconds ?? SESSION_MAX_AGE_SECONDS}`,
  ]
  if (opts.secure) {
    parts.push('Secure')
  }

  return parts.join('; ')
}

/** 清除会话 cookie（登出）。 */
export function clearSessionCookieValue(
  name: string,
  opts: { secure?: boolean } = {},
): string {
  return sessionCookieValue(name, '', { maxAgeSeconds: 0, secure: opts.secure })
}

/** pending cookie 的 Set-Cookie 值（短 TTL，对齐 gateway）。 */
export function pendingCookieValue(
  pendingValue: string,
  opts: { secure?: boolean } = {},
): string {
  return sessionCookieValue(PENDING_COOKIE_NAME, pendingValue, {
    maxAgeSeconds: PENDING_MAX_AGE_SECONDS,
    secure: opts.secure,
  })
}

/** 清除 pending cookie。 */
export function clearPendingCookieValue(opts: { secure?: boolean } = {}): string {
  return sessionCookieValue(PENDING_COOKIE_NAME, '', {
    maxAgeSeconds: 0,
    secure: opts.secure,
  })
}

// ── URL 构建（与上游 native-oauth.ts 同形）─────────────────────────────────

function joinBase(baseUrl: string, path: string): string {
  const parsed = new URL(baseUrl)
  const prefix = parsed.pathname.replace(/\/+$/, '')

  return `${parsed.protocol}//${parsed.host}${prefix}${path}`
}

export function nativeAuthorizeUrl(
  target: string,
  params: { challenge: string; redirectUri: string; state: string; provider?: string },
): string {
  const q = new URLSearchParams({
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    redirect_uri: params.redirectUri,
    state: params.state,
  })
  if (params.provider) {
    q.set('provider', params.provider)
  }

  return `${joinBase(target, '/auth/native/authorize')}?${q.toString()}`
}

export function nativeTokenUrl(target: string): string {
  return joinBase(target, '/auth/native/token')
}

export function nativeRefreshUrl(target: string): string {
  return joinBase(target, '/auth/native/refresh')
}

export function wsTicketUrl(target: string): string {
  return joinBase(target, '/api/auth/ws-ticket')
}

// ── 回调解析 / token 响应规范化 ────────────────────────────────────────────

/**
 * 解析 gateway 回跳（path+query）。返回 code；state 不匹配抛错（CSRF，
 * RFC 6749 §10.12）。gateway 拒绝时带 error 参数也抛错。
 */
export function parseCallback(
  requestUrl: string,
  expectedState: string,
): { code: string } {
  const parsed = new URL(requestUrl, 'http://127.0.0.1')

  return parseCallbackQuery(parsed.searchParams, expectedState)
}

/**
 * 从 URLSearchParams 提取 code 并校验 state（callback 与 paste 共享）。
 * state 不匹配抛错（CSRF，RFC 6749 §10.12）；error 参数原样透传。
 */
export function parseCallbackQuery(
  search: URLSearchParams,
  expectedState: string,
): { code: string } {
  const error = search.get('error')

  if (error) {
    const desc = search.get('error_description') || ''
    throw new Error(
      `Gateway rejected native login: ${error}${desc ? ` (${desc})` : ''}`,
    )
  }

  const code = search.get('code') || ''
  const state = search.get('state') || ''

  if (!code) {
    throw new Error('Native callback missing authorization code')
  }

  if (!expectedState || state !== expectedState) {
    throw new Error('Native callback state mismatch (possible CSRF)')
  }

  return { code }
}

/**
 * 解析用户粘贴的回跳内容（完整 URL 或裸 query，容忍前后空白）。
 * 返回 code + state；不在此校验 state——paste 端点按 state 查 pending
 * cookie 时完成 CSRF 校验（与 callback 同一条验证链）。
 */
export function parsePastedCallback(raw: string): { code: string; state: string } {
  const trimmed = raw.trim()

  if (!trimmed) {
    throw new Error('Pasted callback is empty')
  }

  let parsed: URL
  try {
    // 完整 URL 用自身 origin；裸 query（如 ?code=..&state=..）以 127.0.0.1 兜底解析。
    parsed = new URL(trimmed, 'http://127.0.0.1')
  } catch {
    throw new Error('Invalid pasted callback URL')
  }

  const code = parsed.searchParams.get('code') || ''
  const state = parsed.searchParams.get('state') || ''

  if (!code) {
    throw new Error('Pasted callback missing authorization code')
  }

  return { code, state }
}

/** 规范化 `/auth/native/token`（或 refresh）JSON 响应；形状非法抛错。 */
export function parseTokenResponse(body: unknown): NativeTokenSet {
  const b = (body ?? {}) as Record<string, unknown>
  const accessToken = String(b.access_token ?? '')

  if (!accessToken) {
    throw new Error('Gateway token response missing access_token')
  }

  const expiresAt = Number(b.expires_at)

  return {
    accessToken,
    refreshToken: String(b.refresh_token ?? ''),
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    provider: String(b.provider ?? ''),
    userId: String(b.user_id ?? ''),
  }
}

/** access token 是否已到/临近过期（提前 skew 秒刷新，避免在途过期）。 */
export function tokenNeedsRefresh(
  expiresAt: number,
  nowSeconds: number,
  skewSeconds = DEFAULT_REFRESH_SKEW_SECONDS,
): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    // 未知过期时间 ⇒ 视为需要刷新，先验证再使用。
    return true
  }

  return nowSeconds >= expiresAt - skewSeconds
}

// ── Cookie 解析工具 ────────────────────────────────────────────────────────

/** 解析 Cookie 头（名字 → 值）。 */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}

  if (!header) {
    return out
  }

  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) {
      continue
    }
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name) {
      out[name] = value
    }
  }

  return out
}

// ── 无状态 OAuth 中转（凭证在浏览器 cookie，ADR-0023）──────────────────────

/**
 * OAuth 中转逻辑：零凭证内存态。token set / pending 全部在浏览器 cookie
 * （编码值经参数进出），`refreshing` 并发去重是唯一的瞬态内存（非凭证，
 * 重启丢失无害——只是少一层并发保护）。
 */
export class OAuthStore {
  /** target → 进行中的 refresh promise（并发去重；瞬态，非凭证）。 */
  private readonly refreshing = new Map<string, Promise<NativeTokenSet | null>>()

  constructor(readonly deps: OAuthDeps) {}

  /** start：生成 PKCE/state，编码 pending cookie，返回 authorize URL。 */
  async begin(
    target: string,
    redirectUri: string,
    provider?: string,
  ): Promise<OAuthStartResult> {
    const { verifier, challenge } = await generatePkcePair()
    const state = generateState()
    const pending: PendingLogin = {
      state,
      target,
      verifier,
      redirectUri,
      createdAt: Date.now(),
    }
    const authorizeUrl = nativeAuthorizeUrl(target, {
      challenge,
      redirectUri,
      state,
      provider,
    })

    return { authorizeUrl, pendingValue: encodePendingCookie(pending) }
  }

  /**
   * 解析 pending cookie 并校验 state（CSRF）。TTL 过期 / 值非法 /
   * state 不匹配 → null（端点按未登录处理）。
   */
  resolvePending(pendingValue: string | null, state: string): PendingLogin | null {
    if (!pendingValue) {
      return null
    }
    const pending = decodePendingCookie(pendingValue)
    if (!pending) {
      return null
    }
    if (pending.state !== state) {
      return null
    }
    if (Date.now() - pending.createdAt > DEFAULT_PENDING_TTL_MS) {
      return null
    }

    return pending
  }

  /**
   * 从会话 cookie 解码 token set 注入 REST（需要时先刷新）。返回
   * `setCookie` = 刷新后的新 cookie 值（调用方 Set-Cookie 写回浏览器；
   * Portal RT 旋转 + reuse-detection 要求每次 refresh 后立即写回）。
   * 无会话 / target 不匹配 / 刷新失败 → { bearer: null, setCookie: null }。
   */
  async bearerFor(
    cookieValue: string | null,
    target: string,
  ): Promise<{ bearer: string | null; setCookie: string | null }> {
    const session = this.sessionFromCookie(cookieValue, target)
    if (!session) {
      return { bearer: null, setCookie: null }
    }

    const now = this.deps.now ? this.deps.now() : Math.floor(Date.now() / 1000)
    const skew = this.deps.refreshSkewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS

    if (!tokenNeedsRefresh(session.tokenSet.expiresAt, now, skew)) {
      return { bearer: session.tokenSet.accessToken, setCookie: null }
    }

    const fresh = await this.refresh(target, session.tokenSet)
    if (!fresh) {
      return { bearer: null, setCookie: null }
    }

    return { bearer: fresh.accessToken, setCookie: encodeSessionCookie(target, fresh) }
  }

  /** WS 拨号：从会话 cookie 解码 → mint 单次 ws-ticket（失败 → null）。 */
  async wsTicketFor(
    cookieValue: string | null,
    target: string,
  ): Promise<{ ticket: string | null; setCookie: string | null }> {
    const { bearer, setCookie } = await this.bearerFor(cookieValue, target)
    if (!bearer) {
      return { ticket: null, setCookie: null }
    }

    try {
      const body = (await this.deps.postJson(
        wsTicketUrl(target),
        {},
        {
          timeoutMs: WS_TICKET_TIMEOUT_MS,
          headers: { authorization: `Bearer ${bearer}` },
        },
      )) as { ticket?: unknown }
      const ticket = String(body?.ticket ?? '')

      return { ticket: ticket || null, setCookie }
    } catch {
      return { ticket: null, setCookie: null }
    }
  }

  /** 会话状态查询（回显；永不下发 token 本体）。 */
  sessionInfo(cookieValue: string | null, target: string): OAuthSessionInfo {
    const session = this.sessionFromCookie(cookieValue, target)

    if (!session) {
      return {
        connected: false,
        provider: '',
        userId: '',
        expiresAt: 0,
        tokenPreview: null,
      }
    }

    return {
      connected: true,
      provider: session.tokenSet.provider,
      userId: session.tokenSet.userId,
      expiresAt: session.tokenSet.expiresAt,
      tokenPreview: `${session.tokenSet.accessToken.slice(0, 4)}…`,
    }
  }

  /** 从 cookie 值解码会话（target 内嵌校验，防串连）。 */
  private sessionFromCookie(
    cookieValue: string | null,
    target: string,
  ): { target: string; tokenSet: NativeTokenSet } | null {
    if (!cookieValue) {
      return null
    }
    const session = decodeSessionCookie(cookieValue)
    if (!session || session.target !== target) {
      return null
    }

    return session
  }

  /** 刷新（并发去重）：成功返回新 token set；失败（session_expired）→ null。 */
  private refresh(
    target: string,
    tokenSet: NativeTokenSet,
  ): Promise<NativeTokenSet | null> {
    const inflight = this.refreshing.get(target)
    if (inflight) {
      return inflight
    }

    const run = async (): Promise<NativeTokenSet | null> => {
      try {
        const body = (await this.deps.postJson(
          nativeRefreshUrl(target),
          {
            refresh_token: tokenSet.refreshToken,
            provider: tokenSet.provider,
          },
          { timeoutMs: TOKEN_EXCHANGE_TIMEOUT_MS },
        )) as Record<string, unknown>

        if (body && typeof body === 'object' && body.error === 'session_expired') {
          // gateway 判定 refresh 失效（401）→ 会话作废（不清 cookie：
          // 下次查询自然未连接）。
          return null
        }

        return parseTokenResponse(body)
      } catch {
        return null
      } finally {
        this.refreshing.delete(target)
      }
    }

    const promise = run()
    this.refreshing.set(target, promise)

    return promise
  }
}

// ── 端点处理器（main.ts 集成；cookie 读写由调用方传入）──────────────────────

export interface OauthHandlerContext {
  /** 请求是否为 HTTPS（生产自动加 Secure cookie 标志，ADR-0023）。 */
  isHttps: (request: Request) => boolean
}

export interface OauthEndpoints {
  /** POST /auth/native/start —— 浏览器 fetch；返回 { authorizeUrl } + pending cookie。 */
  handleStart: (request: Request) => Promise<Response>
  /** GET /auth/native/callback —— gateway 回跳；Set-Cookie 会话 + 清 pending。 */
  handleCallback: (request: Request) => Promise<Response>
  /** POST /auth/native/paste —— 远端粘贴回跳（ADR-0017）；Set-Cookie 会话 + 清 pending。 */
  handlePaste: (request: Request) => Promise<Response>
  /** GET /auth/native/session —— 状态查询（cookie + ?target=）。 */
  handleSession: (request: Request) => Promise<Response>
  /** POST /auth/native/logout —— 清会话 cookie。 */
  handleLogout: (request: Request) => Promise<Response>
}

const DONE_HTML =
  '<!doctype html><meta charset="utf-8"><title>Signed in</title>' +
  '<body style="font:15px system-ui;margin:3rem;text-align:center">' +
  '<h2>&#10003; Signed in to Hermes</h2>' +
  '<p>You can close this window and return to the app.</p>' +
  '<script>if (window.opener) setTimeout(() => window.close(), 400)</script>'

const FAILED_HTML =
  '<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>' +
  '<body style="font:15px system-ui;margin:3rem;text-align:center">' +
  '<h2>&#10007; Sign-in failed</h2><p>Close this window and try again.</p>' +
  '<script>if (window.opener) setTimeout(() => window.close(), 1500)</script>'

function json(
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string> | Headers,
): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (extraHeaders instanceof Headers) {
    // Headers 可能带多值头（多个 Set-Cookie）——set 会覆盖，须逐值追加。
    for (const [key, values] of extraHeaders.entries()) {
      if (key.toLowerCase() === 'set-cookie') {
        const setCookies = extraHeaders.getSetCookie?.() ?? []
        for (const v of setCookies) {
          headers.append('Set-Cookie', v)
        }
      } else {
        headers.set(key, values)
      }
    }
  } else if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      headers.set(key, value)
    }
  }

  return new Response(JSON.stringify(body), { status, headers })
}

/**
 * 用 code + pending cookie 完成交换（callback 与 paste 共享，ADR-0017）。
 * CSRF：只有代理签发过（cookie 里 state 匹配）的登录才可交换。失败不消费
 * pending（保留重试机会）；code 单次使用由 gateway 保证。
 */
async function exchangeCode(
  store: OAuthStore,
  pending: PendingLogin,
  code: string,
): Promise<NativeTokenSet> {
  const body = await store.deps.postJson(
    nativeTokenUrl(pending.target),
    { code, code_verifier: pending.verifier },
    { timeoutMs: TOKEN_EXCHANGE_TIMEOUT_MS },
  )

  return parseTokenResponse(body)
}

/** 读取请求中的 pending cookie 值。 */
function readPendingCookie(request: Request): string | null {
  return parseCookies(request.headers.get('cookie'))[PENDING_COOKIE_NAME] ?? null
}

/**
 * 组装 OAuth 端点。`loopbackPort` = 代理监听端口（loopback redirect_uri
 * 基址，默认 6722，ADR-0017）；`redirectUriOverride`（env
 * WEB_OAUTH_REDIRECT_URI）可整体覆盖（部署场景）。
 */
export function createOauthEndpoints(
  store: OAuthStore,
  ctx: OauthHandlerContext,
  opts: {
    /** 代理监听端口；loopback redirect_uri 用（默认 6722）。 */
    loopbackPort?: number
    redirectUriOverride?: () => string
    /** 目标白名单（ADR-0015）：返回 false 时 start 拒绝 403。 */
    allowTarget?: (target: string) => boolean
  } = {},
): OauthEndpoints {
  const redirectUriFor = (): string => {
    const override = opts.redirectUriOverride?.()
    if (override && override.trim()) {
      return override.trim()
    }

    return `http://127.0.0.1:${opts.loopbackPort ?? DEFAULT_LOOPBACK_PORT}/auth/native/callback`
  }

  return {
    async handleStart(request: Request): Promise<Response> {
      let target = ''
      try {
        const body = (await request.json().catch(() => ({}))) as { target?: unknown }
        target = String(body.target ?? '')
      } catch {
        target = ''
      }
      if (!target) {
        return json(400, { detail: 'target required' })
      }

      // 规范化 target（与转发面同一校验）。
      let normalized: string
      try {
        normalized = normalizeTargetUrl(target)
      } catch (error) {
        return json(400, {
          detail: error instanceof Error ? error.message : String(error),
        })
      }

      // 目标白名单（ADR-0015）：start 之后的 code 交换会向该 target 发
      // POST，必须限定在名单内。
      if (opts.allowTarget && !opts.allowTarget(normalized)) {
        return json(403, { detail: 'target not allowed' })
      }

      try {
        const { authorizeUrl, pendingValue } = await store.begin(
          normalized,
          redirectUriFor(),
        )
        const secure = ctx.isHttps(request)

        return json(
          200,
          { authorizeUrl },
          {
            'Cache-Control': 'no-store',
            'Set-Cookie': pendingCookieValue(pendingValue, { secure }),
          },
        )
      } catch (error) {
        return json(500, {
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    },

    async handleCallback(request: Request): Promise<Response> {
      const url = new URL(request.url)
      const state = url.searchParams.get('state') ?? ''
      const pending = store.resolvePending(readPendingCookie(request), state)

      if (!pending) {
        return new Response(FAILED_HTML, {
          status: 400,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      }

      const secure = ctx.isHttps(request)

      try {
        const { code } = parseCallback(url.pathname + url.search, state)
        // code 有 TTL（gateway 侧 120s），callback 到交换之间的窗口足够；
        // 交换失败不消费 pending（浏览器可重试粘贴/回跳）。
        const tokenSet = await exchangeCode(store, pending, code)
        const headers = new Headers({
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        // 会话 cookie（编码 token set）+ 清 pending cookie（两个 Set-Cookie 头）。
        headers.append(
          'Set-Cookie',
          sessionCookieValue(
            oauthSessionCookieName(pending.target),
            encodeSessionCookie(pending.target, tokenSet),
            { secure },
          ),
        )
        headers.append('Set-Cookie', clearPendingCookieValue({ secure }))

        return new Response(DONE_HTML, { status: 200, headers })
      } catch (error) {
        return new Response(
          FAILED_HTML +
            `<p style="color:#b00">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`,
          {
            status: 400,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          },
        )
      }
    },

    /**
     * POST /auth/native/paste —— 远端部署的粘贴回跳（ADR-0017）。
     * body { target, url }：url = 用户从地址栏复制的完整回调 URL（或裸
     * query）；按 state 查 pending cookie（CSRF 与 callback 同一条验证链），
     * target 必须匹配，随后走与 callback 完全相同的 code 交换。
     */
    async handlePaste(request: Request): Promise<Response> {
      let target = ''
      let pasted = ''

      try {
        const body = (await request.json().catch(() => ({}))) as {
          target?: unknown
          url?: unknown
        }
        target = String(body.target ?? '')
        pasted = String(body.url ?? '')
      } catch {
        // JSON 解析失败按空处理（url required 400）。
      }

      if (!pasted) {
        return json(400, { detail: 'url required' })
      }

      const secure = ctx.isHttps(request)

      try {
        const parsed = parsePastedCallback(pasted)
        const pending = store.resolvePending(readPendingCookie(request), parsed.state)

        if (!pending) {
          return json(400, { detail: 'Unknown or expired login state' })
        }

        // target 匹配校验（防把 A 网关的 code 贴到 B 网关的 pending 上）。
        if (target) {
          let normalized = ''
          try {
            normalized = normalizeTargetUrl(target)
          } catch {
            // 非法 target 走 mismatch。
          }
          if (!normalized || normalized !== pending.target) {
            return json(400, { detail: 'target mismatch' })
          }
        }

        const tokenSet = await exchangeCode(store, pending, parsed.code)
        const headers = new Headers({
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        })
        headers.append(
          'Set-Cookie',
          sessionCookieValue(
            oauthSessionCookieName(pending.target),
            encodeSessionCookie(pending.target, tokenSet),
            { secure },
          ),
        )
        headers.append('Set-Cookie', clearPendingCookieValue({ secure }))

        return json(200, { ok: true }, headers)
      } catch (error) {
        return json(400, {
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    },

    handleSession(request: Request): Promise<Response> {
      const url = new URL(request.url)
      const target = url.searchParams.get('target') ?? ''
      const cookieValue =
        parseCookies(request.headers.get('cookie'))[oauthSessionCookieName(target)] ??
        null
      const info = store.sessionInfo(cookieValue, target)

      return Promise.resolve(json(200, info))
    },

    async handleLogout(request: Request): Promise<Response> {
      let target: string | null = null

      try {
        const body = (await request.json().catch(() => ({}))) as { target?: unknown }
        if (typeof body.target === 'string' && body.target.trim()) {
          target = normalizeTargetUrl(body.target)
        }
      } catch {
        return json(400, { detail: 'invalid target' })
      }

      // per-target cookie：有 target 时只清当前 gateway；无 body 保持旧行为，
      // 清掉请求里所有 hermes_oauth_* 会话 cookie（兼容旧客户端）。
      const cookies = parseCookies(request.headers.get('cookie'))
      const secure = ctx.isHttps(request)
      const headers = new Headers({ 'Content-Type': 'application/json' })
      const onlyName = target ? oauthSessionCookieName(target) : null
      for (const name of Object.keys(cookies)) {
        if (
          name.startsWith(SESSION_COOKIE_PREFIX) &&
          (!onlyName || name === onlyName)
        ) {
          headers.append('Set-Cookie', clearSessionCookieValue(name, { secure }))
        }
      }

      return json(200, { ok: true }, headers)
    },
  }
}

// ── 小工具 ─────────────────────────────────────────────────────────────────

/** 与 relay.ts normalizeTarget 相同语义（模块内复用，避免循环依赖）。 */
function normalizeTargetUrl(raw: string): string {
  if (!raw) {
    throw new Error('target required')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Invalid target URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Target URL must be http:// or https://, got ${url.protocol}`)
  }
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/+$/, '')

  return url.toString().replace(/\/+$/, '')
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
