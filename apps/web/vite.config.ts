import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import fs from 'node:fs'

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

const real = (p: string): string | null => {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

const fsAllow = [
  ...new Set([root, real(path.join(root, 'node_modules'))].filter((p): p is string => p !== null))
]

export default defineConfig(({ command }) => ({
  base: './',
  // Vendor's public/ (icons, sprites) served as our public dir —
  // no copy to reconcile after a subtree pull.
  publicDir: path.join(vendorDesktop, 'public'),
  plugins: [react(), tailwindcss()],
  css: {
    postcss: { plugins: [] }
  },
  resolve: {
    alias: {
      // Same debug counters wiring as upstream (dev-only.ts / noop in build).
      '@/debug/dev-only': command === 'serve'
        ? path.join(vendorDesktop, 'src/debug/dev-only.ts')
        : path.join(vendorDesktop, 'src/debug/dev-only.noop.ts'),
      '@': path.join(vendorDesktop, 'src'),
      '@hermes/plugin-sdk': path.join(vendorDesktop, 'src/sdk/index.ts'),
      '@hermes/shared/billing': path.join(vendorShared, 'src/billing-types.ts'),
      '@hermes/shared': path.join(vendorShared, 'src')
    },
    dedupe: ['react', 'react-dom', 'react-router']
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: { allow: fsAllow }
  },
  preview: {
    host: '127.0.0.1',
    port: 4173
  }
}))