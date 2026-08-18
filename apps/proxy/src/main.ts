/**
 * main.ts — M2/M3 薄代理入口（Deno 零依赖）。单 handler 多分支（PLAN §6）：
 *   1) 静态资源：GET 且 WEB_DIST 中存在该文件 → SPA 产物（含 fallback）；
 *   2) OAuth 面：/auth/native/{start,callback,session,logout}（M3，见 oauth.ts）；
 *   3) /api/proxy/meta：默认 gateway URL + allowedTargets 下发（M3/M6）；
 *   4) 访问控制：WEB_PROXY_ALLOWED_TARGETS 配置后只向名单内 gateway 出站
 *      （REST/WS/OAuth start/密码 login 四面，拒绝 403，ADR-0015）；
 *   5) 其余全部转发：REST 透传（X-Hermes-Target 头）或 WS 中继
 *      （/api/ws?target=<encoded gateway url>）。
 *
 * M3 OAuth 集成：OAuth 会话存在时（per-target httpOnly cookie
 * `hermes_oauth_<hash>`，ADR-0023），REST 转发注入 Authorization: Bearer，
 * WS 拨号先 mint 单次 ticket。
 * 凭证模型（ADR-0023）：OAuth token set / 密码 jar 编码进浏览器 httpOnly
 * cookie（per-target，Max-Age=30d），代理进程零凭证内存态、零落盘、
 * 重启无感恢复；网关域 Set-Cookie 不透传，轮换经代理域 cookie 写回。
 *
 * Usage:  deno run --allow-net --allow-read --allow-env src/main.ts
 * Env:    PORT           代理端口（默认 6722，用户手改；dev.mjs 同步）
 *         HOST           监听地址（默认 127.0.0.1）
 *         WEB_DIST       静态目录（默认 <repo>/apps/web/dist；不存在则静态面为空）
 *         WEB_PROXY_ALLOWED_TARGETS  出站目标白名单（逗号分隔，空=不限；
 *                            支持 *. 子域通配；公网部署必配；本地 dev 留空）
 *         WEB_DEFAULT_GATEWAY_URL  经 /api/proxy/meta 下发的默认 gateway URL
 *         WEB_OAUTH_REDIRECT_URI   OAuth redirect_uri 覆盖（部署场景）
 */
import {
  createOauthEndpoints,
  oauthSessionCookieName,
  OAuthStore,
  parseCookies,
  sessionCookieValue,
} from './oauth.ts'
import {
  dialUpstreamWs,
  mediaStreamUpstreamRequest,
  normalizeTarget,
  parseAllowedTargets,
  relayRest,
  relayWs,
  targetAllowed,
} from './relay.ts'
import {
  createSessionEndpoints,
  passwordSessionCookieName,
  passwordSessionCookieValue,
  SessionStore,
  type RawPostResult,
} from './session.ts'

export interface ProxyOptions {
  /** 静态托管根目录（file:// URL 或路径字符串）；不存在则静态面为空。 */
  webDist?: string
  /** 出站目标白名单（WEB_PROXY_ALLOWED_TARGETS；空 = 不限）。 */
  allowedTargets?: string[]
  /** /api/proxy/meta 下发的默认 gateway URL（生产 compose env）。 */
  defaultGatewayUrl?: string
  /** OAuth redirect_uri 覆盖（部署场景；默认 = loopback 字面量，ADR-0017）。 */
  oauthRedirectUri?: string
  /** 代理监听端口（loopback redirect_uri 基址；默认 6722，ADR-0017）。 */
  oauthLoopbackPort?: number
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * CORS（dev 跨源 / 生产同源都无害）。M3 起凭证走 httpOnly cookie，
 * fetch 需 credentials: include → 有 Origin 的跨源请求必须回显 Origin +
 * Allow-Credentials（`*` 与 credentials 不能共存）。无 Origin（同源导航/
 * 非浏览器）保持 `*`。
 */
function corsHeaders(request: Request | null = null): Record<string, string> {
  const origin = request?.headers.get('origin')

  if (origin) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      // credentials 模式下通配符 * 不匹配（Fetch 规范）——回显预检请求头。
      'Access-Control-Allow-Headers':
        request?.headers.get('access-control-request-headers') ??
        'x-hermes-target, x-hermes-session-token, content-type, authorization',
      Vary: 'Origin',
    }
  }

  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  }
}

function jsonResponse(status: number, body: unknown, request?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  })
}

/** 给响应补 CORS 头（转发响应 / OAuth 响应统一处理）。 */
function withCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(corsHeaders(request))) {
    headers.set(key, value)
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function isWsUpgrade(request: Request): boolean {
  return (request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket'
}

/** 请求是否为 HTTPS（Secure cookie 标志；X-Forwarded-Proto 反代场景兜底）。 */
function isHttpsRequest(request: Request): boolean {
  const fwd = request.headers.get('x-forwarded-proto')
  if (fwd === 'https') {
    return true
  }

  return new URL(request.url).protocol === 'https:'
}

/** 从请求 Cookie 读 per-target OAuth 会话值（ADR-0023）。 */
function readOauthCookie(request: Request, target: string): string | null {
  return parseCookies(request.headers.get('cookie'))[oauthSessionCookieName(target)] ?? null
}

/** 从请求 Cookie 读 per-target 密码 jar 值（ADR-0023）。 */
function readPasswordCookie(request: Request, target: string): string | null {
  return parseCookies(request.headers.get('cookie'))[passwordSessionCookieName(target)] ?? null
}

/** 静态分支：文件存在 → 返回；不存在 → null（调用方决定 fallback）。 */
async function serveStatic(request: Request, webDist: URL): Promise<Response | null> {
  const url = new URL(request.url)

  // 只服务 GET/HEAD；/api/ 与 /auth/ 前缀绝不进静态面（转发面与 OAuth
  // 免检面在静态分支之后，SPA fallback 不能吞掉它们——M4 生产测试抓出：
  // webDist 指向真实 dist 后 /auth/native/* 被 fallback 成 index.html）。
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return null
  }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
    return null
  }

  // 防路径穿越：拒绝含 .. 的段。
  if (url.pathname.split('/').includes('..')) {
    return jsonResponse(403, { detail: 'forbidden path' }, request)
  }

  const candidate = new URL(url.pathname.slice(1), webDist)
  let file: URL | null = null

  try {
    const info = await Deno.stat(candidate)
    if (info.isFile) {
      file = candidate
    } else if (info.isDirectory) {
      const index = new URL('index.html', candidate)
      const idxInfo = await Deno.stat(index).catch(() => null)
      if (idxInfo?.isFile) {
        file = index
      }
    }
  } catch {
    file = null
  }

  if (!file) {
    // SPA fallback：非 API 路径 → index.html（若存在）。
    const index = new URL('index.html', webDist)
    try {
      const info = await Deno.stat(index)
      if (!info.isFile) {
        return null
      }
    } catch {
      return null
    }
    file = index
  }

  const data = await Deno.readFile(file)
  const ext = file.pathname.slice(file.pathname.lastIndexOf('.')).toLowerCase()

  return new Response(data, {
    status: 200,
    headers: {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control':
        ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
      ...corsHeaders(request),
    },
  })
}

/** 生产 postJson（服务器到服务器，OAuthStore 注入面）。 */
async function proxyPostJson(
  url: string,
  body: unknown,
  opts?: { timeoutMs?: number; headers?: Record<string, string> },
): Promise<unknown> {
  const controller = new AbortController()
  const timer = opts?.timeoutMs
    ? setTimeout(() => controller.abort(), opts.timeoutMs)
    : undefined
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...opts?.headers },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'manual',
    })
    const text = await res.text()

    if (!text) {
      return {}
    }

    try {
      const parsed = JSON.parse(text)
      // 非 2xx 也返回解析后的 body（refresh 的 401 { error: session_expired }
      // 由 OAuthStore 判定；其余让调用方抛错）。
      if (!res.ok && !(parsed && typeof parsed === 'object')) {
        throw new Error(`upstream ${url} -> HTTP ${res.status}`)
      }

      return parsed
    } catch {
      throw new Error(`upstream ${url} -> HTTP ${res.status}`)
    }
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

/**
 * 生产 postRaw（服务器到服务器，SessionStore 注入面）：与 proxyPostJson
 * 同形，但返回原始响应信息（Set-Cookie 完整捕获，redirect 不跟随）。
 */
async function proxyPostRaw(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
  timeoutMs?: number,
): Promise<RawPostResult> {
  const controller = new AbortController()
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'manual',
    })
    const text = await res.text()
    let parsed: unknown = {}
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = { detail: text.slice(0, 200) }
      }
    }
    const setCookies: string[] = []
    if (typeof res.headers.getSetCookie === 'function') {
      setCookies.push(...res.headers.getSetCookie())
    } else {
      res.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'set-cookie') {
          setCookies.push(...value.split(', '))
        }
      })
    }

    return { status: res.status, ok: res.ok, setCookies, body: parsed }
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

/**
 * WS upgrade 分支（M3：OAuth 会话先 mint 单次 ticket 再拨号；M5：密码会话同）。
 * 白名单校验在 upgrade 之前（ADR-0015），拒绝 403 不升级。
 */
async function handleWs(
  request: Request,
  oauthStore: OAuthStore,
  sessionStore: SessionStore,
  allowTarget: (target: string) => boolean,
): Promise<Response> {
  const url = new URL(request.url)
  const rawTarget = url.searchParams.get('target') ?? ''
  let target: string
  try {
    target = normalizeTarget(rawTarget)
  } catch (error) {
    return jsonResponse(
      400,
      { detail: error instanceof Error ? error.message : String(error) },
      request,
    )
  }
  if (!allowTarget(target)) {
    return jsonResponse(403, { detail: 'target not allowed' }, request)
  }

  // OAuth 会话 / 密码会话（ADR-0023：per-target cookie 解码）：为本次拨号
  // mint 单次 ws-ticket（gated gateway 拒绝 ?token=）。两种会话互斥存在，
  // 先 OAuth 后密码；refresh 产生的新凭证经 101 升级响应 Set-Cookie 写回。
  const oauthCookie = readOauthCookie(request, target)
  const passwordCookie = readPasswordCookie(request, target)
  // upgrade 后 request.headers 不可再读——Secure 标志必须在升级前算好。
  const secure = isHttpsRequest(request)
  const oauth = await oauthStore.wsTicketFor(oauthCookie, target)
  const password = oauth.ticket
    ? null
    : await sessionStore.wsTicketFor(passwordCookie, target)
  const ticket = oauth.ticket ?? password?.ticket ?? null
  // 无会话且无静态 token：gated gateway 拨号必败。必须在 upgrade 前拒绝
  // （401），否则浏览器先拿 101、随后立刻断开——渲染层误判已连接 → 跳
  // 模型选择 → 鉴权 401 → 跳回 setup → 重拨循环（OAuth 取消后实测的闪断
  // 循环）。401 让前端稳定落到 sign-in 恢复面（boot-failure overlay 的
  // remote-reauth 分支）。
  if (!ticket && !url.searchParams.has('token')) {
    return jsonResponse(
      401,
      { detail: 'gateway session required (sign in first)' },
      request,
    )
  }

  // 先拨上游（gateway 腿）并等其 OPEN，再 upgrade 浏览器：101 必须建立在
  // 能交付的连接上。上游不可达/超时 → 502（无 101）——前端 connect()
  // reject → boot 稳定失败；不再出现"101 后立刻断"的假连重拨循环
  // （token 模式 + gateway 不可达实测：8s 内 4-5 次拨号，UI 停在 onboarding 狂闪）。
  let upstream: WebSocket
  try {
    upstream = await dialUpstreamWs(target, url, { ticket })
  } catch (error) {
    return jsonResponse(
      502,
      {
        detail: `proxy upstream error: ${error instanceof Error ? error.message : String(error)}`,
      },
      request,
    )
  }

  try {
    const upgraded = Deno.upgradeWebSocket(request)
    // ADR-0023 决策 5：拨号期间 refresh 产生的新凭证经 101 升级响应
    // Set-Cookie 写回（Portal RT 旋转 + reuse-detection 要求立即写回）。
    if (oauth.setCookie) {
      upgraded.response.headers.append(
        'Set-Cookie',
        sessionCookieValue(oauthSessionCookieName(target), oauth.setCookie, { secure }),
      )
    }
    if (password?.setCookie) {
      upgraded.response.headers.append(
        'Set-Cookie',
        passwordSessionCookieValue(
          passwordSessionCookieName(target),
          password.setCookie,
          { secure },
        ),
      )
    }
    relayWs(upgraded.socket, upstream)

    return upgraded.response
  } catch (error) {
    try {
      upstream.close()
    } catch {
      // ignore
    }

    console.error('[ws] upgrade failed:', error instanceof Error ? error.stack ?? error.message : String(error))
    try {
      return jsonResponse(
        502,
        {
          detail: `proxy ws upgrade failed: ${error instanceof Error ? error.message : String(error)}`,
        },
        request,
      )
    } catch (headersError) {
      // upgrade 请求的 headers 已被消费/关闭时不能再读（回退无 CORS 的 502）。
      return new Response(
        JSON.stringify({ detail: 'proxy ws upgrade failed' }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      )
    }
  }
}

/**
 * ADR-0022：/api/proxy/media-stream —— 同源音频/视频附件可播源（Range/seek）。
 * 浏览器媒体元素 GET 带不了 X-Hermes-Target 头，故目标编码进 query；本路由是
 * 浏览器里"main 进程取数"的等价物：目标白名单（ADR-0015）+ 按会话/token 注入
 * 鉴权 + 透传 Range → gateway /api/files/stream，把 206 流式回传。
 */
async function handleMediaStream(
  request: Request,
  oauthStore: OAuthStore,
  sessionStore: SessionStore,
  allowTarget: (target: string) => boolean,
): Promise<Response> {
  const url = new URL(request.url)
  const rawTarget = url.searchParams.get('target') ?? ''
  let target: string
  try {
    target = normalizeTarget(rawTarget)
  } catch (error) {
    return jsonResponse(
      400,
      { detail: error instanceof Error ? error.message : String(error) },
      request,
    )
  }
  if (!allowTarget(target)) {
    return jsonResponse(403, { detail: 'target not allowed' }, request)
  }
  const filePath = url.searchParams.get('path') ?? ''
  if (!filePath) {
    return jsonResponse(400, { detail: 'path required' }, request)
  }
  const profile = url.searchParams.get('profile')?.trim() || undefined
  const token = url.searchParams.get('token') || null

  const oauthCookie = readOauthCookie(request, target)
  const passwordCookie = readPasswordCookie(request, target)
  const { bearer, setCookie: oauthRotated } = await oauthStore.bearerFor(
    oauthCookie,
    target,
  )
  const cookie = sessionStore.cookieFor(passwordCookie, target)
  const secure = isHttpsRequest(request)
  const extraSetCookies: string[] = []
  if (oauthRotated) {
    extraSetCookies.push(
      sessionCookieValue(oauthSessionCookieName(target), oauthRotated, { secure }),
    )
  }

  const upstream = mediaStreamUpstreamRequest(
    target,
    filePath,
    profile,
    request.headers,
  )
  // token 模式（无 OAuth/密码会话）：把 query 里的 token 转成上游凭证头。
  if (!bearer && !cookie && token) {
    upstream.headers.set('x-hermes-session-token', token)
  }

  return withCors(
    await relayRest(upstream, target, {
      bearer,
      cookie,
      extraSetCookies,
      onSetCookie: (setCookies) => {
        const rotated = sessionStore.applySetCookie(passwordCookie, target, setCookies)
        if (!rotated) {
          return []
        }

        return [
          passwordSessionCookieValue(
            passwordSessionCookieName(target),
            rotated,
            { secure },
          ),
        ]
      },
    }),
    request,
  )
}

/** 构造单 handler（测试可注入配置；生产从 env 读取）。 */
/**
 * 默认 SPA 产物位置：相对模块位置两级到仓库 apps/web/dist。
 * 注意不是 '../web/dist/'——那会解析到 apps/proxy/web/dist（不存在，
 * M4 生产服务器测试抓出的 bug：dev 走 vite 从未触发静态面默认值，
 * 生产模式（Dockerfile / 直接 deno run）静默 400）。
 */
export function defaultWebDist(metaUrl: string): string {
  return new URL('../../web/dist/', metaUrl).href
}

/**
 * 把 webDist 输入归一化成 file URL。文档契约是"file:// URL 或路径字符串"
 * （ProxyOptions.webDist），但实现曾只收 URL——容器生产测试抓出的 bug：
 * Dockerfile ENV WEB_DIST=/app/web-dist 是裸路径，new URL() 直接抛
 * Invalid URL，落到默认值（容器里不存在）→ 静态面静默全灭（所有请求
 * 落转发面 400）。
 *   - Windows 盘符（C:\x）先当路径处理，避免被 URL 解析成 scheme c:；
 *   - 相对路径相对默认 dist 目录（apps/web/dist）解析。
 */
function resolveWebDist(raw: string | undefined): URL {
  if (!raw) return new URL(defaultWebDist(import.meta.url))
  let url: URL
  if (/^[a-zA-Z]:[\\/]/.test(raw)) {
    // Windows 盘符（C:\x）：先当路径处理，避免被 URL 解析成 scheme c:
    url = new URL(`file:///${raw.replace(/\\/g, '/')}`)
  } else {
    try {
      url = new URL(raw)
    } catch {
      // 裸文件系统路径（容器 ENV WEB_DIST=/app/web-dist）→ 相对默认 dist 目录解析
      url = new URL(raw, defaultWebDist(import.meta.url))
    }
  }
  // 目录 URL 必须带尾斜杠：new URL('index.html', base) 在 base 无尾斜杠时
  // 会替换最后一段路径（file:///a/dist + index.html → file:///a/index.html）。
  if (!url.pathname.endsWith('/')) {
    url = new URL(`${url.href}/`)
  }
  return url
}

export function createProxyHandler(
  options: ProxyOptions = {},
): (request: Request) => Promise<Response> {
  const allowedTargets = options.allowedTargets ?? []
  const defaultGatewayUrl = options.defaultGatewayUrl ?? ''
  /** 访问控制：白名单为空 → 放行；否则目标必须命中名单（ADR-0015）。 */
  const allowTarget = (target: string): boolean => targetAllowed(target, allowedTargets)
  const webDist = resolveWebDist(options.webDist)

  const oauthStore = new OAuthStore({ postJson: proxyPostJson })
  const oauth = createOauthEndpoints(
    oauthStore,
    { isHttps: isHttpsRequest },
    {
      loopbackPort: options.oauthLoopbackPort,
      redirectUriOverride: () => options.oauthRedirectUri ?? '',
      allowTarget,
    },
  )
  // M5：密码 "dashboard login" 会话（jar 编码进浏览器 cookie，ADR-0023）。
  const sessionStore = new SessionStore({ postRaw: proxyPostRaw })
  const session = createSessionEndpoints(
    sessionStore,
    { isHttps: isHttpsRequest },
    { allowTarget },
  )

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) })
    }

    // 分支 1：静态托管（含 SPA fallback）。静态面先于访问控制（index.html
    // 需要可公开加载；白名单只约束代理的出站目标）。
    const staticResponse = await serveStatic(request, webDist)
    if (staticResponse) {
      return staticResponse
    }

    // 分支 2：OAuth 免检面（浏览器导航/查询，不构成开放转发——callback 只
    // 交换内存中已登记 state 的 code，session 只回显连接状态布尔）。
    if (url.pathname === '/auth/native/callback' && request.method === 'GET') {
      return withCors(await oauth.handleCallback(request), request)
    }
    if (url.pathname === '/auth/native/session' && request.method === 'GET') {
      return withCors(await oauth.handleSession(request), request)
    }
    // M5：密码会话状态同样免检（只回显 connected/provider/username 布尔与
    // 非敏感字段，不构成开放转发）。
    if (url.pathname === '/api/proxy/session/status' && request.method === 'GET') {
      return withCors(await session.handleStatus(request), request)
    }

    // 分支 3：/api/proxy/meta（公开：默认 gateway URL 预填 + 白名单下发）。
    if (url.pathname === '/api/proxy/meta' && request.method === 'GET') {
      return jsonResponse(
        200,
        {
          defaultGatewayUrl: defaultGatewayUrl || null,
          allowedTargets,
        },
        request,
      )
    }

    // 分支 4：访问控制已并入各出站面（REST/WS 见分支 6；OAuth start 与
    // 密码 login 在各自端点内校验，统一 403 'target not allowed'）。

    // 分支 5：OAuth 启动面（target 白名单校验在 oauth.ts 内，拒绝 403）。
    if (url.pathname === '/auth/native/start' && request.method === 'POST') {
      return withCors(await oauth.handleStart(request), request)
    }
    // ADR-0017：远端粘贴回跳（免检面，与 callback 同级——只交换内存中
    // 已登记 state 的 code，不构成开放转发）。
    if (url.pathname === '/auth/native/paste' && request.method === 'POST') {
      return withCors(await oauth.handlePaste(request), request)
    }
    if (url.pathname === '/auth/native/logout' && request.method === 'POST') {
      return withCors(await oauth.handleLogout(request), request)
    }

    // M5：密码会话破坏性面（登录换 jar、登出清 jar）——登录的 target
    // 白名单校验在 session.ts 内，拒绝 403；登出只清持 cookie 者自己的会话。
    if (url.pathname === '/api/proxy/session/login' && request.method === 'POST') {
      return withCors(await session.handleLogin(request), request)
    }
    if (url.pathname === '/api/proxy/session/logout' && request.method === 'POST') {
      return withCors(await session.handleLogout(request), request)
    }

    // ADR-0022：同源媒体元素可播源（GET，媒体元素发不了 X-Hermes-Target 头，
    // 目标经 query 指定）。白名单 + 鉴权注入与转发面同语义。
    if (url.pathname === '/api/proxy/media-stream' && request.method === 'GET') {
      return handleMediaStream(request, oauthStore, sessionStore, allowTarget)
    }

    // 分支 6：转发（白名单已校验；WS 在 handleWs 内 upgrade 前校验）。
    if (isWsUpgrade(request)) {
      return handleWs(request, oauthStore, sessionStore, allowTarget)
    }

    const rawTarget = request.headers.get('x-hermes-target') ?? ''
    let target: string
    try {
      target = normalizeTarget(rawTarget)
    } catch (error) {
      return jsonResponse(
        400,
        { detail: error instanceof Error ? error.message : String(error) },
        request,
      )
    }
    if (!allowTarget(target)) {
      return jsonResponse(403, { detail: 'target not allowed' }, request)
    }

    // M3/M5 + ADR-0023：per-target 会话 cookie 解码注入（OAuth Bearer /
    // 密码 jar Cookie）；OAuth refresh 或 jar 轮换产生的新凭证编码成新
    // cookie 值经响应 Set-Cookie 写回浏览器（网关域 Set-Cookie 不透传）。
    const oauthCookie = readOauthCookie(request, target)
    const passwordCookie = readPasswordCookie(request, target)
    const { bearer, setCookie: oauthRotated } = await oauthStore.bearerFor(
      oauthCookie,
      target,
    )
    const cookie = sessionStore.cookieFor(passwordCookie, target)
    const secure = isHttpsRequest(request)
    const extraSetCookies: string[] = []
    if (oauthRotated) {
      extraSetCookies.push(
        sessionCookieValue(oauthSessionCookieName(target), oauthRotated, { secure }),
      )
    }
    const response = await relayRest(request, target, {
      bearer,
      cookie,
      extraSetCookies,
      onSetCookie: (setCookies) => {
        const rotated = sessionStore.applySetCookie(passwordCookie, target, setCookies)
        if (!rotated) {
          return []
        }

        return [
          passwordSessionCookieValue(
            passwordSessionCookieName(target),
            rotated,
            { secure },
          ),
        ]
      },
    })

    return withCors(response, request)
  }
}

// ── 生产入口 ────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const PORT = Number(Deno.env.get('PORT') ?? 6722)
  const HOST = Deno.env.get('HOST') ?? '127.0.0.1'
  const handler = createProxyHandler({
    webDist: Deno.env.get('WEB_DIST') ?? undefined,
    allowedTargets: parseAllowedTargets(Deno.env.get('WEB_PROXY_ALLOWED_TARGETS')),
    defaultGatewayUrl: Deno.env.get('WEB_DEFAULT_GATEWAY_URL') ?? undefined,
    oauthRedirectUri: Deno.env.get('WEB_OAUTH_REDIRECT_URI') ?? undefined,
    oauthLoopbackPort: PORT,
  })
  Deno.serve({ port: PORT, hostname: HOST }, handler)
}
