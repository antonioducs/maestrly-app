import { describe, expect, it } from 'vitest'
import { harnessRegistry } from '../../src/main/chat/harness/catalog'
import { resolveChatHarness, resolveChatHarnessExecution } from '../../src/main/chat/harness/execution'
import { serializableReasoningEffort } from '../../src/main/chat/harness/policies'
import { resolveHarness } from '../../src/main/chat/harness/resolver'
import type { ChatProviderKind } from '../../src/shared/chat'
import type { HarnessCapabilityClaims } from '../../src/shared/harness'

const OFFICIAL = 'https://api.openai.com/v1'
const registry = harnessRegistry()

const codexAdapter: HarnessCapabilityClaims = {
  responsesTools: true,
  persistedReasoning: true,
  encryptedReasoning: true,
  reasoningContext: true,
  compaction: true,
  parallelTools: true,
  steering: true,
  asyncTools: true,
  configurationUpdates: true,
  experimentalContext: true,
}

const behavior = (
  requestedModelId: string,
  extra: {
    resolvedModelId?: string | null
    flags?: Record<string, boolean>
    frozen?: boolean
    frozenBehaviorProfileId?: string | null
  } = {}
) => resolveHarness({ providerKind: 'claude-subscription', requestedModelId, ...extra }, registry)

describe('harness resolver: identity matching', () => {
  it('activates a specialized profile only for the exact official BYOK model id', () => {
    const execution = resolveChatHarness('openai-responses', 'gpt-6-astra', OFFICIAL, {
      adapterCapabilities: codexAdapter,
    })
    expect(execution.modelHarnessProfileId).toBe('openai-gpt-6-astra-v1')
    expect(execution.promptProfile).toBe('maestrly-openai-gpt-6-astra@v1')
    expect(execution.harness.capabilities).toMatchObject({
      encryptedReasoning: true,
      compaction: true,
      steering: true,
    })
  })

  it('honors the case-insensitivity a profile declares, and nothing more', () => {
    expect(
      resolveChatHarness('codex-subscription', 'GPT-6-ASTRA', undefined, { adapterCapabilities: codexAdapter })
        .modelHarnessProfileId
    ).toBe('openai-gpt-6-astra-v1')
    for (const modelId of ['opus', 'claude-opus-5-latest', 'gateway/claude-opus-5', 'CLAUDE-OPUS-5']) {
      const resolution = behavior(modelId)
      expect(resolution.ok && resolution.harness.identity.behaviorProfileId, modelId).toBeNull()
    }
  })

  it('keeps the exact Sol prompt identity without splitting Codex Sol/Luna continuity', () => {
    expect(resolveChatHarness('openai-responses', 'gpt-5.6-sol', OFFICIAL).modelHarnessProfileId).toBe(
      'openai-gpt-5.6-sol-v1'
    )
    expect(resolveChatHarness('codex-subscription', 'gpt-5.6-sol').modelHarnessProfileId).toBe('openai-default-v1')
    expect(resolveChatHarness('codex-subscription', 'gpt-5.6-luna').modelHarnessProfileId).toBe('openai-default-v1')
    expect(resolveChatHarness('codex-subscription', 'gpt-5.6-sol').harness.contractId).toBe(
      resolveChatHarness('codex-subscription', 'gpt-5.6-luna').harness.contractId
    )
  })

  it.each([
    ['openai-responses', 'gpt-6-astra-latest', OFFICIAL],
    ['openai-responses', 'Astra', OFFICIAL],
    ['openai-responses', 'gpt-6-astra-mini', OFFICIAL],
    ['openai-responses', 'gpt-6-future', OFFICIAL],
    ['openai-responses', 'gpt-6-astra', 'https://gateway.example/v1'],
    ['openai', 'gpt-6-astra', OFFICIAL],
  ] as const)('fails closed for provider=%s model=%s base=%s', (providerKind, modelId, baseURL) => {
    expect(
      resolveChatHarness(providerKind as ChatProviderKind, modelId, baseURL, { adapterCapabilities: codexAdapter })
        .modelHarnessProfileId
    ).toBe('openai-default-v1')
  })

  it('prefers the canonical identity confirmed by the transport over the requested alias', () => {
    const aliased = behavior('opus', { resolvedModelId: 'claude-opus-5' })
    expect(aliased.ok && aliased.harness.identity.behaviorProfileId).toBe('maestrly-opus-5-v1')
    expect(aliased.ok && aliased.harness.reason).toBe('matched-resolved-model')
    const mismatched = behavior('claude-opus-5', { resolvedModelId: 'claude-fable-5-1' })
    expect(mismatched.ok && mismatched.harness.identity.behaviorProfileId).toBe('maestrly-fable-5.1-v1')
    const unknownCanonical = behavior('claude-opus-5', { resolvedModelId: 'claude-sonnet-5' })
    expect(unknownCanonical.ok && unknownCanonical.harness.identity.behaviorProfileId).toBeNull()
  })
})

describe('harness resolver: flags', () => {
  it('keeps each profile flag independent', () => {
    expect(behavior('claude-opus-5', { flags: { 'chat.opus5Profile': false } })).toMatchObject({
      ok: true,
      harness: { reason: 'disabled', identity: { behaviorProfileId: null } },
    })
    const opus = behavior('claude-opus-5', { flags: { 'chat.fable51Profile': false } })
    expect(opus.ok && opus.harness.identity.behaviorProfileId).toBe('maestrly-opus-5-v1')
    const fable = behavior('claude-fable-5-1', { flags: { 'chat.opus5Profile': false } })
    expect(fable.ok && fable.harness.identity.behaviorProfileId).toBe('maestrly-fable-5.1-v1')
  })

  it('does not mutate an already resolved contract when a later execution flips a flag', () => {
    const first = behavior('claude-fable-5-1')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = behavior('claude-fable-5-1', { flags: { 'chat.fable51Profile': false } })
    expect(second.ok && second.harness.identity.behaviorProfileId).toBeNull()
    expect(first.harness.identity.behaviorProfileId).toBe('maestrly-fable-5.1-v1')
  })

  it('resolves concurrent executions of different profiles independently', () => {
    const [fable, opus, plain] = [
      behavior('claude-fable-5-1'),
      behavior('claude-opus-5'),
      behavior('claude-sonnet-4'),
    ]
    expect([
      fable.ok && fable.harness.profileId,
      opus.ok && opus.harness.profileId,
      plain.ok && plain.harness.profileId,
    ]).toEqual(['claude-fable-5-1', 'claude-opus-5', 'default'])
  })
})

describe('harness resolver: frozen executions', () => {
  it('reproduces the frozen behavioral identity and refuses everything else', () => {
    for (const [modelId, profileId] of [
      ['claude-opus-5', 'maestrly-opus-5-v1'],
      ['claude-fable-5-1', 'maestrly-fable-5.1-v1'],
    ] as const) {
      const legacy = behavior(modelId, { frozen: true, frozenBehaviorProfileId: null })
      expect(legacy.ok && legacy.harness.reason).toBe('frozen-legacy')
      expect(legacy.ok && legacy.harness.identity.behaviorProfileId).toBeNull()

      const frozen = behavior(modelId, { frozen: true, frozenBehaviorProfileId: profileId })
      expect(frozen.ok && frozen.harness.identity.behaviorProfileId).toBe(profileId)

      expect(behavior(modelId, { frozen: true, frozenBehaviorProfileId: 'unknown-v2' })).toEqual({
        ok: false,
        reason: 'frozen-profile-mismatch',
      })
      expect(
        behavior(modelId, {
          frozen: true,
          frozenBehaviorProfileId: profileId,
          resolvedModelId: 'claude-sonnet-5',
        })
      ).toEqual({ ok: false, reason: 'frozen-profile-mismatch' })
    }
  })

  it('applies a frozen profile even when its live flag would disable it', () => {
    const frozen = behavior('claude-opus-5', {
      frozen: true,
      frozenBehaviorProfileId: 'maestrly-opus-5-v1',
      flags: { 'chat.opus5Profile': false },
    })
    expect(frozen.ok && frozen.harness.identity.behaviorProfileId).toBe('maestrly-opus-5-v1')
  })
})

describe('harness resolver: capabilities and efforts', () => {
  it('lets an explicit runtime false disable a manifest capability', () => {
    const execution = resolveChatHarness('codex-subscription', 'gpt-6-astra', undefined, {
      runtimeCapabilities: { experimentalContext: false, parallelTools: false },
      adapterCapabilities: codexAdapter,
    })
    expect(execution.harness.modelCapabilities.experimentalContext).toBe(false)
    expect(execution.harness.capabilities.experimentalContext).toBe(false)
    expect(execution.harness.capabilities.parallelTools).toBe(false)
  })

  it('uses the manifest for absent fields but intersects transport support', () => {
    const execution = resolveChatHarness('codex-subscription', 'gpt-6-astra', undefined, {
      adapterCapabilities: { ...codexAdapter, steering: false, asyncTools: false },
    })
    expect(execution.harness.modelCapabilities.steering).toBe(true)
    expect(execution.harness.capabilities.steering).toBe(false)
    expect(execution.harness.capabilities.asyncTools).toBe(false)
  })

  it('intersects published efforts with the profile manifest', () => {
    const execution = resolveChatHarness('codex-subscription', 'gpt-6-astra', undefined, {
      adapterCapabilities: codexAdapter,
      runtimeReasoningEfforts: ['minimal', 'high', 'future-effort'],
    })
    expect(execution.harness.reasoning.effectiveEfforts).toEqual(['high'])
  })

  it('never serializes an interface reset or a non-serializable tier', () => {
    const astra = resolveChatHarness('codex-subscription', 'gpt-6-astra', undefined, {
      adapterCapabilities: codexAdapter,
    }).harness.reasoning
    expect(serializableReasoningEffort(astra, 'none')).toBeNull()
    expect(serializableReasoningEffort(astra, 'minimal')).toBeNull()
    expect(serializableReasoningEffort(astra, 'off')).toBeNull()
    expect(serializableReasoningEffort(astra, 'default')).toBeNull()
    expect(serializableReasoningEffort(astra, 'ultra')).toBe('ultra')
    const plain = resolveChatHarness('codex-subscription', 'gpt-5.6-sol').harness.reasoning
    expect(serializableReasoningEffort(plain, 'anything')).toBe('anything')
    expect(serializableReasoningEffort(plain, 'off')).toBeNull()
  })

  it('does not apply a specialized transport policy when the endpoint is unsupported', () => {
    const gateway = resolveChatHarness('openai-responses', 'gpt-6-astra', 'https://gateway.example/v1')
    expect(gateway.harness.reason).toBe('unsupported-endpoint')
    expect(gateway.harness.runtime.promptCacheTtl).toBeNull()
    expect(gateway.capabilities.responseItems).toBe(true)
  })
})

describe('harness resolver: immutability', () => {
  it('returns a deeply frozen contract', () => {
    const harness = resolveChatHarness('claude-subscription', 'claude-fable-5-1').harness
    expect(Object.isFrozen(harness)).toBe(true)
    expect(Object.isFrozen(harness.prompts)).toBe(true)
    expect(Object.isFrozen(harness.identity)).toBe(true)
    expect(Object.isFrozen(harness.hooks)).toBe(true)
    expect(Object.isFrozen(harness.reasoning.effectiveEfforts)).toBe(true)
    expect(() => {
      ;(harness.identity as { behaviorProfileId: string | null }).behaviorProfileId = 'x'
    }).toThrow()
  })

  it('exposes a distinct contract hash per applied contract', () => {
    const hashes = new Set(
      [
        resolveChatHarness('claude-subscription', 'claude-fable-5-1'),
        resolveChatHarness('claude-subscription', 'claude-opus-5'),
        resolveChatHarness('claude-subscription', 'claude-sonnet-4'),
        resolveChatHarness('codex-subscription', 'gpt-6-astra'),
      ].map((execution) => execution.harness.definitionHash)
    )
    expect(hashes.size).toBe(4)
  })

  it('never reports a frozen mismatch for a non-frozen selection', () => {
    expect(resolveChatHarnessExecution('anthropic', 'anything-at-all').ok).toBe(true)
  })
})
