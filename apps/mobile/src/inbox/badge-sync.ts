import { FLEET_ATTENTION_FEATURE } from '@maestrly/bot-fleet-protocol'
import type { MobileInboxItem } from './types'

const BADGE_OTHERS_MAX = 99_999
export const BADGE_OTHERS_DEBOUNCE_MS = 2_000

export interface BadgeServerRef {
  id: string
  features: readonly string[]
}

/**
 * Computes `badgeOthers = total - serverOwnCount` for each paired server advertising `FLEET_ATTENTION_FEATURE`.
 * Servers without the feature are omitted so older gateways never receive `badgeOthers` on their strict push schema.
 */
export function computeBadgeOthers(
  servers: readonly BadgeServerRef[],
  items: readonly Pick<MobileInboxItem, 'serverId' | 'group'>[]
): Record<string, number> {
  const perServer = new Map<string, number>()
  let total = 0
  for (const item of items) {
    if (item.group !== 'waiting' && item.group !== 'new') continue
    total++
    perServer.set(item.serverId, (perServer.get(item.serverId) ?? 0) + 1)
  }
  const result: Record<string, number> = {}
  for (const server of servers) {
    if (!server.features.includes(FLEET_ATTENTION_FEATURE)) continue
    const own = perServer.get(server.id) ?? 0
    result[server.id] = Math.max(0, Math.min(BADGE_OTHERS_MAX, total - own))
  }
  return result
}

export interface BadgeSyncOptions {
  setBadge: (count: number) => Promise<void> | void
  /**
   * Sends updated `badgeOthers` values for changed attention-capable servers. May return a per-server success map
   * (`true` = registered); returning `void` treats every server in the payload as succeeded, and rejecting marks none.
   */
  syncPushBadge: (
    badgeOthersByServer: Readonly<Record<string, number>>
  ) => Promise<Readonly<Record<string, boolean>> | void> | Readonly<Record<string, boolean>> | void
  debounceMs?: number
}

export interface BadgeSync {
  /** Updates the app-icon badge immediately on total change and schedules debounced `badgeOthers` push sync. */
  update(total: number, badgeOthers: Readonly<Record<string, number>>): void
  /**
   * Resets the remembered last badge and immediately re-applies the current local total to the OS icon badge
   * (called on foreground and after a foreground notification, so incoming push badges never leave the icon drifted).
   */
  reapplyBadge(): void
  /** Flushes any `badgeOthers` entries that changed since the last successful send (called on app background). */
  flushOnBackground(): void
  stop(): void
}

function sameRecord(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean {
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) if (a[key] !== b[key]) return false
  return true
}

/**
 * Coordinates the OS app-icon badge (`setBadgeCountAsync`) and per-server `badgeOthers` push registration updates:
 * - OS badge updates immediately whenever `total` changes (including `0` when cleared), and re-applies on demand.
 * - `badgeOthers` syncs to attention-capable servers debounced (~2 s) on changes and flushed on background only for
 *   servers whose value changed since the last successful send.
 */
export function createBadgeSync(options: BadgeSyncOptions): BadgeSync {
  const debounceMs = options.debounceMs ?? BADGE_OTHERS_DEBOUNCE_MS
  let lastBadge: number | null = null
  let lastTotal: number | null = null
  const lastSentOthers: Record<string, number> = {}
  let latestOthers: Record<string, number> = {}
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const changedPayload = (): Record<string, number> => {
    const payload: Record<string, number> = {}
    for (const [serverId, value] of Object.entries(latestOthers)) {
      if (lastSentOthers[serverId] !== value) payload[serverId] = value
    }
    return payload
  }

  const pruneRemovedSent = () => {
    for (const serverId of Object.keys(lastSentOthers)) {
      if (!(serverId in latestOthers)) delete lastSentOthers[serverId]
    }
  }

  const sendOthers = () => {
    clearTimer()
    if (stopped) return
    pruneRemovedSent()
    const payload = changedPayload()
    const sentKeys = Object.keys(payload)
    if (sentKeys.length === 0) return
    void Promise.resolve(options.syncPushBadge(payload))
      .then((outcome) => {
        if (stopped) return
        for (const serverId of sentKeys) {
          const ok = outcome === undefined ? true : outcome[serverId] === true
          if (ok && serverId in latestOthers) lastSentOthers[serverId] = payload[serverId]
        }
      })
      .catch(() => {
        // Leave `lastSentOthers` unchanged so the next update or background flush retries failed servers.
      })
  }

  return {
    update(total, badgeOthers) {
      if (stopped) return
      const normalized = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0))
      lastTotal = normalized
      if (lastBadge !== normalized) {
        lastBadge = normalized
        void Promise.resolve(options.setBadge(normalized)).catch(() => {})
      }
      if (!sameRecord(latestOthers, badgeOthers)) {
        latestOthers = { ...badgeOthers }
        pruneRemovedSent()
        if (Object.keys(changedPayload()).length > 0) {
          clearTimer()
          timer = setTimeout(sendOthers, debounceMs)
        } else {
          clearTimer()
        }
      }
    },
    reapplyBadge() {
      if (stopped) return
      lastBadge = null
      if (lastTotal !== null) {
        lastBadge = lastTotal
        void Promise.resolve(options.setBadge(lastTotal)).catch(() => {})
      }
    },
    flushOnBackground() {
      if (stopped) return
      sendOthers()
    },
    stop() {
      stopped = true
      clearTimer()
    },
  }
}
