# Hermes Desktop → Web 移植计划（v1）

> 共识文档：本文件是需求分析（grilling 三轮）的最终产物。确认后按此实施。

## 1. 目标与范围

**一句话**：把 Hermes 桌面端的 React 渲染层移植为浏览器 Web 应用，通过一个 Node/TS 薄代理连接任意远程 Hermes gateway（`hermes serve` / dashboard API 面），配置同步走外挂 API。

### v1 交付（全部做扎实）

- 聊天核心：流式消息、tool 活动、审批/澄清/secret 请求
- 会话：列表、恢复、新建
- 模型切换（model picker 等桌面已有资产）
- 最小设置页（连接配置、feature 门相关）
- 连接管理：手填 URL + 静态 token（`X-Hermes-Session-Token` / WS `?token=`）+ OAuth（native PKCE，经 gateway `/auth/native/*`，Hermes Cloud/Privy 由 gateway `auth_flows` 自动适配）
- 薄代理（Node/TS）：托管 SPA 静态产物、转发 REST/WS、OAuth 回调与 token 存储（httpOnly cookie）、外挂配置 API、目标 gateway 切换（UI 手填 → 探测 → 生效）

### 明确不做（代码保留，布尔门关闭）

- voice、终端（整体移出计划，无 v2）
- 文件浏览、artifacts、agents、kanban、预览面板等桌面非核心页面：**`if (false)` 布尔门**关掉入口，代码留在仓库里便于 subtree 合并，不做 feature-flag 系统
- 本地后端托管、系统更新、HUD、窗口管理、原生文件系统权限模型
- 移动端特殊处理：纯响应式，浏览器直接访问

### 关键决策记录

| # | 决策 | 结论 |
|---|------|------|
| Q1 | 目标用户 | 个人/小团队 + 移动浏览器（A+C） |
| Q2 | 连接模型 | 纯远程，手填 URL 连任意 gateway |
| Q3 | 运行时依赖 | 只依赖 gateway/dashboard 接口；配置同步用外挂 API |
| Q4 | 前端代码基 | 桌面渲染层（`apps/desktop/src`）为基座 |
| Q5 | voice/终端 | 移出计划 |
| Q6 | 部署 | 仅薄代理模式（先只支持 remote gateway） |
| Q7 | 认证 | 全部方式：token + OAuth（native PKCE）；无 QR 配对（上游不存在此机制） |
| — | 会话来源标签 | 复用 `source: 'desktop'`（零 Python patch） |
| Q8 | 代理技术栈 | Deno（原生零依赖，TS 源码直跑；`deno compile` 可选） |
| Q9 | 非核心页面 | 布尔门关闭，代码保留 |
| — | 部署拓扑 | hermes + webui 双容器 compose（bridge 网络）；默认远端 URL 经 /api/proxy/meta 运行时下发前端 |

## 2. 上游事实（已核实，标注出处）

- 渲染层是纯 Vite + React 19 应用，运行时只通过 `window.hermesDesktop` 能力桥（约 391 调用点 / ~25 方法，133 个走泛型 `api()`）与 Electron 交互 → **web 移植 = 换桥**。
- 传输层：JSON-RPC over WebSocket，`apps/shared`（`@hermes/shared`）的 `JsonRpcGatewayClient`，web/ 仪表盘已复用。
- 远程连接：`/api/status` 探测（token 在 header）→ WS 拨号（token 型 `?token=`；oauth 型 ws-ticket）。见 `apps/desktop/electron/gateway-ws-probe.ts`、`connection-config.ts`。
- OAuth：gateway 是授权服务器（`/auth/native/{authorize,token,refresh}`），`/api/status.auth_flows` 宣告能力（`native_pkce`）；`apps/desktop/electron/native-oauth.ts` 是**零 Electron 依赖的纯 TS**（PKCE/state 生成、能力判断），可直接搬进代理。
- `hermes serve` = headless 后端（`headless_backend=True`，只留 JSON-RPC/WS/API 面）。
- 会话来源标签驱动工具集下发（`desktop_ui` 等），复用 `source:'desktop'` 即可拿到 GUI 工具集。
- 上游无统一 feature-flag；能力探测靠 `window.hermesDesktop?.xxx` 可选链 → 我们的布尔门加在导航/路由入口即可，渲染层会自然降级。

## 3. 仓库结构

```
hermes-agent-desktop-web/
├── PLAN.md / PATCHES.md / README.md
├── vendor/
│   ├── hermes-desktop/        # subtree：上游 apps/desktop（构建只用 src/ 渲染层 + 少量脚本）
│   └── hermes-shared/         # subtree：上游 apps/shared
├── apps/
│   ├── web/                   # 移植入口（新）：Vite web 构建
│   │   ├── src/
│   │   │   ├── bridge/        # WebCapabilityAdapter：~25 个桥方法的三类实现
│   │   │   ├── gates.ts       # 布尔门：if (false) 关闭的页面/入口清单
│   │   │   └── main.tsx       # 入口替换（不加载 Electron boot）
│   └── proxy/                 # Deno 薄代理（原生零依赖，源码直跑）
│       ├── src/
│       │   ├── main.ts        # Deno.serve 单 handler：静态 + 访问控制 + 全量转发
│       │   └── oauth.ts       # OAuth 内存态中转（PKCE 交换，无持久化）
│       ├── deno.json          # 权限声明（allow-net 等）
│       └── Dockerfile         # deno:alpine，deno run 直跑；deno compile 可选发行
├── docker-compose.yml         # hermes(上游镜像) + webui(proxy) 双容器编排
├── package.json               # npm workspaces: apps/web, vendor/*(只作源)；proxy 用 deno.json 独立管理
└── scripts/
    └── sync-upstream.ps1      # subtree pull 工作流
```

## 4. Subtree 引入与同步

```bash
git remote add upstream https://github.com/NousResearch/hermes-agent.git
# 只拉桌面端与共享协议层，--squash 避免历史膨胀
git subtree add --prefix=vendor/hermes-desktop upstream <TAG或main> --squash
git subtree add --prefix=vendor/hermes-shared  upstream <TAG或main> --squash
# 同步上游（固定节奏，pin 到 tag 优先）
git subtree pull --prefix=vendor/hermes-desktop upstream <TAG> --squash
git subtree pull --prefix=vendor/hermes-shared  upstream <TAG> --squash
```

- 首次 pin 到当前 main（已克隆 SHA，待记录进 PATCHES.md），之后优先追 release tag。
- 上游 `apps/desktop` 依赖 `@hermes/shared`（file: 引用）→ 在 apps/web 的构建里把 `@hermes/shared` 映射到 `vendor/hermes-shared`。

## 5. Patch 面清单（控制冲突的策略）

**原则**：vendor 内原位修改收敛到最少文件；能新加文件就不改旧文件；所有 vendor 改动登记在 `PATCHES.md`。

| 类别 | 位置 | 方式 |
|------|------|------|
| 入口替换 | vendor/hermes-desktop/src/main.tsx | 原位改（小而稳），或 web 入口文件 import 原渲染树 |
| 能力桥类型 | src/global.d.ts（window.hermesDesktop 类型） | 保持不动，WebCapabilityAdapter 按同一类型实现 |
| 布尔门 | apps/web/src/gates.ts + 导航/路由调用点 | 新增文件为主；少数路由表/侧边栏入口原位加 `if (false)`（登记 PATCHES.md） |
| 连接启动 | 桌面 boot/连接状态机 | web 端用新文件重写（探测→拨号→re-home 语义照搬 `connection-apply.ts` 纯逻辑） |
| Python 侧 | 无（source 复用 'desktop'，代理同源无 CORS 问题） | 零 patch |

## 6. 代理协议设计（v1）——单通配 handler，无状态

结构上只有一个入口（Deno.serve 的 handler），按优先级在内部三分支；WS 用 `Deno.upgradeWebSocket`，零依赖：

```
浏览器 (SPA, 同源) ──> apps/proxy（单 handler，三分支，无状态）
  1) 静态资源（GET 且 dist 中存在该文件）→ 直接返回 SPA 产物
  2) 访问控制：校验 X-Hermes-Proxy-Passphrase（可选，公网部署必开；无状态比对）
  3) 其余全部（REST /api/*、/auth/*、WS upgrade）→ 按请求头 X-Hermes-Target 指定的
     目标 gateway 原样转发：路径/查询/method/headers/body 透传，响应流式回传
     - 认证凭证由浏览器随请求携带（X-Hermes-Session-Token / 网关 cookie / ?token=），
       代理只透传、不落盘
     - WS：server 'upgrade' 事件统一处理（校验 passphrase → 按目标 URL + 浏览器
       提供的 token 拨号 gateway → 双向中继）
```

- 浏览器**只见代理同源**：无 CORS、无跨源 WS；代理**零凭证落盘、无状态**。
- 凭证只存在浏览器（见 6.1）；目标 gateway 由浏览器在每次请求携带（X-Hermes-Target），切换目标无需代理侧配置。
- 公网部署安全：代理被攻破只泄漏"转发能力"，不泄漏任何 gateway 凭证；passphrase 防开放转发（SSRF/### 6.1 配置保存决策（v1）——凭证跟浏览器

1. **渲染层 UI 状态**（route / lastSessionId / themes / boot 背景等）：上游本就存 localStorage → 浏览器原样工作，零改动；web origin 与桌面 origin 天然隔离。`workspace-cwd` 等本地路径键在 web 端废弃（工作目录属 gateway 侧）。
2. **连接注册表 + 凭证**：全部在浏览器，按连接 id 存 localStorage / IndexedDB（`hermes-web.connections.v1`）：
   - 连接定义（label/kind/url/authMode）与凭证（静态 token、OAuth token set）同存，按设备隔离
   - 代理**不存任何凭证**（无 PROXY_SECRET、无加密落盘）→ 公网部署代理被攻破不泄漏 gateway 凭证
   - 代价：换设备/换浏览器需重新填 token；localStorage 凭证对 XSS 可见（用 CSP + 无第三方脚本 + OAuth 短时 token + 轮换 refresh 对冲；OAuth 可后补 httpOnly cookie 方案）
3. **后端配置**（config.yaml/.env）：归 gateway 侧，web 不管理；查看/调整走已有 JSON-RPC config 方法或 dashboard 页面。

外挂 API 缩减：原 /api/proxy/config 仅保留可选 passphrase / allowlist / health 管理，连接与凭证不再经过代理。

### 6.2 Docker 编排与默认远端 URL

双容器 compose（bridge 网络，不用上游的 host 模式，靠服务名互通）：

- **hermes**：上游镜像（Debian/s6，体积不归我们管），覆盖 command 跑 `hermes serve`（headless）；端口**不映射到宿主机**，只暴露在 compose 内部网络（规避上游"dashboard 绑 loopback、暴露不安全"的警告；webui 是唯一入口）
- **webui**：`apps/proxy/Dockerfile`（deno:alpine，`deno run` 源码直跑，镜像保持小巧）；仅 webui 映射端口（如 8080）到宿主机；公网部署必开 passphrase

默认远端 URL 下发链路（运行时下发，非构建时）：

```
compose env: HERMES_DEFAULT_GATEWAY_URL=http://hermes:9119
        ↓ (env)
webui 容器 (proxy) ── /api/proxy/meta ──> { defaultGatewayUrl, requiresPassphrase }
        ↓ (fetch on boot)
前端连接设置页自动预填 URL（token 仍由用户填，凭证仍只在浏览器）
```

- 同一 SPA 构建可部署到任意环境，改默认 URL 只需改 compose env，不用重新构建
- hermes 容器需监听非 loopback（如 `hermes serve --host 0.0.0.0`，具体参数 M2 实测）才能被 webui 访问；因仅内部网络可达 + webui 入口有 passphrase，风险可控
- 不影响"手填 URL 连任意远程 gateway"能力——默认 URL 只是预填

## 7. 里程碑

- **M0 骨架**：git 初始化、subtree 引入、npm workspaces、vendor 在浏览器跑通（dev:mock 模式，不接 Electron）
- **M1 换桥**：WebCapabilityAdapter 三类实现（浏览器等价 / 走代理 RPC / 布尔门空实现）、入口替换、导航布尔门；对 mock 后端跑通聊天全流程
- **M2 代理 + token 模式**：静态托管、REST/WS 转发、目标切换、手填 token 连接真 `hermes serve`，验证流式/审批/会话恢复
- **M3 OAuth + 配置 API**：native PKCE 客户端、httpOnly cookie、设置页（连接 + 目标 gateway）
- **M4 打磨与部署** ✅：响应式顺手（web.css 覆盖层）、错误/重连态（实测验收 + 单测固化）、compose 编排落地（apps/proxy/Dockerfile + 根 docker-compose.yml，hermes 用 gateway run + HERMES_DASHBOARD=1 作 API 载点）、部署文档（docs/deploy.md，含 auth gate 与 loopback redirect_uri 限制）、PATCHES.md 完整登记（§4.4）；验收见 temp/m4-acceptance.md

## 8. 验证方式

- 上游既有 Playwright e2e（`apps/desktop/e2e/*.spec.ts`）+ `mock-server.ts` 可复用（跑浏览器目标）
- 真 gateway 手动验收：`hermes serve` 起本地后端 → 代理 → 浏览器全流程
- 每轮 subtree pull 后跑类型检查 + 关键 e2e，PATCHES.md 冲突登记

## 9. 风险

- 上游迭代快 → 固定同步节奏 + PATCHES.md 登记 + 布尔门留代码
- 桥 API 漂移 → 适配器集中在 apps/web/src/bridge，vendor 内尽量不动
- OAuth 的 redirect_uri 限制（gateway 只认自己 origin）→ 代理同源回调天然满足；具体端点形态以实测 gateway `/api/status` 为准