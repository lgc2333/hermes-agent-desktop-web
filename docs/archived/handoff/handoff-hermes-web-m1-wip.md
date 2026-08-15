# Handoff — Hermes Web M1（中途交接：现状 + 剩余工作）

> 生成时间：2026-08-15（M1 实施轮次中段）。工作区：D:\Coding\hermes-agent-desktop-web。
> 基础上下文：PLAN.md / CONTEXT.md / PATCHES.md / docs/adr/、
> handoff-hermes-web-v4.md（M0 完成 + 环境注意全集）、handoff-hermes-web-m1.md（M1 任务书）。
> **仓库 HEAD = 5d23e71，M1 全部改动在未提交的工作区。**

## 1. 一句话现状

**M1 主体已完成且自检通过**：三类 WebCapabilityAdapter 已实现、入口已替换、
vendor 导航布尔门已加、mock gateway 已升级为可聊天（REST + WS 双通道）。
**尚未做**：浏览器里的交互式聊天验收（发消息 → 流式回复，M1 验收核心）、
文档登记（PATCHES.md/CONTEXT.md/ADR）、git commit。

## 2. 已完成（全部在未提交工作区）

### 2.1 桥实现（apps/web/src/bridge/）

| 文件 | 内容 |
|------|------|
| `gates.ts` | 布尔门清单（artifacts/agents/voice/terminal/files/preview/windows/git/... 全部 false）+ `isDenied()`；语义权威，vendor 侧以字面常量镜像 |
| `registry.ts` | 连接注册表（localStorage `hermes-web.connections.v1`，ADR-0002 凭证跟浏览器）；默认 mock 连接 → ws://127.0.0.1:5180/gateway；profile 偏好 `hermes-web.profile.v1` |
| `gateway.ts` | 类 2：getConnection/getGatewayWsUrl/revalidateConnection/touchBackend、`api()` REST 转发（X-Hermes-Session-Token、404 错误形状 `404: {"detail":"No such API endpoint: ...}`）、boot 面（getBootProgress 等）、连接设置面（getConnectionConfig/save/apply/test/probe + connections.* + profile + cloud/ssh 空面）、getVersion/getBootstrapState |
| `browser.ts` | 类 1：clipboard（navigator.clipboard + execCommand 降级）、openExternal、fetchLinkTitle、notify（Notification）、selectPaths/selectSavePath 空、zoom、reportRendererError |
| `denied.ts` | 类 3：全部 77 桥成员的桌面原生面空实现（窗口/petOverlay/hud/quickEntry/voice/文件/git/terminal/updates/themes.marketplace/findInPage/bootstrap 等），合法返回形状（[] / null / { ok:false } / 显式 reject） |
| `adapter.ts` | buildWebBridge()/installWebBridge() 组装三类 → window.hermesDesktop |

测试（vitest，28 个全过）：`registry.test.ts`（注册表持久化/播种）、
`gateway.test.ts`（api 转发/错误形状/连接面）、`adapter.test.ts`（形状/denied 空态）。

### 2.2 入口替换

- `apps/web/src/main.tsx`：`installWebBridge()` 替代 mock-bridge import（ESM 顺序保证先装桥）。
- `apps/web/src/bridge/mock-bridge.ts` 已删除。

### 2.3 vendor 布尔门（PATCHES.md §4 需登记）

| 文件 | 门 |
|------|-----|
| `app/chat/sidebar/index.tsx` | `GATE_ARTIFACTS_NAV=false` + `ARTIFACTS_NAV_ITEM` 具类型常量条件展开（被关条目抽成常量避免隐式 any） |
| `app/contrib/surfaces.tsx` | `GATE_ARTIFACTS_ROUTE=false`：/artifacts 路由不挂（直开回落 chat） |
| `app/command-palette/index.tsx` | `GATE_ARTIFACTS_NAV`/`GATE_AGENTS_NAV`：palette 两行关闭 |
| `app/shell/hooks/use-statusbar-items.tsx` | `GATE_AGENTS_STATUSBAR=false`（条件展开 + `satisfies StatusbarItem[]` 保持上下文类型） |
| `app/chat/index.tsx` | `voice.enabled: false`（关 dictation pill） |

kanban 无需门：上游 `defaultEnabled: false`，默认 dormant。

### 2.4 mock gateway（apps/web/dev/mock-gateway.mjs 重写）

- **同一端口 5180 双协议**：HTTP REST（CORS 全开）+ WS（`new WebSocketServer({ server: httpServer, path: '/gateway' })`——**不能各 listen 同端口**）。
- WS RPC：`setup.status → { provider_configured: true }`（**跳过 onboarding 直进聊天**，这是 M1 的关键一步）、setup.runtime_check、config.get/set、session.create/resume/info/activate/delete、**prompt.submit（立即 ACK + 50ms 后推流）**、process.kill、approval.*、clarify.respond、reload.env、wake.pause；未知方法回 `{ error: { message: 'No such RPC method: ...' } }`。
- 事件帧：`{ method: 'event', params: { type, session_id, payload } }`；prompt.submit 推 message.start → message.delta（40ms/词）→ message.complete（{ text, status:'ok' }）→ session.info（含 stored_session_id/running:false/model/provider）；回复与用户消息同时写入内存 session 的 messages（REST 转写可见）。
- REST：/api/status、/api/config、/api/config/defaults、/api/model/info、/api/model/options（含 mock provider，模型选择器可用）、/api/profiles/sessions/sidebar、/api/profiles/sessions、/api/sessions(+/:id、/:id/messages、PATCH/DELETE)、/api/profiles、/api/cron/jobs、/api/env、/api/skills、/api/logs；未知 → 404 `{"detail":"No such API endpoint: ...}`。
- session 结构：stored id（`st-*`，侧栏/路由用）+ runtime id（`rt-*`，live 事件用），byRuntime 映射。

### 2.5 工程基建（本轮新增/修复）

- `apps/web/scripts/typecheck.mjs`：**真实 typecheck 驱动**（见 §4 坑 1）。
- `apps/web/vitest.config.ts` + package.json `test` 脚本；typecheck 脚本换成 node 驱动。
- `apps/web/tsconfig.json`：**paths 新增 react 钉扎**（见 §4 坑 2）。
- **注意**：`apps/web/vite.config.ts` 有一处**非本轮所作**的修改（server.watch.ignored 加 `.package.json.*` 与 `*.tmpdir`，Windows 下 chokidar EBUSY 修复），工作区在会话开始时就有（handoff 说"工作区干净"与实际不符）。看起来是合理修复，建议保留并随本批一起提交说明。

## 3. 验证状态

| 项 | 状态 |
|----|------|
| `pnpm --filter @hermes-web/web typecheck` | ✅ **真绿**（exit 0；修复了 M0 起 CLI 假绿问题，见 §4 坑 1） |
| `pnpm --filter @hermes-web/web test` | ✅ 28/28 过 |
| headless boot（dump-dom/screenshot） | ⚠️ 部分：无 vite-error-overlay、聊天壳/侧栏/composer DOM 存在；**发现并修复一个运行时崩溃**：`denied.onOpenUpdatesRequested is not a function`（denied.ts 类字段误用 `:` → 被解析为类型注解、运行时 undefined；已全部改 `=`）。修复后**未重新截图确认**（最后一次截图因 Chrome profile/参数问题失败） |
| 交互式聊天（发消息→流式回复） | ❌ **未做**——M1 验收核心，见 §5 |
| PATCHES.md/CONTEXT.md/ADR/commit | ❌ 未做 |

## 4. 坑与发现（下一个 agent 必读）

1. **`tsc` CLI 在 TS 6.0 下是假绿**：tsconfig 的 `baseUrl` 触发 TS5101 配置错误，**CLI 报完 TS5101 就提前退出、根本不检查任何文件**（M0 起 typecheck 从未真正跑过；用 `--listFilesOnly`/探针文件验证过）。真实检查必须走编译器 API——`apps/web/scripts/typecheck.mjs` 已改为 in-process（`ts.parseJsonConfigFileContent` + `ts.createProgram` + `getPreEmitDiagnostics`，仅过滤 TS5101）。
2. **react 双实例伪错**：`apps/web/node_modules/@types/react`（pnpm symlink → store）与 root hoisted 的 `@types/react` 同时进程序（jsx-runtime 从不同根解析）→ 全库 "Two different types with this name exist"（基线 102 个错，全在 vendor 非本批文件）。**已修复**：tsconfig paths 把 react/react-dom/react-jsx-runtime 等直接钉到 root `@types/*.d.ts`（映射包目录不行——会绕过 @types 查找变成 2990 个 "Could not find declaration file"）。修后 in-process 检查 **0 错**。
3. **tsconfig 的 baseUrl 不能动**：删 baseUrl 或加 `ignoreDeprecations` 都会切到 TS6 新 paths 模式，Windows 下产生模块身份重复（试过 ${configDir} 也不行）。就保持 baseUrl + 过滤 TS5101。
4. **类字段初始化必须用 `=`**：`onX: noopUnsub` 在 class body 里是类型注解不是初值（运行时 undefined → 渲染层直接崩）。denied.ts 已修，别再写回去。
5. **vendor 条件展开会破坏数组上下文类型**：`...(false ? [...] : [])` 会让外层数组元素失去上下文类型（`variant: 'action'` 变 string、arrow 参数变隐式 any）。修法：被关条目抽成具类型常量（sidebar）或内层数组加 `satisfies X[]`（statusbar）。**`satisfies` 在多行数组字面量 + 紧邻 `)` 的写法会触发解析器 bug（TS1005）**——用常量最稳。
6. mock gateway 双协议必须共用 httpServer（§2.4）。
7. 本会话在沙箱里 `spawnSync` 子进程（管道捕获）被禁：node 子进程用 `stdio: ['ignore', fd, fd]` 文件描述符捕获可行；**不要**在脚本里依赖 shell/cmd。

## 5. 剩余工作（下一轮任务清单）

1. **M1 验收：交互式聊天全流程**（最重要）：
   - `pnpm --filter @hermes-web/web dev`（mock gateway :5180 + vite :5173；本会话的后台 job 已停，需重启）
   - headless Chrome（chrome.exe 在 `C:\Program Files\Google\Chrome\Application\`）：
     - `--dump-dom`：确认无 vite-error-overlay、无错误边界（"Something broke in the interface"）、无 boot 错误横幅
     - `--screenshot=路径`（等号形式或 `--screenshot=路径` 空格形式都行，之前 `--screenshot=$tmp\boot.png` 空格形式成功、等号带引号失败——用 `--screenshot=file` 不带引号）
     - 交互用 CDP：`chrome-devtools-cli` 技能（chrome-devtools CLI 未全局安装，需先按技能安装说明装）或 `--remote-debugging-port=9222` 手写 CDP；流程：等 boot 完成 → 直接应进聊天态（setup.status 已返回 configured）→ composer 输入 → 回车 → 观察流式回复 → 侧栏出现新会话
   - 修复验证中发现的问题（预期可能：某些 REST 形状不匹配、事件时序、onboarding 残留等）
2. **PATCHES.md §4 登记**：5 处 vendor 布尔门 + styles.css @source 检查（subtree pull 场景）+ tsconfig paths react 钉扎说明。
3. **文档**：CONTEXT.md 若有术语变动（WebCapabilityAdapter/gates 已在词表？需核对）；可新增 ADR（如"typecheck 走编译器 API"或"react 类型钉扎"决策记录）。
4. **git commit**（用户全局身份 LgCuwukii <lgc2333@126.com>；本地无 user.name/email）：
   - 建议拆 2-3 个 commit：bridge 实现 + 测试、mock gateway + 入口、vendor 布尔门 + 基建（typecheck/tsconfig/vitest）。
   - `apps/web/vite.config.ts` 的 watch 修复单独说明或并入基建 commit。
5. **可选**：`temp/` 下清理（m1-bridge-bak、m1-bridge-bak2、m1-tests-bak、m1-parse-probe*.cjs、m1-typecheck.cjs、m1-headless/ 等，均已在 .gitignore，不碍事）。
6. **M2 展望**：api() 的 baseUrl 落点（gateway.ts `gatewayBaseUrl()`）与 wsUrlFor() 已集中，M2 换同源代理 + X-Hermes-Target 只改这两个函数；connections.* UI 从 registry.ts 直接长出来。

## 6. 建议技能（suggested skills）

- `chrome-devtools-cli`：M1 交互聊天验收（headless Chrome / CDP）
- `tdd`：后续适配器/代理逻辑测试（本批已建 vitest 基线）
- `domain-modeling`：落地后更新 CONTEXT.md / 新增 ADR
- `handoff`：M1 完成后生成下一轮交接

## 7. 敏感信息

无 API key / 密码 / 个人身份信息。mock token 为占位值 `mock-token`（仅本地 dev）。
