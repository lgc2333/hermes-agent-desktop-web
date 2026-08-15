# 0014 — Web 构建版本标识：上游桌面版本 + 项目版本

**Status**: accepted

**Context**:

- 桥层 `getVersion()`（apps/web/src/bridge/gateway/index.ts）的
  `appVersion` 是 **Web 客户端自身的版本标识**，在 About 设置面板 /
  状态栏 / 命令面板展示。它不承载网关版本——网关/Hermes 运行时版本经
  远端 status（`currentVersion`）获取，与客户端构建无关（命令面板在
  已连接时优先显示后端版本）。
- 原 `WEB_VERSION = '0.1.0-web-m3'` 是 Web 项目自造的里程碑版本，
  不反映上游桌面端。
- 基准版本候选（vendor 基准提交 d2672a3，2026-08-15）：
  - 桌面端自身版本：上游 `apps/desktop/package.json` → **0.17.0**
    （即 Electron `app.getVersion()`）；
  - Hermes 运行时版本：上游 `hermes_cli/__init__.py` `__version__`
    → 0.20.1（桌面 About 面板经 `resolveHermesVersion()` 显示的是它）。
- vendor 子树只含 `apps/desktop` + `apps/shared`，**不含 hermes_cli**
  ——运行时版本只能手写常量，每次 sync 都会漂移。
- 后缀候选：项目版本号（`apps/web/package.json`，原 0.0.0，无真实
  版本体系）vs commit hash（本地可得，但 `.dockerignore` 排除 `.git`，
  容器构建拿不到）。
- 决策演进：基准 = 桌面端自身版本（用户指定"hermes desktop 原始版本号"）；
  后缀先定"项目版本号"，后细化为混合阶梯——**HEAD 打 tag 才用版本号，
  否则用 commit hash**（发布点稳定可复述，开发构建精确到 commit）。

**Decision**:

- `WEB_VERSION = <桌面版本>+web.<项目标识>`，形如 `0.17.0+web.0.1.0`
  （发布）或 `0.17.0+web.gd8aa0fe`（开发构建）：
  - 后缀用 semver build metadata（`+`）——不参与版本比较，纯标识；
  - `web.` 前缀区分两个数字段，避免被读成上游的预发布版。
- **项目标识解析阶梯**（用户决策）：
  1. HEAD 恰好打了 tag（发布点）→ 用 tag 版本号（剥前导 `v`，
     如 tag `v0.1.0` → `web.0.1.0`）；
  2. 否则有 git 检出 → 短 commit hash（`g<sha>`，精确到构建、
     零维护）；
  3. 无 git（Docker 构建，`.dockerignore` 排除 `.git`）→ 退回
     `apps/web/package.json` 版本号。
- **构建期注入**（vite/vitest `define`，全局 `__HERMES_WEB_VERSION__`）：
  - 桌面版本在构建时从 `vendor/hermes-desktop/package.json` 读取
    ——subtree 同步升级后**自动跟随**，无需手工维护；
  - 项目版本（阶梯 3 的 fallback，也是发布 tag 应对照的版本）为
    `apps/web/package.json` version（首个真实版本 bump 为 0.1.0，
    发布时 tag + bump 同步）；
  - 共享 helper `apps/web/scripts/build-version.mjs`，vite 与 vitest
    配置同源，保证构建与测试看到同一字符串。
- 网关 / Hermes 运行时版本不进客户端版本串（远端 status 已提供）。
- 无 `define` 的冷路径（理论上不存在）退回 `0.0.0+web.dev`。

**Considered Options**:

- 基准用 Hermes 运行时版本（0.20.1，手写常量）：与桌面 About 面板
  显示一致，但 vendor 无 hermes_cli，每次 sync 需人工核对 PATCHES.md
  基准 → 否决。
- 后缀固定用项目版本号：开发构建与发布无法区分，且构建不精确到
  commit → 否决。
- 后缀固定用 commit hash：开发构建精确、零维护，但每次构建字符串都
  变、发布点无法作为稳定版本号复述；Docker 构建还拿不到
  （`.dockerignore` 排除 `.git`）→ 最终采用混合阶梯：有 tag 用
  版本号、无 tag 用 `g<sha>`、无 git 退回 package.json 版本。
- 保持运行时常量硬编码：最简单，但 sync 升级后版本不自动跟随 → 否决。
