# 0016 — SPA 只走代理：删除直连回退

浏览器 SPA 的所有出站面（REST / WS / 探活 / OAuth / 密码会话 / meta）恒经同源代理，
不再存在"直连 conn.url"路径。代理基址解析不再依赖构建模式（import.meta.env.PROD），
proxyBaseUrl() 恒非空：VITE_PROXY_URL（dev 覆盖）→ window.location.origin。

**Status**: accepted（ADR-0007 的"直连回退"rung 被本 ADR 取代）

**Context**:

- 线上部署（2026-08-16 实测 hermes.kanochi.cn）：WEB_DEFAULT_GATEWAY_URL 已正确
  配置（/api/proxy/meta 返回 defaultGatewayUrl），但设置页 URL 锁死在出厂
  http://127.0.0.1:5180。根因链：生产构建把 proxyBaseUrl() 编译成 return null
  （VITE_PROXY_URL 构建期未定义 → 死代码消除）→ fetchProxyMeta() 短路不发请求
  （浏览器实测 /api/proxy/meta 0 请求）→ 预填永不触发。
- 同一根因的第二症状（探活假信号）：probeConnectionConfig 在代理基址为空时
  proxy ?? conn.url 直连 gateway——白名单/CORS 均以真实链路（代理）为准，直连
  结果必然失真：容器内网域名（如 http://hermes:9119）直连必失败（假红），
  CORS 开放的未白名单目标直连成功（假绿，绕过白名单语义）。
- ADR-0007 的基址解析原本就写了三 rung（VITE_PROXY_URL → 生产同源 origin → 直连
  回退），但第三 rung 与 ADR-0013 已明确的"直连模式否决"冲突，且 50568ff 以
  import.meta.env.PROD 分支打补丁后，同一 dist 的拓扑仍由构建模式推断——
  治标：只修了"生产构建 + 出厂注册表 + 同源托管"一个窄场景，探活/安全语义
  （白名单被直连绕过）未动。该 commit 已 revert（9d3177e）。

**Decision**:

- proxyBaseUrl(): string 恒非空：VITE_PROXY_URL（dev 注入）→ 否则
  window.location.origin。不再有 null、不再有构建模式分支——SPA 由代理托管
  是唯一受支持的部署拓扑（拓扑不变量），同源即代理。
- 删除全部直连回退与无代理短路：
  - gatewayBaseUrl() / wsUrlFor() 的 ?? conn.url 直连分支；
  - probeConnectionConfig() / probeAuthProviders() 的直连分支——探活恒经代理
    （X-Hermes-Target），白名单在探活即生效，探活结果 = 真实链路结果；
  - oauth.ts login/logout/session、proxySessionLogin/Logout/Status、
    fetchProxyMeta() 的 !proxy 短路。
- dev 拓扑统一：dev.mjs 恒起代理（pnpm dev = 原 dev:proxy 形态），删除
  vite 直连形态（dev:web、dev:proxy 脚本撤除）；mock CORS 直连通道随之退役。
- 旧镜像不兼容：v0.1.0 tag 之前的 bundle 无此修复且生产基址恒 null，部署必须
  重建镜像（本 ADR 落地前线上即此状态）。

**Considered Options**:

- 保留直连回退 + import.meta.env.PROD 分支（= 已撤掉的 50568ff）：拓扑仍由
  构建模式推断，探活仍可能直连（假信号），dev 直连形态遗留——否决。
- 代理 serve 时向 index.html 注入运行时 boot 配置（proxyBaseUrl + defaultGatewayUrl）：
  对子路径/反代前缀更鲁棒，但当前唯一受支持拓扑就是同源托管，注入机制带来
  HTML 改写与缓存复杂度而无实际收益——不做，留作未来子路径支持时的方案。
- 保持 null 并让调用方各自回退（原状）：症状持续（meta 0 请求、探活失真、
  预填不生效）——否决。

**Consequences**:

- 生产 bundle 不再含"直连"路径：/api/proxy/meta 必有请求，默认 gateway URL
  预填在生产/容器/任何同源托管下开箱即用；探活、OAuth、密码会话、WS 全部
  与真实链路一致（白名单即时生效，无假绿）。
- 不受支持的拓扑显式化：vite preview 或任意非代理静态托管下 /api/* 会打到
  静态服务器本身（SPA fallback）——代理托管是唯一形态，README 已注明。
- dev 需要 deno 在 PATH（代理恒起）；mock 的 M1 直连 CORS 面不再被使用。
- ADR-0007 正文保留原样（不可变历史），仅 Status 标注直连回退段被本 ADR 取代。
