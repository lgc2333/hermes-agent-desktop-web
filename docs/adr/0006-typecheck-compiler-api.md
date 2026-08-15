# 0006 — 真实 typecheck 走编译器 API（TS 6.0 + baseUrl 兼容策略）

TS 6.0 下 `tsc --noEmit` CLI 对带 `baseUrl` 的 tsconfig 报 TS5101 配置错误，**报完即提前退出、不检查任何文件**（M0 起 typecheck 从未真正跑过，属于假绿）。CLI 无开关可绕过：删 baseUrl 或加 `ignoreDeprecations` 都会切到 TS6 新 paths 模式，Windows 下产生模块身份重复（`${configDir}` 也不行）。

**Status**: accepted

**Considered Options**:
- 删 baseUrl 迁移到 TS6 paths 新语法：最"正统"，但 Windows 下模块身份重复，vendor 源码（依赖 `@/*`、`@hermes/shared/*` 别名）解析出现双实例伪错
- CLI + 忽略 TS5101 错误码：`tsc` 报完配置错误就退出，无文件可检查，无法实现
- 编译器 API in-process（选定）：`ts.parseJsonConfigFileContent` + `ts.createProgram` + `getPreEmitDiagnostics`，仅过滤 TS5101；保持 baseUrl + 旧 paths 语义，结果即真实诊断（M1 基线：0 错）

**Consequences**: `pnpm --filter @hermes-web/web typecheck` 走 `apps/web/scripts/typecheck.mjs`（node 驱动，非 tsc CLI）；TS 升级后若 TS5101 消失，脚本内的过滤逻辑可移除，但 baseUrl 的保留策略不变。另：`apps/web/tsconfig.json` paths 把 react/react-dom/jsx-runtime 直接钉到 root `@types/*/index.d.ts` 文件，解决 pnpm 下 apps/web 与 root 双份 @types/react 的 "Two different types" 伪错（jsx-runtime 从不同根解析；映射 .d.ts 文件而非包目录，避免绕过 @types 查找产生 2990 个 "Could not find declaration file"）。
