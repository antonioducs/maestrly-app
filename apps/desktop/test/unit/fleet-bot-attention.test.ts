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
})
