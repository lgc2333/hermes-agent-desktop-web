# PATCHES.md — Vendor Patch & Sync Register

本文件登记所有对 vendor 目录的原位改动、subtree 基准与同步流程。
原则（AGENTS.md 规则「vendor 纪律」）：vendor 内原位修改收敛到最少文件；能新加文件就不改旧文件。

## 1. Subtree 基准（Baseline）

- 上游仓库：https://github.com/NousResearch/hermes-agent.git
- 基准提交：`d2672a349b6e783868e681735b45cad181cb05a8`（2026-08-15，桌面端 0.17.0）
- vendor/hermes-desktop：上游 `apps/desktop`（含 src/ 渲染层、scripts/、vite.config.ts 等）
- vendor/hermes-shared：上游 `apps/shared`（`@hermes/shared` 源码）
- 引入方式：`git subtree add --squash`（对过滤提交执行，见 §2）
- 当前子树 split：hermes-desktop: `800e98cc0b2d547199df0e3056d169396e70ee71`；hermes-shared: `ca95b9cc143b0e7b4a749ef9d42bc22d31d82ff9`

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
（见 scripts/sync-upstream.sh，工作流与 §2 相同）：

```bash
git fetch upstream <tag-or-main>
NEW_DESKTOP_TREE=$(git rev-parse FETCH_HEAD:apps/desktop)
NEW_FILTERED=$(git commit-tree $NEW_DESKTOP_TREE -m "hermes-desktop @ <sha>")
git subtree merge --prefix=vendor/hermes-desktop $NEW_FILTERED --squash
# 同法处理 hermes-shared；同步后把新基准 SHA 记入 §1 清单
```

## 4. 当前 vendor 原位改动清单

- vendor/hermes-desktop/src/styles.css
  - 改动：`@import 'tailwindcss'` 后加两行 `@source '../../hermes-desktop/src'` 与 `@source '../../hermes-shared/src'`
  - 原因：Tailwind v4 自动扫描只覆盖 vite root（apps/web），vendor 源码的类名不生成 CSS 规则（M0 验证时发现界面下半部无样式崩坏）；@source 让 Tailwind 扫描 vendor 源码
  - 同步注意：路径相对 styles.css（位于 vendor/hermes-desktop/src），指向 vendor 自身，subtree pull 后依旧有效；若上游改 styles.css 头部导致 @source 行丢失，按本条恢复

- vendor/hermes-desktop/src/app/chat/index.tsx
  - 改动：voice 配置 `enabled: true` 改为 `enabled: false`（附注释）
  - 原因：Web 布尔门：语音移出 Web 计划，关闭 dictation pill（产品范围决策，非能力缺失；上游 remote 模式本身支持语音）
  - 同步注意：上游若重构 voice 配置，按注释恢复（注释已注明 gates.ts 已删、语义权威 = 本文档）

- vendor/hermes-desktop/src/global.d.ts
  - 改动：新增 `DesktopPasswordLoginResult` 接口 + `hermesDesktop.passwordLoginConnectionConfig` 表面（M5 密码 "dashboard login"）
  - 原因：Web 端密码门禁登录走代理 /api/proxy/session/login（ADR-0013）；桌面端不实现此能力（桥面存在但桌面 main 进程不注册，渲染层仅在密码 provider 分支调用）
  - 同步注意：上游若改动 hermesDesktop 表面或 oauth 登录签名，按 M5 语义合并（该能力是 Web 专有扩展）

- vendor/hermes-desktop/src/app/settings/gateway-settings.tsx
  - 改动：oauth 分支按 isPasswordProvider 分流——未登录渲染用户名/密码表单（调 passwordLoginConnectionConfig），已登录保持原 pill + sign-out；新增 authUsername/authPassword 状态与 passwordSignIn 处理器
  - 原因：Web 端没有 gateway 登录弹窗（桌面靠 Electron partition cookie）；表单直接 POST /auth/password-login（经代理），密码不落盘
  - 同步注意：上游若重构 auth 区块 JSX/登录流，按 "密码 provider → 凭据表单" 语义恢复；i18n 键 authUsername/authPassword 在 types.ts 已声明

- vendor/hermes-desktop/src/components/first-run-remote-form.tsx
  - 改动：同 gateway-settings——密码 provider 渲染用户名/密码表单（passwordSignIn）
  - 原因：同上（首启表单与设置表单同源同语义）
  - 同步注意：同上

- vendor/hermes-desktop/src/components/boot-failure-overlay.tsx
  - 改动：signInRemote 对 isPassword 的 reauth 直接进嵌入式 Gateway settings 视图（setView('connect')），不再走 OAuth 弹窗
  - 原因：Web 端密码 reauth 的唯一入口是设置面板里的凭据表单
  - 同步注意：上游若改 reauth 动作列表，保留该分流

- vendor/hermes-desktop/src/i18n/en.ts / zh.ts / types.ts
  - 改动：settings.gateway 与 install 两节新增 authUsername / authPassword（install 另有 authNeedsPassword）；types.ts 同步声明
  - 原因：密码表单文案（M5）
  - 同步注意：上游 i18n 合入新键时按名合并，勿覆盖 M5 键

## 5. 同步后必做

1. `pnpm install`（apps/web）
2. `pnpm --filter @hermes-web/web typecheck` + 关键 vitest/e2e
3. 更新 §1 基准 SHA 与本文档

