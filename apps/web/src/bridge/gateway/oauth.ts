/**
 * Gateway 桥面 — native OAuth 中转（M3）。
 *
 * 从 gateway.ts 拆出：OAuth 登录/登出/会话轮询，全部经代理
 * /auth/native/*（PKCE 全程在代理侧，httpOnly cookie 会话）。
 */

import type { DesktopOauthLoginResult, DesktopOauthLogoutResult } from '@/global'

import { proxyBaseUrl, proxyFetch, proxySessionStatus } from './rest'

/** OAuth 授权窗口名（同名复用，避免多开）。 */
const OAUTH_WINDOW_NAME = 'hermes-oauth-login'
/** 授权轮询：500ms 间隔，最长 5 分钟（与 gateway pending TTL 对齐）。 */
const OAUTH_POLL_INTERVAL_MS = 500
const OAUTH_POLL_TIMEOUT_MS = 5 * 60_000

export interface OauthSessionStatus {
  connected: boolean
  provider: string
  userId: string
  expiresAt: number
  tokenPreview: string | null
}

const DISCONNECTED: OauthSessionStatus = {
  connected: false,
  provider: '',
  userId: '',
  expiresAt: 0,
  tokenPreview: null,
}

export class OauthBroker {
  /**
   * M3：native OAuth 登录（经代理中转，PKCE 全程在代理侧）。
   *
   * 流程：POST /auth/native/start（代理生成 PKCE/state + authorize URL）→
   * 新窗口打开 gateway 授权页 → gateway 完成授权后 302 回代理 callback →
   * 代理换 token set 并存 httpOnly cookie → 本窗口轮询 /auth/native/session
   * 直到 connected（或窗口关闭 / 超时）。
   */
  async login(remoteUrl: string): Promise<DesktopOauthLoginResult> {
    const proxy = proxyBaseUrl()
    const baseUrl = remoteUrl.replace(/\/+$/, '')

    if (!proxy) {
      // 直连模式无代理中转（token 在浏览器侧才能转发）——OAuth 不可用。
      return { ok: false, baseUrl, connected: false }
    }

    // 同步段先开窗（保留用户手势，避免弹窗拦截），拿到 authorize URL 后再导航。
    const win = window.open('', OAUTH_WINDOW_NAME, 'popup,width=560,height=680')

    if (!win) {
      return { ok: false, baseUrl, connected: false }
    }

    try {
      const start = await proxyFetch(`${proxy}/auth/native/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: baseUrl }),
      })

      if (!start.ok) {
        win.close()

        return { ok: false, baseUrl, connected: false }
      }

      const { authorizeUrl } = (await start.json()) as { authorizeUrl?: string }

      if (!authorizeUrl) {
        win.close()

        return { ok: false, baseUrl, connected: false }
      }

      // 授权窗口导航（gateway → IDP → 代理 callback → 自动关闭）。
      win.location.href = authorizeUrl

      const connected = await this.pollSession(baseUrl, win)

      return { ok: true, baseUrl, connected }
    } catch {
      try {
        win.close()
      } catch {
        // already closed
      }

      return { ok: false, baseUrl, connected: false }
    }
  }

  async logout(remoteUrl?: string): Promise<DesktopOauthLogoutResult> {
    const proxy = proxyBaseUrl()

    if (!proxy) {
      return { ok: false, connected: false }
    }

    try {
      const res = await proxyFetch(`${proxy}/auth/native/logout`, { method: 'POST' })

      return { ok: res.ok, connected: false }
    } catch {
      return { ok: false, connected: false }
    }
  }

  /** 轮询代理会话状态：窗口关闭即停（最后一查）；最多 OAUTH_POLL_TIMEOUT_MS。 */
  private async pollSession(remoteUrl: string, win: Window | null): Promise<boolean> {
    const deadline = Date.now() + OAUTH_POLL_TIMEOUT_MS

    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, OAUTH_POLL_INTERVAL_MS))

      if (win && win.closed) {
        // 窗口已关闭：最后一查确认结果（登录成功时 callback 页自动关闭）。
        return this.sessionStatus(remoteUrl).then((s) => s.connected)
      }

      const session = await this.sessionStatus(remoteUrl)
      if (session.connected) {
        return true
      }
    }

    return false
  }

  /**
   * 查询连接会话状态（cookie + target 匹配才 connected）。
   * M5：OAuth 会话优先；无则查密码 "dashboard login" 会话（同一个
   * 连接只能有一种已生效的代理会话，两种都查让 UI 的 signed-in 状态
   * 与桌面端一致）。
   */
  async sessionStatus(remoteUrl: string): Promise<OauthSessionStatus> {
    const oauth = await this.oauthSession(remoteUrl)

    if (oauth.connected) {
      return oauth
    }

    const password = await proxySessionStatus(remoteUrl)

    if (password.connected) {
      return {
        connected: true,
        provider: password.provider,
        // 密码会话没有 userId 概念——回显用户名（仅展示用途）。
        userId: password.username,
        expiresAt: 0,
        tokenPreview: null,
      }
    }

    return oauth
  }

  /** 查询代理 OAuth 会话状态（/auth/native/session）。 */
  private async oauthSession(remoteUrl: string): Promise<OauthSessionStatus> {
    const proxy = proxyBaseUrl()

    if (!proxy) {
      return DISCONNECTED
    }

    try {
      const res = await proxyFetch(
        `${proxy}/auth/native/session?target=${encodeURIComponent(remoteUrl.replace(/\/+$/, ''))}`,
      )

      if (!res.ok) {
        return DISCONNECTED
      }

      const json = (await res.json()) as {
        connected?: boolean
        provider?: string
        userId?: string
        expiresAt?: number
        tokenPreview?: string | null
      }

      return {
        connected: Boolean(json.connected),
        provider: json.provider ?? '',
        userId: json.userId ?? '',
        expiresAt: json.expiresAt ?? 0,
        tokenPreview: json.tokenPreview ?? null,
      }
    } catch {
      return DISCONNECTED
    }
  }
}
