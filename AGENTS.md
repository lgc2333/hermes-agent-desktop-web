# Hermes-Agent-Desktop-Web — AGENTS.md

**注意：**如本文件同级有 `AGENTS.local.md` 文件且它不在上下文中，请先读取它再继续工作。此文件未被 git track，请注意检查。

编写面向 AI Agent 的入口文档时（如 `AGENTS(.local).md` / `PATCHES.md`），保持简洁与 token 高效，如在代码注释或其他文档中详细解释过的行为只留简短解释与指针。

把 Hermes 桌面端渲染层移植为浏览器 Web 应用，经一个 **Deno 无状态薄代理** 连接任意远程 Hermes gateway。

## 拓扑

```
浏览器 ──同源──> proxy(Deno, 6722) ──X-Hermes-Target 转发──> gateway(/api/* + /api/ws + /auth/native/* + /auth/password-login)
                 └ 托管 SPA dist；零凭证落盘（OAuth token set / 密码会话 cookie 在浏览器 httpOnly cookie，代理无状态，ADR-0023）
```

## 常用命令

```bash
pnpm install     # 首次（pnpm 11，node >=22.22）
pnpm dev         # mock(5180) + proxy(6722) + vite(5173)，SPA 只走代理（ADR-0016）
pnpm dev:remote  # proxy + vite，无 mock（连自己的 gateway）
pnpm --filter @hermes-web/web test  # vitest（桥单测，apps/web）
pnpm typecheck   # apps/web 类型检查（typecheck.mjs）
pnpm format      # 格式化
pnpm build       # 生产构建 → apps/web/dist
cd apps/proxy && deno task test  # 代理单测（deno test，42+ 用例）
deno run --allow-net --allow-read --allow-env apps/proxy/src/main.ts  # 手动起代理
MOCK_OAUTH=1 node apps/web/dev/mock-gateway.mjs 5182  # gated mock（native OAuth 面）
MOCK_PASSWORD=1 node apps/web/dev/mock-gateway.mjs 5183  # 密码门禁 mock（admin/admin，M5）
docker compose up -d --build  # 生产部署（见 README.md「快速开始」）
bash scripts/sync-upstream.sh [tag]  # 上游 subtree 同步（PATCHES.md §3）
```

浏览器验收（Vitest + Playwright 客户端驱动 Chromium，独立于 dev 端口 5173/6722/5180，见 apps/web/e2e/AGENTS.md）：

```bash
pnpm --filter @hermes-web/web e2e:install   # 一次性装 Chromium
pnpm --filter @hermes-web/web test:e2e      # 全量 e2e（串行单 worker）
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
│   │   ├── dev/                # dev.mjs（恒起代理；--no-mock 形态）+ mock-gateway.mjs（mock 后端）
│   │   ├── e2e/                # Vitest + Playwright 客户端 e2e（*.e2e.ts；端口用 E2E_*_PORT，见 e2e/AGENTS.md）
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

写 `CONTEXT.md` 或 `docs/adr/` 之前，**必须**先看 Skill `domain-modeling`。如上下文中没有，提醒用户是否安装它：`pnpx skills add https://github.com/mattpocock/skills --skill domain-modeling -p -y`。

## 规则

- 用户决策在写代码前应及时进 ADR。写 ADR 前必须先查看 `domain-modeling` Skill。如在实现时遇到当前情况与 ADR 预想中不符，应及时更新当前 ADR。非本次对话中创建的 ADR 按惯例不应该修改其内容，只能修改 status，除非用户特别说明。

- **版本 bump**：只看本项目（Web patch / 代理 / bridge / 本地代码）改动大小，不看上游 vendor 更新规模。本项目无大改 → 一律 **patch**（x.y.z → x.y.(z+1)）；本项目功能性大改 → minor；破坏性变更 → major。上游同步内容再大也不算 bump 理由。

- **vendor 纪律**：vendor/hermes-desktop|shared 内原位改动收敛到最少；能新加文件就不改旧文件；所有 vendor 改动必须登记 PATCHES.md（含同步注意）。

- **凭证模型**（ADR-0002/0023）：连接凭证只在浏览器（localStorage 注册表 + 代理域 httpOnly cookie），代理零凭证内存态、零落盘、重启无感恢复。勿往代理加持久化/落盘凭证。具体编码见 proxy 头注（main/oauth/session.ts）。

- **认证三条路**（协议细节见 relay/oauth/session.ts 头注，ADR-0023）：token（`X-Hermes-Session-Token` / WS `?token=`，loopback 未 gated 的 gateway）；OAuth（native PKCE 经代理 `/auth/native/*` 中转，REST Bearer + WS `?ticket=`，仅代理模式）；密码会话（"dashboard login"：`/auth/password-login` 换 cookie，`/api/proxy/session/*` 中转，仅代理模式）。密码本体不落盘。

- **布尔门**：用字面 `if (false)` 关功能入口，不做 feature-flag 系统（gates.ts 已删）；语义权威见 denied.ts 头注 + ADR-0009（artifacts/agents 的 gate 已撤销）。

- **响应式覆盖**收敛在 `apps/web/src/web.css`（非 vendor）：移动端状态栏滚动、Connection mode 只留 remote、boot-failure 隐藏 use-local/repair/open-logs。改 vendor 布局前先看能否 CSS 覆盖。

- **CORS**：credentials:'include' 的跨源请求必须回显 `Origin` + `Access-Control-Allow-Headers` 预检头；`*` 通配符会挂（Chrome 151 实测）。实现见 main.ts corsHeaders。

- **代理静态面**：`serveStatic` 必须排除 `/api/` `/auth/` 前缀（否则 SPA fallback 吞掉 OAuth 端点）；默认 `webDist` = `../../web/dist/`（`defaultWebDist()` 纯函数，别写 `../web/dist/`）；`resolveWebDist()` 归一化成带尾斜杠的 file URL（Dockerfile ENV 裸路径坑）。`apps/web/index.html` 是**真文件**（非 symlink，rolldown 拒跨目录入口）。

- **默认 URL**：`WEB_DEFAULT_GATEWAY_URL` → `/api/proxy/meta` 运行时下发前端预填；同 dist 可部署任意环境。SPA 恒经同源代理（ADR-0016，见 gateway/rest.ts）：`proxyBaseUrl()` 恒非空，无直连路径。

- **格式**：一切改动（含文档 `.md`）提交前跑 `pnpm format`（= `prettier -cw .`）格式化，保持全仓一致风格。

- **测试纪律**：桥层行为用 vitest（`apps/web/src/bridge/*.test.ts`），代理用 deno test；先写测试再实现（tdd）。改桥/代理协议后跑全量：`deno task test` + `pnpm --filter @hermes-web/web test` + `pnpm typecheck` 三件套全绿才提交。

- **临时文件**放 `temp/`（已 gitignore）；验收记录 `temp/m*-acceptance*`。

## 常见坑

- **弹窗拦截**：headless 验收需 `--disable-popup-blocking` + 独立 profile；`Runtime.evaluate` 里 `window.open` 无用户手势返回 null → oauthLogin ok:false。OAuth 手势本体见 gateway/oauth.ts 注释（同步段先 `window.open` 再 await，保留手势上下文）。

- **loopback redirect_uri**：上游 `/auth/native/authorize` 只收 127.0.0.1/::1（RFC 8252，安全边界无放宽渠道，见 oauth.ts）；dev 同机开箱即用，远端浏览器需 SSH 隧道/VPN（README.md「安全模型」）。

- **mock gated 影响 boot**：`MOCK_OAUTH=1` 的 mock `auth_required=true`，页面 boot 会要求登录——验收先等 "Gateway ready"（注意 "Runtime not ready" 也含 ready 字样，判状态栏 token 更准）。

- **HashRouter**：设置页 URL 是 `/#/settings?tab=gateway`，pushState 无效。

- **直连已删（ADR-0016，见 gateway/rest.ts）**：SPA 无直连路径，`proxyBaseUrl()` 恒非空；`vite preview`/静态裸托管不是可用拓扑（/api/* 会打 SPA fallback）。旧镜像（v0.1.0 tag 前）bundle 里 `proxyBaseUrl()` 被编译成 `return null` → `/api/proxy/meta` 0 请求、预填永不触发、探活假信号——部署必须用新构建镜像。

- **上游 sync 必须浅取 + 用后清理**（PATCHES.md §3）：全量 `git fetch` 会把整个 monorepo 对象灌进本地，叠加 `tmp_pack_*` 残留让 .git 膨胀到 GB 级（`.git gc` 不自动删需手动清）。用 `git fetch upstream --depth=1 <tag>`（脚本已内置），对 tag 须 `^{commit}` peel；sync 后删本地 tag 引用 + 清 `.git/shallow` 再 gc。**split 对象不挂 ref、`git gc` 会回收致 `subtree merge` fatal**——脚本自动 `git update-ref refs/subtree-anchors/<dir>` 保护；若 ref 丢失按 PATCHES §3 恢复。全部见 sync-upstream.sh 头注。

## Commit

Use English conventional commit messages:

```text
type(optional scope): description

- List of change descriptions, focus one point per row

Optional footer(s)
```
