import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  generateText: vi.fn(),
  runCodexEphemeralWithFailover: vi.fn(),
  recordModelCallUsage: vi.fn(),
  runAntigravityIsolatedPrompt: vi.fn(),
  antigravityManager: {
    getStatus: () => ({ state: 'signed-in', authenticated: true }),
    getAccountIdentity: () => ({ fingerprint: 'project:test', epoch: 1 }),
  },
}))
vi.mock('ai', () => ({ generateText: h.generateText }))
vi.mock('../../src/main/store', () => ({ getConversation: () => ({ scope: 'project' }) }))
vi.mock('../../src/main/chat/catalog', () => ({
  getProvider: (id: string) => (id === 'api' ? { baseURL: 'https://example.test' } : undefined),
  getProviderKind: () => 'openai',
  subscriptionAccountId: () => null,
  isCodexSubscriptionProvider: (id: string) => id === 'codex-subscription',
  isClaudeSubscriptionProvider: () => false,
  isGitHubCopilotSubscriptionProvider: () => false,
  isCursorSubscriptionProvider: () => false,
  isAntigravitySubscriptionProvider: (id: string) => id === 'antigravity-subscription',
  isGrokSubscriptionProvider: () => false,
}))
vi.mock('../../src/main/chat/provider', () => ({ resolveLanguageModel: () => ({ modelId: 'test' }) }))
vi.mock('../../src/main/chat/credentials', () => ({ hasApiKey: () => true }))
vi.mock('../../src/main/chat/model-meta', () => ({
  getProviderModelMeta: async () => null,
  catalogProviderForBaseURL: () => null,
}))
vi.mock('../../src/main/chat/usage-diagnostics', () => ({ recordModelCallUsage: h.recordModelCallUsage }))
vi.mock('../../src/main/chat/subscription-failover', () => ({
  runCodexEphemeralWithFailover: h.runCodexEphemeralWithFailover,
}))
vi.mock('../../src/main/chat/portable-summarizer', () => ({
  summarizeWithCodexRuntime: vi.fn(),
  summarizeWithClaudeRuntime: vi.fn(),
  summarizeWithGitHubCopilotRuntime: vi.fn(),
  isolatedSummaryAttemptUsage: (value: { usage?: unknown }) => value.usage,
  mergeIsolatedSummaryUsage: vi.fn(),
}))
vi.mock('../../src/main/chat/github-copilot/manager', () => ({ getGitHubCopilotSubscriptionManager: vi.fn() }))
vi.mock('../../src/main/chat/cursor-subscription/manager', () => ({ getCursorSubscriptionManager: vi.fn() }))
vi.mock('../../src/main/chat/grok-subscription/manager', () => ({ getGrokSubscriptionManager: vi.fn() }))
vi.mock('../../src/main/chat/cursor-subscription/portable-summarizer', () => ({ summarizeWithCursorRuntime: vi.fn() }))
vi.mock('../../src/main/chat/antigravity-subscription/manager', () => ({
  getAntigravitySubscriptionManager: () => h.antigravityManager,
}))
vi.mock('../../src/main/chat/antigravity-subscription/isolated-prompt', () => ({
  runAntigravityIsolatedPrompt: h.runAntigravityIsolatedPrompt,
}))

import { runOneShotText } from '../../src/main/chat/one-shot-text'

const args = {
  system: 'Extract facts.',
  prompt: 'A synthetic conversation.',
  signal: new AbortController().signal,
  conversationId: 'test-conversation',
  cwd: '/tmp/one-shot-test',
  agent: 'memory-extraction',
}
beforeEach(() => {
  vi.clearAllMocks()
  h.runCodexEphemeralWithFailover.mockResolvedValue({
    text: 'codex',
    usage: { input: 6, output: 2, cacheRead: 4, cacheCreate: 1, totalInput: 11 },
  })
  h.generateText.mockResolvedValue({
    text: 'api',
    totalUsage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 },
  })
})
describe('runOneShotText', () => {
  it('routes Codex through helper failover and returns its text and usage', async () => {
    const result = await runOneShotText({ ...args, selection: { providerId: 'codex-subscription', modelId: 'test' } })
    expect(h.runCodexEphemeralWithFailover).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'helper',
        signal: args.signal,
        conversationId: args.conversationId,
        extractAttemptUsage: expect.any(Function),
        mergeAttemptUsage: expect.any(Function),
      })
    )
    expect(result).toEqual({ text: 'codex', usage: { input: 6, output: 2, cacheRead: 4, cacheCreate: 1 } })
  })
  it('passes plain API prompts and returns normalized usage', async () => {
    const result = await runOneShotText({ ...args, selection: { providerId: 'api', modelId: 'test' } })
    expect(h.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: args.system,
        prompt: args.prompt,
        abortSignal: args.signal,
      })
    )
    expect(h.generateText.mock.calls[0][0]).not.toHaveProperty('messages')
    expect(result).toEqual({ text: 'api', usage: { input: 6, output: 2, cacheRead: 4, cacheCreate: 0 } })
    expect(h.recordModelCallUsage).toHaveBeenCalledWith(expect.objectContaining({ agent: args.agent }))
  })
  it('routes Google AI through an isolated Antigravity prompt', async () => {
    h.runAntigravityIsolatedPrompt.mockResolvedValue({ text: 'gemini' })
    const result = await runOneShotText({
      ...args,
      selection: { providerId: 'antigravity-subscription', modelId: 'gemini-3.1-pro', effort: 'low' },
    })
    expect(h.runAntigravityIsolatedPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        manager: h.antigravityManager,
        accountIdentity: { fingerprint: 'project:test', epoch: 1 },
        modelId: 'gemini-3.1-pro',
        reasoningEffort: 'low',
        system: args.system,
        prompt: args.prompt,
      })
    )
    expect(result).toEqual({ text: 'gemini', usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 } })
    expect(h.generateText).not.toHaveBeenCalled()
  })
  it('rejects unknown providers', async () => {
    await expect(runOneShotText({ ...args, selection: { providerId: 'unknown', modelId: 'test' } })).rejects.toThrow(
      'Unknown one-shot provider: unknown'
    )
  })
})
