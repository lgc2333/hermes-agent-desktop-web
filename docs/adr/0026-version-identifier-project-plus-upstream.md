# 0026 — 版本标识改为「项目版本 + 上游同步点」（`v<项目版本>+<上游版本>`）

**Status**: accepted

**Context**:

- 上游 2026-10-08（v0.21.6）起 `apps/desktop/package.json` 的 `version` 变成占位符
  `0.0.0`，真版本改由构建 stamp（`HERMES_PAYLOAD_VERSION` / `HERMES_PAYLOAD_TAG`）注入，
  桌面端自己的 release 频道另有独立版本序列 → ADR-0014 的「上游桌面版本」分量**失去
  来源**，ADR-0018 的 `v<桌面版本>+web.<项目版本>` 按字面执行会得到 `v0.0.0+web.0.4.22`
  （不自洽，docker `latest` 还会指向 0.0.0 镜像）。
- 上游 release tag 的命名同时变了：由日期式 `v2026.9.24` 改为 agent 版本 `v0.21.6`
  （`v2026.9.24` == Agent v0.21.5）→ tag 名本身即可作「同步到哪个上游版本」的标识。
- 构建期读不到 git：Docker 构建 `.dockerignore` 排除 `.git`，上游 tag / commit hash 都
  拿不到，任何以 git 为源的方案都必须先落盘。

**Decision**:

- 版本标识 = **`v<项目版本>+<上游版本>`**（**带前导 `v`**，与发布 tag 同形）：
  - 同步到上游 release tag → 上游分量用 tag 名（`v0.4.22+v0.21.6`）；
  - 追 main（上游未发 release）→ 上游分量用上游提交的 7 位短 hash（`v0.4.22+818c13b`）。
- 发布 tag 与客户端自报版本 `WEB_VERSION` **逐字一致**（都带前导 `v`）；HEAD 恰好打了
  tag 时以 tag 原文为准。`apps/web/package.json#version` 保持**纯 semver**（`0.4.22`，
  该字段不接受前导 v），前导 `v` 只由 `build-version.mjs#composeWebVersion` 拼上；
  渲染层显示时自己也会补 `v`（`version-details.tsx` 的 `v${shortVersion(...)}`，
  `shortVersion` 先剥前导 v）→ 不会出现 `vv`。
- 上游分量落 `apps/web/package.json#upstream`（`ref` + `commit`），**由
  `scripts/sync-upstream.sh` 在每次同步末尾自动写入**；`build-version.mjs` 读它而非
  vendor 的 `package.json`。项目版本仍对映 `apps/web/package.json#version`（发布时 bump）。
- 本 ADR 取代 ADR-0014 的「上游桌面版本」分量与 tag 示例部分、ADR-0018 的全部 tag 语义。

**Considered Options**:

- 按 ADR-0018 字面执行（`v0.0.0+web.0.4.22`）：零改动，但不自洽、docker `latest` 指向
  0.0.0 镜像 → 否决。
- 用桌面端自己的 release 频道版本作分量（如 `v0.18.x`）：与 agent 版本不同源，Web 与桌面
  release 无对应关系，且该版本同样不在 vendor 里 → 否决。
- 保留 `+web.` 前缀、只换分量来源：桌面版本已不存在，前缀失去「区分两个数字段」的意义
  → 否决。
- 只留项目版本、去掉上游分量：无法从 tag / 自报值对映「同步到哪个上游点」，排查要翻
  PATCHES / `docs/sync/` 记录 → 否决。

**Consequences**:

- `+web.` 前缀作废；开发构建不再带本仓 commit（原 `g<sha>` 分支移除）→ 同一同步点 + 同一
  项目版本下字符串确定，与将来的发布 tag 一致。
- 上游分量是同步脚本写入的落盘字段：手工跑同步（勿手跑）或漏写时，自报值退化为
  `<项目版本>+unknown`。
- 上游若恢复 vendor 内的真版本号，本方案仍成立——上游分量只要求是「同步点标识」，不要求
  semver。
