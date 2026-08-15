#!/usr/bin/env node
/**
 * M0 mock gateway — a JSON-RPC WebSocket server the renderer can dial.
 *
 * The desktop renderer connects to the gateway over WS (JsonRpcGatewayClient
 * in @hermes/shared) and expects:
 *   - requests  → { jsonrpc, id, method, params }  replied with { id, result }
 *   - events    → { method: 'event', params: { type, ... } } pushed at will
 *
 * M0 only needs the socket to OPEN so the boot flow completes; chat methods
 * (prompt.submit, session.info, ...) are M1 work and default to an empty
 * result here. Run alongside 'vite dev' (see package.json dev script).
 *
 * Usage:  node dev/mock-gateway.mjs [port]
 */

import { WebSocketServer } from 'ws'

const PORT = Number(process.argv[2] ?? process.env.MOCK_GATEWAY_PORT ?? 5180)

const wss = new WebSocketServer({ port: PORT, path: '/gateway' })

wss.on('connection', (socket) => {
  console.log('[mock-gateway] client connected')

  socket.on('message', (raw) => {
    let frame
    try {
      frame = JSON.parse(String(raw))
    } catch {
      return
    }

    if (frame.id !== undefined && frame.id !== null) {
      // M0: acknowledge every request with an empty result; M1 fills in the
      // real method surface (session.list, prompt.submit, config.get, ...).
      socket.send(JSON.stringify({ id: frame.id, result: {} }))
      return
    }

    // Ignore client events; M1 may want to reflect them.
  })

  socket.on('close', () => console.log('[mock-gateway] client disconnected'))
  socket.on('error', (err) => console.error('[mock-gateway] socket error', err.message))
})

wss.on('listening', () => {
  console.log('[mock-gateway] listening on ws://127.0.0.1:' + PORT + '/gateway')
})

process.on('SIGINT', () => {
  wss.close()
  process.exit(0)
})
