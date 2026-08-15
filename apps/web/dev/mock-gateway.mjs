#!/usr/bin/env node
/**
 * M1 mock gateway — 可聊天的 JSON-RPC/WS + REST 双通道 mock 后端。
 *
 * 渲染层走两条通道（handoff §4，M2 起经同源代理转发）：
 *   - REST（经 bridge api()）：/api/config、/api/status、sidebar 会话列表…
 *   - WS（JsonRpcGatewayClient）：session.create/resume、prompt.submit +
 *     流式事件（message.start/delta/complete、session.info）
 *
 * 协议形状（vendor/hermes-shared/src/json-rpc-gateway.ts 已核实）：
 *   - 请求：  { jsonrpc, id, method, params }  → 回 { id, result } / { id, error }
 *   - 事件：  { method: 'event', params: { type, session_id, payload } }
 *
 * setup.status 返回 provider_configured: true → 渲染层跳过 onboarding 直接进聊天。
 *
 * Usage:  node dev/mock-gateway.mjs [port]
 */

import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { WebSocketServer } from 'ws'

const PORT = Number(process.argv[2] ?? process.env.MOCK_GATEWAY_PORT ?? 5180)
const MODEL = 'mock-model'
const PROVIDER = 'mock'

// M3：MOCK_OAUTH=1 时模拟 gated gateway 的 native OAuth 面
// （auth_required + auth_flows: native_pkce + /auth/native/* + ws-ticket）。
const OAUTH_MODE = (process.env.MOCK_OAUTH ?? '0') === '1'

// M5：MOCK_PASSWORD=1 时模拟纯密码门禁 gateway（auth_flows 无 native_pkce ——
// 旧网关或 password-only provider 形态）：/auth/password-login 换 cookie 会话，
// /api/* 全部挂 cookie 门，WS 走 ?ticket=。dev 凭据 admin/admin。
const PASSWORD_MODE = (process.env.MOCK_PASSWORD ?? '0') === '1'

// ── OAuth 模拟状态（进程内存，对齐真 gateway 的 dashboard_auth/native_flow）──
// broker_state -> { code_challenge, redirect_uri, client_state, expires_at }
const oauthPending = new Map()
// gw_code -> { code_challenge, expires_at }
const oauthCodes = new Map()
let oauthSeq = 1

// ── M5：密码会话模拟状态 ──
const mockSessions = new Set()

function hasMockSession(req) {
  const cookie = req.headers.cookie ?? ''
  const match = /(?:^|;)\s*hermes_mock_session=([^;]+)/.exec(cookie)

  return Boolean(match && mockSessions.has(match[1]))
}

function b64url(raw) {
  return Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function s256(verifier) {
  return b64url(createHash('sha256').update(verifier, 'ascii').digest())
}

function oauthTokenSet(seed = oauthSeq++) {
  return {
    access_token: `mock-oauth-access-${seed}-${randomBytes(6).toString('hex')}`,
    refresh_token: `mock-oauth-refresh-${seed}-${randomBytes(6).toString('hex')}`,
    token_type: 'Bearer',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    provider: 'nous',
    user_id: `mock-user-${seed}`,
  }
}

// ── 会话存储 ────────────────────────────────────────────────────────────────
// stored id（durable，侧栏/路由用）↔ runtime id（live 事件用）。mock 简化：
// 每个 stored 会话有一个固定 runtime id，resume 复用。

let nextId = 1

function mintId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${nextId++}`
}

function sessionInfoRow(session, runtime) {
  const messages = session.messages
  const lastMessage = messages[messages.length - 1]
  const preview =
    lastMessage && lastMessage.role === 'assistant'
      ? String(lastMessage.text ?? '')
      : null

  return {
    archived: false,
    cwd: session.cwd || null,
    git_branch: null,
    git_repo_root: null,
    ended_at: session.endedAt,
    id: session.storedId,
    input_tokens: 0,
    is_active: session.isActive !== false,
    last_active: session.lastActive,
    message_count: messages.length,
    model: session.model || MODEL,
    output_tokens: 0,
    pinned: false,
    preview,
    profile: session.profile || 'default',
    is_default_profile: true,
    source: session.source ?? 'desktop',
    started_at: session.startedAt,
    title: session.title || null,
    tool_call_count: 0,
  }
}

const sessions = new Map() // storedId -> session
const byRuntime = new Map() // runtimeId -> storedId

function getSessionByRuntime(runtimeId) {
  const storedId = byRuntime.get(runtimeId)
  return storedId ? sessions.get(storedId) : null
}

function runtimeInfo(session) {
  return {
    approval_mode: 'manual',
    branch: '',
    cwd: session.cwd || '',
    fast: session.fast ?? false,
    model: session.model || MODEL,
    provider: session.provider || PROVIDER,
    reasoning_effort: session.reasoningEffort || '',
    running: false,
    source: session.source ?? 'desktop',
    version: '0.0.0-mock',
    desktop_contract: 1,
    tools: {},
    skills: [],
  }
}

function createSession(params = {}) {
  const storedId = mintId('st')
  const runtimeId = mintId('rt')
  const session = {
    storedId,
    runtimeId,
    title: null,
    cwd: typeof params.cwd === 'string' ? params.cwd : '',
    profile: typeof params.profile === 'string' ? params.profile : null,
    source: typeof params.source === 'string' ? params.source : 'desktop',
    model: typeof params.model === 'string' ? params.model : MODEL,
    provider: typeof params.provider === 'string' ? params.provider : PROVIDER,
    fast: Boolean(params.fast),
    reasoningEffort:
      typeof params.reasoning_effort === 'string' ? params.reasoning_effort : '',
    messages: [],
    startedAt: Math.floor(Date.now() / 1000),
    lastActive: Date.now() / 1000,
    endedAt: null,
    isActive: false,
  }
  sessions.set(storedId, session)
  byRuntime.set(runtimeId, storedId)

  return session
}

function sessionResumePayload(session) {
  return {
    resumed: session.storedId,
    session_id: session.runtimeId,
    message_count: session.messages.length,
    messages: session.messages,
    running: false,
    status: 'idle',
    info: runtimeInfo(session),
  }
}

function sessionCreatePayload(session) {
  return {
    session_id: session.runtimeId,
    stored_session_id: session.storedId,
    message_count: 0,
    messages: [],
    info: runtimeInfo(session),
  }
}

function sessionInfoPayload(session) {
  return {
    ...runtimeInfo(session),
    stored_session_id: session.storedId,
    usage: { calls: 0, input: 0, output: 0, total: 0 },
  }
}

// ── 流式回复（prompt.submit 的推流）────────────────────────────────────────

const REPLY = [
  'Hello from the mock gateway! ',
  'The M1 bridge swap is working: ',
  'this reply was streamed over the JSON-RPC WebSocket, ',
  'word by word, exactly like a real Hermes gateway would. ',
  'You can now send another message.',
].join('')

const STREAM_WORD_MS = 40

function streamTurn(socket, session, userText) {
  const { runtimeId } = session
  const push = (type, payload) => {
    if (socket.readyState !== socket.OPEN) {
      return
    }
    socket.send(
      JSON.stringify({
        method: 'event',
        params: { type, session_id: runtimeId, payload },
      }),
    )
  }

  const now = Math.floor(Date.now() / 1000)
  session.messages.push({
    role: 'user',
    text: userText,
    timestamp: now,
    content: userText,
  })
  session.lastActive = Date.now() / 1000
  session.isActive = true
  session.endedAt = null

  push('message.start', {})

  const words = REPLY.split(' ')
  let i = 0

  const tick = () => {
    if (socket.readyState !== socket.OPEN) {
      return
    }

    if (i >= words.length) {
      const full = REPLY
      session.messages.push({
        role: 'assistant',
        text: full,
        content: full,
        timestamp: now,
        model: session.model || MODEL,
        provider: session.provider || PROVIDER,
      })
      session.endedAt = Date.now() / 1000
      session.lastActive = Date.now() / 1000
      session.isActive = false
      session.title = session.title || userText.slice(0, 60)
      push('message.complete', { text: full, status: 'ok' })
      push('session.info', sessionInfoPayload(session))

      return
    }

    push('message.delta', { text: (i === 0 ? '' : ' ') + words[i] })
    i += 1
    setTimeout(tick, STREAM_WORD_MS)
  }

  tick()
}

// ── WS JSON-RPC 分发 ───────────────────────────────────────────────────────

const RPC_HANDLERS = {
  'setup.status': () => ({ provider_configured: true }),
  'setup.runtime_check': () => ({ ok: true }),
  'config.get': () => ({}),
  'config.set': () => ({ ok: true }),
  'session.create': (params) => sessionCreatePayload(createSession(params ?? {})),
  'session.resume': (params) => {
    const storedId = params?.session_id
    const session = sessions.get(storedId)

    if (!session) {
      throw new Error(`session not found: ${storedId}`)
    }

    session.lastActive = Date.now() / 1000
    session.isActive = true

    return sessionResumePayload(session)
  },
  'session.info': (params) => {
    const runtimeId = params?.session_id
    const session = runtimeId ? getSessionByRuntime(runtimeId) : null

    if (!session) {
      throw new Error(`session not found: ${runtimeId}`)
    }

    return sessionInfoPayload(session)
  },
  'session.activate': (params) => {
    const storedId = params?.session_id
    const session =
      sessions.get(storedId) ?? (params?.session_id ? createSession({}) : null)

    if (!session) {
      throw new Error(`session not found: ${storedId}`)
    }

    return sessionInfoPayload(session)
  },
  'session.delete': (params) => {
    const storedId = params?.session_id
    const session = sessions.get(storedId)

    if (session) {
      byRuntime.delete(session.runtimeId)
      sessions.delete(storedId)
    }

    return { ok: true }
  },
  'prompt.submit': (params, socket) => {
    const session = getSessionByRuntime(params?.session_id) ?? createSession({})
    const text = String(params?.text ?? '')

    // M2 审批模拟：消息含 "approval" 时先推 approval.request，等 approval.respond
    // 后才继续流式（与真 gateway 的 _await_gateway_decision 行为对齐）。
    if (/approval/i.test(text)) {
      session.approvalPending = {
        request_id: mintId('apr'),
        command: 'rm -rf /tmp/demo-artifacts',
        description: 'dangerous command (mock approval)',
        allow_permanent: true,
      }
      session.pendingText = text
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            method: 'event',
            params: {
              type: 'approval.request',
              session_id: session.runtimeId,
              payload: session.approvalPending,
            },
          }),
        )
      }, 80)

      return { ok: true }
    }

    // Fire-and-forget：ACK 立即返回，回复走事件流。
    setTimeout(() => streamTurn(socket, session, text), 50)

    return { ok: true }
  },
  'approval.respond': (params, socket) => {
    const sessionId = params?.session_id
    const session = sessionId ? getSessionByRuntime(sessionId) : null

    if (session?.approvalPending) {
      const pending = session.approvalPending
      session.approvalPending = null
      const text = session.pendingText ?? ''
      session.pendingText = null
      setTimeout(() => streamTurn(socket, session, text), 80)

      return { ok: true, resolved: true, request_id: pending.request_id }
    }

    return { ok: false, error: 'no pending approval' }
  },
  'process.kill': () => ({ ok: true }),
  'approval.received': () => ({ ok: true }),
  'approval.pending': () => ({ ok: true }),
  'clarify.respond': () => ({ ok: true }),
  'reload.env': () => ({ ok: true }),
  'reload.mcp': () => ({ ok: true }),
  'wake.pause': () => ({ ok: true }),
}

function handleRpc(socket, frame) {
  const handler = RPC_HANDLERS[frame.method]

  if (!handler) {
    socket.send(
      JSON.stringify({
        id: frame.id,
        error: { message: `No such RPC method: ${frame.method}` },
      }),
    )

    return
  }

  try {
    const result = handler(frame.params ?? {}, socket)
    socket.send(JSON.stringify({ id: frame.id, result: result ?? null }))
  } catch (error) {
    socket.send(
      JSON.stringify({
        id: frame.id,
        error: { message: error instanceof Error ? error.message : String(error) },
      }),
    )
  }
}

// ── REST（HTTP 同端口，CORS 开放）──────────────────────────────────────────

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  })
  res.end(text)
}

function queryParams(url) {
  const query = new URL(url, 'http://mock').searchParams

  return {
    get: (name) => query.get(name),
    int: (name, fallback) => {
      const raw = query.get(name)
      const n = Number(raw)

      return Number.isFinite(n) ? n : fallback
    },
  }
}

function sessionList(limit) {
  const rows = [...sessions.values()]
    .filter((s) => s.messages.length >= 1)
    .sort((a, b) => b.lastActive - a.lastActive)
    .slice(0, limit)
    .map((s) => sessionInfoRow(s))

  return rows
}

function routeRest(req, res) {
  const url = req.url.split('?')[0]
  const q = queryParams(req.url)
  const method = req.method ?? 'GET'

  // M5：密码门禁 —— /api/* 全部挂会话 cookie 门（/api/status 与
  // /api/auth/providers 是 public 免检面，与真 gateway 的 PUBLIC 列表对齐）。
  // 401 形状带 login_url，与真 gateway middleware 的 _unauth_response 一致。
  if (
    PASSWORD_MODE &&
    url.startsWith('/api/') &&
    url !== '/api/status' &&
    url !== '/api/auth/providers' &&
    !hasMockSession(req)
  ) {
    json(res, 401, {
      error: 'unauthenticated',
      detail: 'Unauthorized',
      login_url: '/login',
    })

    return
  }

  if (url === '/api/status' && method === 'GET') {
    const status = PASSWORD_MODE
      ? {
          ok: true,
          version: '0.0.0-mock',
          auth_required: true,
          // 无 native_pkce：旧网关/密码-only 形态（M5 probe 靠
          // supports_password 归入 oauth 分支）。
          auth_flows: ['cookie'],
          auth_providers: ['password'],
        }
      : OAUTH_MODE
        ? {
            ok: true,
            version: '0.0.0-mock',
            // 真 gateway 无 auth_mode 字段（M3 probe 读 auth_required/auth_flows）；
            // auth_mode 保留给旧 probe 逻辑做兼容。
            auth_mode: 'oauth',
            auth_required: true,
            auth_flows: ['cookie', 'native_pkce'],
            auth_providers: ['nous'],
          }
        : { ok: true, version: '0.0.0-mock', auth_mode: 'token', auth_required: false }
    json(res, 200, status)

    return
  }

  if (url === '/api/config' && method === 'GET') {
    json(res, 200, {})

    return
  }

  if (url === '/api/config/defaults' && method === 'GET') {
    json(res, 200, {})

    return
  }

  if (url === '/api/model/info' && method === 'GET') {
    json(res, 200, { model: MODEL, provider: PROVIDER })

    return
  }

  if (url === '/api/model/options' && method === 'GET') {
    json(res, 200, {
      model: MODEL,
      provider: PROVIDER,
      providers: [
        {
          slug: PROVIDER,
          name: 'Mock provider',
          models: [MODEL],
          featured_models: [MODEL],
          total_models: 1,
          authenticated: true,
          auth_type: 'api_key',
          is_current: true,
          capabilities: { [MODEL]: { fast: true, reasoning: true } },
        },
      ],
    })

    return
  }

  if (url === '/api/profiles/sessions/sidebar' && method === 'GET') {
    const limit = q.int('recents_limit', 40)
    json(res, 200, {
      recents: { sessions: sessionList(limit), profiles_truncated: {} },
      cron: { sessions: [] },
      messaging: { sessions: [] },
    })

    return
  }

  if (url === '/api/profiles/sessions' && method === 'GET') {
    const limit = q.int('limit', 40)
    const rows = sessionList(limit)
    json(res, 200, { sessions: rows, total: rows.length, limit, offset: 0 })

    return
  }

  if (url === '/api/sessions' && method === 'GET') {
    const limit = q.int('limit', 40)
    const rows = sessionList(limit)
    json(res, 200, { sessions: rows, total: rows.length, limit, offset: 0 })

    return
  }

  const sessionMatch = url.match(/^\/api\/sessions\/([^/]+)$/)

  if (sessionMatch && method === 'GET') {
    const session = sessions.get(decodeURIComponent(sessionMatch[1]))

    if (!session) {
      json(res, 404, { detail: 'No such session' })

      return
    }

    json(res, 200, sessionInfoRow(session))

    return
  }

  const messagesMatch = url.match(/^\/api\/sessions\/([^/]+)\/messages$/)

  if (messagesMatch && method === 'GET') {
    const session = sessions.get(decodeURIComponent(messagesMatch[1]))

    if (!session) {
      json(res, 404, { detail: 'No such session' })

      return
    }

    json(res, 200, { session_id: session.storedId, messages: session.messages })

    return
  }

  if (sessionMatch && (method === 'PATCH' || method === 'DELETE')) {
    json(res, 200, { ok: true })

    return
  }

  if (url === '/api/profiles' && method === 'GET') {
    json(res, 200, { profiles: [] })

    return
  }

  if (url === '/api/cron/jobs' && method === 'GET') {
    json(res, 200, [])

    return
  }

  if (url === '/api/env' && method === 'GET') {
    json(res, 200, {})

    return
  }

  if (url === '/api/skills' && method === 'GET') {
    json(res, 200, [])

    return
  }

  if (url === '/api/logs' && method === 'GET') {
    json(res, 200, { path: 'mock', lines: [] })

    return
  }

  // ── M3：native OAuth 模拟面（对齐真 gateway 的 dashboard_auth/native_flow）──

  if (url === '/auth/native/authorize' && method === 'GET') {
    const q = new URL(req.url, 'http://mock')
    const challenge = q.searchParams.get('code_challenge') || ''
    const methodPkce = q.searchParams.get('code_challenge_method') || ''
    const redirectUri = q.searchParams.get('redirect_uri') || ''
    const state = q.searchParams.get('state') || ''

    // 与真 gateway 一致：只接受 S256 + loopback redirect_uri。
    if (methodPkce.toUpperCase() !== 'S256') {
      json(res, 400, { detail: 'code_challenge_method must be S256' })

      return
    }
    if (!challenge) {
      json(res, 400, { detail: 'code_challenge required' })

      return
    }
    if (!redirectUri) {
      json(res, 400, { detail: 'redirect_uri required' })

      return
    }
    const parsedRedirect = new URL(redirectUri)
    if (
      parsedRedirect.protocol !== 'http:' ||
      !['127.0.0.1', '::1'].includes(parsedRedirect.hostname)
    ) {
      json(res, 400, {
        detail:
          'native redirect_uri host must be a loopback IP literal (127.0.0.1 / ::1)',
      })

      return
    }

    // 模拟 IDP 即时完成：直接 302 回 redirect_uri 带一次性 code + state。
    const broker = `broker-${oauthSeq++}`
    const code = `mock-gw-code-${oauthSeq++}`
    oauthPending.set(broker, {
      code_challenge: challenge,
      redirect_uri: redirectUri,
      client_state: state,
      expires_at: Math.floor(Date.now() / 1000) + 600,
    })
    oauthCodes.set(code, {
      code_challenge: challenge,
      expires_at: Math.floor(Date.now() / 1000) + 120,
    })
    const sep = redirectUri.includes('?') ? '&' : '?'
    res.writeHead(302, {
      Location: `${redirectUri}${sep}code=${code}&state=${encodeURIComponent(state)}`,
    })
    res.end()

    return
  }

  if (url === '/auth/native/token' && method === 'POST') {
    let body = {}
    try {
      body = JSON.parse(req.body ?? '{}')
    } catch {
      body = {}
    }
    const code = String(body.code ?? '')
    const verifier = String(body.code_verifier ?? '')
    const issued = oauthCodes.get(code)

    // 单次消费 + PKCE 校验（对齐 redeem_code：pop 后再校验）。
    oauthCodes.delete(code)
    if (!issued || issued.expires_at < Math.floor(Date.now() / 1000)) {
      json(res, 400, { detail: 'Invalid or expired authorization code.' })

      return
    }
    if (s256(verifier) !== issued.code_challenge) {
      json(res, 400, { detail: 'Invalid or expired authorization code.' })

      return
    }

    json(res, 200, oauthTokenSet())

    return
  }

  if (url === '/auth/native/refresh' && method === 'POST') {
    let body = {}
    try {
      body = JSON.parse(req.body ?? '{}')
    } catch {
      body = {}
    }
    if (!String(body.refresh_token ?? '').startsWith('mock-oauth-refresh-')) {
      json(res, 401, {
        error: 'session_expired',
        detail: 'Refresh token expired or invalid; start a new sign-in.',
      })

      return
    }

    json(res, 200, oauthTokenSet())

    return
  }

  // ── M5：密码门禁模拟面（password-login + providers）──────────────────────

  if (url === '/api/auth/providers' && method === 'GET') {
    if (!PASSWORD_MODE) {
      json(res, 503, { detail: 'no auth providers registered' })

      return
    }
    json(res, 200, {
      providers: [
        {
          name: 'password',
          display_name: 'Username & Password',
          supports_password: true,
        },
      ],
    })

    return
  }

  if (url === '/auth/password-login' && method === 'POST') {
    let body = {}
    try {
      body = JSON.parse(req.body ?? '{}')
    } catch {
      body = {}
    }
    // dev 凭据：admin/admin（镜像真 gateway：错误永远 401 Invalid credentials，
    // 不区分用户不存在与密码错误）。
    if (
      String(body.username ?? '') !== 'admin' ||
      String(body.password ?? '') !== 'admin'
    ) {
      json(res, 401, { detail: 'Invalid credentials' })

      return
    }
    const session = `mock-pw-session-${randomBytes(6).toString('hex')}`
    mockSessions.add(session)
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `hermes_mock_session=${session}; Path=/; HttpOnly; Max-Age=900`,
    })
    res.end(JSON.stringify({ ok: true, next: '' }))

    return
  }

  if (url === '/api/auth/ws-ticket' && method === 'POST') {
    // 宽松：模拟已认证会话（真 gateway 这里要求 session cookie / Bearer）。
    json(res, 200, { ticket: `mock-ticket-${oauthSeq++}`, ttl_seconds: 30 })

    return
  }

  json(res, 404, { detail: `No such API endpoint: ${req.url.split('?')[0]}` })
}

const httpServer = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    })
    res.end()

    return
  }

  // 收集请求体（OAuth token/refresh 是 POST JSON）。
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
    if (body.length > 1_000_000) {
      req.destroy()
    }
  })
  req.on('end', () => {
    req.body = body
    routeRest(req, res)
  })
})

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-gateway] REST listening on http://127.0.0.1:${PORT}/api/*`)
})

// ── WS（挂在同一个 HTTP server 上，同端口双协议）────────────────────────────

// M2：路径对齐真 gateway 的 /api/ws（M1 是 mock 特有的 /gateway）。
// token 经 query 传入（真 gateway 恒时比对 _SESSION_TOKEN；mock 宽松接受）。
const wss = new WebSocketServer({ server: httpServer, path: '/api/ws' })

wss.on('connection', (socket, request) => {
  // M5：密码门禁 —— WS 只认单次 ?ticket=（gated gateway 拒绝 ?token=）。
  if (PASSWORD_MODE) {
    const ticket = new URL(request.url, 'http://mock').searchParams.get('ticket') ?? ''
    if (!ticket.startsWith('mock-ticket-')) {
      console.log('[mock-gateway] ws rejected: no ticket')
      socket.close(4401, 'ticket required')

      return
    }
  }

  console.log('[mock-gateway] client connected')

  socket.on('message', (raw) => {
    let frame
    try {
      frame = JSON.parse(String(raw))
    } catch {
      return
    }

    if (frame.id !== undefined && frame.id !== null) {
      handleRpc(socket, frame)

      return
    }

    // Ignore client events.
  })

  socket.on('close', () => console.log('[mock-gateway] client disconnected'))
  socket.on('error', (err) => console.error('[mock-gateway] socket error', err.message))
})

wss.on('listening', () => {
  console.log(`[mock-gateway] WS listening on ws://127.0.0.1:${PORT}/api/ws`)
})

function shutdown() {
  wss.close()
  httpServer.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
