# PATCHES.md — Vendor Patch & Sync Register

本文件登记所有对 vendor 目录的原位改动、subtree 基准与同步流程。
原则（AGENTS.md 规则「vendor 纪律」）：vendor 内原位修改收敛到最少文件；能新加文件就不改旧文件。

## 1. Subtree 基准（Baseline）

- 上游仓库：https://github.com/NousResearch/hermes-agent.git
- 基准提交：`e624e9fde561e1add9388384012b295fde669ade`(上游 **main** HEAD，2026-08-18)
- vendor/hermes-desktop：上游 `apps/desktop`（含 src/ 渲染层、scripts/、vite.config.ts 等）
- vendor/hermes-shared：上游 `apps/shared`（`@hermes/shared` 源码）
- 引入方式：`git subtree add --squash`（对过滤提交执行，见 §2）
- 当前子树 split：hermes-desktop: `caf535b050d572588847b072b0339f8b7fdf72de`；hermes-shared: `8b09caae37870a2f2059fdda0250dc63bcec5f30`

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

因过滤提交不在上游历史中，同步用 `git subtree merge --squash` 对**新过滤提交**执行
（见 scripts/sync-upstream.sh，工作流与 §2 相同）。

**fetch 必须 --depth=1（浅取）**：上游 hermes 是 monorepo 且 commit 极多，全量拉取
会把整个仓库对象灌进本地；叠加断连中断的 tmp_pack 残留会让 .git 膨胀到 GB 级（实测追
一次 tag 后 .git 冲到 1GB，其中 ~958MB 是中断打包的 tmp_pack_*。git gc 不自动删这类
垃圾，需手动清 `git gc` 后再删 `.git/objects/pack/tmp_pack_*`）。本地 vendor 是 squash
的，只要目标提交 apps/desktop|shared 两棵完整子树，不需要上游历史。浅取对 tag 时
FETCH_HEAD 是 tag 对象，先 `^{commit}` peel 再取树。sync 落盘后应清理 shallow 边界与
本地 tag 引用，恢复非 shallow 小体积仓库：

```bash
git fetch upstream --depth=1 <tag-or-main>
NEW_DESKTOP_TREE=$(git rev-parse FETCH_HEAD^{commit}:apps/desktop)
NEW_FILTERED=$(git commit-tree $NEW_DESKTOP_TREE -m "hermes-desktop @ <sha>")
git subtree merge --prefix=vendor/hermes-desktop $NEW_FILTERED --squash
# 同法处理 hermes-shared；同步后把新基准 SHA 记入 §1 清单
```

**git-subtree 依赖历史 split 对象，别把它们 prune 掉**：`git subtree merge` 会从
历史 squash 提交的 "from A..B" 里 `rev-parse` 旧过滤提交（A/B）作为 merge 基准；上一轮
`git gc --prune=now` 清过这些中间对象后，subtree 直接 fatal `could not rev-parse split
hash`（git 2.55 实测）。此时改**手工三路**（等价于 subtree 内部，保留全部补丁）：

```bash
# index 清空旧 vendor，挂载上游目标树
git read-tree HEAD^{tree}
git ls-files vendor/hermes-desktop | git update-index --force-remove --stdin
git read-tree --prefix=vendor/hermes-desktop/ $NEW_FILTERED^{tree}
# 复位上游未改动的补丁文件为 HEAD 版：git update-index --cacheinfo 100644 <HEAD:...blob> <path>
# 上游也改动了的补丁文件做 3-way（base=上一版上游原版）：git merge-file -L main -L base -L ours out base ours
# shared 同理：git read-tree --prefix=vendor/hermes-shared/ <main^tools>:apps/shared
# 然后 git checkout-index -a -f 同步工作树、write-tree、add、commit
```

m3/main 实测：上游 main 相对上一基准只改了 11 个补丁文件里的 4 个
（global.d.ts、i18n/en|zh|types），`git merge-file` 3-way 全部无冲突自动合入；桥层
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
  - Web 构建入口（M4 生产构建修复）。原为指向 vendor/hermes-desktop/index.html
    的符号链接：dev 模式（vite serve）正常，但 rolldown 生产构建（vite build）对
    symlink 解析出的跨目录路径报错（"fileName must be neither absolute nor
    relative paths"），导致 Dockerfile 的构建阶段从未真正跑通。这里改为真文件，
    内容照抄 vendor 版（含 pre-paint 主题背景脚本）；原注释块已移入本文档，
    文件现与 vendor 版逐字节一致。
    同步注意：subtree pull 后若上游改 vendor/hermes-desktop/index.html，
    直接照抄 vendor 版即可（Web 侧无差异需保留）。

- apps/web/src/main.tsx
  - Web 入口：先 installWebBridge()（ESM import 顺序保证桥在渲染层模块图
    求值前就位，boot 侧 store 在模块作用域读 window.hermesDesktop），再
    import vendor 渲染树（../../../vendor/hermes-desktop/src/main）与 web.css。
    同步注意：上游若重构 src/main.tsx 入口（改名/换路径/改 boot 序列），
    此 import 与装桥顺序须按新结构核对。

- apps/web/src/web.css
  - Web 覆盖层（非 vendor，M4）：选择器按 vendor DOM 结构锚定
    （data-slot='statusbar'、mode 卡片 .grid.auto-rows-fr.grid-cols-1、
    boot-failure 按钮行等），web.css 头注标注每条规则的"全库唯一"锚点。
    同步注意：上游若改这些 class/data-slot/按钮结构，覆盖会静默失效——
    subtree pull 后按头注锚点核对（e2e：cdp-mobile3 / cdp-hide-modes /
    cdp-repair-logs 等回归）。

- apps/web/vite.config.ts（+ tsconfig.json / vitest.config.ts）
  - 别名与 include 指向 vendor 源码：'@' → vendor/hermes-desktop/src、
    '@hermes/shared' → vendor/hermes-shared/src、'@hermes/plugin-sdk'、
    '@/debug/dev-only'（serve 真模块 / build noop 双态）；publicDir 直接复用
    vendor public/（不复制）。vite.config.ts 头注已说明：subtree pull 除
    路径常量外无需对账。
    同步注意：上游若移动目录或改入口模块名（如 src/debug/dev-only.ts），
    更新三处配置的路径常量与别名即可。

- apps/web/scripts/build-version.mjs
  - 构建版本计算（ADR-0014）：读 vendor/hermes-desktop/package.json 的版本
    拼 WEB_VERSION（<上游桌面版本>+web.<项目标识>），subtree 同步后自动跟随，
    无需手工改；无 git 检出（Docker 构建）时退回 apps/web 版本号。

- apps/web/src/bridge/
  - WebCapabilityAdapter 实现 window.hermesDesktop 表面，签名以
    vendor/hermes-desktop/src/global.d.ts（本身是 §4 登记的 vendor 改动）为准。
    同步注意：上游若增改 hermesDesktop 表面，桥层（adapter.ts +
    browser/gateway/denied）须同步适配，typecheck 兜底。

## 6. 同步后必做

1. `pnpm install`（apps/web）
2. `pnpm --filter @hermes-web/web typecheck` + 关键 vitest/e2e
3. 更新 §1 基准 SHA 与本文档

## 7. 同步备注

### 2026-08-18（→ main e624e9f）

追上游 **main** `e624e9f…`（相对上一基准 9ed4a7c）。仍走**手工三路**
（git-subtree 不可用，见下方「git-subtree 失效根因」）。本轮上游改动较大：
desktop 净变更 136 文件（+13078/−1981，translucency 玻璃效果、kanban
completion-notify、settings-scope、gateway 生命周期等）。

**12 个 §4 补丁文件中 6 个上游也改了**（styles.css、global.d.ts、
gateway-settings.tsx、i18n/en|zh|types），用 `git merge-file` 3-way
（base=9ed4a7c 原版 / ours=HEAD 补丁版 / main=e624e9f 新上游）——**全部
clean 零冲突**，Web 专有表面（passwordLogin/oauthPaste/streamMediaUrl/
saveImageFile、@source 两行、passwordSignIn/pasteSignIn）逐一核对保留。
其余 6 个补丁文件上游未变，直接保留 HEAD 版。hermes-shared 未动。

流程脚本：`/tmp/vendor-merge2.sh`（build 构建树+commit 不落盘 / apply
reset --hard 落地；CHANGED 文件 3-way、SAME 文件保留 HEAD、其余取新树）。

### git-subtree 失效根因（2026-08-18 查证）

`git subtree merge`/`split` 现在 fatal `could not rev-parse split hash
8674f2c… from commit 4c67cd9`。根因链：

1. vendor 引入用**过滤提交法**（本地 `commit-tree` 造的提交，树 = 上游
   apps/desktop），squash 提交 `4c67cd9` 的 message 记着
   `git-subtree-split: 8674f2c…`（指向本地过滤提交）。
2. 过滤提交**不是上游历史对象、也不挂在任何 ref 上**，只被该 message 引用。
3. 早前 `git gc --prune=now` 把它们当不可达对象回收（`cat-file` 已确认
   `8674f2c`/`800e98c`/`caf535b`/`8b09caa` 全部丢失，reflog 无痕迹）。
4. git-subtree 的 `find_latest_squash` 从 message 读 split hash 后
   `rev-parse` 失败 → 所有 subtree 命令（merge/split）都挂。

**修复选项**：(a) 重写 `4c67cd9` message 去坏引用（filter-repo，后续所有
SHA 变、需强推，收益低）；(b) 继续手工三路（已脚本化、两次全绿，推荐）。
**决策：持续用手工三路，不修 subtree。** 注意：`git gc` 别再 `--prune=now`
（普通 `git gc` 也会回收不可达对象，仅 prune=now 是即时强制）。后续同步
直接参考上方 2026-08-18 流程，勿再跑 `git subtree`。

### 2026-08-17（→ main 9ed4a7c）

追上游 **main** `9ed4a7c…`（相对上一基准 cf64ca20）。用**手工三路**而非
`git subtree merge`：早前 `git gc --prune=now` 清掉了 git-subtree 依赖的历史
split 对象，subtree 直接 fatal `could not rev-parse split hash`（PATCHES §3）。
流程：新 desktop 过滤提交（`128cbb93…`，树 = 上游 apps/desktop@9ed4a7c）read-tree
挂到 vendor/hermes-desktop/，12 个 §4 补丁文件在上游 base→new 间**全部未变**，
直接保留为 HEAD 版（无冲突、无 3-way）。hermes-shared base 与 new 树 SHA 相同
（未变），未动。本轮 desktop 净变更 21 文件（+1865/−139，主要为 hermes-bots
插件、budgeted-loop、image-generation-placeholder、connection-registry 等上游新增）。

清理（浅取副作用）：已 `git update-ref -d refs/tags/main`（若存在）、
`rm -f .git/shallow`、`git gc` 可恢复非 shallow 小体积仓库（未 prune 过滤提交，
本轮不再 prune，避免再次破坏 subtree split——后续同步继续用手工三路）。

### v2026.8.16

apps/web/tsconfig.json 增加 `exclude`，把 `vendor/**/*.test.*`
移出 web typecheck 程序。上游桌面测试会 import 其仓库根 `tests/fixtures/*`（子树外），
同步后新增此类引用会破坏本仓库 typecheck；vendor 测试并非本仓库运行/校验范围，
apps/web 自身测试（src/bridge/*.test.ts）仍受检。

桥层同步：上游新增 `hermesDesktop.onOpenFindBarRequested` 表面（find overlay 接口），
Web find 桥面延续布尔门 denied（ADR-0010/0011/0019），已在
apps/web/src/bridge/denied.ts 加 `onOpenFindBarRequested = noopUnsub` 并在
adapter.ts 透传；use-keybinds.ts 桌面分支并入上游 overlay 路由抑制（见 §4）。
