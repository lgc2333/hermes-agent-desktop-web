# Handoff — M4 打磨与部署（任务书）

> 生成时间：M3 完成轮末尾。工作区：D:\Coding\hermes-agent-desktop-web。
> 本文是 M4 的实施任务书：M3 交付基线、M4 目标、已知坑。
> 基础上下文见 PLAN.md / CONTEXT.md / PATCHES.md / docs/adr/，以及
> handoff-hermes-web-m1.md（M1）、handoff-hermes-web-m2.md（M2）、
> handoff-hermes-web-m3.md（M3 任务书）。

## 1. 一句话现状

**M3 OAuth + 配置 API 已完成并验收**：代理 PKCE 中转（/auth/native/* +
httpOnly cookie 会话 + 内存 token set + Bearer/ticket 注入），设置页
OAuth 登录（Sign in with nous → 弹窗授权 → 自动回跳 → connected），
刷新后 cookie 会话保持，/api/proxy/meta 默认 URL 预填，mock 具备完整
native OAuth 模拟面。

## 2. M3 交付基线（工作区含未提交改动，见 §7）

| 面         | 内容                                                                                                                                                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 代理 OAuth | apps/proxy/src/oauth.ts：PKCE 生成、authorize/token/refresh/ws-ticket URL、内存 store（pending + sessions + 刷新去重）、cookie 工具、端点处理器；26 单测                                                                                                                                                                                          |
| 代理集成   | main.ts：OAuth 路由（start 需 passphrase，callback/session 免检，logout 需 passphrase）、CORS 回显 Origin + credentials + Allow-Headers 回显、/api/proxy/meta、REST Bearer 注入、WS ticket 注入；relay.ts opts.bearer/opts.ticket；main_test 42 全过（含 OAuth 端到端）                                                                           |
| 桥         | gateway.ts：oauthLogin/LogoutConnectionConfig 真实实现（start→window.open→轮询 session，5min 超时）、webApi credentials include + OAuth 不发静态 token 头、wsUrlFor OAuth 无 token query、probe 读 auth_required/auth_flows/auth_providers、getConnectionConfig 查会话状态 + meta 预填、OAuth 连接清 token；10 新用例，vitest 41/41 + typecheck 0 |
| mock       | mock-gateway.mjs：MOCK_OAUTH=1 时模拟 gated gateway 完整 native OAuth 面（authorize 校验 loopback redirect_uri + S256、token 单次消费 + PKCE 校验、refresh、ws-ticket、status 真字段）                                                                                                                                                            |
| 验收       | temp/m3-acceptance/：cdp-oauth.mjs（桥层全链路）+ cdp-ui.mjs（UI 层：设置页点击登录→聊天→刷新保持）；token 模式回归（5182）通过                                                                                                                                                                                                                   |

## 3. M3 验收记录

- 桥层：OAuth 登录 → config.remoteOauthConnected=true、tokenPreview=mock…；
  真实 WS 聊天流式（代理 mint ticket 替换 token）；刷新后会话保持；登出后断开
- UI 层：设置页（#/settings?tab=gateway）→ 远程模式 probe → "Sign in with nous"
  → 点击 → 授权弹窗自动完成（mock 即时 302）→ 按钮变 Sign out、注册表
  authMode=oauth/token 清空 → 聊天 UI 输入 "hello from m3 ui" → 流式回复 →
  刷新后 OAuth 会话保持 + 会话恢复
- token 模式回归：save(token 5182) → probe token → WS 聊天流式（wsUrl 仍带
  ?token= 形态）
- 测试：deno 42/42 + vitest 41/41 + typecheck exit 0

## 4. M4 目标（PLAN.md §7）

响应式顺手、错误/重连态、compose 编排落地（hermes + webui 双容器 + 默认
URL 下发）、部署文档、PATCHES.md 完整登记。

## 5. M4 已知坑（M3 新发现，必读）

1. **CORS credentials 通配符坑**：credentials:'include' 的跨源 fetch 预检
   不接受 Access-Control-Allow-Headers: _（Chrome 151 实测）——必须回显
   access-control-request-headers；Allow-Origin 也必须回显具体 origin（不能
   '_'）。已修进 main.ts 的 corsHeaders()，别回退。
2. **弹窗拦截**：headless Chrome 验收需 --disable-popup-blocking + 独立
   profile（m3-cdp-profile，9224）；Runtime.evaluate 里 window.open 无用户
   手势会被拦（返回 null → oauthLogin 返回 ok:false）。
3. **OAuth 弹窗手势**：oauthLoginConnectionConfig 在同步段先 window.open
   （保留手势上下文）再 await start 后设 location.href——避免 await 后开窗
   被拦截。
4. **redirect_uri loopback 限制**（真 gateway）：/auth/native/authorize 只收
   127.0.0.1/::1 文本 redirect_uri。dev（代理与浏览器同机）开箱即用；远端
   部署需 gateway 放宽或 OAUTH_REDIRECT_URI 覆盖（M4 部署文档跟进）。
5. **mock 变 gated 影响 boot**：MOCK_OAUTH=1 的 mock 是 auth_required=true，
   页面 boot 探测到 gated 会要求登录——验收脚本先等 "Gateway ready" 再进设置页
   即可；纯 token dev 请用 5182（不带 MOCK_OAUTH）或 dev.mjs（不带 env）。
6. **路由是 HashRouter**：vendor 用 react-router HashRouter，设置页 URL 是
   /#/settings?tab=gateway（pushState /settings 无效）。
7. **ws-ticket 必须带 Bearer**：/api/auth/ws-ticket 是 auth-required 端点，
   OAuthStore.wsTicketFor 经 deps.postJson 传 authorization 头（M3 曾漏掉，
   已修 + 测试覆盖）。
8. **OAuth 连接 WS URL 无 token**：wsUrlFor OAuth 模式只带 target（cookie +
   ticket 认证）；若直连（无代理）OAuth 连接会缺凭证——OAuth 仅代理模式可用。
9. **代理内存态**：代理重启所有 OAuth 会话失效（cookie 还在但内存清空），
   浏览器下次请求 401/未连接；用户重新登录即可。
10. **PORT 空字符串坑**（沿用 M2）：main.ts 的 Number(env) 兜底别删。

## 6. 建议技能

- `tdd`：M4 若加错误/重连态逻辑，先写测试
- `prototype`：compose 拓扑 spike（hermes 容器内 /auth/native 可达性）
- `chrome-devtools-cli`：响应式/重连态浏览器验收（复用 temp/m3-acceptance/）
- `handoff`：M4 完成后生成下一轮交接
- `domain-modeling`：新决策（如远端 OAuth redirect_uri 放宽）更新 CONTEXT/ADR

## 7. 当前工作区状态

- 未提交改动：代理（oauth/main/relay + 测试 + deno.json）、桥（gateway.ts +
  测试）、mock-gateway.mjs、temp/m3-acceptance/、PATCHES.md §4.3、ADR-0008
- 运行中的 dev 拓扑（验收遗留）：mock 5180（MOCK_OAUTH=1）+ mock 5182（token）
  - 代理 6722 + vite 5173 + headless Chrome 9224（m3-cdp-profile）
- 提交前建议：deno task test + pnpm test + typecheck 各跑一遍（提交脚本内）

## 8. 敏感信息

无。mock token 为占位值；OAuth token set 只存代理内存，浏览器仅 httpOnly
cookie 引用；真 gateway 连接凭据仍为用户手填（浏览器 localStorage，
ADR-0002）。
