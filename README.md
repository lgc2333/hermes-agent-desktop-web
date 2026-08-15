# Hermes Desktop → Web

把 NousResearch/hermes-agent（MIT，monorepo）桌面端的 React 渲染层移植为浏览器 Web 应用，
通过 **Deno 无状态薄代理** 连接远程 Hermes gateway。**不 fork 上游**，用 git subtree 引用。

## 仓库结构

```
hermes-agent-desktop-web/
├── PLAN.md / CONTEXT.md / PATCHES.md / README.md
├── docs/adr/              # 决策记录 0001–0004
├── vendor/
│   ├── hermes-desktop/    # subtree：上游 apps/desktop（渲染层源码）
│   └── hermes-shared/     # subtree：上游 apps/shared（@hermes/shared）
├── apps/
│   ├── web/               # 移植入口（Vite web 构建；src/main.tsx 挂载 vendor 渲染树）
│   └── proxy/             # Deno 薄代理（M2 起；Dockerfile = compose 的 webui 容器）
├── docs/
│   ├── adr/               # 决策记录 0001–0008
│   └── deploy.md          # compose 部署指南（M4）
├── scripts/
│   └── sync-upstream.sh   # 上游同步（过滤提交法 subtree merge）
├── docker-compose.yml     # hermes + webui 双容器编排（M4）
├── package.json           # pnpm workspaces（apps/web；vendor 只作源）
└── pnpm-workspace.yaml
```

## 开发

```bash
pnpm install
pnpm --filter @hermes-web/web dev        # mock gateway + vite dev server（127.0.0.1:5173）
pnpm --filter @hermes-web/web dev:proxy  # 同上 + Deno 薄代理（127.0.0.1:6722）
cd apps/proxy && deno task test          # 代理单测
pnpm test                                # 桥单测（vitest）
pnpm typecheck
```

入口 `apps/web/src/main.tsx` 先装 WebCapabilityAdapter（bridge/，三类实现：
浏览器等价 / 代理 RPC / 布尔门空实现），再挂载 vendor 渲染树；
`apps/web/dev/mock-gateway.mjs` 提供可拨号的 JSON-RPC WS（MOCK_OAUTH=1 时模拟
gated gateway 的 native OAuth 面）。

## 部署（compose）

```bash
cd research/upstream && docker build -t hermes-agent .   # 上游镜像（一次性）
export PROXY_PASSPHRASE=... HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=...
docker compose up -d --build
# 浏览器打开 http://<host>:8080 → 设置页预填 http://hermes:9119 → Sign in → 聊天
```

完整说明（拓扑、认证模型、auth gate、OAuth loopback 限制、安全清单）见
**docs/deploy.md**。默认远端 URL 经 `HERMES_DEFAULT_GATEWAY_URL` 运行时下发，
改目标不用重建镜像。

## 上游同步

```bash
bash scripts/sync-upstream.sh            # 追 main
bash scripts/sync-upstream.sh v0.18.0   # 追 tag
```

原理与基准 SHA 见 PATCHES.md（过滤提交法：monorepo 只 vendoring 两个子路径）。

## 里程碑

M0 骨架 ✅ → M1 换桥 ✅ → M2 代理 + token ✅ → M3 OAuth + 配置 API ✅ → M4 打磨 + compose ✅（响应式、错误/重连态、双容器编排、部署文档，验收见 temp/m4-acceptance.md）。
