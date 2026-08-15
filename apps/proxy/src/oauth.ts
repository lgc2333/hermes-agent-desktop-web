/**
 * oauth.ts — M3 native PKCE 中转（RFC 8252 / RFC 7636）。
 *
 * 浏览器侧完成 OAuth 登录（gateway 的 `/auth/native/*` 面，Hermes
 * Cloud/Privy 由 gateway 的 auth_flows 自动适配），代理负责：
 *
 *   1. `/auth/native/start`    —— 生成 PKCE pair + state，构建 gateway
 *      authorize URL 返回给浏览器（浏览器开新窗口导航过去）；
 *   2. `/auth/native/callback` —— gateway 完成授权后 302 回代理（redirect_uri
 *      指向代理 origin）；代理校验 state（CSRF），用 code + verifier 换
 *      token set，存进程内存，并 Set-Cookie httpOnly 会话；
 *   3. `/auth/native/session`  —— 浏览器带 cookie 查询连接状态（不暴露
 *      token 本体，只回显 provider/userId/过期时间/前 4 位预览）；
 *   4. `/auth/native/logout`   —— 清内存 token set + 清 cookie。
 *
 * 凭证生命周期：token set 只存在于代理进程内存（重启即失效，PLAN §6 无
 * 持久化），浏览器只持有一个 httpOnly session cookie（值 = 内存键）。
 * 转发面（relay.ts / main.ts）在 REST 前注入 `Authorization: Bearer`、在
 * WS 拨号前经 `POST /api/auth/ws-ticket` 换单次 ticket（gated gateway 拒绝
 * `?token=`，见 dashboard_auth/ws_tickets.py）。token 过期前自动经
 * `/auth/native/refresh` 轮换；refresh 失败（401 session_expired）清除会话。
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
 * 已知限制（M4 部署处理）：真 gateway 校验 redirect_uri 必须是 loopback
 * （127.0.0.1/::1，见 native_flow 的 _validate_loopback_redirect_uri），因此
 * dev 拓扑（代理与浏览器同机）开箱即用；代理在远端服务器时需 gateway 侧
 * 放宽或用 WEB_OAUTH_REDIRECT_URI 覆盖（若 gateway 接受非 loopback）。
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

/** 一次进行中的登录（start 到 callback 之间）。 */
export interface PendingLogin {
  target: string
  verifier: string
  redirectUri: string
  sessionKey: string
  createdAt: number
}

/** 一个已完成的 OAuth 会话（cookie sessionKey → 此条目）。 */
export interface OAuthSession {
  target: string
  tokenSet: NativeTokenSet
  createdAt: number
}

export interface OAuthStartResult {
  /** gateway authorize URL（浏览器新窗口导航）。 */
  authorizeUrl: string
  /** 会话键，后续查询用（浏览器不直接持有；调试用）。 */
  sessionKey: string
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

// ── PKCE / 随机数（Web Crypto，Deno 原生）──────────────────────────────────

function b64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
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

/** 高熵会话键（32 随机字节 b64url）。 */
export function generateSessionKey(): string {
  return b64urlEncode(randomBytes(32))
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
  const error = parsed.searchParams.get('error')

  if (error) {
    const desc = parsed.searchParams.get('error_description') || ''
    throw new Error(
      `Gateway rejected native login: ${error}${desc ? ` (${desc})` : ''}`,
    )
  }

  const code = parsed.searchParams.get('code') || ''
  const state = parsed.searchParams.get('state') || ''

  if (!code) {
    throw new Error('Native callback missing authorization code')
  }

  if (!expectedState || state !== expectedState) {
    throw new Error('Native callback state mismatch (possible CSRF)')
  }

  return { code }
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

// ── Cookie 工具 ────────────────────────────────────────────────────────────

export const SESSION_COOKIE_NAME = 'hermes_oauth_session'

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

/**
 * 会话 cookie 的 Set-Cookie 值。HttpOnly（浏览器 JS 不可读）+ SameSite=Lax
 * （同站 127.0.0.1 跨端口 / 生产同源都携带；跨站不发送）。
 */
export function sessionCookieValue(sessionKey: string, maxAgeSeconds?: number): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionKey)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${maxAgeSeconds}`)
  } else {
    parts.push('Max-Age=86400')
  }

  return parts.join('; ')
}

/** 清除会话 cookie（登出）。 */
export function clearSessionCookieValue(): string {
  return sessionCookieValue('', 0)
}

// ── 内存状态存储 ───────────────────────────────────────────────────────────

/**
 * OAuth 中转状态：pending（进行中登录）与 sessions（已完成会话）。
 * 进程内存、无持久化（PLAN §6：代理不落盘任何凭证）。
 */
export class OAuthStore {
  /** state → PendingLogin（callback 校验 CSRF 用）。 */
  private readonly pending = new Map<string, PendingLogin>()
  /** sessionKey → OAuthSession（httpOnly cookie 指向这里）。 */
  private readonly sessions = new Map<string, OAuthSession>()
  /** sessionKey → 进行中的 refresh promise（并发去重）。 */
  private readonly refreshing = new Map<string, Promise<NativeTokenSet | null>>()

  constructor(readonly deps: OAuthDeps) {}

  get pendingCount(): number {
    return this.pending.size
  }

  get sessionCount(): number {
    return this.sessions.size
  }

  /** start：生成 PKCE/state，登记 pending，返回 authorize URL + sessionKey。 */
  async begin(
    target: string,
    redirectUri: string,
    provider?: string,
  ): Promise<OAuthStartResult> {
    const { verifier, challenge } = await generatePkcePair()
    const state = generateState()
    const sessionKey = generateSessionKey()
    this.pending.set(state, {
      target,
      verifier,
      redirectUri,
      sessionKey,
      createdAt: Date.now(),
    })
    const authorizeUrl = nativeAuthorizeUrl(target, {
      challenge,
      redirectUri,
      state,
      provider,
    })

    return { authorizeUrl, sessionKey }
  }

  /** 取出 pending（不消费；callback 完成或失败后由调用方删除）。 */
  getPending(state: string): PendingLogin | undefined {
    const entry = this.pending.get(state)
    if (entry && Date.now() - entry.createdAt > DEFAULT_PENDING_TTL_MS) {
      this.pending.delete(state)

      return undefined
    }

    return entry
  }

  removePending(state: string): void {
    this.pending.delete(state)
  }

  /** callback 换到 token 后落库。 */
  storeSession(sessionKey: string, target: string, tokenSet: NativeTokenSet): void {
    this.sessions.set(sessionKey, { target, tokenSet, createdAt: Date.now() })
  }

  /** 按 cookie sessionKey 查询会话（target 必须匹配，防串连）。 */
  getSession(sessionKey: string | null, target?: string): OAuthSession | undefined {
    if (!sessionKey) {
      return undefined
    }

    const session = this.sessions.get(sessionKey)

    if (!session) {
      return undefined
    }

    if (target !== undefined && session.target !== target) {
      return undefined
    }

    return session
  }

  logout(sessionKey: string): boolean {
    return this.sessions.delete(sessionKey)
  }

  // ── 转发面辅助 ───────────────────────────────────────────────────────────

  /**
   * REST 转发注入：cookie sessionKey + 目标 target → access token（需要时
   * 先刷新）。无会话 / target 不匹配 / 刷新失败 → null（调用方不注入）。
   */
  async bearerFor(sessionKey: string | null, target: string): Promise<string | null> {
    if (!sessionKey) {
      return null
    }

    const session = this.getSession(sessionKey, target)

    if (!session) {
      return null
    }

    const now = this.deps.now ? this.deps.now() : Math.floor(Date.now() / 1000)
    const skew = this.deps.refreshSkewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS

    if (!tokenNeedsRefresh(session.tokenSet.expiresAt, now, skew)) {
      return session.tokenSet.accessToken
    }

    const fresh = await this.refresh(sessionKey, session)

    return fresh ? fresh.accessToken : null
  }

  /** WS 拨号：cookie sessionKey + target → 单次 ws-ticket（mint 失败 → null）。 */
  async wsTicketFor(sessionKey: string | null, target: string): Promise<string | null> {
    const accessToken = await this.bearerFor(sessionKey, target)

    if (!accessToken) {
      return null
    }

    try {
      const body = (await this.deps.postJson(
        wsTicketUrl(target),
        {},
        {
          timeoutMs: WS_TICKET_TIMEOUT_MS,
          headers: { authorization: `Bearer ${accessToken}` },
        },
      )) as { ticket?: unknown }
      const ticket = String(body?.ticket ?? '')

      return ticket || null
    } catch {
      return null
    }
  }

  /** 会话状态查询（session 端点回显；永不下发 token 本体）。 */
  sessionInfo(sessionKey: string | null, target: string): OAuthSessionInfo {
    const session = this.getSession(sessionKey, target)

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

  /** 刷新（并发去重）：成功更新内存并返回新 token set；失败清会话。 */
  private refresh(
    sessionKey: string,
    session: OAuthSession,
  ): Promise<NativeTokenSet | null> {
    const inflight = this.refreshing.get(sessionKey)
    if (inflight) {
      return inflight
    }

    const run = async (): Promise<NativeTokenSet | null> => {
      try {
        const body = (await this.deps.postJson(
          nativeRefreshUrl(session.target),
          {
            refresh_token: session.tokenSet.refreshToken,
            provider: session.tokenSet.provider,
          },
          { timeoutMs: TOKEN_EXCHANGE_TIMEOUT_MS },
        )) as Record<string, unknown>

        if (body && typeof body === 'object' && body.error === 'session_expired') {
          // gateway 判定 refresh 失效（401）→ 会话作废，浏览器下次查询看到未连接。
          this.sessions.delete(sessionKey)

          return null
        }

        const fresh = parseTokenResponse(body)
        this.sessions.set(sessionKey, {
          target: session.target,
          tokenSet: fresh,
          createdAt: session.createdAt,
        })

        return fresh
      } catch {
        this.sessions.delete(sessionKey)

        return null
      } finally {
        this.refreshing.delete(sessionKey)
      }
    }

    const promise = run()
    this.refreshing.set(sessionKey, promise)

    return promise
  }
}

// ── 端点处理器（main.ts 集成；cookie 读写由调用方传入）──────────────────────

export interface OauthHandlerContext {
  /** 从请求读取会话 cookie 值；null 表示无。 */
  readSessionKey: (request: Request) => string | null
}

export interface OauthEndpoints {
  /** POST /auth/native/start —— 浏览器 fetch；返回 { authorizeUrl }。 */
  handleStart: (request: Request) => Promise<Response>
  /** GET /auth/native/callback —— gateway 回跳；Set-Cookie + 完成页。 */
  handleCallback: (request: Request) => Promise<Response>
  /** GET /auth/native/session —— 状态查询（cookie + ?target=）。 */
  handleSession: (request: Request) => Promise<Response>
  /** POST /auth/native/logout —— 清会话 + 清 cookie。 */
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
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}

/**
 * 组装 OAuth 端点。`origin` = 代理对外 origin（redirect_uri 基址）；
 * `redirectUriOverride`（env WEB_OAUTH_REDIRECT_URI）可覆盖（部署场景）。
 */
export function createOauthEndpoints(
  store: OAuthStore,
  ctx: OauthHandlerContext,
  opts: {
    origin: (request: Request) => string
    redirectUriOverride?: () => string
    /** 目标白名单（ADR-0015）：返回 false 时 start 拒绝 403。 */
    allowTarget?: (target: string) => boolean
  } = {
    origin: () => '',
  },
): OauthEndpoints {
  const redirectUriFor = (request: Request): string => {
    const override = opts.redirectUriOverride?.()
    if (override && override.trim()) {
      return override.trim()
    }

    return `${opts.origin(request)}/auth/native/callback`
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
        const { authorizeUrl } = await store.begin(normalized, redirectUriFor(request))

        return json(200, { authorizeUrl })
      } catch (error) {
        return json(500, {
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    },

    async handleCallback(request: Request): Promise<Response> {
      const url = new URL(request.url)
      const state = url.searchParams.get('state') ?? ''
      const pending = store.getPending(state)

      if (!pending) {
        return new Response(FAILED_HTML, {
          status: 400,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      }

      try {
        const { code } = parseCallback(url.pathname + url.search, state)
        // code 有 TTL（gateway 侧 120s），callback 到交换之间的窗口足够；
        // 交换失败清掉 pending（code 单次使用，重试无意义）。
        const body = await store.deps.postJson(
          nativeTokenUrl(pending.target),
          { code, code_verifier: pending.verifier },
          { timeoutMs: TOKEN_EXCHANGE_TIMEOUT_MS },
        )
        const tokenSet = parseTokenResponse(body)
        store.storeSession(pending.sessionKey, pending.target, tokenSet)
        store.removePending(state)

        return new Response(DONE_HTML, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Set-Cookie': sessionCookieValue(pending.sessionKey),
          },
        })
      } catch (error) {
        store.removePending(state)

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

    handleSession(request: Request): Promise<Response> {
      const url = new URL(request.url)
      const target = url.searchParams.get('target') ?? ''
      const info = store.sessionInfo(ctx.readSessionKey(request), target)

      return Promise.resolve(json(200, info))
    },

    handleLogout(request: Request): Promise<Response> {
      const sessionKey = ctx.readSessionKey(request)

      if (sessionKey) {
        store.logout(sessionKey)
      }

      return Promise.resolve(
        json(200, { ok: true }, { 'Set-Cookie': clearSessionCookieValue() }),
      )
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
