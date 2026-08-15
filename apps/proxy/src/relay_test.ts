/**
 * relay_test.ts — 转发核心单测（deno test）。
 * 集成测试在本文件内起临时本地服务（echo HTTP / echo WS），不依赖外部网络。
 */
import { assertEquals, assertStrictEquals, assertThrows } from 'jsr:@std/assert'
import {
  normalizeTarget,
  parseAllowedTargets,
  relayRest,
  relayWs,
  targetAllowed,
  upstreamUrl,
  upstreamWsUrl,
} from './relay.ts'

Deno.test('targetAllowed: empty allowlist allows everything', () => {
  assertEquals(targetAllowed('http://127.0.0.1:5180', []), true)
  assertEquals(targetAllowed('https://gw.example.com', []), true)
})

Deno.test('targetAllowed: exact origin match, port defaults normalized', () => {
  const allowed = ['http://127.0.0.1:5180', 'https://gw.example.com']
  assertEquals(targetAllowed('http://127.0.0.1:5180', allowed), true)
  assertEquals(targetAllowed('http://127.0.0.1:5180/hermes', allowed), true)
  assertEquals(targetAllowed('https://gw.example.com', allowed), true)
  assertEquals(targetAllowed('https://gw.example.com:443', allowed), true)
  assertEquals(targetAllowed('http://gw.example.com', allowed), false) // scheme mismatch
  assertEquals(targetAllowed('https://gw.example.com:8443', allowed), false) // port mismatch
  assertEquals(targetAllowed('http://127.0.0.1:5181', allowed), false)
  assertEquals(targetAllowed('http://other.example.com', allowed), false)
})

Deno.test('targetAllowed: *. wildcard matches subdomains, not apex', () => {
  const allowed = ['https://*.example.com', 'http://*.internal:9119']
  assertEquals(targetAllowed('https://gw.example.com', allowed), true)
  assertEquals(targetAllowed('https://a.b.example.com', allowed), true)
  assertEquals(targetAllowed('https://example.com', allowed), false) // apex excluded
  assertEquals(targetAllowed('http://gw.internal:9119', allowed), true)
  assertEquals(targetAllowed('http://gw.internal', allowed), false) // port mismatch
  assertEquals(targetAllowed('https://gw.internal:9119', allowed), false) // scheme mismatch
})

Deno.test('parseAllowedTargets: splits, trims, ignores empties, validates', () => {
  assertEquals(parseAllowedTargets(undefined), [])
  assertEquals(parseAllowedTargets(''), [])
  assertEquals(parseAllowedTargets('  http://a:1 , http://b:2 , '), [
    'http://a:1',
    'http://b:2',
  ])
  assertEquals(parseAllowedTargets('https://*.example.com'), ['https://*.example.com'])
  assertThrows(() => parseAllowedTargets('http://a:1, ftp://x'), Error, 'must be http')
  assertThrows(() => parseAllowedTargets('not a url'), Error, 'Invalid target URL')
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
  assertEquals(
    upstreamUrl('http://gw:9119', req),
    'http://gw:9119/api/status?limit=5&x=1',
  )
  const req2 = new Request('http://proxy:8787/api/profiles/sessions/sidebar', {
    method: 'GET',
  })
  assertEquals(
    upstreamUrl('http://gw:9119/hermes', req2),
    'http://gw:9119/hermes/api/profiles/sessions/sidebar',
  )
})
