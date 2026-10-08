/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MOCK_GATEWAY_WS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// 构建期注入（vite/vitest define）：<项目版本>+<上游版本 | 7 位短 hash>。
declare const __HERMES_WEB_VERSION__: string
