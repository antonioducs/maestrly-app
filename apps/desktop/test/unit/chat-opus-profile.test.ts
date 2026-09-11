import { describe, expect, it } from 'vitest'
import { resolveClaudeBehaviorProfile as resolve } from '../../src/main/chat/behavior-profile'
import { OPUS_5_BEHAVIOR_PROFILE as opus } from '../../src/main/chat/opus/profile'
import { FABLE_51_BEHAVIOR_PROFILE as fable } from '../../src/main/chat/fable/profile'

describe('Claude profile isolation', () => {
  it('requires exact identity and honors canonical resolution', () => {
    expect(resolve({ requestedModelId: 'opus', resolvedModelId: opus.targetModelId }).profile).toEqual(opus)
    for (const requestedModelId of ['opus', 'claude-opus-5-latest', 'gateway/claude-opus-5', 'CLAUDE-OPUS-5']) {
      expect(resolve({ requestedModelId }).profile).toBeNull()
    }
    expect(resolve({ requestedModelId: opus.targetModelId, resolvedModelId: fable.targetModelId }).profile).toEqual(
      fable
    )
  })
  it('keeps flags independent and frozen executions reproducible', () => {
    expect(resolve({ requestedModelId: opus.targetModelId, opusEnabled: false }).reason).toBe('disabled')
    expect(resolve({ requestedModelId: opus.targetModelId, fableEnabled: false }).profile).toEqual(opus)
    expect(resolve({ requestedModelId: fable.targetModelId, opusEnabled: false }).profile).toEqual(fable)
    for (const profile of [opus, fable]) {
      const args = { requestedModelId: profile.targetModelId, frozen: true, fableEnabled: false, opusEnabled: false }
      expect(resolve(args)).toEqual({ profile: null, reason: 'frozen-legacy' })
      expect(resolve({ ...args, frozenProfileId: profile.id }).profile).toEqual(profile)
      expect(resolve({ ...args, frozenProfileId: 'unknown-v2' }).reason).toBe('frozen-profile-mismatch')
      expect(resolve({ ...args, frozenProfileId: profile.id, resolvedModelId: 'claude-sonnet-5' }).reason).toBe(
        'frozen-profile-mismatch'
      )
    }
  })
})
