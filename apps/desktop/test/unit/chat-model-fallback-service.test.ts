import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessagePart } from '../../src/shared/chat'

/**
 * Model fallback of a conversation turn runs in startSend, the same way for every runtime: the BYOK runner stands in
 * for all of them here. Mocks follow the Plan-mode guard service tests.
 */

const h = vi.hoisted(() => ({
  getMainWebContents: vi.fn(),
  getConversation: vi.fn(),
  getConvUiPrefs: vi.fn(),
  patchConvUiPrefs: vi.fn(),
  getAppFlag: vi.fn(),
  getAppSetting: vi.fn(),
  updateConversationStatus: vi.fn(),
  upsertChatMessage: vi.fn(),
  listConversationContextMessages: vi.fn(() => [] as unknown[]),
  hasApiKey: vi.fn((_id: string) => true),
  runChat: vi.fn(),
  providerWindow: vi.fn((_providerId: string, _modelId: string) => Promise.resolve(undefined as number | undefined)),
  isClaude: vi.fn((_id: string) => false),
  freezeFailoverChain: vi.fn((id: string) => [id]),
  resolveClaudeRuntimeTarget: vi.fn(),
}))

const CLAUDE = 'builtin_claude_subscription'
const providers = [
  { id: CLAUDE, name: 'Claude', baseURL: '' },
  { id: 'provider-1', name: 'Primary', baseURL: 'https://primary.example.test/v1' },
  { id: 'provider-2', name: 'Fallback', baseURL: 'https://fallback.example.test/v1' },
]

vi.mock('../../src/main/window-ipc', () => ({ getMainWebContents: h.getMainWebContents }))

vi.mock('../../src/main/store', () => ({
  getConversation: h.getConversation,
  getConvUiPrefs: h.getConvUiPrefs,
  getAppFlag: h.getAppFlag,
  getAppSetting: h.getAppSetting,
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({ get: vi.fn(() => undefined), all: vi.fn(() => []), run: vi.fn() })),
  })),
  getLocale: vi.fn(() => 'en'),
  updateConversationStatus: h.updateConversationStatus,
  patchConvUiPrefs: h.patchConvUiPrefs,
  setAppFlag: vi.fn(),
  setAppSetting: vi.fn(),
}))

vi.mock('../../src/main/chat/catalog', () => ({
  PROVIDER_PRESETS: [],
  CODEX_SUBSCRIPTION_PROVIDER_ID: 'builtin_codex_subscription',
  getProvider: vi.fn((id: string) => providers.find((provider) => provider.id === id)),
  getProviderKind: vi.fn(() => 'openai'),
  isClaudeSubscriptionProvider: h.isClaude,
  isCursorSubscriptionProvider: vi.fn(() => false),
  isAntigravitySubscriptionProvider: vi.fn(() => false),
  isGrokSubscriptionProvider: vi.fn(() => false),
  isCodexSubscriptionProvider: vi.fn(() => false),
  isGitHubCopilotSubscriptionProvider: vi.fn(() => false),
  isSubscriptionProvider: h.isClaude,
  subscriptionAccountId: vi.fn(() => null),
  subscriptionProviderIdFor: vi.fn(() => 'builtin'),
  getSubscriptionAccount: vi.fn(() => undefined),
  addSubscriptionAccount: vi.fn(),
  renameSubscriptionAccount: vi.fn(),
  removeSubscriptionAccount: vi.fn(),
  listAvailableChatProviders: vi.fn(() => providers),
  listProviders: vi.fn(() => providers),
}))

vi.mock('../../src/main/chat/subscription-failover', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/subscription-failover')>()),
  freezeFailoverChain: h.freezeFailoverChain,
}))

vi.mock('../../src/main/chat/subscription-failover/claude-adapter', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/subscription-failover/claude-adapter')>()),
  resolveClaudeRuntimeTarget: h.resolveClaudeRuntimeTarget,
}))

vi.mock('../../src/main/chat/credentials', () => ({
  apiKeyStorageMode: vi.fn(() => 'secure'),
  hasApiKey: h.hasApiKey,
}))

vi.mock('../../src/main/chat/chat-store', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/chat-store')>()),
  lastConversationContextMessage: vi.fn(() => null),
  getChatMessage: vi.fn(() => null),
  listUndeliveredReviewReports: vi.fn(() => []),
  chatHistoryStats: vi.fn(() => ({ lastUsage: null })),
  listChatMessages: vi.fn(() => []),
  listConversationContextMessages: h.listConversationContextMessages,
  listActiveConversationContextMessages: h.listConversationContextMessages,
  upsertChatMessage: h.upsertChatMessage,
}))

vi.mock('../../src/main/chat/runner', () => ({
  normalizeAiUsage: vi.fn(() => ({ input: 0, output: 0, totalInput: 0, cacheRead: 0, cacheCreate: 0 })),
  runChat: h.runChat,
}))

vi.mock('../../src/main/chat/models', () => ({
  fetchModels: vi.fn(() => Promise.resolve(['model-1'])),
  fetchModelWindow: vi.fn(() => Promise.resolve(undefined)),
  invalidateModels: vi.fn(),
}))

vi.mock('../../src/main/chat/context-limits', () => ({
  getContextLimit: vi.fn(() => undefined),
  setContextLimit: vi.fn(),
  resolveContextWindow: vi.fn((inputs: { providerWindow?: number }) => inputs.providerWindow),
}))

vi.mock('../../src/main/chat/model-meta', () => ({
  catalogProviderForBaseURL: vi.fn(() => null),
  composeEffectiveMeta: vi.fn(() => null),
  getModelMeta: vi.fn(() => Promise.resolve(null)),
  getProviderModelMeta: vi.fn(() => Promise.resolve(null)),
  filterChatModels: vi.fn((models: string[]) => models),
}))

vi.mock('../../src/main/chat/provider', () => ({
  ChatConfigError: class ChatConfigError extends Error {},
  invalidateProvider: vi.fn(),
  resolveChatHarnessMetadata: vi.fn(() => ({ harnessProfile: 'legacy', capabilities: {} })),
  resolveLanguageModel: vi.fn(),
}))

vi.mock('../../src/main/chat/mcp', () => ({
  listMcpServers: vi.fn(() => []),
  listRuntimeMcpServers: vi.fn(() => []),
}))

vi.mock('../../src/main/chat/context-window-discovery', () => ({
  forgetLearnedContextWindow: vi.fn(),
  learnContextLimitFromError: vi.fn(() => false),
  learnContextLimitFromFailureText: vi.fn(() => false),
  resolveProviderContextWindow: h.providerWindow,
}))

vi.mock('../../src/main/plugins/runtime', async (original) => ({
  ...(await original<typeof import('../../src/main/plugins/runtime')>()),
  listPluginHooks: () => [],
}))

import { MODEL_FALLBACK_CONTINUE_PROMPT } from '../../src/main/chat/model-fallback/turn-fallback'
import { resetStickyWinnersForTests } from '../../src/main/chat/model-fallback/sticky'
import { getSubscriptionFailoverRouter, modelCircuitKey } from '../../src/main/chat/subscription-failover/router'
import { registerChatIpc } from '../../src/main/chat/service'
import { clearAllChatSubscriptions, subscribeChatStream } from '../../src/main/chat/stream-subscribers'
import { __resetCwdActivityForTests } from '../../src/main/cwd-activity-coordinator'

const CONV = 'conv-fallback'
const wc = { isDestroyed: vi.fn(() => false), send: vi.fn() }
let cwd = ''
let fallbackConfig: unknown = null
let chatPrefs: Record<string, unknown> = {}

const sent = (channel: string) =>
  wc.send.mock.calls.filter(([name]) => name === channel).map(([, payload]) => payload as Record<string, unknown>)
const doneCount = () => sent(`chat:delta:${CONV}`).filter((event) => event.kind === 'done').length
const switches = () => sent(`chat:subscription-failover:${CONV}`)

async function send(text: string): Promise<{ ok: boolean; error?: string }> {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  registerChatIpc({ mhandle: (channel, fn) => void handlers.set(channel, fn), mon: vi.fn(), emitStatus: vi.fn() })
  const before = doneCount()
  const result = (await handlers.get('chat:send')?.({ sender: wc }, { conversationId: CONV, text })) as {
    ok: boolean
    error?: string
  }
  if (result.ok) await vi.waitFor(() => expect(doneCount()).toBe(before + 1), { timeout: 10_000 })
  return result
}

const userMessages = () =>
  h.upsertChatMessage.mock.calls
    .map(([message]) => message as { role: string; internal?: boolean; parts: MessagePart[] })
    .filter((message) => message.role === 'user')

type RunArgs = {
  selection: { providerId: string; modelId: string }
  reasoningOverride?: string
  fastModeOverride?: boolean
  emit: (event: unknown) => void
  onTerminalFailure?: (error: unknown) => void
  shouldRetryInPlace?: (error: unknown) => boolean
}

const runCalls = () => h.runChat.mock.calls.map(([args]) => args as RunArgs)
const ranOn = () => runCalls().map((args) => `${args.selection.providerId}/${args.selection.modelId}`)

function failWith(error: unknown, args: RunArgs, partial = 'partial answer') {
  args.emit({ kind: 'message-start', messageId: `assistant-${h.runChat.mock.calls.length}` })
  args.emit({ kind: 'text-delta', messageId: `assistant-${h.runChat.mock.calls.length}`, delta: partial })
  args.onTerminalFailure?.(error)
  args.emit({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
  return { planSubmitted: false }
}

const quota = () => Object.assign(new Error('You exceeded your current quota'), { statusCode: 429 })

describe('model fallback in a Maestrly turn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetCwdActivityForTests()
    getSubscriptionFailoverRouter().reset()
    resetStickyWinnersForTests()
    cwd = mkdtempSync(path.join(os.tmpdir(), 'model-fallback-service-'))
    h.getMainWebContents.mockReturnValue(wc)
    h.getConversation.mockReturnValue({ id: CONV, cli: 'chat', cwd, workspaceId: 'workspace-1' })
    chatPrefs = { providerId: 'provider-1', modelId: 'model-1', mode: 'agent', reasoning: 'max' }
    h.getConvUiPrefs.mockImplementation(() => ({ chat: chatPrefs }))
    h.getAppFlag.mockImplementation((_key: string, fallback: boolean) => fallback)
    fallbackConfig = {
      version: 1,
      enabled: true,
      fallbacks: [{ providerId: 'provider-2', modelId: 'model-2', reasoning: 'high' }],
    }
    h.getAppSetting.mockImplementation((key: string) =>
      key === 'chat.modelFallback.v1' && fallbackConfig ? JSON.stringify(fallbackConfig) : null
    )
    h.hasApiKey.mockReturnValue(true)
    h.isClaude.mockImplementation(() => false)
    h.freezeFailoverChain.mockImplementation((id: string) => [id])
    h.providerWindow.mockImplementation(async (providerId: string) =>
      providerId === 'provider-1' ? 1_000_000 : 32_000
    )
    h.listConversationContextMessages.mockReturnValue([])
    h.runChat.mockResolvedValue({ planSubmitted: false })
    subscribeChatStream(wc as never, CONV)
  })
  afterEach(() => {
    clearAllChatSubscriptions()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('continues the same turn on the next model, in a new bubble, without touching the selection', async () => {
    h.runChat.mockImplementationOnce(async (args: RunArgs) => failWith(quota(), args))

    expect(await send('fix the tests')).toEqual({ ok: true })

    expect(ranOn()).toEqual(['provider-1/model-1', 'provider-2/model-2'])
    // The fallback runs with its own effort, never the primary's `max`.
    expect(runCalls()[1]).toMatchObject({ reasoningOverride: 'high', fastModeOverride: false })
    expect(runCalls()[0].reasoningOverride).toBeUndefined()
    // One turn: a single 'done', a hidden continuation prompt, and the switch announced.
    expect(doneCount()).toBe(1)
    const continuation = userMessages().find((message) => message.internal)
    expect(continuation?.parts[0]).toMatchObject({ type: 'text', text: MODEL_FALLBACK_CONTINUE_PROMPT })
    expect(switches()).toEqual([
      expect.objectContaining({
        kind: 'model',
        scope: 'root',
        fromProviderId: 'provider-1',
        fromModelId: 'model-1',
        toProviderId: 'provider-2',
        toModelId: 'model-2',
        reasonKind: 'quota',
      }),
    ])
    // The failure was absorbed by the fallback; the conversation never shows the error status.
    expect(h.updateConversationStatus).not.toHaveBeenCalledWith(CONV, 'error')
    for (const [, patch] of h.patchConvUiPrefs.mock.calls) {
      expect((patch as { chat?: { providerId?: string } }).chat?.providerId).not.toBe('provider-2')
    }
  })

  it('runs the continuation within the context window of the fallback', async () => {
    h.runChat.mockImplementationOnce(async (args: RunArgs) => failWith(quota(), args))

    await send('fix the tests')

    expect(runCalls().map((args) => (args as RunArgs & { contextWindow?: number }).contextWindow)).toEqual([
      1_000_000, 32_000,
    ])
  })

  it('keeps the winner in front for the next turns after a capacity failure', async () => {
    h.runChat.mockImplementationOnce(async (args: RunArgs) => failWith(quota(), args))
    await send('first')
    h.runChat.mockClear()

    await send('second')

    expect(ranOn()).toEqual(['provider-2/model-2'])
  })

  it('returns to the primary on the next turn after a failure that does not stick', async () => {
    h.runChat.mockImplementationOnce(async (args: RunArgs) =>
      failWith(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), args)
    )
    await send('first')
    expect(ranOn()).toEqual(['provider-1/model-1', 'provider-2/model-2'])
    h.runChat.mockClear()
    getSubscriptionFailoverRouter().reset()

    await send('second')

    expect(ranOn()).toEqual(['provider-1/model-1'])
    expect(runCalls()[0].reasoningOverride).toBeUndefined()
  })

  it('starts on the fallback when the primary is cooling down, and says so', async () => {
    getSubscriptionFailoverRouter().recordFailure(modelCircuitKey('provider-1', 'model-1'), {
      kind: 'overloaded',
      reason: 'overloaded',
    })

    await send('hello')

    expect(ranOn()).toEqual(['provider-2/model-2'])
    expect(switches()).toEqual([expect.objectContaining({ kind: 'model', toProviderId: 'provider-2' })])
  })

  it('admits the next candidate when the primary cannot be admitted', async () => {
    h.hasApiKey.mockImplementation((id: string) => id !== 'provider-1')

    expect(await send('hello')).toEqual({ ok: true })

    expect(ranOn()).toEqual(['provider-2/model-2'])
    expect(switches()).toEqual([expect.objectContaining({ kind: 'model', reasonKind: 'auth' })])
  })

  it('moves a Claude turn whose accounts are all exhausted to an API-key model', async () => {
    h.isClaude.mockImplementation((id: string) => id === CLAUDE)
    h.freezeFailoverChain.mockImplementation((id: string) => (id === CLAUDE ? [CLAUDE, `${CLAUDE}@acc_2`] : [id]))
    h.resolveClaudeRuntimeTarget.mockResolvedValue({
      ok: false,
      error: 'no-eligible-account',
      reason: 'quota-exhausted',
      message: 'Every Claude account in the rotation list reached its usage limit.',
    })
    chatPrefs = { providerId: CLAUDE, modelId: 'claude-opus', mode: 'agent', reasoning: 'max' }

    expect(await send('fix the tests')).toEqual({ ok: true })

    expect(h.resolveClaudeRuntimeTarget).toHaveBeenCalled()
    expect(ranOn()).toEqual(['provider-2/model-2'])
    expect(runCalls()[0]).toMatchObject({ reasoningOverride: 'high' })
    expect(switches()).toEqual([
      expect.objectContaining({
        kind: 'model',
        fromProviderId: CLAUDE,
        toProviderId: 'provider-2',
        reasonKind: 'quota',
      }),
    ])
  })

  it('tells the runner to stop waiting in place while a fallback is ready', async () => {
    h.runChat.mockImplementationOnce(async (args: RunArgs) => {
      expect(args.shouldRetryInPlace?.(quota())).toBe(false)
      expect(args.shouldRetryInPlace?.(Object.assign(new Error('upstream'), { statusCode: 503 }))).toBe(true)
      return { planSubmitted: false }
    })

    await send('hello')

    expect(h.runChat).toHaveBeenCalledTimes(1)
  })

  it('reports the error when every candidate fails', async () => {
    h.runChat.mockImplementation(async (args: RunArgs) => failWith(quota(), args))

    await send('hello')

    expect(ranOn()).toEqual(['provider-1/model-1', 'provider-2/model-2'])
    expect(doneCount()).toBe(1)
    expect(h.updateConversationStatus).toHaveBeenCalledWith(CONV, 'error')
  })

  it.each([
    ['a pinned conversation', () => void (chatPrefs = { ...chatPrefs, modelFallbackPinned: true }), quota],
    ['a disabled list', () => void (fallbackConfig = { ...(fallbackConfig as object), enabled: false }), quota],
    [
      'a rejected request',
      () => undefined,
      () => Object.assign(new Error('content_policy_violation'), { statusCode: 400 }),
    ],
    ['an expired login race', () => undefined, () => new Error('another Claude Code process is refreshing')],
  ])('does not fall back for %s', async (_label, arrange, error) => {
    arrange()
    h.runChat.mockImplementation(async (args: RunArgs) => failWith(error(), args))

    await send('hello')

    expect(ranOn()).toEqual(['provider-1/model-1'])
    expect(switches()).toEqual([])
    expect(h.updateConversationStatus).toHaveBeenCalledWith(CONV, 'error')
  })

  it('keeps a later host continuation of the same turn on the fallback model', async () => {
    chatPrefs = { ...chatPrefs, mode: 'plan' }
    h.runChat.mockImplementationOnce(async (args: RunArgs) => failWith(quota(), args))

    await send('plan the fix')

    // The fallback answered without submitting the plan: the Plan guard asks again, on the same fallback.
    expect(ranOn()).toEqual(['provider-1/model-1', 'provider-2/model-2', 'provider-2/model-2'])
    expect(doneCount()).toBe(1)
  })

  it('does not fall back once the turn submitted its plan', async () => {
    h.runChat.mockImplementationOnce(async (args: RunArgs) => ({ ...failWith(quota(), args), planSubmitted: true }))

    await send('plan it')

    expect(ranOn()).toEqual(['provider-1/model-1'])
  })

  it('does not fall back after the person stops the turn', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const register = (channel: string, fn: (...args: any[]) => unknown) => void handlers.set(channel, fn)
    registerChatIpc({ mhandle: register, mon: register, emitStatus: vi.fn() })
    h.runChat.mockImplementationOnce(async (args: RunArgs & { signal: AbortSignal }) => {
      handlers.get('chat:stop')?.({ sender: wc }, CONV)
      expect(args.signal.aborted).toBe(true)
      return failWith(quota(), args)
    })

    await handlers.get('chat:send')?.({ sender: wc }, { conversationId: CONV, text: 'hello' })
    await vi.waitFor(() => expect(doneCount()).toBe(1), { timeout: 10_000 })

    expect(ranOn()).toEqual(['provider-1/model-1'])
    expect(switches()).toEqual([])
  })
})
