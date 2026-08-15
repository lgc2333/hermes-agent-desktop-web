# 0010 — denied 面判定标准：仅限浏览器不可实现 且 remote gateway 不支持

桥面（Capability bridge）三分法中的 denied 类此前缺乏判定标准，成员按"顺手"归类，
审计发现两类错位：有 gateway REST 端点却被 denied（/api/fs/_、/api/git/_ 共 6 组），
以及浏览器 Web API 可等价实现却被 denied（saveImageFromUrl 等）。现确立判定标准并
记录审计结论。

**Status**: accepted；其中 findInPage 条目被 ADR-0011 取代（回归浏览器原生查找对话框）

**Context**:

- 上游桌面渲染层在 remote 模式下对文件/仓库能力有 remote-aware 门面
  （desktop-fs.ts / desktop-git.ts）：mode === 'remote' 时改走
  hermesDesktop.api() REST（/api/fs/_、/api/git/_），不经 Electron IPC；
  Web 的 HermesConnection.mode 恒为 remote 且 api() 已实现（webApi 转发），
  因此这些能力在 Web 上实际可用。
- 后端端点核实存在（research/upstream/hermes_cli）：/api/fs/list |
  read-text | write-text | read-data-url | git-root | default-cwd；
  /api/git/status | worktrees | branch/switch | branches | base-branches |
  file-diff | review/* | commit | push | create-pr | pr-list。
- 逐成员对照"浏览器 Web API 等价物 + 后端 REST 端点"审计 denied.ts 全部成员。

**Decision**:

- **denied 判定标准**：桥成员归入 denied 当且仅当"浏览器环境无法实现 且
  remote gateway 不支持（无对应 REST 端点）"；满足其一即应归 browser 或
  gateway 类。例外（技术上可行但产品范围拒绝）需显式登记，如语音
  （ADR-0009 保留的 voice gate）。
- **语音（requestMicrophoneAccess，B-7）维持现状**：getUserMedia 可实现、
  gateway /api/audio/* 支持，但语音整体是产品范围 gate（vendor chat/index.tsx
  enabled:false，PATCHES.md §4 登记），requestMicrophoneAccess 继续 denied，
  不因技术可行而翻案。
- 审计确认的错位清单（★ = 本轮已实施，见 Consequences）：
  - A 类（gateway REST 支持，契约错位，运行层已被门面覆盖）：readDir、
    readFileText、writeTextFile、readFileDataUrl、gitRoot、git._（含
    review._）★ → 已实现为 gateway REST（gateway/fs-git.ts RemoteFsGit，
    与 desktop-git.ts remoteGit 同构）；除 readFileDataUrl 的直呼点
    （attachmentPreviewDataUrl 先 throw 再 fallback，随实现消除）外，
    denied 实现原本不被渲染层命中。
  - B 类（浏览器可实现）：
    - saveImageFromUrl：**实损**——渲染层 use-image-download 在桥成员
      不存在时走浏览器下载 fallback（fetch→blob→a[download]），denied
      返回 false 被当作"用户取消保存"，fallback 死路，保存按钮无反应。
      ★ 修复 = 归入 browser 类（browser.ts saveImageFromUrl 直接做浏览器
      下载，成功 true / 失败静默 false）；不摘除——global.d.ts 中该成员
      必选，摘除需改 vendor 类型（违反 vendor 纪律），browser 实现同时
      满足判定标准且消除 throw 路径。
    - getOnBattery/onBatteryChanged ★：navigator.getBattery() 可实现
      （已实现于 browser.ts；无 API 时恒 AC，backstop 轮询不减速）。
    - findInPage/onFoundInPage：window.find() 可实现但 vendor
      store/find-in-page.ts 依赖 Electron 异步高亮回调，需适配。
    - saveClipboardImage：navigator.clipboard.read() 可实现，需适配上传链路。
    - settings.getDefaultProjectDir 等：localStorage 可实现。
    - saveImageBuffer：blob URL 可替代，但渲染层 openHtmlInBrowser 等链路
      依赖本地路径，需 vendor 适配。
  - 确认正确 denied（C 类）：terminal（本地 PTY；agent 终端走 gateway 事件
    流不经桥）、renamePath/revealPath/openDir（本地 OS，REST 无端点）、
    desktopPluginsRoot/agentPluginsRoot（runtime-loader 明确
    Electron-local）、bootstrap 四件套、updates/uninstall（桥面=客户端更新，
    部署管理；backend 更新走 /api/hermes/update/* REST 与桥无关）、
    setKeepAwake（vendor 注释明确 web no-op）、watchPreviewFile（remote 下
    preview-pane 显式 gate）、normalizePreviewTarget（denied null 恰好触发
    renderer 侧等价 fallback）、多窗口/独立窗口面、on* 主进程事件、原生外观
    set*、sanitizeWorkspaceCwd（remote 分支不调用）、revealLogs。

**Consequences**:

- denied.ts 的语义权威从"硬编码清单"升级为"判定标准 + 登记"：新成员归入
  denied 前必须先对照本 ADR 两条排除项。
- 本轮已实施（2026-06，gateway/ 目录化拆分的同一轮）：
  ① saveImageFromUrl → browser 类（浏览器下载，见 Decision）；
  ② A 类 6 组 → gateway/fs-git.ts RemoteFsGit，GatewayAdapter 委托接入
  （gateway/index.ts），adapter.ts 接线；gateway.ts 同期拆分为
  gateway/{index,rest,oauth,fs-git}.ts；
  ③ getOnBattery/onBatteryChanged → browser.ts（navigator.getBattery）；
  ④ trashPath 从 bridge 摘除（global.d.ts 可选，浏览器无回收站语义，
  渲染层 desktop-fs.trashDesktopPath 已有 !desktop.trashPath 兜底）；
  adapter.test.ts 同步更新旧 denied 断言（readDir/git 断言随实现移入
  gateway/index.test.ts，新增 12 个 fs/git REST 用例）。
- 维持 denied（需 vendor 适配，收益低，未实施）：findInPage /
  saveClipboardImage / settings。
