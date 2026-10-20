import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessagePart } from '../../src/shared/chat'

/**
 * The Plan-mode guard runs in startSend, the same way for every model: the BYOK runner stands in for all of them
 * here. Mocks follow the plugin hooks service tests.
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
  runChat: vi.fn(),
}))

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
  getProvider: vi.fn(() => ({ id: 'provider-1', name: 'Provider', baseURL: 'https://example.test/v1' })),
  getProviderKind: vi.fn(() => 'openai'),
  isClaudeSubscriptionProvider: vi.fn(() => false),
  isCursorSubscriptionProvider: vi.fn(() => false),
  isAntigravitySubscriptionProvider: vi.fn(() => false),
  isGrokSubscriptionProvider: vi.fn(() => false),
  isCodexSubscriptionProvider: vi.fn(() => false),
  isGitHubCopilotSubscriptionProvider: vi.fn(() => false),
  isSubscriptionProvider: vi.fn(() => false),
  isChatGptWebProvider: vi.fn(() => false),
  subscriptionAccountId: vi.fn(() => null),
  subscriptionProviderIdFor: vi.fn(() => 'builtin'),
  getSubscriptionAccount: vi.fn(() => undefined),
  addSubscriptionAccount: vi.fn(),
  renameSubscriptionAccount: vi.fn(),
  removeSubscriptionAccount: vi.fn(),
  listAvailableChatProviders: vi.fn(() => [{ id: 'provider-1', name: 'Provider', baseURL: 'https://example.test/v1' }]),
  listProviders: vi.fn(() => [{ id: 'provider-1', name: 'Provider', baseURL: 'https://example.test/v1' }]),
}))

vi.mock('../../src/main/chat/credentials', () => ({
  apiKeyStorageMode: vi.fn(() => 'secure'),
  hasApiKey: vi.fn(() => true),
}))

vi.mock('../../src/main/chat/chat-store', () => ({
  getChatMessage: vi.fn(() => null),
  listUndeliveredReviewReports: vi.fn(() => []),
  chatHistoryStats: vi.fn(() => ({ lastUsage: null })),
  listChatMessages: vi.fn(() => []),
  listConversationContextMessages: h.listConversationContextMessages,
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
  resolveContextWindow: vi.fn(() => undefined),
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

vi.mock('../../src/main/plugins/runtime', async (original) => ({
  ...(await original<typeof import('../../src/main/plugins/runtime')>()),
  listPluginHooks: () => [],
}))

import { PLAN_GUARD_PROMPT } from '../../src/main/chat/plan-guard'
import { registerChatIpc } from '../../src/main/chat/service'
import { clearAllChatSubscriptions, subscribeChatStream } from '../../src/main/chat/stream-subscribers'
import { __resetCwdActivityForTests } from '../../src/main/cwd-activity-coordinator'

const wc = { isDestroyed: vi.fn(() => false), send: vi.fn() }
let cwd = ''

const streamed = () => wc.send.mock.calls.map(([, payload]) => payload as { kind?: string })
const doneCount = () => streamed().filter((event) => event.kind === 'done').length

/** Sends a prompt and, once admitted, waits for its turn (and any continuation) to end. */
async function send(text: string): Promise<{ ok: boolean; error?: string }> {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  registerChatIpc({ mhandle: (channel, fn) => void handlers.set(channel, fn), mon: vi.fn(), emitStatus: vi.fn() })
  const before = doneCount()
  const result = (await handlers.get('chat:send')?.({ sender: wc }, { conversationId: 'conv-plan', text })) as {
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

const inMode = (mode: string) =>
  h.getConvUiPrefs.mockReturnValue({ chat: { providerId: 'provider-1', modelId: 'model-1', mode } })

describe('Plan-mode guard in a Maestrly turn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetCwdActivityForTests()
    cwd = mkdtempSync(path.join(os.tmpdir(), 'plan-guard-service-'))
    h.getMainWebContents.mockReturnValue(wc)
    h.getConversation.mockReturnValue({ id: 'conv-plan', cli: 'chat', cwd, workspaceId: 'workspace-1' })
    inMode('plan')
    h.getAppFlag.mockImplementation((_key: string, fallback: boolean) => fallback)
    h.getAppSetting.mockReturnValue(null)
    h.listConversationContextMessages.mockReturnValue([])
    h.runChat.mockResolvedValue({ planSubmitted: false })
    subscribeChatStream(wc as never, 'conv-plan')
  })
  afterEach(() => {
    clearAllChatSubscriptions()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('asks once, as a hidden prompt, when a Plan turn ends without submitting the plan', async () => {
    expect(await send('plan the tests')).toEqual({ ok: true })

    expect(h.runChat).toHaveBeenCalledTimes(2)
    // One turn and its continuation end with a single 'done'.
    expect(doneCount()).toBe(1)
    const [, continuation] = userMessages()
    expect(continuation.internal).toBe(true)
    expect(continuation.parts[0]).toMatchObject({ type: 'text', text: PLAN_GUARD_PROMPT })
    expect(h.runChat.mock.calls[1][0].behaviorOverride).toBe('plan')
  })

  it('does not chain: a continuation that still submits nothing ends the turn', async () => {
    await send('plan the tests')

    expect(h.runChat).toHaveBeenCalledTimes(2)
    expect(userMessages().filter((message) => message.internal)).toHaveLength(1)
  })

  it('stops there when the continuation submits the plan', async () => {
    h.runChat.mockResolvedValueOnce({ planSubmitted: false }).mockResolvedValueOnce({ planSubmitted: true })

    await send('plan the tests')

    expect(h.runChat).toHaveBeenCalledTimes(2)
  })

  it('leaves a turn that submitted its plan alone', async () => {
    h.runChat.mockResolvedValue({ planSubmitted: true })

    await send('plan the tests')

    expect(h.runChat).toHaveBeenCalledTimes(1)
    expect(userMessages().filter((message) => message.internal)).toEqual([])
  })

  it('leaves a turn that failed alone', async () => {
    h.runChat.mockImplementation(async (args: { emit: (event: unknown) => void }) => {
      args.emit({ kind: 'error', message: 'provider down' })
      return { planSubmitted: false }
    })

    await send('plan the tests')

    expect(h.runChat).toHaveBeenCalledTimes(1)
  })

  it.each(['ask', 'agent'])('does not apply in %s', async (mode) => {
    inMode(mode)

    await send('what is this?')

    expect(h.runChat).toHaveBeenCalledTimes(1)
    expect(userMessages().filter((message) => message.internal)).toEqual([])
  })
})
