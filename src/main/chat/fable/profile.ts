export const FABLE_51_MODEL_ID = 'claude-fable-5-1'
export const FABLE_51_BEHAVIOR_PROFILE_ID = 'maestrly-fable-5.1-v1'
export const FABLE_51_PROFILE_FLAG = 'chat.fable51Profile'

export type FableProgressMode = 'summarized'

export interface FableBehaviorProfile {
  id: typeof FABLE_51_BEHAVIOR_PROFILE_ID
  targetModelId: typeof FABLE_51_MODEL_ID
  progressMode: FableProgressMode
}

export const FABLE_51_BEHAVIOR_PROFILE: FableBehaviorProfile = Object.freeze({
  id: FABLE_51_BEHAVIOR_PROFILE_ID,
  targetModelId: FABLE_51_MODEL_ID,
  progressMode: 'summarized',
})

export type FableProfileResolutionReason =
  | 'matched-requested-model'
  | 'matched-resolved-model'
  | 'disabled'
  | 'frozen-legacy'
  | 'frozen-profile-mismatch'
  | 'model-not-target'

export interface ResolveFableBehaviorProfileArgs {
  requestedModelId: string
  /** Canonical identity supplied by the transport catalog/runtime. It is authoritative when present. */
  resolvedModelId?: string | null
  enabled?: boolean
  /** Present for frozen executions. null/undefined legacy snapshots intentionally retain legacy behavior. */
  frozenProfileId?: string | null
  frozen?: boolean
}

export interface FableProfileResolution {
  profile: FableBehaviorProfile | null
  reason: FableProfileResolutionReason
}

function exactModelId(value: string | null | undefined): string {
  return value?.trim() ?? ''
}

/** Pure exact-identity resolver. It never strips gateway prefixes or expands model families. */
export function resolveFableBehaviorProfile(args: ResolveFableBehaviorProfileArgs): FableProfileResolution {
  if (args.frozen) {
    if (args.frozenProfileId == null) {
      return { profile: null, reason: 'frozen-legacy' }
    }
    if (args.frozenProfileId !== FABLE_51_BEHAVIOR_PROFILE_ID) {
      return { profile: null, reason: 'frozen-profile-mismatch' }
    }
  } else if (args.enabled === false) {
    return { profile: null, reason: 'disabled' }
  }

  const requested = exactModelId(args.requestedModelId)
  const resolved = exactModelId(args.resolvedModelId)
  const effective = resolved || requested
  if (effective !== FABLE_51_MODEL_ID) {
    return {
      profile: null,
      reason: args.frozen ? 'frozen-profile-mismatch' : 'model-not-target',
    }
  }
  return {
    profile: FABLE_51_BEHAVIOR_PROFILE,
    reason: resolved ? 'matched-resolved-model' : 'matched-requested-model',
  }
}

export function fableBehaviorProfileFromId(id: string | null | undefined): FableBehaviorProfile | null {
  return id === FABLE_51_BEHAVIOR_PROFILE_ID ? FABLE_51_BEHAVIOR_PROFILE : null
}
