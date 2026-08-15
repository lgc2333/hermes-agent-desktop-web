import path from 'node:path'
import { defineConfig } from 'vitest/config'

// Apps/web 桥面测试：registry / gateway / adapter 的纯逻辑与形状。
// 别名与 apps/web/vite.config.ts 保持一致（测试大多只 import type 走 vendor，
// 运行时并不加载 vendor 模块）。
const root = path.resolve(import.meta.dirname, '../..')

export default defineConfig({
  resolve: {
    alias: {
      '@': path.join(root, 'vendor', 'hermes-desktop', 'src'),
      '@hermes/shared': path.join(root, 'vendor', 'hermes-shared', 'src'),
      '@hermes/plugin-sdk': path.join(
        root,
        'vendor',
        'hermes-desktop',
        'src',
        'sdk',
        'index.ts',
      ),
      '@/debug/dev-only': path.join(
        root,
        'vendor',
        'hermes-desktop',
        'src',
        'debug',
        'dev-only.noop.ts',
      ),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    globals: true,
    testTimeout: 10_000,
  },
})
