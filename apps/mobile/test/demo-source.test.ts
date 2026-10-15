import type { FleetGatewayEvent } from '@maestrly/bot-fleet-protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDemoSource, DEMO_SERVER } from '../src/demo/demo-source'
import { GatewayError } from '../src/gateway/client'

const KEY = '550e8400-e29b-41d4-a716-446655440000'

function listen(source: ReturnType<typeof createDemoSource>) {
  const events: FleetGatewayEvent[] = []
  source.openEvents({ onEvent: (event) => events.push(event), onState: () => {} })
  return events
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('demo server', () => {
  it('serves the prototype’s bots, environments and pending requests', async () => {
    const source = createDemoSource({ stepMs: 0, autoplay: false })
    expect(source.serverId).toBe(DEMO_SERVER.id)
    const { bots } = await source.call('botsList')
    expect(bots.map((bot) => bot.name)).toEqual(['Juno', 'Atlas', 'Pixel', 'Ledger', 'Scout'])
    const { environments } = await source.call('environmentsList')
    expect(environments.map((environment) => [environment.name, environment.kind])).toEqual([
      ['studio', 'bots'],
      ['research', 'bots'],
      ['Personal', 'workspaces'],
      ['Company', 'workspaces'],
    ])
    expect(bots.find((bot) => bot.id === 'scout')?.status).toBe('offline')
    expect(bots.find((bot) => bot.id === 'atlas')?.status).toBe('waiting')
    const { items } = await source.call('inbox')
    expect(items.find((item) => item.botId === 'atlas')?.interaction.kind).toBe('permission')
    const page = await source.call('botTranscript', { params: { id: 'ledger' }, query: { limit: 50 } })
    expect(page.items).toHaveLength(50)
    expect(page.before).not.toBeNull()
    const older = await source.call('botTranscript', {
      params: { id: 'ledger' },
      query: { limit: 50, before: page.before },
    })
    expect(older.before).toBeNull()
    expect((older.items.at(-1)?.at ?? '') < page.items[0].at).toBe(true)
  })

  it('answers a message with a streamed turn, once per idempotency key', async () => {
    const source = createDemoSource({ stepMs: 0, autoplay: false })
    const events = listen(source)
    await vi.runAllTimersAsync()
    events.length = 0
    const body = { text: 'Who spent the most?', idempotencyKey: KEY, attachments: [] }
    const receipt = await source.call('botMessageSend', { params: { id: 'ledger' }, body })
    await vi.runAllTimersAsync()
    const trace = events.flatMap((event) => {
      if (event.type === 'bot.updated') return [`bot:${event.bot.status}`]
      if (event.type !== 'transcript.upsert') return []
      const item = event.item
      if (item.kind === 'tool') return [`tool:${item.state}`]
      if (item.kind === 'assistant') return [`assistant:${item.streaming ? 'streaming' : 'done'}`]
      return [item.kind]
    })
    const order = [
      'user',
      'bot:working',
      'tool:running',
      'tool:done',
      'assistant:streaming',
      'assistant:done',
      'bot:idle',
    ]
    let at = -1
    for (const step of order) {
      const next = trace.indexOf(step, at + 1)
      expect(next, `${step} in ${trace.join(' ')}`).toBeGreaterThan(at)
      at = next
    }
    const idle = events.filter((event) => event.type === 'bot.updated').at(-1)
    expect(
      idle?.type === 'bot.updated' && idle.bot.activity?.kind === 'idle' && idle.bot.activity.lastTurnSummary
    ).toBeTruthy()
    const count = events.length
    expect(await source.call('botMessageSend', { params: { id: 'ledger' }, body })).toEqual(receipt)
    await vi.runAllTimersAsync()
    expect(events).toHaveLength(count)
  })

  it('runs the deploy once Atlas’s command is allowed', async () => {
    const source = createDemoSource({ stepMs: 0, autoplay: false })
    const events = listen(source)
    const { items } = await source.call('inbox')
    const request = items.find((item) => item.botId === 'atlas')!.interaction
    await source.call('botInteractionResolve', {
      params: { id: 'atlas', interactionId: request.id },
      body: { kind: 'permission', reply: 'once' },
    })
    await vi.runAllTimersAsync()
    const inbox = events.filter((event) => event.type === 'inbox.updated').at(-1)
    expect(inbox?.type === 'inbox.updated' && inbox.items.some((item) => item.botId === 'atlas')).toBe(false)
    const targets = events.flatMap((event) =>
      event.type === 'transcript.upsert' && event.item.kind === 'tool' ? [event.item.target] : []
    )
    expect(targets).toContain('npm run deploy:staging')
  })

  it('changes a bot’s model and lists the models its accounts offer', async () => {
    const source = createDemoSource({ stepMs: 0, autoplay: false })
    const events = listen(source)
    const { options } = await source.call('botSelections', { params: { id: 'ledger' } })
    expect([...new Set(options.map((option) => option.providerLabel))]).toEqual(['Claude', 'OpenAI', 'Gemini'])
    const opus = options.find((option) => option.modelId === 'claude-opus-5-5')!
    expect(opus).toMatchObject({ fastMode: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] })
    const selection = { providerId: opus.providerId, modelId: opus.modelId, reasoning: 'low', fastMode: false }
    const bot = await source.call('botPatch', { params: { id: 'ledger' }, body: { selection } })
    expect(bot.selection).toEqual(selection)
    expect(events.some((event) => event.type === 'bot.updated' && event.bot.selection?.modelId === opus.modelId)).toBe(
      true
    )
  })

  it('refuses what the demo does not offer', async () => {
    const source = createDemoSource({ stepMs: 0, autoplay: false })
    await expect(source.call('botSkillsList', { params: { id: 'juno' } })).rejects.toBeInstanceOf(GatewayError)
    await expect(source.call('botSkillsList', { params: { id: 'juno' } })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
