/**
 * oauth_test.ts — OAuth 中转逻辑单测（deno test，零外部依赖）。
 * 覆盖：PKCE 生成、URL 构建、回调解析（CSRF）、token 规范化、
 * cookie、内存 store（交换/刷新/ws-ticket/登出）、端点处理器。
 */
import { assertEquals, assertStrictEquals, assertThrows } from 'jsr:@std/assert'
import {
  OAuthStore,
  clearSessionCookieValue,
  createOauthEndpoints,
  generatePkcePair,
  nativeAuthorizeUrl,
  nativeRefreshUrl,
  nativeTokenUrl,
  parseCallback,
  parseCookies,
  parseTokenResponse,
  sessionCookieValue,
  tokenNeedsRefresh,
  wsTicketUrl,
  type OAuthDeps,
  type NativeTokenSet,
} from './oauth.ts'

// ── PKCE ────────────────────────────────────────────────────────────────────

Deno.test(
  'generatePkcePair: verifier 43 chars, challenge == S256(verifier)',
  async () => {
    const pair = await generatePkcePair()
    assertEquals(pair.method, 'S256')
    assertEquals(pair.verifier.length, 43)
    assertEquals(pair.challenge.length, 43)
    // RFC 7636: challenge = base64url(SHA256(verifier))
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(pair.verifier),
    )
    const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    assertEquals(pair.challenge, b64)
  },
)

Deno.test('generatePkcePair: two pairs differ (randomness)', async () => {
  const [a, b] = await Promise.all([generatePkcePair(), generatePkcePair()])
  assertEquals(a.verifier === b.verifier, false)
})

// ── URL 构建 ────────────────────────────────────────────────────────────────

Deno.test(
  'nativeAuthorizeUrl: carries PKCE + state + redirect_uri (with prefix path)',
  () => {
    const url = nativeAuthorizeUrl('http://gw:9119/hermes/', {
      challenge: 'cc',
      redirectUri: 'http://127.0.0.1:6722/auth/native/callback',
      state: 'st',
      provider: 'nous',
    })
    const parsed = new URL(url)
    assertEquals(
      parsed.origin + parsed.pathname,
      'http://gw:9119/hermes/auth/native/authorize',
    )
    assertEquals(parsed.searchParams.get('code_challenge'), 'cc')
    assertEquals(parsed.searchParams.get('code_challenge_method'), 'S256')
    assertEquals(
      parsed.searchParams.get('redirect_uri'),
      'http://127.0.0.1:6722/auth/native/callback',
    )
    assertEquals(parsed.searchParams.get('state'), 'st')
    assertEquals(parsed.searchParams.get('provider'), 'nous')
  },
)

Deno.test('endpoint url builders join prefix paths without double slashes', () => {
  assertEquals(nativeTokenUrl('http://gw:9119'), 'http://gw:9119/auth/native/token')
  assertEquals(
    nativeTokenUrl('http://gw:9119/hermes/'),
    'http://gw:9119/hermes/auth/native/token',
  )
  assertEquals(nativeRefreshUrl('http://gw:9119'), 'http://gw:9119/auth/native/refresh')
  assertEquals(wsTicketUrl('http://gw:9119'), 'http://gw:9119/api/auth/ws-ticket')
})

// ── 回调解析（CSRF）────────────────────────────────────────────────────────

Deno.test('parseCallback: extracts code with matching state', () => {
  const { code } = parseCallback('/auth/native/callback?code=abc&state=st', 'st')
  assertEquals(code, 'abc')
})

Deno.test('parseCallback: rejects state mismatch (CSRF)', () => {
  assertThrows(
    () => parseCallback('/auth/native/callback?code=abc&state=evil', 'st'),
    Error,
    'state mismatch',
  )
})

Deno.test('parseCallback: rejects missing code', () => {
  assertThrows(
    () => parseCallback('/auth/native/callback?state=st', 'st'),
    Error,
    'missing authorization code',
  )
})

Deno.test('parseCallback: surfaces gateway error param', () => {
  assertThrows(
    () =>
      parseCallback(
        '/auth/native/callback?error=access_denied&error_description=nope',
        'st',
      ),
    Error,
    'access_denied (nope)',
  )
})

// ── token 响应规范化 ───────────────────────────────────────────────────────

Deno.test('parseTokenResponse: normalizes snake_case to camelCase', () => {
  const tokens = parseTokenResponse({
    access_token: 'at',
    refresh_token: 'rt',
    expires_at: 1234,
    provider: 'nous',
    user_id: 'u1',
  })
  assertEquals(tokens, {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: 1234,
    provider: 'nous',
    userId: 'u1',
  })
})

Deno.test('parseTokenResponse: throws on missing access_token', () => {
  assertThrows(
    () => parseTokenResponse({ refresh_token: 'rt' }),
    Error,
    'missing access_token',
  )
})

// ── 过期判定 ────────────────────────────────────────────────────────────────

Deno.test('tokenNeedsRefresh: fresh token is fine, near-expiry needs refresh', () => {
  assertEquals(tokenNeedsRefresh(2000, 1000, 60), false)
  assertEquals(tokenNeedsRefresh(2000, 1945, 60), true)
  assertEquals(tokenNeedsRefresh(2000, 2000, 60), true)
  // 未知过期时间 ⇒ 视为需要刷新
  assertEquals(tokenNeedsRefresh(0, 1000), true)
  assertEquals(tokenNeedsRefresh(NaN, 1000), true)
})

// ── Cookie ─────────────────────────────────────────────────────────────────

Deno.test('parseCookies: parses multi-cookie header', () => {
  const cookies = parseCookies('a=1; b=two; hermes_oauth_session=sk123')
  assertEquals(cookies.a, '1')
  assertEquals(cookies.b, 'two')
  assertEquals(cookies.hermes_oauth_session, 'sk123')
  assertEquals(Object.keys(parseCookies(null)).length, 0)
})

Deno.test('sessionCookieValue: HttpOnly + SameSite=Lax + Path=/', () => {
  const value = sessionCookieValue('sk')
  assertEquals(value.includes('hermes_oauth_session=sk'), true)
  assertEquals(value.includes('HttpOnly'), true)
  assertEquals(value.includes('SameSite=Lax'), true)
  assertEquals(value.includes('Path=/'), true)
  // 登出用 Max-Age=0 清除
  assertEquals(clearSessionCookieValue().includes('Max-Age=0'), true)
})

// ── Store：完整登录流程（注入 postJson 模拟 gateway）────────────────────────

function tokenSet(overrides: Partial<NativeTokenSet> = {}): NativeTokenSet {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: 5000,
    provider: 'nous',
    userId: 'u1',
    ...overrides,
  }
}

function makeDeps(
  overrides: Partial<OAuthDeps> = {},
): OAuthDeps & {
  calls: { url: string; body: unknown; headers?: Record<string, string> }[]
} {
  const calls: { url: string; body: unknown; headers?: Record<string, string> }[] = []
  return {
    postJson: async (
      url: string,
      body: unknown,
      opts?: { headers?: Record<string, string> },
    ) => {
      calls.push({ url, body, headers: opts?.headers })
      if (url.endsWith('/auth/native/token')) {
        return {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_at: 5000,
          provider: 'nous',
          user_id: 'u1',
        }
      }
      if (url.endsWith('/auth/native/refresh')) {
        return {
          access_token: 'access-2',
          refresh_token: 'refresh-2',
          expires_at: 9000,
          provider: 'nous',
          user_id: 'u1',
        }
      }
      if (url.endsWith('/api/auth/ws-ticket')) {
        return { ticket: 'ticket-1', ttl_seconds: 30 }
      }
      throw new Error(`unexpected url: ${url}`)
    },
    ...overrides,
    calls,
  }
}

async function completeLogin(
  store: OAuthStore,
  target = 'http://gw:9119',
): Promise<{ state: string; sessionKey: string }> {
  const { authorizeUrl, sessionKey } = await store.begin(
    target,
    'http://127.0.0.1:6722/auth/native/callback',
  )
  const state = new URL(authorizeUrl).searchParams.get('state')!
  const pending = store.getPending(state)
  assertEquals(pending !== undefined, true)
  // 模拟 gateway 回跳 + token 交换（直接走 store 内部逻辑：callback 由端点处理器完成，
  // 此处直接验证 store 的存/取）
  return { state, sessionKey }
}

Deno.test(
  'store: begin registers pending and builds authorize url with redirect_uri',
  async () => {
    const store = new OAuthStore(makeDeps())
    const { authorizeUrl, sessionKey } = await store.begin(
      'http://gw:9119',
      'http://127.0.0.1:6722/auth/native/callback',
    )
    assertEquals(typeof sessionKey, 'string')
    const parsed = new URL(authorizeUrl)
    assertEquals(
      parsed.searchParams.get('redirect_uri'),
      'http://127.0.0.1:6722/auth/native/callback',
    )
    assertEquals(parsed.searchParams.get('code_challenge_method'), 'S256')
    assertEquals(store.pendingCount, 1)
  },
)

Deno.test(
  'store: bearerFor returns access token for matching target, null for others',
  async () => {
    const deps = makeDeps({ now: () => 1000 })
    const store = new OAuthStore(deps)
    const { sessionKey } = await store.begin(
      'http://gw:9119',
      'http://127.0.0.1:6722/auth/native/callback',
    )
    store.storeSession(sessionKey, 'http://gw:9119', tokenSet({ expiresAt: 5000 }))

    assertEquals(await store.bearerFor(sessionKey, 'http://gw:9119'), 'access-1')
    // 无会话 / target 不匹配 / 无 cookie
    assertEquals(await store.bearerFor(null, 'http://gw:9119'), null)
    assertEquals(await store.bearerFor('nope', 'http://gw:9119'), null)
    assertEquals(await store.bearerFor(sessionKey, 'http://other:1'), null)
  },
)

Deno.test(
  'store: near-expiry token triggers refresh and updates in place',
  async () => {
    const deps = makeDeps({ now: () => 4950 }) // expiresAt 5000, skew 60 → 需要刷新
    const store = new OAuthStore(deps)
    const { sessionKey } = await store.begin(
      'http://gw:9119',
      'http://127.0.0.1:6722/auth/native/callback',
    )
    store.storeSession(sessionKey, 'http://gw:9119', tokenSet({ expiresAt: 5000 }))

    assertEquals(await store.bearerFor(sessionKey, 'http://gw:9119'), 'access-2')
    assertEquals(deps.calls.length, 1)
    assertEquals(deps.calls[0].url, 'http://gw:9119/auth/native/refresh')
    assertEquals(
      (deps.calls[0].body as Record<string, unknown>).refresh_token,
      'refresh-1',
    )
    // 刷新后不再触发（并发去重 + 新过期时间）
    assertEquals(await store.bearerFor(sessionKey, 'http://gw:9119'), 'access-2')
    assertEquals(deps.calls.length, 1)
  },
)

Deno.test('store: refresh session_expired clears the session', async () => {
  const deps = makeDeps({
    now: () => 4950,
    postJson: async (url: string) => {
      if (url.endsWith('/auth/native/refresh')) {
        return { error: 'session_expired', detail: 'Refresh token expired' }
      }
      throw new Error(`unexpected: ${url}`)
    },
  })
  const store = new OAuthStore(deps)
  const { sessionKey } = await store.begin(
    'http://gw:9119',
    'http://127.0.0.1:6722/auth/native/callback',
  )
  store.storeSession(sessionKey, 'http://gw:9119', tokenSet({ expiresAt: 5000 }))

  assertEquals(await store.bearerFor(sessionKey, 'http://gw:9119'), null)
  assertEquals(store.sessionCount, 0)
  assertEquals(store.sessionInfo(sessionKey, 'http://gw:9119').connected, false)
})

Deno.test(
  'store: wsTicketFor mints a ticket via the gateway (with Bearer)',
  async () => {
    const deps = makeDeps({ now: () => 1000 })
    const store = new OAuthStore(deps)
    const { sessionKey } = await store.begin(
      'http://gw:9119',
      'http://127.0.0.1:6722/auth/native/callback',
    )
    store.storeSession(sessionKey, 'http://gw:9119', tokenSet())

    assertEquals(await store.wsTicketFor(sessionKey, 'http://gw:9119'), 'ticket-1')
    // mint 请求必须带 Bearer（/api/auth/ws-ticket 是 auth-required 端点）。
    assertEquals(deps.calls[0].headers?.authorization, 'Bearer access-1')
    assertEquals(await store.wsTicketFor(null, 'http://gw:9119'), null)
  },
)

Deno.test('store: sessionInfo never exposes the token body', async () => {
  const store = new OAuthStore(makeDeps({ now: () => 1000 }))
  const { sessionKey } = await store.begin(
    'http://gw:9119',
    'http://127.0.0.1:6722/auth/native/callback',
  )
  store.storeSession(
    sessionKey,
    'http://gw:9119',
    tokenSet({ accessToken: 'abcdsecret' }),
  )

  const info = store.sessionInfo(sessionKey, 'http://gw:9119')
  assertEquals(info.connected, true)
  assertEquals(info.provider, 'nous')
  assertEquals(info.userId, 'u1')
  assertEquals(info.tokenPreview, 'abcd…')
  assertEquals(JSON.stringify(info).includes('abcdsecret'), false)
})

Deno.test('store: logout removes the session', async () => {
  const store = new OAuthStore(makeDeps({ now: () => 1000 }))
  const { sessionKey } = await store.begin(
    'http://gw:9119',
    'http://127.0.0.1:6722/auth/native/callback',
  )
  store.storeSession(sessionKey, 'http://gw:9119', tokenSet())
  assertEquals(store.logout(sessionKey), true)
  assertEquals(store.sessionCount, 0)
  assertEquals(store.logout(sessionKey), false)
})

// ── 端点处理器（HTTP 面）───────────────────────────────────────────────────

function makeEndpoints(store: OAuthStore) {
  return createOauthEndpoints(
    store,
    {
      readSessionKey: (request) =>
        parseCookies(request.headers.get('cookie'))['hermes_oauth_session'] ?? null,
    },
    {
      origin: () => 'http://127.0.0.1:6722',
    },
  )
}

Deno.test('handleStart: requires target, returns authorize url', async () => {
  const store = new OAuthStore(makeDeps())
  const endpoints = makeEndpoints(store)

  const bad = await endpoints.handleStart(
    new Request('http://127.0.0.1:6722/auth/native/start', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  )
  assertEquals(bad.status, 400)

  const ok = await endpoints.handleStart(
    new Request('http://127.0.0.1:6722/auth/native/start', {
      method: 'POST',
      body: JSON.stringify({ target: 'http://gw:9119/' }),
    }),
  )
  assertEquals(ok.status, 200)
  const { authorizeUrl } = await ok.json()
  assertEquals(new URL(authorizeUrl).origin, 'http://gw:9119')
  // redirect_uri 指向代理 origin
  assertEquals(
    new URL(authorizeUrl).searchParams.get('redirect_uri'),
    'http://127.0.0.1:6722/auth/native/callback',
  )
})

Deno.test(
  'handleCallback: full flow sets session cookie and stores tokens',
  async () => {
    const deps = makeDeps()
    const store = new OAuthStore(deps)
    const endpoints = makeEndpoints(store)

    const start = await endpoints.handleStart(
      new Request('http://127.0.0.1:6722/auth/native/start', {
        method: 'POST',
        body: JSON.stringify({ target: 'http://gw:9119' }),
      }),
    )
    const { authorizeUrl } = await start.json()
    const state = new URL(authorizeUrl).searchParams.get('state')!

    // gateway 回跳（模拟）
    const cb = await endpoints.handleCallback(
      new Request(
        `http://127.0.0.1:6722/auth/native/callback?code=gw-code&state=${state}`,
      ),
    )
    assertEquals(cb.status, 200)
    const setCookie = cb.headers.get('set-cookie') ?? ''
    assertEquals(setCookie.includes('hermes_oauth_session='), true)
    assertEquals(setCookie.includes('HttpOnly'), true)
    const sessionKey = setCookie.split(';')[0].split('=')[1]

    // token 交换走的是 gateway /auth/native/token
    assertEquals(deps.calls.length, 1)
    assertEquals(deps.calls[0].url, 'http://gw:9119/auth/native/token')
    const tokenBody = deps.calls[0].body as Record<string, unknown>
    assertEquals(tokenBody.code, 'gw-code')
    assertEquals(typeof tokenBody.code_verifier, 'string')

    // 会话可用
    const info = store.sessionInfo(sessionKey, 'http://gw:9119')
    assertEquals(info.connected, true)
    assertEquals(store.pendingCount, 0)
  },
)

Deno.test('handleCallback: rejects unknown/forged state (CSRF)', async () => {
  const store = new OAuthStore(makeDeps())
  const endpoints = makeEndpoints(store)
  const res = await endpoints.handleCallback(
    new Request('http://127.0.0.1:6722/auth/native/callback?code=x&state=forged'),
  )
  assertEquals(res.status, 400)
  assertEquals(store.sessionCount, 0)
})

Deno.test(
  'handleSession: reports connected only with cookie + matching target',
  async () => {
    const deps = makeDeps({ now: () => 1000 })
    const store = new OAuthStore(deps)
    const endpoints = makeEndpoints(store)
    const { sessionKey } = await store.begin(
      'http://gw:9119',
      'http://127.0.0.1:6722/auth/native/callback',
    )
    store.storeSession(sessionKey, 'http://gw:9119', tokenSet())

    const cookie = { cookie: `hermes_oauth_session=${sessionKey}` }
    const ok = await endpoints.handleSession(
      new Request(
        'http://127.0.0.1:6722/auth/native/session?target=http%3A%2F%2Fgw%3A9119',
        { headers: cookie },
      ),
    )
    assertEquals((await ok.json()).connected, true)
    // target 不匹配 → 未连接（防串连）
    const other = await endpoints.handleSession(
      new Request(
        'http://127.0.0.1:6722/auth/native/session?target=http%3A%2F%2Fother%3A1',
        { headers: cookie },
      ),
    )
    assertEquals((await other.json()).connected, false)
    // 无 cookie
    const none = await endpoints.handleSession(
      new Request(
        'http://127.0.0.1:6722/auth/native/session?target=http%3A%2F%2Fgw%3A9119',
      ),
    )
    assertEquals((await none.json()).connected, false)
  },
)

Deno.test('handleLogout: clears session and cookie', async () => {
  const deps = makeDeps({ now: () => 1000 })
  const store = new OAuthStore(deps)
  const endpoints = makeEndpoints(store)
  const { sessionKey } = await store.begin(
    'http://gw:9119',
    'http://127.0.0.1:6722/auth/native/callback',
  )
  store.storeSession(sessionKey, 'http://gw:9119', tokenSet())

  const res = await endpoints.handleLogout(
    new Request('http://127.0.0.1:6722/auth/native/logout', {
      method: 'POST',
      headers: { cookie: `hermes_oauth_session=${sessionKey}` },
    }),
  )
  assertEquals(res.status, 200)
  assertEquals(store.sessionCount, 0)
  const setCookie = res.headers.get('set-cookie') ?? ''
  assertEquals(setCookie.includes('Max-Age=0'), true)
})

// ── 边界 ────────────────────────────────────────────────────────────────────

Deno.test('store: pending entry expires (TTL 10min)', async () => {
  const store = new OAuthStore(makeDeps())
  const { authorizeUrl } = await store.begin(
    'http://gw:9119',
    'http://127.0.0.1:6722/auth/native/callback',
  )
  const state = new URL(authorizeUrl).searchParams.get('state')!
  assertEquals(store.getPending(state) !== undefined, true)
  // 模拟 11 分钟过去（直接改 createdAt）
  const pending = store.getPending(state)!
  ;(pending as { createdAt: number }).createdAt = Date.now() - 11 * 60_000
  assertEquals(store.getPending(state), undefined)
  assertEquals(store.pendingCount, 0)
})
