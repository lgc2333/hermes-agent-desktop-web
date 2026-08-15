# apps/web/e2e — CDP 浏览器验收脚本

> headless Chrome + Chrome DevTools Protocol 场景脚本（M3 起累积，自 M4 起入库管理）。
> 约定：**从仓库根运行**（脚本内相对路径以仓库根为 cwd）。

## 前置

```bash
# 1. 起 headless Chrome（CDP 9224，独立 profile + 放行弹窗）
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' --headless=new \
  --remote-debugging-port=9224 --user-data-dir=temp/e2e-profile \
  --disable-popup-blocking --no-first-run --no-default-browser-check about:blank

# 2. 起目标拓扑（按脚本头部注释）——多数脚本需要：
#    mock(5180) [OAuth 场景加 mock(5182, MOCK_OAUTH=1)] + proxy(6722) + vite(5173)
#    或生产形态（proxy 托管 dist）；部分脚本内部自行 kill/restart mock/proxy

# 3. 跑脚本
node apps/web/e2e/cdp-oauth.mjs          # 桥层 OAuth 全链路
node apps/web/e2e/cdp-ui.mjs             # UI 层 OAuth + 聊天 + 刷新保持
node apps/web/e2e/cdp-reconnect-a.mjs    # token 断连 → 自动重连
node apps/web/e2e/cdp-reconnect-b.mjs    # OAuth + 代理重启会话丢失
node apps/web/e2e/cdp-repair-logs.mjs    # boot-failure 按钮隐藏断言
node apps/web/e2e/cdp-dev-remote.mjs     # dev:remote（无 mock）形态
node apps/web/e2e/validate-compose.mjs   # compose YAML 解析校验
```

## 注意

- 脚本间的注册表（localStorage hermes-web.connections.v1）会互相污染——换场景先清注册表 + reload（AGENTS.md 坑 14）。
- 截图输出到 temp/e2e-out/（gitignore）。
- kill 端口进程用 taskkill /F /PID，先确认端口存活（AGENTS.md 坑 13）。
