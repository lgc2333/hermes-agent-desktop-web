import { describe, expect, it } from 'vitest'
import { composeWebVersion } from './build-version.mjs'

describe('composeWebVersion (ADR-0018)', () => {
  // 完整组合版本 tag：已含 +web. → 原样返回，不再重复拼装。
  it('returns a full-composed tag verbatim (no duplicate +web.)', () => {
    expect(composeWebVersion('0.17.0', '0.17.0+web.0.1.0')).toBe('0.17.0+web.0.1.0')
  })

  // 纯项目版本 tag（ADR-0014 旧示例，向后兼容）→ 照常拼装。
  it('composes a bare web-version tag with the +web. prefix', () => {
    expect(composeWebVersion('0.17.0', '0.1.0')).toBe('0.17.0+web.0.1.0')
  })

  // 无 tag 分支：commit hash 标识。
  it('composes a commit-hash identifier', () => {
    expect(composeWebVersion('0.17.0', 'gd8aa0fe')).toBe('0.17.0+web.gd8aa0fe')
  })

  // 无 git 分支：package.json 版本。
  it('composes a package.json version identifier', () => {
    expect(composeWebVersion('0.17.0', '0.1.0')).toBe('0.17.0+web.0.1.0')
  })
})
