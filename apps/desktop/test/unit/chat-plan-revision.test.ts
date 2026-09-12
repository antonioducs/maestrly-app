import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  getMainWebContents: vi.fn(),
  getConversation: vi.fn(),
  getConvUiPrefs: vi.fn(),
  getAppFlag: vi.fn(),
  getAppSetting: vi.fn(),
  updateConversationStatus: vi.fn(),
  upsertChatMessage: vi.fn(),
  listChatMessages: vi.fn(() => []),

  listConversationContextMessages: vi.fn(() => []),
  runChat: vi.fn(),
  setChatGptWebHooks: vi.fn(),
  stagePlan: vi.fn(),
  releasePlanRevision: vi.fn(),
  isChatGptWebProvider: vi.fn((_providerId?: string) => false),
  patchConvUiPrefs: vi.fn(),
  resolvePlanReview: vi.fn(() => ({ ok: true })),
}))

vi.mock('../../src/main/window-ipc', () => ({
  getMainWebContents: h.getMainWebContents,
}))

vi.mock('../../src/main/store', () => ({
  getConversation: h.getConversation,
  getConvUiPrefs: h.getConvUiPrefs,
  getAppFlag: h.getAppFlag,
  getAppSetting: h.getAppSetting,
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({ get: vi.fn(() => undefined), all: vi.fn(() => []), run: vi.fn() })),
  })),
  getLocale: vi.fn(() => 'pt-BR'),
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
  isGrokSubscriptionProvider: vi.fn(() => false),
  isCodexSubscriptionProvider: vi.fn(() => false),
  isGitHubCopilotSubscriptionProvider: vi.fn(() => false),
  isSubscriptionProvider: vi.fn(() => false),
  isChatGptWebProvider: h.isChatGptWebProvider,
  isChatGptWebEnabled: vi.fn(() => false),
  setChatGptWebEnabled: vi.fn(),
  isManagedProvider: vi.fn(() => false),
  CHATGPT_WEB_PROVIDER_ID: 'builtin_chatgpt_web',
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
  chatHistoryStats: vi.fn(() => ({ lastUsage: null })),
  listChatMessages: h.listChatMessages,

  listConversationContextMessages: h.listConversationContextMessages,
  upsertChatMessage: h.upsertChatMessage,
}))

vi.mock('../../src/main/chat/runner', () => ({
  normalizeAiUsage: vi.fn(() => ({ input: 0, output: 0, totalInput: 0, cacheRead: 0, cacheCreate: 0 })),
  runChat: h.runChat,
}))

vi.mock('../../src/main/chat/chatgpt-web/manager', () => ({
  onChatGptWebChange: vi.fn(() => vi.fn()),
  setChatGptWebHooks: h.setChatGptWebHooks,
  reviewLoopLockFor: vi.fn(() => null),
  projectEnvironmentLockFor: vi.fn(() => null),
  transportConfigurationHasActiveResources: vi.fn(() => false),
  withTransportConfigurationMutation: vi.fn((operation: () => Promise<unknown>) => operation()),
  resolvePlanReview: h.resolvePlanReview,
  discardPlanReviews: vi.fn(),
}))

vi.mock('../../src/main/plan-broker', () => ({
  stagePlan: h.stagePlan,
  releasePlanRevision: h.releasePlanRevision,
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
}))

import { registerChatIpc, runApprovedPlan, runPlanRevision, type ChatIpcDeps } from '../../src/main/chat/service'
import { __resetCwdActivityForTests, tryWithCwdExclusive } from '../../src/main/cwd-activity-coordinator'

const wc = {
  isDestroyed: vi.fn(() => false),
  send: vi.fn(),
}

function deps(): ChatIpcDeps {
  return { mhandle: vi.fn(), mon: vi.fn(), emitStatus: vi.fn() }
}

describe('runPlanRevision', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.stagePlan.mockReturnValue({ ok: true })
    h.releasePlanRevision.mockReset()
    __resetCwdActivityForTests()
    h.getMainWebContents.mockReturnValue(wc)
    h.getConversation.mockReturnValue({
      id: 'conv-chat',
      cli: 'chat',
      cwd: '/tmp/project',
      workspaceId: 'workspace-1',
    })
    h.getConvUiPrefs.mockReturnValue({ chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'plan' } })
    h.getAppFlag.mockImplementation((_key: string, fallback: boolean) => fallback)
    h.getAppSetting.mockReturnValue(null)
    h.runChat.mockResolvedValue({ planSubmitted: false })
    h.isChatGptWebProvider.mockImplementation((providerId?: string) => providerId === 'builtin_chatgpt_web')
  })

  it('starts a local chat turn without a Maestrly account gate', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>()
    registerChatIpc({
      mhandle: (channel, fn) => void handlers.set(channel, fn),
      mon: vi.fn(),
      emitStatus: vi.fn(),
    })

    await expect(
      handlers.get('chat:send')?.({ sender: wc }, { conversationId: 'conv-chat', text: 'start the local turn' })
    ).resolves.toEqual({ ok: true })
    expect(h.runChat).toHaveBeenCalledOnce()
  })

  it('rejects new legacy-provider selections and migrates existing preferences', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>()
    registerChatIpc({
      mhandle: (channel, fn) => void handlers.set(channel, fn),
      mon: vi.fn(),
      emitStatus: vi.fn(),
    })

    await expect(
      handlers.get('chat:set-selection')?.({}, 'conv-chat', {
        providerId: 'builtin_chatgpt_web',
        modelId: 'chatgpt-web',
      })
    ).resolves.toEqual({ ok: false, error: 'unknown-provider' })

    h.getConvUiPrefs.mockReturnValue({
      chat: { providerId: 'builtin_chatgpt_web', modelId: 'chatgpt-web', mode: 'agent' },
    })
    expect(handlers.get('chat:get-selection')?.({}, 'conv-chat')).toEqual({
      providerId: 'provider-1',
      modelId: '',
    })
    expect(h.patchConvUiPrefs).toHaveBeenCalled()
  })

  it('blocks turns during exclusive Git transitions', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>()
    registerChatIpc({
      mhandle: (channel, fn) => void handlers.set(channel, fn),
      mon: vi.fn(),
      emitStatus: vi.fn(),
    })
    const result = await tryWithCwdExclusive('/tmp/project', async () =>
      handlers.get('chat:send')?.({ sender: wc }, { conversationId: 'conv-chat', text: 'start the local turn' })
    )
    expect(result).toEqual({ ok: true, value: { ok: false, error: 'cwd-locked' } })
    expect(h.runChat).not.toHaveBeenCalled()
  })

  it('persists internal feedback without changing model text', async () => {
    registerChatIpc(deps())

    await runPlanRevision('conv-chat', 'The user requested changes to step 2')

    expect(h.upsertChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-chat',
        role: 'user',
        internal: true,
        parts: [expect.objectContaining({ type: 'text', text: 'The user requested changes to step 2' })],
      })
    )
    expect(h.runChat).toHaveBeenCalledOnce()
  })

  it('releases revision reservations when no new plan is submitted', async () => {
    registerChatIpc(deps())

    await runPlanRevision('conv-chat', 'Adjust the plan', 7)

    await vi.waitFor(() => expect(h.releasePlanRevision).toHaveBeenCalledWith('conv-chat', 'maestrly-chat', 7))
  })

  it('sends approved plans inline without claiming worktree files', async () => {
    registerChatIpc(deps())

    await runApprovedPlan('conv-chat', '## Plan final\n\n- change the flow')

    const persisted = h.upsertChatMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message?.role === 'user')
    expect(persisted).toEqual(
      expect.objectContaining({
        conversationId: 'conv-chat',
        internal: true,
        parts: [
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('<approved_plan>\n## Plan final\n\n- change the flow\n</approved_plan>'),
          }),
        ],
      })
    )
    expect(persisted.parts[0].text).toContain('NÃO existe como arquivo no worktree')
    expect(persisted.parts[0].text).toContain('Não procure nem tente abrir approved-plan.md')
    expect(persisted.parts).not.toContainEqual(expect.objectContaining({ type: 'file' }))
    expect(h.runChat).toHaveBeenCalledOnce()
  })

  it('delivers companion chat with provenance and renderer notification', async () => {
    registerChatIpc(deps())
    const hooks = h.setChatGptWebHooks.mock.calls.at(-1)?.[0]

    await hooks.deliverChat('conv-chat', '# Resultado', 'Summary')

    expect(h.upsertChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-chat',
        role: 'assistant',
        source: 'chatgpt-web',
        parts: [expect.objectContaining({ type: 'text', text: '## Summary\n\n# Resultado' })],
      })
    )
    expect(wc.send).toHaveBeenCalledWith(
      'chat:chatgpt-web:delivery:conv-chat',
      expect.objectContaining({ messageId: expect.any(String) })
    )
  })

  it('delivers a companion plan through stagePlan without inserting a chat message', async () => {
    registerChatIpc(deps())
    const hooks = h.setChatGptWebHooks.mock.calls.at(-1)?.[0]
    h.upsertChatMessage.mockClear()

    await hooks.deliverPlan('conv-chat', '# Plan', 'pr_service_v1', 'ChatGPT plan')

    expect(h.stagePlan).toHaveBeenCalledWith({
      agentId: 'conv-chat',
      cwd: '/tmp/project',
      plan: '# Plan',
      title: 'ChatGPT plan',
      origin: { kind: 'chatgpt-web', reviewId: 'pr_service_v1' },
      onLifecycle: expect.any(Function),
    })
    expect(h.upsertChatMessage).not.toHaveBeenCalled()
  })

  it('propagates origin conflicts without accepting Web deliveries', async () => {
    registerChatIpc(deps())
    const hooks = h.setChatGptWebHooks.mock.calls.at(-1)?.[0]
    h.stagePlan.mockReturnValue({ ok: false, error: 'plan-origin-conflict' })

    expect(() => hooks.deliverPlan('conv-chat', '# Plan', 'pr_service_conflict')).toThrow('plan-origin-conflict')
    expect(h.upsertChatMessage).not.toHaveBeenCalled()
  })

  it('routes supersession and clear to matching plan reviews', async () => {
    registerChatIpc(deps())
    const hooks = h.setChatGptWebHooks.mock.calls.at(-1)?.[0]
    await hooks.deliverPlan('conv-chat', '# Plan', 'pr_service_lifecycle')
    const staged = h.stagePlan.mock.calls.at(-1)?.[0]

    staged.onLifecycle('superseded')
    staged.onLifecycle('cancelled')

    expect(h.resolvePlanReview).toHaveBeenNthCalledWith(1, 'conv-chat', 'pr_service_lifecycle', {
      status: 'superseded',
    })
    expect(h.resolvePlanReview).toHaveBeenNthCalledWith(2, 'conv-chat', 'pr_service_lifecycle', {
      status: 'cancelled',
    })
  })

  it('persists duration on runner setup failure', async () => {
    h.runChat.mockRejectedValue(new Error('setup failed'))
    registerChatIpc(deps())

    await runPlanRevision('conv-chat', 'Adjust the plan')

    await vi.waitFor(() => {
      expect(h.upsertChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-chat',
          role: 'assistant',
          error: 'setup failed',
          responseDurationMs: expect.any(Number),
        })
      )
      // Decision turns remain persisted, but without live consumers the
      // subscription-aware registry drops renderer-only deltas.
      expect(wc.send).not.toHaveBeenCalledWith(
        'chat:delta:conv-chat',
        expect.objectContaining({ kind: 'error', message: 'setup failed' })
      )
    })
  })

  it('silences ready transitions after plan submission', async () => {
    const ipcDeps = deps()
    h.runChat.mockResolvedValue({ planSubmitted: true })
    registerChatIpc(ipcDeps)

    await runPlanRevision('conv-chat', 'Adjust the plan')

    await vi.waitFor(() => {
      expect(ipcDeps.emitStatus).toHaveBeenLastCalledWith('conv-chat', 'ready', { silent: true })
    })
  })
})
