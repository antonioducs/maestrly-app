export const OPUS_5_MODEL_ID = 'claude-opus-5'
export const OPUS_5_BEHAVIOR_PROFILE_ID = 'maestrly-opus-5-v1'
export const OPUS_5_PROFILE_FLAG = 'chat.opus5Profile'

export type OpusProgressMode = 'prompt-only'

export interface OpusBehaviorProfile {
  id: typeof OPUS_5_BEHAVIOR_PROFILE_ID
  targetModelId: typeof OPUS_5_MODEL_ID
  progressMode: OpusProgressMode
}

export const OPUS_5_BEHAVIOR_PROFILE: OpusBehaviorProfile = Object.freeze({
  id: OPUS_5_BEHAVIOR_PROFILE_ID,
  targetModelId: OPUS_5_MODEL_ID,
  progressMode: 'prompt-only',
})

export type OpusProfileResolutionReason =
  | 'matched-requested-model'
  | 'matched-resolved-model'
  | 'disabled'
  | 'frozen-legacy'
  | 'frozen-profile-mismatch'
  | 'model-not-target'

export interface ResolveOpusBehaviorProfileArgs {
  requestedModelId: string
  /** Canonical identity supplied by the transport catalog/runtime. It is authoritative when present. */
  resolvedModelId?: string | null
  enabled?: boolean
  /** Present for frozen executions. null/undefined legacy snapshots intentionally retain legacy behavior. */
  frozenProfileId?: string | null
  frozen?: boolean
}

export interface OpusProfileResolution {
  profile: OpusBehaviorProfile | null
  reason: OpusProfileResolutionReason
}

function exactModelId(value: string | null | undefined): string {
  return value?.trim() ?? ''
}

/** Pure exact-identity resolver. It never strips gateway prefixes or expands model families. */
export function resolveOpusBehaviorProfile(args: ResolveOpusBehaviorProfileArgs): OpusProfileResolution {
  if (args.frozen) {
    if (args.frozenProfileId == null) {
      return { profile: null, reason: 'frozen-legacy' }
    }
    if (args.frozenProfileId !== OPUS_5_BEHAVIOR_PROFILE_ID) {
      return { profile: null, reason: 'frozen-profile-mismatch' }
    }
  } else if (args.enabled === false) {
    return { profile: null, reason: 'disabled' }
  }

  const requested = exactModelId(args.requestedModelId)
  const resolved = exactModelId(args.resolvedModelId)
  const effective = resolved || requested
  if (effective !== OPUS_5_MODEL_ID) {
    return {
      profile: null,
      reason: args.frozen ? 'frozen-profile-mismatch' : 'model-not-target',
    }
  }
  return {
    profile: OPUS_5_BEHAVIOR_PROFILE,
    reason: resolved ? 'matched-resolved-model' : 'matched-requested-model',
  }
}

export function opusBehaviorProfileFromId(id: string | null | undefined): OpusBehaviorProfile | null {
  return id === OPUS_5_BEHAVIOR_PROFILE_ID ? OPUS_5_BEHAVIOR_PROFILE : null
}
