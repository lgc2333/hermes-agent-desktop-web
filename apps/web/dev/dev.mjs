#!/usr/bin/env node
/**
 * M0 dev driver: starts the mock gateway (WS) and the Vite dev server
 * together, so the renderer has a gateway to dial while it boots.
 *
 * Usage:  node dev/dev.mjs
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const children = []

function run(name, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: appRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: false
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

run('mock-gateway', process.execPath, ['dev/mock-gateway.mjs'])
run('vite', process.execPath, [path.join(appRoot, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5173'])

process.on('SIGINT', () => {
  for (const child of children) {
    child.kill()
  }
  process.exit(0)
})