/**
 * relay_test.ts — 转发核心单测（deno test）。
 * 集成测试在本文件内起临时本地服务（echo HTTP / echo WS），不依赖外部网络。
 */
import { assertEquals, assertStrictEquals, assertThrows } from '@std/assert'
import {
  mediaStreamUpstreamRequest,
  normalizeTarget,
  parseAllowedTargets,
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

Deno.test('upstreamWsUrl: default /api/ws, strips proxy target param', () => {
  const url = new URL(
    'ws://proxy:8787/api/ws?token=tok123&target=' +
      encodeURIComponent('http://gw:9119'),
  )
  const upstream = upstreamWsUrl('http://gw:9119', url)
  assertStrictEquals(upstream.href, 'ws://gw:9119/api/ws?token=tok123')
})

Deno.test('upstreamWsUrl: ADR-0022 forwards client pathname (speak-stream)', () => {
  const url = new URL(
    'ws://proxy:8787/api/audio/speak-stream?token=tok123&target=' +
      encodeURIComponent('http://gw:9119'),
  )
  const upstream = upstreamWsUrl('http://gw:9119', url)
  assertStrictEquals(upstream.href, 'ws://gw:9119/api/audio/speak-stream?token=tok123')
})

Deno.test('upstreamWsUrl: preserves gateway prefix path on custom pathname', () => {
  const url = new URL(
    'ws://proxy:8787/api/audio/speak-stream?target=' +
      encodeURIComponent('http://gw:9119/hermes'),
  )
  const upstream = upstreamWsUrl('http://gw:9119/hermes', url)
  assertStrictEquals(upstream.href, 'ws://gw:9119/hermes/api/audio/speak-stream')
})

Deno.test(
  'mediaStreamUpstreamRequest: builds gateway /api/files/stream with media headers only',
  () => {
    const source = new Headers({
      range: 'bytes=0-1023',
      'if-range': 'etag-1',
      accept: 'audio/webm',
      'x-hermes-target': 'http://danger:1', // must NOT leak
      cookie: 'secret=1', // must NOT leak
    })
    const req = mediaStreamUpstreamRequest(
      'http://gw:9119/',
      '/tmp/a b.ogg',
      'reviewer',
      source,
    )
    assertStrictEquals(req.method, 'GET')
    assertStrictEquals(
      req.url,
      'http://gw:9119/api/files/stream?path=%2Ftmp%2Fa+b.ogg&profile=reviewer',
    )
    assertStrictEquals(req.headers.get('range'), 'bytes=0-1023')
    assertStrictEquals(req.headers.get('if-range'), 'etag-1')
    assertStrictEquals(req.headers.get('accept'), 'audio/webm')
    assertStrictEquals(req.headers.has('x-hermes-target'), false)
    assertStrictEquals(req.headers.has('cookie'), false)
  },
)
