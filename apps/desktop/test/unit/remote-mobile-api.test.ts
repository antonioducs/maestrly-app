import { type MobileChatSetup, mobileChatPageSchema } from '@maestrly/bot-fleet-protocol'
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
    {
      type: 'tool',
      id: 'call-1',
      toolCallId: 'call-1',
      toolName: 'bash',
      input: { command: 'npm test' },
      state: { status: 'completed', output: { text: '12 passed' } },
    },
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
    /** Plugin servers and signed-in accounts of the conversation, as `chat:get-conv-tools` reports them. */
    convTools: {} as Record<string, unknown>,
    mcpAccountsDisabled: [] as string[],
    extraServers: [] as unknown[],
    limit: null as number | null,
    subagents: true,
    defaults: null as Record<string, unknown> | null,
    /** Subscription accounts `chat:config` lists, and what `chat:subscription-usage` answers for each account id. */
    subscriptions: [] as unknown[],
    usage: {} as Record<string, unknown>,
    /** The pending plan `plan:get` hands out, what `plan:decide` answers, and the review `chat:review:status` reports. */
    plan: null as Record<string, unknown> | null,
    decided: { ok: true } as Record<string, unknown> | undefined,
    review: null as Record<string, unknown> | null,
    /** More chats of the workspace, beyond the ones every test sees. */
    workspaceChats: [] as unknown[],
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
        conversation('c2', {
          scope: 'project',
          workspaceId: 'w1',
          branch: 'task/push',
          mode: 'worktree',
          experience: 'maestro',
        }),
        conversation('old', { scope: 'project', workspaceId: 'w1', branch: 'x', archived: 1 }),
        ...state.workspaceChats,
      ],
    },
  ])
  handle('conversation:list-standalone', () => [
    conversation('c1', { pinnedAt: T0 }),
    conversation('bot', { botOrigin: { botId: 'juno' } }),
  ])
  handle('conversation:create-standalone', (args) =>
    conversation('new', { name: (args as { name?: string }).name ?? 'New chat' })
  )
  handle('workspace:branches', () => ({
    defaultBranch: 'main',
    current: 'main',
    local: ['main', 'release'],
    remote: ['origin/main', 'origin/HEAD', 'origin/feat/x'],
    remoteRefs: [
      { remote: 'origin', name: 'main', ref: 'refs/remotes/origin/main' },
      { remote: 'origin', name: 'HEAD', ref: 'refs/remotes/origin/HEAD' },
      { remote: 'origin', name: 'feat/x', ref: 'refs/remotes/origin/feat/x' },
    ],
  }))
  handle('conversation:create', (args) =>
    conversation('wnew', {
      scope: 'project',
      workspaceId: 'w1',
      branch: (args as { branch: string }).branch,
      mode: 'worktree',
    })
  )
  handle('chat:subscribe', () => undefined, 'send')
  handle('chat:unsubscribe', () => undefined, 'send')
  handle('chat:history:page', (_id, opts) =>
    (opts as { beforeSeq?: number }).beforeSeq
      ? { messages: [user('m0', 'Earlier')], hasMore: false, earliestSeq: 1 }
      : { messages: state.messages, hasMore: true, earliestSeq: 7 }
  )
  handle('chat:runtime', () => state.runtime)
  handle('conversation:attention-clear', () => undefined)
  handle('plan:get', () => state.plan)
  handle('plan:decide', () => state.decided)
  handle('chat:review:status', () => state.review)
  handle('chat:maestro:strategy-profiles:list', () => ({
    lastUsedId: 'builtin:fast',
    items: [
      {
        id: 'global',
        name: 'Global',
        source: 'global',
        config: { version: 1, strategy: 'balanced', pool: [{ label: 'Implementer', enabled: true }] },
        orchestrator: { providerId: 'claude', modelId: 'opus', reasoning: 'high', fastMode: false },
      },
      {
        id: 'builtin:fast',
        name: 'Fast',
        source: 'builtin',
        config: {
          version: 1,
          strategy: 'fast',
          pool: [
            { label: 'Implementer', enabled: true },
            { label: 'Reviewer', enabled: false },
          ],
        },
        orchestrator: null,
      },
    ],
  }))
  handle('conversation-dispatch:status', () => ({ sourceConversationId: 'c9' }))
  handle('chat:send', () => state.send)
  handle('chat:resend', () => state.send)
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
  handle('chat:get-conv-tools', () => ({
    app: true,
    mcpDisabled: state.mcpDisabled,
    imageGen: true,
    ...state.convTools,
    mcpAccountsDisabled: state.mcpAccountsDisabled,
  }))
  handle('chat:set-conv-tools', (_id, patch) => {
    const value = patch as { mcpDisabled?: string[]; mcpAccountsDisabled?: string[] }
    if (value.mcpDisabled) state.mcpDisabled = value.mcpDisabled
    if (value.mcpAccountsDisabled) state.mcpAccountsDisabled = value.mcpAccountsDisabled
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
    providers: [{ id: 'claude', name: 'Claude', baseURL: '', apiKeyPresent: true }, ...state.subscriptions],
    mcpServers: [
      { id: 'linear', name: 'Linear', transport: 'http', enabled: true },
      { id: 'off', name: 'Off', transport: 'http', enabled: false },
      ...state.extraServers,
    ],
    defaultSelection: { providerId: 'claude', modelId: 'opus' },
  }))
  handle('chat:models', () => ['opus', 'sonnet'])
  handle('chat:subscription-usage', (payload) => {
    const { providerKind, accountId } = payload as { providerKind: string; accountId: string | null }
    const answer = state.usage[accountId ?? providerKind]
    if (answer instanceof Error) throw answer
    return answer
  })
  handle('chat:model-meta', () => ({ contextWindow: 200000, nativeUltraMode: false, contextLimitEditable: true }))
  handle('chat:context-limit:get', () => ({
    limit: state.limit,
    providerWindow: 200000,
    catalogWindow: null,
    effective: 200000,
  }))
  handle('chat:context-limit:set', (_p, _m, value) => {
    state.limit = value as number | null
    return { ok: true }
  })
  handle('chat:subagent-profiles:get-conversation', () => ({ subagentsEnabled: state.subagents }))
  handle('chat:subagents:set-conversation-enabled', (_id, enabled) => {
    state.subagents = enabled as boolean
    return { ok: true }
  })
  handle('chat:skills:reset-overrides', () => ({ ok: true }))
  handle('chat:set-default', (sel) => {
    state.defaults = sel as Record<string, unknown>
    return { ok: true }
  })
  handle('chat:attachment-image', () => ({
    ok: true,
    bytes: new Uint8Array([1, 2, 3]),
    mediaType: 'image/png',
    byteSize: 3,
  }))
  const events: Array<[string, unknown]> = []
  const api = new MobileApi({
    table,
    emit: (channel, payload) => events.push([channel, payload]),
    log: vi.fn(),
    selections: null,
    flushMs: 10,
    listsMs: 10,
  })
  const invoke = (channel: string, args: unknown = {}) => api.invoke(channel, [args])
  const push = (channel: string, payload: unknown) => sender?.send(channel, payload)
  return {
    api,
    invoke,
    calls,
    events,
    state,
    push,
    called: (channel: string) => calls.filter(([name]) => name === channel),
  }
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }))
afterEach(() => vi.useRealTimers())
const settle = () => vi.advanceTimersByTimeAsync(50)

describe('mobile API of a workspaces host', () => {
  it('lists active chats and workspaces, never a bot conversation', async () => {
    const h = setup()
    const lists = (await h.invoke('mobile:v1:lists')) as {
      workspaces: Array<{ conversations: Array<{ id: string }> }>
      chats: Array<{ id: string; pinned: boolean }>
    }
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
    expect(await h.invoke('mobile:v1:conversation:create', { workspaceId: null, name: 'Ideas' })).toMatchObject({
      id: 'new',
      workspaceId: null,
    })
    await expect(
      h.invoke('mobile:v1:conversation:create', { workspaceId: null, experience: 'maestro' })
    ).rejects.toMatchObject({ code: 'invalid' })
    await h.invoke('mobile:v1:conversation:create', {
      workspaceId: 'w1',
      name: 'Fix the flaky test',
      experience: 'maestro',
    })
    const [args] = h.called('conversation:create')[0][1] as [Record<string, unknown>]
    expect(args).toMatchObject({
      workspaceId: 'w1',
      isNewBranch: true,
      base: 'main',
      mode: 'worktree',
      experience: 'maestro',
      name: 'Fix the flaky test',
    })
    expect(args.branch).toMatch(/^chat\/fix-the-flaky-test-[0-9a-f]{8}$/)
    await expect(h.invoke('mobile:v1:conversation:create', { workspaceId: 'nope' })).rejects.toMatchObject({
      code: 'not-found',
    })
    await expect(h.invoke('mobile:v1:conversation:create', { workspaceId: 1 })).rejects.toMatchObject({
      code: 'invalid',
    })
    h.api.dispose()
  })

  it('lists a workspace’s branches, and creates a chat on a chosen new or existing branch', async () => {
    const h = setup()
    expect(await h.invoke('mobile:v1:workspace:branches', { workspaceId: 'w1' })).toEqual({
      defaultBranch: 'main',
      local: ['main', 'release'],
      remote: [{ name: 'feat/x', remote: 'origin' }],
    })
    await expect(h.invoke('mobile:v1:workspace:branches', { workspaceId: 'nope' })).rejects.toMatchObject({
      code: 'not-found',
    })
    await h.invoke('mobile:v1:conversation:create', {
      workspaceId: 'w1',
      branch: { kind: 'new', name: 'feat/login', base: 'release' },
    })
    await h.invoke('mobile:v1:conversation:create', { workspaceId: 'w1', branch: { kind: 'new', name: 'feat/y' } })
    await h.invoke('mobile:v1:conversation:create', { workspaceId: 'w1', branch: { kind: 'existing', name: 'feat/x' } })
    const calls = h.called('conversation:create').map(([, args]) => (args as [Record<string, unknown>])[0])
    expect(calls[0]).toMatchObject({ branch: 'feat/login', isNewBranch: true, base: 'release', mode: 'worktree' })
    expect(calls[1]).toMatchObject({ branch: 'feat/y', isNewBranch: true, base: 'main' })
    expect(calls[2]).toMatchObject({ branch: 'feat/x', isNewBranch: false })
    expect(calls[2]).not.toHaveProperty('base')
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
      items: [
        { kind: 'assistant', id: 'm3:0', at: new Date(T0 + 20).toISOString(), text: 'Deploying now', streaming: true },
      ],
    })
    expect(h.events.find(([channel]) => channel === 'mobile:v1:runtime')?.[1]).toMatchObject({
      runtime: { streaming: true },
    })

    // A permission request becomes a card, and its resolution updates it.
    h.push('chat:permission:c1', {
      kind: 'request',
      request: {
        id: 'r1',
        conversationId: 'c1',
        toolCallId: 'call-1',
        toolName: 'bash',
        action: 'bash',
        title: 'Run a command',
        resources: ['npm run deploy'],
      },
    })
    await settle()
    const card = h.events.filter(([channel]) => channel === 'mobile:v1:items').at(-1)?.[1] as {
      items: Array<Record<string, unknown>>
    }
    expect(card.items).toEqual([
      expect.objectContaining({
        kind: 'permission',
        id: 'perm:r1',
        requestId: 'r1',
        state: 'pending',
        tool: { name: 'bash', target: 'npm test' },
      }),
    ])
    await h.invoke('mobile:v1:permission', { conversationId: 'c1', requestId: 'r1', reply: 'once' })
    expect(h.called('chat:permission-respond')[0][1]).toEqual(['r1', 'once'])
    h.push('chat:permission:c1', { kind: 'resolved', requestId: 'r1', decision: 'allow' })
    await settle()
    const resolved = h.events.filter(([channel]) => channel === 'mobile:v1:items').at(-1)?.[1] as {
      items: Array<Record<string, unknown>>
    }
    expect(resolved.items[0]).toMatchObject({ id: 'perm:r1', state: 'approved' })

    // Statuses and list changes reach the phone; a burst of list changes is told once.
    sendToRemoteMains('agent:status', { agentId: 'c2', status: 'working' })
    sendToRemoteMains('workspace:changed', {})
    sendToRemoteMains('conversation:open', {})
    await settle()
    expect(h.events.filter(([channel]) => channel === 'mobile:v1:status')).toEqual([
      ['mobile:v1:status', { conversationId: 'c2', status: 'working' }],
    ])
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
    await expect(
      h.invoke('mobile:v1:conversation:page', { conversationId: 'c1', before: 'nope' })
    ).rejects.toMatchObject({ code: 'invalid' })

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
        {
          name: 'notes.md',
          kind: 'text',
          mediaType: 'text/markdown',
          dataBase64: Buffer.from('# Hi').toString('base64'),
        },
      ],
    }
    expect(await h.invoke('mobile:v1:conversation:send', message)).toEqual({ status: 'started' })
    const [payload] = h.called('chat:send')[0][1] as [{ attachments: Array<Record<string, unknown>> }]
    expect(payload.attachments[0]).toMatchObject({
      kind: 'image',
      mediaType: 'image/png',
      bytes: new Uint8Array([9, 8]),
    })
    expect(payload.attachments[1]).toEqual({ name: 'notes.md', mediaType: 'text/plain', kind: 'text', data: '# Hi' })
    expect(await h.invoke('mobile:v1:conversation:send', message)).toEqual({ status: 'duplicate' })
    expect(h.called('chat:send')).toHaveLength(1)
    // A phone that reconnected resends on a new session: the host still knows the message.
    const other = setup()
    expect(await other.invoke('mobile:v1:conversation:send', message)).toEqual({ status: 'duplicate' })
    expect(other.called('chat:send')).toHaveLength(0)
    other.api.dispose()
    h.state.send = { ok: false, error: 'busy' }
    await expect(
      h.invoke('mobile:v1:conversation:send', { ...message, clientId: '550e8400-e29b-41d4-a716-446655440001' })
    ).rejects.toMatchObject({ code: 'busy' })
    h.api.dispose()
  })

  it('edits only the last message while no turn runs, then reloads the phone', async () => {
    const h = setup()
    await h.invoke('mobile:v1:conversation:open', { conversationId: 'c1' })
    const edit = (itemId: string) =>
      h.invoke('mobile:v1:conversation:edit', { conversationId: 'c1', itemId, text: 'Run lint' })
    await expect(edit('m2:1')).rejects.toMatchObject({ code: 'not-editable' })
    h.state.runtime.streaming = true
    await expect(edit('m1:0')).rejects.toMatchObject({ code: 'busy' })
    h.state.runtime.streaming = false
    h.events.length = 0
    expect(await edit('m1:0')).toBeNull()
    expect(h.called('chat:resend')[0][1]).toEqual([{ conversationId: 'c1', fromMessageId: 'm1', text: 'Run lint' }])
    expect(h.events).toContainEqual(['mobile:v1:reset', { conversationId: 'c1' }])
    h.state.send = { ok: false, error: 'busy' }
    await expect(edit('m1:0')).rejects.toMatchObject({ code: 'busy' })
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
      ultra: 'maestrly',
      tools: { app: true, imageGen: true, subagents: true },
      contextLimit: { limit: null, window: 200000, editable: true },
      mcp: [{ id: 'linear', name: 'Linear', enabled: true }],
      skills: [{ name: 'brainstorming', description: 'Explore ideas', enabled: true, override: 'on' }],
    })
    const next = await h.invoke('mobile:v1:setup:set', {
      conversationId: 'c1',
      patch: {
        mode: 'plan',
        mcp: { id: 'linear', enabled: false },
        tools: { subagents: false, imageGen: false },
        contextLimit: 150000,
        skillsReset: true,
      },
    })
    expect(next).toMatchObject({
      mode: 'plan',
      mcp: [{ id: 'linear', enabled: false }],
      tools: { subagents: false },
      contextLimit: { limit: 150000 },
    })
    expect(h.called('chat:set-conv-tools').at(-1)?.[1]).toEqual(['c1', { imageGen: false }])
    expect(h.called('chat:skills:reset-overrides')).toHaveLength(1)
    await expect(
      h.invoke('mobile:v1:setup:set', { conversationId: 'c1', patch: { contextLimit: 10 } })
    ).rejects.toMatchObject({ code: 'invalid' })
    // New chats' defaults.
    expect(await h.invoke('mobile:v1:defaults')).toEqual({
      selection: { providerId: 'claude', modelId: 'opus' },
      reasoning: 'off',
      fastMode: false,
    })
    await h.invoke('mobile:v1:defaults:set', { reasoning: 'high', fastMode: true })
    expect(h.state.defaults).toEqual({ providerId: 'claude', modelId: 'opus', reasoning: 'high', fastMode: true })
    await expect(
      h.invoke('mobile:v1:setup:set', {
        conversationId: 'c1',
        patch: { selection: { providerId: 'claude', modelId: 'sonnet' } },
      })
    ).rejects.toMatchObject({ code: 'busy' })
    expect(await h.invoke('mobile:v1:models')).toEqual({
      options: [
        {
          id: 'claude::opus',
          providerId: 'claude',
          providerLabel: 'Claude',
          modelId: 'opus',
          modelLabel: 'opus',
          efforts: [],
          fastMode: false,
        },
        {
          id: 'claude::sonnet',
          providerId: 'claude',
          providerLabel: 'Claude',
          modelId: 'sonnet',
          modelLabel: 'sonnet',
          efforts: [],
          fastMode: false,
        },
      ],
      defaultSelection: { providerId: 'claude', modelId: 'opus' },
    })
    h.api.dispose()
  })

  it('lists plugin servers only where they serve, each account of a server, and names a prompt a hook blocked', async () => {
    const h = setup()
    const plugin = (id: string) => ({ id, name: id, transport: 'http', enabled: true, plugin: { key: 'p@m' } })
    h.state.extraServers = [plugin('plg_serves'), plugin('plg_elsewhere')]
    const accounts = (enabled: boolean) => [
      { id: 'acc_000000000001', label: 'Personal', enabled: true },
      { id: 'acc_000000000002', label: 'Work', enabled },
    ]
    h.state.convTools = {
      pluginMcpServers: ['plg_serves'],
      mcpAccounts: [{ serverId: 'plg_serves', serverName: 'plg_serves', accounts: accounts(true) }],
    }
    expect(((await h.invoke('mobile:v1:setup', { conversationId: 'c1' })) as MobileChatSetup).mcp).toEqual([
      { id: 'linear', name: 'Linear', enabled: true },
      { id: 'plg_serves', name: 'plg_serves', enabled: true },
      { id: 'plg_serves#acc_000000000001', name: 'plg_serves · Personal', enabled: true },
      { id: 'plg_serves#acc_000000000002', name: 'plg_serves · Work', enabled: true },
    ])
    // An account switches on and off on its own, never as a server.
    h.state.convTools = {
      pluginMcpServers: ['plg_serves'],
      mcpAccounts: [{ serverId: 'plg_serves', serverName: 'plg_serves', accounts: accounts(false) }],
    }
    await h.invoke('mobile:v1:setup:set', {
      conversationId: 'c1',
      patch: { mcp: { id: 'plg_serves#acc_000000000002', enabled: false } },
    })
    expect(h.state.mcpAccountsDisabled).toEqual(['plg_serves#acc_000000000002'])
    expect(h.state.mcpDisabled).toEqual([])
    // A server switched off hides its accounts.
    const off = (await h.invoke('mobile:v1:setup:set', {
      conversationId: 'c1',
      patch: { mcp: { id: 'plg_serves', enabled: false } },
    })) as MobileChatSetup
    expect(off.mcp.map((entry) => entry.id)).toEqual(['linear', 'plg_serves'])

    h.state.send = { ok: false, error: 'blocked-by-hook: no secrets here' }
    await expect(
      h.invoke('mobile:v1:conversation:send', {
        conversationId: 'c1',
        text: 'my password is hunter2',
        clientId: '550e8400-e29b-41d4-a716-446655440009',
        attachments: [],
      })
    ).rejects.toMatchObject({ code: 'blocked-by-hook', message: 'no secrets here' })
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
          {
            type: 'file',
            id: 'f',
            name: 'shot.png',
            mediaType: 'image/png',
            kind: 'image',
            artifactId: 'art',
            byteSize: 3,
          },
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
    await expect(h.invoke('mobile:v1:image', { conversationId: 'c1', imageId: 'a-unknown' })).rejects.toMatchObject({
      code: 'not-found',
    })
    await expect(h.invoke('mobile:v1:image', { conversationId: 'c2', imageId: image?.id })).rejects.toMatchObject({
      code: 'not-found',
    })
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
                    {
                      requestKey: 'a',
                      title: 'Push sender',
                      status: 'started',
                      conversationId: 'c7',
                      conversationName: 'Gateway push sender',
                    },
                    { requestKey: 'b', title: 'Docs', status: 'start-failed', error: 'No model' },
                  ],
                }),
              },
            },
          },
        ],
      },
    ]
    const opened = (await h.invoke('mobile:v1:conversation:open', { conversationId: 'c1' })) as {
      page: { items: unknown[] }
    }
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

  it('shows a question asked from inside another tool as a card, until it is answered', async () => {
    const h = setup()
    const starting = {
      id: 'm3',
      conversationId: 'c1',
      role: 'assistant' as const,
      createdAt: T0 + 20,
      parts: [
        {
          type: 'tool' as const,
          id: 'd1',
          toolCallId: 'd1',
          toolName: 'start_conversations',
          input: {},
          state: { status: 'running' as const },
        },
      ],
    }
    h.state.messages = [...h.state.messages, starting]
    await h.invoke('mobile:v1:conversation:open', { conversationId: 'c1' })
    const confirm = {
      messageId: 'm3',
      toolCallId: 'd1',
      questions: [
        {
          header: 'Start',
          question: 'Start 2 conversations?',
          options: [{ label: 'Start' }, { label: "Don't start" }],
        },
      ],
    }
    h.state.runtime = { ...h.state.runtime, pendingQuestions: [confirm] }
    h.push('chat:delta:c1', { kind: 'questions-pending', questions: [confirm] })
    await settle()
    const latest = () => {
      const last = h.events.filter(([channel]) => channel === 'mobile:v1:items').at(-1)?.[1] as
        | { items: Array<Record<string, unknown>> }
        | undefined
      return last?.items ?? []
    }
    expect(latest()).toEqual([
      expect.objectContaining({ kind: 'question', id: 'm3:0', toolCallId: 'd1', state: 'pending' }),
    ])

    await h.invoke('mobile:v1:question', { conversationId: 'c1', toolCallId: 'd1', answers: [['Start']] })
    expect(h.called('chat:question-respond')[0][1]).toEqual(['d1', [['Start']]])
    h.state.runtime = { ...h.state.runtime, pendingQuestions: [] }
    h.push('chat:delta:c1', { kind: 'questions-pending', questions: [] })
    await settle()
    expect(latest()).toEqual([expect.objectContaining({ kind: 'dispatch', id: 'm3:0', state: 'running' })])
    h.api.dispose()
  })

  it('names the conversation a message came from', async () => {
    const h = setup()
    h.state.messages = [
      {
        ...user('m1', 'The push sender is merged.', T0),
        source: 'conversation-message',
        peer: {
          messageId: 'j1',
          fromConversationId: 'c7',
          fromConversationName: 'Gateway push sender',
          kind: 'report',
        },
      },
      user('m2', 'Thanks', T0 + 5),
    ]
    const opened = (await h.invoke('mobile:v1:conversation:open', { conversationId: 'c1' })) as {
      page: { items: Array<Record<string, unknown>> }
    }
    expect(opened.page.items).toEqual([
      expect.objectContaining({
        kind: 'user',
        text: 'The push sender is merged.',
        fromConversation: { conversationId: 'c7', name: 'Gateway push sender', purpose: 'report' },
      }),
      expect.not.objectContaining({ fromConversation: expect.anything() }),
    ])
    expect(mobileChatPageSchema.parse(opened.page).items[0]).toHaveProperty('fromConversation.purpose', 'report')
    h.api.dispose()
  })

  it('clears the attention mark of a conversation the phone shows', async () => {
    const h = setup()
    await h.invoke('mobile:v1:conversation:open', { conversationId: 'c1' })
    expect(h.called('conversation:attention-clear').map(([, args]) => args)).toEqual([['c1']])
    sendToRemoteMains('conversation:attention', { conversationId: 'c1', attention: true })
    sendToRemoteMains('conversation:attention', { conversationId: 'c2', attention: true })
    sendToRemoteMains('conversation:attention', { conversationId: 'c1', attention: false })
    await settle()
    expect(h.called('conversation:attention-clear').map(([, args]) => args)).toEqual([['c1'], ['c1']])
    await h.invoke('mobile:v1:conversation:close', { conversationId: 'c1' })
    sendToRemoteMains('conversation:attention', { conversationId: 'c1', attention: true })
    await settle()
    expect(h.called('conversation:attention-clear')).toHaveLength(2)
    h.api.dispose()
  })

  it('keeps a message before its answer when the answer streamed before the message was saved', async () => {
    const h = setup()
    h.state.messages = []
    await h.invoke('mobile:v1:conversation:open', { conversationId: 'c1' })
    // The answer starts streaming, stamped before the message it answers, which the history has not saved yet.
    h.push('chat:delta:c1', { kind: 'message-start', messageId: 'a1', createdAt: T0 + 10, responseStartedAt: T0 + 10 })
    await vi.advanceTimersByTimeAsync(12)
    h.state.messages = [user('u1', 'Hello', T0 + 20), answer('a1', 'Hi there', T0 + 10)]
    await settle()
    const sent = h.events
      .filter(([channel]) => channel === 'mobile:v1:items')
      .flatMap(([, payload]) => (payload as { items: Array<{ id: string; at: string }> }).items)
    const at = (id: string) => sent.filter((item) => item.id.startsWith(id)).at(-1)?.at ?? ''
    expect(at('u1') < at('a1:')).toBe(true)
    const reopened = (await h.invoke('mobile:v1:conversation:open', { conversationId: 'c1' })) as {
      page: { items: Array<{ kind: string }> }
    }
    expect(reopened.page.items.map((item) => item.kind)).toEqual(['user', 'tool', 'assistant'])
    h.api.dispose()
  })

  it('keeps a long message, and shows how a failed or stopped turn ended', async () => {
    const h = setup()
    h.state.messages = [
      user('m1', 'x'.repeat(20_000)),
      { ...answer('m2', 'Half'), finishReason: undefined, error: 'The provider refused the request' },
      user('m3', 'Again', T0 + 100),
      { ...answer('m4', 'Stop', T0 + 110), finishReason: 'aborted' },
    ]
    const opened = (await h.invoke('mobile:v1:conversation:open', { conversationId: 'c1' })) as {
      page: { items: Array<{ kind: string; id: string; text?: string | null; code?: string }> }
    }
    const items = opened.page.items
    expect(items[0]).toMatchObject({ kind: 'user' })
    expect(items[0].text).toHaveLength(16_000)
    expect(items.filter((item) => item.kind === 'system')).toEqual([
      expect.objectContaining({ id: 'm2:end', code: 'turn_failed', text: 'The provider refused the request' }),
      expect.objectContaining({ id: 'm4:end', code: 'turn_cancelled', text: null }),
    ])
    // Each ends its own turn, after its answer.
    expect(items.map((item) => item.id).indexOf('m2:end')).toBe(items.map((item) => item.id).indexOf('m2:1') + 1)
    h.api.dispose()
  })

  it('reads the quota usage of each connected subscription account, naming none of its secrets', async () => {
    const h = setup()
    const account = (kind: string, base: string, accountId?: string, extra: Record<string, unknown> = {}) => ({
      id: accountId ? `${base}@${accountId}` : base,
      name: base,
      baseURL: '',
      kind,
      builtIn: true,
      connected: true,
      ...(accountId ? { accountId } : {}),
      ...extra,
    })
    h.state.subscriptions = [
      account('claude-subscription', 'builtin_claude_subscription', 'acc_work', { accountLabel: 'Work' }),
      account('claude-subscription', 'builtin_claude_subscription', undefined, { accountLabel: 'Personal' }),
      account('claude-subscription', 'builtin_claude_subscription', 'acc_old', { connected: false }),
      account('antigravity-subscription', 'builtin_antigravity_subscription'),
      account('codex-subscription', 'builtin_codex_subscription'),
      account('cursor-subscription', 'builtin_cursor_subscription'),
      account('codex-subscription', 'builtin_codex_subscription', 'acc_team', { accountLabel: 'Team' }),
    ]
    const ready = (providerKind: string, accountId: string | null, windows: unknown[]) => ({
      state: 'ready',
      providerKind,
      accountId,
      fetchedAt: T0,
      windows,
    })
    h.state.usage = {
      'claude-subscription': ready('claude-subscription', null, [
        { id: 'five_hour', kind: 'five-hour', usedPercent: 42.5, resetsAt: T0 + 3_600_000, durationMins: 300 },
      ]),
      acc_work: ready('claude-subscription', 'acc_work', [
        { id: 'seven_day', kind: 'weekly', usedPercent: 140, resetsAt: null, durationMins: 10_080, extra: 'x' },
        {
          id: 'seven_day_opus',
          kind: 'weekly-model',
          usedPercent: 3,
          resetsAt: Number.NaN,
          durationMins: null,
          label: 'Opus',
        },
      ]),
      'codex-subscription': {
        state: 'error',
        providerKind: 'codex-subscription',
        accountId: null,
        error: 'Request failed: Bearer [REDACTED] user@example.com',
      },
      acc_team: { state: 'error', providerKind: 'codex-subscription', accountId: 'acc_team', error: 'unknown-account' },
      'antigravity-subscription': {
        state: 'unsupported',
        providerKind: 'antigravity-subscription',
        accountId: null,
        reason: 'unavailable',
      },
      'cursor-subscription': new Error('never asked'),
    }

    const result = (await h.invoke('mobile:v1:subscription-usage', { force: true })) as {
      entries: Array<Record<string, unknown>>
    }
    expect(result.entries).toEqual([
      {
        providerId: 'builtin_codex_subscription',
        providerKind: 'codex',
        providerLabel: 'ChatGPT',
        state: 'error',
        windows: [],
        error: 'failed',
      },
      {
        providerId: 'builtin_codex_subscription@acc_team',
        providerKind: 'codex',
        providerLabel: 'ChatGPT',
        accountLabel: 'Team',
        state: 'error',
        windows: [],
        error: 'unknown-account',
      },
      {
        providerId: 'builtin_claude_subscription',
        providerKind: 'claude',
        providerLabel: 'Claude',
        accountLabel: 'Personal',
        state: 'ready',
        fetchedAt: T0,
        windows: [
          { id: 'five_hour', kind: 'five-hour', usedPercent: 42.5, resetsAt: T0 + 3_600_000, durationMins: 300 },
        ],
      },
      {
        providerId: 'builtin_claude_subscription@acc_work',
        providerKind: 'claude',
        providerLabel: 'Claude',
        accountLabel: 'Work',
        state: 'ready',
        fetchedAt: T0,
        windows: [
          { id: 'seven_day', kind: 'weekly', usedPercent: 100, resetsAt: null, durationMins: 10_080 },
          {
            id: 'seven_day_opus',
            kind: 'weekly-model',
            usedPercent: 3,
            resetsAt: null,
            durationMins: null,
            label: 'Opus',
          },
        ],
      },
      {
        providerId: 'builtin_antigravity_subscription',
        providerKind: 'google',
        providerLabel: 'Google AI',
        state: 'error',
        windows: [],
        error: 'unavailable',
      },
    ])
    expect(JSON.stringify(result)).not.toMatch(/REDACTED|example\.com/)
    expect(h.called('chat:subscription-usage').map(([, args]) => args[0])).toEqual([
      { providerKind: 'codex-subscription', accountId: null, force: true },
      { providerKind: 'codex-subscription', accountId: 'acc_team', force: true },
      { providerKind: 'claude-subscription', accountId: null, force: true },
      { providerKind: 'claude-subscription', accountId: 'acc_work', force: true },
      { providerKind: 'antigravity-subscription', accountId: null, force: true },
    ])

    // A read that throws fails only its own account; without `force` the host may answer from its cache.
    h.state.usage['claude-subscription'] = new Error('socket hang up')
    const again = (await h.invoke('mobile:v1:subscription-usage')) as { entries: Array<Record<string, unknown>> }
    expect(again.entries.find((entry) => entry.providerId === 'builtin_claude_subscription')).toMatchObject({
      state: 'error',
      error: 'failed',
    })
    expect(again.entries.find((entry) => entry.providerId === 'builtin_claude_subscription@acc_work')).toMatchObject({
      state: 'ready',
    })
    expect(h.called('chat:subscription-usage').at(-1)?.[1][0]).toMatchObject({ force: false })
    await expect(
      h.invoke('mobile:v1:subscription-usage', { force: true, accountId: 'acc_work' })
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('decides plans as the Plan tab does, and tells the phone where else they can be built', async () => {
    const h = setup()
    h.state.plan = { agentId: 'c1', plan: '## Steps\n1. Two', title: 'Ship', version: 2, previousPlan: '1. One' }
    const opened = (await h.invoke('mobile:v1:conversation:open', { conversationId: 'c1' })) as {
      runtime: { plan: unknown }
    }
    expect(opened.runtime.plan).toEqual({ version: 2, title: 'Ship', text: '## Steps\n1. Two', previousText: '1. One' })
    // A first version shows no changes, even when the broker kept an older cycle's plan.
    sendToRemoteMains('plan:received', { agentId: 'c1', plan: 'Fresh', version: 1, previousPlan: 'stale' })
    await settle()
    expect(h.events.filter(([channel]) => channel === 'mobile:v1:runtime').at(-1)?.[1]).toMatchObject({
      runtime: { plan: { version: 1, text: 'Fresh', previousText: null } },
    })

    // Edits and line comments go through the same handler; so do the Maestro and new-conversation hand-offs.
    expect(
      await h.invoke('mobile:v1:plan', {
        conversationId: 'c1',
        action: 'revise',
        feedback: 'Tighter',
        editedPlan: '## Steps\n1. Two, edited',
        lineComments: [{ line: 2, text: 'Split it' }],
      })
    ).toEqual({ ok: true })
    h.state.decided = { ok: true, conversationId: 'c-maestro' }
    expect(
      await h.invoke('mobile:v1:plan', {
        conversationId: 'c1',
        action: 'approve',
        implementation: { target: 'maestro', profileId: 'global' },
      })
    ).toEqual({ ok: true, conversationId: 'c-maestro' })
    await h.invoke('mobile:v1:plan', {
      conversationId: 'c1',
      action: 'approve',
      implementation: {
        target: 'standard',
        settings: { providerId: 'claude', modelId: 'opus', reasoning: 'high', fastMode: true },
        placement: 'worktree',
      },
    })
    expect(h.called('plan:decide').map(([, args]) => args)).toEqual([
      [
        'c1',
        {
          action: 'revise',
          feedback: 'Tighter',
          editedPlan: '## Steps\n1. Two, edited',
          lineComments: [{ line: 2, text: 'Split it' }],
        },
      ],
      ['c1', { action: 'approve', implementationTarget: 'maestro', maestroStrategyProfileId: 'global' }],
      [
        'c1',
        {
          action: 'approve',
          implementationTarget: 'standard',
          standardHandoff: {
            settings: { providerId: 'claude', modelId: 'opus', reasoning: 'high', fastMode: true },
            placement: 'worktree',
          },
        },
      ],
    ])
    h.state.decided = { ok: false, error: 'review-active' }
    expect(await h.invoke('mobile:v1:plan', { conversationId: 'c1', action: 'approve' })).toEqual({
      ok: false,
      error: 'review-active',
    })

    // A chat with no workspace builds its plan only in itself; a Maestro chat cannot hand it to Maestro.
    expect(await h.invoke('mobile:v1:plan:options', { conversationId: 'c1' })).toEqual({
      newConversation: false,
      maestro: null,
      review: null,
    })
    expect(await h.invoke('mobile:v1:plan:options', { conversationId: 'c2' })).toMatchObject({
      newConversation: true,
      maestro: null,
    })
    h.state.workspaceChats = [conversation('c3', { scope: 'project', workspaceId: 'w1', branch: 'task/plan' })]
    h.state.review = { kind: 'review', target: 'plan', status: 'ready' }
    expect(await h.invoke('mobile:v1:plan:options', { conversationId: 'c3' })).toEqual({
      newConversation: true,
      maestro: {
        lastUsedId: 'builtin:fast',
        profiles: [
          {
            id: 'global',
            source: 'global',
            name: 'Global',
            strategy: 'balanced',
            orchestrator: { modelId: 'opus', reasoning: 'high' },
            agents: ['Implementer'],
          },
          {
            id: 'builtin:fast',
            source: 'builtin',
            name: 'Fast',
            strategy: 'fast',
            orchestrator: null,
            agents: ['Implementer'],
          },
        ],
      },
      review: { target: 'plan', stage: 'ready' },
    })
    // A finished review no longer holds the plan.
    h.state.review = { kind: 'review', target: 'plan', status: 'completed' }
    expect(await h.invoke('mobile:v1:plan:options', { conversationId: 'c3' })).toMatchObject({ review: null })
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
