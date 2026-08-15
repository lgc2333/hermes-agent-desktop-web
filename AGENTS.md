# Hermes-Agent-Desktop-Web — AGENTS.md

把 Hermes 桌面端渲染层移植为浏览器 Web 应用，经一个 **Deno 无状态薄代理** 连接任意远程 Hermes gateway。

## 拓扑（一句话）

```
浏览器 ──同源──> proxy(Deno, 6722) ──X-Hermes-Target 转发──> gateway(/api/* + /api/ws + /auth/native/* + /auth/password-login)
                 └ 托管 SPA dist；零凭证落盘（OAuth token set / 密码会话 cookie 仅内存）
```

## 常用命令

```bash
pnpm install                                   # 首次（pnpm 11，node >=22.22）
pnpm dev                                       # mock(5180) + vite(5173)，直连
pnpm --filter @hermes-web/web dev:proxy        # mock + proxy(6722) + vite，经代理
pnpm --filter @hermes-web/web dev:remote       # vite + proxy，无 mock（连自己的 gateway）
pnpm --filter @hermes-web/web dev:web          # 仅 vite（直连模式）
pnpm --filter @hermes-web/web test             # vitest（桥单测，apps/web）
pnpm typecheck                                 # apps/web 类型检查（typecheck.mjs）
pnpm format                                    # 格式化
pnpm build                                     # 生产构建 → apps/web/dist
cd apps/proxy && deno task test                # 代理单测（deno test，42+ 用例）
deno run --allow-net --allow-read --allow-env apps/proxy/src/main.ts   # 手动起代理
MOCK_OAUTH=1 node apps/web/dev/mock-gateway.mjs 5182   # gated mock（native OAuth 面）
MOCK_PASSWORD=1 node apps/web/dev/mock-gateway.mjs 5183  # 密码门禁 mock（admin/admin，M5）
docker compose up -d --build                  # 生产部署（见 docs/deploy.md）
bash scripts/sync-upstream.sh [tag]            # 上游 subtree 同步（PATCHES.md §3）
```

浏览器验收（headless Chrome + CDP 9224，脚本在 apps/web/e2e/，从仓库根运行）：

```bash
chrome --headless=new --remote-debugging-port=9224 --user-data-dir=temp/e2e-profile --disable-popup-blocking
node apps/web/e2e/cdp-*.mjs   # 场景脚本（OAuth/断连/响应式/隐藏验证；前置拓扑见 apps/web/e2e/README.md）
```

## 项目结构

```
hermes-agent-desktop-web/
├── AGENTS.md / CONTEXT.md / PATCHES.md / README.md      # 共识/术语/登记/入口
├── package.json · pnpm-workspace.yaml · pnpm-lock.yaml  # pnpm workspaces（nodeLinker: hoisted）
├── docker-compose.yml · .dockerignore                   # 生产编排
├── docs/
│   ├── adr/                    # 决策记录
│   └── archived/               # 归档文档（handoff 等）
├── apps/
│   ├── web/                    # SPA 移植入口（Vite 构建 vendor 渲染层）
│   │   ├── index.html          # 真文件（勿改回 symlink，rolldown 拒绝跨目录入口，上游更新注意 sync）
│   │   ├── src/
│   │   │   ├── main.tsx        # 入口：装桥 → import web.css → 挂 vendor 渲染树
│   │   │   ├── web.css         # Web 覆盖层（响应式 + 隐藏桌面专属 UI，非 vendor）
│   │   │   └── bridge/         # WebCapabilityAdapter 三类：browser（浏览器等价）/
│   │   │                       #   gateway（走代理 RPC：注册表/api 转发/OAuth/探测）/
│   │   │                       #   denied（布尔门空实现）；registry.ts = 连接注册表
│   │   ├── dev/                # dev.mjs（四形态启动器）+ mock-gateway.mjs（mock 后端）
│   │   ├── e2e/                # CDP 浏览器验收脚本（cdp-*.mjs，从仓库根跑；AGENTS.md）
│   │   ├── scripts/typecheck.mjs  # 项目类型检查（filter TS5101 等）
│   │   └── vite.config.ts · vitest.config.ts · tsconfig.json
│   └── proxy/                  # Deno 薄代理（无状态，零依赖）
│       ├── src/main.ts         # 单 handler 三分支：静态(排除 /api/ /auth/) → OAuth/meta → 转发
│       ├── src/relay.ts        # REST 透传（Bearer 注入）+ WS 双向中继（ticket）
│       ├── src/oauth.ts        # native PKCE 中转：内存 token set + httpOnly cookie 会话
│       ├── src/session.ts      # 密码 "dashboard login" 会话：内存 cookie jar + /api/proxy/session/*
│       ├── src/*_test.ts       # deno test（main 端到端 / oauth 单测 / relay）
│       ├── Dockerfile          # 多阶段：node 构建 SPA → deno 运行时（= compose webui）
│       └── deno.json           # tasks（dev/test）+ 权限声明
├── vendor/                     # git subtree 引入的上游（只读基准；改必登记 PATCHES.md）
│   ├── hermes-desktop/         # 上游 apps/desktop（渲染层 src/ 是构建来源，别名 '@'）
│   └── hermes-shared/          # 上游 apps/shared（@hermes/shared，JSON-RPC 客户端等）
├── scripts/sync-upstream.sh    # 上游同步（过滤提交法 subtree merge，PATCHES.md §2-3）
├── research/upstream/          # 上游全量克隆（只读调研；不进构建/不走 sync）
└── temp/                       # 临时/验收产物（gitignore）
```

## 工作流 Skill

关于 `CONTEXT.md` 与 `docs/adr/`，参见 Skill `domain-modeling`。如上下文中没有，提醒用户是否安装它：`pnpx skills add https://github.com/mattpocock/skills --skill domain-modeling -p -y`。

## 规则

- 用户决策在写代码前应及时进 ADR。写 ADR 前必须先查看 `domain-modeling` Skill。如在实现时遇到当前情况与 ADR 预想中不符，应及时更新当前 ADR。

- **vendor 纪律**（PLAN §5）：vendor/hermes-desktop|shared 内原位改动收敛到最少；能新加文件就不改旧文件；所有 vendor 改动必须登记 PATCHES.md（含同步注意）。

- **凭证模型**（PLAN §6.1 / ADR-0002）：连接凭证只在浏览器（localStorage 注册表 `hermes-web.connections.v1`）；OAuth token set 只存代理内存（重启失效）；代理零凭证落盘、无状态。不要往代理加持久化/落盘凭证。

- **认证三条路**：token（`X-Hermes-Session-Token` / WS `?token=`，loopback 未 gated 的 gateway）；OAuth（native PKCE 经代理 `/auth/native/*` 中转，REST Bearer + WS 单次 `?ticket=`，仅代理模式可用）；密码会话（"dashboard login"：`/auth/password-login` 换 cookie 会话，代理 `/api/proxy/session/*` 中转，cookie jar 仅内存 + 响应 Set-Cookie 轮换合并，REST Cookie + WS 经 ws-ticket，仅代理模式可用）。密码本体不落盘；代理重启即失效（与 OAuth token set 同取舍，ADR-0013）。

- **布尔门**：用字面 `if (false)` 关功能入口（voice/terminal 等；artifacts/agents 曾 gate，按 ADR-0009 撤销——上游 remote 模式原生支持），不做 feature-flag 系统（gates.ts 已删）；入口关闭后渲染层自然降级。

- **响应式覆盖**收敛在 `apps/web/src/web.css`（非 vendor）：移动端状态栏滚动、Connection mode 只留 remote、boot-failure 隐藏 use-local/repair/open-logs。改 vendor 布局前先看能否 CSS 覆盖。

- **CORS**（M3 实测）：credentials:'include' 的跨源请求必须回显 `Origin` + `Access-Control-Allow-Headers` 回显预检头；`*` 通配符会挂。别回退成 `*`。

- **代理静态面**：`serveStatic` 必须排除 `/api/` 与 `/auth/` 前缀（否则 SPA fallback 吞掉 OAuth 端点）；默认 `webDist` 是 `../../web/dist/`（相对 src/，`defaultWebDist()` 纯函数），别写成 `../web/dist/`。`apps/web/index.html` 是**真文件**（不是 symlink——rolldown 构建拒绝跨目录 symlink 入口）。

- **默认 URL**：`HERMES_DEFAULT_GATEWAY_URL` → `/api/proxy/meta` 运行时下发前端预填；同一 dist 可部署任意环境，改 URL 不用重建。

- **测试纪律**：桥层行为用 vitest（`apps/web/src/bridge/*.test.ts`），代理用 deno test；先写测试再实现（tdd）。改桥/代理协议后跑全量：`deno task test` + `pnpm --filter @hermes-web/web test` + `pnpm typecheck` 三件套全绿才提交。

- **临时文件**放 `temp/`（已 gitignore）；验收记录 `temp/m*-acceptance*`。

## 常见坑

- **CORS 通配符**：credentials 模式预检不接受 `Allow-Headers: *`（Chrome 151 实测）——必须回显。

- **弹窗拦截**：headless 验收需 `--disable-popup-blocking` + 独立 profile；`Runtime.evaluate` 里 `window.open` 无用户手势返回 null → oauthLogin ok:false。

- **OAuth 手势**：`oauthLoginConnectionConfig` 同步段先 `window.open` 再 await（保留手势上下文），别 await 后开窗。

- **loopback redirect_uri**：上游 `/auth/native/authorize` 只收 127.0.0.1/::1（RFC 8252，安全边界无放宽渠道）；dev 同机开箱即用，远端浏览器需 SSH 隧道/VPN（docs/deploy.md §4.3）。

- **mock gated 影响 boot**：`MOCK_OAUTH=1` 的 mock `auth_required=true`，页面 boot 会要求登录——验收先等 "Gateway ready"（注意 "Runtime not ready" 也含 ready 字样，判状态栏 token 更准）。

- **HashRouter**：设置页 URL 是 `/#/settings?tab=gateway`，pushState 无效。
