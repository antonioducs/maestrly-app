import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  service: { list: vi.fn(), read: vi.fn(), wait: vi.fn(), send: vi.fn(), report: vi.fn() },
}))
vi.mock('../../src/main/conversation-link-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/conversation-link-service')>()),
  getConversationLinkService: async () => h.service,
}))

import { assistantActionBudget } from '../../src/main/assistant/action-budget'
import {
  type RemoteConversationDeps,
  readRemoteConversation,
  REMOTE_READ_PAGE,
  sendRemoteConversation,
} from '../../src/main/assistant/remote-conversations'
import { setAssistantHostAccess } from '../../src/main/assistant/assistant-context'
import {
  clearHumanTurnOrigin,
  type HumanTurnOrigin,
  recordHumanTurnOrigin,
} from '../../src/main/chat/conversation-dispatch-authorization'
import { setAssistantRoleResolver } from '../../src/main/chat/harness/assistant-role'
import { assistantRuntimeFor } from '../../src/main/chat/tools/assistant'
import {
  conversationLinkRuntimeFor,
  readConversationTool,
  sendToConversationTool,
  waitConversationTool,
} from '../../src/main/chat/tools/conversation-link'
import type { ToolContext } from '../../src/main/chat/tools/util'

const HOST = 'srv/workspaces'
const text = (id: string, role: 'user' | 'assistant', value: string, extra: Record<string, unknown> = {}) => ({
  id,
  role,
  parts: [{ type: 'text', id: `${id}-t`, text: value }],
  createdAt: 1,
  ...extra,
})

function fakeHost(patch: { state?: string; page?: unknown; send?: unknown } = {}) {
  const calls: Array<[string, unknown[]]> = []
  const deps: RemoteConversationDeps = {
    hosts: () => [{ id: HOST, label: 'Workspaces', state: patch.state ?? 'online' }],
    viaLine: () => '— via Maestrly Assistant',
    invoke: async <T>(_host: string, channel: string, args: unknown[]) => {
      calls.push([channel, args])
      if (channel === 'workspace:list')
        return [
          {
            name: 'api',
            conversations: [
              { id: 'c-1', name: 'Fix login', scope: 'project', workspaceId: 'w', branch: 'main', status: 'working' },
              {
                id: 'c-old',
                name: 'Old',
                scope: 'project',
                workspaceId: 'w',
                branch: 'x',
                status: 'idle',
                archived: 1,
              },
            ],
          },
        ] as T
      if (channel === 'conversation:list-standalone') return [] as T
      if (channel === 'chat:history:page')
        return (patch.page ?? {
          messages: [
            text('m1', 'user', 'Fix the login bug.'),
            { id: 'm2', role: 'assistant', parts: [{ type: 'tool', toolCallId: 't', toolName: 'bash' }], createdAt: 2 },
            text('m3', 'user', 'hidden framing', { internal: true }),
            text('m4', 'assistant', 'Fixed; tests pass.'),
          ],
          hasMore: true,
          earliestSeq: 41,
        }) as T
      if (channel === 'chat:send') return (patch.send ?? { ok: true }) as T
      throw new Error(`unexpected ${channel}`)
    },
  }
  return { deps, calls }
}

describe('remote conversations', () => {
  it('reads a remote conversation as read_conversation does, without internal or tool-only messages', async () => {
    const { deps, calls } = fakeHost()
    const result = await readRemoteConversation(deps, HOST, 'c-1', {})
    expect(calls.find(([channel]) => channel === 'chat:history:page')?.[1]).toEqual([
      'c-1',
      { limit: REMOTE_READ_PAGE },
    ])
    expect(result).toMatchObject({
      conversation: {
        conversationId: 'host:srv/workspaces:c-1',
        name: 'Fix login',
        workspaceName: 'api · Workspaces',
        running: true,
        relation: null,
      },
      lastReply: { text: 'Fixed; tests pass.' },
      messages: [
        { role: 'user', text: 'Fix the login bug.' },
        { role: 'assistant', text: 'Fixed; tests pass.' },
      ],
      hasMore: true,
      earliestSeq: 41,
    })
    expect(JSON.stringify(result)).not.toContain('hidden framing')

    await readRemoteConversation(deps, HOST, 'c-1', { beforeSeq: 41, messages: 2 })
    expect(calls.at(-1)?.[1]).toEqual(['c-1', { limit: REMOTE_READ_PAGE, beforeSeq: 41 }])
  })

  it('prefixes what it sends and calls chat:send on the host', async () => {
    const { deps, calls } = fakeHost()
    const admit = vi.fn(async () => true)
    const result = await sendRemoteConversation(deps, HOST, 'c-1', { message: 'Rebase on main.' }, admit)
    expect(result).toEqual({
      ok: true,
      status: 'delivered',
      conversationId: 'host:srv/workspaces:c-1',
      conversationName: 'Fix login',
    })
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'host:srv/workspaces:c-1' }),
      'Rebase on main.'
    )
    expect(calls.at(-1)).toEqual([
      'chat:send',
      [{ conversationId: 'c-1', text: '— via Maestrly Assistant\n\nRebase on main.', attachments: [] }],
    ])
  })

  it('does not send when the person declines, the host refuses, or the conversation is archived', async () => {
    const { deps, calls } = fakeHost({ send: { ok: false, error: 'busy' } })
    expect(await sendRemoteConversation(deps, HOST, 'c-1', { message: 'x' }, async () => false)).toMatchObject({
      code: 'declined',
    })
    expect(calls.some(([channel]) => channel === 'chat:send')).toBe(false)
    expect(await sendRemoteConversation(deps, HOST, 'c-1', { message: 'x' }, async () => true)).toEqual({
      ok: false,
      code: 'delivery-failed',
      error: 'busy',
    })
    expect(await sendRemoteConversation(deps, HOST, 'c-old', { message: 'x' }, async () => true)).toMatchObject({
      code: 'archived',
    })
    expect(await readRemoteConversation(deps, HOST, 'missing', {})).toMatchObject({ code: 'not-found' })
  })

  it('answers unavailable with the host name when it is offline', async () => {
    const { deps, calls } = fakeHost({ state: 'offline' })
    const result = await readRemoteConversation(deps, HOST, 'c-1', {})
    expect(result).toEqual({
      ok: false,
      code: 'unavailable',
      error: 'The remote computer "Workspaces" is not connected now; try again when it is back.',
    })
    expect(await sendRemoteConversation(deps, HOST, 'c-1', { message: 'x' }, async () => true)).toMatchObject({
      code: 'unavailable',
    })
    expect(calls).toEqual([])
  })

  it('refuses reportBack for a remote conversation', async () => {
    const { deps, calls } = fakeHost()
    const result = await sendRemoteConversation(deps, HOST, 'c-1', { message: 'x', reportBack: true }, async () => true)
    expect(result).toMatchObject({ ok: false, code: 'unavailable' })
    expect((result as { error: string }).error).toContain('reportBack')
    expect(calls).toEqual([])
  })
})

describe('the link tools with a remote ref', () => {
  const humans: HumanTurnOrigin[] = []
  const context = (overrides: Partial<ToolContext> = {}): ToolContext => ({
    conversationId: 'assistant',
    projectId: '',
    messageId: 'reply',
    toolCallId: 'call-1',
    cwd: '/',
    signal: new AbortController().signal,
    ask: async () => undefined,
    askQuestion: async () => [],
    ...overrides,
  })
  function typed(conversationId: string) {
    const origin = {
      token: {},
      conversationId,
      messageId: 'typed-1',
      text: 'manda',
      signal: new AbortController().signal,
    }
    recordHumanTurnOrigin(origin)
    humans.push(origin)
  }
  afterEach(() => {
    for (const origin of humans.splice(0)) clearHumanTurnOrigin(origin.conversationId, origin.token)
    setAssistantRoleResolver(null)
    setAssistantHostAccess(null)
    assistantActionBudget.clear('message:typed-1')
    vi.clearAllMocks()
  })

  it('gives a caller other than the assistant not-found for a host ref', async () => {
    typed('chat')
    const ctx = context({ conversationId: 'chat', conversationLink: conversationLinkRuntimeFor('chat', 'agent')! })
    const ref = 'host:srv/workspaces:c-1'
    expect(await readConversationTool.execute({ conversationId: ref }, ctx)).toMatchObject({ code: 'not-found' })
    expect(await sendToConversationTool.execute({ conversationId: ref, message: 'x' }, ctx)).toMatchObject({
      code: 'not-found',
    })
    expect(h.service.read).not.toHaveBeenCalled()
    expect(h.service.send).not.toHaveBeenCalled()
  })

  it('sends the assistant to the remote host, within its budget, and to this computer for a local ref', async () => {
    setAssistantRoleResolver((id) => id === 'assistant')
    typed('assistant')
    const { deps, calls } = fakeHost()
    setAssistantHostAccess({
      invoker: { online: () => true, invoke: deps.invoke },
      hosts: deps.hosts,
    })
    const askQuestion = vi.fn(async () => [['Cancel']])
    const ctx = context({
      conversationLink: conversationLinkRuntimeFor('assistant', 'agent')!,
      assistant: assistantRuntimeFor('assistant', 'agent')!,
      askQuestion,
    })
    for (const target of ['local:a', 'local:b', 'local:c']) assistantActionBudget.check('message:typed-1', target)
    const sent = await sendToConversationTool.execute(
      { conversationId: 'host:srv/workspaces:c-1', message: 'Go.' },
      ctx
    )
    expect(sent).toMatchObject({ ok: false, code: 'declined' })
    expect(askQuestion).toHaveBeenCalledOnce()
    expect(calls.some(([channel]) => channel === 'chat:send')).toBe(false)

    askQuestion.mockResolvedValue([['Send']])
    expect(
      await sendToConversationTool.execute({ conversationId: 'host:srv/workspaces:c-1', message: 'Go.' }, ctx)
    ).toMatchObject({
      ok: true,
      status: 'delivered',
    })
    expect(calls.at(-1)?.[0]).toBe('chat:send')

    expect(await readConversationTool.execute({ conversationId: 'host:srv/workspaces:c-1' }, ctx)).toMatchObject({
      conversation: { name: 'Fix login' },
    })
    expect(await waitConversationTool.execute({ conversationId: 'host:srv/workspaces:c-1' }, ctx)).toMatchObject({
      code: 'unavailable',
    })

    h.service.read.mockResolvedValue({ ok: true })
    await readConversationTool.execute({ conversationId: 'local:c-9' }, ctx)
    expect(h.service.read.mock.calls[0][1]).toEqual({ conversationId: 'c-9' })
  })
})
