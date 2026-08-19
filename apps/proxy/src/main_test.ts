/**
 * main_test.ts — 代理端到端测试：真实 Deno.serve 起代理 + 临时目标服务，
 * 客户端走完整 HTTP/WS 链路（同 main.ts 生产形态）。
 */
import { assert, assertEquals } from 'jsr:@std/assert'
import { createProxyHandler, defaultWebDist } from './main.ts'
import {
  decodeSessionCookie,
  encodeSessionCookie,
  oauthSessionCookieName,
} from './oauth.ts'

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
    if (url.pathname === '/api/files/stream') {
      const range = request.headers.get('range') ?? ''
      const body = JSON.stringify({
        path: url.searchParams.get('path'),
        profile: url.searchParams.get('profile'),
        token: request.headers.get('x-hermes-session-token'),
        range,
      })
      return new Response(body, {
        status: range ? 206 : 200,
        headers: {
          'Content-Type': 'application/json',
          'Accept-Ranges': 'bytes',
          ...(range ? { 'Content-Range': 'bytes 0-10/1000' } : {}),
        },
      })
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
  opts: {
    allowedTargets?: string[]
    webDist?: string
    defaultGatewayUrl?: string
  } = {},
): Promise<{
  url: string
  close: () => Promise<void>
}> {
  const handler = createProxyHandler({
    allowedTargets: opts.allowedTargets,
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

Deno.test(
  'proxy: /api/proxy/media-stream streams gateway file with Range + token (ADR-0022)',
  async () => {
    const target = startTargetHttp()
    const proxy = await startProxy()
    try {
      const res = await fetch(
        `${proxy.url}/api/proxy/media-stream?target=${encodeURIComponent(target.url)}` +
          `&path=${encodeURIComponent('/tmp/a.ogg')}&profile=reviewer&token=tok123`,
        { headers: { range: 'bytes=0-10' } },
      )
      assertEquals(res.status, 206)
      assertEquals(res.headers.get('content-range'), 'bytes 0-10/1000')
      const json = await res.json()
      assertEquals(json.path, '/tmp/a.ogg')
      assertEquals(json.profile, 'reviewer')
      assertEquals(json.token, 'tok123')
      assertEquals(json.range, 'bytes=0-10')
    } finally {
      await proxy.close()
      await target.close()
    }
  },
)

Deno.test(
  'proxy: /api/proxy/media-stream gates non-allowlisted target (403)',
  async () => {
    const proxy = await startProxy({
      allowedTargets: ['http://127.0.0.1:1'],
    })
    try {
      const res = await fetch(
        `${proxy.url}/api/proxy/media-stream?target=${encodeURIComponent('http://127.0.0.1:2')}` +
          `&path=${encodeURIComponent('/tmp/a.ogg')}&token=tok123`,
      )
      assertEquals(res.status, 403)
      assertEquals((await res.json()).detail, 'target not allowed')
    } finally {
      await proxy.close()
    }
  },
)

Deno.test('proxy: /api/proxy/media-stream rejects missing path (400)', async () => {
  const target = startTargetHttp()
  const proxy = await startProxy()
  try {
    const res = await fetch(
      `${proxy.url}/api/proxy/media-stream?target=${encodeURIComponent(target.url)}`,
    )
    assertEquals(res.status, 400)
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

Deno.test('proxy: target allowlist gates REST forwarding (403)', async () => {
  const target = startTargetHttp()
  const proxy = await startProxy({ allowedTargets: [target.url] })
  try {
    // 白名单外目标 → 403，不产生出站。
    const denied = await fetch(`${proxy.url}/api/echo`, {
      headers: { 'x-hermes-target': 'http://127.0.0.1:1' },
    })
    assertEquals(denied.status, 403)
    assertEquals((await denied.json()).detail, 'target not allowed')

    // 白名单内目标 → 正常转发。
    const ok = await fetch(`${proxy.url}/api/echo`, {
      headers: { 'x-hermes-target': target.url },
    })
    assertEquals(ok.status, 200)
  } finally {
    await proxy.close()
    await target.close()
  }
})

Deno.test('proxy: target allowlist gates WS upgrade before dial (403)', async () => {
  const proxy = await startProxy({ allowedTargets: ['http://127.0.0.1:5180'] })
  try {
    const res = await fetch(
      `${proxy.url}/api/ws?target=${encodeURIComponent('http://127.0.0.1:1')}`,
      {
        headers: {
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-key': 'aaaaaaaaaaaaaaaaaaaaaa',
          'sec-websocket-version': '13',
        },
      },
    )
    assertEquals(res.status, 403)
    assertEquals((await res.json()).detail, 'target not allowed')
  } finally {
    await proxy.close()
  }
})

Deno.test('proxy: OAuth start rejects non-allowlisted target (403)', async () => {
  const proxy = await startProxy({ allowedTargets: ['http://127.0.0.1:5180'] })
  try {
    const denied = await fetch(`${proxy.url}/auth/native/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'http://evil.example.com' }),
    })
    assertEquals(denied.status, 403)
    assertEquals((await denied.json()).detail, 'target not allowed')

    // 白名单内目标照常返回 authorizeUrl（无需真实 gateway，begin 只拼 URL）。
    const ok = await fetch(`${proxy.url}/auth/native/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'http://127.0.0.1:5180' }),
    })
    assertEquals(ok.status, 200)
    assertEquals(
      (await ok.json()).authorizeUrl.startsWith('http://127.0.0.1:5180'),
      true,
    )
  } finally {
    await proxy.close()
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
Deno.test(
  'proxy: webDist accepts a plain filesystem path (container ENV style)',
  async () => {
    const dir = Deno.makeTempDirSync()
    const root = `file:///${dir.replace(/\\\\/g, '/')}/`
    Deno.writeFileSync(
      new URL('index.html', root),
      new TextEncoder().encode('<html>plain-path</html>'),
    )
    // Dockerfile ENV WEB_DIST=/app/web-dist 传的是裸路径字符串，不是 file:// URL
    const proxy = await startProxy({ webDist: dir })
    try {
      const index = await fetch(`${proxy.url}/`)
      assertEquals(index.status, 200)
      assertEquals(await index.text(), '<html>plain-path</html>')
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

Deno.test(
  'proxy: ws upgrade without session and without token is rejected (no false connect)',
  async () => {
    // OAuth/密码会话连接取消登录后：无会话、WS URL 无 ?token=。代理必须在
    // upgrade 前 401，而不是先 101 再断——后者让渲染层误判已连接 →
    // boot 循环（模型选择 ↔ setup 闪断）。
    const target = startTargetWs()
    const proxy = await startProxy()
    try {
      const targetHttp = target.url.replace(/^ws/, 'http')
      const wsUrl = `${proxy.url.replace(/^http/, 'ws')}/api/ws?target=${encodeURIComponent(targetHttp)}`
      const ws = new WebSocket(wsUrl)

      const outcome = await new Promise<'error' | 'close' | 'open' | 'timeout'>(
        (resolve) => {
          ws.onopen = () => resolve('open')
          ws.onerror = () => resolve('error')
          ws.onclose = () => resolve('close')
          setTimeout(() => resolve('timeout'), 3000)
        },
      )

      // 非 101（401）在浏览器/Deno WebSocket 上表现为 error 或 close——
      // 关键是不能 open（假连），且失败必须快速到达。
      assert(
        outcome === 'error' || outcome === 'close',
        `expected error/close (401), got ${outcome}`,
      )
    } finally {
      await proxy.close()
      await target.close()
    }
  },
)

Deno.test(
  'proxy: ws to an unreachable gateway is rejected without a false 101',
  async () => {
    // token 模式 + gateway 不可达：必须在上游腿失败时直接拒绝（502，无
    // 101）——否则浏览器先 101 后立刻断，渲染层误判已连接 → boot 完成 →
    // 重拨循环（实测 8s 内 4-5 次拨号，UI 停在 onboarding 狂闪）。
    const proxy = await startProxy()
    try {
      // 127.0.0.1:9 无服务 → 连接立即被拒。
      const wsUrl = `${proxy.url.replace(/^http/, 'ws')}/api/ws?token=tok&target=${encodeURIComponent('http://127.0.0.1:9')}`
      const ws = new WebSocket(wsUrl)

      const outcome = await new Promise<'error' | 'close' | 'open' | 'timeout'>(
        (resolve) => {
          ws.onopen = () => resolve('open')
          ws.onerror = () => resolve('error')
          ws.onclose = () => resolve('close')
          setTimeout(() => resolve('timeout'), 3000)
        },
      )

      assert(
        outcome === 'error' || outcome === 'close',
        `expected error/close (502, no false 101), got ${outcome}`,
      )
    } finally {
      await proxy.close()
    }
  },
)

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
  // ADR-0023：start 下发 pending cookie（浏览器持有，callback 时带回）。
  const pendingCookie = start.headers.get('set-cookie')?.split(';')[0] ?? ''
  assert(pendingCookie.startsWith('hermes_oauth_pending='), pendingCookie)

  // 2) 模拟浏览器：跟随 authorize 302（gateway → redirect_uri = 代理 loopback）。
  const hop = await fetch(authorizeUrl, { redirect: 'manual' })
  assertEquals(hop.status, 302)
  const location = hop.headers.get('location') ?? ''
  // ADR-0017：start 的 redirect_uri 是 loopback 字面量（127.0.0.1:<port>，
  // 非请求 origin）；dev 拓扑下 127.0.0.1 恰是本机代理——把端口改写为测试
  // 代理的实际端口，继续模拟浏览器跟随回跳。
  assert(/^http:\/\/127\.0\.0\.1:\d+\/auth\/native\/callback\?/.test(location))
  const cbUrl = location.replace(/^http:\/\/127\.0\.0\.1:\d+/, proxyUrl)

  // 3) 浏览器到达代理 callback（同窗口导航，带 pending cookie）。
  const cb = await fetch(cbUrl, { headers: { cookie: pendingCookie } })
  assertEquals(cb.status, 200)
  const setCookies = cb.headers.getSetCookie()
  // ADR-0023：会话 cookie 名 = per-target（hermes_oauth_<hash>），值 = 编码凭证。
  const sessionSet = setCookies.find((c) => c.startsWith('hermes_oauth_'))
  assert(
    sessionSet !== undefined,
    `expected hermes_oauth_* cookie, got: ${setCookies.join(' | ')}`,
  )
  assertEquals(sessionSet.includes('HttpOnly'), true)
  // 同时清掉 pending cookie（短 TTL 指针）。
  const pendingCleared = setCookies.find((c) => c.startsWith('hermes_oauth_pending=;'))
  assertEquals(pendingCleared?.includes('Max-Age=0'), true)
  const cookie = sessionSet.split(';')[0]

  return { cookie, setCookie: sessionSet }
}

Deno.test(
  'proxy: full OAuth login flow through the proxy (cookie + bearer injection)',
  async () => {
    const target = startOauthTarget()
    const proxy = await startProxy()
    try {
      const { cookie } = await oauthLogin(proxy.url, target.url)

      // 会话查询（免检、带 cookie + target）。
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

      // 登出：清浏览器 cookie（ADR-0023 无状态语义——凭证本体仍可解码，
      // 登出 = 清 cookie；浏览器不再持有旧值即断开）。
      const logout = await fetch(`${proxy.url}/auth/native/logout`, {
        method: 'POST',
        headers: { cookie },
      })
      assertEquals(logout.status, 200)
      assertEquals((logout.headers.get('set-cookie') ?? '').includes('Max-Age=0'), true)

      // 浏览器 cookie 被清后：不带旧 cookie 查询 → 未连接。
      const session2 = await fetch(
        `${proxy.url}/auth/native/session?target=${encodeURIComponent(target.url)}`,
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
  'proxy: OAuth WS dial refresh writes new cookie via 101 response (ADR-0023)',
  async () => {
    const target = startOauthTarget()
    const proxy = await startProxy()
    try {
      // 构造已过期会话：AT 过期 → WS 拨号前 refresh（access-oauth-1 → access-oauth-2），
      // 新 token set 必须经 101 升级响应 Set-Cookie 写回（Portal RT 旋转 + reuse-detection）。
      const expired = {
        accessToken: 'access-oauth-1',
        refreshToken: 'refresh-oauth-1',
        expiresAt: Math.floor(Date.now() / 1000) - 60,
        provider: 'nous',
        userId: 'u-oauth',
      }
      const cookieName = oauthSessionCookieName(target.url)
      const cookie = `${cookieName}=${encodeSessionCookie(target.url, expired)}`
      const proxyUrl = new URL(proxy.url)

      // 底层 TCP 发 WS upgrade（标准 WebSocket 客户端不暴露 101 响应头）。
      const conn = await Deno.connect({
        hostname: '127.0.0.1',
        port: Number(proxyUrl.port),
      })
      const key = 'dGhlIHNhbXBsZSBub25jZQ=='
      const req =
        `GET /api/ws?target=${encodeURIComponent(target.url)} HTTP/1.1\r\n` +
        `Host: ${proxyUrl.host}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        `Cookie: ${cookie}\r\n\r\n`
      await conn.write(new TextEncoder().encode(req))

      // 读 101 响应头（到空行截止）。
      const reader = conn.readable.getReader()
      const decoder = new TextDecoder()
      let headerText = ''
      while (!headerText.includes('\r\n\r\n')) {
        const { value, done } = await reader.read()
        if (done) break
        headerText += decoder.decode(value, { stream: true })
      }
      conn.close()

      assert(headerText.startsWith('HTTP/1.1 101'), headerText)
      // 101 响应必须带写回的会话 cookie（refresh 后的新 token set）。
      const setCookieMatch = headerText.match(/set-cookie: ([^\r\n]+)/i)
      assert(setCookieMatch !== null, headerText)
      const written = setCookieMatch[1].split(';')[0]
      const writtenName = written.split('=')[0]
      const writtenValue = written.slice(writtenName.length + 1)
      assertEquals(writtenName, cookieName)
      const decoded = decodeSessionCookie(writtenValue)
      assertEquals(decoded?.tokenSet.accessToken, 'access-oauth-2')
      assertEquals(decoded?.tokenSet.refreshToken, 'refresh-oauth-2')
    } finally {
      await proxy.close()
      await target.close()
    }
  },
)
Deno.test(
  'proxy: OAuth paste-back login completes through /auth/native/paste (ADR-0017)',
  async () => {
    const target = startOauthTarget()
    const proxy = await startProxy()
    try {
      // start → 远端浏览器拿不到 loopback 回调（跳本机 127.0.0.1 失败），
      // 复制地址栏 URL 粘贴到 /auth/native/paste。
      const start = await fetch(`${proxy.url}/auth/native/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: target.url }),
      })
      assertEquals(start.status, 200)
      const { authorizeUrl } = await start.json()
      const pendingCookie = start.headers.get('set-cookie')?.split(';')[0] ?? ''

      // 跟随 authorize 302（gateway → redirect_uri = loopback 字面量）。
      const hop = await fetch(authorizeUrl, { redirect: 'manual' })
      assertEquals(hop.status, 302)
      const location = hop.headers.get('location') ?? ''
      assert(location.startsWith('http://127.0.0.1:'), location)
      assert(location.includes('/auth/native/callback?code='), location)

      // 用户粘贴完整回调 URL（含 code + state）；paste 带 pending cookie
      // （ADR-0023：进行中登录在 cookie，不在代理内存）。
      const paste = await fetch(`${proxy.url}/auth/native/paste`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: pendingCookie },
        body: JSON.stringify({ target: target.url, url: location }),
      })
      assertEquals(paste.status, 200)
      assertEquals((await paste.json()).ok, true)
      const setCookies = paste.headers.getSetCookie()
      // ADR-0023：per-target 会话 cookie（hermes_oauth_<hash>），值 = 编码凭证。
      const sessionSet = setCookies.find((c) => c.startsWith('hermes_oauth_'))
      assert(
        sessionSet !== undefined,
        `expected hermes_oauth_* cookie, got: ${setCookies.join(' | ')}`,
      )
      assertEquals(sessionSet.includes('HttpOnly'), true)
      const cookie = sessionSet.split(';')[0]

      // 会话可用（免检查询）。
      const session = await fetch(
        `${proxy.url}/auth/native/session?target=${encodeURIComponent(target.url)}`,
        { headers: { cookie } },
      )
      assertEquals((await session.json()).connected, true)

      // 带 cookie 的 REST → Bearer 注入（与 callback 登录同一会话面）。
      const echo = await fetch(`${proxy.url}/api/echo`, {
        headers: { 'x-hermes-target': target.url, cookie },
      })
      assertEquals(echo.status, 200)
      assertEquals((await echo.json()).auth, 'Bearer access-oauth-1')

      // 伪造粘贴（未知 state）→ 400，不产生会话。
      const forged = await fetch(`${proxy.url}/auth/native/paste`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target: target.url,
          url: '?code=x&state=forged',
        }),
      })
      assertEquals(forged.status, 400)
    } finally {
      await proxy.close()
      await target.close()
    }
  },
)

Deno.test(
  'proxy: /api/proxy/meta reports default gateway + allowed targets (public)',
  async () => {
    const proxy = await startProxy({
      allowedTargets: ['http://hermes:9119', 'https://*.example.com'],
      defaultGatewayUrl: 'http://hermes:9119',
    })
    try {
      // 公开可读（默认 URL 预填是 boot 期能力，白名单下发供前端提示）。
      const res = await fetch(`${proxy.url}/api/proxy/meta`)
      assertEquals(res.status, 200)
      const meta = await res.json()
      assertEquals(meta.defaultGatewayUrl, 'http://hermes:9119')
      assertEquals(meta.allowedTargets, ['http://hermes:9119', 'https://*.example.com'])

      // 未配置 → null / 空数组（不限）。
      const proxy2 = await startProxy()
      try {
        const meta2 = await (await fetch(`${proxy2.url}/api/proxy/meta`)).json()
        assertEquals(meta2.defaultGatewayUrl, null)
        assertEquals(meta2.allowedTargets, [])
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
// ── M5：密码 "dashboard login" 会话端到端 ─────────────────────────────────

/** 目标服务：实现 gated gateway 的密码门禁面（password-login + cookie 门 + ws-ticket）。 */
function startPasswordTarget(): {
  url: string
  close: () => Promise<void>
  cookieSeen: string[]
  logoutSeen: number
} {
  const cookieSeen: string[] = []
  let logoutSeen = 0
  let rotated = false

  const handler = async (request: Request) => {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === '/auth/password-login' && request.method === 'POST') {
      const body = (await request.json()) as { username?: string; password?: string }
      if (body.password !== 'right') {
        return new Response(JSON.stringify({ detail: 'Invalid credentials' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      // 成功：下发 at/rt 会话 cookie（镜像上游 cookies.py 形状）。
      const loginHeaders = new Headers({ 'Content-Type': 'application/json' })
      loginHeaders.append(
        'Set-Cookie',
        'hermes_session_at=at-1; Path=/; HttpOnly; Max-Age=900',
      )
      loginHeaders.append(
        'Set-Cookie',
        'hermes_session_rt=rt-1; Path=/; HttpOnly; Max-Age=86400',
      )
      loginHeaders.append('Set-Cookie', 'hermes_session_provider=basic; Path=/')

      return new Response(JSON.stringify({ ok: true, next: '' }), {
        status: 200,
        headers: loginHeaders,
      })
    }

    if (path === '/api/echo' && request.method === 'GET') {
      const cookie = request.headers.get('cookie') ?? ''
      cookieSeen.push(cookie)
      if (!cookie.includes('hermes_session_at=')) {
        return new Response(JSON.stringify({ error: 'unauthenticated' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      // 首次带 at-1 的请求模拟一次 AT 轮换（镜像 middleware._attempt_refresh）。
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (cookie.includes('hermes_session_at=at-1') && !rotated) {
        rotated = true
        headers['Set-Cookie'] = 'hermes_session_at=at-2; Path=/; Max-Age=900'
      }

      return new Response(JSON.stringify({ cookie }), {
        status: 200,
        headers,
      })
    }

    if (path === '/api/auth/ws-ticket' && request.method === 'POST') {
      const cookie = request.headers.get('cookie') ?? ''
      if (!cookie.includes('hermes_session_at=')) {
        return new Response(JSON.stringify({ detail: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ticket: 'ticket-pw', ttl_seconds: 30 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (path === '/auth/logout' && request.method === 'POST') {
      logoutSeen += 1
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
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
    cookieSeen,
    get logoutSeen() {
      return logoutSeen
    },
  }
}

/** 走完整密码登录：POST /api/proxy/session/login → 返回 hermes_session cookie。 */
async function passwordLogin(
  proxyUrl: string,
  targetUrl: string,
  password: string,
): Promise<{ cookie: string }> {
  const login = await fetch(`${proxyUrl}/api/proxy/session/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      target: targetUrl,
      provider: 'basic',
      username: 'alice',
      password,
    }),
  })
  assertEquals(login.status, 200)
  const setCookie = login.headers.get('set-cookie') ?? ''
  // ADR-0023：per-target 会话 cookie（hermes_session_<hash>），值 = 编码 jar。
  assert(setCookie.startsWith('hermes_session_'), setCookie)
  assert(!setCookie.startsWith('hermes_session='), setCookie)

  return { cookie: setCookie.split(';')[0] }
}

Deno.test(
  'proxy: password login → cookie-injected REST → status → logout',
  async () => {
    const target = startPasswordTarget()
    const proxy = await startProxy()
    try {
      const { cookie } = await passwordLogin(proxy.url, target.url, 'right')

      // 状态：connected + 回显 provider/username（不泄露 cookie 本体）。
      const status = await fetch(
        `${proxy.url}/api/proxy/session/status?target=${encodeURIComponent(target.url)}`,
        { headers: { cookie } },
      )
      assertEquals(status.status, 200)
      const info = (await status.json()) as Record<string, unknown>
      assertEquals(info.connected, true)
      assertEquals(info.provider, 'basic')
      assertEquals(info.username, 'alice')

      // REST 转发：代理注入 cookie jar → 目标看到会话 cookie。
      const echo = await fetch(`${proxy.url}/api/echo`, {
        headers: {
          'X-Hermes-Target': target.url,
          cookie,
        },
      })
      assertEquals(echo.status, 200)
      const echoBody = (await echo.json()) as { cookie: string }
      assertEquals(echoBody.cookie.includes('hermes_session_at=at-1'), true)

      // 登出：尽力转发 gateway logout + 清浏览器 cookie（ADR-0023 无状态
      // 语义——登出 = 清 cookie；浏览器不再持有旧值即断开）。
      const logout = await fetch(`${proxy.url}/api/proxy/session/logout`, {
        method: 'POST',
        headers: { cookie },
      })
      assertEquals(logout.status, 200)
      assertEquals((logout.headers.get('set-cookie') ?? '').includes('Max-Age=0'), true)
      assertEquals(target.logoutSeen, 1)

      // 浏览器 cookie 被清后：不带旧 cookie 请求 → 代理不注入 → 目标 401。
      const after = await fetch(`${proxy.url}/api/echo`, {
        headers: {
          'X-Hermes-Target': target.url,
        },
      })
      assertEquals(after.status, 401)
    } finally {
      await proxy.close()
      await target.close()
    }
  },
)

Deno.test('proxy: password login failure passes through 401 detail', async () => {
  const target = startPasswordTarget()
  const proxy = await startProxy()
  try {
    const login = await fetch(`${proxy.url}/api/proxy/session/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: target.url,
        provider: 'basic',
        username: 'alice',
        password: 'wrong',
      }),
    })
    assertEquals(login.status, 401)
    assertEquals(
      ((await login.json()) as { detail: string }).detail,
      'Invalid credentials',
    )
  } finally {
    await proxy.close()
    await target.close()
  }
})

Deno.test(
  'proxy: password session rotates cookies from relayed Set-Cookie (write-back)',
  async () => {
    const target = startPasswordTarget()
    const proxy = await startProxy()
    try {
      const { cookie } = await passwordLogin(proxy.url, target.url, 'right')
      const cookieName = cookie.split('=')[0]

      // 第一次请求触发目标轮换（at-1 → at-2）。ADR-0023：代理把上游
      // Set-Cookie 剥离，合并后编码成代理域 cookie 写回响应头。
      const first = await fetch(`${proxy.url}/api/echo`, {
        headers: {
          'X-Hermes-Target': target.url,
          cookie,
        },
      })
      assertEquals(first.status, 200)
      const writeBack = first.headers
        .getSetCookie()
        .find((c) => c.startsWith(`${cookieName}=`))
      // 上游 Set-Cookie 不透传（gateway 域 cookie 对浏览器无用）
      assert(writeBack !== undefined, 'expected proxy-domain cookie write-back')
      const firstSet = first.headers.getSetCookie().join(' | ')
      assert(!firstSet.includes('hermes_session_at=at-2'), firstSet)
      assert(!firstSet.includes('Max-Age=900'), firstSet)

      // 第二次请求带写回后的新 cookie → 目标看到轮换后的 at-2。
      const rotatedCookie = writeBack.split(';')[0]
      const second = await fetch(`${proxy.url}/api/echo`, {
        headers: {
          'X-Hermes-Target': target.url,
          cookie: rotatedCookie,
        },
      })
      assertEquals(second.status, 200)
      assertEquals(target.cookieSeen[1].includes('hermes_session_at=at-2'), true)
    } finally {
      await proxy.close()
      await target.close()
    }
  },
)

Deno.test(
  'proxy: OAuth + password sessions survive proxy restart (cookie holds credentials)',
  async () => {
    const target = startOauthTarget()
    const passwordTarget = startPasswordTarget()
    const proxy = await startProxy()
    let oauthCookie = ''
    let passwordCookie = ''
    try {
      // 建立两种会话。
      const oauth = await oauthLogin(proxy.url, target.url)
      oauthCookie = oauth.cookie
      passwordCookie = (await passwordLogin(proxy.url, passwordTarget.url, 'right'))
        .cookie
    } finally {
      // 模拟代理重启：完全关闭，起一个全新实例（零共享状态）。
      await proxy.close()
    }

    const proxy2 = await startProxy()
    try {
      // ADR-0023：凭证在浏览器 cookie，新代理实例直接解码恢复，无需重登。
      const session = await fetch(
        `${proxy2.url}/auth/native/session?target=${encodeURIComponent(target.url)}`,
        { headers: { cookie: oauthCookie } },
      )
      assertEquals((await session.json()).connected, true)

      const echo = await fetch(`${proxy2.url}/api/echo`, {
        headers: { 'x-hermes-target': target.url, cookie: oauthCookie },
      })
      assertEquals((await echo.json()).auth, 'Bearer access-oauth-1')

      const pwStatus = await fetch(
        `${proxy2.url}/api/proxy/session/status?target=${encodeURIComponent(passwordTarget.url)}`,
        { headers: { cookie: passwordCookie } },
      )
      assertEquals((await pwStatus.json()).connected, true)

      const pwEcho = await fetch(`${proxy2.url}/api/echo`, {
        headers: { 'x-hermes-target': passwordTarget.url, cookie: passwordCookie },
      })
      assertEquals(pwEcho.status, 200)
    } finally {
      await proxy2.close()
      await target.close()
      await passwordTarget.close()
    }
  },
)

Deno.test(
  'proxy: password session status is public (CORS) and login gated by allowlist',
  async () => {
    const target = startPasswordTarget()
    const proxy = await startProxy({ allowedTargets: ['http://127.0.0.1:5180'] })
    try {
      // status 免检 + CORS（跨端口轮询）。
      const status = await fetch(
        `${proxy.url}/api/proxy/session/status?target=${encodeURIComponent(target.url)}`,
        { headers: { Origin: 'http://127.0.0.1:5173' } },
      )
      assertEquals(status.status, 200)
      assertEquals(
        status.headers.get('access-control-allow-origin'),
        'http://127.0.0.1:5173',
      )

      // login 目标不在白名单 → 403，不产生出站。
      const denied = await fetch(`${proxy.url}/api/proxy/session/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: target.url,
          provider: 'basic',
          username: 'a',
          password: 'b',
        }),
      })
      assertEquals(denied.status, 403)
      assertEquals((await denied.json()).detail, 'target not allowed')
    } finally {
      await proxy.close()
      await target.close()
    }
  },
)
