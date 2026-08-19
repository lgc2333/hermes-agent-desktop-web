# apps/web/e2e — Playwright Test 浏览器验收

浏览器 e2e 用官方 **@playwright/test** runner（配置见 `apps/web/playwright.config.ts`），**不用 vitest**。
单测/桥层仍是 vitest（`src/**/*.test.ts`）；e2e 独立成 runner（行业「双 runner」形态，各自幂等）。

入口：`pnpm --filter @hermes-web/web e2e`（= `playwright test`，testDir `./e2e`，testMatch `**/*.e2e.ts`）。

## 隔离模型（关键，替代旧的「共享单例代理 + 串行单 worker」）

每个 **Playwright worker 独享一套拓扑**（worker 级 `stack` fixture，见 `e2e/fixtures.ts`）：

- 自己的 Deno 代理 + Vite dev server + mock 端口（端口从 `workerIndex` 派生，见 `helpers/topology.ts#portsFor`）。
- 因此 **spec 文件可并行**（`playwright.config.ts` `workers: 4`，`fullyParallel: false` 保证单 worker 内一次一文件）。
- 某 spec 重启**自己 worker 的代理**（reconnect B：`startProxy(stack.proxyPort)`）不会再打翻其它 worker 的连接 —— 这是并行安全的前提。
- 每个 worker 的 Vite 烘焙自己的 `VITE_MOCK_GATEWAY_WS` → 清注册表 boot 的默认 seed 指向本 worker 的 token mock（无需改 app）。

## 端口（每 worker 一套，`portsFor(workerIndex)` 0-based）

| 角色          | 端口          |
| ------------- | ------------- |
| token mock    | `30000 + w*3` |
| oauth mock    | `30001 + w*3` |
| password mock | `30002 + w*3` |
| Deno 代理     | `28100 + w`   |
| Vite dev      | `27100 + w`   |

`stack.appUrl`（boot）/ `stack.tokenTarget` / `stack.oauthTarget` 即本 worker 的 URL；不要用模块固定端口常量。

## 进程管理

- `stack` fixture（worker 级）拉起本 worker 的 proxy + Vite，worker 结束时回收。
- 每个 spec 在 test 体内 `stack.startMock(port, { oauth?, password? })` 启自己需要的 mock，结尾 `stack.stopMock(port)`。
- 中断进程：`stopByPort(port)`；重启 mock：`stack.startMock(port)` + `waitForHttp`；重启 proxy：`startProxy(stack.proxyPort)` + `waitForHttp(`${api}/proxy/meta)`。
- 不用 `dev/dev.mjs`（其连环杀兄弟进程，reconnect 会误杀）。

## Helpers

- `topology`：`startMock/startProxy/startVite/stopByPort/waitForHttp/pidsByPort/killPort/portsFor`。
- `bridge`：`waitForReady`、`waitForBodyText`、`waitFor`（页面表达式轮询）/ `poll`（Node 侧轮询）、`gotoHash`（HashRouter，pushState 无效）、`bootClean`、`oauthLogin/oauthLogout`、`getConfig`、`wsJsonRpc`、`saveOauthConnection`。
- `chat`：`sendChat(page, text)`。
- `registry`：`clearRegistry/setRegistry/readRegistry/tokenRegistry`（localStorage `hermes-web.connections.v1`）。

> `page.evaluate`/`waitFor` 内的函数会被序列化到页面执行：不得闭包引用任何外层/Node 变量（`text`/helper/`page` 都不行），只能用页面全局（`window/document/location/localStorage`）。

## 迁移模式（vitest → playwright）

- 每个旧 `describe` 折叠成 **ONE `test(...)`**；链式有状态 `it` 逐个包进 `await test.step('<原 it 标题>', ...)` 保共享状态与顺序。
- setup 置顶（`startMock`/`waitForHttp`/`page.goto(stack.appUrl)`/`waitForReady`/`bootClean`），teardown（`stopByPort`）置末尾；`browser.close()` 由 Playwright 托管，不写。
- 断言用 `@playwright/test` 的 `expect`；Node 侧轮询仍用 `poll`。
- 移动视口：文件顶层 `test.use({ viewport: { width: 390, height: 844 } })`，不用 `launchBrowser/launchMobilePage`。

## 使用

```bash
pnpm --filter @hermes-web/web e2e:install   # 一次性：playwright install chromium
pnpm --filter @hermes-web/web e2e           # 全量（multi-worker 并行）
pnpm --filter @hermes-web/web exec playwright test e2e/ui.e2e.ts   # 单个
```

spec 覆盖：`smoke`（boot）、`oauth`（桥层 native OAuth + chat + 刷新 + 登出）、`oauth-paste`（ADR-0017 paste-back）、
`ui`（设置页 Sign in + chat + 刷新）、`composer-overflow`、`reconnect`（A 断连重连 / B 代理重启会话保留 / C 断连发送反馈）、
`boot-failure`（overlay + Use local gateway / Repair / Logs 隐藏 + mode 卡只留 remote）、`find`（ADR-0019 Ctrl+F）、
`attach`（ADR-0020 文件拖入落盘）、`responsive`（移动视口设置页 + 状态栏可读）、`dev-remote`（无 mock boot 恢复）。
