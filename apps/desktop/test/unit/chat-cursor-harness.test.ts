import { describe, expect, it } from 'vitest'
import { buildHarnessPrompt } from '../../src/main/chat/harness/prompt-builder'
import { resolveCursorHarness } from '../../src/main/chat/harness/adapters/cursor'
import { createHarnessSnapshot } from '../../src/main/chat/harness/compatibility'
import { hashCursorHarnessEnvelope } from '../../src/main/chat/cursor-subscription/session'

describe('Cursor native harness contract', () => {
  it('records its own native prompt identity and advertises only implemented transport features', () => {
    const harness = resolveCursorHarness('composer-offline-fixture', { flags: {} })
    expect(harness.identity.promptIdentity).toBe('cursor-native-with-host-v1')
    expect(harness.identity.compatibilityGroup).toBe('cursor-native-v1')
    expect(Object.values(harness.capabilities)).toEqual(Array(10).fill(false))
  })

  it('rejects frozen contract drift', () => {
    const harness = resolveCursorHarness('composer-offline-fixture', { flags: {} })
    const snapshot = createHarnessSnapshot(harness)
    expect(() =>
      resolveCursorHarness('composer-offline-fixture', {
        flags: {},
        frozen: true,
        frozenSnapshot: { ...snapshot, definitionHash: 'changed' },
      })
    ).toThrow('frozen-snapshot-mismatch')
  })

  it('invalidates the instruction hash when a harness snapshot changes', () => {
    const harness = resolveCursorHarness('composer-offline-fixture', { flags: {} })
    const envelope = {
      mode: 'agent' as const,
      modelId: 'composer-offline-fixture',
      cwd: '/repo',
      projectContext: '',
      skillCatalog: '',
      agentCatalog: '',
      environment: '',
      ultra: false,
      instructions: 'Host context',
      harnessSnapshot: createHarnessSnapshot(harness),
    }
    expect(hashCursorHarnessEnvelope(envelope)).not.toBe(
      hashCursorHarnessEnvelope({
        ...envelope,
        harnessSnapshot: { ...envelope.harnessSnapshot, definitionHash: 'changed' },
      })
    )
  })
})

describe('Cursor model instructions', () => {
  it.each([
    'gpt-6-astra',
    'gpt-5.6-sol',
    'claude-opus-5',
    'claude-fable-5-1',
  ])('applies the registered profile for %s without importing transport capabilities', (modelId) => {
    const harness = resolveCursorHarness(modelId, { flags: {} })
    expect(harness.profileId).toBe(modelId)
    expect(harness.identity.harnessProfileId).toBe('cursor-native-v1')
    expect(harness.identity.compatibilityGroup).toBe('cursor-native-v1')
    expect(Object.values(harness.capabilities)).toEqual(Array(10).fill(false))
    expect(harness.reasoning.manifestEfforts).toBeNull()
    expect(harness.reasoning.nativeUltra).toBe(false)
    expect(harness.runtime.nativeCompactionFirst).toBe(false)
    const prompt = buildHarnessPrompt({
      harness,
      cwd: '/repo',
      mode: 'agent',
      appToolsEnabled: false,
      hasNotesTab: false,
    })
    const profileText = harness.prompts.base ?? harness.prompts.styleAndWork
    expect(profileText).toBeTruthy()
    expect(prompt.instructions).toContain(profileText!.trim())
  })

  it('keeps exact model matching and feature flags', () => {
    expect(resolveCursorHarness('gpt-6-astra-unknown', { flags: {} }).profileId).toBe('default')
    expect(resolveCursorHarness('gpt-6-astra', { flags: { 'chat.astraHarness': false } }).profileId).toBe('default')
  })
})
