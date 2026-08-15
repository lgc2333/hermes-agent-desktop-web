# 0011 — Web 端 Ctrl+F 回归浏览器原生查找对话框（find 面维持 denied）

Web 上 Ctrl+F 目前两头落空：vendor find-bar 打开后桥面 findInPage 为
denied（0/0 无功能），且 vendor keybind 对 Ctrl+F 执行 preventDefault，
浏览器原生查找对话框也被掐死。决策：不实现自研 find，让 Ctrl+F 直通
浏览器原生查找。

**Status**: accepted

**Context**:

- 桌面端查找链路（已核实）：Ctrl+F → use-keybinds 'view.findInPage' →
  openFindBar()（find-bar 组件 + "x/y" 计数）→ hermesDesktop.findInPage
  → Electron webContents.findInPage（Chromium 原生查找：全页 DOM、黄色
  高亮、异步 found-in-page 回调驱动计数）；渲染层 store/find-in-page.ts
  零自研搜索，纯转发桥成员。
- use-keybinds.ts 的 keybind dispatch 对命中的 combo 执行 preventDefault
  （多处于 300-408 行）——Web 上 Ctrl+F 被 vendor 拦截后既不触发原生
  查找，find-bar 又因桥面 denied 而无功能。
- 三个候选方案：a) bridge 自研（window.find 定位 + TreeWalker 计数 +
  自定义 CSS 高亮）——与浏览器原生查找功能重复且更弱；b) 维持现状——
  Ctrl+F 完全无效；c) 回归浏览器原生对话框——零实现成本，高亮/计数/
  跨平台一致性全由浏览器提供。

**Decision**:

- **findInPage / stopFindInPage / onFoundInPage 维持 denied**（不实现
  window.find 自研，ADR-0010 B 组该条目就此关闭）。
- **Web 入口拦截 vendor keybind**：在 window capture 阶段注册监听
  （早于 vendor use-keybinds 的 capture listener），命中 ⌘F/Ctrl+F 时
  调用 stopImmediatePropagation()——vendor 的 dispatch 收不到事件，
  不会 preventDefault，浏览器原生查找对话框自然接管。不调
  preventDefault。
- find-bar 组件永不激活（$findInPage 恒 inactive），其专属 combo
  （⌘G/⌘⇧G/Escape）不产生归属冲突。
- vendor 零改动（不改 use-keybinds / find-bar / store），PATCHES.md
  无需登记。

**Consequences**:

- 浏览器原生查找覆盖整个页面 DOM，与桌面 webContents.findInPage 的
  搜索范围一致；体验（高亮 + 计数 + Enter/Shift+Enter）由浏览器提供，
  与 Chrome/其他 Hermes 页面行为统一。
- 已知代价：移动端/触屏无 Ctrl+F 快捷键，页面查找入口缺失（桌面端
  的 find-bar 在 Web 上不显示）；若后续需要，可另行评估移动端查找
  入口，不影响本决策。
- 实现落点：apps/web/src（main.tsx 桥安装处或 bridge/ 内独立
  keybind 拦截模块），注册时机必须早于 vendor use-keybinds 的
  listener（桥安装先于渲染树挂载，满足）。
