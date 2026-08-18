# 0023 — 会话凭证进浏览器 cookie，代理完全无状态

代理不再在内存持有 OAuth token set / 密码 cookie jar：登录后把凭证本体
编码进浏览器 httpOnly cookie（代理域），转发面从请求 cookie 解码注入，
refresh/轮换后的新凭证经响应 Set-Cookie 写回。代理重启即无感恢复，
多连接按 target 分 cookie 共存。

**Status**: accepted

**Context**:

- 现状（ADR-0008 / ADR-0013）：代理内存持有凭证（`OAuthStore.sessions` /
  `SessionStore.sessions`），浏览器只持一个指向内存键的 httpOnly 指针
  cookie（`hermes_oauth_session` / `hermes_session`）。代理重启 → 内存清空
  → 全部会话失效，必须重新登录。
- 上游对照：hermes dashboard 的会话凭证**全部在浏览器 cookie**
  （`hermes_session_at/_rt/_provider`，HttpOnly），服务端无会话表；
  basic provider 重启存活靠固定 `HERMES_DASHBOARD_BASIC_AUTH_SECRET`
  签名密钥——因为 gateway 自己是签发方，验签即可恢复。我们的代理
  **不是**签发方（凭证由 gateway/Portal 铸造，代理只中转），无法用
  "固定密钥"这招；要让代理重启后会话仍在，只能让凭证跟着浏览器走，
  与上游同构。
- 桌面端先例：Electron persistent partition 持久化 gateway 域 cookie，
  重启 app 会话不丢。Web 移植没有这个存储面，浏览器 cookie 是唯一
  等价物。

**Decision**:

- 凭证进浏览器 cookie（代理域，HttpOnly + SameSite=Lax + Max-Age=30d，
  HTTPS 时加 Secure）：
  - OAuth：`hermes_oauth_<hash>`（hash = sha256(target) 前 12 hex），值 =
    `base64url(JSON{v:1, t:target, a:accessToken, r:refreshToken, e:expiresAt,
    p:provider, u:userId})`；
  - 密码：`hermes_session_<hash>`，值 = `base64url(JSON{v:1, t:target,
    c:cookieHeader, p:provider, u:username})`。
  - **per-target 命名**（决策 2）：多连接各自独立 cookie 共存，切换连接
    无需重新登录；target 内嵌校验防串连（替代原内存 target 匹配）。
  - 单 cookie 4KB 上限：编码后超限 → 登录失败，返回明确错误（不拆
    cookie、不压缩，保持简单）。
- PKCE 登录中状态（pending）同样进 cookie（决策 4，对齐上游
  `hermes_session_pkce`）：`hermes_oauth_pending`，值 = `base64url(JSON
  {v:1, s:state, t:target, vf:verifier, ru:redirectUri, c:createdAt})`，
  Max-Age=600（10min，对齐 gateway `_PENDING_TTL_SECONDS`）；callback /
  paste 时按 state 校验并消费。同一浏览器同时只有一个进行中的登录。
- 转发面：
  - REST：从请求 cookie 解码凭证注入（Bearer / Cookie 头）；上游响应
    Set-Cookie（密码 jar 轮换）与 refresh 产生的新 token set 都编码成
    新 cookie 值，经响应 Set-Cookie 写回浏览器（`relayRest` 增加
    cookie 写回通道）；
  - WS：拨号前从 cookie 解码 mint 单次 ws-ticket；若触发 refresh，新
    凭证经 **101 upgrade 响应 Set-Cookie** 写回（决策 5，RFC 6455 允许
    握手响应携带 cookie；Portal RT 旋转 + reuse-detection 要求每次
    refresh 后立即写回，否则下次用旧 RT 刷新直接吊销会话）。
- 登出：清对应 target 的 cookie（尽力转发 gateway 登出逻辑保留）。
- 桥层零改动：端点路径 / 响应形状不变，前端只持 cookie 不持值。
- 代理进程内不再有任何持久凭证状态；`refreshing` 并发去重仍为瞬态
  内存（非凭证）。

**Considered Options**:

- 代理内存 Map（现状）：重启即失效，且多连接从未真正生效（cookie 单值
  指针只能指向一个内存条目）→ 被本方案取代。
- 凭证落盘代理侧磁盘（方案 A）：需持久卷、文件权限、多实例失效，且
  打破"代理零落盘"共识 → 否决，cookie 方案零落盘达成同样目标。
- 代理固定签名密钥 + 无状态自验证 cookie（上游 basic provider 同构）：
  代理不是凭证签发方，无法验签 → 否决。

**Consequences**:

- 代理重启 / 容器重建 → 浏览器 cookie 仍在 → 会话无感恢复，**无需重新
  登录**（原始诉求达成）。
- 凭证暴露面从"仅代理内存"变为"浏览器 cookie"：HttpOnly 下 JS/XSS 不可
  读，SameSite=Lax 防跨站携带，信任等级等同桌面端 Electron partition；
  比内存方案多"浏览器本机可读 cookie"暴露面，文档写明。
- 清 cookie / 换浏览器 = 重新登录（与 ADR-0002"凭证跟浏览器"一致）。
- 多连接首次真正可用：各 target 独立 cookie，切换连接免重登。
- 单 cookie 4KB 上限：异常长 token 的 provider 无法登录（正常 provider
  的 token 远小于此）。
- 更新：ADR-0008 / ADR-0013 的"凭证仅内存、重启失效"条款被本方案取代
  （status → superseded by ADR-0023）；AGENTS.md 凭证模型段同步修订。
