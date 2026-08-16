# 0019 — findInPage 热键在 Web 构建下失效（vendor dispatch 短路）

ADR-0011 决定 Web 上 Ctrl+F 回归浏览器原生查找、find 桥面维持 denied，
原定在 Web 入口注册 capture 拦截器"罩住" vendor keybind；实现时改为
vendor 源头处理：Web 构建下 use-keybinds 不注册 view.findInPage 的
handler，组合键命中走 dispatch 的"无 handler → return"（不 preventDefault、
不开 find-bar），浏览器原生查找自然接管。

**Status**: accepted

**Context**:

- ADR-0011 原实现路径是"对抗式罩层"：apps/web 在 window capture 阶段先注册
  listener，命中 `view.findInPage` 当前绑定 combo 时 `stopImmediatePropagation()`
  阻断 vendor dispatch。两个真实缺陷：
  1. **重绑语义脆弱**：用户可在 keybinds 面板重绑 findInPage（store/keybinds.ts，
     localStorage 'hermes.desktop.keybinds'），拦截器须动态订阅 `$comboIndex`
     才能跟随；定义处与 vendor dispatch 的数据源（comboFromEvent + 规范化）
     必须保持一致，否则重绑后漏拦或误拦。
  2. **时序耦合**：拦截器必须早于 vendor 的 React effect 挂载（当前靠
     installWebBridge 的 ESM import 顺序保证）；vendor 若调整键监听的
     挂载点/阶段，罩层静默失效。
- 而 vendor dispatch 已有的语义恰好能零成本表达"热键无效"：handler 缺失时
  `if (!handler) return`（use-keybinds.ts），不 preventDefault 不执行动作。
  桌面/Web 共用同一份渲染层源码，平台差异用 vite define 注入的编译期常量
  `import.meta.env.VITE_WEB_BUILD`（桌面构建 undefined，行为不变）。

**Decision**:

- vendor `use-keybinds.ts`：`'view.findInPage': openFindBar` 改为条件展开，
  `import.meta.env.VITE_WEB_BUILD === '1'` 时不注册该 handler（热键失效）。
  重绑/多绑定语义自动正确：任何 combo 命中 view.findInPage 都无效；
  mod+f 被改绑其他动作时照常执行。
- `apps/web/vite.config.ts` define 注入 `import.meta.env.VITE_WEB_BUILD='1'`。
- findInPage / stopFindInPage / onFoundInPage 桥面维持 denied（ADR-0011
  目标不变）；find-bar 组件因热键永不触发而恒不激活。
- vendor 改动登记 PATCHES.md §4。

**Considered Options**:

- Web 入口 capture 拦截器（ADR-0011 原案）：vendor 零改动，但对抗式罩层 +
  重绑动态订阅 + 注册时序耦合（见 Context），弃。
- actions.ts 把 `view.findInPage` 默认绑定置空：同一份源码桌面端仍用 ⌘F 开
  find-bar，会连桌面一起改坏，不可行。
- 桥面自研 find（window.find 定位 + 自定义高亮）：与浏览器原生查找功能
  重复且更弱（window.find 非标准、不弹 UI、跨浏览器行为不一致），ADR-0010
  已否决，不重启。

**Consequences**:

- Web 上 Ctrl+F（及任何重绑给 findInPage 的 combo）不再打开 find-bar、
  不 preventDefault，浏览器原生查找（高亮 + 计数 + Enter 步进）接管，
  与桌面 webContents.findInPage 的搜索范围一致。
- 移动端/触屏无快捷键，页面查找入口缺失的已知代价不变（ADR-0011）。
- vendor 原位改动 +1 文件（use-keybinds.ts），已登记 PATCHES.md；同步时若
  上游重构 handlersRef 或 findInPage 接线，按"Web 构建不注册该 handler"
  语义恢复。