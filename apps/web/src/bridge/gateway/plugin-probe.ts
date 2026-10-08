/**
 * 插件仓库探测（`probePluginRepo`）—— 类 2 的**降级实现**（ADR-0027）。
 *
 * 桌面端在 Electron 主进程里 `git clone --depth 1` 后读仓库文件判组件
 * （electron/desktop-plugin-install.ts:365-409 `probePluginRepo` → `detectPluginComponents`）。
 * 浏览器里既没有 git 也没有任意 URL 的字节读通道，远端 gateway 也没有 probe 端点
 * （只有 `plugins.manage install`，见 tui_gateway/contracts/tools_mcp_plugins.py:765）
 * —— 所以 Web 侧：
 *
 *   1. **保留标识符校验**：`resolvePluginGitUrl` / `repoNameFromUrl` /
 *      `insecureSchemeWarnings` 逐字移植自上游（同文件），非法输入照旧报错，
 *      不再让整条安装链死在 `phase='error'`（上游 plugin-install-modal.tsx:120-131
 *      在缺 `probePluginRepo` 时无条件落 error）；
 *   2. **恒报 `agent: true` / `desktop: false`**：desktop 半是 Electron 主进程
 *      概念（复制到 `<desktop-plugins root>/<name>`），Web 里**不可能**安装，
 *      报 false 让弹窗不渲染 desktop 勾选（也顺带让
 *      installDesktopPlugin/reconcileDesktopPlugins/removeDesktopPlugin 三个面
 *      在 Web 永不被调用）；agent 半由 gateway `plugins.manage install` 真装，
 *      仓库其实不含 agent 半时由 gateway 返回准确错误，弹窗原样展示；
 *   3. 附一条 warning 说明浏览器无法预检仓库内容，UI 会把它显示给用户。
 */

export interface ResolvedPluginGitUrl {
  gitUrl: string
  subdir: string | null
}

export interface PluginProbeResult {
  ok: boolean
  agent: boolean
  desktop: boolean
  agentName?: null | string
  desktopName?: null | string
  warnings: string[]
  insecure: boolean
  error?: string
}

const GITHUB_BROWSER_SEGMENTS = new Set(['tree', 'blob', 'commit'])

/** 上游 `resolvePluginGitUrl`（desktop-plugin-install.ts:49-105）逐字移植。 */
export function resolvePluginGitUrl(identifier: string): ResolvedPluginGitUrl {
  const trimmed = identifier.trim()

  if (!trimmed) {
    throw new Error('Plugin identifier is required.')
  }

  if (/^(?:https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(trimmed)) {
    if (trimmed.startsWith('https://github.com/')) {
      const rest = trimmed
        .slice('https://github.com/'.length)
        .split(/[?#]/)[0]
        .replace(/\/+$/, '')
      const parts = rest.split('/').filter(Boolean)

      if (parts.length >= 3 && parts[2] && GITHUB_BROWSER_SEGMENTS.has(parts[2])) {
        const repo = parts[1].replace(/\.git$/, '')
        let subdir: string | null = null

        if (parts[2] === 'tree' && parts.length >= 5) {
          subdir = parts.slice(4).join('/').replace(/\/+$/, '') || null
        }

        return { gitUrl: `https://github.com/${parts[0]}/${repo}.git`, subdir }
      }
    }

    if (trimmed.includes('#')) {
      const hashIdx = trimmed.indexOf('#')
      const gitUrl = trimmed.slice(0, hashIdx)
      const subdir = trimmed.slice(hashIdx + 1).replace(/^\/+|\/+$/g, '') || null

      return { gitUrl, subdir }
    }

    const marker = '.git/'

    if (trimmed.includes(marker)) {
      const idx = trimmed.indexOf(marker)
      const gitUrl = trimmed.slice(0, idx + marker.length - 1)
      const subdir =
        trimmed.slice(idx + marker.length).replace(/^\/+|\/+$/g, '') || null

      return { gitUrl, subdir }
    }

    return { gitUrl: trimmed, subdir: null }
  }

  const parts = trimmed.split('/').filter(Boolean)

  if (parts.length >= 2) {
    const [owner, repo, ...rest] = parts
    const gitUrl = `https://github.com/${owner}/${repo}.git`
    const subdir = rest.join('/').replace(/\/+$/, '') || null

    return { gitUrl, subdir }
  }

  throw new Error(
    "Invalid plugin identifier. Use a Git URL or 'owner/repo' (optionally with a subdirectory).",
  )
}

/** 上游 `repoNameFromUrl`（desktop-plugin-install.ts:107-122）逐字移植。 */
export function repoNameFromUrl(url: string): string {
  let name = url.replace(/\/+$/, '')

  if (name.endsWith('.git')) {
    name = name.slice(0, -4)
  }

  name = name.split('/').pop() || name

  if (name.includes(':')) {
    name = name.split(':').pop() || name
    name = name.split('/').pop() || name
  }

  return name
}

/** 上游 `insecureSchemeWarnings`（desktop-plugin-install.ts:355-364）逐字移植。 */
export function insecureSchemeWarnings(gitUrl: string): {
  warnings: string[]
  insecure: boolean
} {
  if (gitUrl.startsWith('http://') || gitUrl.startsWith('file://')) {
    return {
      warnings: [
        'This URL uses an insecure or local scheme. Prefer https:// or git@ for production installs.',
      ],
      insecure: true,
    }
  }

  return { warnings: [], insecure: false }
}

/** 浏览器无法预检仓库内容时附加的说明（渲染层会展示 probe.warnings）。 */
export const BROWSER_PROBE_NOTE =
  'Hermes Web cannot inspect the repository from the browser; the agent half is installed through the gateway, which reports the authoritative result. Desktop plugins are not installable in the browser.'

/**
 * Web 侧 `probePluginRepo`：校验标识符 + 恒报 agent 可装 / desktop 不可装。
 * `ok:false` 只用于**非法标识符**（与上游一致：非法输入不该进安装流程）。
 */
export function probePluginRepoInBrowser(payload: {
  identifier?: string
  repo?: string
}): PluginProbeResult {
  const identifier = String(payload.identifier ?? payload.repo ?? '').trim()

  try {
    const { gitUrl } = resolvePluginGitUrl(identifier)
    const { warnings, insecure } = insecureSchemeWarnings(gitUrl)
    // 上游 agentName = `detected.agentName ?? repoNameFromUrl(gitUrl)`
    // （desktop-plugin-install.ts:392）：我们无法 clone 读插件清单，故恒用
    // 上游的 fallback —— **仓库名**（不是 subdir 的 basename）。
    const agentName = repoNameFromUrl(gitUrl)

    return {
      ok: true,
      agent: true,
      desktop: false,
      agentName,
      desktopName: null,
      warnings: [...warnings, BROWSER_PROBE_NOTE],
      insecure,
    }
  } catch (error) {
    return {
      ok: false,
      agent: false,
      desktop: false,
      warnings: [],
      insecure: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
