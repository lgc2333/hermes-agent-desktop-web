# 0003 — Deno 原生零依赖代理，TS 源码直跑

代理要求小镜像、轻依赖。决定：Deno，只用原生 API（Deno.serve + Deno.upgradeWebSocket + fetch），零第三方依赖，TS 源码直跑（不用 esbuild；deno compile 仅作可选发行形态）。

**Status**: accepted

**Considered Options**:
- Node 零依赖原生：可行，但 WS 要手工 upgrade + socket pipe
- Node + Hono（~15KB）：依赖很小，但 WS 仍需手工处理或引入 ws 包
- Bun：开发体验好，但镜像偏大

**Consequences**: 免构建（dev/prod 一致）、WS 服务端原生、权限模型（--allow-net）对公网部署安全加分、deno:alpine 镜像小；代价是代理代码与 npm 生态隔离，未来如需 npm 库用 npm: 说明符或迁移。