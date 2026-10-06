import { expect, it } from 'vitest'
import { BotConversationProjection } from '../../src/main/bot/projection'

it('publishes only public final text, not reasoning or raw tool arguments and output', () => {
  const events: Record<string, unknown>[] = []
  const projection = new BotConversationProjection((event) => events.push(event))
  projection.receive({ channel: 'chat:delta:local', payload: { kind: 'message-start', messageId: 'm' } })
  projection.receive({
    channel: 'chat:delta:local',
    payload: { kind: 'reasoning-delta', messageId: 'm', delta: 'private reasoning' },
  })
  projection.receive({
    channel: 'chat:delta:local',
    payload: { kind: 'tool-call', messageId: 'm', toolName: 'read', input: { password: 'private-tool-input' } },
  })
  projection.receive({
    channel: 'chat:delta:local',
    payload: { kind: 'tool-state', messageId: 'm', state: { output: 'private-tool-result' } },
  })
  projection.receive({
    channel: 'chat:delta:local',
    payload: { kind: 'text-delta', messageId: 'm', partId: 'p', delta: 'Result: Bear' },
  })
  projection.receive({
    channel: 'chat:delta:local',
    payload: { kind: 'text-delta', messageId: 'm', partId: 'p', delta: 'er secret-value' },
  })
  expect(events).toEqual([])
  projection.finish()
  expect(JSON.stringify(events)).not.toMatch(/private|secret-value/)
  expect(events).toEqual([{ type: 'message', messageId: 'm', role: 'assistant', text: 'Result: Bearer [redacted]' }])
})

it('marks permission and plan gates as owner-only and deduplicates ordinary questions', () => {
  const events: Record<string, unknown>[] = []
  const projection = new BotConversationProjection((event) => events.push(event))
  const question = {
    channel: 'question',
    payload: { toolCallId: 'q1', questions: [{ header: 'Color', question: 'Which color?', options: [] }] },
  }
  projection.receive(question)
  projection.receive(question)
  projection.receive({
    channel: 'chat:permission:local',
    payload: {
      kind: 'request',
      request: { id: 'p1', title: 'Write file', resources: ['/secret/path'], action: 'edit' },
    },
  })
  projection.receive({
    channel: 'plan:received',
    payload: { version: 1, title: 'Review plan', plan: 'private full plan' },
  })
  expect(events).toHaveLength(3)
  expect(events[0]).toMatchObject({
    type: 'interaction',
    interaction: { requestId: 'q1', type: 'question', ownerOnly: false },
  })
  expect(events[1]).toMatchObject({
    type: 'interaction',
    interaction: { requestId: 'p1', type: 'permission', ownerOnly: true },
  })
  expect(events[2]).toMatchObject({ type: 'interaction', interaction: { type: 'plan', ownerOnly: true } })
  expect(JSON.stringify(events)).not.toMatch(/secret\/path|private full plan/)
})
