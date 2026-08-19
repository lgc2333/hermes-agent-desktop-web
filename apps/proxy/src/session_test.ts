/**
 * session_test.ts — 密码会话中转单测（deno test，零外部依赖）。
 * 覆盖：cookie 工具、jar cookie 编解码（ADR-0023：凭证进浏览器 cookie）、
 * 无状态 store（登录/注入/轮换/ws-ticket）、端点处理器。
 */
import { assertEquals } from '@std/assert'
import {
  SessionStore,
  authLogoutUrl,
  clearPasswordSessionCookieValue,
  cookiesFromSetCookie,
  createSessionEndpoints,
  decodeJarCookie,
  encodeJarCookie,
  mergeCookieJar,
  passwordLoginUrl,
  passwordSessionCookieName,
  passwordSessionCookieValue,
  wsTicketUrl,
  type PasswordSessionEntry,
  type SessionDeps,
} from './session.ts'
import { targetHash } from './oauth.ts'

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

Deno.test('password session cookie values: set + clear + Secure + 30d', () => {
  const name = 'hermes_session_0123456789abcdef'
  const set = passwordSessionCookieValue(name, 'encoded-jar')
  assertEquals(set.startsWith(`${name}=encoded-jar`), true)
  assertEquals(set.includes('HttpOnly'), true)
  assertEquals(set.includes('SameSite=Lax'), true)
  assertEquals(set.includes('Max-Age=2592000'), true) // 30 天
  const clear = clearPasswordSessionCookieValue(name)
  assertEquals(clear.includes('Max-Age=0'), true)
  assertEquals(
    passwordSessionCookieValue(name, 'x', { secure: true }).includes('Secure'),
    true,
  )
  assertEquals(passwordSessionCookieValue(name, 'x').includes('Secure'), false)
})

// ── jar cookie 编解码（ADR-0023）───────────────────────────────────────────

function entry(overrides: Partial<PasswordSessionEntry> = {}): PasswordSessionEntry {
  return {
    target: 'http://gw:9119',
    cookieHeader:
      'hermes_session_at=at1; hermes_session_rt=rt1; hermes_session_provider=basic',
    provider: 'basic',
    username: 'admin',
    createdAt: 1000,
    ...overrides,
  }
}

Deno.test('encode/decodeJarCookie: roundtrip preserves fields', () => {
  const e = entry()
  const value = encodeJarCookie('http://gw:9119', e)
  assertEquals(/^[A-Za-z0-9_-]+$/.test(value), true)
  const decoded = decodeJarCookie(value)
  assertEquals(decoded?.target, 'http://gw:9119')
  assertEquals(decoded?.entry.cookieHeader, e.cookieHeader)
  assertEquals(decoded?.entry.username, 'admin')
})

Deno.test('decodeJarCookie: garbage → null', () => {
  assertEquals(decodeJarCookie(''), null)
  assertEquals(decodeJarCookie('not-base64!!!'), null)
  assertEquals(decodeJarCookie('aGVsbG8='), null)
})

Deno.test('passwordSessionCookieName: per-target names, stable', () => {
  const t = 'http://gw:9119'
  assertEquals(passwordSessionCookieName(t), `hermes_session_${targetHash(t)}`)
  assertEquals(
    passwordSessionCookieName(t) === passwordSessionCookieName('http://other:1'),
    false,
  )
})

// ── 无状态 store（jar cookie 值直接进出，无内存）───────────────────────────

function makeDeps(overrides: Partial<SessionDeps> = {}): SessionDeps & {
  calls: { url: string; body: unknown; headers?: Record<string, string> }[]
} {
  const calls: { url: string; body: unknown; headers?: Record<string, string> }[] = []
  return {
    postRaw: async (url: string, body: unknown, headers?: Record<string, string>) => {
      calls.push({ url, body, headers })
      if (url.endsWith('/auth/password-login')) {
        return {
          status: 200,
          ok: true,
          setCookies: [
            'hermes_session_at=at1; Path=/; HttpOnly; Max-Age=900',
            'hermes_session_rt=rt1; Path=/; HttpOnly; Max-Age=86400',
            'hermes_session_provider=basic; Path=/',
          ],
          body: { ok: true, next: '' },
        }
      }
      if (url.endsWith('/api/auth/ws-ticket')) {
        return {
          status: 200,
          ok: true,
          setCookies: [],
          body: { ticket: 'ticket-1', ttl_seconds: 30 },
        }
      }
      if (url.endsWith('/auth/logout')) {
        return { status: 200, ok: true, setCookies: [], body: {} }
      }
      throw new Error(`unexpected url: ${url}`)
    },
    ...overrides,
    calls,
  }
}

async function loginAndGetCookie(
  store: SessionStore,
  target = 'http://gw:9119',
): Promise<string> {
  const outcome = await store.login(target, 'basic', 'admin', 'pw')
  assertEquals(outcome.ok, true)
  assertEquals(outcome.jarValue !== null && outcome.jarValue !== undefined, true)
  return outcome.jarValue!
}

Deno.test(
  'store: login returns encoded jar cookie value (no memory), 401 surfaces detail',
  async () => {
    const deps = makeDeps()
    const store = new SessionStore(deps)

    const ok = await store.login('http://gw:9119', 'basic', 'admin', 'pw')
    assertEquals(ok.ok, true)
    assertEquals(ok.status, 200)
    const decoded = decodeJarCookie(ok.jarValue!)
    assertEquals(decoded?.entry.username, 'admin')
    assertEquals(decoded?.entry.cookieHeader.includes('hermes_session_at=at1'), true)
    // 无内存：第二个 store 实例用同一 cookie 值也能恢复会话（重启恢复）
    const store2 = new SessionStore(deps)
    assertEquals(
      store2
        .cookieFor(ok.jarValue!, 'http://gw:9119')
        ?.includes('hermes_session_at=at1'),
      true,
    )

    // 失败：gateway 401 原样透传
    const bad = new SessionStore(
      makeDeps({
        postRaw: async (url: string) => {
          if (url.endsWith('/auth/password-login')) {
            return {
              status: 401,
              ok: false,
              setCookies: [],
              body: { detail: 'Invalid credentials' },
            }
          }
          throw new Error(`unexpected: ${url}`)
        },
      }),
    )
    const fail = await bad.login('http://gw:9119', 'basic', 'admin', 'wrong')
    assertEquals(fail.ok, false)
    assertEquals(fail.status, 401)
    assertEquals(fail.detail, 'Invalid credentials')
  },
)

Deno.test('store: login without Set-Cookie fails closed (502)', async () => {
  const store = new SessionStore(
    makeDeps({
      postRaw: async () => ({ status: 200, ok: true, setCookies: [], body: {} }),
    }),
  )
  const outcome = await store.login('http://gw:9119', 'basic', 'admin', 'pw')
  assertEquals(outcome.ok, false)
  assertEquals(outcome.status, 502)
})

Deno.test('store: cookieFor decodes jar, null for wrong target / garbage', async () => {
  const store = new SessionStore(makeDeps())
  const jarValue = await loginAndGetCookie(store)

  assertEquals(
    store.cookieFor(jarValue, 'http://gw:9119')?.includes('hermes_session_at=at1'),
    true,
  )
  assertEquals(store.cookieFor(jarValue, 'http://other:1'), null)
  assertEquals(store.cookieFor(null, 'http://gw:9119'), null)
  assertEquals(store.cookieFor('garbage', 'http://gw:9119'), null)
})

Deno.test('store: applySetCookie rotates jar, returns new encoded value', async () => {
  const store = new SessionStore(makeDeps())
  const jarValue = await loginAndGetCookie(store)

  const rotated = store.applySetCookie(jarValue, 'http://gw:9119', [
    'hermes_session_at=at2; Path=/; HttpOnly; Max-Age=900',
    'hermes_session_rt=; Path=/; HttpOnly; Max-Age=0', // RT 轮换：旧 RT 删除
  ])
  assertEquals(rotated !== null, true)
  const decoded = decodeJarCookie(rotated!)
  assertEquals(decoded?.entry.cookieHeader.includes('hermes_session_at=at2'), true)
  assertEquals(decoded?.entry.cookieHeader.includes('hermes_session_rt'), false)
  // 无会话 / target 不匹配 → null（无操作）
  assertEquals(store.applySetCookie(jarValue, 'http://other:1', []), null)
  assertEquals(store.applySetCookie(null, 'http://gw:9119', []), null)
})

Deno.test(
  'store: wsTicketFor mints via gateway with Cookie, no write-back when no rotation',
  async () => {
    const deps = makeDeps()
    const store = new SessionStore(deps)
    const jarValue = await loginAndGetCookie(store)

    const { ticket, setCookie } = await store.wsTicketFor(jarValue, 'http://gw:9119')
    assertEquals(ticket, 'ticket-1')
    assertEquals(setCookie, null)
    const wsCall = deps.calls.find((c) => c.url.endsWith('/api/auth/ws-ticket'))
    assertEquals(wsCall?.headers?.cookie.includes('hermes_session_at=at1'), true)
    // 无会话 → null
    assertEquals((await store.wsTicketFor(null, 'http://gw:9119')).ticket, null)
  },
)

Deno.test(
  'store: wsTicketFor merges rotation cookies into write-back value',
  async () => {
    const base = makeDeps()
    const store = new SessionStore({
      ...base,
      postRaw: async (url: string, body: unknown, headers?: Record<string, string>) => {
        // 保留 login 分支，只覆盖 ws-ticket 分支（返回轮换 Set-Cookie）。
        if (url.endsWith('/auth/password-login')) {
          return base.postRaw(url, body, headers)
        }
        if (url.endsWith('/api/auth/ws-ticket')) {
          return {
            status: 200,
            ok: true,
            setCookies: ['hermes_session_at=at3; Path=/; HttpOnly; Max-Age=900'],
            body: { ticket: 'ticket-2', ttl_seconds: 30 },
          }
        }
        throw new Error(`unexpected: ${url}`)
      },
    })
    const jarValue = await loginAndGetCookie(store)
    const { ticket, setCookie } = await store.wsTicketFor(jarValue, 'http://gw:9119')
    assertEquals(ticket, 'ticket-2')
    assertEquals(
      decodeJarCookie(setCookie!)?.entry.cookieHeader.includes('hermes_session_at=at3'),
      true,
    )
  },
)

Deno.test('store: sessionInfo decodes from cookie, never exposes jar', async () => {
  const store = new SessionStore(makeDeps())
  const jarValue = await loginAndGetCookie(store)

  const info = store.sessionInfo(jarValue, 'http://gw:9119')
  assertEquals(info.connected, true)
  assertEquals(info.provider, 'basic')
  assertEquals(info.username, 'admin')
  assertEquals(JSON.stringify(info).includes('hermes_session_at=at1'), false)
  assertEquals(store.sessionInfo(jarValue, 'http://other:1').connected, false)
  assertEquals(store.sessionInfo(null, 'http://gw:9119').connected, false)
})

Deno.test(
  'store: logout forwards /auth/logout with jar cookie (best-effort)',
  async () => {
    const deps = makeDeps()
    const store = new SessionStore(deps)
    const jarValue = await loginAndGetCookie(store)

    const forwarded = await store.logout(jarValue, 'http://gw:9119')
    assertEquals(forwarded, true)
    const logoutCall = deps.calls.find((c) => c.url.endsWith('/auth/logout'))
    assertEquals(logoutCall?.headers?.cookie.includes('hermes_session_at=at1'), true)
    // 无会话 → 不转发
    assertEquals(await store.logout(null, 'http://gw:9119'), false)
  },
)

// ── 端点处理器（HTTP 面）───────────────────────────────────────────────────

function makeEndpoints(store: SessionStore) {
  return createSessionEndpoints(
    store,
    {
      isHttps: () => false,
    },
    {
      allowTarget: () => true,
    },
  )
}

Deno.test(
  'handleLogin: success → Set-Cookie encoded jar; 401 surfaces detail',
  async () => {
    const store = new SessionStore(makeDeps())
    const endpoints = makeEndpoints(store)

    const ok = await endpoints.handleLogin(
      new Request('http://127.0.0.1:6722/api/proxy/session/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'http://gw:9119',
          provider: 'basic',
          username: 'admin',
          password: 'pw',
        }),
      }),
    )
    assertEquals(ok.status, 200)
    const setCookie = ok.headers.get('set-cookie') ?? ''
    assertEquals(
      setCookie.startsWith(`hermes_session_${targetHash('http://gw:9119')}=`),
      true,
    )
    assertEquals(setCookie.includes('HttpOnly'), true)
    assertEquals(setCookie.includes('Max-Age=2592000'), true)

    // 401 原样透传（带 detail）
    const badStore = new SessionStore(
      makeDeps({
        postRaw: async () => ({
          status: 401,
          ok: false,
          setCookies: [],
          body: { detail: 'Invalid credentials' },
        }),
      }),
    )
    const bad = await makeEndpoints(badStore).handleLogin(
      new Request('http://127.0.0.1:6722/api/proxy/session/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'http://gw:9119',
          provider: 'basic',
          username: 'admin',
          password: 'wrong',
        }),
      }),
    )
    assertEquals(bad.status, 401)
    assertEquals(
      ((await bad.json()) as { detail: string }).detail,
      'Invalid credentials',
    )
  },
)

Deno.test('handleLogin: target not allowed → 403', async () => {
  const store = new SessionStore(makeDeps())
  const endpoints = createSessionEndpoints(
    store,
    { isHttps: () => false },
    {
      allowTarget: (t) => t === 'http://gw:9119',
    },
  )
  const res = await endpoints.handleLogin(
    new Request('http://127.0.0.1:6722/api/proxy/session/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'http://evil:1',
        provider: 'basic',
        username: 'admin',
        password: 'pw',
      }),
    }),
  )
  assertEquals(res.status, 403)
})

Deno.test('handleLogout: forwards gateway logout, clears cookie', async () => {
  const deps = makeDeps()
  const store = new SessionStore(deps)
  const endpoints = makeEndpoints(store)
  const jarValue = await loginAndGetCookie(store)
  const cookieName = passwordSessionCookieName('http://gw:9119')

  const res = await endpoints.handleLogout(
    new Request('http://127.0.0.1:6722/api/proxy/session/logout', {
      method: 'POST',
      headers: { cookie: `${cookieName}=${jarValue}` },
    }),
  )
  assertEquals(res.status, 200)
  const cleared = res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${cookieName}=;`))
  assertEquals(cleared?.includes('Max-Age=0'), true)
})

Deno.test('handleStatus: connected with jar cookie, disconnected without', async () => {
  const store = new SessionStore(makeDeps())
  const endpoints = makeEndpoints(store)
  const jarValue = await loginAndGetCookie(store)
  const cookieName = passwordSessionCookieName('http://gw:9119')

  const ok = await endpoints.handleStatus(
    new Request(
      'http://127.0.0.1:6722/api/proxy/session/status?target=http%3A%2F%2Fgw%3A9119',
      {
        headers: { cookie: `${cookieName}=${jarValue}` },
      },
    ),
  )
  assertEquals(((await ok.json()) as { connected: boolean }).connected, true)

  const empty = await endpoints.handleStatus(
    new Request(
      'http://127.0.0.1:6722/api/proxy/session/status?target=http%3A%2F%2Fgw%3A9119',
    ),
  )
  assertEquals(((await empty.json()) as { connected: boolean }).connected, false)
})

// ── 端点 URL 工具 ───────────────────────────────────────────────────────────

Deno.test('endpoint url builders join prefix paths without double slashes', () => {
  assertEquals(
    passwordLoginUrl('http://gw:9119/'),
    'http://gw:9119/auth/password-login',
  )
  assertEquals(
    passwordLoginUrl('http://gw:9119/hermes'),
    'http://gw:9119/hermes/auth/password-login',
  )
  assertEquals(
    wsTicketUrl('http://gw:9119/hermes/'),
    'http://gw:9119/hermes/api/auth/ws-ticket',
  )
  assertEquals(
    authLogoutUrl('http://gw:9119/hermes'),
    'http://gw:9119/hermes/auth/logout',
  )
})
