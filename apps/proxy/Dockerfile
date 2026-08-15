# apps/proxy/Dockerfile — Hermes WebUI 容器（SPA 静态托管 + Deno 薄代理）
#
# 多阶段：
#   1. node:22-alpine  构建 SPA（apps/web，vite 打包 vendor 渲染层）
#   2. deno:alpine     运行代理（源码直跑，零依赖；WEB_DIST 指向阶段 1 产物）
#
# 运行环境变量（与 apps/proxy/src/main.ts 一致）：
#   PORT / HOST / WEB_DIST / PROXY_PASSPHRASE / HERMES_DEFAULT_GATEWAY_URL /
#   OAUTH_REDIRECT_URI
#
# 构建：docker build -f apps/proxy/Dockerfile -t hermes-webui .
# 或经根 docker-compose.yml：docker compose build webui

# ── 阶段 1：构建 SPA ────────────────────────────────────────────────────────
FROM node:22-alpine AS web-build

WORKDIR /app

# 先拷构建清单（workspace 元数据 + 锁文件），利用层缓存
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY vendor/hermes-desktop/package.json vendor/hermes-desktop/package.json
COPY vendor/hermes-shared/package.json vendor/hermes-shared/package.json

# pnpm 版本由 package.json 的 packageManager 字段钉住（pnpm@11.20.0）
RUN corepack enable && corepack prepare --activate

# --frozen-lockfile：锁文件即真相（与本地 pnpm install 一致）
# allowBuilds 策略继承自 pnpm-workspace.yaml（electron/node-pty 等不构建）
RUN pnpm install --frozen-lockfile

# 再拷源码（vendor 渲染层 + web 入口），此处变更不命中上面的缓存层
COPY apps/web apps/web
COPY vendor/hermes-desktop vendor/hermes-desktop
COPY vendor/hermes-shared vendor/hermes-shared

RUN pnpm --filter @hermes-web/web build

# ── 阶段 2：代理运行时 ──────────────────────────────────────────────────────
FROM denoland/deno:alpine

WORKDIR /app

# 代理源码（deno 零依赖直跑，无 node_modules）
COPY apps/proxy/src src
COPY apps/proxy/deno.json deno.json

# SPA 静态产物
COPY --from=web-build /app/apps/web/dist web-dist

ENV WEB_DIST=/app/web-dist
ENV HOST=0.0.0.0
ENV PORT=6722

EXPOSE 6722

# 权限最小集：net（转发/OAuth 回调）、read（静态 + 源码）、env（配置）
CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-env", "src/main.ts"]
