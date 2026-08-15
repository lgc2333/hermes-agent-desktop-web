# 0009 — 撤销 artifacts/agents 布尔门：上游 remote 模式已原生支持

M4 调研后撤销 Web 版对 artifacts / agents 的入口布尔门（4 处 vendor 原位改动
还原 + gates.ts 同步）。这两个功能在上游桌面端 remote gateway 模式下本来就
完整可用，Web 桥的通用 REST/WS 转发天然覆盖，gate 属于过度关闭；voice 的
gate 保留（产品范围决策，非技术不能）。

**Status**: accepted

**Context**:

- M1 引入 6 处 vendor 原位改动（PATCHES.md §4）：artifacts 侧栏项 / 路由 /
  命令面板行、agents 状态栏项 / 命令面板行（5 处入口隐藏型 gate）、voice
  chat 配置 enabled:false（1 处）、styles.css @source（1 处构建修复）。
- M4 逐条核对 vendor 源码 + 上游全量克隆（research/upstream）后端端点，确认
  上游桌面端在 remote gateway 模式下对这两个功能**本来就有完整支持**：
  - **agents**：页面（src/app/agents/index.tsx）零桥依赖，纯读
    $subagentsBySession store，数据由 gateway WS 事件 subagent.progress /
    thinking / complete 填充——与聊天同一条 WS 通道，Web 桥天然覆盖；
    上游无任何 remote 门控。
  - **artifacts**：数据面 = 会话列表/消息（bridge.api() 转发）+ 文件读取。
    上游 remote 分支（media.ts / desktop-fs.ts 的 isRemoteGateway()）把文件
    读取切换到 gateway REST /api/fs/read-data-url（后端端点确认存在：
    /api/fs/list | read-text | write-text | read-data-url | git-root |
    default-cwd），Web 的 api() 通用转发自动覆盖；图片以 data URL 呈现，
    不依赖 <img> 直连；Web 的 HermesConnection.mode 恒为 remote，恰好走进
    上游 remote 分支，denied 的 readFileDataUrl 成员根本不被调用。
  - **voice** 不同：上游 remote 下同样可用（wake capture 模式含 remote，
    语音链路 = 浏览器原生 getUserMedia/MediaRecorder/WebRTC + gateway
    /api/audio/*），但 Web 侧 gate 是产品范围决策（语音移出 Web 计划），
    不是能力缺失——保留。
- 结论：artifacts/agents 的 gate 属于过度关闭——代码保留 + 入口隐藏的成本
  （同步注意、subtree 冲突面、vendor/桥双份语义权威）没有换来能力收益。

**Decision**:

- 撤销 4 处 vendor 原位改动，还原上游原样：
  - src/app/chat/sidebar/index.tsx（artifacts 侧栏项，含 GATE_ARTIFACTS_NAV /
    ARTIFACTS_NAV_ITEM）
  - src/app/contrib/surfaces.tsx（artifacts 路由，含 GATE_ARTIFACTS_ROUTE）
  - src/app/command-palette/index.tsx（artifacts + agents 两行，含
    GATE_ARTIFACTS_NAV / GATE_AGENTS_NAV）
  - src/app/shell/hooks/use-statusbar-items.tsx（Agents 状态栏项，含
    GATE_AGENTS_STATUSBAR）
- gates.ts 整体删除：isDenied() / gates / GateName 均无消费方（全仓库仅
  denied.ts 头部注释引用），是未接线的 flag 系统残留，与"字面 if (false)、
  不做 feature-flag 系统"原则冲突；文档职责由 PATCHES.md §4（vendor 登记）
  - denied.ts 头部注释（桥面拒绝）承接。denied.ts 注释同步更新。
- PATCHES.md §4 同步：移除上述 4 条登记，保留 voice 与 styles.css 两条。
- 桥面不改：remote 分支自动走 api() 转发，无需在 Web 实现 readFileDataUrl。
- voice gate 与 styles.css @source 保留（前者产品范围，后者构建修复）。

**Consequences**:

- Web 连真 gateway 时 artifacts / agents 直接可用，入口与桌面端一致。
- 已知残余缺口（不阻塞本决策）：
  1. chat 内 audio/video 播放：remote 下 resolveMediaPlaybackSrc →
     mediaExternalUrl 构造 `${baseUrl}/api/files/download?path=..&token=..`
     直连 URL，<audio>/<video src> 无法携带 X-Hermes-Target 头，代理转发
     不了（OAuth 模式 token 为空更甚）——代理协议问题（relay 支持 query
     target 或改 fetch→blob 路径），另开任务跟进，不涉及 vendor。
  2. mock gateway（apps/web/dev/mock-gateway.mjs）无 /api/fs/* 与 subagent
     事件：dev 下 artifacts 图片 / agents 面板为空态；验收需真 gateway
     （dev:remote）或补 mock 端点。
  3. artifacts 页拉取最近 30 个会话全量消息（上游 safe-load limit 保护），
     remote 下与桌面端同样开销，无 Web 特有恶化。
- subtree 同步冲突面缩小：vendor 仅剩 voice 与 styles.css 两处改动。
