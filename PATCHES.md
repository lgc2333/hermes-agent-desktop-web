# PATCHES.md — Vendor Patch & Sync Register

本文件登记所有对 vendor 目录的原位改动、subtree 基准与同步流程。
原则（AGENTS.md 规则「vendor 纪律」）：vendor 内原位修改收敛到最少文件；能新加文件就不改旧文件。

## 1. Subtree 基准（Baseline）

- 上游仓库：https://github.com/NousResearch/hermes-agent.git
- 基准提交：`13ce0c5c675e843af70d19c9e5144249cd51c8d1`(上游 **main** HEAD，2026-08-19)
- vendor/hermes-desktop：上游 `apps/desktop`（含 src/ 渲染层、scripts/、vite.config.ts 等）
- vendor/hermes-shared：上游 `apps/shared`（`@hermes/shared` 源码）
- 引入方式：`git subtree add --squash`（对过滤提交执行，见 §2）
- 当前子树 split：hermes-desktop: `8b49349f4b8e044c32eef7ba197d1f1f7392bfed`；hermes-shared: `7aa52d730ea793956633615e539beb2e7ddecbaa`

### 2. 引入方式说明（重要）

上游是 monorepo，`git subtree add` 直接对上游提交执行会把**整个仓库**（Python 后端等）
挂到 prefix 下。本仓库只 vendoring 桌面渲染层与共享协议层，因此先对上游子树路径做
**过滤提交**（commit-tree，树 = 上游 `apps/desktop` / `apps/shared`），再对过滤提交执行
`git subtree add --prefix=vendor/hermes-desktop <filtered> --squash`。

这样 vendor 内容与上游对应路径**逐字节一致**（树 SHA 相等），且 `git-subtree-split`
指向本地可解析的过滤提交。M0 引入时的操作：

```bash
# 在本地上游克隆（research/upstream）中取树
DESKTOP_TREE=$(git rev-parse d2672a3:apps/desktop)
SHARED_TREE=$(git rev-parse d2672a3:apps/shared)
# 造过滤提交（树 = 子树路径的树）
FILTERED_DESKTOP=$(git commit-tree $DESKTOP_TREE -m "hermes-desktop subtree source: upstream apps/desktop @ d2672a3")
FILTERED_SHARED=$(git commit-tree $SHARED_TREE -m "hermes-shared subtree source: upstream apps/shared @ d2672a3")
# 引入
git subtree add --prefix=vendor/hermes-desktop $FILTERED_DESKTOP --squash
git subtree add --prefix=vendor/hermes-shared  $FILTERED_SHARED --squash
```

### 3. 同步流程（subtree pull）

因过滤提交不在上游历史中，同步用 `git subtree merge --squash` 对**新过滤提交**执行。
完整流程见 `scripts/sync-upstream.sh`（fetch --depth=1 → commit-tree 过滤提交 →
subtree merge，desktop/shared 循环处理；已处理浅取 tag 的 `^{commit}` peel 与
squash 后清理）。

**git-subtree 依赖历史 split 对象（过滤提交）**：`git subtree merge` 会从历史
squash 提交的 message 里 `rev-parse` 旧过滤提交作为 merge 基准。过滤提交是本地造的、
**不挂任何 ref、只被 message 引用**——是"不可达对象"，任何 `git gc`（默认 2 周
grace 期后；`--prune=now` 只是立即触发）都会把它回收，随后 merge fatal `could not
rev-parse split hash`（2026-08-18 实测）。**防再犯：过滤提交必须挂 ref 保护**
（`git update-ref refs/subtree-anchors/<dir> <filtered-sha>`，见 sync-upstream.sh）。
split 命令遍历全部历史、无法靠堆新提交恢复（merge 可以，见下）。

**若 split 对象已丢（2026-08-18 修复记录）**：merge 可恢复——在 HEAD 上堆
**两个纯 message squash 提交**（desktop/shared 各一，树 = 上一基准的上游纯树
**不含补丁**），`git-subtree-split` 指向新造的过滤提交（commit-tree 树 = 该
上游纯树），并**挂 ref 保护新过滤提交**。HEAD 树保持不变（含补丁），它相对锚点的
delta = 恰好是 §4 补丁，三方合并即自动保留补丁。**锚点树必须纯上游**——若锚点树
带补丁，base==ours，merge 会静默覆盖全部补丁（2026-08-18 实测踩坑）。
`git subtree split`/`push` 遍历全部历史仍不可用，本项目只做下游 merge 不受影响。

m3/main 实测：上游 main 相对上一基准只改了 11 个补丁文件里的 4 个
（global.d.ts、i18n/en|zh|types），三方合并全部无冲突自动合入；桥层
补 main 新增 `getProfileRoutes` 表面（空实现）。

## 4. 当前 vendor 原位改动清单

- vendor/hermes-desktop/src/styles.css
  - 改动：`@import 'tailwindcss'` 后加两行 `@source '../../hermes-desktop/src'` 与 `@source '../../hermes-shared/src'`
  - 原因：Tailwind v4 自动扫描只覆盖 vite root（apps/web），vendor 源码的类名不生成 CSS 规则（M0 验证时发现界面下半部无样式崩坏）；@source 让 Tailwind 扫描 vendor 源码
  - 同步注意：路径相对 styles.css（位于 vendor/hermes-desktop/src），指向 vendor 自身，subtree pull 后依旧有效；若上游改 styles.css 头部导致 @source 行丢失，按本条恢复

- vendor/hermes-desktop/src/app/chat/index.tsx
  - 改动：voice 配置 `enabled: false` 恢复为 `enabled: true`（附注释），去掉 Web 布尔门
  - 原因：ADR-0022 语音入 Web 计划——上游 remote 模式原生支持语音，恢复 dictation pill（此前按产品范围关掉；如今流式 TTS + 听写 + 自动朗读已通 proxy 链路，麦克风门在 apps/web 桥层放行）
  - 同步注意：上游若重构 voice 配置，按注释恢复（语义权威 = PATCHES.md §4 / ADR-0022）

- vendor/hermes-desktop/src/global.d.ts
  - 改动：新增 `DesktopPasswordLoginResult` 接口 + `hermesDesktop.passwordLoginConnectionConfig` 表面（M5 密码 "dashboard login"）；新增 `oauthPasteConnectionConfig(remoteUrl, pasted)` 表面（M6 paste-back，ADR-0017）
  - 原因：Web 端密码门禁登录走代理 /api/proxy/session/login（ADR-0013）；远端部署 OAuth 需粘贴回跳（ADR-0017）。桌面端均不实现（桥面存在但桌面 main 进程不注册，渲染层仅在 Web 分支调用）
  - 同步注意：上游若改动 hermesDesktop 表面或 oauth 登录签名，按 M5/M6 语义合并（该能力是 Web 专有扩展）

- vendor/hermes-desktop/src/app/settings/gateway-settings.tsx
  - 改动：oauth 分支按 isPasswordProvider 分流——未登录渲染用户名/密码表单（调 passwordLoginConnectionConfig），已登录保持原 pill + sign-out；新增 authUsername/authPassword 状态与 passwordSignIn 处理器（M5）。M6：OAuth 未连接时渲染 paste-back 区块（Textarea + 提交按钮，调 oauthPasteConnectionConfig），新增 pastedUrl/pasteSubmitting 状态与 pasteSignIn 处理器。M7 修复：passwordSignIn 发送凭证前先 saveConnectionConfig（与 OAuth signIn 同款）——表单 URL 若只是 meta 下发的显示级预填（defaultGatewayUrl），登录后注册表仍指向出厂 mock，白名单（ADR-0015）下所有 REST/WS 转发 403 target not allowed（清 cookie 重登"登录成功但没连上"根因）
  - 原因：Web 端没有 gateway 登录弹窗（桌面靠 Electron partition cookie）；表单直接 POST /auth/password-login（经代理），密码不落盘；远端部署 OAuth 需粘贴回跳（ADR-0017）
  - 同步注意：上游若重构 auth 区块 JSX/登录流，按 "密码 provider → 凭据表单 / OAuth → 登录按钮 + paste 回退" 语义恢复；passwordSignIn 的登录前 saveConnectionConfig 是 Web 专有修复（依赖 Web 桥 saveConnectionConfig 落盘 registry），上游无此语义；i18n 键 authUsername/authPassword/authPaste* 在 types.ts 已声明

- vendor/hermes-desktop/src/components/first-run-remote-form.tsx
  - 改动：同 gateway-settings——密码 provider 渲染用户名/密码表单（passwordSignIn，M5）；OAuth 未连接时渲染 paste-back 区块（M6）
  - 原因：同上（首启表单与设置表单同源同语义）
  - 同步注意：同上

- vendor/hermes-desktop/src/components/boot-failure-overlay.tsx
  - 改动：signInRemote 统一路由到嵌入式 Gateway settings 视图（setView('connect')）——M5 起密码 reauth 如此；M6 起 OAuth reauth 同样如此（paste 提示只在 Settings/首启表单一处，无第三份并行副本）
  - 原因：Web 端 reauth 的唯一入口是设置面板里的凭据表单/登录按钮（远端浏览器够不到代理 loopback，必须经 paste）
  - 同步注意：上游若改 reauth 动作列表，保留该路由；已删除 overlay 内直连 OAuth 弹窗路径

- vendor/hermes-desktop/src/i18n/en.ts / zh.ts / types.ts
  - 改动：settings.gateway 与 install 两节新增 authUsername / authPassword（install 另有 authNeedsPassword，M5）；新增 authPasteHint / authPastePlaceholder / authPasteSubmit（M6，两节同键）；types.ts 同步声明
  - 原因：密码表单与 paste-back 文案
  - 同步注意：上游 i18n 合入新键时按名合并，勿覆盖 M5/M6 键

- vendor/hermes-desktop/src/app/hooks/use-keybinds.ts
  - 改动：`'view.findInPage': openFindBar` 改为条件展开——`import.meta.env.VITE_WEB_BUILD === '1'`（Web 构建时 vite define 注入，见 apps/web/vite.config.ts）时不注册该 handler
  - 原因：Web 端 find 桥面布尔门 denied（ADR-0010/0011），命中会 preventDefault + 打开无功能 find-bar、吞掉浏览器原生查找；handler 缺失 → dispatch 走 "无 handler → return"（不 preventDefault），浏览器原生查找（Ctrl/Cmd+F）接管（ADR-0019）。重绑/多绑定语义自动正确：任何 combo 命中 view.findInPage 都无效，mod+f 改绑其他动作照常执行
  - 同步注意：桌面构建不读 VITE_WEB_BUILD，行为不变；上游若重构 handlersRef 或 view.findInPage 接线，按"Web 构建不注册该 handler"语义恢复
  - v2026.8.16 同步：上游给桌面 handler 内加了 overlay 路由抑制（`isOverlayView` + `appViewForPath`），已并入 Web 条件展开的桌面分支（Web 分支不注册，无 overlay 冲突）

- vendor/hermes-desktop/src/global.d.ts
  - 改动：`hermesDesktop` 表面新增可选 `saveImageFile(blob, name)` 与 `releaseBlobFile(filePath)`（ADR-0020 附件字节存储二分：File 引用 / OPFS）。桌面端 main 进程不注册（保持可选），Web 桥面 adapter.ts 实现
  - 原因：Web 端浏览器 File 无 gateway 侧路径，附件字节存储改 File 引用 + OPFS 落盘（ADR-0020），渲染层经这两入口存取/释放本地字节；submit 提交链路复用 data_url 零改动
  - 同步注意：上游若增改 hermesDesktop 附件相关表面，按"saveImageFile 优先、saveImageBuffer 回退"语义合并（见 use-composer-actions.ts 条目）

- vendor/hermes-desktop/src/app/chat/hooks/use-composer-actions.ts
  - 改动：三处（ADR-0020）——① attachImageBlob 去掉无条件 arrayBuffer()，改为优先调 `window.hermesDesktop.saveImageFile(blob, name)`（Web：File 保留引用 / Blob 落 OPFS），桌面端无该表面时回落旧 `saveImageBuffer` bytes 路径；② 新增 `attachFileBlob(file)`：`saveImageFile(file) → attachContextFilePath(虚拟路径)`，attachDroppedItems 非图片分支在 `!filePath`（浏览器 File 无路径）时调用；③ removeAttachment 对 `web-blob://` 前缀路径附件调 `releaseBlobFile` 显式释放本地字节
  - 原因：Web 端非图片文件拖拽恢复可用（ADR-0020），图片迁移到 File 引用 / OPFS；chip 移除释放字节，残留由页面刷新兜底
  - 同步注意：桌面构建 `saveImageFile` 为 undefined → 走原 saveImageBuffer 路径，行为不变；上游若重构 attach 链路（如新增桥面方法），按"Web 专有扩展可选 + 窄回退"语义合并；`attachFileBlob` 仅浏览器 File 无路径分支生效，不触及桌面路径附加

- vendor/hermes-desktop/src/global.d.ts
  - 改动：`hermesDesktop` 表面新增**可选** `streamMediaUrl(path): Promise<null|string>`（ADR-0022，媒体播放入口）。桌面端 main 进程不注册该表面（保持可选）→ 桌面 `resolveMediaPlaybackSrc` 走回 `hermes-media://` 协议，行为不变；Web 桥面 adapter.ts 实现（返回同源代理流 URL）
  - 原因：浏览器无 Electron main 进程等价物，媒体元素发不了鉴权头；把"怎么流"还给各环境，Web 返回 /api/proxy/media-stream 代理流 URL（Range/seek）
  - 同步注意：上游若新增同名桥面，按其签名对齐即可；remove 语义=回退 hermes-media，勿覆盖

- vendor/hermes-desktop/src/lib/media.ts
  - 改动：`resolveMediaPlaybackSrc` 的 audio/video 分支先委托 `window.hermesDesktop.streamMediaUrl?.(path)`（存在且返回非 null 则用之），否则回退现有 `isRemoteGateway() ? mediaGatewayStreamUrl : mediaStreamUrl`（桌面 hermes-media:// 协议）
  - 原因：ADR-0022 桥优先级——Web 桥面返回同源代理流 URL；桌面无该表面时零回归
  - 同步注意：上游若改 resolveMediaPlaybackSrc 分支结构，保留"桥委托 + null/缺省回退"语义

## 5. 需注意的上游联动

非 vendor 但依赖 vendor/上游结构、subtree pull 后需核对的 Web 侧文件：

- apps/web/index.html
  - Web 构建入口。原为符号链接，实测后发现构建报错。
  - 同步注意：subtree pull 后若上游改 vendor/hermes-desktop/index.html，
    直接照抄 vendor 版即可（Web 侧无差异需保留）。

- apps/web/src/main.tsx
  - Web 入口：装桥（installWebBridge）→ import vendor 渲染树 + web.css，
    顺序即桥先于渲染层就位。
  - 同步注意：上游若重构 src/main.tsx 入口（改名/换路径/改 boot 序列），
    此 import 与装桥顺序须按新结构核对。

- apps/web/src/web.css
  - Web 覆盖层（非 vendor）：隐藏桌面专属 UI、适配移动端视口等 Web 差异。
  - 同步注意：上游若改这些 class/data-slot/按钮结构，覆盖会静默失效——
    subtree pull 后按头注锚点核对（e2e：cdp-mobile3 / cdp-hide-modes /
    cdp-repair-logs 等回归）。

- apps/web/vite.config.ts（+ tsconfig.json / vitest.config.ts）
  - 别名与 include 指向 vendor 源码；publicDir 直接复用 vendor public/
    （不复制）。vite.config.ts 头注已说明：subtree pull 除路径常量外无需对账。
  - 同步注意：上游若移动目录或改入口模块名（如 src/debug/dev-only.ts），
    更新三处配置的路径常量与别名即可。
  - driver.js 别名（2026-08-19 同步起）：上游 tour 功能 import
    `driver.js/dist/driver.js.iife.js?raw`，但该包 exports map 不暴露此 dist
    文件；上游在 vendored vite.config.ts 用 resolve.alias 指到真实 sibling，
    我们 apps/web/vite.config.ts 同样需镜像该别名（+ optimizeDeps.exclude）。
    缺失则 rolldown 构建报 `"./dist/driver.js.iife.js" is not exported`。

- apps/web/src/bridge/
  - WebCapabilityAdapter 实现 window.hermesDesktop 表面，签名以
    vendor/hermes-desktop/src/global.d.ts（本身是 §4 登记的 vendor 改动）为准。
  - 同步注意：上游若增改 hermesDesktop 表面，桥层（adapter.ts +
    browser/gateway/denied）须同步适配，typecheck 兜底。

## 6. 同步后必做

1. `pnpm install`（apps/web）
2. `pnpm --filter @hermes-web/web typecheck` + 关键 vitest/e2e
3. 更新 §1 基准 SHA 与本文档

## 7. 同步坑(Checklist)

每次同步(追 main / 追 tag)按此清单核对;主流程
`scripts/sync-upstream.sh`(git subtree merge,自动保留 §4 补丁),fallback
`scripts/vendor-merge-manual.sh`(手工三路,split 对象损坏时用)。

- **过滤提交（subtree split 对象）必须挂 ref 保护** —— 它们不挂任何 ref、只被
  squash message 引用,`git gc`(含普通 gc,2 周 grace 后)会回收,merge 即坏。
  挂 `git update-ref refs/subtree-anchors/<dir> <sha>`;已损坏恢复法见 §3。
- **subtree merge 能跑 ≠ 补丁保留**:锚点 squash 树必须纯上游(无补丁),带补丁
  会 base==ours 静默覆盖全部补丁(§3 修复记录)。merge 后抽查 §4 关键补丁。
- 浅取必须 `--depth=1`,sync 后清 shallow 边界与本地 tag 引用(§3)。
- **fetch 报 `Could not read <sha>`** = 陈旧 `refs/remotes/upstream/*` tracking
  ref 链上对象缺失(浅取累积)。sync-upstream.sh 已自动清理;手动跑 fetch 前先
  `git update-ref -d refs/remotes/upstream/main`(详见 docs/sync/2026-08-18-2.md)。
- **shared 也可能变**: 对比 `<base>:apps/shared` vs `<new>:apps/shared`,
  变了就同步 vendor/hermes-shared。
- **上游新增子路径模块但 package exports 没更新** → tsconfig/vite 缺别名
  TS2307。按 billing 同款补 `@hermes/shared/<mod>` 映射。
- **3-way 文本无冲突 ≠ 语义无冲突**: 上游删领域概念(如 scope)时,补丁
  残留引用悬空(TS2304/TS7006)。人工核对并适配。
- **桥面契约同步**: 上游 global.d.ts 签名变化时,apps/web/src/bridge/
  (denied.ts/adapter.ts)须同步类型。
- **vendor 测试 import 子树外 fixtures** 会破坏 typecheck(已用 tsconfig
  `exclude: vendor/**/*.test.*` 隔离)。

## 8. 同步记录

见 `docs/sync/`(`YYYY-MM-DD-N.md`)。
