# 0008 — OAuth 中转：native PKCE 经代理 + httpOnly cookie 会话

M3 落地 OAuth 认证（apps/proxy/src/oauth.ts + bridge 登录/登出面）。
浏览器经代理完成 gateway 的 native PKCE 登录（RFC 8252/7636），token set
只存代理进程内存，浏览器持 httpOnly 会话 cookie；转发面由代理注入
Bearer / ws-ticket。

**Status**: accepted（start/logout 口令要求 superseded by ADR-0015；凭证存储位置 superseded by ADR-0023）

**Context**:

- 桌面端 native-oauth.ts 是 loopback 模式（127.0.0.1 临时监听 + 系统浏览器）；
  Web 端没有 loopback 进程，redirect_uri 必须落在**代理 origin**（浏览器
  同源回调），由代理完成 code 交换。
- 真 gateway（hermes 0.19.x dashboard_auth/native_flow.py）的
  `/auth/native/authorize` 校验 redirect_uri 必须是 loopback 文本
  （127.0.0.1/::1）；代理在浏览器同机部署（dev）时 origin 恰为 loopback，
  开箱即用。远端部署（浏览器 ≠ 代理机器）需要 gateway 放宽或用
  WEB_OAUTH_REDIRECT_URI 覆盖（M4 部署时处理）。
- gated gateway（auth_required）REST 只认 session cookie / Bearer，WS 拒绝
  `?token=`，只认 `?ticket=`（POST /api/auth/ws-ticket 签发，单次 30s）。
- 浏览器 WebSocket 握手会携带同源 httpOnly cookie（schemeful same-site 中
  ws:// 视作 http://，跨端口同站生效），代理可在升级请求里读会话。
- CORS 细节：credentials:'include' 的跨源 fetch 要求预检响应回显
  Access-Control-Allow-Headers（通配符 '*' 在 credentials 模式不被接受）
  且 Allow-Origin 必须回显具体 origin（实测 Chrome 151）。

**Decision**:

- 代理新增 `/auth/native/{start,callback,session,logout}`：
  - start（POST，需 passphrase）—— 生成 PKCE pair + state，返回 gateway
    authorize URL（redirect_uri = 代理 origin + /auth/native/callback）；
  - callback（GET，免 passphrase——只交换内存已登记 state 的 code）——
    校验 state（CSRF）、POST /auth/native/token 换 token set、落内存、
    Set-Cookie `hermes_oauth_session`（HttpOnly; SameSite=Lax; Path=/），
    返回"可关闭窗口"页；
  - session（GET，免检）—— 按 cookie + ?target= 回显连接状态
    （provider/userId/expiresAt/token 前 4 位预览，永不下发 token 本体）；
  - logout（POST，需 passphrase）—— 清内存 + 清 cookie。
- token set 生命周期：进程内存（重启失效，PLAN §6 无持久化）；REST 转发前
  bearerFor() 校验过期并自动经 /auth/native/refresh 轮换（并发去重），
  刷新失败（session_expired）即清会话；WS 拨号前 wsTicketFor() 以 Bearer
  mint 单次 ticket 并替换浏览器的 `?token=`。
- 会话按 target 绑定：cookie 只对登录时的 gateway 生效（多连接不串）。
- 桥（gateway.ts）：oauthLoginConnectionConfig 走 start → window.open 授权
  窗口 → 轮询 session；OAuth 连接不存静态 token、webApi 不发送
  X-Hermes-Session-Token；probe 改读 auth_required/auth_flows（真 gateway
  无 auth_mode 字段）；/api/proxy/meta（defaultGatewayUrl）预填连接表单。

**Consequences**:

- 浏览器无任何 OAuth 凭证（连 token 预览都只是前 4 位）；换浏览器/清 cookie
  需重新登录（与 ADR-0002 "凭证跟浏览器"一致，代价可接受）。
- 代理重启即全部掉线（内存态）；刷新 token 只能覆盖进程生命周期内的过期。
- dev 跨端口（5173 页面 → 6722 代理）需要 credentials:'include' + 上述
  CORS 回显规则；生产同源无 CORS 开销。
- 已确认限制：远端部署的 OAuth 登录需 gateway 接受非 loopback redirect_uri
  （或部署隧道），M4 部署文档跟进。

- mock gateway（dev）补齐 native OAuth 面（authorize/token/refresh/ws-ticket
  - auth_required/auth_flows），MOCK_OAUTH=1 开启，语义与真 gateway 对齐
    （loopback redirect_uri 校验、code 单次消费、PKCE 校验）。
