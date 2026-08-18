/**
 * session.ts — password "dashboard login" 会话中转（M5），ADR-0023 凭证模型。
 *
 * gated gateway 的密码登录（POST /auth/password-login）成功后以 HttpOnly
 * cookie（hermes_session_at/_rt，见上游 dashboard_auth/cookies.py）建立
 * 会话；所有 /api/* 认这个 cookie，WS 拨号先经 POST /api/auth/ws-ticket 换
 * 单次 ticket（?ticket=，gated gateway 拒绝 ?token=）。
 *
 * 浏览器不能替代理持有 gateway 域 cookie（转发是代理发出的服务器到服务器
 * 请求），所以代理捕获 jar 后**编码进浏览器 httpOnly cookie**（代理域，
 * `hermes_session_<targetHash>`，per-target，ADR-0023）——与 oauth.ts 的
 * token set 同一凭证模型：代理进程零凭证内存态、零落盘、重启后从浏览器
 * cookie 无感恢复。
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
 *      → 代理转发 password-login，捕获 Set-Cookie 编码进 jar cookie 写回
 *        浏览器（hermes_session_<hash>）；
 *   2. REST 转发：从请求 jar cookie 解码注入 Cookie 头；gateway 每次响应
 *      可能轮换 cookie（AT 过期用 RT 透明刷新，见 middleware._attempt_refresh）
 *      ——响应 Set-Cookie 合并回 jar，重新编码成新 cookie 值随响应写回；
 *   3. WS 拨号：用 jar 调 ws-ticket 换单次 ticket → ?ticket=；
 *   4. POST /api/proxy/session/logout → 转发 /auth/logout（尽力），清
 *      jar cookie。
 *
 * 密码本体只经 浏览器 → 代理 → gateway 一跳传输，代理不落盘、不缓存。
 * 代理重启无感恢复（jar 在浏览器 cookie，ADR-0023）。
 *
 * 本模块零依赖纯逻辑（除注入的 postRaw），全部可单测（session_test.ts）。
 */

import { targetHash } from './oauth.ts'

/** jar cookie 名前缀：`hermes_session_<targetHash>`（per-target，ADR-0023）。 */
export const PASSWORD_SESSION_COOKIE_PREFIX = 'hermes_session_'
/** 会话 cookie Max-Age（30 天，对齐上游 RT cookie TTL）。 */
export const PASSWORD_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
/** 单 cookie 值上限（同 oauth.ts 决策 6）。 */
const MAX_COOKIE_VALUE_CHARS = 3500

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

/** 一个已完成密码登录的会话（编码进 jar cookie）。 */
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
  /** 成功时：编码后的 jar cookie 值（调用方 Set-Cookie 下发）。 */
  jarValue?: string
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

// ── jar cookie 编解码（ADR-0023）───────────────────────────────────────────

interface JarCookiePayload {
  v: 1
  t: string // target
  c: string // cookieHeader
  p: string // provider
  u: string // username
  ts: number // createdAt
}

/** 密码会话 cookie 名：`hermes_session_<targetHash>`。 */
export function passwordSessionCookieName(target: string): string {
  return `${PASSWORD_SESSION_COOKIE_PREFIX}${targetHash(target)}`
}

/** 编码会话条目 → cookie 值（base64url(JSON)，target 内嵌防串连）。 */
export function encodeJarCookie(target: string, entry: PasswordSessionEntry): string {
  const payload: JarCookiePayload = {
    v: 1,
    t: target,
    c: entry.cookieHeader,
    p: entry.provider,
    u: entry.username,
    ts: entry.createdAt,
  }
  const value = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  if (value.length > MAX_COOKIE_VALUE_CHARS) {
    throw new Error(
      `Session cookie too large (${value.length} chars > ${MAX_COOKIE_VALUE_CHARS}): ` +
        'gateway issued an unusually long session cookie set',
    )
  }

  return value
}

/** 解码 cookie 值 → { target, entry }；非法/版本不符 → null。 */
export function decodeJarCookie(value: string): {
  target: string
  entry: PasswordSessionEntry
} | null {
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(b64urlDecode(value)),
    ) as Partial<JarCookiePayload>
    if (payload.v !== 1 || typeof payload.t !== 'string' || !payload.c) {
      return null
    }

    return {
      target: payload.t,
      entry: {
        target: payload.t,
        cookieHeader: payload.c,
        provider: payload.p ?? '',
        username: payload.u ?? '',
        createdAt: Number(payload.ts) || 0,
      },
    }
  } catch {
    return null
  }
}

/** 会话 cookie 的 Set-Cookie 值（HttpOnly + SameSite=Lax；Secure 生产加）。 */
export function passwordSessionCookieValue(
  name: string,
  value: string,
  opts: { maxAgeSeconds?: number; secure?: boolean } = {},
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${opts.maxAgeSeconds ?? PASSWORD_SESSION_MAX_AGE_SECONDS}`,
  ]
  if (opts.secure) {
    parts.push('Secure')
  }

  return parts.join('; ')
}

/** 清除会话 cookie（登出）。 */
export function clearPasswordSessionCookieValue(
  name: string,
  opts: { secure?: boolean } = {},
): string {
  return passwordSessionCookieValue(name, '', { maxAgeSeconds: 0, secure: opts.secure })
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

// ── 无状态密码会话中转（jar 在浏览器 cookie，ADR-0023）─────────────────────

/**
 * 密码会话中转逻辑：零凭证内存态。jar 编码在浏览器 cookie（`hermes_session_
 * <targetHash>`），解码值经参数进出。
 */
export class SessionStore {
  constructor(readonly deps: SessionDeps) {}

  /**
   * 登录：转发 /auth/password-login；成功时捕获 Set-Cookie 编码成 jar
   * cookie 值返回。失败返回 gateway 的状态与 detail（401 等原样透传）。
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

    const entry: PasswordSessionEntry = {
      target,
      cookieHeader: jar,
      provider,
      username,
      createdAt: this.deps.now?.() ?? Date.now(),
    }

    return {
      ok: true,
      status: res.status,
      detail: '',
      jarValue: encodeJarCookie(target, entry),
    }
  }

  /** REST 转发注入：解码 jar cookie → Cookie 头值；无/不匹配 → null。 */
  cookieFor(cookieValue: string | null, target: string): string | null {
    return this.entryFromCookie(cookieValue, target)?.entry.cookieHeader ?? null
  }

  /**
   * 合并 gateway 响应里的新 Set-Cookie 回 jar（AT/RT 轮换），返回重新编码
   * 的新 cookie 值（调用方 Set-Cookie 写回浏览器）。无会话 / target 不匹配
   * / 无变化 → null（不写回）。
   */
  applySetCookie(
    cookieValue: string | null,
    target: string,
    setCookies: string[],
  ): string | null {
    if (!setCookies.length) {
      return null
    }
    const decoded = this.entryFromCookie(cookieValue, target)
    if (!decoded) {
      return null
    }
    const merged = mergeCookieJar(decoded.entry.cookieHeader, setCookies)
    if (merged === decoded.entry.cookieHeader) {
      return null
    }

    return encodeJarCookie(target, {
      ...decoded.entry,
      cookieHeader: merged,
    })
  }

  /** WS 拨号：解码 jar → 单次 ws-ticket（失败 → null）。 */
  async wsTicketFor(
    cookieValue: string | null,
    target: string,
  ): Promise<{ ticket: string | null; setCookie: string | null }> {
    const decoded = this.entryFromCookie(cookieValue, target)
    if (!decoded) {
      return { ticket: null, setCookie: null }
    }

    try {
      const res = await this.deps.postRaw(
        wsTicketUrl(target),
        {},
        { cookie: decoded.entry.cookieHeader },
        WS_TICKET_TIMEOUT_MS,
      )
      // ws-ticket 响应也可能带 cookie 轮换 —— 合并成写回值。
      const setCookie = this.applySetCookie(cookieValue, target, res.setCookies)
      const body = (res.body ?? {}) as { ticket?: unknown }

      return { ticket: String(body.ticket ?? '') || null, setCookie }
    } catch {
      return { ticket: null, setCookie: null }
    }
  }

  /** 登出：尽力转发 gateway /auth/logout（吊销 refresh token），失败不抛。 */
  async logout(cookieValue: string | null, target: string): Promise<boolean> {
    const decoded = this.entryFromCookie(cookieValue, target)
    if (!decoded) {
      return false
    }

    try {
      await this.deps.postRaw(
        authLogoutUrl(target),
        {},
        { cookie: decoded.entry.cookieHeader },
        LOGOUT_TIMEOUT_MS,
      )
    } catch {
      // best-effort
    }

    return true
  }

  /** 会话状态查询（status 端点回显；永不下发 cookie 本体）。 */
  sessionInfo(cookieValue: string | null, target: string): PasswordSessionInfo {
    const decoded = this.entryFromCookie(cookieValue, target)

    if (!decoded) {
      return { connected: false, provider: '', username: '' }
    }

    return {
      connected: true,
      provider: decoded.entry.provider,
      username: decoded.entry.username,
    }
  }

  /** 从 cookie 值解码条目（target 内嵌校验，防串连）。 */
  private entryFromCookie(
    cookieValue: string | null,
    target: string,
  ): { target: string; entry: PasswordSessionEntry } | null {
    if (!cookieValue) {
      return null
    }
    const decoded = decodeJarCookie(cookieValue)
    if (!decoded || decoded.target !== target) {
      return null
    }

    return decoded
  }
}

// ── 端点处理器（main.ts 集成；cookie 读写由调用方传入）──────────────────────

export interface SessionHandlerContext {
  /** 请求是否为 HTTPS（生产自动加 Secure cookie 标志，ADR-0023）。 */
  isHttps: (request: Request) => boolean
}

export interface SessionEndpoints {
  /** POST /api/proxy/session/login —— 密码登录；成功 Set-Cookie 编码 jar。 */
  handleLogin: (request: Request) => Promise<Response>
  /** POST /api/proxy/session/logout —— 尽力转发登出 + 清 jar cookie。 */
  handleLogout: (request: Request) => Promise<Response>
  /** GET /api/proxy/session/status —— 连接状态（cookie + ?target=）。 */
  handleStatus: (request: Request) => Promise<Response>
}

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

/** 读取请求中所有 hermes_session_* 前缀 cookie 的 name=value 对。 */
function readSessionCookies(request: Request): Record<string, string> {
  const out: Record<string, string> = {}
  const cookies = request.headers.get('cookie') ?? ''
  for (const part of cookies.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) {
      continue
    }
    const name = part.slice(0, eq).trim()
    if (name.startsWith(PASSWORD_SESSION_COOKIE_PREFIX)) {
      out[name] = part.slice(eq + 1).trim()
    }
  }

  return out
}

/**
 * 组装密码会话端点。`postRaw` 由调用方注入（生产 = main.ts 的
 * proxyPostRaw，redirect: 'manual' 以捕获 Set-Cookie）。
 */
export function createSessionEndpoints(
  store: SessionStore,
  ctx: SessionHandlerContext,
  opts: {
    /** 目标白名单（ADR-0015）：返回 false 时 login 拒绝 403。 */
    allowTarget?: (target: string) => boolean
  } = {},
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

      // 目标白名单（ADR-0015）：login 会向该 target 转发密码，必须限定。
      if (opts.allowTarget && !opts.allowTarget(target)) {
        return json(403, { detail: 'target not allowed' })
      }

      try {
        const outcome = await store.login(target, provider, username, password)

        if (!outcome.ok || !outcome.jarValue) {
          return json(outcome.status, { detail: outcome.detail })
        }

        const secure = ctx.isHttps(request)

        return json(
          200,
          { ok: true },
          {
            'Cache-Control': 'no-store',
            'Set-Cookie': passwordSessionCookieValue(
              passwordSessionCookieName(target),
              outcome.jarValue,
              { secure },
            ),
          },
        )
      } catch (error) {
        return json(500, {
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    },

    async handleLogout(request: Request): Promise<Response> {
      const sessionCookies = readSessionCookies(request)
      const secure = ctx.isHttps(request)
      const headers = new Headers({ 'Content-Type': 'application/json' })

      // 尽力转发 gateway /auth/logout（吊销 refresh token）；失败不阻塞。
      for (const [name, value] of Object.entries(sessionCookies)) {
        const decoded = decodeJarCookie(value)
        if (decoded) {
          try {
            await store.logout(value, decoded.target)
          } catch {
            // best-effort
          }
        }
        headers.append('Set-Cookie', clearPasswordSessionCookieValue(name, { secure }))
      }

      return Promise.resolve(json(200, { ok: true }, headers))
    },

    handleStatus(request: Request): Promise<Response> {
      const url = new URL(request.url)
      const target = url.searchParams.get('target') ?? ''
      const cookieValue =
        readSessionCookies(request)[passwordSessionCookieName(target)] ?? null
      const info = store.sessionInfo(cookieValue, target)

      return Promise.resolve(json(200, info))
    },
  }
}
