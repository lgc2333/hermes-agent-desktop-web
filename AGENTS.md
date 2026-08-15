# Hermes Web — AGENTS.md

> 项目：把 Hermes 桌面端渲染层移植为浏览器 Web 应用，经一个 **Deno 无状态薄代理**
> 连接任意远程 Hermes gateway。核心文档：`PLAN.md`（共识/里程碑）、`CONTEXT.md`（术语）、
> `PATCHES.md`（vendor 改动登记，**以仓库当前版本为准**）、`docs/deploy.md`（部署）、
> `docs/adr/`（决策）。vendor 的 AGENTS.md 同样适用（只在其目录内改动时）。

## 拓扑（一句话）

```
浏览器 ──同源──> proxy(Deno, 6722) ──X-Hermes-Target 转发──> gateway(/api/* + /api/ws + /auth/native/*)
                 └ 托管 SPA dist；零凭证落盘（OAuth token set 仅内存）
```

## 常用命令

```bash
pnpm install                                   # 首次（pnpm 11，node >=22.22）
pnpm dev                                       # mock(5180) + vite(5173)，直连
pnpm --filter @hermes-web/web dev:proxy        # mock + proxy(6722) + vite，经代理
pnpm --filter @hermes-web/web dev:remote       # vite + proxy，无 mock（连自己的 gateway）
pnpm --filter @hermes-web/web dev:web          # 仅 vite（直连模式）
pnpm test                                      # vitest（桥单测，apps/web）
pnpm typecheck                                 # apps/web 类型检查（typecheck.mjs）
pnpm build                                     # 生产构建 → apps/web/dist
cd apps/proxy && deno task test                # 代理单测（deno test，42+ 用例）
deno run --allow-net --allow-read --allow-env apps/proxy/src/main.ts   # 手动起代理
MOCK_OAUTH=1 node apps/web/dev/mock-gateway.mjs 5182   # gated mock（native OAuth 面）
docker compose up -d --build                  # 生产部署（见 docs/deploy.md）
bash scripts/sync-upstream.sh [tag]            # 上游 subtree 同步（PATCHES.md §3）
```

浏览器验收（headless Chrome + CDP 9224，脚本在 apps/web/e2e/，从仓库根运行）：

```bash
chrome --headless=new --remote-debugging-port=9224 --user-data-dir=temp/e2e-profile --disable-popup-blocking
node apps/web/e2e/cdp-*.mjs   # 场景脚本（OAuth/断连/响应式/隐藏验证；前置拓扑见 apps/web/e2e/README.md）
```

## 规则

1. **vendor 纪律**（PLAN §5）：vendor/hermes-desktop|shared 内原位改动收敛到最少；能新加文件就不改旧文件；所有 vendor 改动必须登记 PATCHES.md（含同步注意）。PATCHES.md 由人维护格式，**追加前先读当前版本**，别覆盖他人内容。
2. **凭证模型**（PLAN §6.1 / ADR-0002）：连接凭证只在浏览器（localStorage 注册表 `hermes-web.connections.v1`）；OAuth token set 只存代理内存（重启失效）；代理零凭证落盘、无状态。不要往代理加持久化/落盘凭证。
3. **认证两条路**：token（`X-Hermes-Session-Token` / WS `?token=`，loopback 未 gated 的 gateway）；OAuth（native PKCE 经代理 `/auth/native/*` 中转，REST Bearer + WS 单次 `?ticket=`，仅代理模式可用）。dashboard 页面密码登录（cookie 会话）不是 API 凭证——cookie 绑定 gateway 域，代理无状态，无法复用。
4. **布尔门**：用字面 `if (false)` 关功能入口（voice/terminal/artifacts 等），不做 feature-flag 系统；入口关闭后渲染层自然降级。
5. **响应式覆盖**收敛在 `apps/web/src/web.css`（非 vendor）：移动端状态栏滚动、Connection mode 只留 remote、boot-failure 隐藏 use-local/repair/open-logs。改 vendor 布局前先看能否 CSS 覆盖。
6. **CORS**（M3 实测）：credentials:'include' 的跨源请求必须回显 `Origin` + `Access-Control-Allow-Headers` 回显预检头；`*` 通配符会挂。别回退成 `*`。
7. **代理静态面**：`serveStatic` 必须排除 `/api/` 与 `/auth/` 前缀（否则 SPA fallback 吞掉 OAuth 端点）；默认 `webDist` 是 `../../web/dist/`（相对 src/，`defaultWebDist()` 纯函数），别写成 `../web/dist/`。`apps/web/index.html` 是**真文件**（不是 symlink——rolldown 构建拒绝跨目录 symlink 入口）。
8. **默认 URL**：`HERMES_DEFAULT_GATEWAY_URL` → `/api/proxy/meta` 运行时下发前端预填；同一 dist 可部署任意环境，改 URL 不用重建。
9. **测试纪律**：桥层行为用 vitest（`apps/web/src/bridge/*.test.ts`），代理用 deno test；先写测试再实现（tdd）。改桥/代理协议后跑全量：`deno task test` + `pnpm test` + `pnpm typecheck` 三件套全绿才提交。
10. **临时文件**放 `temp/`（已 gitignore）；验收记录 `temp/m*-acceptance*`。

## 常见坑

1. **CORS 通配符**：credentials 模式预检不接受 `Allow-Headers: *`（Chrome 151 实测）——必须回显。
2. **弹窗拦截**：headless 验收需 `--disable-popup-blocking` + 独立 profile；`Runtime.evaluate` 里 `window.open` 无用户手势返回 null → oauthLogin ok:false。
3. **OAuth 手势**：`oauthLoginConnectionConfig` 同步段先 `window.open` 再 await（保留手势上下文），别 await 后开窗。
4. **loopback redirect_uri**：上游 `/auth/native/authorize` 只收 127.0.0.1/::1（RFC 8252，安全边界无放宽渠道）；dev 同机开箱即用，远端浏览器需 SSH 隧道/VPN（docs/deploy.md §4.3）。
5. **mock gated 影响 boot**：`MOCK_OAUTH=1` 的 mock `auth_required=true`，页面 boot 会要求登录——验收先等 "Gateway ready"（注意 "Runtime not ready" 也含 ready 字样，判状态栏 token 更准）。
6. **HashRouter**：设置页 URL 是 `/#/settings?tab=gateway`，pushState 无效。