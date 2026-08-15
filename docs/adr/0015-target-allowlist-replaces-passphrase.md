# 0015 — target 白名单取代代理 passphrase

代理访问控制从"共享口令"（PROXY_PASSPHRASE / X-Hermes-Proxy-Passphrase）改为
"出站目标白名单"（WEB_PROXY_ALLOWED_TARGETS）。浏览器 SPA 零改动，公网部署配置
白名单即可防开放转发/SSRF。

**Status**: accepted

**Context**:

- 旧门禁（ADR-0007 访问控制段）：PROXY_PASSPHRASE 配置后，转发面校验
  X-Hermes-Proxy-Passphrase 头。但浏览器侧从未实现发送该头的链路：
  /api/proxy/meta 只下发 requiresPassphrase 标志，SPA 没有输入/存储/携带
  该口令的任何代码 → 公网开启后浏览器转发一律 401，门禁实际效果是
  "挡住一切"，而非"让授权用户进门"。
- 补前端链路（解锁屏输入 + localStorage + 请求头）会把共享口令扩散到每个
  终端用户（泄露面 = 知道口令的人数），且浏览器 WebSocket API 无法携带
  自定义头，WS 面只能走 query（进代理日志），与 ADR-0002 凭证最小化方向相悖。
- 白名单限制的是代理的**出站目标集合**而非请求者身份：不要求浏览器任何
  配合（零协议改动），防开放转发/SSRF 的效果等同且更硬——攻击者即使持有
  页面，也只能转发到名单内的 gateway。
- 代理的服务端出站面共四处：REST 转发（X-Hermes-Target 头）、WS 中继
  （?target= query）、OAuth start（body target，其 code 交换在 callback
  时向该 target 发 POST）、密码会话 login（body target → 转发
  /auth/password-login）。防 SSRF 必须四面包裹，缺一处即后门。

**Decision**:

- 删除 passphrase 全链路：PROXY_PASSPHRASE / X-Hermes-Proxy-Passphrase /
  safeEqual（relay.ts）/ requiresPassphrase（meta 字段与前端类型）/
  CORS 与 STRIP_HEADERS 清单中的该头 / compose 强校验与文档术语。
- 新增 WEB_PROXY_ALLOWED_TARGETS（逗号分隔 gateway base URL；空 = 不限制 =
  本地 dev 默认）：代理只向名单内目标发起出站请求。匹配在 normalizeTarget
  之后按 origin（scheme://host[:port]，缺省端口归一 80/443）精确比较，
  支持 `*.` 子域通配（`https://*.example.com` 匹配子域、不匹配 apex）；
  非法条目启动即抛错（配置错误要可见，不静默）。
- 拒绝语义：REST / WS / OAuth start / 密码 login 统一
  403 {"detail":"target not allowed"}（WS 在 upgrade 前拒绝）。
- /api/proxy/meta 追加下发 allowedTargets: string[]（空数组 = 不限）；
  前端暂不消费（未来可做连接表单预填提示）。
- 原 passphrase 保护的破坏性面（OAuth start/logout、密码 login/logout）
  不再需要口令：logout 只清持 cookie 者自己的会话（无 cookie 无效果）；
  start 不产生出站请求，其后续 code 交换面由白名单限定；
  callback / session / session-status 维持免检（只交换内存已登记 state /
  回显非敏感布尔）。

**Considered Options**:

- 前端解锁屏 + localStorage 携带口令（选白名单的否决项）：共享口令扩散到
  全部终端用户，XSS 可见面 +1，WS 只能走 query，且 SPA 改动 + 新 UI。
- 反向代理/VPN 认证：可行且适合组织部署，但需要额外部署组件；白名单是
  代理内建的最小可行门禁，可与之叠加。
- 部署者下发口令由 SPA 自动携带：口令对任何访问者公开（devtools 可读），
  门禁只防扫描器，不满足防开放转发威胁模型 → 否决。

**Consequences**:

- 浏览器零改动可用；公网部署只需配 WEB_PROXY_ALLOWED_TARGETS（compose env），
  切换 gateway 需改名单重启（无状态代理重启成本低，与改 env 同级）。
- "手填 URL 连任意 gateway"能力在白名单配置下受限——这是部署者主动选择；
  不配置白名单时行为与旧版无 passphrase 时完全一致。
- 匹配粒度为 origin：同 host 下按路径区分的多 gateway 无法用白名单区分
  （路径被忽略，可接受并写入部署文档）。
- 删除 safeEqual（恒时比较）不再需要——白名单匹配无秘密比对。
- 文档处理：ADR-0002/0007/0008/0013 正文保留原样（不可变历史），仅
  Status 标注相应部分被本 ADR 取代；CONTEXT.md Passphrase 词条替换为
  Target allowlist。
