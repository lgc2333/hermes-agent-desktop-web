# 0002 — 凭证跟浏览器，代理无状态零落盘

WebUI 的代理可能部署在公网；最初设计凭证存代理侧（加密落盘）。决定：连接定义与凭证全部存浏览器（localStorage/IndexedDB，按连接 id），代理无状态、不落盘任何凭证，仅做同源转发；公网部署用 passphrase 防开放转发。

**Status**: accepted

**Considered Options**: 凭证存代理（PROXY_SECRET 加密落盘，本 ADR 取代）；凭证走代理 httpOnly cookie（OAuth 模式可后补）

**Consequences**: 代理被攻破不泄漏任何 gateway 凭证，每台设备各自持有凭证；代价是换设备/浏览器需重新填 token，且 localStorage 凭证对 XSS 可见——用 CSP + 无第三方脚本 + OAuth 短时 token/轮换 refresh 对冲。