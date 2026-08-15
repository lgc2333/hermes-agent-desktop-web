/**
 * main.ts — M2/M3 薄代理入口（Deno 零依赖）。单 handler 多分支（PLAN §6）：
 *   1) 静态资源：GET 且 WEB_DIST 中存在该文件 → SPA 产物（含 fallback）；
 *   2) OAuth 面：/auth/native/{start,callback,session,logout}（M3，见 oauth.ts）；
 *   3) /api/proxy/meta：默认 gateway URL + passphrase 开关下发（M3）；
 *   4) 访问控制：PROXY_PASSPHRASE 配置后校验 X-Hermes-Proxy-Passphrase；
 *   5) 其余全部转发：REST 透传（X-Hermes-Target 头）或 WS 中继
 *      （/api/ws?target=<encoded gateway url>）。
 *
 * M3 OAuth 集成：OAuth 会话存在时（httpOnly cookie hermes_oauth_session），
 * REST 转发注入 Authorization: Bearer，WS 拨号先 mint 单次 ticket。
 * 凭证只透传不落盘（token set 仅代理内存）；目标 gateway 由浏览器每次请求携带。
 *
 * Usage:  deno run --allow-net --allow-read --allow-env src/main.ts
 * Env:    PORT           代理端口（默认 6722，用户手改；dev.mjs 同步）
 *         HOST           监听地址（默认 127.0.0.1）
 *         WEB_DIST       静态目录（默认 <repo>/apps/web/dist；不存在则静态面为空）
 *         PROXY_PASSPHRASE  设置后开启访问控制（公网部署必开；本地 dev 留空）
 *         HERMES_DEFAULT_GATEWAY_URL  经 /api/proxy/meta 下发的默认 gateway URL
 *         OAUTH_REDIRECT_URI          OAuth redirect_uri 覆盖（部署场景）
 */
import { createOauthEndpoints, OAuthStore, parseCookies, SESSION_COOKIE_NAME } from './oauth.ts'
import { normalizeTarget, relayRest, relayWs, safeEqual } from './relay.ts'

export interface ProxyOptions {
  /** 静态托管根目录（file:// URL 或路径字符串）；不存在则静态面为空。 */
  webDist?: string
  /** 设置后转发面需要 X-Hermes-Proxy-Passphrase 头。 */
  passphrase?: string
  /** /api/proxy/meta 下发的默认 gateway URL（生产 compose env）。 */
  defaultGatewayUrl?: string
  /** OAuth redirect_uri 覆盖（部署场景；默认 = 请求 origin）。 */
  oauthRedirectUri?: string
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
  '.txt': 'text/plain; charset=utf-8'
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
        'x-hermes-target, x-hermes-session-token, x-hermes-proxy-passphrase, content-type, authorization',
      'Vary': 'Origin'
    }
  }

  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*'
  }
}

function jsonResponse(status: number, body: unknown, request?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
  })
}

/** 给响应补 CORS 头（转发响应 / OAuth 响应统一处理）。 */
function withCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(corsHeaders(request))) {
    headers.set(key, value)
  }

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function isWsUpgrade(request: Request): boolean {
  return (request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket'
}

/** 静态分支：文件存在 → 返回；不存在 → null（调用方决定 fallback）。 */
async function serveStatic(request: Request, webDist: URL): Promise<Response | null> {
  const url = new URL(request.url)

  // 只服务 GET/HEAD；/api/ 前缀绝不进静态面。
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return null
  }
  if (url.pathname.startsWith('/api/')) {
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
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
      ...corsHeaders(request)
    }
  })
}

/** 生产 postJson（服务器到服务器，OAuthStore 注入面）。 */
async function proxyPostJson(url: string, body: unknown, opts?: { timeoutMs?: number; headers?: Record<string, string> }): Promise<unknown> {
  const controller = new AbortController()
  const timer = opts?.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs) : undefined
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...opts?.headers },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'manual'
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

/** WS upgrade 分支（M3：OAuth 会话先 mint 单次 ticket 再拨号）。 */
async function handleWs(request: Request, oauthStore: OAuthStore): Promise<Response> {
  const url = new URL(request.url)
  const rawTarget = url.searchParams.get('target') ?? ''
  let target: string
  try {
    target = normalizeTarget(rawTarget)
  } catch (error) {
    return jsonResponse(400, { detail: error instanceof Error ? error.message : String(error) }, request)
  }

  // OAuth 会话：为本次拨号 mint 单次 ws-ticket（gated gateway 拒绝 ?token=）。
  const sessionKey = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE_NAME] ?? null
  const ticket = await oauthStore.wsTicketFor(sessionKey, target)

  let response: Response
  try {
    const upgraded = Deno.upgradeWebSocket(request)
    response = upgraded.response
    relayWs(upgraded.socket, url, target, { ticket })
  } catch (error) {
    return jsonResponse(502, {
      detail: `proxy ws upgrade failed: ${error instanceof Error ? error.message : String(error)}`
    }, request)
  }

  return response
}

/** 构造单 handler（测试可注入配置；生产从 env 读取）。 */
export function createProxyHandler(options: ProxyOptions = {}): (request: Request) => Promise<Response> {
  const passphrase = options.passphrase ?? ''
  const defaultGatewayUrl = options.defaultGatewayUrl ?? ''
  let webDist: URL
  try {
    webDist = new URL(options.webDist ?? '../web/dist/', import.meta.url)
  } catch {
    webDist = new URL('../web/dist/', import.meta.url)
  }

  const oauthStore = new OAuthStore({ postJson: proxyPostJson })
  const oauth = createOauthEndpoints(oauthStore, {
    readSessionKey: request => parseCookies(request.headers.get('cookie'))[SESSION_COOKIE_NAME] ?? null
  }, {
    origin: request => new URL(request.url).origin,
    redirectUriOverride: () => options.oauthRedirectUri ?? ''
  })

  const isOauthPath = (path: string): boolean =>
    path === '/auth/native/start' ||
    path === '/auth/native/callback' ||
    path === '/auth/native/session' ||
    path === '/auth/native/logout'

  /** 访问控制：配置了 passphrase 后，转发请求必须携带正确头。 */
  const passphraseOk = (request: Request): boolean => {
    if (!passphrase) {
      return true
    }
    const given = request.headers.get('x-hermes-proxy-passphrase') ?? ''

    return safeEqual(given, passphrase)
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) })
    }

    // 分支 1：静态托管（含 SPA fallback）。静态面先于访问控制（index.html
    // 需要可公开加载，passphrase 只保护转发面）。
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

    // 分支 3：/api/proxy/meta（公开：默认 gateway URL 预填 + passphrase 开关）。
    if (url.pathname === '/api/proxy/meta' && request.method === 'GET') {
      return jsonResponse(200, {
        defaultGatewayUrl: defaultGatewayUrl || null,
        requiresPassphrase: Boolean(passphrase)
      }, request)
    }

    // 分支 4：访问控制（转发面 + OAuth 破坏性/启动面）。
    if (!passphraseOk(request)) {
      return jsonResponse(401, { detail: 'invalid proxy passphrase' }, request)
    }

    // 分支 5：OAuth 需检面。
    if (url.pathname === '/auth/native/start' && request.method === 'POST') {
      return withCors(await oauth.handleStart(request), request)
    }
    if (url.pathname === '/auth/native/logout' && request.method === 'POST') {
      return withCors(await oauth.handleLogout(request), request)
    }

    // 分支 6：转发。
    if (isWsUpgrade(request)) {
      return handleWs(request, oauthStore)
    }

    const rawTarget = request.headers.get('x-hermes-target') ?? ''
    let target: string
    try {
      target = normalizeTarget(rawTarget)
    } catch (error) {
      return jsonResponse(400, { detail: error instanceof Error ? error.message : String(error) }, request)
    }

    // M3：OAuth 会话存在且 target 匹配 → 注入 Bearer（浏览器不持静态 token）。
    const sessionKey = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE_NAME] ?? null
    const bearer = await oauthStore.bearerFor(sessionKey, target)
    const response = await relayRest(request, target, { bearer })

    return withCors(response, request)
  }
}

// ── 生产入口 ────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const PORT = Number(Deno.env.get('PORT') ?? 6722)
  const HOST = Deno.env.get('HOST') ?? '127.0.0.1'
  const handler = createProxyHandler({
    webDist: Deno.env.get('WEB_DIST') ?? undefined,
    passphrase: Deno.env.get('PROXY_PASSPHRASE') ?? undefined,
    defaultGatewayUrl: Deno.env.get('HERMES_DEFAULT_GATEWAY_URL') ?? undefined,
    oauthRedirectUri: Deno.env.get('OAUTH_REDIRECT_URI') ?? undefined
  })
  Deno.serve({ port: PORT, hostname: HOST }, handler)
}
