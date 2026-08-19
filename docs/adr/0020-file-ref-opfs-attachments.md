# 0020 — 附件字节存储：File 引用 + OPFS（0012 的存储介质延伸）

ADR-0012 用"虚拟路径 + 内存 dataURL 缓存"让图片附件在 Web 上走通，但
内存缓存意味着**整文件 base64 常驻 JS 堆**：大文件拖入即全量读入内存，
多附件时内存翻倍；且非图片文件拖拽整体失效（file.attach 同样依赖路径，
浏览器 File 无路径）。本 ADR 把存储介质从"内存 dataURL"改为二分模型——
**File 引用保留**（随用随读、读完即弃）+ **OPFS 落盘**（仅内存字节），
并把非图片文件附件接入同一通道。

**Status**: accepted（虚拟路径格式决策被 0024 取代，其余仍有效）

**Context**:

- 上游桌面端附件模型整读转 b64（hardening.ts readFileDataUrlForIpc 全量读 +
  base64，256 MiB cap），且 gateway 侧 file.attach / image.attach_bytes
  都收 data_url（research/upstream 已核实）；Web 端提交链路（
  uploadComposerAttachment）对 image/file 同构：读 data_url → WS RPC 上传，
  **提交链路零改动**。
- 浏览器 File 对象磁盘-backed：不占 JS 堆、不持有文件句柄（按需打开，
  基本不锁文件）；仅 arrayBuffer() 时瞬态读入。因此拖入的 File **无需
  落盘**——保留引用即可，读时才瞬时进内存，读完即弃。
- 纯内存字节（粘贴图片、HTML 预览拼接）没有磁盘背衬，才需要持久介质；
  OPFS（navigator.storage.getDirectory()）是浏览器原生文件目录 API，
  createWritable + file.stream() 流式写盘，零依赖。
- 备选方案对比：
  a) **File 引用 + OPFS 二分**（本 ADR）：File 零拷贝零常驻；Blob 落盘；
  存储层小接口可单测（内存 fake）；
  b) 维持内存 dataURL 缓存（ADR-0012）：非图片仍不可用，大文件常驻堆；
  c) multipart upload-stream（/api/files/upload-stream）：gateway 端点存在
  但多一套字节通道 + 新提交链路，造轮子，弃。
- 生命周期取舍：File 引用 Map 随页面消亡（刷新即清，无泄漏）；OPFS
  web-blobs/ 目录页面载入时初始化清空（无 TTL、无增量清理，磁盘空间
  不心疼）；附件移除（chip ×）时 releaseBlobFile 显式释放。

**Decision**:

- **存储模型二分**（browser.ts + 新 blob-store.ts）：
  - File（拖入）→ `Map<虚拟路径, File>` 保留引用（零常驻字节）；
    读时 arrayBuffer() 瞬态 b64 读完即弃。
  - Blob（粘贴图片、HTML 预览等内存字节）→ OPFS `web-blobs/` 目录
    流式写盘；读时 getFile() 瞬态 b64。
  - 虚拟路径统一 `web-blob://attach/<id>-<name>`（嵌真实文件名，
    file.attach 的 name 参数取自 pathLabel(path)）。
- **桥面表面**（都经 adapter.ts 组合层）：
  - saveImageFile(blob, name)（新）：File → 引用；Blob → OPFS 落盘。
  - saveImageBuffer(bytes, ext)（保留签名）：bytes → Blob → OPFS 写，
    兼容 HTML 预览调用方（local-preview / preview-artifact）。
  - readFileDataUrl(虚拟路径)：File → 瞬态 b64；OPFS → getFile() →
    瞬态 b64；未命中 ''（组合层兜底 gateway REST /api/fs/read-data-url
    不变）。
  - releaseBlobFile(路径)（新）：File → Map.delete；OPFS → remove()。
  - 桥面初始化：页面载入时清空 OPFS web-blobs/ 目录。
- **存储层抽象**（blob-store.ts，可注入）：小接口 `web-blobs/` 目录的
  读写清删 + 内存 fake 实现（单测）；BrowserAdapter 持有默认 OPFS 实现。
- **vendor 渲染层**（use-composer-actions.ts 三处，登记 PATCHES.md）：
  attachImageBlob 去 arrayBuffer() 改调 saveImageFile（图片 File 原样
  保留 / 粘贴 Blob 落 OPFS）；attachDroppedItems 非图片分支加
  attachFileBlob（saveImageFile(file) → attachContextFilePath(虚拟路径)）；
  removeAttachment 对 web-blob:// 路径附件调 releaseBlobFile。
- global.d.ts 增 saveImageFile / releaseBlobFile 桥面表面（Web 专有扩展，
  桌面端不实现）。

**Consequences**:

- 非图片文件附件（拖拽）在 Web 上恢复可用：drop → 引用 → chip →
  file.attach data_url 上传，复用既有提交链路零改动。
- 大文件不再常驻内存：File 引用零拷贝，b64 只在传输前瞬态出现一次。
- 刷新即清：File 引用 Map 随页面消亡；OPFS web-blobs/ 载入清空；
  与草稿同生命周期（提交前刷新丢失，可接受）。
- 释放边界：chip 移除显式 release；上传失败/会话切换残留引用由刷新兜底
  （内存 Map 随页面消亡，OPFS 载入清空）。
- OPFS 不做老浏览器兜底：lib.dom 要求现代 Chromium 系；不支持 OPFS 的
  环境 Blob 附件降级失败（与 denied 语义一致，不造 IndexedDB 等回退）。
