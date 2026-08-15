# 0001 — git subtree 引用上游，不 fork monorepo

桌面端源码在 NousResearch/hermes-agent 大仓（Python agent 核心 + gateway + 桌面端 + 多个前端），我们需要深度修改桌面端前后端、又要持续跟上游同步，但不想 fork 整个大仓。决定：把上游 `apps/desktop` 与 `apps/shared` 以 git subtree（`--squash`）引入 `vendor/`，同步用 `git subtree pull`。

**Status**: accepted

**修订（M0 落地）**: 上游是 monorepo，直接 `git subtree add/pull <upstream> <ref>` 会把**整个仓库**（Python 核心、gateway 等）挂到 prefix 下。实际引入/同步采用**过滤提交法**：先对上游子树路径做 `git commit-tree`（树 = 上游 `apps/desktop` / `apps/shared` 的树），再对该过滤提交执行 `git subtree add/merge --squash`。vendor 内容与上游对应路径逐字节一致（树 SHA 相等），`git-subtree-split` 指向本地可解析的过滤提交。操作细节见 PATCHES.md §2/§3，同步脚本 scripts/sync-upstream.sh。

**Considered Options**:
- fork + upstream remote：同步噪音大（无关目录全跟着动）
- submodule + patches/：patch 维护对移植级改动太痛苦
- vendor + 同步脚本：仓库最干净，但冲突完全自理

**Consequences**: 上游历史以 squash 形式进入仓库；目录结构变动时 pull 可能失败需重新 add；无法用 subtree push 回上游（可接受，回馈走 PR）。