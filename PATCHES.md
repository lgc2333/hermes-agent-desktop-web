# PATCHES.md — Vendor Patch & Sync Register

> 本文件登记所有对 vendor 目录的原位改动、subtree 基准与同步流程。
> 原则（PLAN.md §5）：vendor 内原位修改收敛到最少文件；能新加文件就不改旧文件。

## 1. Subtree 基准（Baseline）

| 项 | 值 |
|----|----|
| 上游仓库 | https://github.com/NousResearch/hermes-agent.git |
| 基准提交 | `d2672a349b6e783868e681735b45cad181cb05a8`（2026-08-15，桌面端 0.17.0） |
| vendor/hermes-desktop | 上游 `apps/desktop`（含 src/ 渲染层、scripts/、vite.config.ts 等） |
| vendor/hermes-shared | 上游 `apps/shared`（`@hermes/shared` 源码） |
| 引入方式 | `git subtree add --squash`（对过滤提交执行，见 §2） |
| 当前子树 split | hermes-desktop: `800e98cc0b2d547199df0e3056d169396e70ee71`；hermes-shared: `ca95b9cc143b0e7b4a749ef9d42bc22d31d82ff9` |

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
（见 scripts/sync-upstream.ps1，工作流与 §2 相同）：

```bash
git fetch upstream <tag-or-main>
NEW_DESKTOP_TREE=$(git rev-parse FETCH_HEAD:apps/desktop)
NEW_FILTERED=$(git commit-tree $NEW_DESKTOP_TREE -m "hermes-desktop @ <sha>")
git subtree merge --prefix=vendor/hermes-desktop $NEW_FILTERED --squash
# 同法处理 hermes-shared；同步后把新基准 SHA 记入 §1 表格
```

## 4. 当前 vendor 原位改动清单

| 文件 | 改动 | 原因 | 同步注意 |
|------|------|------|----------|
| vendor/hermes-desktop/src/styles.css | `@import 'tailwindcss'` 后加两行 `@source '../../hermes-desktop/src'` 与 `@source '../../hermes-shared/src'` | Tailwind v4 自动扫描只覆盖 vite root（apps/web），vendor 源码的类名不生成 CSS 规则（M0 验证时发现界面下半部无样式崩坏）；@source 让 Tailwind 扫描 vendor 源码 | 路径相对 styles.css（位于 vendor/hermes-desktop/src），指向 vendor 自身，subtree pull 后依旧有效；若上游改 styles.css 头部导致 @source 行丢失，按此表恢复 |
| vendor/hermes-desktop/src/app/chat/sidebar/index.tsx | 顶部加 `GATE_ARTIFACTS_NAV = false`，被关条目抽成具类型常量 `ARTIFACTS_NAV_ITEM: SidebarNavItem`，用 `...(GATE_ARTIFACTS_NAV ? [ARTIFACTS_NAV_ITEM] : [])` 条件展开 | Web 布尔门（PLAN §1 Q9）：artifacts（制品/文件）入口在 Web 版关闭；apps/web/src/bridge/gates.ts 为语义权威 | subtree pull 后若上游改了 SIDEBAR_NAV 结构，按文件顶部注释恢复；条件展开写法保持具类型常量，勿退回内联对象（会丢上下文类型） |
| vendor/hermes-desktop/src/app/contrib/surfaces.tsx | 顶部加 `GATE_ARTIFACTS_ROUTE = false`，artifacts 路由用 `{GATE_ARTIFACTS_ROUTE ? <Route .../> : null}` 条件挂载 | Web 布尔门：/artifacts 路由不挂，直开回落 chat，避免渲染被关页面 | 同上；上游若改 ChatRoutesSurface 路由表，按注释恢复 |
| vendor/hermes-desktop/src/app/command-palette/index.tsx | 顶部加 `GATE_ARTIFACTS_NAV = false` 与 `GATE_AGENTS_NAV = false`，palette 中 artifacts/agents 两行条件展开 | Web 布尔门：命令面板两入口关闭 | 同上；上游若改 palette 条目，按注释恢复 |
| vendor/hermes-desktop/src/app/shell/hooks/use-statusbar-items.tsx | 顶部加 `GATE_AGENTS_STATUSBAR = false`，Agents 状态栏条目条件展开，内层数组加 `satisfies StatusbarItem[]` 保持上下文类型 | Web 布尔门：状态栏 Agents 入口关闭 | 同上；`satisfies` 仅用于单行数组字面量场景，多行 + 紧邻 `)` 会触发 TS 解析器 bug（用具类型常量最稳） |
| vendor/hermes-desktop/src/app/chat/index.tsx | 顶部 voice 配置 `enabled: true` 改为 `enabled: false`（附注释） | Web 布尔门：语音移出 Web 计划，关闭 dictation pill | 上游若重构 voice 配置，按注释恢复 |

### 4.1 非 vendor 配套（M1 批，记录于此便于回溯）

| 文件 | 改动 | 原因 |
|------|------|------|
| apps/web/tsconfig.json | `types: ["vite/client"]`（不自动 include 全部 @types）；paths 把 react/react-dom/jsx-runtime 直接钉到 root `../../node_modules/@types/*/index.d.ts` | pnpm 下 apps/web 与 root 各有一份 @types/react，jsx-runtime 从不同根解析 → 全库 "Two different types with this name exist" 伪错（M0 遗留，CLI 因 TS5101 提前退出从未暴露）；映射 .d.ts 文件（非包目录）让两处解析到同一实例。删 baseUrl 会切到 TS6 新 paths 模式产生模块身份重复，故保留 baseUrl + in-process typecheck 过滤 TS5101 |
| apps/web/vite.config.ts | server.watch.ignored 加 `['**/.package.json.*', '**/*.tmpdir/**']` | Windows 下 pnpm 在 app root 下生成 .package.json.*.tmpdir 目录，chokidar 监听其在删除时崩溃（EBUSY）。注：此改动在 M1 会话开始前已存在于工作区（非本轮所作），合理，随本批提交 |


## 5. 同步后必做

1. `pnpm install`（apps/web）
2. `pnpm --filter @hermes-web/web typecheck` + 关键 vitest/e2e
3. 更新 §1 基准 SHA 与本文档