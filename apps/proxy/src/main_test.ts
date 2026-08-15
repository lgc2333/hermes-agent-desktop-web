/**
 * main_test.ts — 代理端到端测试：真实 Deno.serve 起代理 + 临时目标服务，
 * 客户端走完整 HTTP/WS 链路（同 main.ts 生产形态）。
 */
import { assertEquals } from 'jsr:@std/assert'
import { createProxyHandler } from './main.ts'

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
          query: url.search
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
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
        }
      })

      return new Response(body, { status: 200 })
    }
    return new Response(JSON.stringify({ detail: 'No such API endpoint' }), { status: 404 })
  }
  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, handler)

  return {
    get url() {
      return `http://127.0.0.1:${(server.addr as { port: number }).port}`
    },
    close: async () => {
      await server.shutdown()
    }
  }
}

function startTargetWs(): { url: string; close: () => Promise<void> } {
  const handler = (request: Request) => {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('not ws', { status: 400 })
    }
    const { socket, response } = Deno.upgradeWebSocket(request)
    socket.onmessage = event => {
      socket.send(`echo:${String(event.data)}`)
    }

    return response
  }
  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, handler)

  return {
    get url() {
      return `ws://127.0.0.1:${(server.addr as { port: number }).port}`
    },
    close: async () => {
      await server.shutdown()
    }
  }
}

/** 起一个完整代理实例。 */
async function startProxy(opts: { passphrase?: string; webDist?: string } = {}): Promise<{
  url: string
  close: () => Promise<void>
}> {
  const handler = createProxyHandler({ passphrase: opts.passphrase, webDist: opts.webDist })
  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, handler)

  return {
    get url() {
      return `http://127.0.0.1:${(server.addr as { port: number }).port}`
    },
    close: async () => {
      await server.shutdown()
    }
  }
}

// ── REST 转发 ──────────────────────────────────────────────────────────────

Deno.test('proxy: forwards REST with X-Hermes-Target (method/body/headers/query)', async () => {
  const target = startTargetHttp()
  const proxy = await startProxy()
  try {
    const res = await fetch(`${proxy.url}/api/echo?q=1`, {
      method: 'POST',
      headers: {
        'x-hermes-target': target.url,
        'x-hermes-session-token': 'tok123',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ a: 1 })
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
})

Deno.test('proxy: streams response bodies without buffering', async () => {
  const target = startTargetHttp()
  const proxy = await startProxy()
  try {
    const res = await fetch(`${proxy.url}/api/stream`, {
      headers: { 'x-hermes-target': target.url }
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
      headers: { 'x-hermes-target': target.url }
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
      headers: { 'x-hermes-target': 'http://127.0.0.1:1' }
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
      headers: { 'x-hermes-target': target.url }
    })
    assertEquals(denied.status, 401)

    const ok = await fetch(`${proxy.url}/api/echo`, {
      headers: { 'x-hermes-target': target.url, 'x-hermes-proxy-passphrase': 'secret-pass' }
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
  Deno.writeFileSync(new URL('index.html', root), new TextEncoder().encode('<html>SPA</html>'))
  Deno.writeFileSync(new URL('assets/app.js', root), new TextEncoder().encode('console.log(1)'))

  return root
}

Deno.test('proxy: serves static files and SPA-falls back for client routes', async () => {
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
      ws.onmessage = event => {
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
    const outcome = await new Promise<'error' | 'close' | 'timeout'>(resolve => {
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