# 0028 — Web 端链接默认走外部浏览器（默认开启 alwaysExternalLinks + 修 noopener 误报）

桌面渲染层的链接路由默认把网页链接开进**内置预览面板**，只有 ⌘/Ctrl 点击或设置项
「始终在外部浏览器中打开链接」（`$alwaysExternalLinks`）才交给系统浏览器。Web 端口的
内置预览面板是**结构性死面板**（面板渲染 Electron `<webview>`，Web 桥 preview 面属
denied 空实现）→ 该默认在 Web 是无出口的死默认。本 ADR 把 Web 构建下的默认翻到外部
浏览器，并修掉外开实现里的一处**常态误报**（`noopener` 使 `window.open` 恒返回 null，
被桥判成"弹窗被拦"，每次成功打开都弹「无法打开此链接」）。

**Status**: accepted

**Context**:

- 链接落点的唯一决策点是 vendor `lib/external-link.tsx#openLink`（`ExternalLink` 的
  点击处理器与终端链接处理器是仅有的两个调用点）：
  `if (options.native || $alwaysExternalLinks.get() || isConnectorAuthorizationLink(…) ||
hudForcesNativeLinks() || !http(s)) → 系统浏览器，否则 → 内置预览`。
  **设置项短路在修饰键判定之前**，所以开启该设置 = 一切链接点击一律外部（含 ⌘/Ctrl、
  中键、终端链接）。
- Web 端的内置预览必然空白：`app/chat/right-rail/preview-pane.tsx` 渲染 Electron 专属
  `<webview>`，浏览器不认该元素；preview 桥面（`setPreviewGuestHidden` 等）归 denied
  （ADR-0010/0027）。即"默认开内置预览"在 Web 是打开一个永远空白的面板。
- 外开实现的误报（实测，Chromium 154/155 + 真实手势点击）：

  | 形态                                                                                        | 返回值        | 目标站收到的 Referer |
  | ------------------------------------------------------------------------------------------- | ------------- | -------------------- |
  | `window.open(url,'_blank','noopener,noreferrer')`（原实现）                                 | **恒 `null`** | 无                   |
  | `window.open(url,'_blank')` 后 `win.opener=null`                                            | handle        | 带来源页             |
  | `window.open('about:blank')` → `opener=null` → 空文档注入 `rel="noreferrer"` 链接并 click() | handle        | **无**               |

  桥的 `openAndReport` 把 `null` 当"被弹窗拦截"广播 `onExternalOpenFailed`
  （ADR-0027 的 C 组面），渲染层随即弹 `externalOpenFailed` 对话框——**链接其实已经开了**。
  桌面端该对话框是 `shell.openExternal` 真失败（如 Linux 没注册 https handler）的兜底，
  Web 下退化成常态误报。

**Decision**:

1. **默认落点翻到外部浏览器**：Web 构建（`VITE_WEB_BUILD === '1'`，vite define 注入，
   同 ADR-0019 手法）下把 vendor `store/external-links.ts` 的默认值改为 `true`。
   依据：该设置本就在 `openLink` 短路判定中先于修饰键 → 开启即"一律外部"，**不改路由
   逻辑、不引入 Web 专属语义分叉**，桌面构建行为不变。用户仍可在设置页关掉（关掉即回到
   上游语义）。
2. **外开实现改为"可判拦截 + 不带 Referer"**（`apps/web/src/bridge/browser.ts`）：
   `window.open('about:blank','_blank')` 拿 handle（`null` 才判被拦并广播失败）→
   `win.opener = null` → 在空文档注入 `rel="noreferrer"` 锚点并 `click()`（同窗口导航）。
   实测同时保住两条语义：`null` 恢复为真"被拦截"信号；目标站收不到 Referer（对齐桌面
   `shell.openExternal` 不带 Referer）。
3. vendor 改动登记 `PATCHES.md` §4；设置行保持可见可关，不用 `web.css` 隐藏。

**Considered Options**:

- **反转修饰键语义**（普通点击→外部、⌘/Ctrl→内置预览）：更贴桌面手势记忆，但要改
  `external-link.tsx` 路由 + 终端 `links.ts` 的手势模型（终端面手势模型不同，需另一套
  取反），而内置预览在 Web 是死面板——为一个死面板保留点击入口不值得，弃。
- **Web 入口 boot 时 `$alwaysExternalLinks.set(true)`**（vendor 零改动）：会覆盖用户
  显式选择（每次载入重置），且要伸手到 vendor 的 localStorage 键，弃。
- **保留 `noopener,noreferrer` 并放弃拦截检测**（不再广播失败）：最省事，但弹窗被拦时
  用户只看到浏览器自带提示，拿不到"复制链接"兜底，弃。
- **`rel="noreferrer"` 合成 `<a>` 点击开新标签**：无 handle，无法判拦截，弃。
- **用 `about:blank` 文档上的 `<meta name="referrer" content="no-referrer">` 抑制
  Referer**：实测无效（该导航仍带来源页 Referer），弃。
- **隐藏设置行**（`web.css` 先例）：该行无 `settingElementId` id
  （`config-settings.tsx:481`），需补 vendor id 才能精确隐藏；且"关掉设置回到上游语义"
  本身是合理的用户选择，弃。

**Consequences**:

- Web 端一切链接点击（聊天 markdown、终端输出、其余 `ExternalLink` 面）默认开系统浏览器
  新标签；⌘/Ctrl 与中键不再改变落点（中键与 ⌘/Ctrl 仍是外部）。
- 内置预览面板在 Web 仍可从右键菜单「在应用内浏览器中打开」进入，**仍是空白**（denied
  面，本 ADR 不修）。若将来用 iframe 之类实现预览，本决策依然成立（默认仍是外部）。
- 外开不再误报；只有弹窗真被拦时才弹兜底对话框（带复制链接）。
- 设置页「始终在外部浏览器中打开链接」在 Web 显示为开启；用户关掉后回到上游语义
  （普通点击开空白预览）——有意保留，不做隐藏。
- vendor 原位改动 +1 文件（`store/external-links.ts`），已登记 PATCHES.md；同步时若上游
  改该 store 的默认值/持久化，按"Web 构建默认 true、桌面默认 false"语义恢复。
