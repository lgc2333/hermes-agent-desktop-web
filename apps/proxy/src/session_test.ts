/**
 * session_test.ts — 密码会话中转单测（deno test，零外部依赖）。
 * 覆盖：cookie 工具、内存 store（登录/注入/轮换/ws-ticket/登出）、端点处理器。
 */
import { assertEquals } from 'jsr:@std/assert'
import {
  SessionStore,
  authLogoutUrl,
  clearPasswordSessionCookieValue,
  cookiesFromSetCookie,
  createSessionEndpoints,
  generateSessionKey,
  mergeCookieJar,
  passwordLoginUrl,
  passwordSessionCookieValue,
  wsTicketUrl,
  type RawPostResult,
  type SessionDeps,
} from './session.ts'

// ── Cookie 工具 ────────────────────────────────────────────────────────────

Deno.test('cookiesFromSetCookie: joins name=value pairs, dedupes', () => {
  assertEquals(
    cookiesFromSetCookie([
      'hermes_session_at=abc; Path=/; HttpOnly; Max-Age=900',
      'hermes_session_rt=xyz; Path=/; HttpOnly; Max-Age=86400',
      'hermes_session_provider=basic; Path=/',
      'hermes_session_at=abc; Path=/; HttpOnly; Max-Age=900',
    ]),
    'hermes_session_at=abc; hermes_session_rt=xyz; hermes_session_provider=basic',
  )
  assertEquals(cookiesFromSetCookie([]), '')
})

Deno.test('mergeCookieJar: overwrites by name, max-age=0 deletes', () => {
  const jar = 'hermes_session_at=old; hermes_session_rt=rt1; keep=1'
  const merged = mergeCookieJar(jar, [
    'hermes_session_at=new; Path=/; Max-Age=900',
    'hermes_session_rt=; Path=/; Max-Age=0',
  ])
  assertEquals(merged, 'hermes_session_at=new; keep=1')
})

Deno.test('generateSessionKey: 43 chars b64url, unique', () => {
  const a = generateSessionKey()
  const b = generateSessionKey()
  assertEquals(a.length, 43)
  assertEquals(a === b, false)
  assertEquals(/^[A-Za-z0-9_-]+$/.test(a), true)
})

Deno.test('password session cookie values: set + clear', () => {
  const set = passwordSessionCookieValue('key-1')
  assertEquals(set.startsWith('hermes_session=key-1;'), true)
  assertEquals(set.includes('HttpOnly'), true)
  assertEquals(set.includes('SameSite=Lax'), true)
  const clear = clearPasswordSessionCookieValue()
  assertEquals(clear.startsWith('hermes_session=;'), true)
  assertEquals(clear.includes('Max-Age=0'), true)
})

Deno.test('endpoint url builders join prefix paths without double slashes', () => {
  assertEquals(passwordLoginUrl('http://gw:9119'), 'http://gw:9119/auth/password-login')
  assertEquals(
    passwordLoginUrl('http://gw:9119/hermes/'),
    'http://gw:9119/hermes/auth/password-login',
  )
  assertEquals(wsTicketUrl('http://gw:9119'), 'http://gw:9119/api/auth/ws-ticket')
  assertEquals(authLogoutUrl('http://gw:9119'), 'http://gw:9119/auth/logout')
})

// ── Store：登录 / 注入 / 轮换 / ws-ticket / 登出 ───────────────────────────

interface FakeCall {
  url: string
  body: unknown
  headers: Record<string, string> | undefined
}

function fakeDeps(
  handler: (call: FakeCall) => RawPostResult,
  now = () => 1000,
): { deps: SessionDeps; calls: FakeCall[] } {
  const calls: FakeCall[] = []

  return {
    deps: {
      now,
      postRaw: async (url, body, headers) => {
        calls.push({ url, body, headers })

        return handler(calls[calls.length - 1])
      },
    },
    calls,
  }
}

const OK_LOGIN: RawPostResult = {
  status: 200,
  ok: true,
  setCookies: [
    'hermes_session_at=at1; Path=/; HttpOnly; Max-Age=900',
    'hermes_session_rt=rt1; Path=/; HttpOnly; Max-Age=86400',
  ],
  body: { ok: true, next: '' },
}

Deno.test(
  'login: forwards password-login, captures jar, returns sessionKey',
  async () => {
    const { deps, calls } = fakeDeps(() => OK_LOGIN)
    const store = new SessionStore(deps)

    const outcome = await store.login(
      'http://gw:9119/hermes',
      'basic',
      'alice',
      's3cret',
    )

    assertEquals(outcome.ok, true)
    assertEquals(typeof outcome.sessionKey, 'string')
    assertEquals(calls.length, 1)
    assertEquals(calls[0].url, 'http://gw:9119/hermes/auth/password-login')
    assertEquals(calls[0].body, {
      provider: 'basic',
      username: 'alice',
      password: 's3cret',
      next: '',
    })
    assertEquals(store.size, 1)

    const cookie = store.cookieFor(outcome.sessionKey!, 'http://gw:9119/hermes')
    assertEquals(cookie, 'hermes_session_at=at1; hermes_session_rt=rt1')
    // target 不匹配 → 无注入（防串连）。
    assertEquals(store.cookieFor(outcome.sessionKey!, 'http://other'), null)

    const info = store.sessionInfo(outcome.sessionKey!, 'http://gw:9119/hermes')
    assertEquals(info, { connected: true, provider: 'basic', username: 'alice' })
  },
)

Deno.test(
  'login: 401 passes through detail (never distinguishes user/password)',
  async () => {
    const { deps } = fakeDeps(() => ({
      status: 401,
      ok: false,
      setCookies: [],
      body: { detail: 'Invalid credentials' },
    }))
    const store = new SessionStore(deps)

    const outcome = await store.login('http://gw:9119', 'basic', 'alice', 'wrong')

    assertEquals(outcome.ok, false)
    assertEquals(outcome.status, 401)
    assertEquals(outcome.detail, 'Invalid credentials')
    assertEquals(outcome.sessionKey, undefined)
    assertEquals(store.size, 0)
  },
)

Deno.test('login: success without Set-Cookie fails closed (502)', async () => {
  const { deps } = fakeDeps(() => ({
    status: 200,
    ok: true,
    setCookies: [],
    body: { ok: true, next: '' },
  }))
  const store = new SessionStore(deps)

  const outcome = await store.login('http://gw:9119', 'basic', 'alice', 'pw')

  assertEquals(outcome.ok, false)
  assertEquals(outcome.status, 502)
  assertEquals(store.size, 0)
})

Deno.test('applySetCookie: rotates AT/RT from relayed responses', async () => {
  const { deps } = fakeDeps(() => OK_LOGIN)
  const store = new SessionStore(deps)
  const outcome = await store.login('http://gw:9119', 'basic', 'alice', 'pw')
  const key = outcome.sessionKey!

  store.applySetCookie(key, 'http://gw:9119', [
    'hermes_session_at=at2; Path=/; Max-Age=900',
  ])
  assertEquals(
    store.cookieFor(key, 'http://gw:9119'),
    'hermes_session_at=at2; hermes_session_rt=rt1',
  )

  // 无关 target 的 Set-Cookie 不合并。
  store.applySetCookie(key, 'http://other', ['x=1'])
  assertEquals(
    store.cookieFor(key, 'http://gw:9119'),
    'hermes_session_at=at2; hermes_session_rt=rt1',
  )
})

Deno.test(
  'wsTicketFor: mints ticket with cookie jar, merges rotation cookies',
  async () => {
    const { deps, calls } = fakeDeps((call) => {
      if (call.url.endsWith('/auth/password-login')) {
        return OK_LOGIN
      }

      return {
        status: 200,
        ok: true,
        setCookies: ['hermes_session_at=at3; Path=/; Max-Age=900'],
        body: { ticket: 't-1', ttl_seconds: 30 },
      }
    })
    const store = new SessionStore(deps)
    const outcome = await store.login('http://gw:9119', 'basic', 'alice', 'pw')
    const key = outcome.sessionKey!

    const ticket = await store.wsTicketFor(key, 'http://gw:9119')

    assertEquals(ticket, 't-1')
    assertEquals(calls.length, 2)
    assertEquals(calls[1].url, 'http://gw:9119/api/auth/ws-ticket')
    assertEquals(
      calls[1].headers?.cookie,
      'hermes_session_at=at1; hermes_session_rt=rt1',
    )
    // 轮换合并。
    assertEquals(
      store.cookieFor(key, 'http://gw:9119'),
      'hermes_session_at=at3; hermes_session_rt=rt1',
    )
  },
)

Deno.test('wsTicketFor: no session / upstream error → null', async () => {
  const { deps } = fakeDeps(() => OK_LOGIN)
  const store = new SessionStore(deps)

  assertEquals(await store.wsTicketFor(null, 'http://gw:9119'), null)
  assertEquals(await store.wsTicketFor('unknown', 'http://gw:9119'), null)

  const outcome = await store.login('http://gw:9119', 'basic', 'alice', 'pw')
  // 换了目标 → 会话仍在但 target 不匹配。
  assertEquals(await store.wsTicketFor(outcome.sessionKey!, 'http://other'), null)
})

Deno.test('logout: clears entry, info reports disconnected', async () => {
  const { deps } = fakeDeps(() => OK_LOGIN)
  const store = new SessionStore(deps)
  const outcome = await store.login('http://gw:9119', 'basic', 'alice', 'pw')
  const key = outcome.sessionKey!

  assertEquals(store.logout(key), true)
  assertEquals(store.size, 0)
  assertEquals(store.sessionInfo(key, 'http://gw:9119'), {
    connected: false,
    provider: '',
    username: '',
  })
})

// ── 端点处理器 ─────────────────────────────────────────────────────────────

function handlerContext(cookie: string | null) {
  return {
    readSessionKey: () => cookie,
  }
}

Deno.test(
  'handleLogin: success sets hermes_session cookie; 400 on missing fields',
  async () => {
    const { deps, calls } = fakeDeps(() => OK_LOGIN)
    const store = new SessionStore(deps)
    const ep = createSessionEndpoints(store, handlerContext(null))

    const res = await ep.handleLogin(
      new Request('http://proxy/api/proxy/session/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'http://gw:9119',
          provider: 'basic',
          username: 'alice',
          password: 'pw',
        }),
      }),
    )

    assertEquals(res.status, 200)
    const setCookie = res.headers.get('set-cookie') ?? ''
    assertEquals(setCookie.startsWith('hermes_session='), true)
    assertEquals((await res.json()).ok, true)
    assertEquals(calls[0].url, 'http://gw:9119/auth/password-login')

    const bad = await ep.handleLogin(
      new Request('http://proxy/api/proxy/session/login', {
        method: 'POST',
        body: JSON.stringify({ target: 'http://gw:9119', username: 'alice' }),
      }),
    )
    assertEquals(bad.status, 400)
  },
)

Deno.test('handleLogin: gateway 401 surfaces with detail', async () => {
  const { deps } = fakeDeps(() => ({
    status: 401,
    ok: false,
    setCookies: [],
    body: { detail: 'Invalid credentials' },
  }))
  const store = new SessionStore(deps)
  const ep = createSessionEndpoints(store, handlerContext(null))

  const res = await ep.handleLogin(
    new Request('http://proxy/api/proxy/session/login', {
      method: 'POST',
      body: JSON.stringify({
        target: 'http://gw:9119',
        provider: 'basic',
        username: 'alice',
        password: 'bad',
      }),
    }),
  )

  assertEquals(res.status, 401)
  assertEquals((await res.json()).detail, 'Invalid credentials')
})

Deno.test(
  'handleLogout: clears jar, forwards /auth/logout, clears cookie',
  async () => {
    const { deps, calls } = fakeDeps(() => OK_LOGIN)
    const store = new SessionStore(deps)
    const ep = createSessionEndpoints(store, handlerContext(null))

    // 先登录拿 key
    const loginRes = await ep.handleLogin(
      new Request('http://proxy/api/proxy/session/login', {
        method: 'POST',
        body: JSON.stringify({
          target: 'http://gw:9119',
          provider: 'basic',
          username: 'alice',
          password: 'pw',
        }),
      }),
    )
    const setCookie = loginRes.headers.get('set-cookie') ?? ''
    const key = decodeURIComponent(setCookie.split(';')[0].split('=')[1])
    assertEquals(store.size, 1)

    const ep2 = createSessionEndpoints(store, handlerContext(key))
    const res = await ep2.handleLogout(
      new Request('http://proxy/api/proxy/session/logout', { method: 'POST' }),
    )

    assertEquals(res.status, 200)
    assertEquals(store.size, 0)
    assertEquals((res.headers.get('set-cookie') ?? '').includes('Max-Age=0'), true)
    const logoutCall = calls[calls.length - 1]
    assertEquals(logoutCall.url, 'http://gw:9119/auth/logout')
    assertEquals(
      logoutCall.headers?.cookie,
      'hermes_session_at=at1; hermes_session_rt=rt1',
    )
  },
)

Deno.test(
  'handleStatus: connected / disconnected echo without leaking cookies',
  async () => {
    const { deps } = fakeDeps(() => OK_LOGIN)
    const store = new SessionStore(deps)
    const ep = createSessionEndpoints(store, handlerContext(null))

    const off = await ep.handleStatus(
      new Request(
        'http://proxy/api/proxy/session/status?target=http%3A%2F%2Fgw%3A9119',
      ),
    )
    assertEquals(await off.json(), { connected: false, provider: '', username: '' })

    const loginRes = await ep.handleLogin(
      new Request('http://proxy/api/proxy/session/login', {
        method: 'POST',
        body: JSON.stringify({
          target: 'http://gw:9119',
          provider: 'basic',
          username: 'alice',
          password: 'pw',
        }),
      }),
    )
    const key = decodeURIComponent(
      (loginRes.headers.get('set-cookie') ?? '').split(';')[0].split('=')[1],
    )
    const ep2 = createSessionEndpoints(store, handlerContext(key))
    const on = await ep2.handleStatus(
      new Request(
        'http://proxy/api/proxy/session/status?target=http%3A%2F%2Fgw%3A9119',
      ),
    )
    assertEquals(await on.json(), {
      connected: true,
      provider: 'basic',
      username: 'alice',
    })
    // 明文不含 cookie 本体。
    const bodyText = await ep2
      .handleStatus(
        new Request(
          'http://proxy/api/proxy/session/status?target=http%3A%2F%2Fgw%3A9119',
        ),
      )
      .then((r) => r.text())
    assertEquals(bodyText.includes('at1'), false)
  },
)
