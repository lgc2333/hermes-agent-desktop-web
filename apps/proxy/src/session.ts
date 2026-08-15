/**
 * session.ts — password "dashboard login" 会话中转（M5）。
 *
 * gated gateway 的密码登录（POST /auth/password-login）成功后以 HttpOnly
 * cookie（hermes_session_at/_rt，见上游 dashboard_auth/cookies.py）建立
 * 会话；所有 /api/* 认这个 cookie，WS 拨号先经 POST /api/auth/ws-ticket 换
 * 单次 ticket（?ticket=，gated gateway 拒绝 ?token=）。
 *
 * 浏览器不能替代理持有 gateway 域 cookie（转发是代理发出的服务器到服务器
 * 请求），所以代理在内存保存 cookie jar —— 与 oauth.ts 的 token set 同一
 * 凭证模型（PLAN §6：只存内存、重启失效、零落盘）。浏览器只持有一个
 * httpOnly 会话 cookie（hermes_session，值 = 内存键），指向这个 jar。
 *
 * 协议（对照 hermes 0.19.x dashboard_auth/routes.py 核实）：
 *   POST <target>/auth/password-login  {provider, username, password, next}
 *     → 200 {"ok": true, "next": <path>} + Set-Cookie（at/rt/provider）
 *     → 401 {"detail": "Invalid credentials"} / 429 / 404 / 503
 *   POST <target>/api/auth/ws-ticket  (cookie) → {"ticket", "ttl_seconds"}
 *   POST <target>/auth/logout         (cookie) → 尽力吊销
 *
 * 生命周期：
 *   1. POST /api/proxy/session/login  {target, provider, username, password}
 *      → 代理转发 password-login，捕获 Set-Cookie 存 jar，回发
 *        Set-Cookie: hermes_session=<key>；
 *   2. REST 转发：jar 随请求注入 Cookie 头；gateway 每次响应可能轮换 cookie
 *      （AT 过期用 RT 透明刷新，见 middleware._attempt_refresh）——转发后把
 *      响应 Set-Cookie 合并回 jar；
 *   3. WS 拨号：用 jar 调 ws-ticket 换单次 ticket → ?ticket=；
 *   4. POST /api/proxy/session/logout → 转发 /auth/logout（尽力），清 jar
 *      与浏览器 cookie。
 *
 * 密码本体只经 浏览器 → 代理 → gateway 一跳传输，代理不落盘、不缓存。
 * 代理重启即失效（与 OAuth token set 相同的取舍）：用户重新登录即可。
 *
 * 本模块零依赖纯逻辑（除注入的 postRaw），全部可单测（session_test.ts）。
 */

export const PASSWORD_SESSION_COOKIE = 'hermes_session'

/** postRaw 注入面：返回原始响应信息（Set-Cookie 必须完整捕获）。 */
export interface RawPostResult {
  status: number
  ok: boolean
  /** 响应 Set-Cookie 原始值列表（轮换/登录时捕获）。 */
  setCookies: string[]
  body: unknown
}

export interface SessionDeps {
  /** POST JSON 并返回原始响应信息（生产 = 注入的 proxyPostRaw，redirect 不跟随）。 */
  postRaw: (
    url: string,
    body: unknown,
    headers?: Record<string, string>,
    timeoutMs?: number,
  ) => Promise<RawPostResult>
  /** 时钟（毫秒），测试可控。 */
  now?: () => number
}

/** 一个已完成密码登录的会话（cookie sessionKey → 此条目）。 */
export interface PasswordSessionEntry {
  target: string
  /** 合并后的 Cookie 头值（"name=value; name2=value2"）。 */
  cookieHeader: string
  provider: string
  username: string
  createdAt: number
}

export interface PasswordLoginOutcome {
  ok: boolean
  status: number
  detail: string
  sessionKey?: string
}

export interface PasswordSessionInfo {
  connected: boolean
  provider: string
  username: string
}

const LOGIN_TIMEOUT_MS = 15_000
const WS_TICKET_TIMEOUT_MS = 10_000
const LOGOUT_TIMEOUT_MS = 10_000

// ── 小工具 ─────────────────────────────────────────────────────────────────

function joinBase(baseUrl: string, path: string): string {
  const parsed = new URL(baseUrl)
  const prefix = parsed.pathname.replace(/\/+$/, '')

  return `${parsed.protocol}//${parsed.host}${prefix}${path}`
}

export function passwordLoginUrl(target: string): string {
  return joinBase(target, '/auth/password-login')
}

export function wsTicketUrl(target: string): string {
  return joinBase(target, '/api/auth/ws-ticket')
}

export function authLogoutUrl(target: string): string {
  return joinBase(target, '/auth/logout')
}

/** 高熵会话键（32 随机字节 b64url）。 */
export function generateSessionKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Set-Cookie 原始值列表 → Cookie 头值（取每个 cookie 的 name=value 段）。 */
export function cookiesFromSetCookie(setCookies: string[]): string {
  const parts: string[] = []
  for (const raw of setCookies) {
    const first = raw.split(';')[0]?.trim() ?? ''
    if (first && !parts.includes(first)) {
      parts.push(first)
    }
  }

  return parts.join('; ')
}

/**
 * 合并 Cookie 罐：新 Set-Cookie 按名覆盖旧 jar；`Max-Age=0` / 过期删除的
 * cookie 从 jar 中移除（gateway 轮换时会把旧 cookie 清掉再写新值）。
 */
export function mergeCookieJar(current: string, setCookies: string[]): string {
  const map = new Map<string, string>()
  for (const pair of current.split(';')) {
    const eq = pair.indexOf('=')
    if (eq > 0) {
      map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }
  for (const raw of setCookies) {
    const first = raw.split(';')[0]?.trim() ?? ''
    const eq = first.indexOf('=')
    if (eq <= 0) {
      continue
    }
    const name = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    if (/max-age\s*=\s*0/i.test(raw)) {
      map.delete(name)
    } else {
      map.set(name, value)
    }
  }

  return [...map.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

/** 会话 cookie 的 Set-Cookie 值（HttpOnly + SameSite=Lax，同 oauth.ts）。 */
export function passwordSessionCookieValue(
  sessionKey: string,
  maxAgeSeconds?: number,
): string {
  const parts = [
    `${PASSWORD_SESSION_COOKIE}=${encodeURIComponent(sessionKey)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ]
  parts.push(`Max-Age=${maxAgeSeconds ?? 86400}`)

  return parts.join('; ')
}

/** 清除会话 cookie（登出）。 */
export function clearPasswordSessionCookieValue(): string {
  return passwordSessionCookieValue('', 0)
}

/** 从错误响应体提取 detail（失败形状 {detail: ...}）。 */
function detailOf(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const d = (body as Record<string, unknown>).detail
    if (typeof d === 'string' && d) {
      return d
    }
  }

  return fallback
}

// ── 内存状态存储 ───────────────────────────────────────────────────────────

/**
 * 密码会话中转状态：sessionKey → cookie jar。进程内存、无持久化
 * （PLAN §6：代理不落盘任何凭证；重启即失效）。
 */
export class SessionStore {
  /** sessionKey → 密码会话（httpOnly cookie 指向这里）。 */
  private readonly sessions = new Map<string, PasswordSessionEntry>()

  constructor(readonly deps: SessionDeps) {}

  get size(): number {
    return this.sessions.size
  }

  getEntry(sessionKey: string): PasswordSessionEntry | undefined {
    return this.sessions.get(sessionKey)
  }

  /** 按 cookie sessionKey 查询会话（target 必须匹配，防串连）。 */
  getSession(
    sessionKey: string | null,
    target?: string,
  ): PasswordSessionEntry | undefined {
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

  /**
   * 登录：转发 /auth/password-login；成功时捕获 Set-Cookie 存 jar 并返回
   * 新 sessionKey。失败返回 gateway 的状态与 detail（401 等原样透传）。
   */
  async login(
    target: string,
    provider: string,
    username: string,
    password: string,
  ): Promise<PasswordLoginOutcome> {
    const res = await this.deps.postRaw(
      passwordLoginUrl(target),
      { provider, username, password, next: '' },
      undefined,
      LOGIN_TIMEOUT_MS,
    )

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        detail: detailOf(res.body, `HTTP ${res.status}`),
      }
    }

    const jar = cookiesFromSetCookie(res.setCookies)
    if (!jar) {
      return {
        ok: false,
        status: 502,
        detail: 'Gateway accepted the login but set no session cookie',
      }
    }

    const sessionKey = generateSessionKey()
    this.sessions.set(sessionKey, {
      target,
      cookieHeader: jar,
      provider,
      username,
      createdAt: this.deps.now?.() ?? Date.now(),
    })

    return { ok: true, status: res.status, detail: '', sessionKey }
  }

  /** REST 转发注入：cookie sessionKey + target → jar（Cookie 头值）；无 → null。 */
  cookieFor(sessionKey: string | null, target: string): string | null {
    return this.getSession(sessionKey, target)?.cookieHeader ?? null
  }

  /**
   * 合并 gateway 响应里的新 Set-Cookie 回 jar（AT/RT 轮换）。
   * 无会话 / target 不匹配 → 无操作。
   */
  applySetCookie(
    sessionKey: string | null,
    target: string,
    setCookies: string[],
  ): void {
    if (!setCookies.length) {
      return
    }
    const session = this.getSession(sessionKey, target)
    if (!session) {
      return
    }
    session.cookieHeader = mergeCookieJar(session.cookieHeader, setCookies)
  }

  /** WS 拨号：cookie sessionKey + target → 单次 ws-ticket（失败 → null）。 */
  async wsTicketFor(sessionKey: string | null, target: string): Promise<string | null> {
    const cookie = this.cookieFor(sessionKey, target)
    if (!cookie) {
      return null
    }

    try {
      const res = await this.deps.postRaw(
        wsTicketUrl(target),
        {},
        { cookie },
        WS_TICKET_TIMEOUT_MS,
      )
      // ws-ticket 响应也可能带 cookie 轮换 —— 顺手合并。
      if (res.setCookies.length) {
        this.applySetCookie(sessionKey, target, res.setCookies)
      }
      const body = (res.body ?? {}) as { ticket?: unknown }

      return String(body.ticket ?? '') || null
    } catch {
      return null
    }
  }

  /** 登出：清内存条目；调用方负责把 gateway 的 /auth/logout 转发好。 */
  logout(sessionKey: string): boolean {
    return this.sessions.delete(sessionKey)
  }

  /** 会话状态查询（status 端点回显；永不下发 cookie 本体）。 */
  sessionInfo(sessionKey: string | null, target: string): PasswordSessionInfo {
    const session = this.getSession(sessionKey, target)

    if (!session) {
      return { connected: false, provider: '', username: '' }
    }

    return {
      connected: true,
      provider: session.provider,
      username: session.username,
    }
  }
}

// ── 端点处理器（main.ts 集成；cookie 读写由调用方传入）──────────────────────

export interface SessionHandlerContext {
  /** 从请求读取 hermes_session cookie 值；null 表示无。 */
  readSessionKey: (request: Request) => string | null
}

export interface SessionEndpoints {
  /** POST /api/proxy/session/login —— 密码登录；成功 Set-Cookie 会话键。 */
  handleLogin: (request: Request) => Promise<Response>
  /** POST /api/proxy/session/logout —— 清 jar + 清 cookie。 */
  handleLogout: (request: Request) => Promise<Response>
  /** GET /api/proxy/session/status —— 连接状态（cookie + ?target=）。 */
  handleStatus: (request: Request) => Promise<Response>
}

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

/** 与 oauth.ts / relay.ts 相同语义的目标规范化（模块内复用）。 */
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

/**
 * 组装密码会话端点。`postRaw` 由调用方注入（生产 = main.ts 的
 * proxyPostRaw，redirect: 'manual' 以捕获 Set-Cookie）。
 */
export function createSessionEndpoints(
  store: SessionStore,
  ctx: SessionHandlerContext,
): SessionEndpoints {
  const readTarget = (body: unknown): string => {
    const target = String((body as { target?: unknown })?.target ?? '')
    if (!target) {
      throw new Error('target required')
    }

    return normalizeTargetUrl(target)
  }

  return {
    async handleLogin(request: Request): Promise<Response> {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const provider = String(body.provider ?? '')
      const username = String(body.username ?? '')
      const password = String(body.password ?? '')

      if (!provider || !username || !password) {
        return json(400, { detail: 'provider, username and password are required' })
      }

      let target: string
      try {
        target = readTarget(body)
      } catch (error) {
        return json(400, {
          detail: error instanceof Error ? error.message : String(error),
        })
      }

      try {
        const outcome = await store.login(target, provider, username, password)

        if (!outcome.ok || !outcome.sessionKey) {
          return json(outcome.status, { detail: outcome.detail })
        }

        return json(
          200,
          { ok: true },
          { 'Set-Cookie': passwordSessionCookieValue(outcome.sessionKey) },
        )
      } catch (error) {
        return json(500, {
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    },

    async handleLogout(request: Request): Promise<Response> {
      const sessionKey = ctx.readSessionKey(request)
      const entry = sessionKey ? store.getEntry(sessionKey) : undefined

      if (entry && sessionKey) {
        store.logout(sessionKey)
        // 尽力转发 /auth/logout（gateway 吊销 refresh token）；失败不阻塞。
        try {
          await store.deps.postRaw(
            authLogoutUrl(entry.target),
            {},
            { cookie: entry.cookieHeader },
            LOGOUT_TIMEOUT_MS,
          )
        } catch {
          // best-effort
        }
      }

      return json(
        200,
        { ok: true },
        { 'Set-Cookie': clearPasswordSessionCookieValue() },
      )
    },

    handleStatus(request: Request): Promise<Response> {
      const url = new URL(request.url)
      const target = url.searchParams.get('target') ?? ''
      const info = store.sessionInfo(ctx.readSessionKey(request), target)

      return Promise.resolve(json(200, info))
    },
  }
}
