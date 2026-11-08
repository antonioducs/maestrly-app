import { describe, expect, it, vi } from 'vitest'
import { FLEET_REASONING_QUERY, FLEET_ROUTINE_CONVERSATIONS_FEATURE } from '@maestrly/bot-fleet-protocol'
import {
  type BotToolDeps,
  type BotToolServer,
  botTranscriptEntries,
  readBot,
  sendBot,
} from '../../src/main/assistant/bot-tools'
import { sendBotMessage } from '../../src/main/fleet/client/bot-actions'
import { botReadInputSchema, botSendInputSchema, BOT_SEND_MAX } from '../../src/main/chat/tools/assistant'

const NOW = Date.parse('2026-11-08T12:00:00Z')
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

const items = [
  { id: 'i1', at: at(30), kind: 'user', text: 'Review PR 12.', source: 'owner', queued: false },
  { id: 'i2', at: at(29), kind: 'reasoning', text: 'thinking', truncated: false, streaming: false },
  { id: 'i3', at: at(28), kind: 'tool', name: 'bash', target: 'gh pr view', state: 'done', output: 'x', images: [] },
  { id: 'i4', at: at(27), kind: 'assistant', text: 'Two comments left.', streaming: false },
  {
    id: 'i5',
    at: at(20),
    kind: 'user',
    text: 'Daily check',
    source: 'routine',
    routine: { id: 'r', title: 'Daily' },
    queued: false,
  },
  { id: 'i6', at: at(19), kind: 'peer_out', to: { botId: 'b2', name: 'Deployer' }, text: 'Ship it.', delivered: true },
  {
    id: 'i7',
    at: at(18),
    kind: 'user',
    text: 'Done here',
    source: 'peer',
    peer: { botId: 'b2', name: 'Deployer' },
    queued: false,
  },
  { id: 'i8', at: at(17), kind: 'system', code: 'restarted', text: null, durationMs: null },
]

function fakeServer(patch: Partial<BotToolServer> & { runs?: boolean; sendError?: Error } = {}) {
  const call = vi.fn(async (route: string, _options?: unknown): Promise<unknown> => {
    if (route === 'botTranscript' || route === 'botRunTranscript') return { items, before: null }
    if (route === 'botRuns')
      return {
        runs: Array.from({ length: 7 }, (_, n) => ({
          id: `run-${n}`,
          routineTitle: 'Daily',
          status: 'completed',
          deliveredAt: at(60 * (n + 1)),
        })),
        before: null,
      }
    if (route === 'botMessageSend') {
      if (patch.sendError) throw patch.sendError
      return { inputId: 'input-1', itemId: 'item-1', queued: true }
    }
    throw new Error(`unexpected ${route}`)
  })
  const server: BotToolServer = {
    fleet: {
      call: call as never,
      hasFeature: (feature: string) => patch.runs !== false && feature === FLEET_ROUTINE_CONVERSATIONS_FEATURE,
      idempotencyKey: () => '550e8400-e29b-41d4-a716-446655440000',
    },
    name: 'vps.example',
    connected: true,
    snapshot: () => ({
      bots: [
        {
          id: 'reviewer',
          name: 'Reviewer',
          role: 'Reviews PRs',
          lifecycle: 'running',
          status: 'idle',
          activity: null,
          runningRun: null,
        },
        {
          id: 'gone',
          name: 'Gone',
          role: '',
          lifecycle: 'archived',
          status: 'offline',
          activity: null,
          runningRun: null,
        },
      ] as never,
      inbox: [],
    }),
    ...patch,
  }
  const deps: BotToolDeps = {
    server: (id) => (id === 'vps' ? server : null),
    viaLine: () => '— via Maestrly Assistant',
    now: () => NOW,
  }
  return { deps, call }
}

describe('bot transcripts', () => {
  it('keeps the messages and what the bot told other bots, without tools, reasoning or system items', () => {
    expect(botTranscriptEntries(items as never)).toEqual([
      { role: 'user', text: 'Review PR 12.' },
      { role: 'assistant', text: 'Two comments left.' },
      { role: 'user', from: 'routine "Daily"', text: 'Daily check' },
      { role: 'assistant', text: 'To Deployer: Ship it.' },
      { role: 'user', from: 'Deployer', text: 'Done here' },
    ])
  })

  it("reads a bot's conversation with its last five routine runs", async () => {
    const { deps, call } = fakeServer()
    const result = await readBot(deps, { ref: 'bot:vps:reviewer', messages: 2 })
    expect(call.mock.calls[0]).toEqual([
      'botTranscript',
      { params: { id: 'reviewer' }, query: { before: undefined, limit: 50, [FLEET_REASONING_QUERY]: 1 } },
    ])
    expect(result).toEqual({
      bot: { ref: 'bot:vps:reviewer', name: 'Reviewer', role: 'Reviews PRs', place: 'vps.example', status: 'idle' },
      messages: [
        { role: 'assistant', text: 'To Deployer: Ship it.' },
        { role: 'user', from: 'Deployer', text: 'Done here' },
      ],
      hasMore: true,
      runs: [1, 2, 3, 4, 5].map((hours, n) => ({
        runId: `run-${n}`,
        routineName: 'Daily',
        status: 'completed',
        started: `${hours} h ago`,
      })),
    })
  })

  it('reads one routine run, without listing runs', async () => {
    const { deps, call } = fakeServer()
    const result = await readBot(deps, { ref: 'bot:vps:reviewer', runId: 'run-3' })
    expect(call.mock.calls.map(([route]) => route)).toEqual(['botRunTranscript'])
    expect(call.mock.calls[0][1]).toMatchObject({ params: { id: 'reviewer', runId: 'run-3' } })
    expect(result).not.toHaveProperty('runs')
  })

  it('leaves the runs out when the gateway keeps none', async () => {
    const { deps } = fakeServer({ runs: false })
    expect(await readBot(deps, { ref: 'bot:vps:reviewer' })).not.toHaveProperty('runs')
  })
})

describe('messaging a bot', () => {
  it('marks the message as the assistant’s and sends it within the budget', async () => {
    const { deps, call } = fakeServer()
    const admit = vi.fn(async () => true)
    expect(await sendBot(deps, { ref: 'bot:vps:reviewer', message: 'Review PR 13.' }, admit)).toEqual({
      ok: true,
      status: 'queued',
      conversationId: 'bot:vps:reviewer',
      conversationName: 'Reviewer',
      messageId: 'input-1',
    })
    expect(admit).toHaveBeenCalledWith({ ref: 'bot:vps:reviewer', name: 'Reviewer' }, 'Review PR 13.')
    expect(call).toHaveBeenCalledWith('botMessageSend', {
      params: { id: 'reviewer' },
      body: {
        text: '— via Maestrly Assistant\n\nReview PR 13.',
        attachments: [],
        idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
      },
    })
  })

  it('does not send when the person declines, and relays what the bot refuses', async () => {
    const declined = fakeServer()
    expect(await sendBot(declined.deps, { ref: 'bot:vps:reviewer', message: 'x' }, async () => false)).toMatchObject({
      code: 'declined',
    })
    expect(declined.call).not.toHaveBeenCalled()
    const paused = fakeServer({ sendError: new Error('The bot is paused.') })
    expect(await sendBot(paused.deps, { ref: 'bot:vps:reviewer', message: 'x' }, async () => true)).toEqual({
      ok: false,
      code: 'delivery-failed',
      error: '"Reviewer" did not take the message: The bot is paused.',
    })
  })

  it('answers unavailable for a disconnected server and not-found for an unknown one, an archived bot or a bad ref', async () => {
    const offline = fakeServer({ connected: false })
    expect(await readBot(offline.deps, { ref: 'bot:vps:reviewer' })).toEqual({
      ok: false,
      code: 'unavailable',
      error: 'The bot server "vps.example" is not connected now; ask the person to check it in Settings → Bot servers.',
    })
    expect(await sendBot(offline.deps, { ref: 'bot:vps:reviewer', message: 'x' }, async () => true)).toMatchObject({
      code: 'unavailable',
    })
    expect(offline.call).not.toHaveBeenCalled()
    const { deps } = fakeServer()
    expect(await readBot(deps, { ref: 'bot:other:reviewer' })).toMatchObject({ code: 'not-found' })
    expect(await readBot(deps, { ref: 'bot:vps:gone' })).toMatchObject({ code: 'not-found' })
    expect(await readBot(deps, { ref: 'local:c-1' })).toMatchObject({ code: 'not-found' })
  })

  it('sends what the window sends through the extracted function', async () => {
    const { deps, call } = fakeServer()
    const server = (await deps.server('vps'))!
    await sendBotMessage(server.fleet, 'reviewer', 'hello')
    expect(call).toHaveBeenLastCalledWith('botMessageSend', {
      params: { id: 'reviewer' },
      body: { text: 'hello', attachments: [], idempotencyKey: '550e8400-e29b-41d4-a716-446655440000' },
    })
    expect(() => sendBotMessage(server.fleet, 'reviewer', 'x'.repeat(16_001))).toThrow()
  })

  it('keeps room for the assistant line in a bot message', () => {
    expect(botSendInputSchema.safeParse({ ref: 'bot:vps:b', message: 'x'.repeat(BOT_SEND_MAX) }).success).toBe(true)
    expect(botSendInputSchema.safeParse({ ref: 'bot:vps:b', message: 'x'.repeat(BOT_SEND_MAX + 1) }).success).toBe(
      false
    )
    expect(botReadInputSchema.safeParse({ ref: 'bot:vps:b', messages: 21 }).success).toBe(false)
  })
})
