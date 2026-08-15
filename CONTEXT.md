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
浏览器持有的长期凭证（静态 session token 或 OAuth token set），按连接存储，永不进入代理。
_Avoid_: 密钥、token（太泛）

**Session token**:
gateway 签发的静态长期令牌，token 认证模式下的凭证；REST 走 X-Hermes-Session-Token 头，WS 走 ?token=。
_Avoid_: 密钥

**Ticket**:
OAuth 模式下 gateway 为每次 WS 拨号签发的短期票据，与 Credential 不同，拨号即用即弃。
_Avoid_: 一次性令牌（与 Session token 混淆）

**Native OAuth**:
OAuth 认证模式：gateway 充当授权服务器（/auth/native/*），浏览器侧完成 PKCE（RFC 8252 风格），经代理回调落地。
_Avoid_: 登录流程（太泛）

**Passphrase**:
代理的访问控制口令（公网部署必开），用于防止开放转发；它认证的是代理，不是 gateway。
_Avoid_: token、密钥

## 客户端结构

**WebUI**:
浏览器面对的整个部署单元：SPA 静态产物 + 无状态代理，作为一个容器交付。
_Avoid_: 前端（单指 SPA 时）

**SPA**:
浏览器中运行的 React 渲染层，移植自桌面端渲染层。
_Avoid_: WebUI（部署单元）、前端（口语）

**Proxy**:
WebUI 内的 Deno 组件：同源转发 REST/WS 到 Target，托管 SPA 静态产物，不持有任何凭证。
_Avoid_: 薄代理（口语）、网关（错误）

**Vendor**:
以 git subtree 引入的上游包（hermes-desktop / hermes-shared）；apps/web 以 workspace 依赖引用其包清单，渲染层依赖因此隐式继承、不另行复制。
_Avoid_: 上游源码（口语）、node_modules（实现细节）

**Capability bridge**:
渲染层访问机器/原生能力的窄类型接口（桌面端为 window.hermesDesktop）；Web 端由 WebCapabilityAdapter 提供同签名实现，能力按可用性分三类：浏览器原生可用、经 gateway 转发、被布尔门关闭（桌面独有）。
_Avoid_: 桥（太短）、preload（实现细节）

**布尔门（feature gate）**:
用字面 `if (false)` 关闭功能入口而保留其代码的做法，刻意不做可配置开关系统；被关闭的功能处于 dormant 状态。
_Avoid_: feature flag（语义不同）

**Session source**:
session.create 上标记客户端表面的标签；本项目复用桌面端的 'desktop' 值。
_Avoid_: 平台（上游 platform 是另一个概念）

**Re-home**:
切换 Connection 时外壳保持、仅 gateway 绑定视图清空重建的语义（软/硬两档），继承自桌面端。
_Avoid_: 重启、刷新

## 部署

**Hermes container**:
跑 gateway 的容器（compose 中为上游镜像 + `gateway run` + `HERMES_DASHBOARD=1`，s6 监督 dashboard 作 API 载点）；9119 仅映射宿主 loopback（OAuth 授权弹窗需要浏览器可达 `/auth/native/authorize`），webui 是浏览器唯一入口。
_Avoid_: 后端容器（与 Proxy 混淆）

**Dashboard auth gate**:
上游 dashboard 的非 loopback 绑定强制启用的认证闸门（2026-06 硬化后 `--insecure` 失效）；必须注册 auth provider（内置 basic auth 或 OAuth）否则启动失败。API 面认证走 native OAuth Bearer + ws-ticket，与 gate 的页面登录相互独立。
_Avoid_: 登录流程（特指页面 cookie 登录）、代理 passphrase（保护转发面的另一层）

**Default gateway**:
部署时由环境变量提供、经代理 meta 端点运行时下发的预填 gateway URL；前端连接表单自动预填，用户可改。
_Avoid_: 默认配置（太泛）

**Loopback redirect_uri**:
上游 `/auth/native/authorize` 只接受 127.0.0.1/::1 字面量 redirect_uri（RFC 8252 §7.3，安全边界、无放宽渠道）；因此 OAuth 登录要求浏览器与代理同机或经 SSH 隧道回连 loopback。详见 docs/deploy.md §4.3。
_Avoid_: localhost（上游明确拒绝）、"可配置的允许列表"（不存在）
