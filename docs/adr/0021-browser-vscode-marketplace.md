# 0021 — 主题供应商：浏览器直连 VS Code Marketplace

设置页「Appearance → Theme」的主题搜索（本地主题过滤 + VS Code Marketplace
实时搜索/安装）在桌面端靠 Electron 主进程跑（`electron/vscode-marketplace.ts`，
node:https 打官方 gallery 接口 + node:zlib 解 .vsix）。Web 端口桥层当时把
`themes.searchMarketplace` / `fetchMarketplace` 做成 denied 空实现，导致搜索框
出不了结果、安装不可用。本 ADR 决定 Web 端改用浏览器 fetch 直连官方接口。

**Status**: accepted

**Context**:

- 设置页主题搜索分两块：① 过滤已装主题（availableThemes 本地过滤，本来就
  能用）；② Marketplace 搜索 + 安装（走 `window.hermesDesktop.themes.*`，
  Web 版恒空 → 搜索无结果、安装抛 UNAVAILABLE）。用户要求把②做起来。
- 浏览器直连是否可行取决于官方接口的 CORS 放行情况，实测：
  - Gallery ExtensionQuery：`POST https://marketplace.visualstudio.com/_apis/
public/gallery/extensionquery` → `Access-Control-Allow-Origin: *`，
    预检放行 `content-type`（实测 200）。
  - VSIX CDN：`*.gallerycdn.vsassets.io` → `Allow-Origin: *`（实测）。
  - 因此**无需代理转发**，浏览器直接 fetch 即可。
- 备选方案对比：
  a) **浏览器直连官方接口**（本 ADR）：零代理改动、零凭证（公共 API，
  符合 ADR-0002 只存连接凭证、代理零落盘）；解压复用桌面同一套转化
  （渲染层 install.ts → buildThemeFromMarketplace），只移植"取包"层；
  b) 走代理转发：代理是多租户/目标导向转发器，为公共第三方 API 加一条
  浏览器同源中转通道，且代理无状态、需临时落凭据 curl 才有意义——造
  轮子、违背 ADR-0003，弃；
  c) 维持 denied：功能永远不可用，弃（用户已明确要做）。
- 安全边界与桌面一致：**永不执行扩展代码**，只读 package.json + 引用的
  `*.json` 主题文件，原文交回渲染层转换（vscode.ts convertVideoColorTheme
  不执行任何代码）。

**Decision**:

- 新增 `apps/web/src/bridge/vscode-marketplace.ts`：`electron/vscode-marketplace.ts`
  的浏览器移植（fetch + `DecompressionStream('deflate-raw')`，零解压依赖）：
  - `searchMarketplaceThemes(query)` → 卡片数组（同桌面语义：Themes 类别、
    过滤图标包、空查询返回安装量最高）；
  - `fetchMarketplaceThemes(id)` → 解析扩展 + 下载最新 VSIX + 提取贡献的主题
    JSON 原文（`DesktopMarketplaceThemeResult`）；
  - `.vsix` 是普通 zip，借最小 zip 读取器按需解压（method 0 stored / 8 deflate）。
- `BrowserAdapter.themes` 暴露这两个方法（类 1 浏览器等价）；`adapter.ts`
  把 `themes` 从 `denied.themes` 切到 `browser.themes`。`denied.ts` 的布尔门
  实现保留，便于隔离测试。
- 转换/持久化仍走渲染层现有链路（`installVscodeThemeFromMarketplace` →
  `buildThemeFromMarketplace` → `installUserTheme`），与桌面同一份代码，无 vendor
  改动。
- 网络边界即浏览器 CORS 面：若官方接口未来收紧 CORS，搜索/安装会静默降级
  （状态栏照常），不引入代理改动。

**Consequences**:

- 设置页主题搜索与安装开箱可用（需浏览器可直连外网；与 gateway 连通性无关）。
- 零代理改动、零凭证进出代理；新增模块有 vitest 单测（搜索映射 + zip 提取 +
  含 deflate-raw 解压路径），`pnpm --filter @hermes-web/web test` + typecheck 全绿。
- 桌面 API 形态（node:https + node:zlib）与浏览器实现并存，互不影响。
