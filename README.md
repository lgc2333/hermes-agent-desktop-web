# Hermes-Agent-Desktop-Web

简体中文 | [English](./README.en.md)

用浏览器访问你的 Hermes 智能体 —— 一个与官方桌面端体验一致的 Web 客户端。无需安装任何软件，打开网页即可与你的 Hermes 对话，支持连接远程服务器上运行的 Hermes。

## 为什么会有这个项目

社区里能搜到的 Hermes WebUI 主要是两个项目：

- [hermes-webui](https://github.com/nesquena/hermes-webui)：Bug 太多，无法忍受；
- [hermes-studio](https://github.com/EKKOLearnAI/hermes-studio)：太重、功能太多，不适合。

而 Hermes 官方桌面端本身是一个 Electron 应用。于是想到：能不能把它原样搬到浏览器里，而不是从零再写一个 UI？这个项目就是答案 —— 界面与交互和桌面端完全一致，并且跟随官方版本持续更新。

## 特性

- **与桌面端一致的完整体验**：会话管理、流式回复、工具调用、技能等
- **连接任何远程 Hermes**：填一个地址就能连上你的 gateway（服务器），随时随地用浏览器访问
- **三种登录方式**：静态 token、OAuth 登录、用户名密码登录，按你的 gateway 配置选择
- **手机 / 平板 / 电脑都适用**：响应式界面，移动端也能流畅使用
- **部署简单**：一个容器即可跑起来，开箱即用
- **凭证安全**：登录凭证保存在你自己的浏览器里，服务器不落盘

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

适合开发者。需要 Node.js ≥ 22.22、pnpm 11，代理模式还需要 Deno：

```bash
pnpm install
pnpm dev  # 本地体验（自带模拟 gateway）
pnpm --filter @hermes-web/web dev:remote  # 连接你自己的 gateway
```

## 常见问题

**为什么无法完成 OAuth 登录？**

Hermes 官方的 OAuth 登录要求回调地址只能是本机回环地址（`127.0.0.1`）。授权完成后浏览器需要能回跳到服务器的 `127.0.0.1` —— 如果你是用手机或公网域名访问，需要通过 SSH 隧道或 VPN 连接。这是官方的安全限制，无法绕过。

**为什么服务器重启后要重新登录？**

登录会话只保存在服务器内存中，重启即失效 —— 这是刻意的设计，服务器不把任何凭证写入磁盘。重新登录一次即可。

**凭证存在哪里？**

连接信息保存在你的浏览器本地存储中；登录会话（OAuth / 用户名密码）只存在服务器内存。服务器不会保存任何凭证到磁盘。

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
