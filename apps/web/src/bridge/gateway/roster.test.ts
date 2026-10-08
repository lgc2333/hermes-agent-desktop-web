import { describe, expect, it, vi } from 'vitest'

import type { WebConnectionRecord } from '../registry'

import {
  agentHandle,
  buildAgentRoster,
  buildRosterPayload,
  enumerateRosterSources,
  labelSlug,
  rosterSourceStatus,
} from './roster'

function conn(
  id: string,
  label: string,
  kind: WebConnectionRecord['kind'] = 'remote',
): WebConnectionRecord {
  return {
    id,
    label,
    kind,
    url: `https://${id}.example`,
    authMode: 'token',
    token: 't',
  }
}

describe('roster pure helpers (upstream buildAgentRoster port)', () => {
  it('labelSlug / agentHandle mirror the upstream duplicate-handle rule', () => {
    expect(labelSlug('Work VPS')).toBe('work-vps')
    expect(labelSlug('')).toBe('connection')
    expect(agentHandle('research', 'Homelab', false)).toBe('research')
    expect(agentHandle('research', 'Homelab', true)).toBe('research-homelab')
    expect(agentHandle('', 'Homelab', true)).toBe('default-homelab')
  })

  it('rosterSourceStatus treats null profiles as unreachable', () => {
    expect(rosterSourceStatus({ profiles: ['default'] })).toEqual({ reachable: true })
    expect(rosterSourceStatus({ profiles: null, error: 'boom' })).toEqual({
      reachable: false,
      error: 'boom',
    })
    // connect-on-demand + 已播种 profiles（上游 rememberSshEnumeration 的形状）算可达。
    expect(
      rosterSourceStatus({ profiles: ['default'], error: 'connect-on-demand' }),
    ).toEqual({
      reachable: true,
      error: 'connect-on-demand',
    })
    // profiles 为 null 时无论 error 是什么都不可达（上游同款布尔式）。
    expect(rosterSourceStatus({ profiles: null, error: 'connect-on-demand' })).toEqual({
      reachable: false,
      error: 'connect-on-demand',
    })
    expect(
      rosterSourceStatus({ profiles: null, error: 'x', needsSignIn: true }),
    ).toEqual({
      reachable: false,
      error: 'x',
      needsSignIn: true,
    })
  })

  it('unions profiles across connections and keeps per-connection identity', () => {
    const roster = buildAgentRoster([
      { connection: conn('homelab', 'Homelab'), profiles: ['default', 'research'] },
      { connection: conn('vps', 'Work VPS'), profiles: ['default'] },
    ])

    expect(roster.map((a) => `${a.connectionId}/${a.profile}`)).toEqual([
      'homelab/default',
      'homelab/research',
      'vps/default',
    ])
    // `default` 出现在两条连接上 → @name-device 去重生效。
    expect(roster.map((a) => a.handle)).toEqual([
      'default-homelab',
      'research',
      'default-work-vps',
    ])
    expect(roster[1].connectionKind).toBe('remote')
    expect(roster[1].targetProfile).toBe('research')
  })

  it('collapses two addresses of the same backend (install_id) to one row', () => {
    const primary = conn('vps-ip', 'VPS IP')
    const roster = buildAgentRoster(
      [
        {
          connection: conn('vps-host', 'VPS Host'),
          installId: 'install-1',
          profiles: ['default'],
        },
        { connection: primary, installId: 'install-1', profiles: ['default'] },
      ],
      { primaryConnectionId: 'vps-ip' },
    )

    expect(roster).toHaveLength(1)
    // primary 是候选之一 → 行路由到 primary（窗口已经路由的地方）。
    expect(roster[0].connectionId).toBe('vps-ip')
    // 只有一行 → 不再有重名 → handle 保持裸名。
    expect(roster[0].handle).toBe('default')
  })

  it('picks the canonical connection by kind priority when no primary matches', () => {
    const roster = buildAgentRoster([
      {
        connection: conn('cloud-1', 'Cloud', 'cloud'),
        installId: 'i',
        profiles: ['default'],
      },
      {
        connection: conn('ssh-1', 'Box', 'ssh'),
        installId: 'i',
        profiles: ['default'],
      },
    ])

    // local(0) < ssh(1) < remote(2) < cloud(3) → ssh 胜出。
    expect(roster[0].connectionId).toBe('ssh-1')
  })

  it('collapses duplicate profile rows within one connection', () => {
    const roster = buildAgentRoster([
      { connection: conn('a', 'A'), profiles: ['default', 'default', 'research'] },
    ])

    expect(roster.map((a) => a.profile)).toEqual(['default', 'research'])
  })

  it('carries profileMetadata through to the roster rows', () => {
    const roster = buildAgentRoster([
      {
        connection: conn('a', 'A'),
        profiles: ['default'],
        profileMetadata: { default: { display_name: 'Hermes', title: 'Main bot' } },
      },
    ])

    expect(roster[0].profileMetadata).toEqual({
      display_name: 'Hermes',
      title: 'Main bot',
    })
  })

  it('buildRosterPayload shapes agents + sources + primaryConnectionId', () => {
    const payload = buildRosterPayload(
      [
        { connection: conn('a', 'A'), profiles: ['default'], installId: 'i-1' },
        { connection: conn('b', 'B'), profiles: null, error: 'HTTP 401: nope' },
      ],
      'a',
    )

    expect(payload.primaryConnectionId).toBe('a')
    expect(payload.sources).toEqual([
      {
        connectionId: 'a',
        label: 'A',
        kind: 'remote',
        reachable: true,
        installId: 'i-1',
      },
      {
        connectionId: 'b',
        label: 'B',
        kind: 'remote',
        reachable: false,
        error: 'HTTP 401: nope',
      },
    ])
    expect(payload.agents.map((a) => a.connectionId)).toEqual(['a'])
  })
})

describe('enumerateRosterSources', () => {
  it('reads /api/profiles per connection, seeds `default`, and reports failures', async () => {
    const api = vi.fn(
      async (request: { connectionId?: null | string; path: string }) => {
        if (request.path === '/api/status') {
          return { install_id: `id-${request.connectionId}` }
        }

        if (request.connectionId === 'broken') {
          throw new Error('HTTP 401: unauthorized')
        }

        return {
          profiles: [
            { name: 'research', bot_title: 'Researcher', has_avatar: true },
            { name: '' },
          ],
        }
      },
    )

    const sources = await enumerateRosterSources({
      api: api as never,
      connections: [conn('ok', 'Ok'), conn('broken', 'Broken')],
    })

    expect(sources[0]).toMatchObject({
      profiles: ['default', 'research'],
      installId: 'id-ok',
      profileMetadata: { research: { title: 'Researcher', has_avatar: true } },
    })
    expect(sources[1]).toMatchObject({
      profiles: null,
      error: 'HTTP 401: unauthorized',
      needsSignIn: true,
    })
  })

  it('keeps the profile list when the install-id probe fails', async () => {
    const api = vi.fn(async (request: { path: string }) => {
      if (request.path === '/api/status') {
        throw new Error('HTTP 404')
      }

      return { profiles: [{ name: 'default' }] }
    })

    const sources = await enumerateRosterSources({
      api: api as never,
      connections: [conn('a', 'A')],
    })

    expect(sources[0].profiles).toEqual(['default'])
    expect(sources[0].installId).toBeUndefined()
    // 上游对每个具名 profile 都产出一条（可为空对象），不按「非空」裁剪。
    expect(sources[0].profileMetadata).toEqual({ default: {} })
  })
})
