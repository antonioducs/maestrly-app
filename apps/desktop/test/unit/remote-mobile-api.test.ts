import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/maestrly-mobile-api-test', getVersion: () => '0.0.0' } }))

import type { ChatMessage } from '../../src/shared/chat'
import { IpcHandlerTable } from '../../src/main/remote-host/ipc-handler-table'
import { MobileApi } from '../../src/main/remote-host/server/mobile-api'
import { sendToRemoteMains } from '../../src/main/remote-ui-targets'

const T0 = Date.parse('2026-10-13T12:00:00.000Z')
const conversation = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id.toUpperCase(),
  cwd: '/srv/' + id,
  status: 'idle',
  createdAt: T0,
  archived: 0,
  pinnedAt: null,
  lastActivityAt: T0 + 1000,
  scope: 'standalone',
  workspaceId: null,
  branch: null,
  mode: null,
  experience: 'standard',
  isMulti: 0,
  ...extra,
})
const user = (id: string, text: string, at = T0): ChatMessage => ({
  id,
  conversationId: 'c1',
  role: 'user',
  parts: [{ type: 'text', id: id + 'p', text }],
  createdAt: at,
})
const answer = (id: string, text: string, at = T0 + 10): ChatMessage => ({
  id,
  conversationId: 'c1',
  role: 'assistant',
  parts: [
    { type: 'tool', id: 'call-1', toolCallId: 'call-1', toolName: 'bash', input: { command: 'npm test' }, state: { status: 'completed', output: { text: '12 passed' } } },
    { type: 'text', id: id + 't', text },
  ],
  finishReason: 'stop',
  createdAt: at,
})

function setup() {
  const table = new IpcHandlerTable()
  const calls: Array<[string, unknown[]]> = []
  let sender: { send(channel: string, ...args: unknown[]): void } | null = null
  const state = {
    messages: [user('m1', 'Run the tests'), answer('m2', 'All green.')] as ChatMessage[],
    runtime: { streaming: false, pendingPermissions: [] as unknown[], pendingQuestions: [] as unknown[] },
    send: { ok: true } as { ok: boolean; error?: string },
    mode: 'agent',
    mcpDisabled: [] as string[],
  }
  const handle = (channel: string, fn: (...args: unknown[]) => unknown, kind: 'invoke' | 'send' = 'invoke') =>
    table.record(channel, kind, (event: { sender: typeof sender }, ...args: unknown[]) => {
      calls.push([channel, args])
      sender = event.sender
      return fn(...args)
    })
  handle('workspace:list', () => [
    {
      id: 'w1',
      name: 'maestrly',
      defaultBranch: 'main',
      conversations: [
        conversation('c2', { scope: 'project', workspaceId: 'w1', branch: 'task/push', mode: 'worktree', experience: 'maestro' }),
        conversation('old', { scope: 'project', workspaceId: 'w1', branch: 'x', archived: 1 }),
      ],
    },
  ])
  handle('conversation:list-standalone', () => [
    conversation('c1', { pinnedAt: T0 }),
    conversation('bot', { botOrigin: { botId: 'juno' } }),
  ])
  handle('conversation:create-standalone', (args) => conversation('new', { name: (args as { name?: string }).name ?? 'New chat' }))
  handle('workspace:branches', () => ({ defaultBranch: 'main', current: 'main', local: ['main'] }))
  handle('conversation:create', (args) => conversation('wnew', { scope: 'project', workspaceId: 'w1', branch: (args as { branch: string }).branch, mode: 'worktree' }))
  handle('chat:subscribe', () => undefined, 'send')
  handle('chat:unsubscribe', () => undefined, 'send')
  handle('chat:history:page', (_id, opts) =>
    (opts as { beforeSeq?: number }).beforeSeq
      ? { messages: [user('m0', 'Earlier')], hasMore: false, earliestSeq: 1 }
      : { messages: state.messages, hasMore: true, earliestSeq: 7 }
  )
  handle('chat:runtime', () => state.runtime)
  handle('plan:get', () => null)
  handle('conversation-dispatch:status', () => ({ sourceConversationId: 'c9' }))
  handle('chat:send', () => state.send)
  handle('chat:stop', () => undefined, 'send')
  handle('chat:permission-respond', () => undefined, 'send')
  handle('chat:question-respond', () => undefined, 'send')
  handle('chat:get-mode', () => state.mode)
  handle('chat:set-mode', (_id, mode) => {
    state.mode = mode as string
    return { ok: true }
  })
  handle('chat:get-perm-mode', () => 'auto')
  handle('chat:set-perm-mode', () => undefined)
  handle('chat:get-selection', () => ({ providerId: 'claude', modelId: 'opus' }))
  handle('chat:set-selection', () => ({ ok: false, error: 'busy' }))
  handle('chat:get-reasoning', () => 'high')
  handle('chat:set-reasoning', () => undefined)
  handle('chat:get-fast-mode', () => true)
  handle('chat:set-fast-mode', () => undefined)
  handle('chat:get-conv-tools', () => ({ app: true, mcpDisabled: state.mcpDisabled, imageGen: true }))
  handle('chat:set-conv-tools', (_id, patch) => {
    state.mcpDisabled = (patch as { mcpDisabled: string[] }).mcpDisabled
    return undefined
  })
  handle('chat:skills:state', () => ({
    skills: [{ name: 'brainstorming', description: 'Explore ideas', enabled: true, override: 'on' }],
    groups: [],
    selection: { kind: 'all' },
    selectedGroupMissing: false,
    hasOverrides: true,
  }))
  handle('chat:skills:set-override', () => undefined)
  handle('chat:config', () => ({
    providers: [{ id: 'claude', name: 'Claude', baseURL: '', apiKeyPresent: true }],
    mcpServers: [
      { id: 'linear', name: 'Linear', transport: 'http', enabled: true },
      { id: 'off', name: 'Off', transport: 'http', enabled: false },
    ],
    defaultSelection: { providerId: 'claude', modelId: 'opus' },
  }))
  handle('chat:models', () => ['opus', 'sonnet'])
  handle('chat:attachment-image', () => ({ ok: true, bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png', byteSize: 3 }))
  const events: Array<[string, unknown]> = []
  const api = new MobileApi({ table, emit: (channel, payload) => events.push([channel, payload]), log: vi.fn(), selections: null, flushMs: 10, listsMs: 10 })
  const invoke = (channel: string, args: unknown = {}) => api.invoke(channel, [args])
  const push = (channel: string, payload: unknown) => sender?.send(channel, payload)
  return { api, invoke, calls, events, state, push, called: (channel: string) => calls.filter(([name]) => name === channel) }
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }))
afterEach(() => vi.useRealTimers())
const settle = () => vi.advanceTimersByTimeAsync(50)

describe('mobile API of a workspaces host', () => {
  it('lists active chats and workspaces, never a bot conversation', async () => {
    const h = setup()
    const lists = (await h.invoke('mobile:v1:lists')) as { workspaces: Array<{ conversations: Array<{ id: string }> }>; chats: Array<{ id: string; pinned: boolean }> }
    expect(lists.chats.map((chat) => [chat.id, chat.pinned])).toEqual([['c1', true]])
    expect(lists.workspaces).toEqual([
      {
        id: 'w1',
        name: 'maestrly',
        defaultBranch: 'main',
        conversations: [
          {
            id: 'c2',
            name: 'C2',
            workspaceId: 'w1',
            workspaceName: 'maestrly',
            branch: 'task/push',
            status: 'idle',
            lastActivityAt: '2026-10-13T12:00:01.000Z',
            pinned: false,
            experience: 'maestro',
          },
        ],
      },
    ])
    h.api.dispose()
  })

  it('creates a standalone chat, or one on a new branch of a workspace', async () => {
    const h = setup()
    expect(await h.invoke('mobile:v1:conversation:create', { workspaceId: null, name: 'Ideas' })).toMatchObject({ id: 'new', workspaceId: null })
    await expect(h.invoke('mobile:v1:conversation:create', { workspaceId: null, experience: 'maestro' })).rejects.toMatchObject({ code: 'invalid' })
    await h.invoke('mobile:v1:conversation:create', { workspaceId: 'w1', name: 'Fix the flaky test', experience: 'maestro' })
    const [args] = h.called('conversation:create')[0][1] as [Record<string, unknown>]
    expect(args).toMatchObject({ workspaceId: 'w1', isNewBranch: true, base: 'main', mode: 'worktree', experience: 'maestro', name: 'Fix the flaky test' })
    expect(args.branch).toMatch(/^chat\/fix-the-flaky-test-[0-9a-f]{8}$/)
    await expect(h.invoke('mobile:v1:conversation:create', { workspaceId: 'nope' })).rejects.toMatchObject({ code: 'not-found' })
    await expect(h.invoke('mobile:v1:conversation:create', { workspaceId: 1 })).rejects.toMatchObject({ code: 'invalid' })
    h.api.dispose()
  })

  it('opens a conversation as transcript items, then streams what changes', async () => {
    const h = setup()
    const opened = (await h.invoke('mobile:v1:conversation:open', { conversationId: 'c1' })) as {
      page: { items: Array<{ kind: string; id: string }>; before: string | null }
      sourceConversationId: string | null
      runtime: { streaming: boolean }
    }
    expect(h.called('chat:subscribe')).toHaveLength(1)
    expect(opened.sourceConversationId).toBe('c9')
    expect(opened.page.before).toBe('seq-7')
    expect(opened.page.items.map((item) => item.kind)).toEqual(['user', 'tool', 'assistant'])
    expect(opened.page.items[1]).toMatchObject({ name: 'bash', target: 'npm test', state: 'done', output: '12 passed' })

    // A new turn streams in; updates gather briefly and go out once.
    h.push('chat:delta:c1', { kind: 'message-start', messageId: 'm3', createdAt: T0 + 20, responseStartedAt: T0 + 20 })
    h.push('chat:delta:c1', { kind: 'text-start', messageId: 'm3', partId: 'm3t' })
    h.push('chat:delta:c1', { kind: 'text-delta', messageId: 'm3', partId: 'm3t', delta: 'Deploying' })
    h.push('chat:delta:c1', { kind: 'text-delta', messageId: 'm3', partId: 'm3t', delta: ' now' })
    h.state.messages = [...h.state.messages]
    await vi.advanceTimersByTimeAsync(12)
    const items = h.events.filter(([channel]) => channel === 'mobile:v1:items')
    expect(items).toHaveLength(1)
    expect(items[0][1]).toEqual({
      conversationId: 'c1',
      items: [{ kind: 'assistant', id: 'm3:0', at: new Date(T0 + 20).toISOString(), text: 'Deploying now', streaming: true }],
    })
    expect(h.events.find(([channel]) => channel === 'mobile:v1:runtime')?.[1]).toMatchObject({ runtime: { streaming: true } })

    // A permission request becomes a card, and its resolution updates it.
    h.push('chat:permission:c1', {
      kind: 'request',
      request: { id: 'r1', conversationId: 'c1', toolCallId: 'call-1', toolName: 'bash', action: 'bash', title: 'Run a command', resources: ['npm run deploy'] },
    })
    await settle()
    const card = h.events.filter(([channel]) => channel === 'mobile:v1:items').at(-1)?.[1] as { items: Array<Record<string, unknown>> }
    expect(card.items).toEqual([expect.objectContaining({ kind: 'permission', id: 'perm:r1', requestId: 'r1', state: 'pending', tool: { name: 'bash', target: 'npm test' } })])
    await h.invoke('mobile:v1:permission', { conversationId: 'c1', requestId: 'r1', reply: 'once' })
    expect(h.called('chat:permission-respond')[0][1]).toEqual(['r1', 'once'])
    h.push('chat:permission:c1', { kind: 'resolved', requestId: 'r1', decision: 'allow' })
    await settle()
    const resolved = h.events.filter(([channel]) => channel === 'mobile:v1:items').at(-1)?.[1] as { items: Array<Record<string, unknown>> }
    expect(resolved.items[0]).toMatchObject({ id: 'perm:r1', state: 'approved' })

    // Statuses and list changes reach the phone; a burst of list changes is told once.
    sendToRemoteMains('agent:status', { agentId: 'c2', status: 'working' })
    sendToRemoteMains('workspace:changed', {})
    sendToRemoteMains('conversation:open', {})
    await settle()
    expect(h.events.filter(([channel]) => channel === 'mobile:v1:status')).toEqual([['mobile:v1:status', { conversationId: 'c2', status: 'working' }]])
    expect(h.events.filter(([channel]) => channel === 'mobile:v1:lists-changed')).toHaveLength(1)

    // A plan for the open conversation arrives with its runtime.
    sendToRemoteMains('plan:received', { agentId: 'c1', plan: '1. Ship it', title: 'Ship', version: 2 })
    await settle()
    expect(h.events.filter(([channel]) => channel === 'mobile:v1:runtime').at(-1)?.[1]).toMatchObject({
      runtime: { plan: { version: 2, title: 'Ship', text: '1. Ship it' } },
    })

    // Older pages, on demand.
    expect(await h.invoke('mobile:v1:conversation:page', { conversationId: 'c1', before: 'seq-7' })).toMatchObject({
      items: [{ kind: 'user', text: 'Earlier' }],
      before: null,
    })
    await expect(h.invoke('mobile:v1:conversation:page', { conversationId: 'c1', before: 'nope' })).rejects.toMatchObject({ code: 'invalid' })

    await h.invoke('mobile:v1:conversation:close', { conversationId: 'c1' })
    expect(h.called('chat:unsubscribe')).toHaveLength(1)
    h.api.dispose()
  })

  it('sends text and attachments once per client id, and names a refusal', async () => {
    const h = setup()
    await h.invoke('mobile:v1:conversation:open', { conversationId: 'c1' })
    const message = {
      conversationId: 'c1',
      text: 'Look',
      clientId: '550e8400-e29b-41d4-a716-446655440000',
      attachments: [
        { name: 'a.png', kind: 'image', mediaType: 'image/png', dataBase64: Buffer.from([9, 8]).toString('base64') },
        { name: 'notes.md', kind: 'text', mediaType: 'text/markdown', dataBase64: Buffer.from('# Hi').toString('base64') },
      ],
    }
    expect(await h.invoke('mobile:v1:conversation:send', message)).toEqual({ status: 'started' })
    const [payload] = h.called('chat:send')[0][1] as [{ attachments: Array<Record<string, unknown>> }]
    expect(payload.attachments[0]).toMatchObject({ kind: 'image', mediaType: 'image/png', bytes: new Uint8Array([9, 8]) })
    expect(payload.attachments[1]).toEqual({ name: 'notes.md', mediaType: 'text/plain', kind: 'text', data: '# Hi' })
    expect(await h.invoke('mobile:v1:conversation:send', message)).toEqual({ status: 'duplicate' })
    expect(h.called('chat:send')).toHaveLength(1)
    h.state.send = { ok: false, error: 'busy' }
    await expect(
      h.invoke('mobile:v1:conversation:send', { ...message, clientId: '550e8400-e29b-41d4-a716-446655440001' })
    ).rejects.toMatchObject({ code: 'busy' })
    h.api.dispose()
  })

  it('reads and changes a chat’s setup', async () => {
    const h = setup()
    const setup0 = await h.invoke('mobile:v1:setup', { conversationId: 'c1' })
    expect(setup0).toEqual({
      selection: { providerId: 'claude', modelId: 'opus' },
      reasoning: 'high',
      fastMode: true,
      mode: 'agent',
      permMode: 'auto',
      experience: 'standard',
      mcp: [{ id: 'linear', name: 'Linear', enabled: true }],
      skills: [{ name: 'brainstorming', description: 'Explore ideas', enabled: true, override: 'on' }],
    })
    const next = await h.invoke('mobile:v1:setup:set', { conversationId: 'c1', patch: { mode: 'plan', mcp: { id: 'linear', enabled: false } } })
    expect(next).toMatchObject({ mode: 'plan', mcp: [{ id: 'linear', enabled: false }] })
    await expect(
      h.invoke('mobile:v1:setup:set', { conversationId: 'c1', patch: { selection: { providerId: 'claude', modelId: 'sonnet' } } })
    ).rejects.toMatchObject({ code: 'busy' })
    expect(await h.invoke('mobile:v1:models')).toEqual({
      options: [
        { id: 'claude::opus', providerId: 'claude', providerLabel: 'Claude', modelId: 'opus', modelLabel: 'opus', efforts: [], fastMode: false },
        { id: 'claude::sonnet', providerId: 'claude', providerLabel: 'Claude', modelId: 'sonnet', modelLabel: 'sonnet', efforts: [], fastMode: false },
      ],
      defaultSelection: { providerId: 'claude', modelId: 'opus' },
    })
    h.api.dispose()
  })

  it('serves the images of items it sent, and only those', async () => {
    const h = setup()
    h.state.messages = [
      {
        id: 'm1',
        conversationId: 'c1',
        role: 'user',
        parts: [
          { type: 'text', id: 't', text: 'See' },
          { type: 'file', id: 'f', name: 'shot.png', mediaType: 'image/png', kind: 'image', artifactId: 'art', byteSize: 3 },
        ],
        createdAt: T0,
      },
    ]
    const opened = (await h.invoke('mobile:v1:conversation:open', { conversationId: 'c1' })) as {
      page: { items: Array<{ kind: string; images?: Array<{ id: string }> }> }
    }
    const image = opened.page.items[0].images?.[0]
    expect(image).toMatchObject({ mediaType: 'image/png', name: 'shot.png' })
    expect(await h.invoke('mobile:v1:image', { conversationId: 'c1', imageId: image?.id })).toEqual({
      mediaType: 'image/png',
      dataBase64: Buffer.from([1, 2, 3]).toString('base64'),
    })
    await expect(h.invoke('mobile:v1:image', { conversationId: 'c1', imageId: 'a-unknown' })).rejects.toMatchObject({ code: 'not-found' })
    await expect(h.invoke('mobile:v1:image', { conversationId: 'c2', imageId: image?.id })).rejects.toMatchObject({ code: 'not-found' })
    h.api.dispose()
  })

  it('shows the conversations an agent started as one card', async () => {
    const h = setup()
    h.state.messages = [
      {
        id: 'm1',
        conversationId: 'c1',
        role: 'assistant',
        finishReason: 'stop',
        createdAt: T0,
        parts: [
          {
            type: 'tool',
            id: 'd1',
            toolCallId: 'd1',
            toolName: 'start_conversations',
            input: {},
            state: {
              status: 'completed',
              output: {
                text: JSON.stringify({
                  ok: true,
                  items: [
                    { requestKey: 'a', title: 'Push sender', status: 'started', conversationId: 'c7', conversationName: 'Gateway push sender' },
                    { requestKey: 'b', title: 'Docs', status: 'start-failed', error: 'No model' },
                  ],
                }),
              },
            },
          },
        ],
      },
    ]
    const opened = (await h.invoke('mobile:v1:conversation:open', { conversationId: 'c1' })) as { page: { items: unknown[] } }
    expect(opened.page.items).toEqual([
      {
        kind: 'dispatch',
        id: 'm1:0',
        at: new Date(T0).toISOString(),
        state: 'done',
        conversations: [
          { conversationId: 'c7', title: 'Gateway push sender', status: 'started', workspaceName: null, error: null },
          { conversationId: null, title: 'Docs', status: 'start-failed', workspaceName: null, error: 'No model' },
        ],
      },
    ])
    h.api.dispose()
  })

  it('refuses unknown channels and stops hearing the host once disposed', async () => {
    const h = setup()
    await expect(h.invoke('chat:send')).rejects.toMatchObject({ code: 'unknown-channel' })
    await h.invoke('mobile:v1:conversation:open', { conversationId: 'c1' })
    h.api.dispose()
    await settle()
    expect(h.called('chat:unsubscribe')).toHaveLength(1)
    sendToRemoteMains('agent:status', { agentId: 'c1', status: 'working' })
    await settle()
    expect(h.events.filter(([channel]) => channel === 'mobile:v1:status')).toEqual([])
  })
})
