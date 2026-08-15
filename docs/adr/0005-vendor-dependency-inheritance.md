# 0005 — 渲染层依赖清单隐式继承自 vendor 包

apps/web 需要桌面渲染层的全部运行时依赖。最初方案是复制 vendor 包的 dependencies 到 apps/web（显式清单）；决定：apps/web 只声明 `"hermes": "workspace:*"`（指向 vendor/hermes-desktop），渲染层依赖全部由该 workspace 包隐式提供，**不复制清单**。vendor 的 devDependencies（electron / node-pty / playwright / vitest 等）也会随 workspace 安装，但其 build 脚本在 pnpm-workspace.yaml 的 `allowBuilds` 中显式拒绝，避免二进制下载与原生态编译。

**Status**: accepted

**Considered Options**:
- 复制 dependencies 到 apps/web：清单显式、可裁剪（只装渲染层需要的），但每次 subtree pull 后需手动同步版本
- `file:` 引用 vendor 包：pnpm 只装其 dependencies（devDeps 不进来），但上游 `file:../shared` 相对路径在改名后的 vendor 布局下解析错误，需 overrides 修补
- `workspace:*`（选定）：语义最直接，依赖随上游自动演进，零同步负担

**Consequences**: 依赖版本永远跟随 vendor 包，不会漂移；代价是渲染层用不到的桌面 devDeps（electron 等）也进 node_modules（仅装包体、不跑脚本），且依赖可见性不如显式清单——查依赖清单看 vendor/hermes-desktop/package.json。上游 `@hermes/shared` 的 `file:../shared` 相对路径由 workspace overrides 钉到 vendor/hermes-shared 包。
