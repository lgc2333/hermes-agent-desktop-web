import { describe, expect, it } from 'vitest'

import {
  BROWSER_PROBE_NOTE,
  insecureSchemeWarnings,
  probePluginRepoInBrowser,
  repoNameFromUrl,
  resolvePluginGitUrl,
} from './plugin-probe'

/**
 * ADR-0027：Web 侧 `probePluginRepo` 是**降级实现**——保留上游的标识符校验
 * （非法输入仍 ok:false），但恒报 agent 可装 / desktop 不可装（Web 无 Electron
 * 主进程，desktop 半不可能安装）。
 */

describe('resolvePluginGitUrl (upstream port)', () => {
  it('parses owner/repo shorthand', () => {
    expect(resolvePluginGitUrl('lgc2333/hermes-plugin')).toEqual({
      gitUrl: 'https://github.com/lgc2333/hermes-plugin.git',
      subdir: null,
    })
  })

  it('parses owner/repo/subdir shorthand', () => {
    expect(resolvePluginGitUrl('owner/repo/plugins/foo')).toEqual({
      gitUrl: 'https://github.com/owner/repo.git',
      subdir: 'plugins/foo',
    })
  })

  it('normalizes a GitHub browser tree URL to a git URL + subdir', () => {
    expect(
      resolvePluginGitUrl('https://github.com/owner/repo/tree/main/pkgs/plugin'),
    ).toEqual({
      gitUrl: 'https://github.com/owner/repo.git',
      subdir: 'pkgs/plugin',
    })
    expect(resolvePluginGitUrl('https://github.com/owner/repo')).toEqual({
      gitUrl: 'https://github.com/owner/repo',
      subdir: null,
    })
  })

  it('parses the #subdir and .git/subdir forms', () => {
    expect(resolvePluginGitUrl('https://gitlab.com/g/p.git#sub/dir')).toEqual({
      gitUrl: 'https://gitlab.com/g/p.git',
      subdir: 'sub/dir',
    })
    expect(resolvePluginGitUrl('https://gitlab.com/g/p.git/sub/dir')).toEqual({
      gitUrl: 'https://gitlab.com/g/p.git',
      subdir: 'sub/dir',
    })
  })

  it('rejects empty and single-segment identifiers', () => {
    expect(() => resolvePluginGitUrl('')).toThrow(/required/i)
    expect(() => resolvePluginGitUrl('just-a-name')).toThrow(
      /Invalid plugin identifier/,
    )
  })
})

describe('repoNameFromUrl / insecureSchemeWarnings (upstream port)', () => {
  it('derives the repo name', () => {
    expect(repoNameFromUrl('https://github.com/owner/repo.git')).toBe('repo')
    expect(repoNameFromUrl('git@github.com:owner/repo.git')).toBe('repo')
  })

  it('flags http:// and file:// as insecure', () => {
    expect(insecureSchemeWarnings('http://host/r.git')).toEqual({
      warnings: [
        'This URL uses an insecure or local scheme. Prefer https:// or git@ for production installs.',
      ],
      insecure: true,
    })
    expect(insecureSchemeWarnings('https://host/r.git')).toEqual({
      warnings: [],
      insecure: false,
    })
  })
})

describe('probePluginRepoInBrowser (degraded Web probe)', () => {
  it('reports agent installable + desktop never installable, with a warning', () => {
    const result = probePluginRepoInBrowser({ identifier: 'owner/repo' })

    expect(result.ok).toBe(true)
    expect(result.agent).toBe(true)
    expect(result.desktop).toBe(false)
    expect(result.agentName).toBe('repo')
    expect(result.desktopName).toBeNull()
    expect(result.insecure).toBe(false)
    expect(result.warnings).toEqual([BROWSER_PROBE_NOTE])
  })

  it('uses the repo name as agentName even with a subdirectory', () => {
    // 上游 fallback = repoNameFromUrl(gitUrl)（desktop-plugin-install.ts:392），
    // 不是 subdir 的 basename。
    expect(
      probePluginRepoInBrowser({
        identifier: 'https://github.com/owner/repo#pkgs/plugin',
      }).agentName,
    ).toBe('repo')
    expect(
      probePluginRepoInBrowser({
        identifier: 'https://github.com/owner/repo/tree/main/pkgs/plugin',
      }).agentName,
    ).toBe('repo')
    expect(probePluginRepoInBrowser({ repo: 'owner/repo/plugins/foo' }).agentName).toBe(
      'repo',
    )
  })

  it('carries the insecure-scheme warning through', () => {
    const result = probePluginRepoInBrowser({ repo: 'http://host/repo.git' })

    expect(result.insecure).toBe(true)
    expect(result.warnings).toHaveLength(2)
  })

  it('fails closed on an invalid identifier (upstream parity)', () => {
    const result = probePluginRepoInBrowser({ identifier: 'nope' })

    expect(result.ok).toBe(false)
    expect(result.agent).toBe(false)
    expect(result.desktop).toBe(false)
    expect(result.error).toMatch(/Invalid plugin identifier/)
  })

  it('accepts the legacy `repo` field when identifier is absent', () => {
    expect(probePluginRepoInBrowser({ repo: 'owner/repo' }).ok).toBe(true)
    expect(probePluginRepoInBrowser({}).ok).toBe(false)
  })
})
