# Hermes-Agent-Desktop-Web

简体中文 | [English](./README.en.md)

用浏览器访问你的 Hermes 智能体 —— 一个与官方桌面端体验一致的 Web 客户端。无需安装任何软件，打开网页即可与你的 Hermes 对话，支持连接远程服务器上运行的 Hermes。

## 为什么会有这个项目

社区里能搜到的 Hermes WebUI 主要是两个项目：

- [hermes-webui](https://github.com/nesquena/hermes-webui)：Bug 太多，无法忍受，聊天记录一长体验简直灾难；
- [hermes-studio](https://github.com/EKKOLearnAI/hermes-studio)：太重、功能太多，在 Hermes 的基础上轮子造太高，来自 Hermes 本体的聊天数据还是只读的，不适合。

（还有一个 [hermes-workspace](https://github.com/outsourc-e/hermes-workspace)，但是做这个项目之前没体验过，这里暂且不提）

而 Hermes 官方桌面端本身是一个 Electron 应用，我也非常喜欢它处理连接远程 Hermes 实例的方式，也就是只依赖 Hermes Gateway Dashboard 暴露出来的 API，很适合外围项目与官方容器环境分离部署。于是想到：能不能把它原样搬到浏览器里，而不是从零再写一个 UI？于是——

## 特性

- **不另起运行时**：Web 服务只提供浏览器界面与无状态代理，不自行运行 Hermes
- **与桌面端一致的完整体验**：会话管理、流式回复、工具调用、技能等
- **连接任何远程 Hermes**：填一个地址就能连上你的 gateway（服务器），随时随地用浏览器访问
- **三种登录方式**：静态 token、OAuth 登录、用户名密码登录，与 Dashboard 登录方式一致
- **部署简单**：一个容器即可跑起来，开箱即用
- **凭证存储**：登录凭证保存在你自己的浏览器里，服务器不落盘

## 快速开始

### Docker Compose 部署（推荐）

前置：安装了 Docker（含 compose 插件）的服务器。

1. 把仓库中的 `.env.example` 与 `docker-compose.yml` 下载下来一起放在目标目录

2. 将 `.env.example` 重命名为 `.env`

   ```bash
   mv .env.example .env
   ```

3. 编辑 `.env`：**必须设置 gateway 的登录方式**，否则无法登录；也可以按需修改端口、白名单等

4. 启动:

   ```bash
   docker compose up -d
   ```

首次使用：

1. 进入 **设置 → Gateway**，地址已自动填好（`http://hermes:9119`），无需修改；
2. 点击探测后按提示登录：OAuth 授权弹窗，或输入 `.env` 里设置的用户名密码；
3. 回到聊天页，开始和你的 Hermes 对话。

### 从源码运行

适合开发者。需要 Node.js ≥ 22.22、pnpm 11 与 Deno（SPA 恒经代理，dev 也会起代理）：

```bash
pnpm install
pnpm dev  # 本地体验（自带模拟 gateway），或
pnpm dev:remote  # 连接你自己的 gateway
```

## 常见问题

**移动端体验怎么样？**

只能说**凑合能用**，用不爽，操作别扭。毕竟 Hermes Desktop 的界面布局和操作逻辑本就不适合触屏移动端。但是在我的视角看来，比起用那些用户体验实在不太行的项目，这种体验足够了。

**为什么无法完成 OAuth 登录？**

Hermes 官方的 OAuth 登录要求回调地址只能是本机回环地址（`127.0.0.1`）：

- **浏览器与服务器同机**（开发环境）：弹窗自动完成，无需任何操作。
- **远程访问**（手机 / 公网域名）：登录后浏览器会跳到本机的 `127.0.0.1` 并显示"连接失败"——这是**预期**的。复制地址栏里的完整 URL，粘贴到登录框下方的"粘贴回调 URL"输入框即可完成登录，无需 SSH 隧道或 VPN。

这是官方的安全边界，本方案不绕过它，只是把 code 由你亲手搬回代理，各安全属性与桌面端完全一致。

**凭证存在哪里？**

连接信息保存在你的浏览器本地存储中；登录会话（OAuth / 用户名密码）只存在服务器内存。服务器不会保存任何凭证到磁盘。

**使用用户名密码登录时，密码安全吗？**

如果通过 `http://`（没有 HTTPS）访问，用户名密码是**明文传输**的，网络路径上的中间人可以看到。公网部署请务必在前面加 HTTPS（如 Nginx / Caddy 反向代理）；内网或 VPN 环境相对安全，但同样建议启用。

**为什么我填写的 gateway 地址连不上？**

如果你（或部署者）配置了连接白名单（`WEB_PROXY_ALLOWED_TARGETS`），那么只能连接白名单内的 gateway。这是部署者主动设置的限制，用于防止服务器被滥用。

**支持哪些登录方式？**

| 方式       | 适用场景                            |
| ---------- | ----------------------------------- |
| 静态 token | 本机运行、未开启登录验证的 gateway  |
| OAuth 登录 | 开启了官方 OAuth 的 gateway（推荐） |
| 用户名密码 | 仅配置了密码登录的 gateway          |

## 配置

详见 [.env.example](.env.example)；gateway 侧的完整配置见 [Hermes Agent 官方文档](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)。

## 致谢

- [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)

## 赞助

**[赞助我](https://lgck.cc/sponsor)**

感谢大家的赞助！你们的赞助将是我继续创作的动力！

## 联系

- QQ：3076823485
- QQ群：[168603371](https://qm.qq.com/q/EikuZ5sP4G)
- Telegram：[@lgc2333](https://t.me/lgc2333)
- 邮箱：<lgc2333@126.com>
