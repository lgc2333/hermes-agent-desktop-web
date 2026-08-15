# Handoff — M1 换桥（实施前交接）

> 生成时间：2026-08-15（第三轮末尾）。工作区：D:\Coding\hermes-agent-desktop-web。
> 本文是 **M1 的实施任务书**：目标、桥面盘点（已核实数据）、实现要点、验证方式、已知坑。
> 基础上下文见 PLAN.md / CONTEXT.md / PATCHES.md / docs/adr/，以及
> handoff-hermes-web-v4.md（M0 完成 + 环境注意事项全集）。
> 仓库当前 HEAD = 5d23e71，工作区干净。

## 1. M1 目标（PLAN.md §7）

**换桥**：WebCapabilityAdapter 三类实现（浏览器等价 / 走代理 RPC / 布尔门空实现）、
入口替换、导航布尔门；对 mock 后端跑通**聊天全流程**（发消息 → 流式回复）。

M0 已完成的前置：渲染层在纯浏览器 boot 通过（mock bridge + mock gateway WS 打开），
样式修复（Tailwind @source）已提交。M1 把 M0 的占位桥换成正式适配器，并把 mock
gateway 从"只开 socket"升级到"能聊天"。

## 2. 桥面盘点（本轮已核实，直接可用）

**77 个成员 / 329 调用点**（regex 扫描 vendor/hermes-desktop/src，含嵌套对象成员）。
按调用频次 Top：api(137)、openExternal(22)、petOverlay(18)、hud(11)、
readFileDataUrl(9)、quickEntry(7)、writeClipboard(5)、getPathForFile(4)、
themes(4)、settings(4)、zoom(4)、terminal(3)、连接配置面(各3)、git(3)、
findInPage(3)、updates(3)、getConnection(2)、openSessionWindow(2)……

**类型契约**：vendor/hermes-desktop/src/global.d.ts（保持不动，适配器按同一类型实现）。

**boot/聊天关键路径的桥调用**（从 use-gateway-boot.ts / gateway store 核实）：

- boot：`getConnection()` → `resolveGatewayWsUrl(desktop, conn)`（@hermes/shared，
  token 模式无 mint 时回退 conn.wsUrl）→ `gateway.connect(wsUrl)` → 成功后
  `refreshHermesConfig()`（REST 经 api()）+ `refreshSessions()`（REST）
- 会话切换：`getConnection(profile)`、`touchBackend(profile)`、`revalidateConnection()`
- HermesConnection 必需字段（渲染层实读）：baseUrl、token、wsUrl、authMode、
  mode、nativeOverlayWidth、isFullscreen、windowButtonPosition、logs

## 3. 实现结构（建议，与 PLAN §3 一致）

```
apps/web/src/bridge/
├── adapter.ts        # buildWebBridge()/installWebBridge()：组装三类，装 window.hermesDesktop
├── browser.ts        # 一类：浏览器原生等价（剪贴板/openExternal/通知/...）
├── gateway.ts        # 二类：连接注册表(localStorage, ADR-0002) + api() REST 转发 + boot 面
└── denied.ts         # 三类：布尔门空实现（voice/终端/文件/窗口/git/preview/pet/hud/...）
apps/web/src/gates.ts # 布尔门清单（if (false) 关闭的页面/入口）
```

**三类分法**（M1 共识）：

1. **浏览器等价**：clipboard（navigator.clipboard + execCommand 降级）、openExternal
   （window.open）、fetchLinkTitle（fetch 解析 title，CORS 受限时返回 ''）、
   notify（Notification API）、selectPaths/selectSavePath（返回空）
2. **走代理 RPC**：getConnection/getGatewayWsUrl（连接注册表 localStorage，
   ADR-0002 凭证跟浏览器；M1 默认目标 = mock gateway :5180，M2 换代理协议）、
   api()（REST 转发，M1 直连 mock、M2 经同源代理 X-Hermes-Target）、
   boot 面（getBootProgress/onBootProgress/onBackendExit 等，浏览器无后端进程，
   语义简化为连接探测）、连接设置面（getConnectionConfig/save/apply/test/probe）
3. **布尔门空实现**：terminal、voice、文件系统（readFileDataUrl/readDir/...）、
   窗口（openSessionWindow/openWindow/hud/petOverlay/quickEntry）、git 工作树、
   preview/watch、themes.marketplace、updates/uninstall、bootstrap、cloud、
   ssh、connections（注册表旧版面可空，M2 起做）

**入口替换**（PLAN §5）：apps/web/src/main.tsx 把 mock-bridge import 换成
adapter 的 installWebBridge()（ESM import 顺序保证先装桥再挂渲染树）；
mock-bridge.ts 删除。

## 4. mock gateway 方法面（apps/web/dev/mock-gateway.mjs，聊天全流程）

现状：只开 WS、任何请求回 { }。M1 需要：

- 会话面：session.list / session.create / session.info / session.resume（形状参考
  vendor/hermes-desktop/src/types/hermes.ts 的 SessionInfo）
- 聊天面：prompt.submit → 推流事件 message.start / message.delta / message.complete
  （事件帧：{ method: 'event', params: { type, session_id, payload } }，见
  vendor/hermes-shared/src/json-rpc-gateway.ts 的 handleMessage 分发）
- 配置面：config.get / config.get_defaults（REST 侧走 mock bridge api() 已有
  canned 响应，可复用到 gateway RPC）
- 注意 REST 与 WS 双通道：refreshHermesConfig/refreshSessions 走 REST（api()），
  消息流走 WS 事件；两侧都要 mock 一致

## 5. 验证方式

1. `pnpm --filter @hermes-web/web dev` → mock gateway + vite
2. headless Chrome：
   - `--dump-dom`：确认无 vite-error-overlay、聊天壳渲染、无 boot 错误横幅
   - `--screenshot=<path>`（等号形式，避免 exit 13）：看视觉
   - 需要交互（发消息）时：用 CDP（--remote-debugging-port=9222）或
     chrome-devtools-cli 技能驱动
3. 手动：浏览器开 http://127.0.0.1:5173 → onboarding 页出现（M1 若想让
   mock 直接进入聊天态，可在 mock bridge 的 /api/config 返回带 mock provider
   的配置，或 mock gateway 实现 session 面后走"已有会话"路径）

## 6. 已知坑（M1 实施前必读）

- Tailwind：vendor 源码类名靠 styles.css 的 @source（PATCHES.md §4 已登记），
  subtree pull 后检查该两行是否还在
- vite 8：config 用 import.meta.dirname；vendor vite.config.ts 不能 symlink
- pnpm 11：配置只认 pnpm-workspace.yaml；install 偶发 UND_ERR_DESTROYED 需重跑
- git：别对 git 输出用 Select-Object -First 截断（index.lock 残留）
- 桥类型：global.d.ts 的 Window['hermesDesktop'] 是完整契约；denied 实现要
  覆盖全部 77 成员（至少可选链安全），否则渲染层调用 undefined 会炸
- 上游 e2e（vendor/hermes-desktop/e2e/*.spec.ts + mock-server.ts）是 Electron
  启动 + OpenAI 兼容 mock；浏览器版需自建等价（可参考其协议形状）

## 7. 建议技能（suggested skills）

- `tdd`：适配器逻辑（连接注册表、api 转发、denied 形状）可先写 vitest
- `prototype`：mock gateway 方法面是 spike
- `chrome-devtools-cli`：headless Chrome / CDP 驱动聊天交互验证
- `domain-modeling`：M1 落地后若有术语/决策变动，更新 CONTEXT.md / 新增 ADR
- `handoff`：M1 完成后生成下一轮交接

## 8. 敏感信息

无。
