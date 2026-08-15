/**
 * relay.ts — M2 代理转发核心（REST 透传 + WS 中继 + 目标解析）。
 *
 * 协议（PLAN §6 / handoff M2 §4，浏览器只见代理同源）：
 *   - REST：请求带 `X-Hermes-Target: <gateway base url>` 头；代理把
 *     target + pathname + search 拼成上游 URL，method/headers/body 透传，
 *     响应体流式回传（不缓冲）。
 *   - WS：浏览器 WebSocket 无法携带自定义头，目标改由 query 参数传递：
 *     `ws://proxy/api/ws?token=..&target=<encoded gateway base url>`。
 *     代理解析 target 后向 `<target>/api/ws<保留 query>` 拨号并双向中继。
 *
 * 本模块不依赖 Deno 之外的任何库，全部可单测（relay_test.ts）。
 */

/**
 * 解析 WEB_PROXY_ALLOWED_TARGETS（逗号分隔 gateway base URL；空 = 不限）。
 * 每项经 normalizeTarget 校验（http/https、去尾斜杠）；非法项启动即抛错
 * （配置错误要可见，不静默）。支持 `*.` 子域通配（如 https://*.example.com）。
 */
export function parseAllowedTargets(raw: string | undefined): string[] {
  if (!raw) {
    return []
  }

  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => normalizeTarget(entry))
}

interface OriginParts {
  scheme: string
  host: string
  port: string
}

function parseOrigin(urlStr: string): OriginParts {
  const url = new URL(urlStr)

  return {
    scheme: url.protocol,
    host: url.hostname,
    port: url.port || (url.protocol === 'https:' ? '443' : '80'),
  }
}

/**
 * 目标白名单判定：allowed 为空 → 放行；否则按 origin
 * （scheme://host[:port]，缺省端口归一 80/443）匹配，`*.` 通配只匹配
 * 子域、不匹配 apex。调用方需先 normalizeTarget（本函数容忍任意 http(s) 串）。
 */
export function targetAllowed(target: string, allowed: string[]): boolean {
  if (allowed.length === 0) {
    return true
  }

  const t = parseOrigin(target)
  for (const entry of allowed) {
    const e = parseOrigin(entry)
    if (e.scheme !== t.scheme || e.port !== t.port) {
      continue
    }
    if (e.host.startsWith('*.')) {
      if (t.host.endsWith(e.host.slice(1))) {
        return true
      }
    } else if (e.host === t.host) {
      return true
    }
  }

  return false
}

/** 校验并规范化目标 gateway base URL；非法抛 Error（调用方转 400）。 */
export function normalizeTarget(raw: string): string {
  if (!raw) {
    throw new Error('X-Hermes-Target header (or ?target= query) is required')
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

/** hop-by-hop 头 + 代理私有头：转发时剔除。 */
const STRIP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'x-hermes-target',
])

/** 构造上游 REST URL：target + 请求的 pathname/search。 */
export function upstreamUrl(target: string, request: Request): string {
  const reqUrl = new URL(request.url)

  return `${target}${reqUrl.pathname}${reqUrl.search}`
}

/** 构造上游 WS URL：target + /api/ws + 原 query（剔除 target 参数，其余保留）。 */
export function upstreamWsUrl(target: string, proxyUrl: URL): URL {
  const wsScheme = target.startsWith('https') ? 'wss' : 'ws'
  const parsed = new URL(target)
  // pathname 为 '/'（根目标）时省略前缀，避免拼出 '//api/ws' 双斜杠。
  const prefix = parsed.pathname === '/' ? '' : parsed.pathname
  const upstream = new URL(`${wsScheme}://${parsed.host}${prefix}/api/ws`)
  proxyUrl.searchParams.forEach((value, key) => {
    if (key !== 'target') {
      upstream.searchParams.append(key, value)
    }
  })

  return upstream
}

/**
 * REST 全量转发：method/headers/body 透传，响应流式回传。
 *
 * M3：`opts.bearer`（OAuth 模式的 access token，来自 oauth.ts 的
 * bearerFor）存在时注入 `Authorization: Bearer` 并去掉浏览器侧可能带的
 * X-Hermes-Session-Token（OAuth 模式浏览器不持静态 token）。
 *
 * M5：`opts.cookie`（密码 "dashboard login" 会话的 cookie jar，来自
 * session.ts 的 cookieFor）存在时注入 `Cookie` 头并同样摘掉浏览器侧静态
 * token（代理会话是权威凭证）。gateway 会在响应里轮换会话 cookie（AT 过期
 * 用 RT 透明刷新）——`opts.onSetCookie` 把响应 Set-Cookie 交回存储合并。
 */
export interface RelayRestOptions {
  bearer?: string | null
  cookie?: string | null
  /** 上游响应携带 Set-Cookie 时回调（cookie 轮换合并，session.ts）。 */
  onSetCookie?: (setCookies: string[]) => void
}

/** 读取响应的全部 Set-Cookie 原始值（Deno 2 原生 getSetCookie）。 */
export function collectSetCookies(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie
  if (typeof getSetCookie === 'function') {
    return getSetCookie.call(headers)
  }
  // 旧运行时回退：forEach 会把多个 set-cookie 拼成 ", " —— 尽力拆回。
  const out: string[] = []
  headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') {
      out.push(...value.split(', '))
    }
  })

  return out
}

export async function relayRest(
  request: Request,
  target: string,
  opts: RelayRestOptions = {},
): Promise<Response> {
  const headers = new Headers()
  request.headers.forEach((value, key) => {
    if (!STRIP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value)
    }
  })

  if (opts.bearer) {
    headers.set('authorization', `Bearer ${opts.bearer}`)
    headers.delete('x-hermes-session-token')
  }
  if (opts.cookie) {
    headers.set('cookie', opts.cookie)
    headers.delete('x-hermes-session-token')
  }

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl(target, request), {
      method: request.method,
      headers,
      body:
        request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : request.body,
      redirect: 'manual',
    })
  } catch (error) {
    return new Response(
      JSON.stringify({
        detail: `proxy upstream error: ${error instanceof Error ? error.message : String(error)}`,
      }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const setCookies = collectSetCookies(upstream.headers)
  if (setCookies.length && opts.onSetCookie) {
    opts.onSetCookie(setCookies)
  }

  const outHeaders = new Headers()
  upstream.headers.forEach((value, key) => {
    if (!STRIP_HEADERS.has(key.toLowerCase())) {
      outHeaders.set(key, value)
    }
  })

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  })
}

/** socket 缓冲：CONNECTING 期间入队，OPEN 后统一 flush。 */
const pendingMap = new WeakMap<WebSocket, (string | ArrayBuffer)[]>()

function enqueue(socket: WebSocket, data: string | ArrayBuffer): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(data)
    return
  }
  let pending = pendingMap.get(socket)
  if (!pending) {
    pending = []
    pendingMap.set(socket, pending)
  }
  pending.push(data)
}

function drain(socket: WebSocket): void {
  const pending = pendingMap.get(socket)
  if (pending && socket.readyState === WebSocket.OPEN && pending.length > 0) {
    for (const data of pending) {
      socket.send(data)
    }
    pending.length = 0
  }
}

function forward(event: MessageEvent, to: WebSocket): void {
  const data = (event as MessageEvent).data
  if (typeof data === 'string') {
    enqueue(to, data)
  } else if (data instanceof ArrayBuffer) {
    enqueue(to, data)
  } else if (
    data &&
    typeof data === 'object' &&
    typeof (data as Blob).arrayBuffer === 'function'
  ) {
    void (data as Blob).arrayBuffer().then((buf) => enqueue(to, buf))
  } else {
    drain(to)
  }
}

/**
 * WS 拨号选项：`ticket`（OAuth 模式经 ws-ticket 换的单次票据，见 oauth.ts 的
 * wsTicketFor）存在时追加 `?ticket=`（gated gateway 拒绝 `?token=`）。
 */
export interface RelayWsOptions {
  ticket?: string | null
}

/**
 * 先拨上游 gateway 腿并等待其 OPEN（默认 10s 超时，早于渲染层 15s 的
 * connect 超时）。浏览器侧 101 必须等这一腿确认连通后才发——否则浏览器
 * 先拿到 101、随后立刻断开（假连）：渲染层误判已连接 → boot 完成 → 网关
 * 腿失败 → WS 断 → 重拨循环（token 模式 + gateway 不可达实测：8s 内
 * 4-5 次拨号，UI 停在 onboarding 狂闪）。失败 reject，由调用方转 502
 * （无 101），前端 connect() reject → boot 稳定失败。
 */
export function dialUpstreamWs(
  target: string,
  proxyUrl: URL,
  opts: RelayWsOptions = {},
  timeoutMs = 10_000,
): Promise<WebSocket> {
  const upstream = upstreamWsUrl(target, proxyUrl)
  if (opts.ticket) {
    upstream.searchParams.set('ticket', opts.ticket)
    upstream.searchParams.delete('token')
  }
  const socket = new WebSocket(upstream.href)

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        socket.close()
      } catch {
        // ignore
      }
      reject(new Error(`upstream ws connect timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    socket.onopen = () => {
      clearTimeout(timer)
      resolve(socket)
    }
    socket.onerror = () => {
      clearTimeout(timer)
      reject(new Error(`upstream ws connection failed (${target})`))
    }
    socket.onclose = () => {
      clearTimeout(timer)
    }
  })
}

/**
 * WS 中继：浏览器侧 socket（已 upgrade）↔ 上游 gateway socket（已 OPEN）
 * 双向转发。上游必须先行拨通（dialUpstreamWs）——101 只能在能交付时给出。
 */
export function relayWs(browserSocket: WebSocket, upstreamSocket: WebSocket): void {
  // 浏览器侧刚 upgrade 可能仍在 CONNECTING：flush 它排队中的消息。
  browserSocket.onopen = () => {
    drain(browserSocket)
  }
  upstreamSocket.onmessage = (event) => {
    forward(event, browserSocket)
  }
  upstreamSocket.onclose = (event) => {
    try {
      browserSocket.close(event.code === 1006 ? 1001 : event.code, event.reason ?? '')
    } catch {
      // already closed
    }
  }
  upstreamSocket.onerror = () => {
    try {
      upstreamSocket.close()
    } catch {
      // ignore
    }
  }

  browserSocket.onmessage = (event) => {
    forward(event, upstreamSocket)
  }
  browserSocket.onclose = (event) => {
    try {
      upstreamSocket.close(event.code === 1006 ? 1001 : event.code, event.reason ?? '')
    } catch {
      // ignore
    }
  }
  browserSocket.onerror = () => {
    try {
      browserSocket.close()
    } catch {
      // ignore
    }
  }
}
