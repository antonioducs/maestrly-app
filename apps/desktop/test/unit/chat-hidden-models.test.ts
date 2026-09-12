import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const providers = [{ id: 'byok-openai', name: 'OpenAI BYOK', baseURL: 'https://api.openai.com/v1', kind: 'openai' }]
  const webContents = { isDestroyed: vi.fn(() => false), send: vi.fn() }
  return {
    providers,
    webContents,
    getMainWebContents: vi.fn(() => webContents),
    fetchModels: vi.fn(async () => ['gpt-4o', 'gpt-4o-mini', 'o3', 'o3-mini']),
    removeProvider: vi.fn(),
    clearApiKey: vi.fn(),
  }
})

vi.mock('../../src/main/window-ipc', () => ({ getMainWebContents: h.getMainWebContents }))

vi.mock('../../src/main/chat/catalog', () => ({
  PROVIDER_PRESETS: [],
  CODEX_SUBSCRIPTION_PROVIDER_ID: 'builtin_codex_subscription',
  listProviders: vi.fn(() => h.providers),
  listAvailableChatProviders: vi.fn(() => h.providers),
  getProviderKind: vi.fn(() => 'openai'),
  addProvider: vi.fn(),
  updateProvider: vi.fn(),
  removeProvider: h.removeProvider,
  isCodexSubscriptionProvider: vi.fn(() => false),
  isGitHubCopilotSubscriptionProvider: vi.fn(() => false),
  isClaudeSubscriptionProvider: vi.fn(() => false),
  isGrokSubscriptionProvider: vi.fn(() => false),
  isSubscriptionProvider: vi.fn(() => false),
  isManagedProvider: vi.fn(() => false),
  subscriptionAccountId: vi.fn(() => null),
  subscriptionProviderIdFor: vi.fn(() => 'builtin'),
  getSubscriptionAccount: vi.fn(() => undefined),
  addSubscriptionAccount: vi.fn(),
  renameSubscriptionAccount: vi.fn(),
  removeSubscriptionAccount: vi.fn(),
}))

vi.mock('../../src/main/chat/codex-subscription', () => ({
  getCodexSubscriptionManager: vi.fn(() => ({
    isDisposed: false,
    getStatusSnapshot: vi.fn(() => null),
    getStatus: vi.fn(async () => ({
      state: 'ready',
      available: true,
      authenticated: false,
      account: null,
      error: null,
    })),
    listModels: vi.fn(async () => []),
    onAccountUpdated: vi.fn(() => () => {}),
  })),
  deleteAllManagedCodexThreads: vi.fn(async () => {}),
  deleteCodexThreadForConversation: vi.fn(async () => {}),
  retryManagedCodexThreadCleanup: vi.fn(async () => {}),
}))

vi.mock('../../src/main/chat/github-copilot', () => ({
  getGitHubCopilotSubscriptionManager: vi.fn(() => ({
    isDisposed: false,
    getStatusSnapshot: vi.fn(() => null),
    getStatus: vi.fn(async () => ({
      state: 'ready',
      available: true,
      authenticated: false,
      account: null,
      error: null,
    })),
    onAuthUpdated: vi.fn(() => () => {}),
  })),
  deleteAllManagedGitHubCopilotSessions: vi.fn(async () => {}),
  deleteGitHubCopilotSessionForConversation: vi.fn(async () => {}),
  retryManagedGitHubCopilotSessionCleanup: vi.fn(async () => {}),
}))

vi.mock('../../src/main/chat/credentials', () => ({
  apiKeyStorageMode: vi.fn(() => 'secure'),
  hasApiKey: vi.fn(() => true),
  setApiKey: vi.fn(),
  clearApiKey: h.clearApiKey,
}))

vi.mock('../../src/main/chat/models', () => ({
  fetchModels: h.fetchModels,
  fetchModelWindow: vi.fn(),
  invalidateModels: vi.fn(),
}))

vi.mock('../../src/main/chat/model-meta', () => ({
  getModelMeta: vi.fn(async () => null),
  getProviderModelMeta: vi.fn(async () => null),
  catalogProviderForBaseURL: vi.fn(() => null),
  composeEffectiveMeta: vi.fn((exact, canonical) => exact ?? canonical),
  filterChatModels: vi.fn(async (models: string[]) => models),
}))

vi.mock('../../src/main/chat/mcp', () => ({ listMcpServers: vi.fn(() => []) }))

vi.mock('../../src/main/chat/runner', () => ({
  normalizeAiUsage: vi.fn(() => ({ input: 0, output: 0, totalInput: 0, cacheRead: 0, cacheCreate: 0 })),
  runChat: vi.fn(),
}))

import { registerChatIpc, type ChatIpcDeps } from '../../src/main/chat/service'
import { getHiddenChatModelsFor, setHiddenChatModels } from '../../src/main/store'
import { closeDb, freshDb } from '../helpers/db'

type Handler = (event: never, ...args: unknown[]) => unknown

function register(): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  registerChatIpc({
    mhandle: (channel, fn) => void handlers.set(channel, fn as Handler),
    mon: vi.fn(),
    emitStatus: vi.fn(),
  } satisfies ChatIpcDeps)
  return handlers
}

describe('displayed model filter per provider', () => {
  beforeEach(() => {
    freshDb()
    vi.clearAllMocks()
    h.fetchModels.mockResolvedValue(['gpt-4o', 'gpt-4o-mini', 'o3', 'o3-mini'])
  })
  afterEach(closeDb)

  it('returns the list unchanged for a provider without a filter', async () => {
    const models = await register().get('chat:models')?.(undefined as never, 'byok-openai')

    expect(models).toEqual(['gpt-4o', 'gpt-4o-mini', 'o3', 'o3-mini'])
  })

  it('hides marked models and returns the full list with includeHidden', async () => {
    const handlers = register()

    expect(handlers.get('chat:hidden-models:set')?.(undefined as never, 'byok-openai', ['o3', 'o3-mini'])).toEqual({
      ok: true,
    })

    await expect(handlers.get('chat:models')?.(undefined as never, 'byok-openai')).resolves.toEqual([
      'gpt-4o',
      'gpt-4o-mini',
    ])
    await expect(handlers.get('chat:models')?.(undefined as never, 'byok-openai', false, true)).resolves.toEqual([
      'gpt-4o',
      'gpt-4o-mini',
      'o3',
      'o3-mini',
    ])
    expect(handlers.get('chat:hidden-models:get')?.(undefined as never)).toEqual({ 'byok-openai': ['o3', 'o3-mini'] })
  })

  it('scopes the filter per provider without affecting other providers', async () => {
    const handlers = register()
    setHiddenChatModels('other-provider', ['gpt-4o'])

    await expect(handlers.get('chat:models')?.(undefined as never, 'byok-openai')).resolves.toEqual([
      'gpt-4o',
      'gpt-4o-mini',
      'o3',
      'o3-mini',
    ])
  })

  it('clearing the filter with an empty list returns all models', async () => {
    const handlers = register()
    handlers.get('chat:hidden-models:set')?.(undefined as never, 'byok-openai', ['gpt-4o'])
    handlers.get('chat:hidden-models:set')?.(undefined as never, 'byok-openai', [])

    await expect(handlers.get('chat:models')?.(undefined as never, 'byok-openai')).resolves.toEqual([
      'gpt-4o',
      'gpt-4o-mini',
      'o3',
      'o3-mini',
    ])
    expect(handlers.get('chat:hidden-models:get')?.(undefined as never)).toEqual({})
  })

  it('rejects invalid providerId without writing', () => {
    const handlers = register()

    expect(handlers.get('chat:hidden-models:set')?.(undefined as never, '', ['gpt-4o'])).toEqual({
      ok: false,
      error: 'invalid-input',
    })
    expect(handlers.get('chat:hidden-models:get')?.(undefined as never)).toEqual({})
  })

  it('rejects removed or unknown providers to avoid recreating orphan entries', () => {
    const handlers = register()

    expect(handlers.get('chat:hidden-models:set')?.(undefined as never, 'provider-removido', ['gpt-4o'])).toEqual({
      ok: false,
      error: 'invalid-input',
    })
    expect(handlers.get('chat:hidden-models:get')?.(undefined as never)).toEqual({})
  })

  it('rejects malformed lists without clearing the persisted filter', () => {
    const handlers = register()
    setHiddenChatModels('byok-openai', ['o3'])

    expect(handlers.get('chat:hidden-models:set')?.(undefined as never, 'byok-openai', 'not-an-array')).toEqual({
      ok: false,
      error: 'invalid-input',
    })
    expect(handlers.get('chat:hidden-models:set')?.(undefined as never, 'byok-openai', ['o3', 42])).toEqual({
      ok: false,
      error: 'invalid-input',
    })
    expect(getHiddenChatModelsFor('byok-openai')).toEqual(['o3'])
  })

  it('removing a provider deletes its filter', () => {
    const handlers = register()
    setHiddenChatModels('byok-openai', ['o3'])

    expect(handlers.get('chat:provider-remove')?.(undefined as never, 'byok-openai')).toEqual({ ok: true })

    expect(h.removeProvider).toHaveBeenCalledWith('byok-openai')
    expect(getHiddenChatModelsFor('byok-openai')).toEqual([])
  })
})
