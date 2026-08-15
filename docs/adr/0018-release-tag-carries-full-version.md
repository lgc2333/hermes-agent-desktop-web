# 0018 — 发布 tag 携带完整版本标识（v<桌面版本>+web.<Web项目版本>）

**Status**: accepted

**Context**:

- 首次真实发布打的 tag 是 `v0.17.0+web.0.1.0`，把桌面版本也揉进了 tag。
- 构建脚本 build-version.mjs 对项目标识**无条件**拼 `+web.` 前缀：
  tag（剥前导 v）即项目标识，于是 `0.17.0+web.` + `0.17.0+web.0.1.0` →
  状态栏/About 显示成 `v0.17.0+web.0.17.0+web.0.1.0`（重复），误导排查。
- ADR-0014 只约定 WEB_VERSION 的组成公式（`<桌面版本>+web.<项目标识>`），
  其 tag 示例（`v0.1.0`，纯项目版本）与发布者的实际诉求不一致：发布点希望
  tag 一眼可见"桌面哪个版本 + web 哪个版本"，且与客户端自报版本串完全一致。

**Decision**:

- **发布 tag = 完整组合版本**：`v<桌面版本>+web.<Web项目版本>`，形如
  `v0.17.0+web.0.1.0`；桌面版本须与 `vendor/hermes-desktop/package.json`
  一致，Web 项目版本与 `apps/web/package.json` 一致（bump + 打 tag 同步）。
- **构建脚本加固**（build-version.mjs 新增 `composeWebVersion()`）：
  projectId 已含 `+web.` → 视为完整组合版本直接返回（剥前导 v 后原样），
  不再重复拼装；纯项目版本 tag（`v0.1.0`，ADR-0014 旧示例）与无 tag 的
  `g<sha>` / package.json 版本分支保持原行为不变（向后兼容）。
- 本 ADR 取代 ADR-0014 中"tag 用项目版本号"的示例部分；WEB_VERSION 组成
  公式本身不变。

**Considered Options**:

- tag 只打 Web 项目版本（`v0.1.0`，ADR-0014 原示例）：零代码改动，但 tag
  不含桌面版本，无法从 git 直接对映客户端版本 → 否决（用户决策）。
- 保持现状（tag 含 `+web.` 且脚本重复拼接）：版本串重复、误导排查 → 否决。
- tag 用完整组合版本 + 脚本对 `+web.` 去重：tag 与状态栏/About 显示完全
  一致、可读性强；代价是脚本需识别两种 tag 形态 → 采用。
