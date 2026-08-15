/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MOCK_GATEWAY_WS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// 构建期注入（vite/vitest define，ADR-0014）：<桌面版本>+web.<项目版本>。
declare const __HERMES_WEB_VERSION__: string
