/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MOCK_GATEWAY_WS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
