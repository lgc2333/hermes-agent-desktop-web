# Handoff — M5 建议任务书

> 生成时间：M4 完成轮末尾。工作区：D:\Coding\hermes-agent-desktop-web。
> 本文是 M5 的实施建议书：M4 交付基线、M5 候选目标、已知坑（含 M4 新发现）。
> 基础上下文见 PLAN.md / CONTEXT.md / PATCHES.md / docs/adr/ / docs/deploy.md，以及
> handoff-hermes-web-m3.md（M3）、handoff-hermes-web-m4.md（M4 任务书）。

## 1. 一句话现状

**M4 打磨与部署已完成并验收**：响应式（移动端状态栏截断修复）、错误/重连态
（断连→Runtime not ready + 重连退避→自动恢复；代理重启→OAuth 回 Sign in，全链路实测
通过）、compose 编排（hermes gateway run + HERMES_DASHBOARD=1 API 载点 + webui
Dockerfile + 默认 URL 下发）、部署文档（docs/deploy.md，auth gate 与 loopback 限制
如实登记）。

## 2. M4 交付基线（已提交 a562d68 + 058ea62）

| 面          | 内容                                                                                                                                                                                                                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| compose     | apps/proxy/Dockerfile（node 构建 SPA → deno 运行时）+ 根 docker-compose.yml（hermes：上游镜像 gateway run + HERMES_DASHBOARD=1，9119 仅映射宿主 loopback，必配 HERMES_DASHBOARD_BASIC_AUTH_USERNAME/PASSWORD；webui：HERMES_DEFAULT_GATEWAY_URL 运行时下发 + PROXY_PASSPHRASE 强校验）+ .dockerignore |
| 部署文档    | docs/deploy.md：拓扑/前置/启动/认证模型（gate + Bearer + ws-ticket）/默认 URL 链路/安全清单/运维/已知限制                                                                                                                                                                                             |
| 响应式      | apps/web/src/web.css 覆盖层：≤640px 状态栏 overflow-x:auto（原 clip 截断 Gateway/backend）；main.tsx import                                                                                                                                                                                           |
| 错误/重连态 | 实测验收：gateway 被杀 → checking/connecting 交替 + Runtime not ready 横幅 + composer 禁用 → 重启自动恢复；代理重启 → OAuth 会话如实未连接（设置页回 Sign in）；gateway.test.ts 新增失效会话用例                                                                                                      |
| 文档        | PATCHES.md §4.4、PLAN.md M4 ✅、README 部署章节、CONTEXT.md 补 auth gate/loopback redirect_uri 术语                                                                                                                                                                                                   |
| 验收        | temp/m4-acceptance.md + temp/m4/（CDP 脚本：响应式探测/状态栏/断连观察/重连闭环/OAuth 会话丢失）                                                                                                                                                                                                      |
| 测试        | deno 42/42 + vitest 42/42（+1 新增）+ typecheck 0                                                                                                                                                                                                                                                     |

## 3. M5 候选目标（按价值排序，建议任选聚焦）

1. **compose 实机部署验证**：M4 本机无 Docker，编排只做了静态验证。找一台有 Docker
   的主机按 docs/deploy.md 走一遍：构建上游镜像、up 起、浏览器全流程（预填 → OAuth
   → 聊天）、kill -9 webui 容器验证 restart 策略与 OAuth 会话丢失提示。
2. **纯公网 OAuth 出路**（M4 遗留限制）：上游 /auth/native/authorize 只收 loopback
   redirect_uri（RFC 8252 §7.3 安全边界，无放宽渠道）。候选方向：
   - 代理侧把 authorize 导航也中转（浏览器只见 webui 同源），redirect_uri 仍 loopback
     → 仅同机/隧道可用，公网无解；
   - 调研上游是否有新版本放宽（subtree 同步时留意 dashboard_auth/routes.py 的
     _validate_loopback_redirect_uri）；
   - 若需支持公网，最小可行 = 文档方案（隧道/VPN），代码不动。
3. **上游 subtree 同步**（当前基准 d2672a3 = 0.17.0；上游已迭代到 0.19.x+）：跑
   scripts/sync-upstream.sh，按 PATCHES.md §4 逐条核对（styles.css @source 行、
   布尔门三处、voice 配置、M1-M4 非 vendor 配套），PATCHES 冲突登记。
4. **Playwright e2e 接入**：PLAN §8 提到上游 e2e 可复用；M4 的 CDP 脚本可固化为
   vitest/playwright 用例（响应式快照、断连恢复），替代手工脚本。
5. **平板/横屏响应式补测**：M4 只验了 390px 竖屏；768/1024 宽度下侧边栏与
   状态栏行为未测。

## 4. M4 已知坑（M5 必读，新增 #11-#13）

1-10. 沿用 M3 任务书 §5（CORS 回显/弹窗拦截/OAuth 手势/loopback redirect_uri/
mock gated boot/HashRouter/ws-ticket Bearer/OAuth 仅代理可用/代理内存态/PORT 兜底）。11. **auth gate 强制**：上游 2026-06 起非 loopback dashboard 绑定必配 auth provider
（HERMES_DASHBOARD_BASIC_AUTH_* 或 OAUTH_CLIENT_ID），--insecure 已失效；
compose 缺失该 env 会启动失败（fail closed）——不是配置错误，是安全硬化。12. **浏览器验收 waitFor 的 ready 陷阱**："Runtime not ready" 文案含 "ready"，
用 includes('ready') 判 gateway 就绪会被骗过；应判状态栏 token 或 boot 区无 error。13. **CDP 杀进程的竞态**：Get-NetTCPConnection -State Listen 在进程刚被杀/重启时
可能返回空（脚本拿空 PID 报错）；验收脚本先确认端口存活再取 PID。14. **注册表会污染后续验收**：改过连接注册表（localStorage hermes-web.connections.v1）
后，后续页面 boot 的目标是改过的连接；换场景先清注册表 + reload。

## 5. 建议技能

- `handoff`：M5 完成后生成下一轮交接
- `chrome-devtools-cli`：compose 实机验收（复用 temp/m4/ 脚本）
- `tdd`：M5 若有新桥行为（如 authorize 中转），先写测试
- `domain-modeling`：纯公网 OAuth 若产生新决策，更新 CONTEXT/ADR

## 6. 当前工作区状态

- git 干净：a562d68（feat M4）+ 058ea62（docs M4）
- 无运行中 dev 拓扑（本轮验收后已全部清理）
- 本机无 Docker：compose 实机验证留给 M5
- 提交前建议：deno task test + pnpm test + typecheck（本轮已全绿）

## 7. 敏感信息

无。compose 所需密码为部署者运行时 env 提供（PROXY_PASSPHRASE /
HERMES_DASHBOARD_BASIC_AUTH_PASSWORD），未落库。
