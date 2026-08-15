/**
 * relay_test.ts — 转发核心单测（deno test）。
 * 集成测试在本文件内起临时本地服务（echo HTTP / echo WS），不依赖外部网络。
 */
import { assertEquals, assertStrictEquals, assertThrows } from 'jsr:@std/assert'
import { normalizeTarget, relayRest, relayWs, safeEqual, upstreamUrl, upstreamWsUrl } from './relay.ts'

Deno.test('safeEqual: constant-time equality', () => {
  assertEquals(safeEqual('abc', 'abc'), true)
  assertEquals(safeEqual('abc', 'abd'), false)
  assertEquals(safeEqual('abc', 'abcd'), false)
  assertEquals(safeEqual('', ''), true)
})

Deno.test('normalizeTarget: trims trailing slashes, keeps prefix path', () => {
  assertEquals(normalizeTarget('http://127.0.0.1:9119/'), 'http://127.0.0.1:9119')
  assertEquals(normalizeTarget('http://h:9119/hermes///'), 'http://h:9119/hermes')
  assertEquals(normalizeTarget('https://gw.example.com'), 'https://gw.example.com')
  assertThrows(() => normalizeTarget(''), Error, 'required')
  assertThrows(() => normalizeTarget('ftp://x'), Error, 'must be http')
  assertThrows(() => normalizeTarget('not a url'), Error, 'Invalid target URL')
})

Deno.test('upstreamUrl: target + pathname + search', () => {
  const req = new Request('http://proxy:8787/api/status?limit=5&x=1', { method: 'GET' })
  assertEquals(upstreamUrl('http://gw:9119', req), 'http://gw:9119/api/status?limit=5&x=1')
  const req2 = new Request('http://proxy:8787/api/profiles/sessions/sidebar', { method: 'GET' })
  assertEquals(upstreamUrl('http://gw:9119/hermes', req2), 'http://gw:9119/hermes/api/profiles/sessions/sidebar')
})