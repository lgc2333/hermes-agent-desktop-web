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

/** 恒时比较两个字符串（passphrase 校验）。 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
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
  'x-hermes-proxy-passphrase'
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

/** REST 全量转发：method/headers/body 透传，响应流式回传。 */
export async function relayRest(request: Request, target: string): Promise<Response> {
  const headers = new Headers()
  request.headers.forEach((value, key) => {
    if (!STRIP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value)
    }
  })

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl(target, request), {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual'
    })
  } catch (error) {
    return new Response(
      JSON.stringify({ detail: `proxy upstream error: ${error instanceof Error ? error.message : String(error)}` }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const outHeaders = new Headers()
  upstream.headers.forEach((value, key) => {
    if (!STRIP_HEADERS.has(key.toLowerCase())) {
      outHeaders.set(key, value)
    }
  })

  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: outHeaders })
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
  } else if (data && typeof data === 'object' && typeof (data as Blob).arrayBuffer === 'function') {
    void (data as Blob).arrayBuffer().then(buf => enqueue(to, buf))
  } else {
    drain(to)
  }
}

/** WS 中继：浏览器侧 socket（已 upgrade）↔ 上游 gateway socket 双向转发。 */
export function relayWs(browserSocket: WebSocket, proxyUrl: URL, target: string): void {
  const upstream = upstreamWsUrl(target, proxyUrl)
  const upstreamSocket = new WebSocket(upstream.href)

  upstreamSocket.onopen = () => {
    drain(upstreamSocket)
    drain(browserSocket)
  }
  upstreamSocket.onmessage = event => {
    forward(event, browserSocket)
  }
  upstreamSocket.onclose = event => {
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

  browserSocket.onmessage = event => {
    forward(event, upstreamSocket)
  }
  browserSocket.onclose = event => {
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