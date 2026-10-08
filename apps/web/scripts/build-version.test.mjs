import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { composeWebVersion, webVersionString } from './build-version.mjs'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('composeWebVersion', () => {
  // 同步到上游 release tag → 上游分量保留 tag 的 v（tag 形态 v<项目版本>+v<上游版本>）。
  it('composes the upstream release tag as the upstream component', () => {
    expect(composeWebVersion('0.4.22', 'v0.21.6')).toBe('0.4.22+v0.21.6')
  })

  // 同步到 main → 上游提交的 7 位短 hash（sync-upstream.sh 用 --short=7）。
  it('composes a 7-char upstream commit hash', () => {
    expect(composeWebVersion('0.4.22', '818c13b')).toBe('0.4.22+818c13b')
  })

  // upstream.ref 缺失 → unknown 兜底（不应发生）。
  it('falls back to the unknown marker', () => {
    expect(composeWebVersion('0.4.22', 'unknown')).toBe('0.4.22+unknown')
  })
})

describe('webVersionString', () => {
  // 真实仓库：HEAD 未打 tag → package.json 的 version + upstream.ref；
  // 发布点（HEAD 打了 tag）→ tag 剥前导 v 后的完整标识。
  it('follows the <project version>+<upstream tag | hash> shape', () => {
    expect(webVersionString(webRoot)).toMatch(
      /^\d+\.\d+\.\d+\+(?:v\d+\.\d+\.\d+|[0-9a-f]{7}|unknown)$/,
    )
  })
})
