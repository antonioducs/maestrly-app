import { describe, expect, it } from 'vitest'
import {
  resolveModelHarnessProfile,
  serializableReasoningEffortForProfile,
} from '../../src/main/chat/model-harness-profile'

const codexAdapter = {
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
} as const

describe('versioned model harness profiles', () => {
  it('activates Astra only for the exact official BYOK model ID', () => {
    const resolved = resolveModelHarnessProfile({
      providerKind: 'openai-responses',
      modelId: 'gpt-6-astra',
      baseURL: 'https://api.openai.com/v1',
      adapterCapabilities: codexAdapter,
    })
    expect(resolved.id).toBe('openai-gpt-6-astra-v1')
    expect(resolved.promptProfile).toBe('maestrly-openai-gpt-6-astra@v1')
    expect(resolved.capabilities).toMatchObject({
      encryptedReasoning: true,
      compaction: true,
      steering: true,
    })
  })

  it('activates Astra for the first-party Codex subscription', () => {
    expect(
      resolveModelHarnessProfile({
        providerKind: 'codex-subscription',
        modelId: 'GPT-6-ASTRA',
        adapterCapabilities: codexAdapter,
      }).id
    ).toBe('openai-gpt-6-astra-v1')
  })

  it('keeps the exact official BYOK Sol prompt identity without splitting Codex Sol/Luna continuity', () => {
    expect(
      resolveModelHarnessProfile({
        providerKind: 'openai-responses',
        modelId: 'gpt-5.6-sol',
        baseURL: 'https://api.openai.com/v1',
      }).id
    ).toBe('openai-gpt-5.6-sol-v1')
    expect(resolveModelHarnessProfile({ providerKind: 'codex-subscription', modelId: 'gpt-5.6-sol' }).id).toBe(
      'openai-default-v1'
    )
  })

  it.each([
    ['openai-responses', 'gpt-6-astra-latest', 'https://api.openai.com/v1'],
    ['openai-responses', 'Astra', 'https://api.openai.com/v1'],
    ['openai-responses', 'gpt-6-astra-mini', 'https://api.openai.com/v1'],
    ['openai-responses', 'gpt-6-future', 'https://api.openai.com/v1'],
    ['openai-responses', 'gpt-6-astra', 'https://gateway.example/v1'],
    ['openai', 'gpt-6-astra', 'https://api.openai.com/v1'],
  ] as const)('fails closed for provider=%s model=%s base=%s', (providerKind, modelId, baseURL) => {
    expect(resolveModelHarnessProfile({ providerKind, modelId, baseURL, adapterCapabilities: codexAdapter }).id).toBe(
      'openai-default-v1'
    )
  })

  it('lets explicit runtime false disable a manifest capability', () => {
    const resolved = resolveModelHarnessProfile({
      providerKind: 'codex-subscription',
      modelId: 'gpt-6-astra',
      runtimeModelCapabilities: { experimentalContext: false, parallelTools: false },
      adapterCapabilities: codexAdapter,
    })
    expect(resolved.modelCapabilities.experimentalContext).toBe(false)
    expect(resolved.capabilities.experimentalContext).toBe(false)
    expect(resolved.capabilities.parallelTools).toBe(false)
  })

  it('uses the manifest for absent fields but intersects transport support', () => {
    const resolved = resolveModelHarnessProfile({
      providerKind: 'codex-subscription',
      modelId: 'gpt-6-astra',
      adapterCapabilities: { ...codexAdapter, steering: false, asyncTools: false },
    })
    expect(resolved.modelCapabilities.steering).toBe(true)
    expect(resolved.capabilities.steering).toBe(false)
    expect(resolved.capabilities.asyncTools).toBe(false)
  })

  it('honors the kill switch and never serializes none/minimal', () => {
    expect(
      resolveModelHarnessProfile({
        providerKind: 'codex-subscription',
        modelId: 'gpt-6-astra',
        astraHarnessEnabled: false,
        adapterCapabilities: codexAdapter,
      }).id
    ).toBe('openai-default-v1')
    expect(serializableReasoningEffortForProfile('openai-gpt-6-astra-v1', 'none')).toBeNull()
    expect(serializableReasoningEffortForProfile('openai-gpt-6-astra-v1', 'minimal')).toBeNull()
    expect(serializableReasoningEffortForProfile('openai-gpt-6-astra-v1', 'ultra')).toBe('ultra')
  })

  it('intersects published efforts with the Astra manifest', () => {
    const resolved = resolveModelHarnessProfile({
      providerKind: 'codex-subscription',
      modelId: 'gpt-6-astra',
      adapterCapabilities: codexAdapter,
      runtimeReasoningEfforts: ['minimal', 'high', 'future-effort'],
    })
    expect(resolved.capabilities.validReasoningEfforts).toEqual(['high'])
  })
})
