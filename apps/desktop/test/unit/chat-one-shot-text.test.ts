import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  generateText: vi.fn(),
  runCodexEphemeralWithFailover: vi.fn(),
  recordModelCallUsage: vi.fn(),
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
  isAntigravitySubscriptionProvider: () => false,
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
  it('rejects unknown providers', async () => {
    await expect(runOneShotText({ ...args, selection: { providerId: 'unknown', modelId: 'test' } })).rejects.toThrow(
      'Unknown one-shot provider: unknown'
    )
  })
})
