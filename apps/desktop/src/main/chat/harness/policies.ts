import {
  HARNESS_CAPABILITY_NAMES,
  isHarnessReasoningReset,
  type HarnessCapabilities,
  type HarnessCapabilityClaims,
} from '../../../shared/harness'
import type { ResolvedReasoningPolicy } from './types'

/** Applies claims over a baseline. Only an explicit boolean overrides; absence inherits. */
export function applyCapabilityClaims(
  baseline: Readonly<HarnessCapabilities>,
  claims: HarnessCapabilityClaims | undefined
): HarnessCapabilities {
  const result = {} as HarnessCapabilities
  for (const name of HARNESS_CAPABILITY_NAMES) {
    result[name] = typeof claims?.[name] === 'boolean' ? claims[name] : baseline[name]
  }
  return result
}

/** Effective capability: the profile/runtime claim AND what the adapter actually implements. */
export function intersectCapabilities(
  model: Readonly<HarnessCapabilities>,
  adapter: Readonly<HarnessCapabilities>
): HarnessCapabilities {
  const result = {} as HarnessCapabilities
  for (const name of HARNESS_CAPABILITY_NAMES) result[name] = model[name] && adapter[name]
  return result
}

export interface ResolveReasoningInput {
  manifestEfforts: readonly string[] | null
  nonSerializableEfforts: readonly string[]
  nativeUltra: boolean
  /** `undefined`/`null` means the runtime published nothing; `[]` means it published none. */
  runtimeEfforts?: readonly string[] | null
}

/**
 * Single source for reasoning capability. Without a manifest the runtime catalog is authoritative;
 * with one, the published list is the intersection minus the non-serializable tiers.
 */
export function resolveReasoningPolicy(input: ResolveReasoningInput): ResolvedReasoningPolicy {
  const manifest = input.manifestEfforts ? [...input.manifestEfforts] : null
  const nonSerializable = [...input.nonSerializableEfforts]
  const serializable = (effort: string): boolean =>
    (!manifest || manifest.includes(effort)) && !nonSerializable.includes(effort)
  const effective = manifest
    ? input.runtimeEfforts
      ? input.runtimeEfforts.filter(serializable)
      : manifest.filter(serializable)
    : (input.runtimeEfforts?.filter(serializable) ?? [])
  return Object.freeze({
    manifestEfforts: manifest ? Object.freeze(manifest) : null,
    nonSerializableEfforts: Object.freeze(nonSerializable),
    nativeUltra: input.nativeUltra,
    effectiveEfforts: Object.freeze(effective),
  })
}

/**
 * Value actually sent to the provider. Interface resets ('off'/'default') clear the override
 * instead of becoming an effort, and a manifest never serializes a tier it excludes.
 */
export function serializableReasoningEffort(
  policy: Pick<ResolvedReasoningPolicy, 'manifestEfforts' | 'nonSerializableEfforts'>,
  effort: string | null | undefined
): string | null {
  if (!effort || isHarnessReasoningReset(effort)) return null
  if (policy.nonSerializableEfforts.includes(effort)) return null
  if (!policy.manifestEfforts) return effort
  return policy.manifestEfforts.includes(effort) ? effort : null
}
