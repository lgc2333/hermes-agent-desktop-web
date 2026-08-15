# 0001 — git subtree 引用上游，不 fork monorepo

桌面端源码在 NousResearch/hermes-agent 大仓（Python agent 核心 + gateway + 桌面端 + 多个前端），我们需要深度修改桌面端前后端、又要持续跟上游同步，但不想 fork 整个大仓。决定：把上游 `apps/desktop` 与 `apps/shared` 以 git subtree（`--squash`）引入 `vendor/`，同步用 `git subtree pull`。

**Status**: accepted

**Considered Options**:
- fork + upstream remote：同步噪音大（无关目录全跟着动）
- submodule + patches/：patch 维护对移植级改动太痛苦
- vendor + 同步脚本：仓库最干净，但冲突完全自理

**Consequences**: 上游历史以 squash 形式进入仓库；目录结构变动时 pull 可能失败需重新 add；无法用 subtree push 回上游（可接受，回馈走 PR）。