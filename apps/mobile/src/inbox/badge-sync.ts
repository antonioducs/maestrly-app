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
  syncPushBadge: (badgeOthersByServer: Readonly<Record<string, number>>) => Promise<void> | void
  debounceMs?: number
}

export interface BadgeSync {
  /** Updates the app-icon badge immediately on total change and schedules debounced `badgeOthers` push sync. */
  update(total: number, badgeOthers: Readonly<Record<string, number>>): void
  /** Flushes pending or current `badgeOthers` immediately (called when the app moves to background). */
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
 * - OS badge updates immediately whenever `total` changes (including `0` when cleared).
 * - `badgeOthers` syncs to attention-capable servers debounced (~2 s) on changes and immediately on background.
 */
export function createBadgeSync(options: BadgeSyncOptions): BadgeSync {
  const debounceMs = options.debounceMs ?? BADGE_OTHERS_DEBOUNCE_MS
  let lastBadge: number | null = null
  let lastSentOthers: Record<string, number> = {}
  let latestOthers: Record<string, number> = {}
  let dirtyOthers = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const sendOthers = (forceAll: boolean) => {
    clearTimer()
    if (stopped) return
    const payload: Record<string, number> = {}
    for (const [serverId, value] of Object.entries(latestOthers)) {
      if (forceAll || lastSentOthers[serverId] !== value) payload[serverId] = value
    }
    dirtyOthers = false
    if (Object.keys(payload).length === 0) return
    lastSentOthers = { ...latestOthers }
    void Promise.resolve(options.syncPushBadge(payload)).catch(() => {})
  }

  return {
    update(total, badgeOthers) {
      if (stopped) return
      const normalized = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0))
      if (lastBadge !== normalized) {
        lastBadge = normalized
        void Promise.resolve(options.setBadge(normalized)).catch(() => {})
      }
      if (!sameRecord(latestOthers, badgeOthers)) {
        latestOthers = { ...badgeOthers }
        dirtyOthers = !sameRecord(lastSentOthers, latestOthers)
        if (dirtyOthers) {
          clearTimer()
          timer = setTimeout(() => sendOthers(false), debounceMs)
        } else {
          clearTimer()
        }
      }
    },
    flushOnBackground() {
      if (stopped) return
      if (Object.keys(latestOthers).length === 0) {
        clearTimer()
        return
      }
      sendOthers(true)
    },
    stop() {
      stopped = true
      clearTimer()
    },
  }
}
