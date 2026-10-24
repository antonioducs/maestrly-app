import { describe, expect, it } from 'vitest'
import { FleetBotAttention } from '../../src/main/notifications/bot-attention'
import type { FleetBotAttentionChange } from '../../src/shared/notifications'
import type { FleetServerId } from '../../src/shared/fleet-servers'

const S1 = 'aaaaaaaa-0000-4000-8000-000000000001' as FleetServerId
const S2 = 'bbbbbbbb-0000-4000-8000-000000000002' as FleetServerId

function setup(stored: string | null = null, max?: number) {
  let saved = stored
  const changes: FleetBotAttentionChange[] = []
  const attention = new FleetBotAttention({
    load: () => saved,
    save: (value) => {
      saved = value
    },
    emit: (change) => void changes.push(change),
    ...(max ? { max } : {}),
  })
  return { attention, changes, saved: () => saved }
}

describe('FleetBotAttention', () => {
  it('marks and clears a bot of a server once, and keeps the marks', () => {
    const s = setup()
    s.attention.mark(S1, 'alex')
    s.attention.mark(S1, 'alex')
    s.attention.mark(S2, 'alex')
    expect(s.attention.has(S1, 'alex')).toBe(true)
    expect(s.attention.list()).toEqual([
      { serverId: S1, botId: 'alex' },
      { serverId: S2, botId: 'alex' },
    ])
    expect(s.attention.clear(S1, 'alex')).toBe(true)
    expect(s.attention.clear(S1, 'alex')).toBe(false)
    expect(s.changes).toEqual([
      { serverId: S1, botId: 'alex', attention: true },
      { serverId: S2, botId: 'alex', attention: true },
      { serverId: S1, botId: 'alex', attention: false },
    ])
    expect(setup(s.saved()).attention.list()).toEqual([{ serverId: S2, botId: 'alex' }])
  })

  it('reads back only the marks of valid servers and bots', () => {
    const stored = JSON.stringify([`${S1}/alex`, 'Not A Server/alex', `${S1}/`, 42, `${S2}/${'x'.repeat(300)}`])
    expect(setup(stored).attention.list()).toEqual([{ serverId: S1, botId: 'alex' }])
    expect(setup('{').attention.list()).toEqual([])
  })

  it('drops the marks of servers no longer paired', () => {
    const s = setup()
    s.attention.mark(S1, 'alex')
    s.attention.mark(S2, 'sam')
    s.attention.retain(new Set([S2]))
    expect(s.attention.list()).toEqual([{ serverId: S2, botId: 'sam' }])
    expect(s.changes.at(-1)).toEqual({ serverId: S1, botId: 'alex', attention: false })
  })

  it('keeps the newest marks within its bound', () => {
    const s = setup(null, 2)
    for (const bot of ['a', 'b', 'c']) s.attention.mark(S1, bot)
    expect(s.attention.list().map(({ botId }) => botId)).toEqual(['b', 'c'])
  })

  it('lets the side conversations a mark is for clear it once all are seen, across restarts', () => {
    const s = setup()
    s.attention.mark(S1, 'alex', 'run:r1')
    s.attention.mark(S1, 'alex', 'thread:t1')
    s.attention.mark(S1, 'alex', 'thread:t1')
    expect(s.changes).toEqual([{ serverId: S1, botId: 'alex', attention: true }])
    expect(s.attention.seenLane(S1, 'alex', 'run:r1')).toBe(false)
    expect(s.attention.seenLane(S1, 'alex', 'run:other')).toBe(false)
    const reopened = setup(s.saved())
    expect(reopened.attention.list()).toEqual([{ serverId: S1, botId: 'alex' }])
    expect(reopened.attention.seenLane(S1, 'alex', 'thread:t1')).toBe(true)
    expect(reopened.changes).toEqual([{ serverId: S1, botId: 'alex', attention: false }])
    expect(setup(reopened.saved()).attention.list()).toEqual([])
  })

  it('keeps a mark that something only this computer clears holds, as a key older versions read', () => {
    const s = setup()
    s.attention.mark(S1, 'alex', 'run:r1')
    s.attention.mark(S1, 'alex')
    expect(s.attention.seenLane(S1, 'alex', 'run:r1')).toBe(false)
    expect(s.attention.has(S1, 'alex')).toBe(true)
    s.attention.mark(S2, 'sam', 'run:r2')
    expect(JSON.parse(s.saved()!)).toEqual([`${S1}/alex`, { key: `${S2}/sam`, lanes: ['run:r2'] }])
    // A mark stored before side conversations were told apart is this computer's to clear.
    const legacy = setup(JSON.stringify([`${S1}/alex`]))
    expect(legacy.attention.seenLane(S1, 'alex', 'run:r1')).toBe(false)
    expect(legacy.attention.has(S1, 'alex')).toBe(true)
  })

  it('reads back only valid marks of side conversations, and keeps one for too many as its own', () => {
    const many = Array.from({ length: 21 }, (_, index) => `run:r${index}`)
    const stored = JSON.stringify([
      { key: `${S1}/alex`, lanes: ['run:r1', 42, ''] },
      { key: `${S1}/sam`, lanes: [] },
      { key: 'Not A Server/alex', lanes: ['run:r1'] },
      { key: `${S2}/many`, lanes: many },
    ])
    const s = setup(stored)
    expect(s.attention.list()).toEqual([
      { serverId: S1, botId: 'alex' },
      { serverId: S2, botId: 'many' },
    ])
    expect(s.attention.seenLane(S1, 'alex', 'run:r1')).toBe(true)
    expect(s.attention.seenLane(S2, 'many', 'run:r0')).toBe(false)
    expect(s.attention.has(S2, 'many')).toBe(true)
    // Past the side conversations a mark names, it becomes this computer's to clear.
    const t = setup()
    for (const lane of many) t.attention.mark(S1, 'alex', lane)
    expect(t.attention.seenLane(S1, 'alex', 'run:r0')).toBe(false)
    expect(t.attention.has(S1, 'alex')).toBe(true)
  })
})
