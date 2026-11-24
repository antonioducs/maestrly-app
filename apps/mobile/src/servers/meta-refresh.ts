import { fleetMetaFeatures } from '@maestrly/bot-fleet-protocol'
import { DEMO_SERVER } from '../demo/demo-source'
import type { GatewayClient } from '../gateway/client'
import type { PairedServer } from './registry'

/** Minimum interval between `/v1/meta` feature refreshes for the same server. */
export const META_REFRESH_THROTTLE_MS = 60_000

/** True when two feature lists contain the exact same entries in the same order. */
export function sameFeatures(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export interface MetaFeatureRefresherOptions {
  clientFor: (server: PairedServer) => Promise<Pick<GatewayClient, 'call'> | null>
  onFeatures: (serverId: string, features: string[]) => Promise<void> | void
  throttleMs?: number
  now?: () => number
}

export interface MetaFeatureRefresher {
  /** Refreshes `/v1/meta` features for every paired non-demo server not recently refreshed. */
  refresh(servers: readonly PairedServer[]): Promise<void>
  stop(): void
}

/**
 * Periodically (throttled per server) queries `/v1/meta` for every paired server on start and on foreground so
 * upgraded non-active gateways start getting attention watchers and downgraded gateways stop receiving `badgeOthers`.
 */
export function createMetaFeatureRefresher(options: MetaFeatureRefresherOptions): MetaFeatureRefresher {
  const throttleMs = options.throttleMs ?? META_REFRESH_THROTTLE_MS
  const now = options.now ?? Date.now
  const lastAttemptAt = new Map<string, number>()
  const inFlight = new Set<string>()
  let stopped = false

  return {
    async refresh(servers) {
      if (stopped) return
      const known = new Set(servers.map((server) => server.id))
      for (const id of lastAttemptAt.keys()) {
        if (!known.has(id)) lastAttemptAt.delete(id)
      }
      const currentNow = now()
      const tasks: Promise<void>[] = []
      for (const server of servers) {
        if (server.id === DEMO_SERVER.id) continue
        if (inFlight.has(server.id)) continue
        const last = lastAttemptAt.get(server.id)
        if (last !== undefined && currentNow - last < throttleMs) continue
        lastAttemptAt.set(server.id, currentNow)
        inFlight.add(server.id)
        tasks.push(
          (async () => {
            try {
              const client = await options.clientFor(server)
              if (!client || stopped) return
              const meta = await client.call('meta')
              if (stopped) return
              const next = fleetMetaFeatures(meta)
              if (!sameFeatures(server.features, next)) {
                await options.onFeatures(server.id, next)
              }
            } catch {
              // Unreachable or unauthorized for now: keep the last known feature list.
            } finally {
              inFlight.delete(server.id)
            }
          })()
        )
      }
      await Promise.all(tasks)
    },
    stop() {
      stopped = true
      inFlight.clear()
      lastAttemptAt.clear()
    },
  }
}
