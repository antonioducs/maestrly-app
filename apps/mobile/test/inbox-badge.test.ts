import { FLEET_ATTENTION_FEATURE, FLEET_PHONES_FEATURE } from '@maestrly/bot-fleet-protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BADGE_OTHERS_DEBOUNCE_MS, computeBadgeOthers, createBadgeSync } from '../src/inbox/badge-sync'
import { pushLink, registerWithServers } from '../src/notifications/push'
import type { PairedServer } from '../src/servers/registry'

const server = (id: string, features: string[]): PairedServer => ({
  id,
  origin: `https://${id}.example.dev`,
  name: id,
  deviceName: 'iPhone',
  features,
  pairedAt: '2026-10-13T12:00:00.000Z',
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('inbox badge & badgeOthers sync', () => {
  it('computes badgeOthers = total - ownCount only for servers advertising attention', () => {
    const servers = [
      server('s1', [FLEET_PHONES_FEATURE, FLEET_ATTENTION_FEATURE]),
      server('s2', [FLEET_PHONES_FEATURE, FLEET_ATTENTION_FEATURE]),
      server('s-old', [FLEET_PHONES_FEATURE]),
    ]
    const items = [
      { serverId: 's1', group: 'waiting' as const },
      { serverId: 's1', group: 'new' as const },
      { serverId: 's1', group: 'read' as const }, // ignored in badge counts
      { serverId: 's2', group: 'new' as const },
      { serverId: 's-old', group: 'waiting' as const },
    ]

    // total = 4 (s1: 2, s2: 1, s-old: 1)
    expect(computeBadgeOthers(servers, items)).toEqual({
      s1: 2, // 4 - 2
      s2: 3, // 4 - 1
    })
    expect('s-old' in computeBadgeOthers(servers, items)).toBe(false)
  })

  it('updates OS badge immediately on change (including 0) and debounces badgeOthers sync (~2s) with background flush', async () => {
    const setBadge = vi.fn()
    const syncPushBadge = vi.fn()
    const sync = createBadgeSync({ setBadge, syncPushBadge })

    // Initial update: sets badge to 3 immediately, debounces badgeOthers.
    sync.update(3, { s1: 1, s2: 2 })
    expect(setBadge).toHaveBeenCalledTimes(1)
    expect(setBadge).toHaveBeenCalledWith(3)
    expect(syncPushBadge).not.toHaveBeenCalled()

    // Rapid update within debounce window coalesces badgeOthers, updates OS badge immediately.
    await vi.advanceTimersByTimeAsync(1_000)
    sync.update(4, { s1: 2, s2: 2 })
    expect(setBadge).toHaveBeenCalledTimes(2)
    expect(setBadge).toHaveBeenLastCalledWith(4)
    expect(syncPushBadge).not.toHaveBeenCalled()

    // Repeating same values does not trigger duplicate badge call.
    sync.update(4, { s1: 2, s2: 2 })
    expect(setBadge).toHaveBeenCalledTimes(2)

    // After debounce window, syncPushBadge fires once with the latest values.
    await vi.advanceTimersByTimeAsync(BADGE_OTHERS_DEBOUNCE_MS)
    expect(syncPushBadge).toHaveBeenCalledTimes(1)
    expect(syncPushBadge).toHaveBeenCalledWith({ s1: 2, s2: 2 })

    // Clearing everything sets OS badge to 0 immediately.
    sync.update(0, { s1: 0, s2: 0 })
    expect(setBadge).toHaveBeenLastCalledWith(0)
    expect(syncPushBadge).toHaveBeenCalledTimes(1)

    // Backgrounding flushes immediately without waiting for debounce.
    sync.flushOnBackground()
    expect(syncPushBadge).toHaveBeenCalledTimes(2)
    expect(syncPushBadge).toHaveBeenLastCalledWith({ s1: 0, s2: 0 })

    // Advancing timers afterwards does not re-fire the cancelled debounce timer.
    await vi.advanceTimersByTimeAsync(BADGE_OTHERS_DEBOUNCE_MS * 2)
    expect(syncPushBadge).toHaveBeenCalledTimes(2)
    sync.stop()
  })

  it('never sends badgeOthers to gateways without FLEET_ATTENTION_FEATURE in registerWithServers', async () => {
    const sent: Record<string, unknown> = {}
    const results = await registerWithServers({
      servers: [
        server('modern', [FLEET_PHONES_FEATURE, FLEET_ATTENTION_FEATURE]),
        server('legacy', [FLEET_PHONES_FEATURE]),
      ],
      token: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
      platform: 'ios',
      locale: 'en-US',
      preferences: { waiting: true, replies: true, routines: true, errors: true },
      // Even if a caller supplies a value for `legacy`, registerWithServers must gate it out.
      badgeOthersByServer: { modern: 5, legacy: 3 },
      clientFor: async (item) => ({
        call: vi.fn(async (_route: string, options?: { body?: unknown }) => {
          sent[item.id] = options?.body
          return {} as never
        }) as never,
      }),
    })

    expect(results).toEqual({ modern: 'registered', legacy: 'registered' })
    expect(sent.modern).toMatchObject({ badgeOthers: 5 })
    expect('badgeOthers' in (sent.legacy as Record<string, unknown>)).toBe(false)
  })

  it('formats pushLink for bot routine runs and peer threads', () => {
    expect(pushLink({ serverId: 's1', kind: 'bot', id: 'atlas', runId: 'run-1' })).toBe(
      '/lane/atlas?kind=run&lane=run-1&server=s1'
    )
    expect(pushLink({ serverId: 's1', kind: 'bot', id: 'atlas', threadId: 'thread-pixel' })).toBe(
      '/lane/atlas?kind=thread&lane=thread-pixel&server=s1'
    )
  })
})
