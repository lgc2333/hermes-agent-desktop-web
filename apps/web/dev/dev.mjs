#!/usr/bin/env node
/**
 * M0 dev driver: starts the mock gateway (WS), the Deno thin proxy, and the
 * Vite dev server together, so the renderer has a gateway to dial while it boots.
 *
 * Usage:  node dev/dev.mjs [--no-mock]
 *   恒起 Deno 薄代理（apps/proxy，默认端口见其 main.ts）并把 VITE_PROXY_URL
 *   注入 vite——SPA 只走代理（ADR-0016，无直连模式）。需要 deno 在 PATH。
 *   --no-mock     不启动 mock gateway：dev 直连自己的 gateway 时用
 *   （浏览器在设置页填真实 gateway URL；注册表默认 mock 地址探测失败会走
 *   boot-failure 恢复面）。
 */

/* eslint-disable no-console */
import { spawn } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const repoRoot = path.dirname(path.dirname(appRoot))
const noMock = process.argv.includes('--no-mock')

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
    console.log(`[${name}] exited with code`, code)
    for (const other of children) {
      if (other !== child && !other.killed) {
        other.kill()
      }
    }
  })
  return child
}

// 代理恒起（ADR-0016：浏览器只经代理，无直连模式）。
run('proxy', 'deno', [
  'run',
  '--allow-net',
  '--allow-read',
  '--allow-env',
  path.join(repoRoot, 'apps/proxy/src/main.ts'),
])

if (!noMock) {
  run('mock-gateway', process.execPath, ['dev/mock-gateway.mjs'])
} else {
  console.log(
    '[dev] --no-mock: mock gateway not started (connecting to your own gateway)',
  )
}
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
    // VITE_PROXY_URL 与 apps/proxy/src/main.ts 的 PORT 默认值一致
    VITE_PROXY_URL: 'http://127.0.0.1:6722',
  },
)

process.on('SIGINT', () => {
  for (const child of children) {
    child.kill()
  }
  process.exit(0)
})
