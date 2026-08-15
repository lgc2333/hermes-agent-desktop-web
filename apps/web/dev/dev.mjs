#!/usr/bin/env node
/**
 * M0 dev driver: starts the mock gateway (WS) and the Vite dev server
 * together, so the renderer has a gateway to dial while it boots.
 *
 * Usage:  node dev/dev.mjs [--with-proxy]
 *   --with-proxy  还启动 Deno 薄代理（apps/proxy，默认端口见其 main.ts）并把
 *   VITE_PROXY_URL 注入 vite，浏览器经代理转发到 mock/真 gateway
 *   （M2 验收形态）。需要 deno 在 PATH。
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const repoRoot = path.dirname(path.dirname(appRoot))
const withProxy = process.argv.includes('--with-proxy')

const children = []

function run(name, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: appRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: false,
  })
  children.push(child)
  child.on('exit', (code) => {
    console.log('[' + name + '] exited with code', code)
    for (const other of children) {
      if (other !== child && !other.killed) {
        other.kill()
      }
    }
  })
  return child
}

if (withProxy) {
  run('proxy', 'deno', [
    'run',
    '--allow-net',
    '--allow-read',
    '--allow-env',
    path.join(repoRoot, 'apps/proxy/src/main.ts'),
  ])
}

run('mock-gateway', process.execPath, ['dev/mock-gateway.mjs'])
run(
  'vite',
  process.execPath,
  [
    path.join(appRoot, 'node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    '5173',
  ],
  {
    ...(withProxy ? { VITE_PROXY_URL: 'http://127.0.0.1:6722' } : {}), // VITE_PROXY_URL 与 apps/proxy/src/main.ts 的 PORT 默认值一致
  },
)

process.on('SIGINT', () => {
  for (const child of children) {
    child.kill()
  }
  process.exit(0)
})
