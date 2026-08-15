# 0017 — OAuth paste-back（粘贴回调）登录：远端浏览器免隧道

M6 解决远端部署的 OAuth 登录：浏览器 ≠ 代理机器时，gateway 只收 loopback
redirect_uri（安全边界、无放宽渠道，ADR-0008 已知限制），授权完成后 IdP 把
浏览器 302 回 127.0.0.1 落在浏览器本机，代理收不到 code。采用上游处理 MCP
OAuth 远程不可达的同一模式（`hermes mcp login` 的 paste-back）：用户复制
地址栏的回调 URL 粘贴回应用，代理校验 state 后完成 code 交换。零基建、
零 vendor 后端改动、安全属性不变。

**Status**: accepted

**Context**:

- 真 gateway 的 `/auth/native/authorize` 只接受 `127.0.0.1`/`::1` 字面量
  redirect_uri（routes.py `_validate_loopback_redirect_uri`，防开放重定向
  盗 code 的安全边界）。远程部署时浏览器够不到代理的 loopback，唯一现状
  出路是 SSH 隧道/VPN（README「安全模型」已如实记录）。
- 改 Hermes 本体（网关加非 loopback 白名单）在本次会话被明确否决：Python
  后端 vendor 补丁维护成本高（PATCHES.md 同步冲突 + 上游未必采纳）。
- 上游解决同类问题（MCP OAuth 远程/headless 不可达）用的就是 paste-back：
  "浏览器跳到 `http://127.0.0.1:PORT/callback` 连接失败是**预期**，复制
  地址栏完整 URL（含 `?code=...&state=...`）粘贴回来，校验 state 后换
  token"（`website/docs/user-guide/features/mcp.md`，PR #28454 引入
  manual-paste fallback，Issue #26923 的远程控制台场景）。裸 `?code=...`
  query 也接受。
- 现有代理面已具备全部安全原语（oauth.ts 的 PKCE/state/pending/交换路径与
  桌面端 native-oauth.ts 同源），paste 只是把 code 的"送达"从浏览器导航
  换成用户手动搬运，验证链一字不动。

**Decision**:

- 代理 OAuth 面改造（apps/proxy/src/oauth.ts，非 vendor）：
  1. `/auth/native/start` 的默认 redirect_uri 从"请求 origin"改为
     **loopback 字面量** `http://127.0.0.1:<port>/auth/native/callback`
     （port 取监听端口，默认 6722；`WEB_OAUTH_REDIRECT_URI` 仍可整体
     覆盖）。理由：gateway 只收 loopback，origin 模式在生产从未成功过；
     loopback 默认让 dev（浏览器=代理同机）自动完成、远端则落入粘贴，
     同一套 start 参数两种拓扑都成立。
  2. 新增 `POST /auth/native/paste`（免检面，与 callback 同级）：body
     `{ target, url }`（url = 用户粘贴的完整回调 URL 或裸 query，容忍
     前后空白）。解析 code/state/error；按 state 查 pending（TTL 10min、
     CSRF 语义与 callback 相同）；`target` 必须匹配 pending.target；
     code 交换复用 `handleCallback` 的同一路径（重构共享
     `completePending`）；成功 Set-Cookie 会话并返回 `{ ok: true }`，
     失败 400 `{ detail }`。
  - 安全：与 callback 逐项相同——只有代理自己登记过的 state 可交换；
    verifier 只存代理内存；code 单次/120s TTL/PKCE 绑定由 gateway 强制；
    token 永不下发浏览器。伪造粘贴（未知/过期 state、target 不匹配）一律
    400，不触发任何交换。
- 桥面（apps/web/src/bridge，非 vendor）：`oauth.ts` 新增
  `paste(remoteUrl, pasted)`；`index.ts` 暴露
  `oauthPasteConnectionConfig(remoteUrl, pasted)`；`adapter.ts` 接线。
- 渲染层（vendor，登记 PATCHES.md §4，M5 密码表单同类）：
  - `gateway-settings.tsx` 与 `first-run-remote-form.tsx` 的 OAuth
    分支：sign-in 进行中显示"回跳失败？粘贴地址栏 URL"区块（textarea +
    提交按钮），调 `oauthPasteConnectionConfig`；成功后走既有轮询/
    refresh 路径。
  - `boot-failure-overlay.tsx`：OAuth reauth 与 M5 密码分支一致路由到
    嵌入式 Gateway settings 视图（paste 提示只在 settings/first-run 一处，
    不复制第三份）。
  - `global.d.ts` 新增 `oauthPasteConnectionConfig` 表面；i18n
    en/zh/types 新增键。
- README FAQ 更新：远端部署 OAuth 登录 = 弹窗 + 粘贴一次，无需隧道。

**Considered Options**:

- 网关侧白名单非 loopback redirect_uri（全自动弹窗）：体验最好，但需改
  Hermes Python 本体——本会话用户明确否决（vendor 后端维护成本）。
- Device flow（RFC 8628）：上游会话登录无此面（device code 仅存在于
  Hermes 自身 provider 认证），需上游新增整套 broker → 排期不可控。
- 保持 SSH 隧道/VPN：零代码，但违背"免特殊操作"核心诉求。

**Consequences**:

- 远端浏览器首次可完成 OAuth 登录：零基建、零 vendor 后端改动；每次新
  会话登录多一次"复制地址栏 URL → 粘贴"（会话 cookie 存续期间无需重登；
  代理重启后需重登一次，与 ADR-0008 内存态同取舍）。
- dev 拓扑无感知变化（loopback redirect 本就落在代理，弹窗自动关闭）。
- 代理默认 redirect_uri 从 origin 改为 loopback：行为等价（origin 模式在
  生产从未成功过），且 dev 端点测试断言不变。
- vendor 原位改动 +5 文件（两个表单、overlay、global.d.ts、i18n×3），
  全部登记 PATCHES.md；同步注意沿用 M5 条目。
