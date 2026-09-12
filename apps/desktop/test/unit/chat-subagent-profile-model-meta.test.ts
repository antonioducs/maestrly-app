import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getProvider } from '../../src/main/chat/catalog'
import { catalogProviderForBaseURL, getProviderModelMetaWithStatus } from '../../src/main/chat/model-meta'
import { getSubagentProfileModelMeta } from '../../src/main/chat/subagent-profile-model-meta'
import { getCodexSubscriptionManager } from '../../src/main/chat/codex-subscription/manager'
import { getGitHubCopilotSubscriptionManager } from '../../src/main/chat/github-copilot/manager'
import { getClaudeSubscriptionManager } from '../../src/main/chat/claude-agent-sdk/manager'
import { getGrokSubscriptionManager } from '../../src/main/chat/grok-subscription/manager'

vi.mock('../../src/main/chat/catalog', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/chat/catalog')>()
  return { ...original, getProvider: vi.fn() }
})
vi.mock('../../src/main/chat/model-meta', () => ({
  catalogProviderForBaseURL: vi.fn(),
  getProviderModelMetaWithStatus: vi.fn(),
}))
vi.mock('../../src/main/chat/codex-subscription/manager', () => ({
  getCodexSubscriptionManager: vi.fn(),
}))
vi.mock('../../src/main/chat/github-copilot/manager', () => ({
  getGitHubCopilotSubscriptionManager: vi.fn(),
}))
vi.mock('../../src/main/chat/claude-agent-sdk/manager', () => ({
  getClaudeSubscriptionManager: vi.fn(),
}))
vi.mock('../../src/main/chat/grok-subscription/manager', () => ({
  getGrokSubscriptionManager: vi.fn(),
}))

const getProviderMock = vi.mocked(getProvider)
const catalogProviderForBaseURLMock = vi.mocked(catalogProviderForBaseURL)
const getProviderModelMetaWithStatusMock = vi.mocked(getProviderModelMetaWithStatus)
const getCodexSubscriptionManagerMock = vi.mocked(getCodexSubscriptionManager)
const getGitHubCopilotSubscriptionManagerMock = vi.mocked(getGitHubCopilotSubscriptionManager)
const getClaudeSubscriptionManagerMock = vi.mocked(getClaudeSubscriptionManager)
const getGrokSubscriptionManagerMock = vi.mocked(getGrokSubscriptionManager)

const gpt55 = {
  status: 'available' as const,
  meta: { reasoning: true, reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
}

describe('getSubagentProfileModelMeta', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getCodexSubscriptionManagerMock.mockReturnValue({
      getStatus: vi.fn(async () => ({ authenticated: false })),
      listModels: vi.fn(async () => []),
    } as unknown as ReturnType<typeof getCodexSubscriptionManager>)
    getGitHubCopilotSubscriptionManagerMock.mockReturnValue({
      getStatus: vi.fn(async () => ({ authenticated: false, connected: false })),
      listModels: vi.fn(async () => []),
    } as unknown as ReturnType<typeof getGitHubCopilotSubscriptionManager>)
    getClaudeSubscriptionManagerMock.mockReturnValue({
      status: vi.fn(async () => ({ authenticated: false })),
      listModels: vi.fn(async () => []),
      getObservedModelContextWindow: vi.fn(() => undefined),
    } as unknown as ReturnType<typeof getClaudeSubscriptionManager>)
    getGrokSubscriptionManagerMock.mockReturnValue({
      getStatus: vi.fn(async () => ({ authenticated: false })),
      listModels: vi.fn(async () => []),
    } as unknown as ReturnType<typeof getGrokSubscriptionManager>)
  })

  it('uses the main picker exact-provider then canonical resolution', async () => {
    getProviderMock.mockReturnValue({ id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1' })
    catalogProviderForBaseURLMock.mockReturnValue('openai')
    getProviderModelMetaWithStatusMock.mockResolvedValue(gpt55)

    await expect(getSubagentProfileModelMeta('openai', 'gpt-5.5')).resolves.toEqual(gpt55)
    expect(catalogProviderForBaseURLMock).toHaveBeenCalledWith('https://api.openai.com/v1')
    expect(getProviderModelMetaWithStatusMock).toHaveBeenCalledWith('gpt-5.5', 'openai')
  })

  it('looks up canonical model metadata for custom providers', async () => {
    getProviderMock.mockReturnValue({ id: 'custom', name: 'Custom', baseURL: 'https://proxy.example.com/v1' })
    catalogProviderForBaseURLMock.mockReturnValue(null)
    getProviderModelMetaWithStatusMock.mockResolvedValue(gpt55)

    await expect(getSubagentProfileModelMeta('custom', 'gpt-5.5')).resolves.toEqual(gpt55)
    expect(getProviderModelMetaWithStatusMock).toHaveBeenCalledWith('gpt-5.5', null)
  })

  it('keeps Codex unavailable without login', async () => {
    await expect(getSubagentProfileModelMeta('builtin_codex_subscription', 'gpt-5.6')).resolves.toEqual({
      status: 'unavailable',
      meta: null,
    })
    expect(getProviderMock).not.toHaveBeenCalled()
    expect(getProviderModelMetaWithStatusMock).not.toHaveBeenCalled()
  })

  it('uses authenticated app-server models and effort levels', async () => {
    getCodexSubscriptionManagerMock.mockReturnValue({
      getStatus: vi.fn(async () => ({ authenticated: true })),
      listModels: vi.fn(async () => [
        {
          id: 'gpt-5.6-mini',
          model: 'gpt-5.6-mini',
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: '' },
            { reasoningEffort: 'high', description: '' },
          ],
          inputModalities: ['text', 'image'],
          serviceTiers: [],
          contextWindow: 160_000,
        },
      ]),
    } as unknown as ReturnType<typeof getCodexSubscriptionManager>)

    await expect(getSubagentProfileModelMeta('builtin_codex_subscription', 'gpt-5.6-mini')).resolves.toEqual({
      status: 'available',
      meta: {
        contextWindow: 160_000,
        reasoning: true,
        reasoningEfforts: ['low', 'high'],
        vision: true,
        chatCapable: true,
        fastModeCapability: false,
        nativeUltraMode: false,
        contextLimitEditable: false,
      },
    })
  })

  it('uses connected Copilot SDK capabilities and effort levels', async () => {
    getGitHubCopilotSubscriptionManagerMock.mockReturnValue({
      getStatus: vi.fn(async () => ({ authenticated: true, connected: true })),
      listModels: vi.fn(async () => [
        {
          id: 'claude-sonnet-4.6',
          name: 'Claude Sonnet 4.6',
          capabilities: {
            supports: { vision: true, reasoningEffort: true },
            limits: { max_context_window_tokens: 200_000 },
          },
          supportedReasoningEfforts: ['low', 'high'],
        },
      ]),
    } as unknown as ReturnType<typeof getGitHubCopilotSubscriptionManager>)

    await expect(
      getSubagentProfileModelMeta('builtin_github_copilot_subscription', 'claude-sonnet-4.6')
    ).resolves.toEqual({
      status: 'available',
      meta: {
        contextWindow: 200_000,
        reasoning: true,
        reasoningEfforts: ['low', 'high'],
        vision: true,
        chatCapable: true,
        fastModeCapability: false,
        nativeUltraMode: false,
        contextLimitEditable: false,
      },
    })
  })

  it('uses official Claude Agent SDK catalog capabilities', async () => {
    getClaudeSubscriptionManagerMock.mockReturnValue({
      status: vi.fn(async () => ({ authenticated: true })),
      listModels: vi.fn(async () => [
        {
          value: 'sonnet',
          resolvedModel: 'claude-sonnet-5',
          displayName: 'Claude Sonnet',
          description: 'Balanced model',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'high', 'max'],
          supportsAdaptiveThinking: true,
          supportsFastMode: true,
        },
      ]),
      getObservedModelContextWindow: vi.fn(() => 200_000),
    } as unknown as ReturnType<typeof getClaudeSubscriptionManager>)

    await expect(getSubagentProfileModelMeta('builtin_claude_subscription', 'claude-sonnet-5')).resolves.toEqual({
      status: 'available',
      meta: {
        contextWindow: 200_000,
        reasoning: true,
        reasoningEfforts: ['low', 'high', 'max'],
        vision: true,
        chatCapable: true,
        fastModeCapability: true,
        nativeUltraMode: false,
        contextLimitEditable: false,
      },
    })
  })

  it('exposes official Grok 4.6 efforts when discovery omits capabilities', async () => {
    getGrokSubscriptionManagerMock.mockReturnValue({
      getStatus: vi.fn(async () => ({ authenticated: true })),
      listModels: vi.fn(async () => [{ id: 'grok-4.6', contextWindow: 256_000 }]),
    } as unknown as ReturnType<typeof getGrokSubscriptionManager>)

    await expect(getSubagentProfileModelMeta('builtin_grok_subscription', 'grok-4.6')).resolves.toEqual({
      status: 'available',
      meta: {
        contextWindow: 256_000,
        reasoning: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        chatCapable: true,
        fastModeCapability: true,
        contextLimitEditable: false,
      },
    })
  })

  it('remains unavailable when all metadata sources are missing', async () => {
    getProviderMock.mockReturnValue(undefined)
    getProviderModelMetaWithStatusMock.mockResolvedValue({ status: 'unavailable', meta: null })

    await expect(getSubagentProfileModelMeta('missing', 'unknown')).resolves.toEqual({
      status: 'unavailable',
      meta: null,
    })
    expect(getProviderModelMetaWithStatusMock).toHaveBeenCalledWith('unknown', null)
  })
})
