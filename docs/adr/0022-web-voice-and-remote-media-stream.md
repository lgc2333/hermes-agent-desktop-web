# 0022 — Web 语音 + 远程媒体流：streamMediaUrl 能力与代理媒体路由

Web 端启用语音（流式 TTS + 听写 + 自动朗读）与网关音频/视频附件播放。上游桌面
remote 模式原生支持语音与媒体播放，vendor 渲染层整套语音栈（recorder / conversation /
voice-playback / VAD barge-in）原样可用；`hermes-media://` 媒体方案在桌面由 **Electron
主进程**处理（`protocol.registerSchemesAsPrivileged` + `protocol.handle`，
`electron/media-protocol.ts` 里主进程 net.fetch 注入鉴权、转发 Range 头、把 206 流回
渲染层媒体元素）。**浏览器没有 main 进程等价物**——媒体元素请求发不了自定义鉴权头，
也注册不了带 `standard/stream` 特权的自定义 scheme。因此需要一个忠实对应方案。

**Status**: accepted

## Context

- **语音链路**（已在 vendor，非 Web 新增）：
  - 听写 STT：`POST /api/audio/transcribe`（mic → Blob → data_url），走
    `window.hermesDesktop.api()` → 桥 `webApi` 通用 `/api/*` 透传 → 代理 REST 转发。
  - 朗读/一次性 TTS：`POST /api/audio/speak` → data_url → `Audio`，同 REST 链路。
  - 流式 TTS：`voice-playback.startSpeechStream` 在 Web 里 `resolveGatewayWsUrl` 拿到
    `ws://proxy/api/ws?...`，再把 pathname 换成 `/api/audio/speak-stream`。
  - 这两类 REST 经现成代理 REST 中继**已经能跑**；缺口在：① 麦克风被 Web 布尔门关着；
    ② 流式 `speak-stream` 的 WS 被代理 `upstreamWsUrl` **硬编码拨到 `<target>/api/ws`、
    无视客户端 pathname** 而接不上；③ 媒体协议在浏览器不可用。
- **媒体附件播放**：`markdown-text.tsx` 用 `<audio>/<video> src=resolveMediaPlaybackSrc(path)>
，remote 模式产 `hermes-media://remote/<file>?profile=..`。Electron 主进程按
hostname（`remote`/`stream`）+ pathname（解码出的文件路径）+ `?profile=` 解析，只放行
流式扩展名（415）、只转发白名单头（`accept/if-modified-since/if-none-match/if-range/range`），
然后 OAuth 走 Bearer/cookie partition、token 走 `X-Hermes-Session-Token`，命中
`baseUrl/api/files/stream`（Range 端点）。浏览器无法复制这套主进程取数逻辑。
- **备选方案**：
  a) **DOM `src` 原型补丁**（零 vendor）：补 `HTMLMediaElement.prototype.src` 把
  `hermes-media://remote/..` 改写成代理媒体 URL。不碰 vendor，但要动内置原型、
  无类型安全；
  b) **`streamMediaUrl` 能力**（本 ADR，vendor 触碰）：给桥加一个类型化能力
  `streamMediaUrl(path) → Promise<null|string>`，`media.ts` 委托它产出"可播 URL"，
  各环境自报：Electron 返回原 `hermes-media://`，Web 返回同源代理流 URL。类型安全、
  符合"能力即接口"的桥哲学、与 `media.ts` 已有的 `readFileDataUrl` 委托先例一致。
  - 两条路都**必须**加代理 `media-stream` 路由——它是浏览器里"main 进程取数"的唯一等价物
    （媒体元素 GET 带不了 `X-Hermes-Target` 头，鉴权只能由代理代注）。选 b）。
- **钱**：Web 移植不产生任何新增供应商计费——STT/TTS 在 gateway 侧按用户自己的 provider
  key 计费（桌面能说语音即已是这笔账）。工程成本在浏览器 autoplay/permission 等进场细节，
  非结构性。

## Decision

1. **vendor 能力 `streamMediaUrl`**（最小、带回退）：
   - `global.d.ts` 新增 `streamMediaUrl?: (path: string) => Promise<null | string>`。
   - `lib/media.ts` 的 `resolveMediaPlaybackSrc`：audio/video 时若桥存在 `streamMediaUrl`
     则委托，`null`/缺省回退到现有 `hermes-media://` scheme。Electron 主进程不实现该表
     面 → 桌面行为完全不变；Web 桥实现 → 返回代理流 URL。
2. **代理 `/api/proxy/media-stream`**（GET，query：`target path profile [token]`）：
   - `normalizeTarget` + 白名单校验（ADR-0015 同一门）；
   - 鉴权解析同现役：OAuth 会话 `bearerFor` / 密码会话 `cookieFor`，否则 `token` query →
     `X-Hermes-Session-Token`；
   - 剥掉代理私有参数（`target`/`token`），只把 `path`/`profile` 转发到
     `target/api/files/stream`；复用 `STRIP_HEADERS`/`collectSetCookies`，透传浏览器
     `Range`/`If-Range`/`Accept`，流式回传并保留 206/`Content-Range`（`relayRest`
     已验证支持）。媒体元素同源 GET → OAuth/密码 cookie 自动带上，token 走 query。
3. **代理 WS pathname 透传**：`upstreamWsUrl` 不再硬编码 `/api/ws`，改用客户端请求的
   pathname（默认 `/api/ws` 不变），使 `voice-playback` 的 `/api/audio/speak-stream`
   能到达网关（query 仍剔除代理私有 `target` 参数，鉴权 ticket/token 原样保留）。
4. **语音门放行**（Web 侧，非结构性）：
   - `requestMicrophoneAccess` 从 denied 切到**浏览器等价**（返回 `true`，getUserMedia
     原生支持）；
   - vendor `chat/index.tsx` 的 `voice.enabled` 从 Web 门 `false` 改回 `true`（顺带清掉
     同位残留的 `<<<<<<< HEAD` merge 冲突标记）。
5. **无新凭证落盘**：token 只在浏览器注册表；OAuth/cookie 只在代理内存；遵 ADR-0002/0013。

## Consequences

- vendor 原位改动三处：`global.d.ts`（新增表面）、`lib/media.ts`（委托 + 回退）、
  `app/chat/index.tsx`（布尔门 + 清冲突），一律登记 PATCHES.md §4（含同步注意）。
- 桌面零回归：Electron 主进程未实现 `streamMediaUrl` → 走回原 scheme；上游若实现该表面，
  桌面可平滑迁移到能力，Web 无需再改。
- 新增测试面：桥层 `streamMediaUrl` vitest；代理 `media-stream` + WS pathname 透传
  deno test；流式/听写在 proxy 模式下端到端通。
- 边界：`hermes-media://stream/`（本地文件分支）在 Web 无本地磁盘，不适用；音频附件
  播放范围纳入本次，与 TTS 回复朗读（Web Audio PCM / data_url）互不影响。
