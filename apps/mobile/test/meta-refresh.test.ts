import { FLEET_ATTENTION_FEATURE, FLEET_ENVIRONMENTS_FEATURE, FLEET_PHONES_FEATURE } from '@maestrly/bot-fleet-protocol'
import { describe, expect, it, vi } from 'vitest'
import { DEMO_SERVER } from '../src/demo/demo-source'
import { createMetaFeatureRefresher, META_REFRESH_THROTTLE_MS } from '../src/servers/meta-refresh'
import type { PairedServer } from '../src/servers/registry'

function server(id: string, features: string[]): PairedServer {
  return {
    id,
    origin: `https://${id}.example.dev`,
    name: id,
    deviceName: 'iPhone',
    features,
    pairedAt: '2026-10-12T12:00:00.000Z',
  }
}

describe('meta feature refresher (N6)', () => {
  it('refreshes /v1/meta for all paired non-demo servers, updating upgraded and downgraded gateways', async () => {
    let clock = 1_000_000
    const metaByServer: Record<string, { features: string[]; moreFeatures?: string[] }> = {
      active: { features: [FLEET_PHONES_FEATURE], moreFeatures: [FLEET_ATTENTION_FEATURE] },
      upgraded: {
        features: [FLEET_PHONES_FEATURE, FLEET_ENVIRONMENTS_FEATURE],
        moreFeatures: [FLEET_ATTENTION_FEATURE],
      },
      downgraded: { features: [FLEET_PHONES_FEATURE] },
      unchanged: { features: [FLEET_PHONES_FEATURE], moreFeatures: [FLEET_ATTENTION_FEATURE] },
    }
    const callCounts: Record<string, number> = {}
    const onFeatures = vi.fn()
    const refresher = createMetaFeatureRefresher({
      throttleMs: META_REFRESH_THROTTLE_MS,
      now: () => clock,
      clientFor: async (item) => ({
        call: vi.fn(async (route: string) => {
          expect(route).toBe('meta')
          callCounts[item.id] = (callCounts[item.id] ?? 0) + 1
          if (item.id === 'offline') throw new Error('network error')
          const spec = metaByServer[item.id]
          return {
            protocol: 1,
            gatewayVersion: '1.0.0',
            botImage: 'x',
            botImageVersion: null,
            features: spec.features,
            ...(spec.moreFeatures ? { moreFeatures: spec.moreFeatures } : {}),
          }
        }) as never,
      }),
      onFeatures,
    })

    const servers = [
      DEMO_SERVER,
      server('active', [FLEET_PHONES_FEATURE]),
      server('upgraded', [FLEET_PHONES_FEATURE]),
      server('downgraded', [FLEET_PHONES_FEATURE, FLEET_ATTENTION_FEATURE]),
      server('unchanged', [FLEET_PHONES_FEATURE, FLEET_ATTENTION_FEATURE]),
      server('offline', [FLEET_PHONES_FEATURE]),
    ]

    await refresher.refresh(servers)

    // Demo server is never queried; every other server is queried once.
    expect(callCounts[DEMO_SERVER.id]).toBeUndefined()
    expect(callCounts).toEqual({ active: 1, upgraded: 1, downgraded: 1, unchanged: 1, offline: 1 })
    expect(onFeatures).toHaveBeenCalledTimes(3)
    expect(onFeatures).toHaveBeenCalledWith('active', [FLEET_PHONES_FEATURE, FLEET_ATTENTION_FEATURE])
    expect(onFeatures).toHaveBeenCalledWith('upgraded', [
      FLEET_PHONES_FEATURE,
      FLEET_ENVIRONMENTS_FEATURE,
      FLEET_ATTENTION_FEATURE,
    ])
    expect(onFeatures).toHaveBeenCalledWith('downgraded', [FLEET_PHONES_FEATURE])

    // Immediate foreground refresh within throttle window is skipped.
    clock += META_REFRESH_THROTTLE_MS - 1
    await refresher.refresh(servers)
    expect(callCounts).toEqual({ active: 1, upgraded: 1, downgraded: 1, unchanged: 1, offline: 1 })

    // After throttle window passes, foreground refresh queries every server again.
    clock += 1
    await refresher.refresh(servers)
    expect(callCounts).toEqual({ active: 2, upgraded: 2, downgraded: 2, unchanged: 2, offline: 2 })

    refresher.stop()
  })
})
