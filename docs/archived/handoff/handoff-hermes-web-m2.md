# Handoff — M2 代理 + token 模式（任务书）

> 生成时间：2026-08-15（M1 完成轮末尾）。工作区：D:\Coding\hermes-agent-desktop-web。
> 本文是 **M2 的实施任务书**：M1 交付基线、M2 目标、实现要点、验证方式、已知坑。
> 基础上下文见 PLAN.md / CONTEXT.md / PATCHES.md / docs/adr/，以及
> handoff-hermes-web-v4.md（M0 完成 + 环境注意事项全集）、handoff-hermes-web-m1.md（M1 任务书）。
> 仓库 HEAD = ad1f8de，**工作区干净**（M1 三个提交全部落地）。

## 1. 一句话现状

**M1 换桥已完成并验收**：三类 WebCapabilityAdapter 落地（28 个 vitest 全过）、
入口替换、5 处 vendor 布尔门、mock gateway 可聊天（REST + WS 双通道），
浏览器内交互式聊天验收通过（发消息 → 流式回复 → 侧栏新会话）。

## 2. M1 交付基线（HEAD = ad1f8de，工作区干净）

| 提交    | 内容                                                                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 137d3a2 | feat: Web capability bridge - browser/gateway/denied adapters（apps/web/src/bridge/ 10 文件 + 28 测试）                                                                                     |
| 1a68bb5 | feat: chat-capable mock gateway（apps/web/dev/mock-gateway.mjs 重写 + main.tsx 入口替换）                                                                                                   |
| ad1f8de | feat: vendor feature gates, real typecheck, react type pinning（5 处布尔门 + scripts/typecheck.mjs + tsconfig 钉扎 + vitest + vite watch 修复 + PATCHES.md §4/4.1 + CONTEXT.md + ADR-0006） |

**M1 验收记录**（temp/m1-acceptance/ 有 cdp-out.json + final-chat.png 佐证）：

- boot 干净：无 vite-error-overlay / 错误边界 / boot 横幅，直进聊天态
  （mock gateway `setup.status → { provider_configured: true }` 跳过 onboarding）
- 聊天全流程：composer 输入 → Enter → WS 流式回复（message.start → delta → complete）
  → 侧栏出现新会话 → REST 转写（/api/profiles/sessions/sidebar）200
- typecheck 真绿（exit 0）+ vitest 28/28

## 3. M2 目标（PLAN.md §7）

**代理 + token 模式**：薄代理（Deno，零依赖）静态托管 SPA、REST/WS 全量转发、
目标 gateway 切换（X-Hermes-Target）、手填 URL + 静态 token 连接**真 `hermes serve`**，
验证流式回复 / 审批 / 会话恢复。

M1 已预留的落点：

- `apps/web/src/bridge/gateway.ts` 的 `gatewayBaseUrl()`（api() 的 baseUrl）与
  `wsUrlFor()`（WS 拨号 URL）**已集中成两个函数**——M2 换同源代理 + X-Hermes-Target
  只改这两个函数
- `apps/web/src/bridge/registry.ts`（localStorage `hermes-web.connections.v1`，
  ADR-0002 凭证跟浏览器）已就绪——connections.* UI 可直接从注册表长出来
- mock gateway 的协议形状（session.create/resume/info、prompt.submit 事件帧、
  404 错误形状）与真 gateway 对齐，可作转发测试的对照端

## 4. 实现结构（建议，与 PLAN §6 一致）

```
apps/proxy/                     # Deno 薄代理（新建 workspace 外独立目录，deno.json 管理）
├── src/
│   ├── main.ts                 # Deno.serve 单 handler 三分支：
│   │                           #   1) 静态资源（GET 且 dist 存在）→ SPA 产物
│   │                           #   2) 访问控制（X-Hermes-Proxy-Passphrase，可选）
│   │                           #   3) 其余全转发：路径/query/method/headers/body 透传，
│   │                           #      响应流式回传；WS upgrade 按 X-Hermes-Target 拨号
│   └── oauth.ts                # OAuth 内存态中转（M3，本批可留空文件/占位）
├── deno.json                   # 权限声明（allow-net 等）
└── Dockerfile                  # deno:alpine，deno run 直跑（M4 再编排）
```

**浏览器侧改动（极小）**：

- `gateway.ts`：`gatewayBaseUrl()` 指向同源代理（如 `/api/proxy` 前缀转发面或根路径），
  `wsUrlFor()` 指向同源 WS；请求头加 `X-Hermes-Target`（目标 gateway URL）与
  既有 `X-Hermes-Session-Token`（凭证浏览器携带，代理不落盘）
- `registry.ts` 已有 seed 逻辑：M2 连接设置 UI 用 `getConnectionConfig/save/apply/test/probe`
  桥面（已实现）即可手填 URL + token，无需新桥成员
- **`hermes serve` 本地起真后端**：token 模式（`--token` 或 config），
  /api/status 探测 → WS `?token=` 拨号 → prompt.submit 流式

**代理协议要点**（PLAN §6）：

- 单通配 handler，无状态；凭证只透传不落盘
- WS：server 'upgrade' 统一处理（passphrase 校验 → 目标 URL + 浏览器 token 拨号 → 双向中继）
- 目标切换无需代理侧配置（浏览器每次请求带 X-Hermes-Target）
- 默认远端 URL 下发（/api/proxy/meta → { defaultGatewayUrl, requiresPassphrase }）M4 再落地，
  M2 可先不做 meta 面，前端默认连接写死 127.0.0.1:9119（本地 serve）即可

## 5. 验证方式

1. `hermes serve` 起真 gateway（本地安装上游镜像或 `uvx`/pip 跑 hermes；M2 首日先确认
   上游怎么起 headless——PLAN §6.2 提到 `hermes serve --host 0.0.0.0` 具体参数 M2 实测）
2. `deno run apps/proxy/src/main.ts`（静态托管 apps/web/dist）→ 浏览器同源访问代理
3. `pnpm --filter @hermes-web/web dev`（vite :5173 直连代理或 mock，开发态可先经 vite proxy 或
   手填连接 URL）——**注意**：M2 前端静态产物由代理托管，开发迭代仍是 vite dev + 手填 URL
   连代理或直连 gateway 两种方式都要通
4. 浏览器：连接设置页手填 token → 探测成功 → 聊天（流式）→ 审批流（mock 或真 gateway 触发
   approval 请求）→ 会话恢复（刷新页面回到上次会话）
5. mock gateway（:5180）保留作对照：代理转发到 mock 也应全通（验证转发正确性，不依赖真后端）

## 6. 已知坑（M2 实施前必读，含 M1 新发现）

1. **tsc CLI 假绿（M1 起已修，别回退）**：TS 6.0 + baseUrl → TS5101 配置错误，CLI 报完即退、
   不检查文件。typecheck 走 `apps/web/scripts/typecheck.mjs`（编译器 API in-process，
   过滤 TS5101）。别把 package.json 的 typecheck 改回 `tsc --noEmit`。
2. **tsconfig paths react 钉扎（M1 起已修，别动）**：baseUrl 不能删（TS6 新 paths 模式
   Windows 下模块身份重复）；react 类型钉到 root @types/.d.ts（映射包目录会绕过 @types
   查找变 2990 个错误）。ADR-0006 记录了完整推理。
3. **类字段初始化必须用 `=`**：class body 里 `onX: noop` 是类型注解不是初值，
   运行时 undefined 渲染层直接崩（M1 曾踩，denied.ts 已全改 `=`）。
4. **vendor 条件展开丢上下文类型**：`...(false ? [...] : [])` 让外层数组元素失去
   上下文类型。修法：具类型常量（最稳）或内层 `satisfies X[]`（仅单行数组字面量 +
   不紧邻 `)` 时可用，否则 TS1005）。见 PATCHES.md §4。
5. **mock gateway 双协议必须共用 httpServer**（不能各 listen 同端口）。
6. **Windows 沙箱二进制读取**：workspace-write 沙箱下 rolldown 读 pnpm store 的 .node
   报 "stream did not contain valid UTF-8"（vite config 加载失败）；danger-full-access 下正常。
   M2 起 dev server 需在放开模式下跑。
7. **端口冲突**：用户常驻 Chrome 占 9222（CDP 返回 404 是别的服务）；headless Chrome 用
   独立端口（9223）+ 独立 profile（m1-cdp-profile2）避免实例互杀。交互验收用 CDP 手写脚本
   （temp/m1-acceptance/cdp-chat.mjs 可改 URL 复用；ws 包在 apps/web devDeps）。
8. **上游 e2e 是 Electron 目标**：浏览器版验证自建（M1 已建 vitest 基线 + CDP 脚本可复用）。
9. Deno 环境：本机是否有 deno？M2 首日先 `deno --version`；没有则按 PLAN 用
   `deno install`/scoop 装（或先 npm workspace 内用 node 等价 spike，协议转发逻辑可移植）。

## 7. 建议技能（suggested skills）

- `tdd`：代理转发逻辑（REST 透传/WS 中继/header 处理）先写测试
- `prototype`：Deno 代理是 spike（协议转发 + X-Hermes-Target 切换）
- `chrome-devtools-cli`：浏览器端聊天/审批/会话恢复验收（CDP 脚本可复用）
- `domain-modeling`：代理落地后若有术语/决策变动，更新 CONTEXT.md / 新增 ADR
  （候选：代理转发面设计决策、X-Hermes-Target 语义）
- `handoff`：M2 完成后生成下一轮交接

## 8. 敏感信息

无。mock token 为占位值 `mock-token`（仅本地 dev）；真 gateway 连接凭据由用户手填、
只存浏览器 localStorage（ADR-0002）。
