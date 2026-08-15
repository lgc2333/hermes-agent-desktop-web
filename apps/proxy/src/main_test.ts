/**
 * main_test.ts — 代理端到端测试：真实 Deno.serve 起代理 + 临时目标服务，
 * 客户端走完整 HTTP/WS 链路（同 main.ts 生产形态）。
 */
import { assert, assertEquals } from 'jsr:@std/assert'
import { createProxyHandler, defaultWebDist } from './main.ts'

// ── 目标服务（echo HTTP / echo WS）─────────────────────────────────────────

function startTargetHttp(): { url: string; close: () => Promise<void> } {
  const handler = (request: Request) => {
    const url = new URL(request.url)
    if (url.pathname === '/api/echo') {
      return new Response(
        JSON.stringify({
          method: request.method,
          token: request.headers.get('x-hermes-session-token'),
          hasBody: request.body !== null,
          query: url.search,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (url.pathname === '/api/stream') {
      const encoder = new TextEncoder()
      let i = 0
      const body = new ReadableStream({
        pull(controller) {
          if (i >= 5) {
            controller.close()
            return
          }
          controller.enqueue(encoder.encode(`chunk${i++}; `))
        },
      })

      return new Response(body, { status: 200 })
    }
    return new Response(JSON.stringify({ detail: 'No such API endpoint' }), {
      status: 404,
    })
  }
  const server = Deno.serve(
    { port: 0, hostname: '127.0.0.1', onListen: () => {} },
    handler,
  )

  return {
    get url() {
      return `http://127.0.0.1:${(server.addr as { port: number }).port}`
    },
    close: async () => {
      await server.shutdown()
    },
  }
}

function startTargetWs(): { url: string; close: () => Promise<void> } {
  const handler = (request: Request) => {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('not ws', { status: 400 })
    }
    const { socket, response } = Deno.upgradeWebSocket(request)
    socket.onmessage = (event) => {
      socket.send(`echo:${String(event.data)}`)
    }

    return response
  }
  const server = Deno.serve(
    { port: 0, hostname: '127.0.0.1', onListen: () => {} },
    handler,
  )

  return {
    get url() {
      return `ws://127.0.0.1:${(server.addr as { port: number }).port}`
    },
    close: async () => {
      await server.shutdown()
    },
  }
}

/** 起一个完整代理实例。 */
async function startProxy(
  opts: { passphrase?: string; webDist?: string; defaultGatewayUrl?: string } = {},
): Promise<{
  url: string
  close: () => Promise<void>
}> {
  const handler = createProxyHandler({
    passphrase: opts.passphrase,
    webDist: opts.webDist,
    defaultGatewayUrl: opts.defaultGatewayUrl,
  })
  const server = Deno.serve(
    { port: 0, hostname: '127.0.0.1', onListen: () => {} },
    handler,
  )

  return {
    get url() {
      return `http://127.0.0.1:${(server.addr as { port: number }).port}`
    },
    close: async () => {
      await server.shutdown()
    },
  }
}

// ── REST 转发 ──────────────────────────────────────────────────────────────

Deno.test(
  'proxy: forwards REST with X-Hermes-Target (method/body/headers/query)',
  async () => {
    const target = startTargetHttp()
    const proxy = await startProxy()
    try {
      const res = await fetch(`${proxy.url}/api/echo?q=1`, {
        method: 'POST',
        headers: {
          'x-hermes-target': target.url,
          'x-hermes-session-token': 'tok123',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ a: 1 }),
      })
      assertEquals(res.status, 200)
      const json = await res.json()
      assertEquals(json.method, 'POST')
      assertEquals(json.token, 'tok123')
      assertEquals(json.hasBody, true)
      assertEquals(json.query, '?q=1')
    } finally {
      await proxy.close()
      await target.close()
    }
  },
)

Deno.test('proxy: streams response bodies without buffering', async () => {
  const target = startTargetHttp()
  const proxy = await startProxy()
  try {
    const res = await fetch(`${proxy.url}/api/stream`, {
      headers: { 'x-hermes-target': target.url },
    })
    assertEquals(res.status, 200)
    assertEquals(await res.text(), 'chunk0; chunk1; chunk2; chunk3; chunk4; ')
  } finally {
    await proxy.close()
    await target.close()
  }
})

Deno.test('proxy: passes through 404 and other statuses', async () => {
  const target = startTargetHttp()
  const proxy = await startProxy()
  try {
    const res = await fetch(`${proxy.url}/api/missing`, {
      headers: { 'x-hermes-target': target.url },
    })
    assertEquals(res.status, 404)
    assertEquals((await res.json()).detail, 'No such API endpoint')
  } finally {
    await proxy.close()
    await target.close()
  }
})

Deno.test('proxy: missing X-Hermes-Target -> 400', async () => {
  const proxy = await startProxy()
  try {
    const res = await fetch(`${proxy.url}/api/status`)
    assertEquals(res.status, 400)
    assertEquals((await res.json()).detail.includes('X-Hermes-Target'), true)
  } finally {
    await proxy.close()
  }
})

Deno.test('proxy: upstream down -> 502 with detail', async () => {
  const proxy = await startProxy()
  try {
    const res = await fetch(`${proxy.url}/api/x`, {
      headers: { 'x-hermes-target': 'http://127.0.0.1:1' },
    })
    assertEquals(res.status, 502)
    assertEquals((await res.json()).detail.startsWith('proxy upstream error:'), true)
  } finally {
    await proxy.close()
  }
})

// ── 访问控制 ───────────────────────────────────────────────────────────────

Deno.test('proxy: passphrase gate rejects and accepts', async () => {
  const target = startTargetHttp()
  const proxy = await startProxy({ passphrase: 'secret-pass' })
  try {
    const denied = await fetch(`${proxy.url}/api/echo`, {
      headers: { 'x-hermes-target': target.url },
    })
    assertEquals(denied.status, 401)

    const ok = await fetch(`${proxy.url}/api/echo`, {
      headers: {
        'x-hermes-target': target.url,
        'x-hermes-proxy-passphrase': 'secret-pass',
      },
    })
    assertEquals(ok.status, 200)
  } finally {
    await proxy.close()
    await target.close()
  }
})

// ── 静态托管 ───────────────────────────────────────────────────────────────

function tempWebDist(): string {
  const dir = Deno.makeTempDirSync()
  const root = `file:///${dir.replace(/\\\\/g, '/')}/`
  Deno.mkdirSync(new URL('assets', root))
  Deno.writeFileSync(
    new URL('index.html', root),
    new TextEncoder().encode('<html>SPA</html>'),
  )
  Deno.writeFileSync(
    new URL('assets/app.js', root),
    new TextEncoder().encode('console.log(1)'),
  )

  return root
}

Deno.test(
  'proxy: serves static files and SPA-falls back for client routes',
  async () => {
    const webDist = tempWebDist()
    const proxy = await startProxy({ webDist })
    try {
      const index = await fetch(`${proxy.url}/`)
      assertEquals(index.status, 200)
      assertEquals(await index.text(), '<html>SPA</html>')

      const js = await fetch(`${proxy.url}/assets/app.js`)
      assertEquals(js.status, 200)
      assertEquals(await js.text(), 'console.log(1)')

      // 未知客户端路由 → index.html（SPA fallback）
      const route = await fetch(`${proxy.url}/chat/some-session`)
      assertEquals(route.status, 200)
      assertEquals(await route.text(), '<html>SPA</html>')

      // API 前缀不落静态面
      const api = await fetch(`${proxy.url}/api/status`)
      assertEquals(api.status, 400)
    } finally {
      await proxy.close()
    }
  },
)
Deno.test('defaultWebDist: resolves to repo apps/web/dist (M4 regression)', () => {
  // M4 生产服务器测试抓出的 bug：默认值曾是 '../web/dist/'，相对 src/main.ts
  // 解析到 apps/proxy/web/dist（不存在）→ 生产静态托管静默 400（dev 走 vite
  // 从未触发默认值）。纯函数断言：相对本文件（src/）两级必须落在 apps/web/dist。
  const url = defaultWebDist(import.meta.url)
  const parsed = new URL(url)
  assertEquals(parsed.protocol, 'file:')
  assert(
    parsed.pathname.endsWith('/apps/web/dist/'),
    `expected .../apps/web/dist/, got ${parsed.pathname}`,
  )
})

// ── WS 中继 ────────────────────────────────────────────────────────────────

Deno.test('proxy: relays WebSocket bidirectionally with ?target=', async () => {
  const target = startTargetWs()
  const proxy = await startProxy()
  try {
    const targetHttp = target.url.replace(/^ws/, 'http')
    const wsUrl = `${proxy.url.replace(/^http/, 'ws')}/api/ws?token=tok123&target=${encodeURIComponent(targetHttp)}`
    const ws = new WebSocket(wsUrl)

    const messages: string[] = []
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws relay timeout')), 5000)
      ws.onopen = () => {
        ws.send('ping-1')
      }
      ws.onmessage = (event) => {
        messages.push(String(event.data))
        if (messages.length === 2) {
          clearTimeout(timer)
          ws.close()
          resolve()
        } else {
          ws.send('ping-2')
        }
      }
      ws.onerror = () => {
        clearTimeout(timer)
        reject(new Error('ws relay error'))
      }
    })

    assertEquals(messages, ['echo:ping-1', 'echo:ping-2'])
  } finally {
    await proxy.close()
    await target.close()
  }
})

Deno.test('proxy: ws upgrade without target fails fast (error or close)', async () => {
  const proxy = await startProxy()
  try {
    const ws = new WebSocket(`${proxy.url.replace(/^http/, 'ws')}/api/ws?token=x`)
    const outcome = await new Promise<'error' | 'close' | 'timeout'>((resolve) => {
      ws.onerror = () => resolve('error')
      ws.onclose = () => resolve('close')
      setTimeout(() => resolve('timeout'), 3000)
    })
    // 非 101 的 upgrade 响应在浏览器/Deno WebSocket 上表现为 error 或 close——
    // 关键是失败必须快速到达，不能挂起。
    assertEquals(outcome === 'timeout', false)
  } finally {
    await proxy.close()
  }
})

// ── M3：OAuth 中转端到端 ───────────────────────────────────────────────────

/** 目标服务：实现 gateway 的 native OAuth 面（authorize/token/refresh/ws-ticket）+ WS。 */
function startOauthTarget(): {
  url: string
  close: () => Promise<void>
  tickets: string[]
  authHeaders: string[]
  wsSeen: string[]
} {
  const tickets: string[] = []
  const authHeaders: string[] = []
  const wsSeen: string[] = []
  let nextCode = 1

  const handler = (request: Request) => {
    const url = new URL(request.url)
    const path = url.pathname

    // WS：验证 ticket 透传（gated gateway 拒绝 ?token=）。
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const ticket = url.searchParams.get('ticket') ?? ''
      const token = url.searchParams.get('token') ?? ''
      wsSeen.push(ticket)
      const { socket, response } = Deno.upgradeWebSocket(request)
      socket.onopen = () =>
        socket.send(`ticket=${ticket || 'none'} token=${token || 'none'}`)

      return response
    }

    // authorize：校验后 302 到 redirect_uri（模拟 IDP 即时完成）。
    if (path === '/auth/native/authorize' && request.method === 'GET') {
      const challenge = url.searchParams.get('code_challenge') ?? ''
      const method = url.searchParams.get('code_challenge_method') ?? ''
      const redirectUri = url.searchParams.get('redirect_uri') ?? ''
      const state = url.searchParams.get('state') ?? ''

      if (method !== 'S256' || !challenge || !redirectUri) {
        return new Response('bad authorize params', { status: 400 })
      }

      const sep = redirectUri.includes('?') ? '&' : '?'
      const location = `${redirectUri}${sep}code=gw-code-${nextCode++}&state=${encodeURIComponent(state)}`

      return new Response(null, { status: 302, headers: { location } })
    }

    if (path === '/auth/native/token' && request.method === 'POST') {
      return new Response(
        JSON.stringify({
          access_token: 'access-oauth-1',
          refresh_token: 'refresh-oauth-1',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          provider: 'nous',
          user_id: 'u-oauth',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    if (path === '/auth/native/refresh' && request.method === 'POST') {
      return new Response(
        JSON.stringify({
          access_token: 'access-oauth-2',
          refresh_token: 'refresh-oauth-2',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          provider: 'nous',
          user_id: 'u-oauth',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    if (path === '/api/auth/ws-ticket' && request.method === 'POST') {
      const auth = request.headers.get('authorization') ?? ''
      authHeaders.push(auth)
      const ticket = 'ticket-' + tickets.length
      tickets.push(ticket)

      return new Response(JSON.stringify({ ticket, ttl_seconds: 30 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // REST echo：回显 Authorization（验证代理注入 Bearer）。
    if (path === '/api/echo') {
      return new Response(
        JSON.stringify({ auth: request.headers.get('authorization') ?? null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    return new Response(JSON.stringify({ detail: 'No such API endpoint' }), {
      status: 404,
    })
  }

  const server = Deno.serve(
    { port: 0, hostname: '127.0.0.1', onListen: () => {} },
    handler,
  )

  return {
    get url() {
      return `http://127.0.0.1:${(server.addr as { port: number }).port}`
    },
    close: async () => {
      await server.shutdown()
    },
    tickets,
    authHeaders,
    wsSeen,
  }
}

/** 走完整 OAuth 登录：start → 模拟浏览器跟随 authorize 302 → 代理 callback → 返回 cookie。 */
async function oauthLogin(
  proxyUrl: string,
  targetUrl: string,
): Promise<{ cookie: string; setCookie: string }> {
  // 1) 浏览器 fetch start（模拟页面同源请求）。
  const start = await fetch(`${proxyUrl}/auth/native/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: targetUrl }),
  })
  assertEquals(start.status, 200)
  const { authorizeUrl } = await start.json()

  // 2) 模拟浏览器：跟随 authorize 302（gateway → redirect_uri = 代理 callback）。
  const hop = await fetch(authorizeUrl, { redirect: 'manual' })
  assertEquals(hop.status, 302)
  const location = hop.headers.get('location') ?? ''
  assertEquals(location.startsWith(proxyUrl + '/auth/native/callback'), true)

  // 3) 浏览器到达代理 callback（同窗口导航，无自定义头）。
  const cb = await fetch(location)
  assertEquals(cb.status, 200)
  const setCookie = cb.headers.get('set-cookie') ?? ''
  assertEquals(setCookie.includes('hermes_oauth_session='), true)
  assertEquals(setCookie.includes('HttpOnly'), true)
  const cookie = setCookie.split(';')[0]

  return { cookie, setCookie }
}

Deno.test(
  'proxy: full OAuth login flow through the proxy (cookie + bearer injection)',
  async () => {
    const target = startOauthTarget()
    const proxy = await startProxy()
    try {
      const { cookie } = await oauthLogin(proxy.url, target.url)

      // 会话查询（免 passphrase、带 cookie + target）。
      const session = await fetch(
        `${proxy.url}/auth/native/session?target=${encodeURIComponent(target.url)}`,
        { headers: { cookie } },
      )
      const info = await session.json()
      assertEquals(info.connected, true)
      assertEquals(info.provider, 'nous')
      assertEquals(info.userId, 'u-oauth')
      assertEquals(info.tokenPreview, 'acce…')

      // 带 cookie 的 REST 请求 → 代理注入 Authorization: Bearer。
      const echo = await fetch(`${proxy.url}/api/echo`, {
        headers: { 'x-hermes-target': target.url, cookie },
      })
      assertEquals(echo.status, 200)
      assertEquals((await echo.json()).auth, 'Bearer access-oauth-1')

      // 无 cookie 的 REST 请求 → 不注入。
      const echo2 = await fetch(`${proxy.url}/api/echo`, {
        headers: { 'x-hermes-target': target.url },
      })
      assertEquals((await echo2.json()).auth, null)

      // 登出：清会话 + 清 cookie。
      const logout = await fetch(`${proxy.url}/auth/native/logout`, {
        method: 'POST',
        headers: { cookie },
      })
      assertEquals(logout.status, 200)
      assertEquals((logout.headers.get('set-cookie') ?? '').includes('Max-Age=0'), true)

      const session2 = await fetch(
        `${proxy.url}/auth/native/session?target=${encodeURIComponent(target.url)}`,
        { headers: { cookie } },
      )
      assertEquals((await session2.json()).connected, false)
    } finally {
      await proxy.close()
      await target.close()
    }
  },
)

Deno.test('proxy: OAuth WS dial mints a ticket and replaces token', async () => {
  const target = startOauthTarget()
  const proxy = await startProxy()
  try {
    const { cookie } = await oauthLogin(proxy.url, target.url)

    // 代理向 gateway mint ticket（Bearer 认证）后以 ?ticket= 拨号 WS。
    // 浏览器 URL 带 ?token=，但 OAuth 会话存在时代理剔除 token、换 ticket。
    const wsUrl = `${proxy.url.replace(/^http/, 'ws')}/api/ws?token=browser-token&target=${encodeURIComponent(target.url)}`
    const ws = new WebSocket(wsUrl, { headers: { cookie } })

    const first = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws ticket timeout')), 5000)
      ws.onmessage = (event) => {
        clearTimeout(timer)
        resolve(String(event.data))
        ws.close()
      }
      ws.onerror = () => {
        clearTimeout(timer)
        reject(new Error('ws ticket error'))
      }
    })

    // ticket 生效、浏览器 token 被剔除（gated gateway 只认 ticket）。
    assertEquals(first, 'ticket=ticket-0 token=none')
    assertEquals(target.authHeaders.length, 1)
    assertEquals(target.authHeaders[0], 'Bearer access-oauth-1')
    assertEquals(target.wsSeen, ['ticket-0'])
  } finally {
    await proxy.close()
    await target.close()
  }
})

Deno.test(
  'proxy: /api/proxy/meta reports default gateway + passphrase flag (public)',
  async () => {
    const proxy = await startProxy({
      passphrase: 'secret',
      defaultGatewayUrl: 'http://hermes:9119',
    })
    try {
      // 免 passphrase 可读（默认 URL 预填是 boot 期能力）。
      const res = await fetch(`${proxy.url}/api/proxy/meta`)
      assertEquals(res.status, 200)
      const meta = await res.json()
      assertEquals(meta.defaultGatewayUrl, 'http://hermes:9119')
      assertEquals(meta.requiresPassphrase, true)

      // 未配置 defaultGatewayUrl → null。
      const proxy2 = await startProxy()
      try {
        const meta2 = await (await fetch(`${proxy2.url}/api/proxy/meta`)).json()
        assertEquals(meta2.defaultGatewayUrl, null)
        assertEquals(meta2.requiresPassphrase, false)
      } finally {
        await proxy2.close()
      }
    } finally {
      await proxy.close()
    }
  },
)

Deno.test(
  'proxy: CORS reflects Origin with credentials for cross-port dev',
  async () => {
    const target = startOauthTarget()
    const proxy = await startProxy()
    try {
      // 带 Origin 的跨源请求 → 回显 Origin + Allow-Credentials（cookie 需要）。
      const res = await fetch(`${proxy.url}/api/echo`, {
        headers: {
          'x-hermes-target': target.url,
          origin: 'http://127.0.0.1:5173',
        },
      })
      assertEquals(
        res.headers.get('access-control-allow-origin'),
        'http://127.0.0.1:5173',
      )
      assertEquals(res.headers.get('access-control-allow-credentials'), 'true')

      // OPTIONS 预检同样回显。
      const preflight = await fetch(`${proxy.url}/api/echo`, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://127.0.0.1:5173',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'x-hermes-target',
        },
      })
      assertEquals(preflight.status, 204)
      assertEquals(
        preflight.headers.get('access-control-allow-origin'),
        'http://127.0.0.1:5173',
      )
      assertEquals(preflight.headers.get('access-control-allow-credentials'), 'true')

      // OAuth session 端点也带 CORS（跨端口轮询）。
      const session = await fetch(`${proxy.url}/auth/native/session`, {
        headers: { origin: 'http://127.0.0.1:5173' },
      })
      assertEquals(
        session.headers.get('access-control-allow-origin'),
        'http://127.0.0.1:5173',
      )
    } finally {
      await proxy.close()
      await target.close()
    }
  },
)
