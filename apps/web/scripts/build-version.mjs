/**
 * Web 构建版本计算（ADR-0014）。
 *
 * WEB_VERSION = <上游桌面版本>+web.<项目标识>：
 *   - 上游版本构建时读 vendor/hermes-desktop/package.json（subtree 同步后自动跟随）；
 *   - 项目标识解析阶梯（用户决策）：
 *       1. HEAD 恰好打了 tag（发布点）→ 用 tag 版本号（剥前导 v）；
 *       2. 否则有 git 检出 → 短 commit hash（g<sha>，精确到构建）；
 *       3. 无 git（Docker 构建，.dockerignore 排除 .git）→ 退回
 *          apps/web/package.json 版本号。
 * vite.config.ts 与 vitest.config.ts 共用，保证构建与测试看到同一字符串。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

function gitInfo(repoRoot) {
  // HEAD 精确打 tag → 发布版本号；否则 → 短 hash；无 git → null。
  try {
    const tag = execFileSync('git', ['describe', '--exact-match', '--tags', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (tag) return { tag: tag.replace(/^v/, '') }
  } catch {
    // 未打 tag → 落 hash 分支
  }
  try {
    const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (hash) return { hash }
  } catch {
    // 非 git 检出（如 Docker 构建）→ null
  }
  return null
}

export function webVersionString(webRoot) {
  const repoRoot = path.resolve(webRoot, '../..')
  const desktopPkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'vendor', 'hermes-desktop', 'package.json'), 'utf8'),
  )
  const webPkg = JSON.parse(fs.readFileSync(path.join(webRoot, 'package.json'), 'utf8'))
  const git = gitInfo(repoRoot)
  const projectId = git?.tag ?? (git?.hash ? `g${git.hash}` : webPkg.version)
  return `${desktopPkg.version}+web.${projectId}`
}
