import {
  MobileBridgeError,
  type MobileArgs,
  type MobileChannelKey,
  type MobileConversation,
  type MobileEvent,
  type MobileResult,
} from '@maestrly/bot-fleet-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openBridgeSocket } from '../src/chats/bridge-source'
import { createChatsController } from '../src/chats/controller'
import { afterChatSendFailure, nextChatsToSend, type ChatOutboxEntry } from '../src/chats/outbox'
import {
  chatSetupSummary,
  chatStatusLine,
  dayGroup,
  groupByDay,
  waitingChats,
  workspaceGroups,
  workspaceResultCount,
} from '../src/chats/selectors'
import type { ChatsHandlers, ChatsSource } from '../src/chats/source'
import { chatsReducer, initialChatsState } from '../src/chats/state'
import { createDemoChatsSource } from '../src/demo/demo-chats'
import { environmentRecord } from '../src/fleet/factories'
import { GatewayError } from '../src/gateway/client'
import { translator } from '../src/i18n/translate'
import { memoryStores, type PairedServer } from '../src/servers/registry'

const text = translator('en')
const NOW = Date.parse('2026-10-13T15:00:00.000Z')
const chat = (id: string, extra: Partial<MobileConversation> = {}): MobileConversation => ({
  id,
  name: id.toUpperCase(),
  workspaceId: null,
  workspaceName: null,
  branch: null,
  status: 'idle',
  lastActivityAt: new Date(NOW - 60_000).toISOString(),
  pinned: false,
  experience: 'standard',
  ...extra,
})
const entry = (id: string, conversationId: string, extra: Partial<ChatOutboxEntry> = {}): ChatOutboxEntry => ({
  id,
  serverId: 's1',
  conversationId,
  text: id,
  attachments: [],
  createdAt: `2026-10-13T12:00:0${id.slice(-1)}.000Z`,
  state: 'waiting',
  error: null,
  attempts: 0,
  ...extra,
})

describe('chat lists', () => {
  it('groups chats by day with pinned ones first', () => {
    const today = new Date(NOW - 60_000).toISOString()
    const yesterday = new Date(NOW - 26 * 3_600_000).toISOString()
    const old = new Date(NOW - 60 * 86_400_000).toISOString()
    expect([dayGroup(today, NOW), dayGroup(yesterday, NOW), dayGroup(old, NOW)]).toEqual([
      'today',
      'yesterday',
      'older',
    ])
    const groups = groupByDay(
      [
        chat('a', { lastActivityAt: old }),
        chat('b', { lastActivityAt: today }),
        chat('c', { pinned: true, lastActivityAt: old }),
      ],
      NOW
    )
    expect(groups.map((group) => [group.group, group.chats.map((item) => item.id)])).toEqual([
      ['pinned', ['c']],
      ['today', ['b']],
      ['older', ['a']],
    ])
  })

  it('orders workspaces by their latest chat and searches workspaces and chats', () => {
    const lists = {
      chats: [],
      workspaces: [
        {
          id: 'w1',
          name: 'docs',
          defaultBranch: 'main',
          conversations: [chat('d1', { name: 'Guide', lastActivityAt: '2026-10-01T00:00:00.000Z' })],
        },
        {
          id: 'w2',
          name: 'maestrly',
          defaultBranch: 'main',
          conversations: [
            chat('m1', { name: 'Push sender' }),
            chat('m2', { name: 'Flaky test', lastActivityAt: '2026-10-02T00:00:00.000Z' }),
          ],
        },
        { id: 'w3', name: 'empty', defaultBranch: null, conversations: [] },
      ],
    }
    expect(workspaceGroups(lists, '').map((group) => [group.workspace.id, group.chats.map((item) => item.id)])).toEqual(
      [
        ['w2', ['m1', 'm2']],
        ['w1', ['d1']],
        ['w3', []],
      ]
    )
    const search = workspaceGroups(lists, 'PUSH')
    expect(search.map((group) => [group.workspace.id, group.chats.map((item) => item.id)])).toEqual([['w2', ['m1']]])
    expect(workspaceResultCount(workspaceGroups(lists, 'empty'))).toBe(1)
    expect(
      waitingChats({ ...lists, chats: [chat('q', { status: 'asking' }), chat('r', { status: 'ready' })] }).map(
        (item) => item.id
      )
    ).toEqual(['q'])
  })

  it('says what a chat does, or where it is when idle', () => {
    const inWorkspace = chat('w', { workspaceName: 'maestrly', branch: 'chat/push' })
    expect(chatStatusLine(inWorkspace, null, 'home', text).text).toBe('maestrly · chat/push')
    expect(chatStatusLine(chat('s'), null, 'home', text).text).toBe('Chat · home')
    expect(chatStatusLine(chat('s', { status: 'waiting' }), null, 'home', text)).toEqual({
      text: 'Needs your approval',
      tone: 'cue',
    })
    expect(
      chatStatusLine(
        chat('s'),
        { streaming: false, compacting: false, plan: { version: 1, title: 'x', text: 'y' }, context: null },
        'home',
        text
      ).tone
    ).toBe('cue')
    const option = {
      id: 'c::o',
      providerId: 'c',
      providerLabel: 'Claude',
      modelId: 'o',
      modelLabel: 'Opus 5.5',
      efforts: ['high'],
      fastMode: true,
    }
    const setup = {
      selection: { providerId: 'c', modelId: 'o' },
      reasoning: 'high',
      fastMode: false,
      mode: 'agent' as const,
      permMode: 'ask' as const,
      experience: 'standard' as const,
      ultra: 'maestrly' as const,
      tools: { app: true, imageGen: true, subagents: true },
      contextLimit: null,
      mcp: [],
      skills: [],
    }
    expect(chatSetupSummary(setup, option, null, text.t)).toBe('Opus 5.5 · High')
    expect(chatSetupSummary({ ...setup, reasoning: 'maestrly-ultra' }, option, null, text.t)).toBe('Opus 5.5 · Ultra')
    expect(chatSetupSummary({ ...setup, selection: null, reasoning: 'off' }, null, option, text.t)).toBe(
      'Default · Opus 5.5'
    )
    // A permission mode other than asking shows, so full access is never out of sight; Maestro has none.
    expect(chatSetupSummary({ ...setup, permMode: 'full' }, option, null, text.t)).toBe('Opus 5.5 · High · Full access')
    expect(chatSetupSummary({ ...setup, permMode: 'auto', reasoning: 'off' }, option, null, text.t)).toBe(
      'Opus 5.5 · Approve for me'
    )
    expect(chatSetupSummary({ ...setup, permMode: 'full', experience: 'maestro' }, option, null, text.t)).toBe(
      'Opus 5.5 · High'
    )
  })
})

describe('chat outbox', () => {
  it('sends one message per chat, oldest first, never to a busy chat or past a failed one', () => {
    const entries = [
      entry('e1', 'a'),
      entry('e2', 'a'),
      entry('e3', 'b'),
      entry('e4', 'c', { state: 'failed', error: 'generic' }),
      entry('e5', 'c'),
    ]
    expect(nextChatsToSend(entries, 's1', () => false).map((item) => item.id)).toEqual(['e1', 'e3'])
    expect(nextChatsToSend(entries, 's1', (id) => id === 'a').map((item) => item.id)).toEqual(['e3'])
    expect(nextChatsToSend(entries, 'other', () => false)).toEqual([])
  })

  it('keeps a message waiting when the chat is busy or the connection dropped, and says why it failed otherwise', () => {
    const waiting = entry('e1', 'a', { state: 'sending' })
    expect(afterChatSendFailure(waiting, new MobileBridgeError('busy', 'busy'))).toMatchObject({ state: 'waiting' })
    expect(afterChatSendFailure(waiting, new MobileBridgeError('DISCONNECTED', 'x', true))).toMatchObject({
      state: 'waiting',
    })
    expect(afterChatSendFailure(waiting, new MobileBridgeError('invalid-attachment', 'x'))).toMatchObject({
      state: 'failed',
      error: 'invalid',
    })
    expect(afterChatSendFailure(waiting, new MobileBridgeError('not-found', 'x'))).toMatchObject({ error: 'chatGone' })
    expect(afterChatSendFailure(waiting, new MobileBridgeError('no-provider', 'x'))).toMatchObject({ error: 'noModel' })
    expect(afterChatSendFailure(waiting, new Error('x'))).toMatchObject({ error: 'generic' })
  })
})

describe('chat state', () => {
  it('merges streamed items in order and follows statuses', () => {
    let state = chatsReducer(initialChatsState, { type: 'hosted', hosted: true })
    state = chatsReducer(state, { type: 'lists', lists: { chats: [chat('c1')], workspaces: [] } })
    state = chatsReducer(state, {
      type: 'view-open',
      conversationId: 'c1',
      result: {
        conversation: chat('c1'),
        sourceConversationId: null,
        page: {
          items: [{ kind: 'assistant', id: 'm:1', at: '2026-10-13T12:00:00.000Z', text: 'a', streaming: false }],
          before: null,
        },
        runtime: { streaming: false, compacting: false, plan: null, context: null },
      },
    })
    state = chatsReducer(state, {
      type: 'items',
      conversationId: 'c1',
      items: [
        { kind: 'assistant', id: 'm:10', at: '2026-10-13T12:00:00.000Z', text: 'b', streaming: true },
        { kind: 'assistant', id: 'm:2', at: '2026-10-13T12:00:00.000Z', text: 'c', streaming: false },
      ],
    })
    expect(state.views.c1.items.map((item) => item.id)).toEqual(['m:1', 'm:2', 'm:10'])
    state = chatsReducer(state, { type: 'status', conversationId: 'c1', status: 'working' })
    expect(state.lists?.chats[0].status).toBe('working')
    expect(state.views.c1.conversation?.status).toBe('working')
    // Items of a chat the phone has not opened are not kept.
    expect(chatsReducer(state, { type: 'items', conversationId: 'other', items: [] }).views.other).toBeUndefined()
    // A server that no longer hosts chats keeps only the messages still to send.
    const outbox = [entry('e1', 'c1')]
    expect(chatsReducer({ ...state, outbox }, { type: 'hosted', hosted: false })).toEqual({
      ...initialChatsState,
      outbox,
    })
  })
})

class FakeHost implements ChatsSource {
  readonly serverId = 's1'
  readonly environmentId = 'w'
  handlers: ChatsHandlers | null = null
  calls: Array<[MobileChannelKey, unknown]> = []
  closed = 0
  answers: Partial<{ [K in MobileChannelKey]: (args: MobileArgs<K>) => unknown }> = {}
  connect(handlers: ChatsHandlers) {
    this.handlers = handlers
    return {
      invoke: async <K extends MobileChannelKey>(key: K, args: MobileArgs<K>) => {
        this.calls.push([key, args])
        const answer = this.answers[key] as ((value: MobileArgs<K>) => unknown) | undefined
        return (answer ? await answer(args) : null) as MobileResult<K>
      },
      reconnectNow: () => {},
      close: () => {
        this.closed++
        handlers.onState('closed')
      },
    }
  }
  readAttachment = async () => 'aGk='
  ready() {
    this.handlers?.onState('open')
    this.handlers?.onReady()
  }
  emit(event: MobileEvent) {
    this.handlers?.onEvent(event)
  }
  keys = () => this.calls.map(([key]) => key)
}

const opened = (id: string, streaming = false): MobileResult<'open'> => ({
  conversation: chat(id),
  sourceConversationId: null,
  page: { items: [], before: null },
  runtime: { streaming, compacting: false, plan: null, context: null },
})

describe('chats controller', () => {
  afterEach(() => vi.useRealTimers())

  it('connects only while the server hosts chats, then reads the lists and the open chat', async () => {
    const host = new FakeHost()
    host.answers.lists = () => ({ chats: [chat('c1')], workspaces: [] })
    host.answers.open = (args) => opened(args.conversationId)
    const controller = createChatsController(host, memoryStores().kv, { uuid: () => 'u1' })
    await controller.start()
    expect(host.handlers).toBeNull()
    controller.setHosted(true)
    controller.openConversation('c1')
    host.ready()
    await vi.waitFor(() => expect(controller.store.getState().views.c1?.loaded).toBe(true))
    expect(controller.store.getState().lists?.chats).toHaveLength(1)
    expect(host.keys()).toEqual(expect.arrayContaining(['lists', 'open']))
    controller.setHosted(false)
    expect(host.closed).toBe(1)
    expect(controller.store.getState().lists).toBeNull()
  })

  it('queues messages while a chat works and sends them, once, when its turn ends', async () => {
    const host = new FakeHost()
    const kv = memoryStores().kv
    host.answers.lists = () => ({ chats: [chat('c1')], workspaces: [] })
    host.answers.open = (args) => opened(args.conversationId, true)
    host.answers.send = () => ({ status: 'started' })
    let id = 0
    const controller = createChatsController(host, kv, {
      uuid: () => `550e8400-e29b-41d4-a716-44665544000${id++}`,
      retryMs: 60_000,
    })
    await controller.start()
    controller.setHosted(true)
    controller.openConversation('c1')
    host.ready()
    await vi.waitFor(() => expect(controller.store.getState().views.c1?.runtime.streaming).toBe(true))
    await controller.send('c1', 'first', [])
    await controller.send('c1', 'second', [])
    expect(host.keys()).not.toContain('send')
    expect(JSON.parse((await kv.get('chat-outbox.s1.w')) ?? '[]')).toHaveLength(2)

    host.emit({
      key: 'runtime',
      payload: { conversationId: 'c1', runtime: { streaming: false, compacting: false, plan: null, context: null } },
    })
    await vi.waitFor(() => expect(host.calls.filter(([key]) => key === 'send')).toHaveLength(2))
    expect(host.calls.filter(([key]) => key === 'send').map(([, args]) => (args as { text: string }).text)).toEqual([
      'first',
      'second',
    ])
    expect(controller.store.getState().outbox).toEqual([])
  })

  it('keeps a message the host refused for a reason and says why', async () => {
    const host = new FakeHost()
    host.answers.lists = () => ({ chats: [], workspaces: [] })
    host.answers.send = () => {
      throw new MobileBridgeError('no-provider', 'no-provider')
    }
    const controller = createChatsController(host, memoryStores().kv, {
      uuid: () => '550e8400-e29b-41d4-a716-446655440000',
    })
    await controller.start()
    controller.setHosted(true)
    host.ready()
    await controller.send('c1', 'hi', [])
    await vi.waitFor(() =>
      expect(controller.store.getState().outbox[0]).toMatchObject({ state: 'failed', error: 'noModel' })
    )
  })

  it('follows statuses, reloads a reset chat and reads the lists for a chat it never saw', async () => {
    vi.useFakeTimers()
    const host = new FakeHost()
    host.answers.lists = () => ({ chats: [chat('c1')], workspaces: [] })
    host.answers.open = (args) => opened(args.conversationId)
    const controller = createChatsController(host, memoryStores().kv, { uuid: () => 'u', listsMs: 10 })
    await controller.start()
    controller.setHosted(true)
    controller.openConversation('c1')
    host.ready()
    await vi.advanceTimersByTimeAsync(0)
    const before = host.keys().length
    host.emit({ key: 'status', payload: { conversationId: 'new', status: 'working' } })
    host.emit({ key: 'reset', payload: { conversationId: 'c1' } })
    await vi.advanceTimersByTimeAsync(20)
    expect(host.keys().slice(before)).toEqual(expect.arrayContaining(['open', 'lists']))
    controller.stop()
  })
})

describe('bridge socket', () => {
  const server: PairedServer = {
    id: 's1',
    origin: 'https://bots.example.dev',
    name: 'bots',
    deviceName: 'iPhone',
    features: [],
    pairedAt: '2026-10-13T12:00:00.000Z',
  }
  const workspaces = (extra: Partial<ReturnType<typeof environmentRecord>> = {}) =>
    environmentRecord({ id: 'w', name: 'Workspaces', kind: 'workspaces', capabilities: ['mobile-api'], ...extra })

  it('asks for a ticket naming its origin, then opens the socket with it', async () => {
    const call = vi.fn(async (key: string) =>
      key === 'environmentsList'
        ? { environments: [environmentRecord({ id: 'b', name: 'bots' }), workspaces()] }
        : { ticket: 't1', path: '/v1/bridge?ticket=t1', expiresAt: '2026-10-13T12:00:30.000Z' }
    )
    const create = vi.fn(() => ({}) as never)
    await openBridgeSocket(server, { call } as never, () => ['phones'], 'w', create)
    expect(call).toHaveBeenLastCalledWith('environmentBridgeTicket', {
      params: { eid: 'w' },
      body: { origin: 'https://bots.example.dev' },
    })
    expect(create).toHaveBeenCalledWith('wss://bots.example.dev/v1/bridge?ticket=t1', 'https://bots.example.dev')
  })

  it('opens the environment the phone chose, of a server with several', async () => {
    const tickets: string[] = []
    const call = vi.fn(async (key: string, options?: { params?: { eid?: string } }) => {
      if (key !== 'environmentsList') {
        tickets.push(options?.params?.eid ?? '')
        return { ticket: 't1', path: '/v1/bridge?ticket=t1', expiresAt: '2026-10-13T12:00:30.000Z' }
      }
      return { environments: [workspaces({ id: 'personal' }), workspaces({ id: 'company' })] }
    })
    await openBridgeSocket(
      server,
      { call } as never,
      () => ['phones'],
      'company',
      vi.fn(() => ({}) as never)
    )
    expect(tickets).toEqual(['company'])
  })

  it('says when it cannot work now: an old server or host, a stopped or removed host, or a removed phone', async () => {
    const list = (environments: unknown[]) => ({ call: async () => ({ environments }) }) as never
    const code = (promise: Promise<unknown>) => promise.catch((error: MobileBridgeError) => error.code)
    expect(await code(openBridgeSocket(server, list([workspaces()]), () => [], 'w', vi.fn()))).toBe('UNSUPPORTED')
    expect(await code(openBridgeSocket(server, list([]), () => ['phones'], 'w', vi.fn()))).toBe('UNAVAILABLE')
    // The chosen host is stopped, even though another one runs: the phone does not switch on its own.
    expect(
      await code(
        openBridgeSocket(
          server,
          list([workspaces({ lifecycle: 'stopped' }), workspaces({ id: 'other' })]),
          () => ['phones'],
          'w',
          vi.fn()
        )
      )
    ).toBe('UNAVAILABLE')
    expect(
      await code(openBridgeSocket(server, list([workspaces({ capabilities: [] })]), () => ['phones'], 'w', vi.fn()))
    ).toBe('UNSUPPORTED')
    const removed = {
      call: async () => Promise.reject(new GatewayError('UNAUTHORIZED', 401, 'Device token required')),
    } as never
    expect(await code(openBridgeSocket(server, removed, () => ['phones'], 'w', vi.fn()))).toBe('UNAUTHORIZED')
  })
})

describe('demo chats', () => {
  it('lists the prototype’s chats and streams a reply to a message', async () => {
    const source = createDemoChatsSource({ stepMs: 1 })
    const events: MobileEvent[] = []
    let ready = false
    const connection = source.connect({
      onEvent: (event) => events.push(event),
      onState: () => {},
      onReady: () => (ready = true),
    })
    await vi.waitFor(() => expect(ready).toBe(true))
    const lists = await connection.invoke('lists', {})
    expect(lists.chats.map((item) => item.id)).toContain('c-relay')
    expect(lists.workspaces.map((item) => item.name)).toEqual(['maestrly', 'landing-site', 'docs-site'])
    const created = await connection.invoke('create', { workspaceId: null })
    expect(
      await connection.invoke('send', {
        conversationId: created.id,
        text: 'How does push work?',
        attachments: [],
        clientId: '550e8400-e29b-41d4-a716-446655440000',
      })
    ).toEqual({
      status: 'started',
    })
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) =>
            event.key === 'items' &&
            event.payload.items.some(
              (item) => item.kind === 'assistant' && !item.streaming && item.text.includes('APNs')
            )
        )
      ).toBe(true)
    )
    expect((await connection.invoke('lists', {})).chats.find((item) => item.id === created.id)?.name).toBe(
      'How does push work?'
    )
    connection.close()
  })

  it('plans in Plan mode and builds once approved, asking before it pushes', async () => {
    const source = createDemoChatsSource({ stepMs: 1 })
    const events: MobileEvent[] = []
    const connection = source.connect({ onEvent: (event) => events.push(event), onState: () => {}, onReady: () => {} })
    await connection.invoke('setSetup', { conversationId: 'c-flaky', patch: { mode: 'plan' } })
    await connection.invoke('send', {
      conversationId: 'c-flaky',
      text: 'Add the push sender',
      attachments: [],
      clientId: '550e8400-e29b-41d4-a716-446655440001',
    })
    await vi.waitFor(async () =>
      expect((await connection.invoke('open', { conversationId: 'c-flaky' })).runtime.plan?.title).toBe(
        'Push sender for the gateway'
      )
    )
    expect(await connection.invoke('plan', { conversationId: 'c-flaky', action: 'approve' })).toEqual({ ok: true })
    await vi.waitFor(
      async () => {
        const items = (await connection.invoke('open', { conversationId: 'c-flaky' })).page.items
        expect(items.some((item) => item.kind === 'permission' && item.state === 'pending')).toBe(true)
      },
      { timeout: 5000 }
    )
    const permission = (await connection.invoke('open', { conversationId: 'c-flaky' })).page.items.find(
      (item) => item.kind === 'permission'
    )
    if (permission?.kind !== 'permission') throw new Error('no permission')
    await connection.invoke('permission', { conversationId: 'c-flaky', requestId: permission.requestId, reply: 'once' })
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) =>
            event.key === 'items' &&
            event.payload.items.some((item) => item.kind === 'assistant' && item.text.startsWith('Pushed'))
        )
      ).toBe(true)
    )
    connection.close()
  })

  it('starts a chat in a workspace when a chat is asked to send work there', async () => {
    const source = createDemoChatsSource({ stepMs: 1 })
    const connection = source.connect({ onEvent: () => {}, onState: () => {}, onReady: () => {} })
    await connection.invoke('send', {
      conversationId: 'c-relay',
      text: 'Plan the gateway push sender and send it to the maestrly workspace.',
      attachments: [],
      clientId: '550e8400-e29b-41d4-a716-446655440002',
    })
    await vi.waitFor(
      async () => {
        const dispatch = (await connection.invoke('open', { conversationId: 'c-relay' })).page.items.find(
          (item) => item.kind === 'dispatch'
        )
        expect(dispatch).toMatchObject({
          state: 'done',
          conversations: [{ title: 'Gateway push sender', workspaceName: 'maestrly' }],
        })
      },
      { timeout: 5000 }
    )
    const started = (await connection.invoke('lists', {})).workspaces[0].conversations.find(
      (item) => item.name === 'Gateway push sender'
    )
    expect((await connection.invoke('open', { conversationId: started!.id })).sourceConversationId).toBe('c-relay')
    connection.close()
  })
})
