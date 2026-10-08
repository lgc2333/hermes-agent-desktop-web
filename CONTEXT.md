# Hermes Web（hermes-agent-desktop-web）Context

浏览器端 Hermes 客户端：把桌面端渲染层搬到 Web，经一个无状态代理连接远程 Hermes gateway。本词表覆盖"浏览器 — 代理 — gateway"三方模型与连接/认证语义。

## 连接与认证

**Gateway**:
本上下文中指 Hermes 的 headless 后端 API 面（`hermes serve` / dashboard 的 /api/* 与 /api/ws），即 Web 应用连接的目标。
_Avoid_: 消息 gateway（Telegram/Discord 等平台适配，上游同名但完全不同的概念）

**Serve**:
以 headless 模式运行的 gateway 进程（`hermes serve`），只暴露 JSON-RPC/WS/API 面，是 Web 连接的标准目标形态。
_Avoid_: 后端服务（太泛）

**Connection**:
浏览器中保存的具名注册项，描述一个 gateway（label / kind / url / authMode）并携带其凭证；每台设备各自持有。
_Avoid_: 配置（太泛）

**Target**:
当前被选中用于转发的 gateway；由浏览器在每次请求中携带（X-Hermes-Target），切换目标不需要代理侧任何状态。
_Avoid_: 目标网关（与 Connection 混用）

**Credential**:
浏览器持有的长期凭证（静态 session token），按连接存储，永不进入代理。
_Avoid_: 密钥、token（太泛）

**Password session**:
密码门禁 gateway 的会话（"dashboard login"）：/auth/password-login 用用户名/密码
换 cookie 会话（hermes_session_at/_rt）。jar 编码进浏览器 httpOnly cookie（代理域，
per-target，ADR-0023），机制见 session.ts 头注。密码本体不落盘不缓存。
_Avoid_: 登录流程（太泛）、cookie（实现细节）

**Session token**:
gateway 签发的静态长期令牌，token 认证模式下的凭证；REST 走 X-Hermes-Session-Token 头，WS 走 ?token=。
_Avoid_: 密钥

**Ticket**:
OAuth 模式下 gateway 为每次 WS 拨号签发的短期票据，与 Credential 不同，拨号即用即弃。
_Avoid_: 一次性令牌（与 Session token 混淆）

**Native OAuth**:
OAuth 认证模式：gateway 充当授权服务器（/auth/native/*），浏览器侧完成 PKCE（RFC 8252 风格），经代理回调落地。
_Avoid_: 登录流程（太泛）

**Target allowlist**:
部署者配置的代理出站目标集合（env WEB_PROXY_ALLOWED_TARGETS，逗号分隔，空=不限）；代理只向名单内 Gateway 发起转发，防开放转发/SSRF。匹配按 origin（scheme://host:port），支持 `*.` 子域通配；限制"能去哪"而非"谁在用"，与 Credential 无关（ADR-0015）。
_Avoid_: 口令（已废弃，无共享口令）、token、密钥

## 客户端结构

**WebUI**:
浏览器面对的整个部署单元：SPA 静态产物 + 无状态代理，作为一个容器交付。
_Avoid_: 前端（单指 SPA 时）

**SPA**:
浏览器中运行的 React 渲染层，移植自桌面端渲染层。
_Avoid_: WebUI（部署单元）、前端（口语）

**Proxy**:
WebUI 内的 Deno 组件：同源转发 REST/WS 到 Target，托管 SPA 静态产物。凭证模型
（ADR-0023）：零凭证内存态——OAuth token set 与 Password session 的 cookie jar 都
在浏览器 httpOnly cookie，代理无状态、重启无感恢复、零落盘（见 proxy 头注）。
SPA 的所有出站面恒经代理（ADR-0016），不存在直连路径。
_Avoid_: 薄代理（口语）、网关（错误）、直连（已删除）

**Vendor**:
以 git subtree 引入的上游包（hermes-desktop / hermes-shared）；apps/web 以 workspace 依赖引用其包清单，渲染层依赖因此隐式继承、不另行复制。
_Avoid_: 上游源码（口语）、node_modules（实现细节）

**Capability bridge**:
渲染层访问机器/原生能力的窄类型接口（桌面端为 window.hermesDesktop）；Web 端由 WebCapabilityAdapter 提供同签名实现，能力按可用性分三类：**browser**（浏览器原生等价）、**gateway**（经代理 RPC 转发）、**denied**（拒绝类空实现）。
_Avoid_: 桥（太短）、preload（实现细节）

**Denied capability**:
桥面三分法中的拒绝类：空实现，返回"空但合法"形状或显式 reject。判定标准（ADR-0010）：仅当浏览器环境不可实现 **且** remote gateway 不支持（无对应 REST 端点）才可归入；例外需产品范围决策（如语音，ADR-0009）；上游在 remote 模式下原生支持的能力不应归入（ADR-0009 撤销了 artifacts/agents）。
_Avoid_: 不支持的能力（与"未实现"混淆）

**Feature gate（已退役）**:
用字面 `if (false)` 关闭功能入口而保留其代码的机制；gates.ts 已删（ADR-0009），Web 不再做可配置开关系统，入口按能力分类决定（browser/gateway/denied）。

**Registry-scoped connection（注册表作用域拨号）**:
按注册表里**指定的一条 Connection**（而非当前 primary）解析出的连接视图：带上
`connectionId` 与 `registryScoped` 标志，供次级/兄弟窗口拨到正确的 Target。与 primary
连接的区别只在解析来源，凭证模型相同（ADR-0027）。
_Avoid_: 次级连接（含糊）、profile（那是同一 gateway 内的身份，另一维度）

**Agent roster（联合 agent 花名册）**:
跨全部注册连接的 agent 视图：逐条连接枚举 `/api/profiles` 后拍平、按 backend 身份
（install_id）折叠同一后台的多个地址、重名 profile 加 `@name-device` 后缀。供 Bot Mode /
capabilities scope-selector / profile rail 显示「别的机器上还有谁」（ADR-0027）。
_Avoid_: 花名册（单指本地 profile 列表时）、agent 列表（未跨连接时）

**Plugin probe（插件仓库探测）**:
安装前判定一个插件仓库里有没有 agent 半 / desktop 半组件的能力。桌面端在 Electron 主进程
clone 后读文件判定；Web 无 git、无任意 URL 字节读通道 → **降级实现**：保留标识符校验，
恒报 agent 可装 / desktop 不可装（Web 无 Electron 主进程可装），并带一条说明性 warning
（ADR-0027）。
_Avoid_: 插件安装（探测只判组件，不装）

**Blob attachment（Web 虚拟附件）**:
浏览器 File / 粘贴图片没有 gateway 侧文件路径，渲染层又是桌面式"路径模型"，Web 桥用一条承载真实文件名的虚拟路径（`web-blob://attach/...`）指代附件，字节随用随读（File 保留引用零常驻；仅纯内存字节才落 OPFS）。虚拟路径含两段正交身份：**附件身份（blob id）**——Web 内部存储唯一键，永不随上传离开 Web；**上传文件名**——提交给 gateway 的实际文件名，与桌面端一致。二者正交（不在同一个 basename 里混着）。
_Avoid_: 本地文件路径（Web 没有 gateway 侧等价）、临时文件（随用随读非常驻）、"文件名前缀"（指 blob id 时的歧义称呼）

**Blob id（附件身份）**:
虚拟路径里的单调递增内部序号，用作 Web 本地存储键的唯一身份（ADR-0020）。仅 Web 内部可见，不进入提交给 gateway 的上传文件名。
_Avoid_: 前缀、序号（口语）

**Gateway file download**:
把 Target 上的单个 gateway 文件交给浏览器下载管理器保存（ADR-0025）。Web 只能返回浏览器可见的下载文件名，不承诺用户本机绝对路径，也不等同于打开所在文件夹。
_Avoid_: 另存为路径选择（Web 不知道本机路径）、附件上传（反方向）、reveal/openDir（OS 文件管理器能力）

**Session source**:
session.create 上标记客户端表面的标签；本项目复用桌面端的 'desktop' 值。
_Avoid_: 平台（上游 platform 是另一个概念）

**Re-home**:
切换 Connection 时外壳保持、仅 gateway 绑定视图清空重建的语义（软/硬两档），继承自桌面端。
_Avoid_: 重启、刷新

**Theme supplier（主题供应商）**:
给设置页「Appearance → Theme」提供 Marketplace 主题来源的能力：搜索 +
按需取包（下载 .vsix、读 package.json 与引用的颜色主题 JSON 原文交给渲染层
转换）。Web 端由浏览器直连官方 VS Code Marketplace（公共 API，CORS 放行 *，
零代理、零凭证；ADR-0021）；桌面端走 Electron 主进程。安全边界同为"决不执行
扩展代码"——只读主题 JSON。
_Avoid_: 主题商店

## 部署

**Hermes container**:
跑 gateway 的容器（compose 中为上游镜像 + `gateway run` + `HERMES_DASHBOARD=1`，s6 监督 dashboard 作 API 载点）；9119 仅映射宿主 loopback（OAuth 授权弹窗需要浏览器可达 `/auth/native/authorize`），webui 是浏览器唯一入口。
_Avoid_: 后端容器（与 Proxy 混淆）

**Dashboard auth gate**:
上游 dashboard 的非 loopback 绑定强制启用的认证闸门（2026-06 硬化后 `--insecure` 失效）；必须注册 auth provider（内置 basic auth 或 OAuth）否则启动失败。API 面认证走 native OAuth Bearer、cookie 会话（Password session）或 ws-ticket，与 gate 的页面登录表单同源同会话。
_Avoid_: 登录流程（特指页面 cookie 登录）、代理 target allowlist（限制转发目标，另一层）

**Default gateway**:
部署时由环境变量提供、经代理 meta 端点运行时下发的预填 gateway URL；前端连接表单自动预填，用户可改。
_Avoid_: 默认配置（太泛）

**Loopback redirect_uri**:
上游 `/auth/native/authorize` 只接受 127.0.0.1/::1 字面量 redirect_uri（RFC 8252 §7.3，安全边界、无放宽渠道）；因此 OAuth 登录要求浏览器与代理同机，或经 Paste-back 手动搬回 code。详见 README.md「安全模型」。

**Paste-back（粘贴回跳）**:
远端部署完成 Native OAuth 的方式（ADR-0017）：start 默认用 loopback 字面量 redirect_uri，浏览器登录后跳到本机 127.0.0.1 失败（预期），用户复制地址栏完整回调 URL（含 code+state，或裸 query）经 `/auth/native/paste` 粘贴回代理；代理校验 state + target 后走与 callback 相同的 code 交换。安全属性不变（PKCE/state/单次/短 TTL 由 gateway 强制）。
_Avoid_: 隧道（已不需要）、登录流程（太泛）
_Avoid_: localhost（上游明确拒绝）、"可配置的允许列表"（不存在）

**发布 tag**:
发布点的 git tag，携带完整版本标识 `v<项目版本>+<上游版本>`（如 v0.4.22+v0.21.6；追 main 的同步点用 7 位短 hash，如 v0.4.22+818c13b），与客户端自报版本 WEB_VERSION 完全一致（ADR-0026）。上游分量 = apps/web/package.json#upstream.ref（同步脚本写入），项目版本 = apps/web/package.json#version。
_Avoid_: 桌面版本分量（上游 2026-10-08 起 `apps/desktop/package.json` version 变占位符 0.0.0，已无来源）、`+web.` 前缀（旧方案）、版本号（不指 tag 时）
