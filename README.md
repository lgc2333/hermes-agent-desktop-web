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
│   └── proxy/             # Deno 薄代理（M2 起）
├── scripts/
│   └── sync-upstream.sh   # 上游同步（过滤提交法 subtree merge）
├── package.json           # pnpm workspaces（apps/web；vendor 只作源）
└── pnpm-workspace.yaml
```

## 开发（M0 当前状态）

```bash
pnpm install
pnpm --filter @hermes-web/web dev     # mock gateway + vite dev server（127.0.0.1:5173）
```

M0 = 骨架 + 渲染层在纯浏览器跑通：入口 `apps/web/src/main.tsx` 先装 dev-only
mock bridge（`apps/web/src/bridge/mock-bridge.ts`），再挂载 vendor 渲染树；
`apps/web/dev/mock-gateway.mjs` 提供可拨号的 JSON-RPC WS（M0 只要求 socket 打开）。
M1 起换为 WebCapabilityAdapter 并实现完整 mock 后端。

## 上游同步

```bash
bash scripts/sync-upstream.sh            # 追 main
bash scripts/sync-upstream.sh v0.18.0   # 追 tag
```

原理与基准 SHA 见 PATCHES.md（过滤提交法：monorepo 只 vendoring 两个子路径）。

## 里程碑

M0 骨架 ✅（git + subtree + workspaces + 浏览器跑通）→ M1 换桥 → M2 代理 + token → M3 OAuth → M4 打磨 + compose。
