# 0025 — Web 远端文件下载走浏览器下载

**Status**: accepted

**Context**:

- Files 面板在 remote 模式保留 Download；上游渲染层调用 `downloadGatewayMediaFile()` → `window.hermesDesktop.saveGatewayFile()`。
- Electron 桌面端的 `saveGatewayFile` 通过主进程访问 `/api/fs/download`，弹原生保存对话框，并流式写到用户选择的本机路径；404 时回退 `/api/fs/read-data-url`。
- Web 端没有 Electron 主进程，也不能知道或写入用户真实本机路径；但浏览器可以把代理响应转成 Blob 并触发标准下载。
- `saveGatewayFile` 不是 Denied capability：浏览器可实现“交给浏览器下载”，且 gateway 已有 REST 端点。

**Decision**:

- Web bridge 实现 `saveGatewayFile(payload)`，语义定义为 **Gateway file download**：把 Target 上的单个 gateway 文件交给浏览器下载管理器。
- 主路径请求 `/api/fs/download?path=...`，继续经同源 Proxy 转发；token 模式带 `X-Hermes-Session-Token`，OAuth / Password session 模式靠 httpOnly cookie。
- 若 payload 显式带 `profile` 则追加 `?profile=`；否则使用当前 Web profile preference，保持与其他 remote fs/API 能力的 profile 路由一致。
- 响应转 Blob 后用 `<a download>` 触发下载；文件名优先级为 `Content-Disposition` → `payload.suggestedName` → gateway path basename → `download`。
- 仅当 `/api/fs/download` 404 时回退 `/api/fs/read-data-url`，与 Electron 兼容策略一致；其他 HTTP 错误直接抛给渲染层显示失败。
- `path` 返回浏览器可见的下载文件名，不承诺本机绝对路径；`selectSavePath()` 继续返回 `null`。

**Consequences**:

- Files 面板普通远端文件下载在 Web 可用。
- 下载大文件主路径不经过 data URL；但浏览器 Blob 下载仍会由浏览器管理内存/磁盘，不提供 Electron 的任意路径写入语义。
- 旧 gateway 没有 `/api/fs/download` 时，小文件仍可通过 data URL fallback 下载；超过旧端点大小限制时按现有 gateway 错误失败。
