import {
  FLEET_PARALLEL_TURNS_FEATURE,
  FLEET_PEER_CONVERSATIONS_FEATURE,
  FLEET_ROUTINE_CONVERSATIONS_FEATURE,
  fleetRoutineRunSchema,
  type FleetGatewayEvent,
} from '@maestrly/bot-fleet-protocol'
import { describe, expect, it, vi } from 'vitest'
import type { StreamState } from '../src/gateway/event-stream'
import { BotCompactError, createFleetController, LaneConflictError, lanesSeenKey } from '../src/fleet/controller'
import { botRecord } from '../src/fleet/factories'
import type { FleetSource } from '../src/fleet/source'
import { GatewayError } from '../src/gateway/client'
import { memoryStores } from '../src/servers/registry'

const at = '2026-10-12T12:00:00.000Z'
const juno = botRecord({ id: 'juno', name: 'Juno' })

function fakeSource(features: string[] = ['environments']) {
  let handlers: { onEvent(event: FleetGatewayEvent): void; onState(state: StreamState): void } | null = null
  const opened = vi.fn()
  const closed = vi.fn()
  const reconnect = vi.fn()
  const responses: Record<string, (options?: unknown) => unknown> = {
    meta: () => ({ protocol: 1, gatewayVersion: '1', botImage: 'x', botImageVersion: null, features }),
    botsList: () => ({ bots: [juno] }),
    environmentsList: () => ({ environments: [] }),
    inbox: () => ({ items: [] }),
    botTranscript: () => ({ items: [], before: null }),
    botMessageSend: () => ({ inputId: 'in1', itemId: 'it1', queued: false }),
  }
  const call = vi.fn(async (key: string, options?: unknown) => responses[key]?.(options))
  const source: FleetSource = {
    serverId: 's1',
    features,
    call: call as unknown as FleetSource['call'],
    openEvents(h) {
      handlers = h
      opened()
      return { close: closed, reconnectNow: reconnect }
    },
    imageSource: () => ({ uri: 'data:,' }),
    fileSource: () => ({ uri: 'https://g.example/file', headers: {} }),
    readAttachment: async () => 'aGk=',
  }
  const open = () => {
    handlers?.onState('open')
    handlers?.onEvent({ type: 'hello', at, lastActivitySeq: 0 })
  }
  const emit = (event: FleetGatewayEvent) => handlers?.onEvent(event)
  const goOffline = () => handlers?.onState('retrying')
  const keys = () => call.mock.calls.map(([key]) => key)
  return { source, call, opened, closed, reconnect, open, emit, goOffline, keys, responses }
}

describe('fleet controller', () => {
  it('loads bots, environments and requests when the stream says hello', async () => {
    const f = fakeSource()
    const controller = createFleetController(f.source, memoryStores().kv)
    await controller.start()
    f.open()
    await vi.waitFor(() => expect(controller.store.getState().bots).toEqual([juno]))
    expect(f.keys()).toEqual(expect.arrayContaining(['botsList', 'environmentsList', 'inbox']))
    expect(controller.store.getState()).toMatchObject({ connection: 'open', loaded: true })

    const older = fakeSource([])
    const plain = createFleetController(older.source, memoryStores().kv)
    await plain.start()
    older.open()
    await vi.waitFor(() => expect(plain.store.getState().loaded).toBe(true))
    expect(older.keys()).not.toContain('environmentsList')
  })

  it('loads the open bot’s latest page and reloads it after a reset', async () => {
    const f = fakeSource()
    const controller = createFleetController(f.source, memoryStores().kv)
    await controller.start()
    f.open()
    await controller.openBot('juno')
    expect(f.call).toHaveBeenCalledWith('botTranscript', { params: { id: 'juno' }, query: { limit: 50 } })
    expect(controller.store.getState().transcripts.juno).toMatchObject({ loaded: true, loading: false })
    f.call.mockClear()
    f.emit({ type: 'transcript.reset', at, botId: 'juno' })
    await vi.waitFor(() => expect(f.keys()).toContain('botTranscript'))
  })

  it('keeps messages on the phone while offline and sends them when the stream comes back', async () => {
    const f = fakeSource()
    const { kv } = memoryStores()
    const controller = createFleetController(f.source, kv, { uuid: () => '550e8400-e29b-41d4-a716-446655440000' })
    await controller.start()
    f.goOffline()
    const entry = await controller.send('juno', 'Deploy after lunch', [])
    expect(entry.id).toBe('550e8400-e29b-41d4-a716-446655440000')
    expect(controller.store.getState().outbox).toHaveLength(1)
    expect(await kv.get('outbox.s1')).toContain('Deploy after lunch')
    expect(f.keys()).not.toContain('botMessageSend')

    f.open()
    await vi.waitFor(() => expect(controller.store.getState().outbox).toEqual([]))
    expect(f.call).toHaveBeenCalledWith('botMessageSend', {
      params: { id: 'juno' },
      body: { text: 'Deploy after lunch', idempotencyKey: entry.id, attachments: [] },
    })
    expect(JSON.parse((await kv.get('outbox.s1')) ?? 'null')).toEqual([])
  })

  it('restores messages saved before the app closed, including one that was being sent', async () => {
    const f = fakeSource()
    const { kv } = memoryStores()
    await kv.set(
      'outbox.s1',
      JSON.stringify([
        {
          id: '550e8400-e29b-41d4-a716-446655440001',
          serverId: 's1',
          botId: 'juno',
          text: 'Saved',
          attachments: [],
          createdAt: at,
          state: 'sending',
          error: null,
          attempts: 0,
        },
      ])
    )
    const controller = createFleetController(f.source, kv)
    await controller.start()
    expect(controller.store.getState().outbox[0]).toMatchObject({ text: 'Saved', state: 'waiting' })
  })

  it('closes the stream in the background and reopens it in the foreground', async () => {
    const f = fakeSource()
    const controller = createFleetController(f.source, memoryStores().kv)
    await controller.start()
    expect(f.opened).toHaveBeenCalledTimes(1)
    controller.background()
    expect(f.closed).toHaveBeenCalledTimes(1)
    controller.foreground()
    expect(f.opened).toHaveBeenCalledTimes(2)
    controller.foreground()
    expect(f.reconnect).toHaveBeenCalledTimes(1)
    controller.stop()
  })

  it('asks the bot to compact and says why it could not', async () => {
    const f = fakeSource()
    const controller = createFleetController(f.source, memoryStores().kv)
    let answer: unknown = { ok: true }
    f.responses.botConversationCall = () => ({ result: answer })
    await controller.compact('juno')
    expect(f.call).toHaveBeenLastCalledWith('botConversationCall', {
      params: { id: 'juno' },
      body: { op: 'chatCompact', args: [] },
    })
    await controller.retryBackgroundCompaction('juno')
    expect(f.call.mock.calls.at(-1)?.[1]).toMatchObject({ body: { op: 'chatBackgroundCompactionRetry' } })
    const issue = () =>
      controller.compact('juno').then(
        () => null,
        (error: unknown) => (error instanceof BotCompactError ? error.issue : 'other')
      )
    answer = { ok: false, error: 'busy' }
    expect(await issue()).toBe('busy')
    answer = { ok: false, error: 'not-configured' }
    expect(await issue()).toBe('notConfigured')
    answer = { ok: false, error: 'invalid' }
    expect(await issue()).toBe('failed')
    answer = null
    expect(await issue()).toBe('failed')
  })

  it('creates a bot, shows it at once, and keeps the key when the same bot is tried again', async () => {
    const f = fakeSource()
    const keys = ['550e8400-e29b-41d4-a716-446655440010', '550e8400-e29b-41d4-a716-446655440011']
    let next = 0
    const controller = createFleetController(f.source, memoryStores().kv, { uuid: () => keys[next++] })
    const request = { name: 'Nova', instructions: '', ceiling: 'auto' as const, talksTo: [], environmentId: 'studio' }
    const nova = botRecord({ id: 'nova', name: 'Nova', environmentId: 'studio', status: 'starting' })
    let fail = true
    f.responses.botsCreate = () => {
      if (fail) throw new GatewayError('NETWORK', 0, 'lost')
      return nova
    }
    await expect(controller.createBot(request)).rejects.toThrow('lost')
    fail = false
    expect(await controller.createBot(request)).toEqual(nova)
    const sent = f.call.mock.calls.filter(([key]) => key === 'botsCreate').map(([, options]) => options)
    expect(sent).toEqual([
      { body: { ...request, idempotencyKey: keys[0] } },
      { body: { ...request, idempotencyKey: keys[0] } },
    ])
    expect(controller.store.getState().bots.map((bot) => bot.id)).toContain('nova')

    // Once the server confirmed it, the next bot is a new request with a key of its own.
    await controller.createBot(request)
    expect(f.call.mock.calls.at(-1)?.[1]).toEqual({ body: { ...request, idempotencyKey: keys[1] } })
  })

  it('opens no stream when stopped while it was starting', async () => {
    const f = fakeSource()
    const controller = createFleetController(f.source, memoryStores().kv)
    const starting = controller.start()
    controller.stop()
    await starting
    controller.foreground()
    expect(f.opened).not.toHaveBeenCalled()
  })

  it('keeps removals, the inbox and transcript items that arrive while their lists load', async () => {
    const f = fakeSource()
    const atlas = botRecord({ id: 'atlas', name: 'Atlas' })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    f.responses.botsList = () => gate.then(() => ({ bots: [juno, atlas] }))
    const item = (text: string) => ({ id: 'i1', at, kind: 'assistant' as const, text, streaming: false })
    let answerPage: (value: unknown) => void = () => {}
    f.responses.botTranscript = () =>
      new Promise((resolve) => {
        answerPage = resolve
      })
    const controller = createFleetController(f.source, memoryStores().kv)
    await controller.start()
    f.open()
    await vi.waitFor(() => expect(f.keys()).toContain('botsList'))
    f.emit({ type: 'bot.removed', at, botId: 'atlas' })
    const request = { botId: 'juno', interaction: { kind: 'question' as const, id: 'q1', at, itemId: 'x' } }
    f.emit({ type: 'inbox.updated', at, items: [request] as never })
    release()
    await vi.waitFor(() => expect(controller.store.getState().loaded).toBe(true))
    expect(controller.store.getState().bots.map((bot) => bot.id)).toEqual(['juno'])
    expect(controller.store.getState().inbox).toHaveLength(1)

    const opening = controller.openBot('juno')
    f.emit({ type: 'transcript.upsert', at, botId: 'juno', item: item('the newer text') })
    answerPage({ items: [item('the older text')], before: null })
    await opening
    expect(
      controller.store.getState().transcripts.juno?.items.map((entry) => entry.kind === 'assistant' && entry.text)
    ).toEqual(['the newer text'])
  })
})

describe('fleet controller with side conversations', () => {
  const both = ['environments', FLEET_ROUTINE_CONVERSATIONS_FEATURE, FLEET_PEER_CONVERSATIONS_FEATURE]
  const run = (id: string, second: number) =>
    fleetRoutineRunSchema.parse({
      id,
      routineId: 'r1',
      botId: 'juno',
      trigger: 'schedule',
      status: 'completed',
      deliveredAt: `2026-10-12T12:00:${String(second).padStart(2, '0')}.000Z`,
      finishedAt: null,
      report: null,
      finalText: null,
      conversation: 'own',
    })

  it('reads a bot’s runs once, counting those already there as seen, and keeps that on the phone', async () => {
    const f = fakeSource(both)
    f.responses.botRuns = () => ({ runs: [run('r2', 2), run('r1', 1)], before: null })
    const { kv } = memoryStores()
    const controller = createFleetController(f.source, kv)
    await controller.start()
    f.open()
    controller.ensureRuns('juno')
    await vi.waitFor(() => expect(controller.store.getState().runs.juno?.loaded).toBe(true))
    expect(f.call).toHaveBeenCalledWith('botRuns', { params: { id: 'juno' }, query: { limit: 100 } })
    expect(controller.store.getState().seen.runs.juno).toEqual(['r1', 'r2'])
    controller.ensureRuns('juno')
    expect(f.keys().filter((key) => key === 'botRuns')).toHaveLength(1)
    controller.markRunSeen('juno', 'r3')
    await vi.waitFor(async () =>
      expect(JSON.parse((await kv.get(lanesSeenKey('s1'))) ?? '{}').runs.juno).toEqual(['r1', 'r2', 'r3'])
    )

    // Another start on the same phone remembers it.
    const again = createFleetController(fakeSource(both).source, kv)
    await again.start()
    expect(again.store.getState().seen.runs.juno).toEqual(['r1', 'r2', 'r3'])
  })

  it('opens a run’s conversation, reloads it after a reset, and sends the owner’s word there', async () => {
    const f = fakeSource(both)
    const key = '550e8400-e29b-41d4-a716-446655440020'
    f.responses.botRunTranscript = () => ({ items: [], before: null })
    f.responses.botRunMessageSend = () => ({ inputId: 'in1', itemId: 'it1', queued: false })
    const controller = createFleetController(f.source, memoryStores().kv, { uuid: () => key })
    await controller.start()
    f.open()
    await controller.openLane('juno', { kind: 'run', id: 'r1' })
    expect(f.call).toHaveBeenCalledWith('botRunTranscript', {
      params: { id: 'juno', runId: 'r1' },
      query: { limit: 50 },
    })
    expect(controller.store.getState().lanes['juno\u0000r1']).toMatchObject({ loaded: true })
    f.call.mockClear()
    f.emit({ type: 'routine_run.transcript.reset', at, botId: 'juno', runId: 'r1' })
    await vi.waitFor(() => expect(f.keys()).toContain('botRunTranscript'))

    await controller.sendLane('juno', { kind: 'run', id: 'r1' }, 'Add the WebKit numbers', [])
    expect(f.call).toHaveBeenCalledWith('botRunMessageSend', {
      params: { id: 'juno', runId: 'r1' },
      body: { text: 'Add the WebKit numbers', idempotencyKey: key, attachments: [] },
    })
    // A conversation that works or is gone refuses it, and the view says why.
    f.responses.botPeerThreadMessageSend = () => {
      throw new GatewayError('CONFLICT', 409, 'busy')
    }
    await expect(controller.sendLane('juno', { kind: 'thread', id: 't1' }, 'Go on', [])).rejects.toBeInstanceOf(
      LaneConflictError
    )
    // Closed, a later reset leaves it alone.
    controller.closeLane('juno', 'r1')
    f.call.mockClear()
    f.emit({ type: 'routine_run.transcript.reset', at, botId: 'juno', runId: 'r1' })
    expect(f.keys()).not.toContain('botRunTranscript')
  })

  it('sends the run a message cites with it, and stops one side conversation’s turn only', async () => {
    const f = fakeSource([...both, FLEET_PARALLEL_TURNS_FEATURE])
    const controller = createFleetController(f.source, memoryStores().kv, {
      uuid: () => '550e8400-e29b-41d4-a716-446655440021',
    })
    await controller.start()
    f.open()
    await controller.send('juno', 'What did it find?', [], 'r1')
    await vi.waitFor(() => expect(f.keys()).toContain('botMessageSend'))
    expect(f.call).toHaveBeenCalledWith('botMessageSend', {
      params: { id: 'juno' },
      body: {
        text: 'What did it find?',
        idempotencyKey: '550e8400-e29b-41d4-a716-446655440021',
        attachments: [],
        citation: { runId: 'r1' },
      },
    })
    await controller.cancelLane('juno', 't1')
    expect(f.call).toHaveBeenLastCalledWith('botCancel', { params: { id: 'juno' }, query: { conversation: 't1' } })
  })
})
