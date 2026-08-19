import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

import { webVersionString } from './scripts/build-version.mjs'

// The web app builds the vendored desktop renderer directly (no fork):
//   vendor/hermes-desktop/src  → aliased as '@'
//   vendor/hermes-shared/src   → aliased as '@hermes/shared'
//
// NOTE: this file is intentionally NOT a symlink to the vendor's
// vite.config.ts — that one uses __dirname relative to the desktop package
// layout (../shared, ./src/sdk) and relies on Vite's legacy config loader.
// Ours points at the vendor paths absolutely, so a subtree pull needs no
// reconciliation here beyond the two path constants below.
const root = path.resolve(import.meta.dirname, '../..')
const vendorDesktop = path.join(root, 'vendor', 'hermes-desktop')
const vendorShared = path.join(root, 'vendor', 'hermes-shared')

function real(p: string): string | null {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

const fsAllow = [
  ...new Set(
    [root, real(path.join(root, 'node_modules'))].filter(
      (p): p is string => p !== null,
    ),
  ),
]

// driver.js: the tour feature's preview surface injects the package's prebuilt
// IIFE as raw source, but driver.js's exports map doesn't expose
// dist/driver.js.iife.js. Mirror the vendored vite.config.ts alias (upstream
// sync 2026-08-19 adds this dep). `?raw` stays attached in dev but is stripped
// in some build paths, hence both keys.
const requireFromApp = createRequire(import.meta.url)
const driverIife = path.join(
  path.dirname(requireFromApp.resolve('driver.js')),
  'driver.js.iife.js',
)

export default defineConfig(({ command }) => ({
  base: './',
  // Vendor's public/ (icons, sprites) served as our public dir —
  // no copy to reconcile after a subtree pull.
  publicDir: path.join(vendorDesktop, 'public'),
  plugins: [react(), tailwindcss()],
  // ADR-0014：构建期注入客户端版本标识（上游桌面版本 + 项目版本）。
  define: {
    __HERMES_WEB_VERSION__: JSON.stringify(webVersionString(import.meta.dirname)),
    // ADR-0019：Web 构建标记——vendor use-keybinds 据此让 view.findInPage
    // 热键失效（find 桥面 denied，回归浏览器原生查找，见 PATCHES.md §4）。
    'import.meta.env.VITE_WEB_BUILD': JSON.stringify('1'),
  },
  css: {
    postcss: { plugins: [] },
  },
  resolve: {
    alias: {
      // Same debug counters wiring as upstream (dev-only.ts / noop in build).
      '@/debug/dev-only':
        command === 'serve'
          ? path.join(vendorDesktop, 'src/debug/dev-only.ts')
          : path.join(vendorDesktop, 'src/debug/dev-only.noop.ts'),
      '@': path.join(vendorDesktop, 'src'),
      '@hermes/plugin-sdk': path.join(vendorDesktop, 'src/sdk/index.ts'),
      '@hermes/shared/billing': path.join(vendorShared, 'src/billing-types.ts'),
      '@hermes/shared/translucency': path.join(vendorShared, 'src/translucency.ts'),
      '@hermes/shared': path.join(vendorShared, 'src'),
      // See driverIife above (upstream sync 2026-08-19).
      'driver.js/dist/driver.js.iife.js?raw': `${driverIife}?raw`,
      'driver.js/dist/driver.js.iife.js': driverIife,
    },
    dedupe: ['react', 'react-dom', 'react-router'],
  },
  // driver.js enters the graph only via the tour's dynamic import chain; left
  // alone the dep scanner would prebundle the `?raw` IIFE at first use and
  // break the raw-text transform (mirrors vendored optimizeDeps.exclude).
  optimizeDeps: {
    exclude: [
      'driver.js',
      'driver.js/dist/driver.js.iife.js',
      'driver.js/dist/driver.js.iife.js?raw',
      'driver.js/dist/driver.css?raw',
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: { allow: fsAllow },
    // Windows: pnpm drops .package.json.*.tmpdir dirs under the app root;
    // chokidar watching them crashes vite with EBUSY when they get removed.
    watch: {
      ignored: ['**/.package.json.*', '**/*.tmpdir/**'],
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
}))
