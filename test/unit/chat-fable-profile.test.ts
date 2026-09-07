import { describe, expect, it } from 'vitest'
import { FABLE_51_BEHAVIOR_PROFILE_ID, resolveFableBehaviorProfile } from '../../src/main/chat/fable/profile'

describe('Fable 5.1 behavior profile', () => {
  it('matches only the exact requested target when no canonical identity is available', () => {
    expect(resolveFableBehaviorProfile({ requestedModelId: 'claude-fable-5-1' })).toMatchObject({
      profile: { id: FABLE_51_BEHAVIOR_PROFILE_ID },
      reason: 'matched-requested-model',
    })
    for (const model of [
      'fable',
      'claude-fable-5',
      'claude-fable-5-2',
      'claude-fable-5-1-latest',
      'gateway/claude-fable-5-1',
      'not-claude-fable-5-1',
      'CLAUDE-FABLE-5-1',
    ]) {
      expect(resolveFableBehaviorProfile({ requestedModelId: model }).profile).toBeNull()
    }
  })

  it('uses the authoritative resolved identity for aliases', () => {
    expect(
      resolveFableBehaviorProfile({ requestedModelId: 'fable', resolvedModelId: 'claude-fable-5-1' }).profile?.id
    ).toBe(FABLE_51_BEHAVIOR_PROFILE_ID)
    expect(
      resolveFableBehaviorProfile({ requestedModelId: 'claude-fable-5-1', resolvedModelId: 'claude-fable-5' }).profile
    ).toBeNull()
    expect(resolveFableBehaviorProfile({ requestedModelId: 'fable', resolvedModelId: null }).profile).toBeNull()
  })

  it('honors the kill switch and frozen policy without reinterpretation', () => {
    expect(resolveFableBehaviorProfile({ requestedModelId: 'claude-fable-5-1', enabled: false })).toEqual({
      profile: null,
      reason: 'disabled',
    })
    expect(
      resolveFableBehaviorProfile({
        requestedModelId: 'claude-fable-5-1',
        enabled: true,
        frozen: true,
        frozenProfileId: null,
      })
    ).toEqual({ profile: null, reason: 'frozen-legacy' })
    expect(
      resolveFableBehaviorProfile({
        requestedModelId: 'fable',
        resolvedModelId: 'claude-fable-5',
        frozen: true,
        frozenProfileId: FABLE_51_BEHAVIOR_PROFILE_ID,
      })
    ).toEqual({ profile: null, reason: 'frozen-profile-mismatch' })
    expect(
      resolveFableBehaviorProfile({
        requestedModelId: 'claude-fable-5-1',
        frozen: true,
        frozenProfileId: 'maestrly-fable-5.1-v999',
      })
    ).toEqual({ profile: null, reason: 'frozen-profile-mismatch' })
  })
})
