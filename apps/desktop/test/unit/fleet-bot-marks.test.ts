import { describe, expect, it } from 'vitest'
import {
  applyBotAttention,
  botsTabCounts,
  markedBots,
  notificationFleetView,
} from '../../src/renderer/lib/fleet/bot-attention'
import type { FleetServerId } from '../../src/shared/fleet-servers'

const S1 = 'aaaaaaaa-0000-4000-8000-000000000001' as FleetServerId
const S2 = 'bbbbbbbb-0000-4000-8000-000000000002' as FleetServerId

describe('bot marks in the window', () => {
  it('applies a change, keeping the same set when nothing changes', () => {
    const none = new Set<string>()
    const marked = applyBotAttention(none, { serverId: S1, botId: 'alex', attention: true })
    expect([...marked]).toEqual([`${S1}/alex`])
    expect(applyBotAttention(marked, { serverId: S1, botId: 'alex', attention: true })).toBe(marked)
    expect([...applyBotAttention(marked, { serverId: S1, botId: 'alex', attention: false })]).toEqual([])
    expect(applyBotAttention(none, { serverId: S1, botId: 'alex', attention: false })).toBe(none)
  })

  it('counts the requests and the marked bots each server lists', () => {
    const marks = new Set([`${S1}/alex`, `${S1}/gone`, `${S2}/alex`])
    expect([...markedBots(marks, S1, [{ id: 'alex' }, { id: 'sam' }])]).toEqual(['alex'])
    expect(
      botsTabCounts(marks, [
        { serverId: S1, inbox: 2, bots: [{ id: 'alex' }, { id: 'sam' }] },
        { serverId: S2, inbox: 0, bots: [] },
      ])
    ).toEqual({ [S1]: 3, [S2]: 0 })
  })

  it('opens what a bot notification is about', () => {
    expect(notificationFleetView({ botId: 'alex' })).toEqual({ kind: 'bot', botId: 'alex', tab: 'conversation' })
    expect(notificationFleetView({ botId: 'alex', runId: 'run-1' })).toEqual({
      kind: 'bot',
      botId: 'alex',
      tab: 'runs',
      runId: 'run-1',
    })
    expect(notificationFleetView({ botId: 'alex', threadId: 't-1' })).toEqual({
      kind: 'bot',
      botId: 'alex',
      tab: 'conversation',
      threadId: 't-1',
    })
  })
})
