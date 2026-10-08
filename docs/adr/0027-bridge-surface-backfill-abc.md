# 0027 — 桥面补齐（A/B/C 组）：真实现优先、降级次之、UI 无意义走 CSS 隐藏

**Status**: accepted

**Context**:

- 审计（2026-10-08，对照上游 v0.21.6）比对 `global.d.ts` 顶层 164 个 `hermesDesktop`
  成员与 Web 桥组装出的 117 键 → 47 个顶层成员 + 7 个嵌套可选成员未实现，**全部为可选
  成员（`?`）**，必填面零缺口。审计按缺口性质分三组：A 组 7 面（有真实缺口或死按钮）、
  B 组 8 面（Web 拓扑下无意义但 UI 露出）、C 组 7 面（低成本可选）。
- 三组的**缺口性质不同，正确处置也不同**——这是本 ADR 要固化的判断：
  - 有的能在浏览器/gateway 上**真实现**（如 `getConnectionFor` 只是缺一层注册表解析）；
  - 有的**只能实现一个安全子集**（如 `contextMenuCopyImage` 同源可行、跨域不可行）；
  - 有的**完全不可实现**（如 `probePluginRepo`：上游在 Electron 主进程 `git clone` 后读
    仓库文件判组件，浏览器既无 git 也无任意 URL 字节读通道）；
  - 有的**根本不该实现**，但其 UI 入口会露出死开关（如 `setDisableF12`）。
- 最高优先的一条：Web 里「插件安装」整条链路是死的 —— `probePluginRepo` 缺失 → 弹窗直接
  落 `phase='error'`（`plugin-install-modal.tsx:120-131`），**连本来可用的 agent 半插件也
  装不了**（agent 半走 gateway `plugins.manage` RPC，Web 本已通）。

**Decision**:

按「**能真实现就真实现 → 只能做子集就做子集 → 完全不可实现才留 denied → UI 无意义的
用 `web.css` 隐藏（不改 vendor）**」逐面处置。

A 组（真实现，多数归桥面三分法的 **gateway** 类）：

- `getConnectionFor` / `getGatewayWsUrlFor`：注册表作用域解析。`rest.ts#toHermesConnection`
  增 `opts.connectionId`，显式 connectionId 时按注册表逐连接解析并打 `connectionId` /
  `registryScoped`。修复 `openSecondary` 此前**静默塌回 primary、拨错 target**。
  **空 id 也抛错**（`No connection with id "".`），不委托 primary——以**上游实现**为准：
  `main.ts:15547` handler → `registryDialConnectionId`（`connection-registry.ts:572-584`，
  注释记了 #90477 的来由）；`global.d.ts:44-45` 那句「空 id 委托 legacy getConnection」
  与实现**自相矛盾**，按实现取齐。`getGatewayWsUrlFor` 走 `{ok:false, error}` 不抛
  （上游 `gatewayWsUrlIpcResult` 同款）——静默回落会把请求拨到错误的 Target 却自称是
  另一条连接，正是审计里的原症状。`getConnectionFor` 的 `profile` 空值填 `'default'`
  （上游 main.ts:15554 同款）。
- `getAgentRoster`：上游 `buildAgentRoster` **纯函数移植**到 `bridge/gateway/roster.ts`
  （install_id 折叠、`@name-device` 重名去重、canonical 选择按 local<ssh<remote<cloud 优先
  级 + primary 偏好），枚举腿走逐条注册连接 `GET /api/profiles` + `GET /api/status`。
  两处按上游对齐的细节：`profileMetadata` **对每个具名 profile 都产出一条**（可为空对象，
  main.ts:16471-16500），不按「是否非空」裁剪；不移植 `shouldDeferLocalEnumeration`
  （connection-registry.ts:594-609）——Web 无本地后端池、不 spawn，且唯一那条 local 形态
  连接的 kind 是 `'remote'`，触发条件不成立（理由记在 roster.ts 头注）。
- `recycleBackend`：`POST /api/gateway/restart`（gateway 端点已存在，代理全透传 `/api/*`），
  带 `?profile=` 作用域。
- `getMachineProfile`：**browser** 类，`locale = navigator.language`（消费端只读 locale，
  首启语言推断），`platform` 标 `'web'`，其余字段留空。
- `contextMenuCopyImage`：**同源子集**。记最近一次 `contextmenu` 手势命中的 `<img>`，取字节
  后写剪贴板；非 PNG 走 canvas 重编码（Chromium 只接受 `image/png`）。跨域图仍不可行——
  **不新增代理字节端点**（涉 SSRF 白名单，不划算）。
- `probePluginRepo`：**降级实现**（`bridge/gateway/plugin-probe.ts`）。保留上游标识符校验
  （非法输入仍 `ok:false`）与不安全 scheme 警告，`agentName` 恒用上游 fallback
  `repoNameFromUrl(gitUrl)`（desktop-plugin-install.ts:392，**仓库名**而非 subdir 名），
  但恒报 `agent:true` / `desktop:false` - 一条说明性 warning。效果：弹窗脱离
  `phase='error'`，agent 半可装，desktop 半恒不渲染（渲染层 `{probe.desktop && ...}` 门控）。
  **与 ADR-0010 的关系**：严格按「浏览器不可实现 **且** remote gateway 不支持 → denied」
  本应归 denied，这里是**有意偏离**——归 denied 会让整条插件安装链路继续死着（含本已
  可用的 agent 半），「降级 + 一条显式 warning」的代价明显更小。

B 组（不实现，但消掉死入口）：

- `probeLocalBackend`：真实现 `{bootstrapNeeded:false}`（Web 无本地后端可装）。修复
  「This device」此前 fail-closed 恒判「需要安装」→ 每次弹安装确认。
- `setDisableF12` / `dataUrlReadMax`：`web.css` 隐藏对应设置行
  （`#setting-field-advanced.disable-f12` / `#setting-field-chat.attachment-size`）。
- `trashPath` / `installDesktopPlugin` / `reconcileDesktopPlugins` / `removeDesktopPlugin`：
  **零改动**——入口已被上游条件门控，核实如下：删除/重命名/在文件管理器显示仅在
  `!isDesktopFsRemoteMode()` 时渲染，而 Web 的 `connection.mode` 恒 `'remote'`
  （`rest.ts#toHermesConnection`）；desktop 插件控件由 `probe.desktop` 门控（恒 false）。
- `connections.updateAll`：**零改动**——上游本快照**没有任何 UI 消费入口**
  （`applyEverythingUpdate` / `hasMultipleUpdateTargets` 在 `src/app/` 零调用点），
  审计此条已过时。

C 组（低成本补齐）：

- `connections.setLaunchMode` / `setLastUsed`：注册表增 `launchMode: 'last-used' | 'primary'`
  与 `lastUsed` 两字段，读旧注册表时归一化（缺字段 → `primary` / `primary` 连接 id）；
  Web 无「启动」概念，但设置页 Startup 开关需可读可写。**未知 id 抛错**（含隐式 `local`
  之外的未知 id，上游 `setPrimaryConnection` / `setLastUsedConnection` 同款），
  `setPrimaryConnection` **只改 primary、不写 lastUsed**——上游 lastUsed 由渲染层成功切换
  后单独记（store/connections.ts:176-190），真正同时设两者的是 Apply 路径
  `reconcileAppliedGlobalConnection`（connection-registry.ts:1590-1652），而 Web 的 Apply
  是原地改写当前 primary 记录（id 不变），不需要重指。
- `logLine` + `getRecentLogs`：**browser** 类内存环形缓冲（500 行；模块级，跨
  `BrowserAdapter` 实例共享，测试用 `resetLogRing()` 清），缓冲为空时回落 localStorage
  里的上次渲染错误快照（原行为保留）。错误边界的 `reportRendererError` 也写进同一缓冲
  （诊断面板要能读到渲染错误，不是只有最后一条）。
- `readFileDataUrlForAttach`：与 `readFileDataUrl` **共用同一条** `browser ?? gateway` 组合
  链路（`adapter.ts` 里提成局部常量，避免两处重复；Web 侧无服务端差异，渲染层本就有
  `?? readFileDataUrl` 回落）。
- `getEmbedHostOrigin`：`location.origin`（消费点被 `hasHttpOrigin()` 短路 → 行为无变化，
  仅为补齐面）。
- `localSkin`：显式 `null`（主题偏好本就在 localStorage 同步读取，`null` 即正确语义；
  显式给出以免「未实现」与「已实现且为 null」在审计里混淆）。
- `onExternalOpenFailed`：`window.open` 返回 null（弹窗被拦）时广播 URL。
- `onNotificationActivate`：通知 `onclick` 回传 `{activate, notifyId, tag}` 并 focus 窗口；
  `actionId` **恒不派发**（浏览器通知无按钮语义，那是 ServiceWorker
  `registration.showNotification` 的能力）。无可跳转目标时不订阅 `onclick`。
  对应的 `onNotificationAction`（通知**按钮**回调）因此保持 **denied**：页内
  `new Notification` 拿不到按钮语义，不是漏做而是不可实现。

**Considered Options**:

- **全部留 denied（零改动）**：最省事，但插件安装链路整条死、首启语言忽略浏览器设置、
  「重启后端」「复制图片」等死按钮继续存在 → 否决。
- **隐藏插件安装入口**（审计备选②）：改动最小，但会连同**本来可用的 agent 半插件**一起砍掉
  → 否决。
- **催上游加 probe 端点/RPC**（审计备选①）：需要改 vendor + 上游协作，本轮不可行；留作后续
  ——若上游真加端点，把 `plugin-probe.ts` 换成真调用即可，桥面签名不变。
- **`contextMenuCopyImage` 归 denied**：跨域图确实不可行，但同源图（预览/附件绝大多数场景）
  可行 → 全拒否决。
- **B 组无意义行改成 vendor 侧 `available()` 门控**：要改 vendor（PATCHES 登记 + 同步冲突
  面），而上游是有意保留这些行给桌面的 → 用 `web.css` 覆盖（项目既有约定，ADR-0010 不做
  feature-flag 系统）。
- **为 `probePluginRepo` 加代理端「拉取仓库文件」端点**：能真实现组件判定，但引入任意 URL
  出站（SSRF 面）+ 白名单维护 → 否决（与 `contextMenuCopyImage` 跨域同一取舍）。

**Consequences**:

- 插件安装弹窗在 Web 从死路变为可用（agent 半）；desktop 半恒不渲染，用户不会看到装不上的
  勾选。**降级是显式的**：probe 结果带一条 warning 说明「Web 无法安装桌面半插件」，不是静默。
- 若上游之后为插件探测加了 REST/RPC 端点，`plugin-probe.ts` 是本仓唯一改动点（桥面契约不变）。
- 联合花名册每刷新一次要对每条注册连接各发 2 个请求（status + profiles），连接多时为 O(n)
  ——与桌面端逐连接枚举同代价，接受。
- `launchMode` / `lastUsed` 落 localStorage 注册表；旧注册表读取时归一化，不需要版本迁移。
- 桥面「类 2（gateway）」新增 5 个成员，`adapter.ts` 仍保持「三分法」可读：新增面各自标注
  归属类，未新增任何 feature gate。
- 本 ADR 只处置 A/B/C 三组；D 组 33 面（保持缺省即正确）不动。
- **路由面与记账面一律严格**：`getConnectionFor` / `getGatewayWsUrlFor` 与
  `setPrimaryConnection` / `setLastUsed` 对未知 id 全部报错（上游同款）。
  两个调用点都能吞错——设置页切换 backend 的 `makePrimary` 有 try/catch
  （connections-registry.tsx:436-460），渲染层的 `setLastUsed` 调用点明确「不能把成功
  切换判成失败」（store/connections.ts:184-190）——所以严格不会把一次成功的 UI 操作
  炸成失败。隐式 `local` 例外：它不在 `connections` 数组里（由 `getConnectionById`
  合成），`hasConnection()` 显式接受它。
