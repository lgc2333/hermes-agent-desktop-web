# apps/web/e2e — Vitest + Playwright 浏览器验收

原有 CDP 脚本（cdp-*.mjs，headless Chrome 9224）已整体迁移为 **Vitest + Playwright 客户端**
驱动真实 Chromium 的 e2e 套件：单测框架仍是 vitest，浏览器自动化经 `playwright` 客户端（非
`@playwright/test` runner），不再手搓 CDP。运行环境 Node，串行单 worker。

入口：`pnpm --filter @hermes-web/web test:e2e`（vitest.e2e.config.ts）。

## 拓扑与端口

e2e 栈**独立于 `pnpm dev` 的端口**（dev 用 mock 5180 / proxy 6722 / vite 5173），
避免与正在运行的开发栈冲突。默认 e2e 端口可用 `E2E_*_PORT` 环境变量覆盖：

| 角色             | 默认端口 | 覆盖变量                 |
| ---------------- | -------- | ------------------------ |
| Vite dev (SPA)   | 5213     | `E2E_VITE_PORT`          |
| Deno 薄代理      | 6813     | `E2E_PROXY_PORT`         |
| token mock       | 5190     | `E2E_MOCK_TOKEN_PORT`    |
| gated OAuth mock | 5192     | `E2E_MOCK_OAUTH_PORT`    |
| password mock    | 5193     | `E2E_MOCK_PASSWORD_PORT` |

- SPA 经同源代理（ADR-0016）：Vite 以 `VITE_PROXY_URL=http://127.0.0.1:<E2E_PROXY_PORT>`
  启动；`VITE_MOCK_GATEWAY_WS` 指向 e2e token mock，使清注册表后的默认 seed 探测正确端口。
- 代理以 `PORT=<E2E_PROXY_PORT>` 启动；mock 以端口参数启动。

## 进程管理

`helpers/topology.ts` 自行 spawn mock/代理/Vite，**不用 `dev/dev.mjs`**（后者在某子进程退出时
会连环杀掉全部兄弟进程，reconnect 场景杀 mock 会误杀 vite/代理）。`stopByPort` 只停指定端口。

- 共享长活进程（代理 + Vite）：`global-setup.ts` 启动一次，suite 结束由 setup 返回的 teardown 回收。
- 每个 spec 在 `beforeAll` 用 `startMock(port, {oauth?, password?})` 起自己的 mock，
  `afterAll` 用 `stopByPort(port)` 停掉；总是 `await browser.close()`。
- 中断进程：`stopByPort(port)`；重启 mock：`startMock(port)` + `waitForHttp`；重启代理（reconnect B）：
  `startProxy()` + `waitForHttp(PROXY_URL/api/proxy/meta)`。

## Helpers

- `topology`：端口常量 + `startMock/startProxy/startVite/stopByPort/waitForHttp/teardownAll`。
- `bridge`：`waitForReady`、`waitForBodyText`、`gotoHash`（HashRouter，pushState 无效）、`bootClean`、
  `saveOauthConnection`、`oauthLogin/oauthLogout`、`getConfig`、`wsJsonRpc`（WS JSON-RPC 聊天流式校验）、
  `waitFor`（页面表达式轮询）/ `poll`（Node 侧异步轮询）。
- `chat`：`sendChat(page, text)` 聚焦 contenteditable 并输入回车。
- `registry`：localStorage 连接注册表 `hermes-web.connections.v1` 的读写/清空。
- `browser`：`launchBrowser()`（1280x800）与 `launchMobilePage()`（390x844 移动视口）。

## 关键坑

- **`page.evaluate`/`waitFor` 的函数会被序列化到页面执行**，不得闭包引用任何外层/Node 变量
  （`text`/helper/`page` 都不行），只能用页面全局（window/document/location/localStorage）。
  动态子串匹配用 `waitForBodyText`；Node 侧异步（如 `getConfig`）用 `poll`。
- OAuth 弹窗：Chromium 启动参数带 `--disable-popup-blocking`（等价旧 headless 设置），
  `window.open` 在无用户手势下也能开窗。
- 端口改为从 `E2E_*_PORT` 常量读取，别写死 5173/6722/5180。
- 脚本内相对路径以仓库根为 cwd（topology 用 `import.meta.url` 算绝对路径，不依赖 cwd）。

## 使用

```bash
pnpm --filter @hermes-web/web e2e:install   # 一次性：playwright install chromium
pnpm --filter @hermes-web/web test:e2e      # 全量
pnpm --filter @hermes-web/web exec vitest run --config vitest.e2e.config.ts e2e/ui.e2e.ts  # 单个
```

spec 覆盖：`smoke`（boot）、`oauth`（桥层 native OAuth + 聊天 + 刷新 + 登出）、`oauth-paste`
（ADR-0017 paste-back）、`ui`（设置页 Sign in + 聊天 + 刷新）、`reconnect`（A 断连重连 / B 代理重启
会话丢失 / C、C2 断连发送反馈）、`boot-failure`（overlay + Use local gateway / Repair/Logs 隐藏 +
mode 卡只留 remote）、`find`（ADR-0019 Ctrl+F 不打开 find-bar）、`attach`（ADR-0020 文件拖入落盘）、
`responsive`（移动视口设置页 + 状态栏可读）、`dev-remote`（无 mock boot 恢复）。
