/**
 * main.ts — M2 薄代理入口（Deno 零依赖）。单 handler 三分支（PLAN §6）：
 *   1) 静态资源：GET 且 WEB_DIST 中存在该文件 → SPA 产物（含 fallback）；
 *   2) 访问控制：PROXY_PASSPHRASE 配置后校验 X-Hermes-Proxy-Passphrase；
 *   3) 其余全部转发：REST 透传（X-Hermes-Target 头）或 WS 中继
 *      （/api/ws?target=<encoded gateway url>）。
 *
 * 凭证只透传不落盘；目标 gateway 由浏览器每次请求携带；代理无状态。
 *
 * Usage:  deno run --allow-net --allow-read --allow-env src/main.ts
 * Env:    PORT           代理端口（默认 8787）
 *         HOST           监听地址（默认 127.0.0.1）
 *         WEB_DIST       静态目录（默认 <repo>/apps/web/dist；不存在则静态面为空）
 *         PROXY_PASSPHRASE  设置后开启访问控制（公网部署必开；本地 dev 留空）
 */
import { normalizeTarget, relayRest, relayWs, safeEqual } from './relay.ts'

export interface ProxyOptions {
  /** 静态托管根目录（file:// URL 或路径字符串）；不存在则静态面为空。 */
  webDist?: string
  /** 设置后转发面需要 X-Hermes-Proxy-Passphrase 头。 */
  passphrase?: string
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

/** CORS（dev 跨源 / 生产同源都无害）：凭证走 header，不依赖 cookie。 */
function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*'
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  })
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
    return jsonResponse(403, { detail: 'forbidden path' })
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
      ...corsHeaders()
    }
  })
}

/** WS upgrade 分支。返回 Response；错误情况返回 400/502。 */
function handleWs(request: Request): Response {
  const url = new URL(request.url)
  const rawTarget = url.searchParams.get('target') ?? ''
  let target: string
  try {
    target = normalizeTarget(rawTarget)
  } catch (error) {
    return jsonResponse(400, { detail: error instanceof Error ? error.message : String(error) })
  }

  let response: Response
  try {
    const upgraded = Deno.upgradeWebSocket(request)
    response = upgraded.response
    relayWs(upgraded.socket, url, target)
  } catch (error) {
    return jsonResponse(502, {
      detail: `proxy ws upgrade failed: ${error instanceof Error ? error.message : String(error)}`
    })
  }

  return response
}

/** 构造单 handler（测试可注入配置；生产从 env 读取）。 */
export function createProxyHandler(options: ProxyOptions = {}): (request: Request) => Promise<Response> {
  const passphrase = options.passphrase ?? ''
  let webDist: URL
  try {
    webDist = new URL(options.webDist ?? '../web/dist/', import.meta.url)
  } catch {
    webDist = new URL('../web/dist/', import.meta.url)
  }

  /** 访问控制：配置了 passphrase 后，转发请求必须携带正确头。 */
  const passphraseOk = (request: Request): boolean => {
    if (!passphrase) {
      return true
    }
    const given = request.headers.get('x-hermes-proxy-passphrase') ?? ''

    return safeEqual(given, passphrase)
  }

  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    // 分支 1：静态托管（含 SPA fallback）。静态面先于访问控制（index.html
    // 需要可公开加载，passphrase 只保护转发面）。
    const staticResponse = await serveStatic(request, webDist)
    if (staticResponse) {
      return staticResponse
    }

    // 分支 2：访问控制（转发面）。
    if (!passphraseOk(request)) {
      return jsonResponse(401, { detail: 'invalid proxy passphrase' })
    }

    // 分支 3：转发。
    if (isWsUpgrade(request)) {
      return handleWs(request)
    }

    const rawTarget = request.headers.get('x-hermes-target') ?? ''
    let target: string
    try {
      target = normalizeTarget(rawTarget)
    } catch (error) {
      return jsonResponse(400, { detail: error instanceof Error ? error.message : String(error) })
    }

    const response = await relayRest(request, target)
    // 给转发响应补 CORS 头（dev 跨源场景）。
    const headers = new Headers(response.headers)
    for (const [key, value] of Object.entries(corsHeaders())) {
      headers.set(key, value)
    }

    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
}

// ── 生产入口 ────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const PORT = Number(Deno.env.get('PORT') ?? 6722)
  const HOST = Deno.env.get('HOST') ?? '127.0.0.1'
  const handler = createProxyHandler({
    webDist: Deno.env.get('WEB_DIST') ?? undefined,
    passphrase: Deno.env.get('PROXY_PASSPHRASE') ?? undefined
  })
  Deno.serve({ port: PORT, hostname: HOST }, handler)
}