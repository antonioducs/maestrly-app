import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshDb, closeDb } from '../helpers/db'
import { makeWorkspace, makeConversation } from '../helpers/factories'
import {
  aggregateChatUsage,
  clearChatMessages,
  deleteChatMessage,
  deleteChatMessagesFrom,
  getMessageSeq,
  listChatMessages,
  upsertChatMessage,
} from '../../src/main/chat/chat-store'
import {
  clearEphemeralToolImages,
  mcpResultToChatToolOutput,
  resolveEphemeralToolImage,
} from '../../src/main/chat/tool-output'
import {
  PermissionBroker,
  PermissionCancelledError,
  AUTO_RULESET,
  BYOK_DEFAULT_RULESET,
  YOLO_RULESET,
  type PermissionRequest,
} from '../../src/main/chat/permission'
import {
  addProvider,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  getProvider,
  getProviderKind,
  GITHUB_COPILOT_SUBSCRIPTION_PROVIDER_ID,
  isAnthropicProvider,
  isManagedProvider,
  isOpenAIResponsesProvider,
  isSubscriptionProvider,
  listAvailableChatProviders,
  listProviders,
  removeProvider,
  updateProvider,
} from '../../src/main/chat/catalog'
import { getAppFlag, getAppSetting, setAppSetting } from '../../src/main/store'
import { addMcpServer, listMcpServers, removeMcpServer, updateMcpServer } from '../../src/main/chat/mcp'
import {
  defaultProviderKind,
  CHATGPT_WEB_PROVIDER_ID,
  effectiveProviderKind,
  isOfficialOpenAIProvider,
  toolOutputImages,
  type ChatMessage,
} from '../../src/shared/chat'

beforeEach(freshDb)
afterEach(() => {
  clearEphemeralToolImages()
  closeDb()
})

function chatConv() {
  const ws = makeWorkspace()
  const conv = makeConversation(ws.id, { mode: 'local' })
  return { ws, conv }
}

describe('chat-store (chat_messages)', () => {
  it('round-trips messages in sequence order', () => {
    const { conv } = chatConv()
    const u: ChatMessage = {
      id: 'm1',
      conversationId: conv.id,
      role: 'user',
      parts: [{ type: 'text', id: 't', text: 'hi' }],
      createdAt: 1,
    }
    const a: ChatMessage = {
      id: 'm2',
      conversationId: conv.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 'x', text: 'hello' }],
      model: { providerId: 'mimo', modelId: 'mimo-v2.5-pro' },
      error: 'Sign in again.',
      errorCode: 'claude-authentication-required',
      responseDurationMs: 12_345,
      source: 'chatgpt-web',
      createdAt: 2,
    }
    upsertChatMessage(u)
    upsertChatMessage(a)
    const rows = listChatMessages(conv.id)
    expect(rows.map((r) => r.id)).toEqual(['m1', 'm2'])
    expect(rows[1].model).toEqual({ providerId: 'mimo', modelId: 'mimo-v2.5-pro' })
    expect(rows[1].responseDurationMs).toBe(12_345)
    expect(rows[1].errorCode).toBe('claude-authentication-required')
    expect(rows[1].source).toBe('chatgpt-web')
    expect(rows[0].parts).toEqual([{ type: 'text', id: 't', text: 'hi' }])
  })

  it('updates parts without changing message sequence', () => {
    const { conv } = chatConv()
    upsertChatMessage({ id: 'm1', conversationId: conv.id, role: 'user', parts: [], createdAt: 1 })
    upsertChatMessage({ id: 'm2', conversationId: conv.id, role: 'assistant', parts: [], createdAt: 2 })
    // Repeated streaming updates must not reorder or duplicate messages.
    upsertChatMessage({
      id: 'm2',
      conversationId: conv.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 'x', text: 'a' }],
      createdAt: 2,
    })
    upsertChatMessage({
      id: 'm2',
      conversationId: conv.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 'x', text: 'ab' }],
      createdAt: 2,
    })
    const rows = listChatMessages(conv.id)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.id)).toEqual(['m1', 'm2'])
    expect(rows[1].parts).toEqual([{ type: 'text', id: 'x', text: 'ab' }])
  })

  it('truncates resend history from the edited message', () => {
    const { conv } = chatConv()
    upsertChatMessage({ id: 'm1', conversationId: conv.id, role: 'user', parts: [], createdAt: 1 })
    upsertChatMessage({ id: 'm2', conversationId: conv.id, role: 'assistant', parts: [], createdAt: 2 })
    upsertChatMessage({ id: 'm3', conversationId: conv.id, role: 'user', parts: [], createdAt: 3 })
    const seq = getMessageSeq('m2')
    expect(seq).not.toBeNull()
    deleteChatMessagesFrom(conv.id, seq!)
    expect(listChatMessages(conv.id).map((r) => r.id)).toEqual(['m1'])
  })

  it('clears transcripts without clearing usage ledgers', async () => {
    const { conv } = chatConv()
    upsertChatMessage({
      id: 'm1',
      conversationId: conv.id,
      role: 'assistant',
      parts: [],
      model: { providerId: 'p', modelId: 'm' },
      usage: { input: 10, output: 2 },
      createdAt: 1,
    })
    await clearChatMessages(conv.id)
    expect(listChatMessages(conv.id)).toEqual([])
    expect(aggregateChatUsage()).toMatchObject({ totalTurns: 1 })
  })

  it('CASCADE: deleting a conversation removes its messages', async () => {
    const { conv } = chatConv()
    upsertChatMessage({
      id: 'm1',
      conversationId: conv.id,
      role: 'assistant',
      parts: [],
      model: { providerId: 'p', modelId: 'm' },
      usage: { input: 10, output: 2 },
      createdAt: 1,
    })
    const { deleteConversation } = await import('../../src/main/store')
    deleteConversation(conv.id)
    expect(listChatMessages(conv.id)).toEqual([])
    expect(aggregateChatUsage()).toMatchObject({ totalTurns: 1 })
  })

  it('does not refund recorded usage when messages are deleted', () => {
    const { conv } = chatConv()
    for (const [id, createdAt] of [
      ['m1', 1],
      ['m2', 2],
      ['m3', 3],
    ] as const) {
      upsertChatMessage({
        id,
        conversationId: conv.id,
        role: 'assistant',
        parts: [],
        model: { providerId: 'p', modelId: 'm' },
        usage: { input: 10, output: 2 },
        createdAt,
      })
    }
    deleteChatMessage('m1')
    deleteChatMessagesFrom(conv.id, getMessageSeq('m2')!)
    expect(listChatMessages(conv.id)).toEqual([])
    expect(aggregateChatUsage()).toMatchObject({ totalTurns: 3 })
  })

  it('releases images without durable owners after deletion', () => {
    const { conv } = chatConv()
    const output = mcpResultToChatToolOutput({
      content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    })
    const imageId = toolOutputImages(output)[0]!.id
    upsertChatMessage({
      id: 'tool-message',
      conversationId: conv.id,
      role: 'assistant',
      parts: [
        {
          type: 'tool',
          id: 'tool-part',
          toolCallId: 'call-1',
          toolName: 'screenshot',
          input: {},
          state: { status: 'completed', output },
        },
      ],
      createdAt: 1,
    })

    expect(resolveEphemeralToolImage({ id: imageId })).not.toBeNull()
    deleteChatMessage('tool-message')
    expect(resolveEphemeralToolImage({ id: imageId })).toBeNull()
  })

  it('preserves deduplicated content owned by other conversations', async () => {
    const { conv } = chatConv()
    const survivor = makeConversation(conv.workspaceId, { mode: 'local' })
    const output = mcpResultToChatToolOutput({
      content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    })
    const echoed = mcpResultToChatToolOutput({
      content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    })
    const imageId = toolOutputImages(output)[0]!.id
    expect(toolOutputImages(echoed)[0]!.id).toBe(imageId)
    const toolPart = (id: string, result: typeof output) => ({
      type: 'tool' as const,
      id: `${id}-part`,
      toolCallId: `${id}-call`,
      toolName: 'screenshot',
      input: {},
      state: { status: 'completed' as const, output: result },
    })
    upsertChatMessage({
      id: 'owned-by-cleared-conversation',
      conversationId: conv.id,
      role: 'assistant',
      parts: [toolPart('cleared', output)],
      createdAt: 1,
    })
    upsertChatMessage({
      id: 'owned-by-survivor',
      conversationId: survivor.id,
      role: 'assistant',
      parts: [toolPart('survivor', echoed)],
      createdAt: 2,
    })

    await clearChatMessages(conv.id)
    expect(resolveEphemeralToolImage({ id: imageId })).not.toBeNull()

    deleteChatMessagesFrom(survivor.id, getMessageSeq('owned-by-survivor')!)
    expect(resolveEphemeralToolImage({ id: imageId })).toBeNull()
  })
})

describe('user-defined BYOK provider catalog', () => {
  it('starts empty and supports provider CRUD', () => {
    expect(listProviders()).toEqual([])
    const p = addProvider({ name: 'My Provider', baseURL: 'https://api.example.com/v1/' })
    expect(p.id).toMatch(/^prov_/)
    expect(p.baseURL).toBe('https://api.example.com/v1') // Normalizes the trailing slash.
    const list = listProviders()
    expect(list).toHaveLength(1)
    expect(getProvider(p.id)?.name).toBe('My Provider')
    removeProvider(p.id)
    expect(listProviders()).toEqual([])
  })

  it('validates provider names and HTTP URLs', () => {
    expect(() => addProvider({ name: '', baseURL: 'https://x.com' })).toThrow(/name/i)
    expect(() => addProvider({ name: 'X', baseURL: 'ftp://x.com' })).toThrow(/baseURL/i)
    expect(() => addProvider({ name: 'X', baseURL: 'without-protocol' })).toThrow(/baseURL/i)
  })

  it('updateProvider edits name and baseURL', () => {
    const p = addProvider({ name: 'A', baseURL: 'https://a.com/v1' })
    updateProvider(p.id, { name: 'B', baseURL: 'https://b.com/v1' })
    expect(getProvider(p.id)).toEqual({ id: p.id, name: 'B', baseURL: 'https://b.com/v1' })
  })

  it('allows multiple providers to coexist', () => {
    const a = addProvider({ name: 'A', baseURL: 'https://a.com/v1' })
    const b = addProvider({ name: 'B', baseURL: 'https://b.com/v1' })
    expect(
      listProviders()
        .map((p) => p.id)
        .sort()
    ).toEqual([a.id, b.id].sort())
  })
})

describe('mcp (chat MCP servers)', () => {
  it('supports HTTP and stdio server CRUD and toggles', () => {
    expect(listMcpServers()).toEqual([])
    const http = addMcpServer({
      name: 'drawer',
      transport: 'http',
      url: 'http://127.0.0.1:8932/mcp',
      headers: { Authorization: 'Bearer x' },
    })
    expect(http.id).toMatch(/^mcp_/)
    expect(http.enabled).toBe(true)
    const stdio = addMcpServer({ name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', '@x/fs'] })
    expect(listMcpServers()).toHaveLength(2)
    updateMcpServer(http.id, { enabled: false })
    expect(listMcpServers().find((s) => s.id === http.id)?.enabled).toBe(false)
    removeMcpServer(stdio.id)
    expect(listMcpServers().map((s) => s.id)).toEqual([http.id])
  })

  it('validates transport-specific server fields', () => {
    expect(() => addMcpServer({ name: '', transport: 'http', url: 'http://x' })).toThrow(/name/i)
    expect(() => addMcpServer({ name: 'X', transport: 'http', url: 'not-url' })).toThrow(/URL/i)
    expect(() => addMcpServer({ name: 'X', transport: 'stdio', command: '' })).toThrow(/command/i)
  })
})

/** assert() emits asked SYNCHRONOUSLY before await: capture the request before responding. */
function pendingAsk(broker: PermissionBroker, args: Parameters<PermissionBroker['assert']>[0]) {
  let req: PermissionRequest | null = null
  const onAsked = (r: PermissionRequest) => {
    req = r
  }
  broker.on('asked', onAsked)
  const promise = broker.assert(args).finally(() => broker.off('asked', onAsked))
  return { promise, req: () => req }
}

describe('PermissionBroker (port of permission.ts)', () => {
  it('read allows immediately under default BYOK rules without asking', async () => {
    const broker = new PermissionBroker({ rulesetFor: () => BYOK_DEFAULT_RULESET })
    await expect(
      broker.assert({ conversationId: 'c', projectId: 'w', action: 'read', resources: ['a.ts'] })
    ).resolves.toBeUndefined()
  })

  it('requires permission for environment files', async () => {
    const broker = new PermissionBroker({ rulesetFor: () => BYOK_DEFAULT_RULESET })
    const { promise, req } = pendingAsk(broker, {
      conversationId: 'c',
      projectId: 'w',
      action: 'read',
      resources: ['.env'],
    })
    expect(req()).toBeTruthy()
    broker.reply({ requestId: req()!.id, reply: 'once' })
    await expect(promise).resolves.toBeUndefined()
  })

  it('allows one-time shell permission decisions', async () => {
    const broker = new PermissionBroker({ rulesetFor: () => BYOK_DEFAULT_RULESET })
    const { promise, req } = pendingAsk(broker, {
      conversationId: 'c',
      projectId: 'w',
      action: 'bash',
      resources: ['ls'],
      save: ['ls'],
      toolCallId: 'k',
    })
    expect(req()?.action).toBe('bash')
    expect(req()?.title).toContain('ls')
    broker.reply({ requestId: req()!.id, reply: 'once' })
    await expect(promise).resolves.toBeUndefined()
  })

  it('distinguishes rejection from correction errors', async () => {
    const broker = new PermissionBroker({ rulesetFor: () => BYOK_DEFAULT_RULESET })
    const a = pendingAsk(broker, { conversationId: 'c', projectId: 'w', action: 'bash', resources: ['rm -rf'] })
    broker.reply({ requestId: a.req()!.id, reply: 'reject' })
    await expect(a.promise).rejects.toThrow(/denied by the user/i)

    const b = pendingAsk(broker, { conversationId: 'c', projectId: 'w', action: 'bash', resources: ['rm -rf'] })
    broker.reply({ requestId: b.req()!.id, reply: 'reject', message: 'use a tool edit' })
    await expect(b.promise).rejects.toThrow('use a tool edit')
  })

  it('persists always rules for subsequent resource requests', async () => {
    freshDb() // Requires permission_saved (created by initStore).
    const broker = new PermissionBroker({ rulesetFor: () => BYOK_DEFAULT_RULESET })
    const a = pendingAsk(broker, {
      conversationId: 'c',
      projectId: 'w',
      action: 'bash',
      resources: ['npm test'],
      save: ['npm test'],
    })
    broker.reply({ requestId: a.req()!.id, reply: 'always' })
    await expect(a.promise).resolves.toBeUndefined()
    // Second assertion for the SAME command: saved allow rule overrides ask and resolves immediately.
    await expect(
      broker.assert({ conversationId: 'c', projectId: 'w', action: 'bash', resources: ['npm test'] })
    ).resolves.toBeUndefined()
  })

  it('aborts pending gates without persisting session rules', async () => {
    const broker = new PermissionBroker({ rulesetFor: () => BYOK_DEFAULT_RULESET })
    const controller = new AbortController()
    const asked: PermissionRequest[] = []
    const resolved: Array<{ requestId: string; decision: string }> = []
    broker.on('asked', (request: PermissionRequest) => asked.push(request))
    broker.on('resolved', (event: { requestId: string; decision: string }) => resolved.push(event))

    const pending = broker.assertDecision({
      conversationId: 'c',
      projectId: 'w',
      action: 'bash',
      resources: ['npm test'],
      save: ['npm test *'],
      signal: controller.signal,
    })
    expect(broker.pendingFor('c')).toHaveLength(1)

    controller.abort()

    await expect(pending).rejects.toBeInstanceOf(PermissionCancelledError)
    expect(broker.pendingFor('c')).toEqual([])
    expect(resolved).toEqual([expect.objectContaining({ requestId: asked[0].id, decision: 'deny' })])

    const retry = broker.assertDecision({
      conversationId: 'c',
      projectId: 'w',
      action: 'bash',
      resources: ['npm test'],
    })
    expect(broker.pendingFor('c')).toHaveLength(1)
    broker.reply({ requestId: broker.pendingFor('c')[0].id, reply: 'once' })
    await expect(retry).resolves.toBe('once')
  })

  it('enabled YOLO allows everything with a blanket rule', async () => {
    const broker = new PermissionBroker({ rulesetFor: () => YOLO_RULESET })
    await expect(
      broker.assert({ conversationId: 'c', projectId: 'w', action: 'bash', resources: ['rm -rf /'] })
    ).resolves.toBeUndefined()
  })

  it('auto mode allows edit/webfetch/mcp and asks for bash', async () => {
    const broker = new PermissionBroker({ rulesetFor: () => AUTO_RULESET })
    // edit and webfetch are allowed in auto mode.
    await expect(
      broker.assert({ conversationId: 'c', projectId: 'w', action: 'edit', resources: ['a.ts'] })
    ).resolves.toBeUndefined()
    await expect(
      broker.assert({ conversationId: 'c', projectId: 'w', action: 'webfetch', resources: ['https://x'] })
    ).resolves.toBeUndefined()
    // bash continua pedindo
    const a = pendingAsk(broker, { conversationId: 'c', projectId: 'w', action: 'bash', resources: ['ls'] })
    expect(a.req()?.action).toBe('bash')
    broker.reply({ requestId: a.req()!.id, reply: 'once' })
    await expect(a.promise).resolves.toBeUndefined()
  })

  it('cascades rejection across conversation requests', async () => {
    const broker = new PermissionBroker({ rulesetFor: () => BYOK_DEFAULT_RULESET })
    const a = pendingAsk(broker, { conversationId: 'c', projectId: 'w', action: 'bash', resources: ['cmd1'] })
    const b = pendingAsk(broker, { conversationId: 'c', projectId: 'w', action: 'bash', resources: ['cmd2'] })
    broker.reply({ requestId: a.req()!.id, reply: 'reject' })
    await expect(a.promise).rejects.toThrow()
    await expect(b.promise).rejects.toThrow()
  })
})

describe('provider format defaults and explicit overrides', () => {
  it('keeps ChatGPT and Copilot virtual rather than persisted BYOK', () => {
    const available = listAvailableChatProviders()
    expect(available.some((provider) => provider.id === CHATGPT_WEB_PROVIDER_ID)).toBe(false)
    expect(available.slice(0, 2).map((provider) => provider.id)).toEqual([
      CODEX_SUBSCRIPTION_PROVIDER_ID,
      GITHUB_COPILOT_SUBSCRIPTION_PROVIDER_ID,
    ])
    expect(available[1]).toMatchObject({
      kind: 'github-copilot-subscription',
      builtin: 'github-copilot-subscription',
      baseURL: 'copilot://github-subscription',
    })
    expect(isSubscriptionProvider(GITHUB_COPILOT_SUBSCRIPTION_PROVIDER_ID)).toBe(true)
    expect(listProviders()).toEqual([])
    expect(() =>
      addProvider({
        name: 'fake',
        baseURL: 'https://example.test',
        kind: 'github-copilot-subscription',
      })
    ).toThrow(/reserved/i)
  })

  it('treats companions as managed providers', () => {
    expect(isManagedProvider(CHATGPT_WEB_PROVIDER_ID)).toBe(true)
    expect(isManagedProvider('prov_usuario')).toBe(false)
  })

  it('derives default provider kind from supported hosts', () => {
    expect(defaultProviderKind('https://api.anthropic.com/v1')).toBe('anthropic')
    expect(defaultProviderKind('https://api.anthropic.com')).toBe('anthropic')
    expect(defaultProviderKind('https://api.openai.com/v1')).toBe('openai-responses')
    expect(defaultProviderKind('https://api.openai.com')).toBe('openai-responses')
    expect(defaultProviderKind('http://localhost:3000/v1')).toBe('openai')
    expect(defaultProviderKind('https://openrouter.ai/api/v1')).toBe('openai')
    expect(defaultProviderKind('not-a-url')).toBe('openai')
  })

  it('forces Responses only for official OpenAI hosts', () => {
    expect(isOfficialOpenAIProvider('https://api.openai.com/v1')).toBe(true)
    expect(isOfficialOpenAIProvider('https://API.OPENAI.COM/v1')).toBe(true)
    expect(isOfficialOpenAIProvider('https://api.openai.com.evil.test/v1')).toBe(false)
    expect(isOfficialOpenAIProvider('https://openrouter.ai/api/v1')).toBe(false)
    expect(effectiveProviderKind('https://api.openai.com/v1', 'openai')).toBe('openai-responses')
    expect(effectiveProviderKind('https://openrouter.ai/api/v1', 'openai')).toBe('openai')
    expect(effectiveProviderKind('https://api.anthropic.com/v1', 'anthropic')).toBe('anthropic')
  })

  it('missing kind derives it from the host', () => {
    const anth = addProvider({ name: 'Anthropic', baseURL: 'https://api.anthropic.com/v1' })
    const other = addProvider({ name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1' })
    expect(isAnthropicProvider(anth.id)).toBe(true)
    expect(isAnthropicProvider(other.id)).toBe(false)
    expect(isAnthropicProvider('prov_inexistente')).toBe(false)
    expect(getProviderKind(undefined)).toBe('openai')
  })

  it('lets explicit kinds override host defaults', () => {
    const proxy = addProvider({ name: 'Proxy', baseURL: 'http://localhost:3000/v1', kind: 'anthropic' })
    const forcedOai = addProvider({
      name: 'Anthropic via compat',
      baseURL: 'https://api.anthropic.com/v1',
      kind: 'openai',
    })
    expect(isAnthropicProvider(proxy.id)).toBe(true)
    expect(isAnthropicProvider(forcedOai.id)).toBe(false)
    expect(getProviderKind(getProvider(proxy.id))).toBe('anthropic')
    expect(getProviderKind(getProvider(forcedOai.id))).toBe('openai')
    // Provider kinds survive JSON round trips.
    expect(listProviders().find((p) => p.id === proxy.id)?.kind).toBe('anthropic')
  })

  it('round-trips Responses kinds through provider CRUD', () => {
    // Host default without kind: api.openai.com resolves to responses.
    const byHost = addProvider({ name: 'OpenAI', baseURL: 'https://api.openai.com/v1' })
    expect(isOpenAIResponsesProvider(byHost.id)).toBe(true)
    expect(getProviderKind(getProvider(byHost.id))).toBe('openai-responses')

    // Explicit local gateway kinds survive JSON round trips.
    const gateway = addProvider({ name: 'Gateway', baseURL: 'http://localhost:4145/v1', kind: 'openai-responses' })
    expect(listProviders().find((p) => p.id === gateway.id)?.kind).toBe('openai-responses')
    expect(isOpenAIResponsesProvider(gateway.id)).toBe(true)

    // Switch back to compatible through updateProvider (UI escape hatch).
    updateProvider(gateway.id, { kind: 'openai' })
    expect(isOpenAIResponsesProvider(gateway.id)).toBe(false)
    expect(getProviderKind(getProvider(gateway.id))).toBe('openai')
  })

  it('derives host defaults for unknown persisted kinds', () => {
    // Migration ignores unknown kinds; provider parsing discards them.
    setAppSetting(
      'chat.providers',
      JSON.stringify([{ id: 'p1', name: 'X', baseURL: 'https://api.openai.com/v1', kind: 'bogus' }])
    )
    expect(listProviders().find((p) => p.id === 'p1')?.kind).toBeUndefined()
    // Without valid kinds, derive defaults from hosts.
    expect(getProviderKind(getProvider('p1'))).toBe('openai-responses')
  })

  it('idempotently migrates official OpenAI to Responses', () => {
    // Simulate legacy explicit OpenAI-compatible kinds on official hosts.
    setAppSetting(
      'chat.providers',
      JSON.stringify([
        { id: 'oai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', kind: 'openai' },
        { id: 'router', name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', kind: 'openai' },
      ])
    )
    expect(getAppFlag('chat.providersKindMigrated', false)).toBe(false)

    // The first read triggers migration.
    const list = listProviders()
    expect(list.find((p) => p.id === 'oai')?.kind).toBe('openai-responses') // migrado
    expect(list.find((p) => p.id === 'router')?.kind).toBe('openai') // Non-openai.com remains untouched.
    expect(getAppFlag('chat.providersKindMigrated', false)).toBe(true)

    // Later legacy writes remain untouched, but runtime resolution ignores divergent kinds.
    updateProvider('oai', { kind: 'openai' })
    expect(listProviders().find((p) => p.id === 'oai')?.kind).toBe('openai')
    expect(getProviderKind(getProvider('oai'))).toBe('openai-responses')
    expect(isOpenAIResponsesProvider('oai')).toBe(true)
    // Generic gateways retain explicit compatible overrides.
    expect(getProviderKind(getProvider('router'))).toBe('openai')
    const raw = JSON.parse(getAppSetting('chat.providers') ?? '[]')
    expect(raw.find((p: { id: string }) => p.id === 'oai')?.kind).toBe('openai')
  })
})
