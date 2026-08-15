# 0013 — 密码 "dashboard login" 会话：代理内存 cookie jar

M5 支持用户名/密码门禁的远程 gateway（页面登录 = "dashboard login"）。
代理转发 /auth/password-login、在内存持有 gateway 会话 cookie（jar），
REST 注入 Cookie、WS 经 ws-ticket 拨号；浏览器只持 httpOnly 指针。

**Status**: accepted

**Context**:

- 用户核心诉求（原始动机）：连接部署在远端的密码门禁 dashboard
  （用户私有的远程部署，域名已脱敏）。该形态的登录页是用户名/密码表单
  （POST /auth/password-login → session cookie），没有 OAuth 弹窗可用：
  - 旧网关 / 纯密码 provider 的 auth_flows 不含 native_pkce；
  - 即使含 native_pkce，远端浏览器也过不了 loopback redirect_uri
    （ADR-0008 已知限制）。
- 桌面端对密码网关的处理：同一 sign-in 窗口，Electron persistent
  partition 保存 gateway 域 cookie，REST 与 ws-ticket 全部靠 cookie
  （gateway 的 middleware 认 cookie 会话，AT 过期用 RT 透明轮换）。
- Web 端浏览器**不能**替代理持有 gateway 域 cookie：转发是代理发出的
  服务器到服务器请求，浏览器的 cookie 只随同源请求，不会附到代理出站
  请求上；且 gateway cookie 是 HttpOnly，JS 也读不出来转交代理。
- 但 ADR-0008 已确立先例：代理可以持有**内存态凭证**（OAuth token set），
  浏览器只持 httpOnly 会话 cookie 指向它。cookie jar 与 token set 是同一
  模型的两种形态——AGENTS.md 旧共识"dashboard 密码登录 cookie 绑定
  gateway 域、代理无状态、无法复用"在此先例下不成立，予以修订。

**Decision**:

- 代理新增密码会话中转（apps/proxy/src/session.ts，独立于 oauth.ts）：
  - `POST /api/proxy/session/login` {target, provider, username, password}
    （需 passphrase）—— 转发 `/auth/password-login`，捕获响应 Set-Cookie
    存内存 jar，回发 httpOnly `hermes_session` cookie（值 = 内存键）；
    失败原样透传 gateway 状态（401 Invalid credentials 等）。
  - `GET /api/proxy/session/status?target=`（免检）—— connected /
    provider / username 回显，永不下发 cookie 本体。
  - `POST /api/proxy/session/logout`（需 passphrase）—— 尽力转发
    `/auth/logout`，清 jar 与 cookie。
- 转发面（relay.ts / main.ts）：
  - REST：存在匹配 jar 时注入 `Cookie` 头并摘掉浏览器侧静态 token；
    上游响应里的 Set-Cookie（AT/RT 轮换）合并回 jar；
  - WS：拨号前用 jar 经 `POST /api/auth/ws-ticket` 换单次 ticket →
    `?ticket=`（gated gateway 拒绝 `?token=`）。
- 密码本体只经 浏览器 → 代理 → gateway 一跳传输；代理不落盘、不缓存、
  不记日志；jar 进程内存、重启即失效（与 ADR-0008 token set 相同取舍）。
- probe 增强：读 `/api/auth/providers`（public）的 supports_password；
  全部 provider 支持密码 → authMode 归 **oauth 分支**（cookie/ws-ticket
  机制与 OAuth 完全一致，只是登录换成用户名/密码表单），UI 渲染凭据表单
  （vendor 补丁，见 PATCHES.md §4）。
- 登出幂等：oauthLogoutConnectionConfig 同时清 OAuth 与密码会话（UI 不
  区分登出的是哪一种）。
- mock gateway 新增 MOCK_PASSWORD 模式（dev 凭据 admin/admin）供开发与
  验收。

**Considered Options**:

- 浏览器弹窗打开 gateway /login 页拿 cookie：cookie 落在浏览器 gateway
  域，代理出站请求用不上（HttpOnly 且跨进程不可读）→ 否决。
- 直连模式（无代理）浏览器直接 fetch gateway：cookie 域 + CORS 同样
  无解，且放弃代理的 WS 中继/凭证统一面 → 否决。
- 把密码存浏览器 localStorage 供代理重启后重登：违背 ADR-0002 凭证
  最小化（静态密码比短期会话 cookie 敏感得多），且代理无状态原则下
  重登本就低成本 → 不做，重登一次即可。

**Consequences**:

- 远端密码门禁 gateway 首次可连（用户原始诉求达成）。
- 代理内存态凭证 +1 种（cookie jar）；代理重启后需重新登录（与 OAuth 同）。
- vendor 原位改动 6 处（global.d.ts / 两个表单 / boot overlay / i18n
  en+zh+types），全部登记 PATCHES.md，同步注意已注明。
- 公网部署：密码经代理转发 → 建议 passphrase + HTTPS（转发面既有防护）。
