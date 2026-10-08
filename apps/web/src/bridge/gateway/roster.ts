/**
 * Union agent roster（`getAgentRoster`）—— 类 2（走代理 RPC）。
 *
 * 桌面端由 Electron main 在 `hermes:agents:roster` 里枚举**每条注册连接**的
 * profile 列表再拍平成联合花名册（Bot Mode / capabilities scope-selector /
 * profile rail 的跨连接行 / `@name-device` 去重）。浏览器没有主进程，但每条
 * 连接的 `/api/profiles` 经代理逐条可达（`X-Hermes-Target` 指目标），故本模块：
 *
 *   1. `enumerateRosterSources` —— 对每条注册连接并发 GET `/api/profiles`
 *      （+ `/api/status` 取 `install_id`），失败按「不可达」上报而不整体失败；
 *   2. `buildAgentRoster` / `agentHandle` / `labelSlug` / `rosterSourceStatus`
 *      / `pickCanonicalConnection` —— 上游 `electron/connection-registry.ts`
 *      的**纯函数逐字移植**（同一套去重策略：同 backend（install_id）折叠 +
 *      `@name-device` handle 规则）。移植而非 import：上游那份在 electron/ 树，
 *      不在 `@` 别名树内（PATCHES.md §5 同款理由）。
 *
 * 与桌面的差异（Web 拓扑所限，见 ADR-0027）：
 *   - 无 SSH 隧道 / 本地后端池 → 不做 `connect-on-demand` 延迟拨号，全部按
 *     注册 URL 直连（失败即上报 unreachable）；
 *   - `installId` 只来自 `/api/status`，无 TTL 缓存（花名册是 on-demand
 *     拉取：mount / focus / 注册表变更，非定时轮询）；
 *   - 无 `remoteProfile`（桌面 SSH 连接的 profile 覆盖）—— `WebConnectionRecord`
 *     没有该字段，故 `targetProfile` 恒等于 `profile`；
 *   - 不移植 `shouldDeferLocalEnumeration`（connection-registry.ts:594-609）：那条
 *     是「本地后端池 + 延迟拨号」的守卫（避免枚举时凭空 spawn 一个本地 backend、
 *     造出幻影 `default` agent）。Web 没有池、也不 spawn——枚举就是对该连接注册的
 *     URL 发请求，不可达即上报 unreachable。且 Web 里唯一那条 local 形态连接
 *     （`defaultMockConnection`）的 kind 是 `'remote'`，触发条件本就不成立。
 */

import type {
  DesktopAgentRoster,
  DesktopConnectionKind,
  DesktopRegistryConnection,
  DesktopRosterAgent,
  HermesApiRequest,
} from '@/global'

import type { WebConnectionRecord } from '../registry'

/** 上游 `RosterProfileMetadata`（connection-registry.ts:642-647）。 */
export interface RosterProfileMetadata {
  display_name?: string
  title?: string
  ui_meta?: Record<string, unknown>
  has_avatar?: boolean
}

/** 上游 `RosterAgent` + 渲染层额外消费的 profileMetadata（hermes-bots/data.ts）。 */
export interface RosterAgent extends DesktopRosterAgent {
  profileMetadata?: RosterProfileMetadata
}

/** 上游 `ConnectionAgents`（connection-registry.ts:610-626）。 */
export interface RosterSourceAgents {
  connection: WebConnectionRecord
  /** 枚举到的 profile 名；`null` = 不可达（与上游同语义）。 */
  profiles: null | string[]
  profileMetadata?: Record<string, RosterProfileMetadata>
  error?: string
  needsSignIn?: boolean
  installId?: string
}

/** 联合花名册负载：`primaryConnectionId` 上游在 IPC 之外多带（渲染层读它）。 */
export interface DesktopAgentRosterPayload extends DesktopAgentRoster {
  primaryConnectionId: string
}

/** 上游 `labelSlug`（connection-registry.ts:145-156）逐字移植。 */
export function labelSlug(label: string): string {
  const slug = String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

  return slug || 'connection'
}

/**
 * profile 名归一化：空/空白 → `'default'`（上游 `buildAgentRoster` /
 * `agentHandle` 共用同一条规则）。
 */
function normalizeProfileName(profile: string): string {
  return String(profile || '').trim() || 'default'
}

/** 上游 `agentHandle`（connection-registry.ts:163-167）逐字移植。 */
export function agentHandle(
  profile: string,
  connectionLabel: string,
  duplicated: boolean,
): string {
  const name = normalizeProfileName(profile)

  return duplicated ? `${name}-${labelSlug(connectionLabel)}` : name
}

/** 上游 `rosterSourceStatus`（electron/roster-source-status.ts:1-7）逐字移植。 */
export function rosterSourceStatus(source: {
  profiles: string[] | null
  error?: string
  needsSignIn?: boolean
}): { reachable: boolean; error?: string; needsSignIn?: true } {
  return {
    reachable:
      source.profiles !== null &&
      (!source.error || source.error === 'connect-on-demand'),
    ...(source.error ? { error: source.error } : {}),
    ...(source.needsSignIn ? { needsSignIn: true as const } : {}),
  }
}

/** 上游 `CANONICAL_KIND_PRIORITY`（connection-registry.ts:823）。 */
const CANONICAL_KIND_PRIORITY: Record<DesktopConnectionKind, number> = {
  cloud: 3,
  local: 0,
  remote: 2,
  ssh: 1,
}

/**
 * 上游 `pickCanonicalConnection`（connection-registry.ts:831-845）逐字移植：
 * 折叠后的同一 backend 行由哪条连接代表 —— 优先当前 primary，其次 kind
 * 优先级（local < ssh < remote < cloud），再次注册顺序。
 */
function pickCanonicalConnection<
  T extends { connection: WebConnectionRecord; order: number },
>(candidates: T[], primaryConnectionId?: string): T {
  const active = primaryConnectionId
    ? candidates.find((c) => c.connection.id === primaryConnectionId)
    : undefined

  if (active) {
    return active
  }

  return [...candidates].sort(
    (a, b) =>
      CANONICAL_KIND_PRIORITY[a.connection.kind] -
        CANONICAL_KIND_PRIORITY[b.connection.kind] || a.order - b.order,
  )[0]
}

/**
 * 上游 `buildAgentRoster`（connection-registry.ts:733-819）逐字移植：把逐连接
 * 枚举拍平成联合花名册，去重策略（同连接+profile 折叠 → 同 install_id 折叠 →
 * `@name-device` handle）与桌面端完全一致。
 */
export function buildAgentRoster(
  enumerations: RosterSourceAgents[],
  opts: { primaryConnectionId?: string } = {},
): RosterAgent[] {
  const identities = new Map<
    string,
    {
      connection: WebConnectionRecord
      installId?: string
      order: number
      profile: string
      profileMetadata?: RosterProfileMetadata
    }
  >()

  let order = 0

  for (const { connection, installId, profiles, profileMetadata } of enumerations) {
    for (const profile of profiles || []) {
      const name = normalizeProfileName(profile)
      const key = `${connection.id}\0${name}`

      if (!identities.has(key)) {
        identities.set(key, {
          connection,
          installId,
          order,
          profile: name,
          ...(profileMetadata?.[name]
            ? { profileMetadata: profileMetadata[name] }
            : {}),
        })
      }
    }

    order += 1
  }

  const backends = new Map<
    string,
    {
      connection: WebConnectionRecord
      order: number
      profile: string
      profileMetadata?: RosterProfileMetadata
    }[]
  >()

  for (const {
    connection,
    installId,
    order: rank,
    profile,
    profileMetadata,
  } of identities.values()) {
    const key = installId
      ? `id:${installId}\0${profile}`
      : `conn:${connection.id}\0${profile}`
    const group = backends.get(key)

    if (group) {
      group.push({ connection, order: rank, profile, profileMetadata })
    } else {
      backends.set(key, [{ connection, order: rank, profile, profileMetadata }])
    }
  }

  const rows = [...backends.values()].map((group) =>
    pickCanonicalConnection(group, opts.primaryConnectionId),
  )

  const counts = new Map<string, number>()

  for (const { profile } of rows) {
    counts.set(profile, (counts.get(profile) || 0) + 1)
  }

  const roster: RosterAgent[] = []

  for (const { connection, profile, profileMetadata } of rows) {
    roster.push({
      connectionId: connection.id,
      connectionKind: connection.kind,
      connectionLabel: connection.label,
      profile,
      targetProfile: profile,
      handle: agentHandle(profile, connection.label, (counts.get(profile) || 0) > 1),
      ...(profileMetadata ? { profileMetadata } : {}),
    })
  }

  return roster
}

/** 枚举单条连接的 `/api/profiles` 响应（上游 main.ts:16469-16531 的裁剪版）。 */
function parseProfiles(body: unknown): {
  profiles: string[]
  profileMetadata?: Record<string, RosterProfileMetadata>
} {
  const list = (body as { profiles?: unknown } | null)?.profiles

  if (!Array.isArray(list)) {
    return { profiles: [] }
  }

  const profiles: string[] = []
  const metadata: Record<string, RosterProfileMetadata> = {}

  for (const raw of list) {
    const name = String((raw as { name?: unknown } | null)?.name ?? '').trim()

    if (!name) {
      continue
    }

    profiles.push(name)

    const row = raw as {
      bot_title?: unknown
      display_name?: unknown
      has_avatar?: unknown
      ui_meta?: unknown
    }
    const entry: RosterProfileMetadata = {}

    if (typeof row.display_name === 'string' && row.display_name.trim()) {
      entry.display_name = row.display_name.trim()
    }

    // `/api/profiles` 把 Bot Mode 标题叫 `bot_title`；空串也要带上——
    // 「该 backend 没有标题」正是渲染层丢掉陈旧本地标题的依据。
    if (typeof row.bot_title === 'string') {
      entry.title = row.bot_title.trim()
    }

    if (row.ui_meta && typeof row.ui_meta === 'object') {
      entry.ui_meta = row.ui_meta as Record<string, unknown>
    }

    if (typeof row.has_avatar === 'boolean') {
      entry.has_avatar = row.has_avatar
    }

    // 上游对**每个具名 profile** 都产出一条（可为空对象，main.ts:16471-16500）——
    // 别按「是否非空」裁剪，否则渲染层看到的形状与桌面端不一致。
    metadata[name] = entry
  }

  // 根 HERMES_HOME 本身也是一个 agent；旧 backend 只列具名 profile。
  if (!profiles.includes('default')) {
    profiles.unshift('default')
  }

  return { profiles, profileMetadata: metadata }
}

/** 认证类失败（401/403）→ 渲染层提示「需要登录」而不是笼统不可达。 */
function looksLikeAuthFailure(message: string): boolean {
  return /\b(?:401|403)\b/.test(message)
}

export interface RosterEnumerationOptions {
  /** 桥内 REST 转发（webApi），逐请求带 connectionId。 */
  api: <T>(request: HermesApiRequest) => Promise<T>
  connections: WebConnectionRecord[]
  /** 单连接枚举超时（ms）；不可达连接不得拖住整份花名册。 */
  timeoutMs?: number
}

/**
 * 对每条注册连接并发枚举 profile 列表（+ install_id）。单条失败只标记该条
 * 不可达（上游同款：一条死源不拖垮整份花名册）。
 */
export async function enumerateRosterSources(
  options: RosterEnumerationOptions,
): Promise<RosterSourceAgents[]> {
  const timeoutMs = options.timeoutMs ?? 8_000

  return Promise.all(
    options.connections.map(async (connection): Promise<RosterSourceAgents> => {
      try {
        const [profilesBody, statusBody] = await Promise.all([
          options.api<unknown>({
            connectionId: connection.id,
            path: '/api/profiles',
            timeoutMs,
          }),
          options
            .api<{ install_id?: unknown }>({
              connectionId: connection.id,
              path: '/api/status',
              timeoutMs,
            })
            .catch(() => null),
        ])

        const parsed = parseProfiles(profilesBody)
        const installId = String(statusBody?.install_id ?? '').trim()

        return {
          connection,
          profiles: parsed.profiles,
          ...(parsed.profileMetadata
            ? { profileMetadata: parsed.profileMetadata }
            : {}),
          ...(installId ? { installId } : {}),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        return {
          connection,
          profiles: null,
          error: message,
          needsSignIn: looksLikeAuthFailure(message),
        }
      }
    }),
  )
}

/** 组装完整负载（`agents` + `sources` + `primaryConnectionId`）。 */
export function buildRosterPayload(
  enumerations: RosterSourceAgents[],
  primaryConnectionId: string,
): DesktopAgentRosterPayload {
  return {
    agents: buildAgentRoster(enumerations, { primaryConnectionId }),
    primaryConnectionId,
    sources: enumerations.map(
      ({ connection, error, installId, profiles, needsSignIn }) => ({
        connectionId: connection.id,
        label: connection.label,
        kind: connection.kind as DesktopRegistryConnection['kind'],
        ...rosterSourceStatus({ profiles, error, needsSignIn }),
        ...(installId ? { installId } : {}),
      }),
    ),
  }
}
