/**
 * Web 构建版本计算。
 *
 * WEB_VERSION = v<项目版本>+<上游版本>（**带前导 v**，与发布 tag 逐字一致）：
 *   - 项目版本 = apps/web/package.json 的 version（发布时 bump；该字段保持纯
 *     semver，前导 v 只由本模块拼上）；
 *   - 上游版本 = apps/web/package.json 的 `upstream.ref`（由同步脚本写入，见
 *     scripts/sync-upstream.sh）：
 *       同步到上游 release tag → tag 名（如 v0.21.6）；
 *       同步到 main（上游尚未发 release）→ 上游提交的 7 位短 hash（如 818c13be）。
 *     必须落盘：Docker 构建 .dockerignore 排除 .git，构建期拿不到 tag/hash。
 *   - HEAD 恰好打了 tag（发布点，形如 v0.4.22+v0.21.6）→ 直接用 tag 原文，
 *     与 package.json 拼出的自报值逐字一致。
 *   - 渲染层显示时自己会补 v（`version-details.tsx` 的 `v${shortVersion(...)}`，
 *     shortVersion 先剥前导 v）→ 不会出现 vv。
 *
 * 上游 2026-10-08 起把 apps/desktop/package.json 的 version 改成占位符 0.0.0
 * （真版本由构建 stamp 注入，见 PATCHES.md §7）→ 旧公式「<桌面版本>+web.<项目
 * 标识>」（ADR-0014/0018，均已 superseded）失去版本来源，故改为以项目版本为主、
 * 上游同步点作 build metadata（ADR-0026）。
 *
 * vite.config.ts 与 vitest.config.ts 共用本模块，保证构建与测试看到同一字符串。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** upstream.ref 缺失时的兜底标识（正常由同步脚本写入，不应发生）。 */
const UNKNOWN_UPSTREAM = 'unknown'

/** HEAD 精确打 tag → 发布标识（tag 原文，含前导 v）；未打 tag / 非 git 检出 → null。 */
function exactTag(repoRoot) {
  try {
    const tag = execFileSync('git', ['describe', '--exact-match', '--tags', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()

    return tag || null
  } catch {
    // 未打 tag / 无 git 检出 → 走 package.json 分支
    return null
  }
}

/** 拼装 WEB_VERSION：v<项目版本>+<上游 release tag | 7 位短 hash>。 */
export function composeWebVersion(projectVersion, upstreamRef) {
  return `v${projectVersion}+${upstreamRef}`
}

export function webVersionString(webRoot) {
  const tagged = exactTag(path.resolve(webRoot, '../..'))

  if (tagged) {
    return tagged
  }

  const webPkg = JSON.parse(fs.readFileSync(path.join(webRoot, 'package.json'), 'utf8'))

  return composeWebVersion(webPkg.version, webPkg.upstream?.ref ?? UNKNOWN_UPSTREAM)
}
