# Handoff — Hermes Desktop → Web 移植（v4）

> 生成时间：2026-08-15（第三轮，修订二）。工作区：D:\Coding\hermes-agent-desktop-web。
> 需求分析/领域建模已收敛，以工作区 PLAN.md / CONTEXT.md / PATCHES.md / docs/adr/ 为准。
> 本文只补它们没写的本轮上下文与操作注意事项。

## 1. 任务一句话

把 NousResearch/hermes-agent（MIT，monorepo）桌面端 React 渲染层移植为浏览器 Web 应用，
经 **Deno 无状态薄代理** 连接远程 Hermes gateway；**不 fork 上游**，用 git subtree 引用。

## 2. 已完成：M0 ✅ + 样式修复 ✅

M0 全部落地（main HEAD = 5d23e71），并在用户截图反馈后修复了一个真实样式 bug：

1. **git 仓库 + 真实 git subtree**（用户要求走回 git subtree 方案，权限已放开）：
   - git init → 基提交 → `git subtree add --squash` 引入
     vendor/hermes-desktop（上游 apps/desktop）、vendor/hermes-shared（上游 apps/shared），pin d2672a3
   - 上游是 monorepo，直接 subtree 会把整个仓库挂进 prefix → 用**过滤提交法**（commit-tree 造子树提交再 subtree add），
     树 SHA 与上游逐字节一致；详见 PATCHES.md §2 与 ADR-0001 修订
2. **提交身份**：用户要求用全局身份，local 已清除；历史全部 filter-branch 重写为
   `LgCuwukii <lgc2333@126.com>`。新提交用 git config user.name/email 全局值
3. **pnpm workspaces 骨架**：
   - 根 package.json + pnpm-workspace.yaml（packages: apps/*, vendor/hermes-desktop, vendor/hermes-shared）
   - **依赖隐式继承**（用户决策，ADR-0005）：apps/web 的 dependencies 只写 `"hermes": "workspace:*"`，
     渲染层依赖清单来自 vendor 包，不复制；vendor 的 devDeps（electron/node-pty/playwright 等）也装，
     但 build 脚本在 allowBuilds 全部拒绝（不下载二进制）
   - **nodeLinker: hoisted**（扁平 node_modules，vendor 源码从根解析）；`pnpm 11 配置只认 pnpm-workspace.yaml`，
     不读 package.json 的 pnpm 字段、不读 .npmrc（踩过坑）
   - upstream `@hermes/shared: file:../shared` 在我们布局指向 vendor/shared → pnpm-workspace.yaml
     `overrides: { "@hermes/shared": "workspace:*" }` 修正
4. **apps/web 浏览器跑通**（M0 验收）：入口 src/main.tsx 先装 dev-only mock bridge
   （src/bridge/mock-bridge.ts，M1 换成 WebCapabilityAdapter）再挂 vendor 渲染树；
   dev/mock-gateway.mjs（JSON-RPC WS 服务器，只要求 socket 打开）+ dev/dev.mjs 驱动
5. **样式修复（5d23e71，用户截图反馈）**：Tailwind v4 自动扫描只覆盖 vite root（apps/web），
   vendor 源码的类名不生成 CSS 规则 → 界面下半部无样式崩坏（状态条文本堆叠）。
   修复：vendor/hermes-desktop/src/styles.css 的 `@import 'tailwindcss'` 后加两行
   `@source '../../hermes-desktop/src'` 与 `@source '../../hermes-shared/src'`（PATCHES.md §4 已登记）。
   验证：CSS 157KB→418KB，headless 截图 + modlens 复核无崩坏
6. **symlink 策略**（用户决策）：index.html **symlink** vendor 原文件（git 120000 模式，subtree pull 自动同步）；
   vendor public/ 用 vite `publicDir` 直接服务（不 junction——junction 会被 git 当目录快照，不同步）；
   vite.config.ts **不能** symlink（vite 8 native config loader 不解析 `__dirname`，别名全失效，实测踩坑）
7. **scripts/sync-upstream.sh**（用户要求 bash 不用 pwsh）：过滤提交法 subtree merge 同步工作流
8. **domain-modeling**（用户 /domain-modeling）：CONTEXT.md 新增 Vendor 术语（20 词）；
   ADR-0001 修订（过滤提交法）；新增 ADR-0005（依赖隐式继承）

## 3. 仓库当前状态

```
main: 5d23e71 (LgCuwukii)
├── vendor/hermes-desktop, vendor/hermes-shared   # subtree（官方 squash+merge 结构）
│   └── hermes-desktop/src/styles.css              # +2 行 @source（PATCHES.md §4 登记）
├── apps/web    # pnpm --filter @hermes-web/web dev → http://127.0.0.1:5173（mock gateway :5180）
│   ├── src/main.tsx              # 入口：装 mock bridge → 挂 vendor 渲染树
│   ├── src/bridge/mock-bridge.ts # M0 占位桥（M1 换 WebCapabilityAdapter）
│   └── dev/                      # mock-gateway.mjs + dev.mjs
├── apps/proxy  # deno.json + src/main.ts 占位（M2）
├── scripts/sync-upstream.sh
└── PATCHES.md / CONTEXT.md / docs/adr/0001-0005
```

工作区 git status 干净；dev server 由会话后台任务持有（重启会话后需重新 `pnpm --filter @hermes-web/web dev`）。

## 4. 下一步：M1 换桥（本轮启动）

M1 目标：**WebCapabilityAdapter 替换 mock bridge + 布尔门 + 对 mock 后端跑通聊天全流程**。

1. **桥面盘点**（已核实）：渲染层只经 `window.hermesDesktop` 能力桥（~391 调用点/~25 方法，133 个走泛型 `api()`）；
   类型定义在 vendor/hermes-desktop/src/global.d.ts（保持不动，适配器按同一类型实现）
2. **WebCapabilityAdapter 三类实现**（apps/web/src/bridge/）：
   - 浏览器等价：clipboard / openExternal(window.open) / fetchLinkTitle / 通知(Notification API) 等
   - 走代理 RPC：`api()`（REST 转发）、getConnection/getGatewayWsUrl（连接注册表 localStorage，
     ADR-0002 凭证跟浏览器）、getBootProgress/onBootProgress 等 boot 面
   - 布尔门空实现：terminal / voice / 文件系统 / 窗口 / git / preview 等桌面能力 → 空实现或降级
3. **apps/web/src/gates.ts** 布尔门清单：voice/终端/文件/artifacts/agents/kanban 用 `if (false)` 关入口（代码保留）
4. **mock gateway 补方法面**（apps/web/dev/mock-gateway.mjs）：session.list / session.create / prompt.submit
   （流式 message.delta/message.complete）/ message.* / config.get 等 → 聊天全流程跑通
5. **验证**：headless Chrome（--dump-dom / --screenshot 均可，见 §5）检查聊天界面、发消息、流式回复
6. 上游 e2e（vendor/hermes-desktop/e2e/*.spec.ts + mock-server.ts）可复用思路，但上游是 Electron 启动——浏览器版要自建

后续：M2 代理+token 连真 serve（compose 双容器、serve 监听参数实测）→ M3 OAuth → M4 打磨+compose。

## 5. 环境与操作注意事项（重要，踩过的坑）

- **网络间歇故障**：registry.npmjs.org 经 node TLS 可达（Invoke-WebRequest 的 schannel 不行）；
  pnpm install 偶发 `UND_ERR_DESTROYED` 重试仍失败 → 加 `--network-concurrency 4 --fetch-retries 5`；
  最稳是重跑直到 done（store 有缓存，重跑快）。别用 `--force` 触发全量重建
- **pnpm 11 配置**：settings 全在 pnpm-workspace.yaml（camelCase 顶层键：nodeLinker/overrides/allowBuilds）；
  package.json 的 `pnpm` 字段被忽略（有 WARN）；.npmrc 的 shamefully-hoist 不生效
- **vite 8**：config 用 `import.meta.dirname`（vendor config 的 `__dirname` 依赖 legacy loader）；
  symlink 的 vite.config.ts 会被 native loader 加载但 __dirname 解析失败 → 别名失效
- **Tailwind v4**：自动内容扫描只覆盖 vite root；vendor 源码要 `@source` 指令（PATCHES.md §4 已登记），
  subtree pull 后检查该行是否还在
- **git subtree / sh**：沙箱放开后 `sh.exe` 可用，git subtree 命令正常；
  **不要对 git 命令输出用 Select-Object -First 截断管道**（broken pipe → 残留 .git/index.lock）
- **Windows symlink**：开发者模式已开，`cmd /c mklink` 可用；git core.symlinks=true 已设；
  文件 symlink 提交为 120000 模式；junction 会被 git 当目录快照（勿用于同步目的）
- **pnpm install 会因 ignored builds 报 exit 1**：allowBuilds 已显式列出全部（electron/node-pty/esbuild 等 false），
  属预期；确认依赖装没装看 node_modules 根目录（hoisted）
- **headless Chrome 验证**：`--dump-dom`（看渲染 DOM/CSS 规则）与 `--screenshot=路径`（看视觉）都可用；
  Start-Process -RedirectStandardOutput 可靠；截图参数用 `--screenshot=file` 等号形式避免 exit 13
- 身份：全局 LgCuwukii <lgc2333@126.com>；不要设 local user.name/email
- 上游 serve/dashboard 端口 9119 默认绑 127.0.0.1；compose 里 hermes 需监听非 loopback（M2 实测）
- 临时文件放 temp/<category>/（已 gitignore）

## 6. 建议技能（suggested skills）

- `tdd`：M1 桥适配器 / M2 代理转发逻辑，上游重度测试风格，测试先行
- `prototype`：M1 "对 mock 后端跑通聊天全流程" 是 spike（mock gateway 方法面补全）
- `chrome-devtools-cli`：M1/M2 浏览器调试渲染层（headless chrome --dump-dom/--screenshot 已验证可用）
- `domain-modeling`：M1 引入 WebCapabilityAdapter/gates 后如有术语或决策变动，更新 CONTEXT.md / 新增 ADR
- `grilling`：需求再有变动时用轮次提问收敛
- `handoff`：每轮会话结束前生成交接文档（本文件 v4）

## 7. 敏感信息

无 API key / 密码 / 个人身份信息（git 身份为用户指定的全局身份，非敏感）。
