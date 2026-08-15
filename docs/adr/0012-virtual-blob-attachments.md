# 0012 — 虚拟 blob 文件：图片附件 / 粘贴图片的浏览器实现

浏览器 File 没有 gateway 侧路径，渲染层的"本地临时文件路径"附件模型在 Web 上
走不通：saveImageBuffer / saveClipboardImage 维持 denied 时，拖拽/粘贴图片附件
整体失效。现以"虚拟路径 + 内存 dataURL 缓存"在桥面实现，零 vendor 改动。

**Status**: accepted

**Context**:

- 上游渲染层图片附件链路是本地路径模型：attachImageBlob（拖入/粘贴）→
  saveImageBuffer(bytes, ext) 落盘 → attachImagePath(path) →
  attachmentPreviewDataUrl(path)（readFileDataUrl 读回全文件 base64 作缩略图）→
  提交时 image.attach_bytes（remote 必走字节上传，字节直接复用 previewUrl）。
- 关键事实：chip 的 previewUrl 就是**全文件** base64 data URL（注释明确，非
  缩略副本），提交链路 readImageForRemoteAttach(path, previewUrl) 优先复用
  previewUrl，不再读盘；attach 成功后 attachment.path 被替换为后端返回的
  gateway 路径（result.path || path）。因此只要桥面能让
  "saveImageBuffer 返回路径 → readFileDataUrl(路径) 读回 dataURL" 闭环，
  渲染层整条链路（含提交上传）无需任何改动即可工作。
- 备选方案对比：
  a) **虚拟 blob 文件**（本 ADR）：桥面内存缓存，零 vendor 改动；
  b) 改 composer 附件链路（File 字节直接 multipart 上传）：更"正确"但跨
  vendor 文件改造（use-composer-actions / 提交管线），同步冲突面大；
  c) 维持 denied：图片附件（拖拽/粘贴）在 Web 上整体不可用。
- ADR-0010 将 saveImageBuffer / saveClipboardImage 列为"维持 denied（需
  vendor 适配）"；本 ADR 推翻该条（0010 判定标准本身不变）。

**Decision**:

- **虚拟 blob 文件**（browser.ts）：saveImageBuffer 把字节存为
  "web-blob://attach/<id><ext>" 虚拟路径 + 内存 Map<path, dataURL> 缓存
  （页面生命周期，刷新即失，与草稿同生命周期）；返回虚拟路径。
- **readFileDataUrl 组合层**（adapter.ts）：browser 缓存命中 → dataURL；
  未命中（普通 gateway 路径）→ gateway REST /api/fs/read-data-url 兜底。
  与渲染层 attachmentPreviewDataUrl 的"先本地后远程"语义一致。
- **saveClipboardImage**：navigator.clipboard.read() 取图片 ClipboardItem →
  同一虚拟文件逻辑返回路径；无图片/无权限返回 ''（渲染层提示
  noClipboardImage，与桌面一致）。
- 不覆盖：HTML 另开窗口场景（openHtmlInBrowser / openPreviewTargetInBrowser
  把返回值当 file:// 路径用，虚拟路径无意义，Web 上 blob URL 才是正解，
  需 vendor 适配，维持现状）；非图片文件拖拽（file.attach 同样依赖路径，
  浏览器 File 无路径，属独立"浏览器附件上传"改造，留待后续）。

**Consequences**:

- 拖拽/粘贴图片附件在 Web 上恢复可用：缩略图（readFileDataUrl 缓存命中）、
  提交（previewUrl → image.attach_bytes）全通，零 vendor 改动。
- 内存缓存边界：提交前刷新页面则附件丢失（与草稿一致）；attach 成功后
  attachment.path 已是 gateway 路径，虚拟路径不再被引用（image.detach 用
  gateway 路径，正确）。
- B 组覆盖进度更新（以本 ADR 为准）：saveImageBuffer / saveClipboardImage
  已实施（4/6）；findInPage 维持 denied 并回归浏览器原生查找（ADR-0011）；
  settings 仍维持 denied（ADR-0010）。
