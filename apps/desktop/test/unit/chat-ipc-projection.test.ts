import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Everything the main process pushed to the window, so an announcement can be read back verbatim. */
const pushed = vi.hoisted(() => [] as Array<[string, unknown]>)
vi.mock('../../src/main/window-ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/window-ipc')>()),
  getMainWebContents: () => ({
    isDestroyed: () => false,
    send: (channel: string, payload?: unknown) => void pushed.push([channel, payload]),
  }),
}))

vi.mock('../../src/main/chat/codex-subscription', () => ({
  compactCodexSubscriptionThread: vi.fn(),
  clearAllCodexThreadBindings: vi.fn(),
  deleteAllManagedCodexThreads: vi.fn(async () => []),
  deleteCodexThreadForConversation: vi.fn(async () => ({ conversationId: '', threadId: null, remoteDeleted: false })),
  retryManagedCodexThreadCleanup: vi.fn(async () => []),
  getCodexSubscriptionManager: () => ({
    getStatus: vi.fn(async () => ({
      state: 'ready',
      available: true,
      connected: true,
      authenticated: false,
      account: null,
      requiresOpenaiAuth: true,
      runtime: null,
      error: null,
    })),
    getStatusSnapshot: vi.fn(() => null),
    startLogin: vi.fn(),
    waitForLogin: vi.fn(() => new Promise<never>(() => {})),
    logout: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
    preferredServiceTier: vi.fn(async () => null),
    observeModelContextWindow: vi.fn(),
    getClient: vi.fn(),
    onAccountUpdated: vi.fn(() => () => {}),
  }),
  listCodexSubscriptionManagers: () => [],
  getCodexThreadBinding: vi.fn(() => null),
  putCodexThreadBinding: vi.fn(),
  runCodexSubscriptionChat: vi.fn(async () => ({ planSubmitted: false, threadId: 'thread-test' })),
}))
vi.mock('../../src/main/chat/portable-summarizer', () => ({
  summarizeWithCodexRuntime: vi.fn(async () => ({ text: 'portable summary' })),
  summarizeWithGitHubCopilotRuntime: vi.fn(),
}))

import type { ChatIpcDeps } from '../../src/main/chat/service'
import {
  chatRuntimeState,
  disposeChat,
  getChatPermissionBroker,
  primeChatTurnSelection,
  publishConvChatSettings,
  registerChatIpc,
} from '../../src/main/chat/service'
import { registerRemoteChatPolicy } from '../../src/main/chat/remote-policy'
import {
  deleteChatMessage,
  listChatMessages,
  upsertChatMessage,
  type StoredChatMessage,
} from '../../src/main/chat/chat-store'
import { mcpResultToChatToolOutput } from '../../src/main/chat/tool-output'
import { putToolExecution } from '../../src/main/chat/openai/inference-store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { addProvider, getProviderKind } from '../../src/main/chat/catalog'
import { clearApiKey, setApiKey } from '../../src/main/chat/credentials'
import { buildOpenAIProviderFingerprint } from '../../src/main/chat/provider'
import { getDb, patchConvUiPrefs } from '../../src/main/store'
import {
  toolOutputImages,
  type ChatHistoryStats,
  type ChatMessage,
  type MessagePart,
  type ToolOutput,
} from '../../src/shared/chat'

type Handler = (event: any, ...args: any[]) => unknown

function register(): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  registerChatIpc({
    mhandle: (channel, fn) => void handlers.set(channel, fn as Handler),
    mon: (channel, fn) => void handlers.set(channel, fn as Handler),
    emitStatus: vi.fn(),
  } satisfies ChatIpcDeps)
  return handlers
}

beforeEach(() => {
  pushed.length = 0
  freshDb()
})
afterEach(async () => {
  await disposeChat()
  closeDb()
})

const FP = 'a'.repeat(64)

/** What the window was told about one conversation, in order. */
const announcements = (conversationId: string) =>
  pushed.filter(([channel]) => channel.endsWith(`:${conversationId}`)).map(([channel, payload]) => [channel, payload])

describe('conversation settings the person did not choose', () => {
  it('announces an account, effort and mode moved by something other than the picker', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id)
    const provider = addProvider({ name: 'Custom', baseURL: 'https://api.example.test/v1/', kind: 'openai' })
    const handlers = register()
    pushed.length = 0

    // What a bot configuring its conversation does, and what a delegated stage or a failover does too.
    const moved = { providerId: provider.id, modelId: 'deepseek-v4-pro', reasoning: 'high' }
    primeChatTurnSelection(conversation.id, moved)
    expect(announcements(conversation.id)).toEqual([[`chat:settings:${conversation.id}`, undefined]])
    // The composer reads the moved values through the handlers it already uses.
    expect(handlers.get('chat:get-reasoning')!({}, conversation.id)).toBe('high')
    expect(handlers.get('chat:get-selection')!({}, conversation.id)).toMatchObject({ modelId: 'deepseek-v4-pro' })

    // Writing the same values again moves nothing, so a read that rewrites a fallback cannot loop.
    pushed.length = 0
    primeChatTurnSelection(conversation.id, moved)
    expect(announcements(conversation.id)).toEqual([])

    // The behavior mode is shown by the composer too, so moving it is announced the same way.
    await handlers.get('chat:set-mode')!({}, conversation.id, 'plan')
    expect(announcements(conversation.id)).toEqual([[`chat:settings:${conversation.id}`, undefined]])
    expect(handlers.get('chat:get-mode')!({}, conversation.id)).toBe('plan')

    // A change the composer does not show is not worth waking it up for.
    pushed.length = 0
    await handlers.get('chat:set-conv-tools')!({}, conversation.id, { app: true })
    expect(announcements(conversation.id)).toEqual([])
  })

  it('announces fast mode the moment a bot turns it on, and again when it goes out', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id)
    const provider = addProvider({ name: 'Custom', baseURL: 'https://api.example.test/v1/', kind: 'openai' })
    const handlers = register()
    pushed.length = 0

    // Exactly what a bot asking for fast mode leaves behind: the flag the next turn reads.
    const selection = { providerId: provider.id, modelId: 'deepseek-v4-pro', reasoning: 'high' }
    primeChatTurnSelection(conversation.id, { ...selection, fastMode: true })
    expect(handlers.get('chat:get-fast-mode')!({}, conversation.id)).toBe(true)
    expect(announcements(conversation.id)).toEqual([[`chat:settings:${conversation.id}`, undefined]])

    // Going out is announced too: a chip that only lit up would keep claiming a speed it no longer has.
    pushed.length = 0
    primeChatTurnSelection(conversation.id, { ...selection, fastMode: false })
    expect(handlers.get('chat:get-fast-mode')!({}, conversation.id)).toBe(false)
    expect(announcements(conversation.id)).toEqual([[`chat:settings:${conversation.id}`, undefined]])
  })

  it('announces settings a caller wrote around the merge, as a bot host does', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id)
    register()
    pushed.length = 0

    // A bot host replaces ui_prefs.chat wholesale instead of merging, then says so itself.
    patchConvUiPrefs(conversation.id, { chat: { mode: 'agent', permMode: 'auto' } })
    expect(announcements(conversation.id)).toEqual([])

    publishConvChatSettings(conversation.id)

    expect(announcements(conversation.id)).toEqual([[`chat:settings:${conversation.id}`, undefined]])
  })

  it('announces the permission mode a bot conversation runs under', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id)
    const handlers = register()
    pushed.length = 0

    await handlers.get('chat:set-perm-mode')!({}, conversation.id, 'auto')

    expect(announcements(conversation.id)).toEqual([[`chat:settings:${conversation.id}`, undefined]])
    expect(handlers.get('chat:get-perm-mode')!({}, conversation.id)).toBe('auto')
  })
})

describe('bot permission replies', () => {
  it('offers only one-operation approval and survives an unsupported persistent reply', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id)
    const release = registerRemoteChatPolicy({
      conversationId: conversation.id,
      cwd: conversation.cwd,
      mode: 'agent',
      permMode: 'ask',
      providerIds: ['fixture'],
      allowCommands: true,
      allowWeb: true,
      allowAppTools: true,
      allowMcp: false,
      allowPush: false,
    })
    const handler = register().get('chat:permission-respond')!
    const broker = getChatPermissionBroker()
    const decision = broker.assertDecision({
      conversationId: conversation.id,
      projectId: workspace.id,
      action: 'bash',
      resources: ['git status'],
      save: ['git status'],
    })
    const [request] = broker.pendingFor(conversation.id)
    try {
      expect.soft(chatRuntimeState(conversation.id).pendingPermissions[0].allowAlways).not.toBe(true)
      // A stale renderer can still send the old button's reply. It must not escape ipcMain.on.
      expect(() => handler({}, request.id, 'always')).not.toThrow()
      expect(broker.pendingFor(conversation.id)).toHaveLength(1)
      expect(getDb().prepare('SELECT * FROM permission_saved').all()).toHaveLength(0)
    } finally {
      handler({}, request.id, 'once')
      expect(await decision).toBe('once')
      release()
    }
  })

  it('keeps persistent approval available to local conversations', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id)
    patchConvUiPrefs(conversation.id, { chat: { permMode: 'ask' } })
    const handler = register().get('chat:permission-respond')!
    const broker = getChatPermissionBroker()
    const decision = broker.assertDecision({
      conversationId: conversation.id,
      projectId: workspace.id,
      action: 'bash',
      resources: ['git status'],
      save: ['git status'],
    })
    const [request] = broker.pendingFor(conversation.id)
    try {
      expect(chatRuntimeState(conversation.id).pendingPermissions[0].allowAlways).toBe(true)
      handler({}, request.id, 'always')
      expect(await decision).toBe('always')
      expect(getDb().prepare('SELECT action, resource FROM permission_saved').all()).toEqual([
        { action: 'bash', resource: 'git status' },
      ])
    } finally {
      broker.reply({ requestId: request.id, reply: 'once' })
      await decision
    }
  })
})

function storedWithIdentity(conversationId: string, id: string, contextIdentity = FP): StoredChatMessage {
  return {
    id,
    conversationId,
    role: 'assistant',
    createdAt: 1000,
    model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
    providerFingerprint: FP,
    usage: {
      usageVersion: 2,
      input: 10,
      output: 20,
      contextInput: 10,
      contextOutput: 20,
      contextIdentity,
    },
    parts: [
      { type: 'reasoning', id: `r-${id}`, text: 'Reasoning' },
      {
        type: 'tool',
        id: `k-${id}`,
        toolCallId: `k-${id}`,
        toolName: 'read',
        input: {},
        state: { status: 'completed', output: 'x' },
      },
    ],
  }
}

function assertNoIdentityLeak(value: unknown): void {
  const json = JSON.stringify(value)
  expect(json).not.toContain('providerFingerprint')
  expect(json).not.toContain('contextIdentity')
  expect(json).not.toContain(FP)
}

function toolImagePart(
  partId: string,
  output?: ToolOutput,
  status: 'running' | 'completed' = 'completed'
): Extract<MessagePart, { type: 'tool' }> {
  return {
    type: 'tool' as const,
    id: partId,
    toolCallId: partId,
    toolName: 'screenshot',
    input: {},
    state: output === undefined ? { status: 'running' } : { status, output },
  }
}

function toolImagePayload(conversationId: string, messageId: string, toolPartId: string, imageId: string) {
  return { conversationId, messageId, toolPartId, imageId }
}

describe('chat:tool-image ownership', () => {
  it('resolves a live running preview only for its persisted message/part owner', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { mode: 'local' })
    const output = mcpResultToChatToolOutput({
      content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    })
    const imageId = toolOutputImages(output)[0]!.id
    upsertChatMessage({
      id: 'live-message',
      conversationId: conversation.id,
      role: 'assistant',
      parts: [toolImagePart('live-part', output, 'running')],
      createdAt: 1,
    })

    const handler = register().get('chat:tool-image')!
    await expect(
      handler({}, toolImagePayload(conversation.id, 'live-message', 'live-part', imageId))
    ).resolves.toMatchObject({ ok: true, mediaType: 'image/png' })
  })

  it('rejects a handle from the wrong conversation or message', async () => {
    const workspace = makeWorkspace()
    const owner = makeConversation(workspace.id, { mode: 'local' })
    const other = makeConversation(workspace.id, { mode: 'local' })
    const output = mcpResultToChatToolOutput({
      content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    })
    const imageId = toolOutputImages(output)[0]!.id
    upsertChatMessage({
      id: 'owned-message',
      conversationId: owner.id,
      role: 'assistant',
      parts: [toolImagePart('owned-part', output)],
      createdAt: 1,
    })
    const handler = register().get('chat:tool-image')!

    await expect(handler({}, toolImagePayload(other.id, 'owned-message', 'owned-part', imageId))).resolves.toEqual({
      ok: false,
      error: 'not-found',
    })
    await expect(handler({}, toolImagePayload(owner.id, 'missing-message', 'owned-part', imageId))).resolves.toEqual({
      ok: false,
      error: 'not-found',
    })
  })

  it('allows a shared deduplicated handle for each live owner, then denies deleted owners', async () => {
    const workspace = makeWorkspace()
    const first = makeConversation(workspace.id, { mode: 'local' })
    const second = makeConversation(workspace.id, { mode: 'local' })
    const output = mcpResultToChatToolOutput({
      content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    })
    const echoed = mcpResultToChatToolOutput({
      content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    })
    const imageId = toolOutputImages(output)[0]!.id
    expect(toolOutputImages(echoed)[0]!.id).toBe(imageId)
    upsertChatMessage({
      id: 'first-message',
      conversationId: first.id,
      role: 'assistant',
      parts: [toolImagePart('first-part', output)],
      createdAt: 1,
    })
    upsertChatMessage({
      id: 'second-message',
      conversationId: second.id,
      role: 'assistant',
      parts: [toolImagePart('second-part', echoed)],
      createdAt: 2,
    })
    const handler = register().get('chat:tool-image')!

    await expect(
      handler({}, toolImagePayload(first.id, 'first-message', 'first-part', imageId))
    ).resolves.toMatchObject({ ok: true })
    await expect(
      handler({}, toolImagePayload(second.id, 'second-message', 'second-part', imageId))
    ).resolves.toMatchObject({ ok: true })

    deleteChatMessage('first-message')
    await expect(handler({}, toolImagePayload(first.id, 'first-message', 'first-part', imageId))).resolves.toEqual({
      ok: false,
      error: 'not-found',
    })
    await expect(
      handler({}, toolImagePayload(second.id, 'second-message', 'second-part', imageId))
    ).resolves.toMatchObject({ ok: true })

    deleteChatMessage('second-message')
    await expect(handler({}, toolImagePayload(second.id, 'second-message', 'second-part', imageId))).resolves.toEqual({
      ok: false,
      error: 'not-found',
    })
  })

  it('accepts an OpenAI tool sidecar owner tied to the same message and call', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { mode: 'local' })
    const output = mcpResultToChatToolOutput({
      content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    })
    const imageId = toolOutputImages(output)[0]!.id
    upsertChatMessage({
      id: 'sidecar-message',
      conversationId: conversation.id,
      role: 'assistant',
      parts: [toolImagePart('sidecar-part', 'running')],
      createdAt: 1,
    })
    putToolExecution({
      conversationId: conversation.id,
      messageId: 'sidecar-message',
      callId: 'sidecar-part',
      toolName: 'screenshot',
      inputHash: 'hash',
      status: 'completed',
      output,
    })

    const handler = register().get('chat:tool-image')!
    await expect(
      handler({}, toolImagePayload(conversation.id, 'sidecar-message', 'sidecar-part', imageId))
    ).resolves.toMatchObject({ ok: true })
  })
})

describe('history IPC contract: internal identity never crosses the boundary', () => {
  it('omits providerFingerprint and contextIdentity from history pages', () => {
    const conv = makeConversation(makeWorkspace().id, { mode: 'local' })
    upsertChatMessage(storedWithIdentity(conv.id, 'a1'))
    const handlers = register()
    const { messages } = handlers.get('chat:history:page')!({}, conv.id, { limit: 10 }) as {
      messages: ChatMessage[]
    }
    expect(messages).toHaveLength(1)
    expect(messages[0].model).toEqual({ providerId: 'deepseek', modelId: 'deepseek-v4-pro' })
    expect(messages[0].parts).toHaveLength(2)
    expect(messages[0]).not.toHaveProperty('providerFingerprint')
    expect(messages[0].usage).not.toHaveProperty('contextIdentity')
    expect(messages[0].usage).toMatchObject({ input: 10, output: 20 })
    assertNoIdentityLeak(messages[0])
  })

  it('omits providerFingerprint and contextIdentity from history pages', () => {
    const conv = makeConversation(makeWorkspace().id, { mode: 'local' })
    upsertChatMessage(storedWithIdentity(conv.id, 'a1'))
    upsertChatMessage(storedWithIdentity(conv.id, 'a2'))
    const handlers = register()
    const page = handlers.get('chat:history:page')?.({}, conv.id, { limit: 10 }) as {
      messages: ChatMessage[]
      hasMore: boolean
      earliestSeq: number | null
    }
    expect(page.messages.map((m) => m.id)).toEqual(['a1', 'a2'])
    for (const message of page.messages) {
      expect(message).not.toHaveProperty('providerFingerprint')
      expect(message.usage).not.toHaveProperty('contextIdentity')
      assertNoIdentityLeak(message)
    }
  })

  it('keeps full internal identity out of renderer payloads', () => {
    const conv = makeConversation(makeWorkspace().id, { mode: 'local' })
    upsertChatMessage(storedWithIdentity(conv.id, 'a1'))
    const handlers = register()
    const { messages: publicMessages } = handlers.get('chat:history:page')!({}, conv.id, { limit: 10 }) as {
      messages: ChatMessage[]
    }
    expect(publicMessages[0]).not.toHaveProperty('providerFingerprint')
    expect(publicMessages[0].usage).not.toHaveProperty('contextIdentity')
    const internal = listChatMessages(conv.id)
    expect(internal[0].providerFingerprint).toBe(FP)
    expect(internal[0].usage?.contextIdentity).toBe(FP)
  })
})

describe('IPC stats contract: contextIdentity never crosses the boundary while internal reuse continues', () => {
  it('removes stats identity while preserving context projection', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const provider = addProvider({ name: 'Custom', baseURL: 'https://api.example.test/v1/', kind: 'openai' })
    try {
      setApiKey(provider.id, 'first-key')
      const fp = buildOpenAIProviderFingerprint(provider, getProviderKind(provider), 'first-key')
      patchConvUiPrefs(conversation.id, {
        chat: { providerId: provider.id, modelId: 'fable' },
      })
      upsertChatMessage({
        id: 'user-1',
        conversationId: conversation.id,
        role: 'user',
        parts: [{ type: 'text', id: 't', text: 'x'.repeat(300_000) }],
        createdAt: 1,
      })
      upsertChatMessage({
        id: 'assistant-measured',
        conversationId: conversation.id,
        role: 'assistant',
        parts: [{ type: 'text', id: 'answer', text: 'done' }],
        model: { providerId: provider.id, modelId: 'fable' },
        providerFingerprint: fp,
        usage: {
          usageVersion: 2,
          input: 48_000,
          output: 2_000,
          contextInput: 48_000,
          contextOutput: 2_000,
          contextIdentity: fp,
        },
        createdAt: 2,
      })

      const stats = (await handlers.get('chat:history:stats')?.({}, conversation.id)) as ChatHistoryStats
      expect(stats.contextProjection).toMatchObject({
        usedTokens: 50_000,
        source: 'runtime-usage',
        quality: 'measured',
      })
      expect(stats.lastUsage).not.toHaveProperty('contextIdentity')
      expect(stats.lastUsage).toMatchObject({ input: 48_000, output: 2_000 })
      assertNoIdentityLeak(stats)

      // Changed credential fingerprints invalidate native measurements and require portable transcripts.
      setApiKey(provider.id, 'rotated-key')
      const after = (await handlers.get('chat:history:stats')?.({}, conversation.id)) as ChatHistoryStats
      expect(after.contextProjection).toMatchObject({ source: 'portable-transcript', quality: 'estimated' })
      expect(after.contextProjection!.usedTokens).toBeGreaterThan(90_000)
      expect(after.lastUsage).not.toHaveProperty('contextIdentity')
      assertNoIdentityLeak(after)

      // The internal payload still has its original identity.
      const internal = listChatMessages(conversation.id)
      expect(internal.find((m) => m.id === 'assistant-measured')?.usage?.contextIdentity).toBe(fp)
    } finally {
      clearApiKey(provider.id)
    }
  })
})
