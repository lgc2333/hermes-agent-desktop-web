# 0007 — 代理转发面协议：X-Hermes-Target 头 + WS target query

M2 落地代理转发面（apps/proxy）。浏览器只见代理同源：REST 经
`X-Hermes-Target` 头指定目标 gateway，WS 因浏览器无法携带自定义头，
目标改由 query 参数传递（`?target=`）。代理无状态、凭证只透传不落盘。

**Status**: accepted

**Context**:
- 桌面端桥 REST 走 baseUrl + token 头，WS 拨号 URL 由桥 mint；Web 端要
  "切换目标无需代理配置"（PLAN §6），目标必须随每个请求携带。
- 浏览器 `new WebSocket(url)` 不能设置自定义 header（`Authorization`
  等），所以 WS 的 target 只能走 query 或子路径；选 query（`target=`
  URL-encoded），代理解析后剔除该参数再拼上游 `<target>/api/ws`。
- 真 gateway 的 WS 端点是 `/api/ws?token=`（loopback token 模式），
  与 M1 mock 的 `/gateway` 路径不同；M2 将 mock 对齐到 `/api/ws`。
- `hermes serve` loopback 绑定下 REST/WS 均以 `_SESSION_TOKEN` 校验
  （`HERMES_DASHBOARD_SESSION_TOKEN` 环境变量可固定），`/api/status`
  在 public paths 中公开。

**Decision**:
- REST 转发：代理对非静态请求要求 `X-Hermes-Target`（http/https，
  否则 400）；拼接 `target + pathname + search` 原样转发
  method/headers/body，响应体流式回传；剔除 hop-by-hop 头与代理私有头。
- WS 中继：`Deno.upgradeWebSocket` 接收浏览器侧，向
  `<target>/api/ws<保留 query>` 拨号（`Deno` 原生 WebSocket），双向
  转发；CONNECTING 期间消息入队、OPEN 后 flush；任一侧关闭即传导。
- 访问控制：`PROXY_PASSPHRASE` 配置后转发面校验
  `X-Hermes-Proxy-Passphrase`（恒时比较）；静态面始终公开（index.html
  需可加载）；本地 dev 默认关闭。
- 浏览器侧（bridge）：`proxyBaseUrl()` 为唯一落点（VITE_PROXY_URL →
  生产同源 origin → 直连回退）；`wsUrlFor()` 在代理模式下生成
  `ws://proxy/api/ws?token=..&target=<encoded>`。

**Consequences**:
- 代理无状态可水平扩展；切换 gateway 只改浏览器注册表，代理零配置。
- 渲染层直拼 `connection.baseUrl` 的 URL（插件 WS、媒体下载）在代理
  模式下指向代理但缺 target——Web 版这些面被布尔门关闭，M2 不验证；
  M3 评估对 media/plugin 面做显式兜底（默认目标或拒绝）。
- WS 的 target 编码进 URL，代理日志会看到目标地址（不含凭证）。
- mock gateway 的 WS 路径从 `/gateway` 改为 `/api/ws`，与真 gateway
  对齐，转发测试才有对照意义。
