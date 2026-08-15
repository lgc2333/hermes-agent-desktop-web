# Handoff — M3 OAuth + 配置 API（任务书）

> 生成时间：M2 完成轮末尾。工作区：D:\Coding\hermes-agent-desktop-web。
> 本文是 M3 的实施任务书：M2 交付基线、M3 目标、实现要点、验证方式、已知坑。
> 基础上下文见 PLAN.md / CONTEXT.md / PATCHES.md / docs/adr/，以及
> handoff-hermes-web-m1.md（M1 任务书）、handoff-hermes-web-m2.md（M2 任务书）。
> 仓库 HEAD = da51df9，**工作区干净**（M2 三个提交全部落地）。

## 1. 一句话现状

**M2 代理 + token 模式已完成并验收**：Deno 零依赖薄代理（apps/proxy）静态托管 +
REST/WS 全量转发，X-Hermes-Target 目标切换，浏览器手填 URL + 静态 token 连真
`hermes serve`（0.19.1，opencode-go provider），流式回复 / 审批 / 会话恢复三项
浏览器验收全过。

## 2. M2 交付基线（HEAD = da51df9，工作区干净）

| 提交    | 内容                                                                                                                                |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 06fb49d | feat: M2 thin proxy - Deno zero-dep REST/WS forwarding with X-Hermes-Target（apps/proxy 6 文件 + deno test 12/12 + ADR-0007）       |
| c8120ee | feat: M2 bridge proxy protocol - X-Hermes-Target + /api/ws alignment + approval mock（gateway.ts 代理协议 + mock 对齐 + dev:proxy） |
| da51df9 | docs: M2 patch register entries（PATCHES.md §4.2）                                                                                  |

**M2 验收记录**（temp/m2-acceptance/ 有 cdp-out-mock.json / cdp-out-serve.json /
cdp-out-approval.json + 截图，headless Chrome CDP 9224）：

- 代理→mock：聊天全流程（输入→Enter→WS 流式→侧栏新会话），40+ REST 全走
  代理（:6722），WS URL 带 `?token=..&target=<encoded>`
- 代理→真 serve（:9119，token=hermes-web-m2-token）：连接建立后流式回复
  （"已思考 m2-serve-ok"，deepseek-v4-flash），刷新页面会话恢复（消息仍在）
- 审批流（经代理）：消息含 "approval" → mock 推 approval.request → 审批条
  （Run/Reject）→ 点击 Run → approval.respond → 流式继续完成
- 测试：vitest 31/31 + typecheck exit 0 + deno test 12/12

## 3. M3 目标（PLAN.md §7）

**OAuth + 配置 API**：native PKCE 客户端、httpOnly cookie token 存储、
设置页（连接 + 目标 gateway 管理 UI）。

M2 已预留的落点：

- `apps/proxy/src/oauth.ts` 占位已建（M3 实现 /auth/native/* 中转 + 内存态
  token set + httpOnly cookie）
- 上游 native-oauth.ts 是零 Electron 依赖的纯 TS（PLAN §2：PKCE/state 生成、
  能力判断），可直接搬进代理或参考
- `/api/proxy/meta`（defaultGatewayUrl + requiresPassphrase 下发）M2 未做，
  M3/M4 落地；前端连接表单自动预填
- bridge 的 `oauthLoginConnectionConfig` 目前直拒（M1 注释）；M3 换真实实现
- connections 注册表（bridge connections.* 面）已就绪，设置页 UI 可从注册表长出

## 4. 实现结构（建议，与 PLAN §6 一致）

```
apps/proxy/src/oauth.ts      # M3：PKCE 中转
apps/web/src/bridge/         # oauthLogin/Logout 真实实现 + 设置页接线
```

浏览器侧注意：

- OAuth 模式 WS 走 `?ticket=`（gateway 签发，单次 30s TTL），与 token 模式
  的 `?token=` 不同；代理 WS 中继需透传任意 query（已支持，保留除 target 外
  全部参数）
- 真 gateway gated 模式（auth_required）下 `_SESSION_TOKEN` 不注入、WS 拒绝
  `?token=`，只能用 ticket——代理转发时浏览器凭证随 query 走，天然兼容
- gateway-settings.tsx 已有 OAuth 按钮接线（桥的 oauthLoginConnectionConfig），
  渲染层无需改

## 5. 验证方式

1. `deno test`（apps/proxy）+ `pnpm test` + `pnpm typecheck`（apps/web）
2. mock 起 OAuth 模拟（或直连真 gateway 的 native OAuth 面）
3. 浏览器：设置页选 OAuth → 弹出授权页 → 回跳 → 聊天；刷新后 cookie 会话保持
4. 会话恢复 + 审批回归（复用 temp/m2-acceptance/ 脚本）

## 6. 已知坑（M3 实施前必读，含 M2 新发现）

1. **M1 三条别回退**：typecheck 走 scripts/typecheck.mjs（禁 tsc --noEmit）；
   tsconfig baseUrl 别删、react 类型钉扎别动；类字段初始化必须 `=`。
2. **vendor 条件展开丢上下文类型**：用具类型常量，勿用内联对象展开。
3. **Windows 沙箱**：vite dev 需放开模式（pnpm store .node 读取）；headless
   Chrome 用独立端口（9224）+ 独立 profile（m2-cdp-profile），别碰用户常驻 9222。
4. **代理端口被用户改过**：apps/proxy/src/main.ts 的 PORT 默认值 =
   **6722**（用户手工改），dev.mjs 的 VITE_PROXY_URL 与之同步；改端口要两处一起。
5. **PORT 空字符串坑**：Windows 环境 PORT='' 时 Number('') = 0 → Deno 随机端口；
   main.ts 已有兜底（rawPort && rawPort.trim() 判定），别删。
6. **WS 目标双斜杠坑**：target 根路径时拼 URL 会出 `//api/ws`，relay.ts
   upstreamWsUrl 已处理（pathname === '/' 省略），有回归测试。
7. **Deno permissions 配置格式**：deno.json 的 "permissions" 字段要求
   PermissionsObject，直接用 tasks 的 --allow-* 参数最省事。
8. **execCommand('insertText') 在新版 headless Chrome 失效**：CDP 验收脚本
   用 Input.insertText（见 temp/m2-acceptance/*.mjs）。
9. **真 serve 首次连接有暖机延迟**：验收脚本需轮询 "checking/connecting"
   消失后再发消息（约 5-15s）。
10. **serve 的 setup.status/setup.runtime_check 存在**（provider_configured:
    true）；M1 观察到的"无响应"是脚本时序问题，非缺方法。
11. **serve 无 provider 时 prompt.submit 报 error 事件但消息会 complete**
    （错误文本作为回复）；配 provider 后正常流式。
12. **serve 认证**：loopback 模式 REST 需 X-Hermes-Session-Token（= 进程
    HERMES_DASHBOARD_SESSION_TOKEN 或随机），WS 需 ?token=；/api/status 公开。
13. **dev.mjs 子进程清理**：pwsh 后台任务 kill 不杀 dev.mjs 的孙进程，
    重启前 Get-Process deno | Stop-Process。

## 7. 建议技能（suggested skills）

- `tdd`：OAuth 中转逻辑先写测试（deno test 模式已建立）
- `prototype`：PKCE 流程 spike（上游 native-oauth.ts 可参考）
- `chrome-devtools-cli`：浏览器 OAuth 回跳验收（CDP 脚本复用 m2-acceptance）
- `handoff`：M3 完成后生成下一轮交接
- `domain-modeling`：OAuth 术语（OAuth token set / ticket 已有词条）若有新增
  决策更新 CONTEXT.md / ADR

## 8. 敏感信息

无。mock token 为占位值 `mock-token`；真 gateway 连接凭据 = 用户手填
（本机 serve token：hermes-web-m2-token，仅本地 dev，存浏览器 localStorage
ADR-0002）。DSH 的 OPENCODE_GO_API_KEY 是用户机器上的 hermes provider 配置
（serve 的 env），不在仓库内。
