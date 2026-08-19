/**
 * oauth_test.ts — OAuth 中转逻辑单测（deno test，零外部依赖）。
 * 覆盖：PKCE 生成、URL 构建、回调解析（CSRF）、token 规范化、cookie
 * 编解码（ADR-0023：凭证进浏览器 cookie）、无状态 store（交换/刷新/
 * ws-ticket）、端点处理器。
 */
import { assertEquals, assertStrictEquals, assertThrows } from '@std/assert'
import {
  OAuthStore,
  PENDING_COOKIE_NAME,
  clearSessionCookieValue,
  createOauthEndpoints,
  decodePendingCookie,
  decodeSessionCookie,
  encodePendingCookie,
  encodeSessionCookie,
  generatePkcePair,
  nativeAuthorizeUrl,
  nativeRefreshUrl,
  nativeTokenUrl,
  oauthSessionCookieName,
  parseCallback,
  parseCookies,
  parsePastedCallback,
  parseTokenResponse,
  sessionCookieValue,
  targetHash,
  tokenNeedsRefresh,
  wsTicketUrl,
  type OAuthDeps,
  type NativeTokenSet,
  type PendingLogin,
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
    })
    const parsed = new URL(url)
    assertEquals(
      parsed.origin + parsed.pathname,
      'http://gw:9119/hermes/auth/native/authorize',
    )
    assertEquals(parsed.searchParams.get('code_challenge'), 'cc')
    assertEquals(parsed.searchParams.get('state'), 'st')
    assertEquals(
      parsed.searchParams.get('redirect_uri'),
      'http://127.0.0.1:6722/auth/native/callback',
    )
    const withProvider = nativeAuthorizeUrl('http://gw:9119', {
      challenge: 'cc',
      redirectUri: 'http://127.0.0.1:6722/auth/native/callback',
      state: 'st',
      provider: 'nous',
    })
    assertEquals(new URL(withProvider).searchParams.get('provider'), 'nous')
  },
)

Deno.test('endpoint url builders join prefix paths without double slashes', () => {
  assertEquals(nativeTokenUrl('http://gw:9119/'), 'http://gw:9119/auth/native/token')
  assertEquals(
    nativeTokenUrl('http://gw:9119/hermes'),
    'http://gw:9119/hermes/auth/native/token',
  )
  assertEquals(
    nativeRefreshUrl('http://gw:9119/hermes/'),
    'http://gw:9119/hermes/auth/native/refresh',
  )
  assertEquals(
    wsTicketUrl('http://gw:9119/hermes'),
    'http://gw:9119/hermes/api/auth/ws-ticket',
  )
})

// ── 回调解析 ────────────────────────────────────────────────────────────────

Deno.test('parseCallback: extracts code with matching state', () => {
  const { code } = parseCallback(
    '/auth/native/callback?code=abc&state=expected',
    'expected',
  )
  assertEquals(code, 'abc')
})

Deno.test('parseCallback: rejects state mismatch (CSRF)', () => {
  assertThrows(
    () => parseCallback('/auth/native/callback?code=abc&state=other', 'expected'),
    Error,
    'state mismatch',
  )
})

Deno.test('parseCallback: rejects missing code', () => {
  assertThrows(
    () => parseCallback('/auth/native/callback?state=expected', 'expected'),
    Error,
    'missing authorization code',
  )
})

Deno.test('parseCallback: surfaces gateway error param', () => {
  assertThrows(
    () =>
      parseCallback(
        '/auth/native/callback?error=access_denied&error_description=nope&state=expected',
        'expected',
      ),
    Error,
    'access_denied',
  )
})

// ── Token 规范化 ───────────────────────────────────────────────────────────

Deno.test('parseTokenResponse: normalizes snake_case to camelCase', () => {
  const ts = parseTokenResponse({
    access_token: 'at',
    refresh_token: 'rt',
    expires_at: 1234,
    provider: 'nous',
    user_id: 'u1',
  })
  assertEquals(ts.accessToken, 'at')
  assertEquals(ts.refreshToken, 'rt')
  assertEquals(ts.expiresAt, 1234)
  assertEquals(ts.provider, 'nous')
  assertEquals(ts.userId, 'u1')
})

Deno.test('parseTokenResponse: throws on missing access_token', () => {
  assertThrows(() => parseTokenResponse({}), Error, 'access_token')
})

Deno.test('tokenNeedsRefresh: fresh token is fine, near-expiry needs refresh', () => {
  assertEquals(tokenNeedsRefresh(5000, 1000, 60), false)
  assertEquals(tokenNeedsRefresh(5000, 4950, 60), true)
  assertEquals(tokenNeedsRefresh(0, 1000, 60), true) // 未知过期时间
})

// ── Cookie 工具 ────────────────────────────────────────────────────────────

Deno.test('parseCookies: parses multi-cookie header', () => {
  assertEquals(parseCookies('a=1; b=hello%20world; c=3'), {
    a: '1',
    b: 'hello%20world',
    c: '3',
  })
  assertEquals(parseCookies(null), {})
})

Deno.test('targetHash: stable per target, distinct across targets', () => {
  const a1 = targetHash('http://gw-a:9119')
  const a2 = targetHash('http://gw-a:9119')
  const b = targetHash('http://gw-b:9119')
  assertEquals(a1, a2)
  assertEquals(a1 === b, false)
  assertEquals(/^[0-9a-f]{16}$/.test(a1), true)
})

Deno.test('oauthSessionCookieName: per-target names, stable', () => {
  const t = 'http://gw:9119'
  assertEquals(oauthSessionCookieName(t), `hermes_oauth_${targetHash(t)}`)
  assertEquals(
    oauthSessionCookieName(t) === oauthSessionCookieName('http://other:1'),
    false,
  )
})

// ── 会话 cookie 编解码（ADR-0023）──────────────────────────────────────────

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

Deno.test('encode/decodeSessionCookie: roundtrip preserves all fields', () => {
  const ts = tokenSet({ accessToken: 'at/+=with special chars' })
  const value = encodeSessionCookie('http://gw:9119', ts)
  // base64url：无 cookie 非法字符（; , 空格 等）
  assertEquals(/^[A-Za-z0-9_-]+$/.test(value), true)
  const decoded = decodeSessionCookie(value)
  assertEquals(decoded?.target, 'http://gw:9119')
  assertEquals(decoded?.tokenSet, ts)
})

Deno.test('decodeSessionCookie: garbage / wrong version → null', () => {
  assertEquals(decodeSessionCookie(''), null)
  assertEquals(decodeSessionCookie('not-base64!!!'), null)
  assertEquals(decodeSessionCookie('aGVsbG8='), null) // 合法 b64 但非 JSON
  // 合法 JSON 但 v != 1 → null（版本不符）。
  const v2 = btoa(JSON.stringify({ v: 2, t: 'http://gw:9119', a: 'x' }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  assertEquals(decodeSessionCookie(v2), null)
})

Deno.test(
  'sessionCookieValue: name+value + HttpOnly + SameSite=Lax + Path=/ + Max-Age=30d',
  () => {
    const value = sessionCookieValue(
      'hermes_oauth_0123456789abcdef',
      'encoded-token-set',
    )
    assertEquals(
      value.includes('hermes_oauth_0123456789abcdef=encoded-token-set'),
      true,
    )
    // 新语义：cookie 名由 target hash 决定，值 = 编码凭证
    assertEquals(value.includes('HttpOnly'), true)
    assertEquals(value.includes('SameSite=Lax'), true)
    assertEquals(value.includes('Path=/'), true)
    assertEquals(value.includes('Max-Age=2592000'), true) // 30 天
    // 登出用 Max-Age=0 清除
    assertEquals(
      clearSessionCookieValue('hermes_oauth_0123456789abcdef').includes('Max-Age=0'),
      true,
    )
    // Secure：生产 HTTPS 自动加
    assertEquals(
      sessionCookieValue('hermes_oauth_a', 'x', { secure: true }).includes('Secure'),
      true,
    )
    assertEquals(sessionCookieValue('hermes_oauth_a', 'x').includes('Secure'), false)
  },
)

// ── pending cookie 编解码（ADR-0023，对齐上游 hermes_session_pkce）─────────

Deno.test(
  'encode/decodePendingCookie: roundtrip + TTL enforced by resolve',
  async () => {
    const store = new OAuthStore(makeDeps())
    const { pendingValue } = await store.begin(
      'http://gw:9119',
      'http://127.0.0.1:6722/auth/native/callback',
    )
    const pending = decodePendingCookie(pendingValue)
    if (!pending) {
      throw new Error('pending cookie did not decode')
    }
    assertEquals(pending.target, 'http://gw:9119')
    assertEquals(pending.verifier.length, 43)
    assertEquals(typeof pending.state, 'string')
    assertEquals(pending.state.length > 0, true)
    // resolve 用 state 校验 + TTL
    const ok = store.resolvePending(pendingValue, pending!.state)
    assertEquals(ok?.target, 'http://gw:9119')
    assertEquals(store.resolvePending(pendingValue, 'wrong-state'), null)
    assertEquals(store.resolvePending(null, 'x'), null)
    // 过期：createdAt 超过 10min → null
    const old = { ...pending!, createdAt: Date.now() - 11 * 60_000 }
    const oldValue = encodePendingCookie(old)
    assertEquals(store.resolvePending(oldValue, old.state), null)
  },
)

Deno.test('PENDING_COOKIE_NAME is fixed and short-TTL', () => {
  assertEquals(PENDING_COOKIE_NAME, 'hermes_oauth_pending')
})

// ── 无状态 store（cookie 值直接进出，无内存）───────────────────────────────

function makeDeps(overrides: Partial<OAuthDeps> = {}): OAuthDeps & {
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

/** 模拟一次完整登录：begin → 换 code → 返回会话 cookie 值。 */
async function loginAndGetCookie(
  store: OAuthStore,
  target = 'http://gw:9119',
): Promise<{ cookieValue: string; state: string }> {
  const { authorizeUrl, pendingValue } = await store.begin(
    target,
    'http://127.0.0.1:6722/auth/native/callback',
  )
  const state = new URL(authorizeUrl).searchParams.get('state')!
  const pending = store.resolvePending(pendingValue, state)
  assertEquals(pending !== null, true)
  // 模拟 gateway 回跳 code 交换（走端点同一路径：postJson token 交换）
  const body = await store.deps.postJson(nativeTokenUrl(target), {
    code: 'gw-code',
    code_verifier: pending!.verifier,
  })
  const ts = parseTokenResponse(body)
  return { cookieValue: encodeSessionCookie(target, ts), state }
}

Deno.test(
  'store: begin returns pending cookie value (no memory), no sessionKey',
  async () => {
    const store = new OAuthStore(makeDeps())
    const { authorizeUrl, pendingValue } = await store.begin(
      'http://gw:9119',
      'http://127.0.0.1:6722/auth/native/callback',
    )
    assertEquals(typeof pendingValue, 'string')
    assertEquals(pendingValue.length > 0, true)
    const parsed = new URL(authorizeUrl)
    assertEquals(
      parsed.searchParams.get('redirect_uri'),
      'http://127.0.0.1:6722/auth/native/callback',
    )
    assertEquals(parsed.searchParams.get('code_challenge_method'), 'S256')
  },
)

Deno.test(
  'store: bearerFor decodes cookie, injects bearer, null for wrong target',
  async () => {
    const deps = makeDeps({ now: () => 1000 })
    const store = new OAuthStore(deps)
    const { cookieValue } = await loginAndGetCookie(store)

    const ok = await store.bearerFor(cookieValue, 'http://gw:9119')
    assertEquals(ok.bearer, 'access-1')
    assertEquals(ok.setCookie, null) // 未过期不写回
    // 无 cookie / 伪造值 / target 不匹配
    assertEquals((await store.bearerFor(null, 'http://gw:9119')).bearer, null)
    assertEquals((await store.bearerFor('garbage', 'http://gw:9119')).bearer, null)
    assertEquals((await store.bearerFor(cookieValue, 'http://other:1')).bearer, null)
  },
)

Deno.test(
  'store: near-expiry token triggers refresh, returns new cookie for write-back',
  async () => {
    const deps = makeDeps({ now: () => 4950 }) // expiresAt 5000, skew 60 → 刷新
    const store = new OAuthStore(deps)
    const { cookieValue } = await loginAndGetCookie(store)

    const { bearer, setCookie } = await store.bearerFor(cookieValue, 'http://gw:9119')
    assertEquals(bearer, 'access-2')
    // 刷新后必须写回新 cookie（Portal RT 旋转 + reuse-detection）
    assertEquals(setCookie !== null, true)
    const decoded = decodeSessionCookie(setCookie!)
    assertEquals(decoded?.tokenSet.accessToken, 'access-2')
    assertEquals(decoded?.tokenSet.refreshToken, 'refresh-2')
    // calls = loginAndGetCookie 的 token 交换 + 本次 refresh
    assertEquals(deps.calls.length, 2)
    assertEquals(deps.calls[1].url, 'http://gw:9119/auth/native/refresh')
    // 新 cookie 值再次使用不再触发刷新
    const again = await store.bearerFor(setCookie!, 'http://gw:9119')
    assertEquals(again.bearer, 'access-2')
    assertEquals(again.setCookie, null)
    assertEquals(deps.calls.length, 2)
  },
)

Deno.test('store: refresh session_expired → no bearer, no write-back', async () => {
  const base = makeDeps()
  const deps = {
    ...base,
    now: () => 4950,
    postJson: async (
      url: string,
      body: unknown,
      opts?: { headers?: Record<string, string> },
    ) => {
      // 保留 login 分支（token 交换），只覆盖 refresh 分支。
      if (url.endsWith('/auth/native/token')) {
        return base.postJson(url, body, opts)
      }
      if (url.endsWith('/auth/native/refresh')) {
        return { error: 'session_expired', detail: 'Refresh token expired' }
      }
      throw new Error(`unexpected: ${url}`)
    },
  }
  const store = new OAuthStore(deps)
  const { cookieValue } = await loginAndGetCookie(store)

  const { bearer, setCookie } = await store.bearerFor(cookieValue, 'http://gw:9119')
  assertEquals(bearer, null)
  assertEquals(setCookie, null) // 会话作废：不清 cookie（下次查询自然未连接）
})

Deno.test(
  'store: wsTicketFor mints a ticket via the gateway (with Bearer)',
  async () => {
    const deps = makeDeps({ now: () => 1000 })
    const store = new OAuthStore(deps)
    const { cookieValue } = await loginAndGetCookie(store)

    const { ticket, setCookie } = await store.wsTicketFor(cookieValue, 'http://gw:9119')
    assertEquals(ticket, 'ticket-1')
    assertEquals(setCookie, null)
    // mint 请求必须带 Bearer（/api/auth/ws-ticket 是 auth-required 端点）。
    assertEquals(deps.calls[1].headers?.authorization, 'Bearer access-1')
    assertEquals((await store.wsTicketFor(null, 'http://gw:9119')).ticket, null)
  },
)

Deno.test('store: sessionInfo never exposes the token body', async () => {
  const store = new OAuthStore(makeDeps({ now: () => 1000 }))
  await loginAndGetCookie(store)
  const withSecret = encodeSessionCookie(
    'http://gw:9119',
    tokenSet({ accessToken: 'abcdsecret' }),
  )

  const info = store.sessionInfo(withSecret, 'http://gw:9119')
  assertEquals(info.connected, true)
  assertEquals(info.provider, 'nous')
  assertEquals(info.userId, 'u1')
  assertEquals(info.tokenPreview, 'abcd…')
  assertEquals(JSON.stringify(info).includes('abcdsecret'), false)
  // 无 cookie / target 不匹配 → disconnected
  assertEquals(store.sessionInfo(null, 'http://gw:9119').connected, false)
  assertEquals(store.sessionInfo(withSecret, 'http://other:1').connected, false)
})

// ── 端点处理器（HTTP 面；cookie 值 = 编码凭证）─────────────────────────────

function makeEndpoints(store: OAuthStore) {
  return createOauthEndpoints(
    store,
    {
      isHttps: () => false,
    },
    {
      loopbackPort: 6722,
    },
  )
}

Deno.test(
  'handleStart: requires target, returns authorize url + pending cookie',
  async () => {
    const store = new OAuthStore(makeDeps())
    const endpoints = makeEndpoints(store)

    const missing = await endpoints.handleStart(
      new Request('http://127.0.0.1:6722/auth/native/start', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    )
    assertEquals(missing.status, 400)

    const ok = await endpoints.handleStart(
      new Request('http://127.0.0.1:6722/auth/native/start', {
        method: 'POST',
        body: JSON.stringify({ target: 'http://gw:9119' }),
      }),
    )
    assertEquals(ok.status, 200)
    const body = (await ok.json()) as { authorizeUrl?: string }
    assertEquals(typeof body.authorizeUrl, 'string')
    // 响应带 pending cookie（短 TTL）
    const setCookie = ok.headers.get('set-cookie') ?? ''
    assertEquals(setCookie.includes(`${PENDING_COOKIE_NAME}=`), true)
    assertEquals(setCookie.includes('Max-Age=600'), true)
    assertEquals(setCookie.includes('HttpOnly'), true)
  },
)

Deno.test('handleStart: target not in allowlist → 403', async () => {
  const store = new OAuthStore(makeDeps())
  const endpoints = createOauthEndpoints(
    store,
    { isHttps: () => false },
    {
      loopbackPort: 6722,
      allowTarget: (t) => t === 'http://gw:9119',
    },
  )
  const res = await endpoints.handleStart(
    new Request('http://127.0.0.1:6722/auth/native/start', {
      method: 'POST',
      body: JSON.stringify({ target: 'http://evil:1' }),
    }),
  )
  assertEquals(res.status, 403)
})

Deno.test(
  'handleCallback: exchanges code, sets session cookie, clears pending',
  async () => {
    const store = new OAuthStore(makeDeps())
    const endpoints = makeEndpoints(store)

    // 先 start 拿 pending cookie
    const start = await endpoints.handleStart(
      new Request('http://127.0.0.1:6722/auth/native/start', {
        method: 'POST',
        body: JSON.stringify({ target: 'http://gw:9119' }),
      }),
    )
    const pendingCookie = start.headers.get('set-cookie')!.split(';')[0]
    const state = new URL(
      ((await start.json()) as { authorizeUrl: string }).authorizeUrl,
    ).searchParams.get('state')!

    // gateway 回跳（带 pending cookie）
    const cb = await endpoints.handleCallback(
      new Request(
        `http://127.0.0.1:6722/auth/native/callback?code=gw-code&state=${state}`,
        { headers: { cookie: pendingCookie } },
      ),
    )
    assertEquals(cb.status, 200)
    const setCookies = cb.headers.getSetCookie()
    // 会话 cookie（编码凭证）+ 清 pending
    const sessionSet = setCookies.find((c) => c.startsWith(`hermes_oauth_`))
    assertEquals(sessionSet !== undefined, true)
    assertEquals(sessionSet!.includes('Max-Age=2592000'), true)
    const pendingCleared = setCookies.find((c) =>
      c.startsWith(`${PENDING_COOKIE_NAME}=;`),
    )
    assertEquals(pendingCleared?.includes('Max-Age=0'), true)
    // 会话 cookie 值可解码出 token set
    const sessionValue = sessionSet!.split(';')[0].split('=')[1]
    assertEquals(decodeSessionCookie(sessionValue)?.tokenSet.accessToken, 'access-1')
  },
)

Deno.test('handleCallback: rejects unknown/forged state (CSRF)', async () => {
  const store = new OAuthStore(makeDeps())
  const endpoints = makeEndpoints(store)
  const res = await endpoints.handleCallback(
    new Request('http://127.0.0.1:6722/auth/native/callback?code=abc&state=forged', {
      headers: { cookie: `${PENDING_COOKIE_NAME}=whatever` },
    }),
  )
  assertEquals(res.status, 400)
})

Deno.test('handleCallback: stale pending cookie rejected', async () => {
  const store = new OAuthStore(makeDeps())
  const endpoints = makeEndpoints(store)
  const old = {
    state: 'stale-state',
    target: 'http://gw:9119',
    verifier: 'v'.repeat(43),
    redirectUri: 'http://127.0.0.1:6722/auth/native/callback',
    createdAt: Date.now() - 11 * 60_000,
  } satisfies PendingLogin
  const res = await endpoints.handleCallback(
    new Request(
      `http://127.0.0.1:6722/auth/native/callback?code=abc&state=${old.state}`,
      { headers: { cookie: `${PENDING_COOKIE_NAME}=${encodePendingCookie(old)}` } },
    ),
  )
  assertEquals(res.status, 400)
})

Deno.test(
  'handleSession: connected with session cookie, disconnected without',
  async () => {
    const store = new OAuthStore(makeDeps({ now: () => 1000 }))
    const endpoints = makeEndpoints(store)
    const { cookieValue } = await loginAndGetCookie(store)
    const cookieName = oauthSessionCookieName('http://gw:9119')

    const ok = await endpoints.handleSession(
      new Request(
        'http://127.0.0.1:6722/auth/native/session?target=http%3A%2F%2Fgw%3A9119',
        {
          headers: { cookie: `${cookieName}=${cookieValue}` },
        },
      ),
    )
    const body = (await ok.json()) as { connected: boolean; userId: string }
    assertEquals(body.connected, true)
    assertEquals(body.userId, 'u1')

    const empty = await endpoints.handleSession(
      new Request(
        'http://127.0.0.1:6722/auth/native/session?target=http%3A%2F%2Fgw%3A9119',
      ),
    )
    assertEquals(((await empty.json()) as { connected: boolean }).connected, false)
  },
)

Deno.test('handleLogout: clears the per-target session cookie', async () => {
  const store = new OAuthStore(makeDeps({ now: () => 1000 }))
  const endpoints = makeEndpoints(store)
  const { cookieValue } = await loginAndGetCookie(store)
  const cookieName = oauthSessionCookieName('http://gw:9119')

  const res = await endpoints.handleLogout(
    new Request('http://127.0.0.1:6722/auth/native/logout', {
      method: 'POST',
      headers: { cookie: `${cookieName}=${cookieValue}` },
    }),
  )
  assertEquals(res.status, 200)
  const setCookies = res.headers.getSetCookie()
  const cleared = setCookies.find((c) => c.startsWith(`${cookieName}=;`))
  assertEquals(cleared?.includes('Max-Age=0'), true)
})

// ── 粘贴回跳（ADR-0017）─────────────────────────────────────────────────────

Deno.test('parsePastedCallback: full URL / bare query / trimmed input', () => {
  const full = parsePastedCallback(
    '  http://127.0.0.1:6722/auth/native/callback?code=abc&state=st  ',
  )
  assertEquals(full.code, 'abc')
  assertEquals(full.state, 'st')
  const bare = parsePastedCallback('?code=xyz&state=s2')
  assertEquals(bare.code, 'xyz')
  assertEquals(bare.state, 's2')
})

Deno.test('parsePastedCallback: rejects empty / missing code / invalid URL', () => {
  assertThrows(() => parsePastedCallback(''), Error, 'empty')
  assertThrows(() => parsePastedCallback('?state=st'), Error, 'code')
  assertThrows(() => parsePastedCallback('not a url with spaces !!!'), Error)
})

Deno.test('handlePaste: bare ?code=..&state=.. query completes login', async () => {
  const store = new OAuthStore(makeDeps())
  const endpoints = makeEndpoints(store)

  const start = await endpoints.handleStart(
    new Request('http://127.0.0.1:6722/auth/native/start', {
      method: 'POST',
      body: JSON.stringify({ target: 'http://gw:9119' }),
    }),
  )
  const pendingCookie = start.headers.get('set-cookie')!.split(';')[0]
  const state = new URL(
    ((await start.json()) as { authorizeUrl: string }).authorizeUrl,
  ).searchParams.get('state')!

  const res = await endpoints.handlePaste(
    new Request('http://127.0.0.1:6722/auth/native/paste', {
      method: 'POST',
      headers: { cookie: pendingCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'http://gw:9119',
        url: `?code=gw-code&state=${state}`,
      }),
    }),
  )
  assertEquals(res.status, 200)
  const sessionSet = res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`hermes_oauth_`))
  assertEquals(sessionSet !== undefined, true)
})

Deno.test('handlePaste: target mismatch rejected, pending kept for retry', async () => {
  const store = new OAuthStore(makeDeps())
  const endpoints = makeEndpoints(store)

  const start = await endpoints.handleStart(
    new Request('http://127.0.0.1:6722/auth/native/start', {
      method: 'POST',
      body: JSON.stringify({ target: 'http://gw:9119' }),
    }),
  )
  const pendingCookie = start.headers.get('set-cookie')!.split(';')[0]
  const state = new URL(
    ((await start.json()) as { authorizeUrl: string }).authorizeUrl,
  ).searchParams.get('state')!

  const res = await endpoints.handlePaste(
    new Request('http://127.0.0.1:6722/auth/native/paste', {
      method: 'POST',
      headers: { cookie: pendingCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'http://other:1',
        url: `?code=gw-code&state=${state}`,
      }),
    }),
  )
  assertEquals(res.status, 400)
  assertStrictEquals(
    ((await res.json()) as { detail: string }).detail.includes('target mismatch'),
    true,
  )
})

Deno.test('handlePaste: state mismatch in pasted URL rejected (CSRF)', async () => {
  const store = new OAuthStore(makeDeps())
  const endpoints = makeEndpoints(store)
  const res = await endpoints.handlePaste(
    new Request('http://127.0.0.1:6722/auth/native/paste', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'http://gw:9119', url: '?code=x&state=forged' }),
    }),
  )
  assertEquals(res.status, 400)
})

Deno.test('handlePaste: empty url → 400', async () => {
  const store = new OAuthStore(makeDeps())
  const endpoints = makeEndpoints(store)
  const res = await endpoints.handlePaste(
    new Request('http://127.0.0.1:6722/auth/native/paste', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'http://gw:9119', url: '' }),
    }),
  )
  assertEquals(res.status, 400)
})

// ── 大小超限兜底（ADR-0023 决策 6）─────────────────────────────────────────

Deno.test(
  'encodeSessionCookie: oversized token set rejected (>4KB cookie budget)',
  () => {
    const huge = 'x'.repeat(5_000)
    const ts = tokenSet({ accessToken: huge })
    // 编码后超 4KB → 抛错（调用方登录失败并提示）
    assertThrows(() => encodeSessionCookie('http://gw:9119', ts), Error, 'too large')
  },
)
