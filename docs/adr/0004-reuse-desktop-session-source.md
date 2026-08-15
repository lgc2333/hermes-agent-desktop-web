# 0004 — 会话来源复用 'desktop'

`session.create` 携带的 source 标签驱动后端工具集下发（desktop_ui 等）；Web 客户端需要 GUI 级工具集。决定：复用 `'desktop'` 值，不新增 `'web'` 标签。

**Status**: accepted

**Considered Options**: 新增 'web' 标签（语义更干净，但引入 tui_gateway/toolsets 的 Python patch 与同步负担）

**Consequences**: Web 客户端在后端工具集语义上被视作桌面表面，零 Python patch，符合"只依赖 gateway/dashboard"边界；若将来需要区分 Web 特有能力，再引入 'web' 标签（改动面可控）。
