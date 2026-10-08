import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { composeWebVersion, webVersionString } from './build-version.mjs'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('composeWebVersion', () => {
  // 同步到上游 release tag → 上游分量保留 tag 的 v；整体带前导 v（与发布 tag 逐字一致）。
  it('composes the upstream release tag as the upstream component', () => {
    expect(composeWebVersion('0.4.22', 'v0.21.6')).toBe('v0.4.22+v0.21.6')
  })

  // 同步到 main → 上游提交的 7 位短 hash（sync-upstream.sh 用 --short=7）。
  it('composes a 7-char upstream commit hash', () => {
    expect(composeWebVersion('0.4.22', '818c13b')).toBe('v0.4.22+818c13b')
  })

  // upstream.ref 缺失 → unknown 兜底（不应发生）。
  it('falls back to the unknown marker', () => {
    expect(composeWebVersion('0.4.22', 'unknown')).toBe('v0.4.22+unknown')
  })
})

describe('webVersionString', () => {
  // 真实仓库：HEAD 未打 tag → package.json 的 version + upstream.ref；
  // 发布点（HEAD 打了 tag）→ tag 原文（含前导 v）。
  it('follows the v<project version>+<upstream tag | hash> shape', () => {
    expect(webVersionString(webRoot)).toMatch(
      /^v\d+\.\d+\.\d+\+(?:v\d+\.\d+\.\d+|[0-9a-f]{7}|unknown)$/,
    )
  })
})
