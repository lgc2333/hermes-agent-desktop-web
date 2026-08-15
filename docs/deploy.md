# Hermes WebUI 部署指南（compose）

> M4 交付。双容器编排（PLAN §6.2）：**hermes**（上游镜像，API 载点）+
> **webui**（Deno 薄代理 + SPA，唯一入口）。同一 SPA 构建可部署到任意环境，
> 默认远端 URL 运行时下发，无需重建镜像。

## 1. 拓扑

```
浏览器 ──:8080──> webui（SPA + 无状态代理） ──内部网络 http://hermes:9119──> hermes（gateway run + dashboard）
                      │                                                         │
                      └── 同机浏览器 OAuth 弹窗也可直达 127.0.0.1:9119（loopback 映射）
```

- **hermes**：上游 `hermes-agent` 镜像，`gateway run`（s6 监督，崩溃自重启），
  `HERMES_DASHBOARD=1` 让 s6 额外监督 dashboard——**API 载点**（/api/*、/api/ws、
  /auth/native/*）。绑定 0.0.0.0:9119，仅映射宿主 loopback。
- **webui**：`apps/proxy/Dockerfile`（deno:alpine 薄镜像），映射宿主机
  `WEBUI_PORT`（默认 8080）。`HERMES_DEFAULT_GATEWAY_URL` 经
  `/api/proxy/meta` 运行时下发前端设置页预填。

## 2. 前置

1. 构建上游镜像（体积大，一次性；或改用你自己的 registry 镜像并改
   compose 的 `image:` 字段）：

   ```bash
   cd research/upstream
   docker build -t hermes-agent .
   ```

2. 准备环境变量（compose 强校验，缺失直接报错）：

   ```bash
   export PROXY_PASSPHRASE='<随机长口令>'          # webui 转发面访问控制（必填）
   export HERMES_DASHBOARD_BASIC_AUTH_PASSWORD='<随机密码>'  # dashboard 登录密码（必填）
   # 可选：
   # export HERMES_DASHBOARD_BASIC_AUTH_USERNAME='hermes'   # dashboard 用户名（默认 hermes）
   # export WEBUI_PORT=8080
   # export HERMES_UID=$(id -u) HERMES_GID=$(id -g)          # 宿主卷归属
   ```

## 3. 启动

```bash
docker compose up -d --build
docker compose logs -f webui    # 观察启动
```

浏览器打开 `http://<host>:8080`：

1. 首次进入设置页（#/settings?tab=gateway），URL 已自动预填
   `http://hermes:9119`（meta 下发，可改）。
2. 远程模式探测后点 **Sign in**（native OAuth）→ 授权弹窗 → connected。
3. 回聊天页发消息（WS 经代理 mint 单次 ws-ticket 拨号）。

## 4. 认证模型（必读）

### 4.1 为什么必须配 basic auth provider

上游 2026-06 安全硬化：dashboard **非 loopback 绑定即强制 auth gate**，
`HERMES_DASHBOARD_INSECURE` 已失效。没有注册 auth provider 时
`start_server` 启动即失败（fail closed）。compose 用内置 **basic auth
provider**（用户名/密码）满足 gate——它保护的是 dashboard 页面本身；
webui 的 API 认证走 native OAuth（见 4.2），两者独立。

### 4.2 API 认证 = native OAuth（Bearer + ws-ticket）

浏览器 → webui 全程同源；代理按 httpOnly cookie 会话注入凭证：

| 面 | 凭证 | 上游接受点 |
|----|------|-----------|
| REST /api/* | `Authorization: Bearer <access_token>` | gate 的 bearer 校验（native token） |
| WS /api/ws | 单次 `?ticket=`（30s TTL，代理先 POST /api/auth/ws-ticket 用 Bearer 换） | ws_tickets 单次消费 |
| PKCE 交换 | /auth/native/{authorize,token,refresh} | gate 公开前缀 |

代理重启 → 内存 token set 清空（PLAN §6：无持久化）→ 浏览器下次请求
401/未连接 → 重新登录即可（M3 坑 #9）。

### 4.3 loopback redirect_uri 限制（重要）

上游 `/auth/native/authorize` 只接受 **loopback IP 字面量**
（127.0.0.1 / ::1，RFC 8252 §7.3）作 redirect_uri——这是安全边界，
**没有放宽渠道**（`localhost` 也不行）。含义：

- **同机访问**（浏览器与服务器同机，打开 `http://127.0.0.1:8080`）：
  OAuth 开箱即用。compose 已把 hermes 的 9119 映射到宿主 loopback，
  授权弹窗直达 127.0.0.1:9119。
- **SSH 隧道**（远端浏览器访问）：`ssh -L 8080:localhost:8080 -L
  9119:localhost:9119 user@server` 后本地打开 `http://127.0.0.1:8080`，
  效果等同同机。
- **纯公网浏览器访问**（如手机经域名访问）：redirect_uri 非 loopback →
  gateway 拒绝授权。上游无配置可放宽；若你的 gateway 未来支持
  redirect_uri 白名单，可用 `OAUTH_REDIRECT_URI` 覆盖回调地址。
  **当前限制下请用隧道或 VPN。**

### 4.4 为什么不支持静态 token 模式

gated dashboard（非 loopback）不接受 `X-Hermes-Session-Token`
（`_SESSION_TOKEN` 只在 loopback 模式注入/校验）。因此 compose
拓扑下认证只有 native OAuth 一条路。需要 token 模式直连的场景
（非容器、本地 `hermes serve`）不在本编排范围——见
`temp/handoff-hermes-web-m2.md` 的验收形态。

## 5. 默认 URL 下发链路

```
compose env: HERMES_DEFAULT_GATEWAY_URL=http://hermes:9119
        ↓ (env)
webui 容器 (proxy) ── /api/proxy/meta ──> { defaultGatewayUrl, requiresPassphrase }
        ↓ (fetch on boot)
前端设置页自动预填 URL（用户可改；token/OAuth 凭证仍只在浏览器）
```

改默认目标只需 `docker compose up -d -e HERMES_DEFAULT_GATEWAY_URL=...`，
**不用重建镜像**。

## 6. 安全清单

- [ ] `PROXY_PASSPHRASE` 已设（公网必开；浏览器首次访问需在设置里填，或
      经 `X-Hermes-Proxy-Passphrase` 头注入）
- [ ] `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD` 为强随机值
- [ ] hermes 9119 仅映射 loopback（compose 默认；不要改成 0.0.0.0 映射）
- [ ] 宿主机防火墙只放行 8080（webui），9119 不对外开放
- [ ] 代理不落盘任何凭证：OAuth token set 只在代理内存，浏览器仅持
      httpOnly cookie 会话；gateway 连接凭证（如有）只在浏览器 localStorage

## 7. 运维

| 操作 | 命令 |
|------|------|
| 看日志 | `docker compose logs -f hermes webui` |
| 重启 webui | `docker compose restart webui`（OAuth 会话会失效，重新登录） |
| 更新 webui | `docker compose up -d --build webui` |
| 更新 hermes | `docker compose pull hermes && docker compose up -d hermes` |
| 健康检查 | `curl http://<host>:8080/api/proxy/meta` 应回 `{"defaultGatewayUrl":...,"requiresPassphrase":true}` |

## 8. 已知限制（如实登记）

1. 远端浏览器（非隧道）OAuth 不可用：上游 redirect_uri loopback 安全边界
   （见 4.3）。
2. 代理为内存态：重启丢 OAuth 会话，用户需重新登录（PLAN §6 无持久化）。
3. hermes 容器需监听 0.0.0.0 才能被 webui 访问（bridge 网络）；这是 gate
   强制开启的原因，配好 4.1 的 provider 即可。
4. 本机无 Docker 的验证路径：compose 配置经 YAML 解析校验 +
   M3 验收脚本（temp/m3-acceptance/）在 dev 拓扑验证代理/OAuth 全链路。
