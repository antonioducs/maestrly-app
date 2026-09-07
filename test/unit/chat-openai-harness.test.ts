import { describe, expect, it } from 'vitest'
import { effectiveProviderKind } from '../../src/shared/chat'
import {
  bypassLegacyAutoCompaction,
  isOpenAIHarnessActive,
  isOpenAIResponsesHarness,
  openAIHarnessProviderOptions,
  resolveChatHarness,
} from '../../src/main/chat/harness'

describe('OpenAI harness profile', () => {
  const openAIBaseURL = 'https://api.openai.com/v1'

  it.each(['anthropic', 'openai'] as const)('keeps %s on the legacy harness', (kind) => {
    const resolved = resolveChatHarness(kind, 'gpt-5.6')
    expect(resolved.profile).toBe('legacy')
    expect(resolved.promptProfile).toBe('maestrly-legacy')
    expect(Object.values(resolved.capabilities)).not.toContain(true)
    expect(isOpenAIResponsesHarness(resolved)).toBe(false)
  })

  it('enables basic Responses for OpenAI IDs without capturing third-party models on the same gateway', () => {
    const resolved = resolveChatHarness('openai-responses', 'gpt-future-model')
    expect(resolved).toMatchObject({
      profile: 'openai-responses-v1',
      promptProfile: 'maestrly-openai-generic-v1',
      capabilities: {
        responseItems: true,
        strictTools: true,
        promptCacheKey: true,
        toolSearch: false,
        nativeCompaction: false,
      },
    })
    expect(resolveChatHarness('openai-responses', 'claude-via-responses').profile).toBe('legacy')
    expect(resolveChatHarness('openai-responses', 'future-model').profile).toBe('legacy')
  })

  it.each([
    'gpt-4.1',
    'gpt-5',
    'gpt-5.6-sol',
    'chatgpt-4o-latest',
    'o1',
    'o3-mini',
    'o4-mini',
    'codex-mini-latest',
    'ft:gpt-4.1:acme:custom',
  ])('recognizes OpenAI id %s on Responses transport', (modelId) => {
    expect(resolveChatHarness('openai-responses', modelId).profile).toBe('openai-responses-v1')
  })

  it.each([
    'claude-4-opus',
    'gemini-2.5-pro',
    'deepseek-r1',
    'openai/gpt-5',
  ])('does not capture the third-party or namespaced ID %s', (modelId) => {
    expect(resolveChatHarness('openai-responses', modelId).profile).toBe('legacy')
  })

  it('enables Responses for the official host even when the persisted kind is legacy', () => {
    const kind = effectiveProviderKind(openAIBaseURL, 'openai')
    const resolved = resolveChatHarness(kind, 'gpt-5.6-sol', openAIBaseURL)

    expect(resolved.profile).toBe('openai-responses-v1')
    expect(isOpenAIHarnessActive(true, resolved)).toBe(true)
    expect(isOpenAIHarnessActive(false, resolved)).toBe(false)
  })

  it('applies the kill switch before enabling any Responses profile', () => {
    const responses = resolveChatHarness('openai-responses', 'gpt-5.6-sol')
    expect(isOpenAIHarnessActive(true, responses)).toBe(true)
    expect(isOpenAIHarnessActive(false, responses)).toBe(false)
    expect(isOpenAIHarnessActive(true, resolveChatHarness('openai', 'gpt-5.6-sol'))).toBe(false)
  })

  it('enables modern capabilities only for known models', () => {
    const sol = resolveChatHarness('openai-responses', 'gpt-5.6-sol', openAIBaseURL)
    expect(sol.promptProfile).toBe('codex-gpt-5.6-sol@5bed644')
    expect(sol.capabilities).toMatchObject({
      encryptedReasoning: true,
      messagePhase: true,
      toolSearch: true,
      nativeShell: false,
      nativeApplyPatch: true,
      nativeCompaction: true,
      reasoningContext: true,
      websocket: false,
    })
    expect(resolveChatHarness('openai-responses', 'gpt-5-codex', openAIBaseURL).capabilities).toMatchObject({
      encryptedReasoning: true,
      toolSearch: false,
      nativeShell: true,
      nativeApplyPatch: true,
      nativeCompaction: false,
    })
    expect(resolveChatHarness('openai-responses', 'gpt-5.3-codex', openAIBaseURL).capabilities).toMatchObject({
      toolSearch: false,
      nativeShell: false,
      nativeApplyPatch: true,
      nativeCompaction: false,
    })
    expect(resolveChatHarness('openai-responses', 'gpt-5.1', openAIBaseURL).capabilities).toMatchObject({
      nativeApplyPatch: true,
      nativeShell: false,
      nativeCompaction: false,
      toolSearch: false,
    })
    expect(resolveChatHarness('openai-responses', 'gpt-5.6-sol-2026-07-01').promptProfile).toBe(
      'maestrly-openai-generic-v1'
    )
    expect(resolveChatHarness('openai-responses', 'gpt-5.6-terra').promptProfile).toBe('maestrly-openai-generic-v1')
  })

  it('does not advertise native apply_patch for Responses gateways that do not declare the extension', () => {
    const proxied = resolveChatHarness('openai-responses', 'gpt-5.6-sol', 'http://localhost:4144/v1')
    expect(proxied.capabilities.nativeApplyPatch).toBe(false)
    expect(proxied.capabilities).toMatchObject({
      responseItems: true,
      toolSearch: true,
      nativeCompaction: true,
    })
    expect(resolveChatHarness('openai-responses', 'gpt-5.6-sol', openAIBaseURL).capabilities.nativeApplyPatch).toBe(
      true
    )
  })

  it('retains legacy automatic compaction only when native compaction is inactive', () => {
    const native = resolveChatHarness('openai-responses', 'gpt-5.6-sol')
    const older = resolveChatHarness('openai-responses', 'gpt-5.3-codex')
    const legacy = resolveChatHarness('openai', 'gpt-5.6-sol')

    expect(bypassLegacyAutoCompaction(true, native)).toBe(true)
    expect(bypassLegacyAutoCompaction(false, native)).toBe(false)
    expect(bypassLegacyAutoCompaction(true, older)).toBe(false)
    expect(bypassLegacyAutoCompaction(true, legacy)).toBe(false)
  })

  it('composes stable options and sends reasoningContext only when supported and active', () => {
    const resolved = resolveChatHarness('openai-responses', 'gpt-5.6')
    expect(
      openAIHarnessProviderOptions(resolved, {
        promptCacheKey: 'maestrly:key',
        reasoningEnabled: true,
        compactionThreshold: 900_000,
      })
    ).toEqual({
      store: false,
      include: ['reasoning.encrypted_content'],
      strictJsonSchema: true,
      parallelToolCalls: true,
      promptCacheKey: 'maestrly:key',
      truncation: 'disabled',
      reasoningContext: 'all_turns',
      contextManagement: [{ type: 'compaction', compactThreshold: 900_000 }],
    })
  })

  it('applies the exact Astra BYOK profile without advertising synchronous-only controls', () => {
    const resolved = resolveChatHarness('openai-responses', 'gpt-6-astra', openAIBaseURL)
    expect(resolved).toMatchObject({
      profile: 'openai-responses-v1',
      modelHarnessProfileId: 'openai-gpt-6-astra-v1',
      promptProfile: 'maestrly-openai-gpt-6-astra@v1',
      capabilities: {
        encryptedReasoning: true,
        reasoningContext: true,
        nativeCompaction: true,
        parallelTools: true,
        midTurnSteering: false,
        asyncTools: false,
        liveReasoningUpdate: false,
      },
    })
    const options = openAIHarnessProviderOptions(resolved, {
      promptCacheKey: 'maestrly:astra',
      promptCacheTtl: '30m',
      reasoningEnabled: true,
      compactionThreshold: 300_000,
    })
    expect(options).toMatchObject({
      include: ['reasoning.encrypted_content'],
      reasoningContext: 'all_turns',
      parallelToolCalls: true,
      promptCacheOptions: { ttl: '30m' },
      contextManagement: [{ type: 'compaction', compactThreshold: 300_000 }],
    })
    expect(options).not.toHaveProperty('temperature')
    expect(options).not.toHaveProperty('topP')
    expect(options).not.toHaveProperty('topLogprobs')
    expect(options).not.toHaveProperty('logprobs')
  })

  it('restores the generic profile when the Astra switch is disabled or endpoint is custom', () => {
    expect(
      resolveChatHarness('openai-responses', 'gpt-6-astra', openAIBaseURL, { astraHarnessEnabled: false })
        .modelHarnessProfileId
    ).toBe('openai-default-v1')
    expect(
      resolveChatHarness('openai-responses', 'gpt-6-astra', 'https://gateway.example/v1').modelHarnessProfileId
    ).toBe('openai-default-v1')
  })
})
