import {
  FABLE_51_BEHAVIOR_PROFILE_ID,
  FABLE_51_MODEL_ID,
  type FableBehaviorProfile,
  type FableProfileResolutionReason,
  type ResolveFableBehaviorProfileArgs,
  resolveFableBehaviorProfile,
} from './fable/profile'
import {
  OPUS_5_BEHAVIOR_PROFILE_ID,
  OPUS_5_MODEL_ID,
  type OpusBehaviorProfile,
  resolveOpusBehaviorProfile,
} from './opus/profile'

export type ClaudeBehaviorProfile = FableBehaviorProfile | OpusBehaviorProfile

export interface ResolveClaudeBehaviorProfileArgs extends Omit<ResolveFableBehaviorProfileArgs, 'enabled'> {
  fableEnabled?: boolean
  opusEnabled?: boolean
}

export interface ClaudeProfileResolution {
  profile: ClaudeBehaviorProfile | null
  reason: FableProfileResolutionReason
}

export function isFableBehaviorProfile(
  profile: ClaudeBehaviorProfile | null | undefined
): profile is FableBehaviorProfile {
  return profile?.id === FABLE_51_BEHAVIOR_PROFILE_ID
}

export function isOpusBehaviorProfile(
  profile: ClaudeBehaviorProfile | null | undefined
): profile is OpusBehaviorProfile {
  return profile?.id === OPUS_5_BEHAVIOR_PROFILE_ID
}

export function resolveClaudeBehaviorProfile(args: ResolveClaudeBehaviorProfileArgs): ClaudeProfileResolution {
  if (args.frozen) {
    if (args.frozenProfileId == null) return { profile: null, reason: 'frozen-legacy' }
    if (args.frozenProfileId === FABLE_51_BEHAVIOR_PROFILE_ID) {
      return resolveFableBehaviorProfile({ ...args, enabled: args.fableEnabled })
    }
    if (args.frozenProfileId === OPUS_5_BEHAVIOR_PROFILE_ID) {
      return resolveOpusBehaviorProfile({ ...args, enabled: args.opusEnabled })
    }
    return { profile: null, reason: 'frozen-profile-mismatch' }
  }

  const effectiveModelId = args.resolvedModelId?.trim() || args.requestedModelId.trim()
  if (effectiveModelId === FABLE_51_MODEL_ID) {
    return resolveFableBehaviorProfile({ ...args, enabled: args.fableEnabled })
  }
  if (effectiveModelId === OPUS_5_MODEL_ID) {
    return resolveOpusBehaviorProfile({ ...args, enabled: args.opusEnabled })
  }
  return { profile: null, reason: 'model-not-target' }
}
