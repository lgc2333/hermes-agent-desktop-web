/**
 * Web boolean gates — M1 导航布尔门清单 (PLAN §1 Q9 / §5).
 *
 * 原则：用字面 `false` 关闭功能入口而保留其代码（dormant），刻意不做可配置
 * 开关系统（CONTEXT.md "布尔门"）。vendor 无法 import 本文件（subtree 独立），
 * 因此本清单是**语义权威**，vendor 侧的入口以字面常量镜像（PATCHES.md §4 登记）。
 *
 * 三层防护（从外到内）：
 *   1. 导航/路由入口（vendor 原位 `const GATE_* = false` 或条件展开）——用户看不到入口；
 *   2. 本清单 —— 文档化哪些功能被关闭、为什么；
 *   3. bridge 的 denied 实现（denied.ts 读取本清单）—— 即使绕过入口直调
 *      window.hermesDesktop 也拿到安全空实现（可选链 + 合法返回形状）。
 *
 * 标注 "M2+" 的项在 M1 保持入口可见但能力被 bridge 拒绝（降级空态），
 * 由后续里程碑决定是否关入口。
 */
export const gates = {
  /** Artifacts 页（文件浏览产物页）。入口：侧边栏 nav 行 + workspace 路由。 */
  artifacts: false,
  /** Agents 管理 overlay。入口：状态栏 Agents 项（M1 关闭；直开 /agents 路由为空）。 */
  agents: false,
  /** Kanban 插件页。上游 `defaultEnabled: false`（Settings → Plugins 手动启用），
   *  默认即 dormant，无需额外门。 */
  kanban: false,
  /** 语音（dictation / 语音会话）。composer 麦克风 pill 关闭；bridge 拒绝 mic。 */
  voice: false,
  /** 终端（本地 PTY）。入口保持可见但 bridge.terminal.* 全拒绝 → 空态。M2 评估关入口。 */
  terminal: false,
  /** 文件浏览（右栏文件树 / 预览）。bridge 文件面全拒绝 → 空态。M2 评估关入口。 */
  files: false,
  /** 预览 rail / preview 面板。bridge 拒绝 preview/watch。 */
  preview: false,
  /** 原生窗口（多窗口 / HUD / pet / quick entry / wake indicator）。bridge 全拒绝。 */
  windows: false,
  /** git 工作树 / review 面板。bridge git.* 全拒绝。 */
  git: false,
  /** 主题市场（VS Code Marketplace）。bridge themes.marketplace 拒绝。 */
  themesMarketplace: false,
  /** 系统更新 / 卸载。bridge updates/uninstall 拒绝。 */
  updates: false,
  /** 本地后端安装（bootstrap）。bridge bootstrap 拒绝。 */
  bootstrap: false,
  /** Hermes Cloud 门户。bridge cloud.* 拒绝。 */
  cloud: false,
  /** SSH 连接。bridge ssh 拒绝。 */
  ssh: false,
  /** v2 连接注册表 UI（M2 起做）。bridge connections.* 提供最小本地注册表。 */
  connectionsRegistry: false,
  /** 页内查找（Cmd+F find-in-page，Electron webContents）。bridge 拒绝。 */
  findInPage: false,
  /** 窗口下方窗口元数据（read_window_below 工具）。bridge 拒绝。 */
  readWindowBelow: false,
  /** 本地文件 data-URL 读取上限设置。bridge 拒绝。 */
  dataUrlRead: false
} as const

export type GateName = keyof typeof gates

/** 供 denied.ts 等桥实现读取：某能力是否被拒绝。 */
export function isDenied(name: GateName): boolean {
  return gates[name] === false
}
