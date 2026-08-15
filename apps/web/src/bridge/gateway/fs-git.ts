/**
 * fs / git REST 桥面（ADR-0010：remote 模式桌面门面的 Web 等价）。
 *
 * 上游桌面渲染层在 remote 模式下经 desktop-fs.ts / desktop-git.ts 门面走
 * gateway REST（/api/fs/*、/api/git/*）；Web 恒为 remote 且 api() 已实现，
 * 因此桥面成员直接打 REST。本模块从 GatewayAdapter 拆出，让 gateway.ts
 * 聚焦连接 / REST 转发 / OAuth / 注册表。
 */

import type {
  HermesApiRequest,
  HermesGitBaseBranch,
  HermesGitBranch,
  HermesGitWorktree,
  HermesReadDirResult,
  HermesReadFileTextResult,
  HermesRepoPullRequests,
  HermesRepoStatus,
  HermesReviewList,
  HermesReviewShipInfo,
} from '@/global'

/** 与 webApi 兼容的最小 RPC 形状（独立声明，避免与 gateway.ts 循环依赖）。 */
export type BridgeApi = <T>(request: HermesApiRequest) => Promise<T>

export class RemoteFsGit {
  constructor(private readonly api: BridgeApi) {}

  async readDir(path: string): Promise<HermesReadDirResult> {
    return this.api<HermesReadDirResult>({
      path: `/api/fs/list?path=${encodeURIComponent(path)}`,
    })
  }

  async readFileText(filePath: string): Promise<HermesReadFileTextResult> {
    return this.api<HermesReadFileTextResult>({
      path: `/api/fs/read-text?path=${encodeURIComponent(filePath)}`,
    })
  }

  async writeTextFile(filePath: string, content: string): Promise<{ path: string }> {
    const result = await this.api<{ ok?: boolean; path?: string }>({
      path: '/api/fs/write-text',
      method: 'POST',
      body: { content, path: filePath },
    })

    return { path: result.path || filePath }
  }

  async readFileDataUrl(filePath: string): Promise<string> {
    const result = await this.api<string | { dataUrl?: string }>({
      path: `/api/fs/read-data-url?path=${encodeURIComponent(filePath)}`,
    })

    return typeof result === 'string' ? result : result.dataUrl || ''
  }

  async gitRoot(path: string): Promise<string | null> {
    const result = await this.api<{ root: string | null }>({
      path: `/api/fs/git-root?path=${encodeURIComponent(path)}`,
    })

    return result.root
  }

  private gitGet<T>(
    route: string,
    params: Record<string, boolean | null | string | undefined>,
  ): Promise<T> {
    const query = new URLSearchParams()

    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) {
        query.set(key, String(value))
      }
    }

    return this.api<T>({ path: `/api/git/${route}?${query.toString()}` })
  }

  private gitPost<T>(route: string, body: Record<string, unknown>): Promise<T> {
    return this.api<T>({ path: `/api/git/${route}`, method: 'POST', body })
  }

  git: NonNullable<NonNullable<Window['hermesDesktop']>['git']> = {
    worktreeList: async (repoPath) =>
      (
        await this.gitGet<{ worktrees: HermesGitWorktree[] }>('worktrees', {
          path: repoPath,
        })
      ).worktrees,

    worktreeAdd: (repoPath, options) =>
      this.gitPost('worktree/add', { path: repoPath, ...options }),

    worktreeRemove: (repoPath, worktreePath, options) =>
      this.gitPost('worktree/remove', {
        force: options?.force ?? false,
        path: repoPath,
        worktreePath,
      }),

    branchSwitch: (repoPath, branch) =>
      this.gitPost('branch/switch', { branch, path: repoPath }),

    branchList: async (repoPath) =>
      (
        await this.gitGet<{ branches: HermesGitBranch[] }>('branches', {
          path: repoPath,
        })
      ).branches,

    baseBranchList: async (repoPath) =>
      (
        await this.gitGet<{ branches: HermesGitBaseBranch[] }>('base-branches', {
          path: repoPath,
        })
      ).branches,

    repoStatus: (repoPath) =>
      this.gitGet<HermesRepoStatus | null>('status', { path: repoPath }),

    fileDiff: async (repoPath, filePath) =>
      (
        await this.gitGet<{ diff: string }>('file-diff', {
          file: filePath,
          path: repoPath,
        })
      ).diff,

    review: {
      list: (repoPath, scope, baseRef) =>
        this.gitGet<HermesReviewList>('review/list', {
          base: baseRef,
          path: repoPath,
          scope,
        }),

      diff: async (repoPath, filePath, scope, baseRef, staged) =>
        (
          await this.gitGet<{ diff: string }>('review/diff', {
            base: baseRef,
            file: filePath,
            path: repoPath,
            scope,
            staged,
          })
        ).diff,

      stage: (repoPath, filePath) =>
        this.gitPost('review/stage', { file: filePath ?? null, path: repoPath }),

      unstage: (repoPath, filePath) =>
        this.gitPost('review/unstage', { file: filePath ?? null, path: repoPath }),

      revert: (repoPath, filePath) =>
        this.gitPost('review/revert', { file: filePath ?? null, path: repoPath }),

      revParse: async (repoPath, ref) =>
        (
          await this.gitGet<{ sha: null | string }>('review/rev-parse', {
            path: repoPath,
            ref,
          })
        ).sha,

      commit: (repoPath, message, push) =>
        this.gitPost('review/commit', { message, path: repoPath, push }),

      commitContext: (repoPath) =>
        this.gitGet('review/commit-context', { path: repoPath }),

      push: (repoPath) => this.gitPost('review/push', { path: repoPath }),

      shipInfo: (repoPath) =>
        this.gitGet<HermesReviewShipInfo>('review/ship-info', { path: repoPath }),

      prList: (repoPath, branches, numbers) =>
        this.gitPost<HermesRepoPullRequests>('review/pr-list', {
          branches,
          numbers: numbers ?? [],
          path: repoPath,
        }),

      // 与 desktop remote 一致：远程 gateway 无 PR-comment 路由，降级为纯 URL。
      fetchPrComment: async () => null,

      createPr: (repoPath) => this.gitPost('review/create-pr', { path: repoPath }),
    },

    // 与 desktop remote 一致：仓库发现是本地磁盘爬取，remote 下由后端维护。
    scanRepos: async () => [],
  }
}
