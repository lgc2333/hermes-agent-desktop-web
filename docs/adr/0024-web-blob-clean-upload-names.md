# 0024 — Web 附件上传名净化：虚拟路径 `<id>/<name>` 分隔

ADR-0020 用 `web-blob://attach/<id>-<name>` 虚拟路径承载 Web 附件（浏览器 File
无 gateway 侧路径），但 `<id>-` 与 `<name>` 拼在同一 basename 段：渲染层的
pathLabel / imageFilenameFromPath 取 basename 会带出 `<id>-`，导致提交给
gateway 的 file.attach `name` / image.attach_bytes `filename` 变成
`<id>-<name>`（如 `3-report.pdf`）——与桌面端（干净 `report.pdf`）不一致，
污染了 gateway 侧落盘的真实文件名。本 ADR 把 Blob id 挪到独立路径段，让
上传名与内部存储身份分离。

**Status**: accepted

**Context**:

- Web 端浏览器 File / 粘贴图片没有 gateway 侧路径，渲染层是桌面式"路径模型"，
  必须用一条承载真实文件名的虚拟路径（`web-blob://attach/...`）指代附件，
  字节随用随读（File 引用零常驻；纯内存字节才落 OPFS，ADR-0020）。
- 虚拟路径里的 **Blob id**（`nextBlobId` 单调递增序号）只服务于 Web 本地存储
  键的唯一性（blobFiles Map / OPFS 扁平键），对"上传名"毫无意义——却因拼在
  basename 段而泄漏进 gateway 文件名。
- 上游 gateway 落盘自带防同名覆盖：`_stage_session_file_attachment` →
  `_unique_attachment_path`（server.py:11531）对同名文件追加 `-N` 后缀
  （`report.pdf`、`report-2.pdf`），不覆盖。因此 Web 无需靠前缀保证 gateway
  侧唯一——Blob id 纯属本地身份。
- 命名上"前缀"是歧义称呼：它其实是 Web 内部附件身份，与"上传文件名"正交，
  应分开命名（见 CONTEXT.md 词表：Blob attachment / Blob id）。

**Decision**:

- 虚拟路径由 `web-blob://attach/<id>-<name>` 改为 `web-blob://attach/<id>/<name>`：
  - `<id>`（**Blob id**）在独立路径段，仅作 Web 内部存储身份，不对外；
  - `<name>` 落末段，即干净上传名——渲染层的 pathLabel / imageFilenameFromPath
    取 basename 天然得到 `<name>`，不泄露 id，**零 vendor 改动**。
- OPFS 扁平存储键不变（仍是 `<id>-<name>`），`blobNameFromPath` 用
  `path.slice(prefix.length).replace('/', '-')` 还原；blobFiles Map 键用完整虚拟路径。
- 取代 ADR-0020 中的虚拟路径格式决策（0020 的 status 已标 superseded，其余仍有效）。
- CONTEXT.md 增补词表：**Blob attachment（Web 虚拟附件）** / **Blob id（附件身份）**。

**Consequences**:

- 上传到 gateway 的附件文件名与桌面端一致：干净 basename（Blob id 不出 Web）；
  同名文件由 gateway `_unique_attachment_path` 追加 `-N` 后缀防覆盖，不覆盖。
- chip 显示同样干净（不再出现 `3-` 前缀）。
- Web 本地唯一性不变：Blob id 保证 blobFiles Map / OPFS 键唯一。
- 破坏性：旧 `-` 分隔格式的虚拟路径不兼容新解析——但 OPFS web-blobs/ 页面载入
  即清空、blobFiles Map 随页面消亡，无跨页面残留，无迁移负担。
