import { describe, expect, it, vi } from 'vitest'
import { listDeliveries } from '@/plugins/hermes-bots/teammate-waits'
import { host } from '@hermes/plugin-sdk'

vi.mock('@hermes/plugin-sdk', async () => ({
  atom: (await import('nanostores')).atom,
  host: { request: vi.fn(), requestProfile: vi.fn() },
}))
vi.mock('@/plugins/hermes-bots/avatar', () => ({}))
vi.mock('@/plugins/hermes-bots/data', () => ({}))
vi.mock('@/plugins/hermes-bots/i18n', () => ({}))
vi.mock('@/plugins/hermes-bots/roster-actions', () => ({}))

describe('teammate waits in Bot Chat', () => {
  it('scopes the query to the sending Bot even on an unscoped roster row', async () => {
    vi.mocked(host.request).mockResolvedValue({ deliveries: [] })

    await expect(listDeliveries({ name: 'research' })).resolves.toEqual([])
    expect(host.request).toHaveBeenCalledWith('bot_delivery.list', {
      profile: 'research',
    })
  })

  it('sends the backend profile on the owning connection for an aliased Bot', async () => {
    const route = {
      connectionId: 'other-gateway',
      mode: 'remote' as const,
      profile: 'research-alias',
      targetProfile: 'research',
    }
    vi.mocked(host.requestProfile).mockResolvedValue({ deliveries: [] })

    await expect(
      listDeliveries({ name: route.profile, route, sourceScoped: true }),
    ).resolves.toEqual([])
    expect(host.requestProfile).toHaveBeenCalledWith(route, 'bot_delivery.list', {
      profile: 'research',
    })
  })
})
