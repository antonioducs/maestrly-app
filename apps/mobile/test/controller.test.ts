import type { FleetGatewayEvent } from '@maestrly/bot-fleet-protocol'
import { describe, expect, it, vi } from 'vitest'
import type { StreamState } from '../src/gateway/event-stream'
import { BotCompactError, createFleetController } from '../src/fleet/controller'
import { botRecord } from '../src/fleet/factories'
import type { FleetSource } from '../src/fleet/source'
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
