/**
 * Serializable harness contracts shared by main and renderer.
 *
 * This module is intentionally free of the profile catalog, prompts, SDKs, Electron and the
 * filesystem: the renderer must be able to reason about the active execution without importing
 * main-side code or prompt text.
 */

/** Capability axis of a harness. Names mirror the model manifest, never raw SDK arguments. */
export interface HarnessCapabilities {
  responsesTools: boolean
  persistedReasoning: boolean
  encryptedReasoning: boolean
  reasoningContext: boolean
  compaction: boolean
  parallelTools: boolean
  steering: boolean
  asyncTools: boolean
  configurationUpdates: boolean
  experimentalContext: boolean
}

export const HARNESS_CAPABILITY_NAMES = [
  'responsesTools',
  'persistedReasoning',
  'encryptedReasoning',
  'reasoningContext',
  'compaction',
  'parallelTools',
  'steering',
  'asyncTools',
  'configurationUpdates',
  'experimentalContext',
] as const satisfies readonly (keyof HarnessCapabilities)[]

export type HarnessCapabilityName = (typeof HARNESS_CAPABILITY_NAMES)[number]

/** Runtime/adapter claims. An explicit `false` always wins over a permissive manifest. */
export type HarnessCapabilityClaims = Partial<Record<HarnessCapabilityName, boolean>>

export const NO_HARNESS_CAPABILITIES: Readonly<HarnessCapabilities> = Object.freeze(
  Object.fromEntries(HARNESS_CAPABILITY_NAMES.map((name) => [name, false]))
) as Readonly<HarnessCapabilities>

/**
 * Validated, extensible profile identity. It exists for diagnostics and persistence, never for
 * authorization: the renderer must consult effective capabilities instead of comparing identities.
 */
export type HarnessProfileIdentity = string

const IDENTITY_PATTERN = /^[a-z0-9][a-z0-9._@-]{0,95}$/

export function isHarnessProfileIdentity(value: unknown): value is HarnessProfileIdentity {
  return typeof value === 'string' && IDENTITY_PATTERN.test(value)
}

/** Reasoning values the interface uses to clear an override; they are never sent as provider effort. */
export const HARNESS_REASONING_RESETS = ['off', 'default'] as const

export function isHarnessReasoningReset(effort: string | null | undefined): boolean {
  return effort === 'off' || effort === 'default'
}

/**
 * Persisted contract identity of an execution. It carries no prompt text, credential or closure:
 * enough to prove a saved session still matches the harness that created it.
 */
export interface HarnessSnapshotV1 {
  snapshotVersion: 1
  profileId: HarnessProfileIdentity
  profileVersion: number
  /** Transport binding actually applied (`providerKind/endpoint`). */
  contractId: string
  compatibilityGroup: string
  /** Canonical hash of the effective definition: policies, strategies and referenced texts. */
  definitionHash: string
}

/** A non-NULL snapshot column whose contents could not be validated; it must never pass a resume gate. */
export const INVALID_HARNESS_SNAPSHOT = Symbol('invalid-harness-snapshot')

export type HarnessSnapshotState = HarnessSnapshotV1 | null | typeof INVALID_HARNESS_SNAPSHOT

export function parseHarnessSnapshot(value: unknown): HarnessSnapshotV1 | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.snapshotVersion !== 1) return null
  if (!isHarnessProfileIdentity(record.profileId)) return null
  if (typeof record.profileVersion !== 'number' || !Number.isSafeInteger(record.profileVersion)) return null
  if (typeof record.contractId !== 'string' || !record.contractId) return null
  if (typeof record.compatibilityGroup !== 'string' || !record.compatibilityGroup) return null
  if (typeof record.definitionHash !== 'string' || !record.definitionHash) return null
  return {
    snapshotVersion: 1,
    profileId: record.profileId,
    profileVersion: record.profileVersion,
    contractId: record.contractId,
    compatibilityGroup: record.compatibilityGroup,
    definitionHash: record.definitionHash,
  }
}

export function readHarnessSnapshotJson(value: string | null | undefined): HarnessSnapshotState {
  if (value == null) return null
  try {
    return parseHarnessSnapshot(JSON.parse(value)) ?? INVALID_HARNESS_SNAPSHOT
  } catch {
    return INVALID_HARNESS_SNAPSHOT
  }
}

/**
 * Live controls published by main for the active execution. Without a running turn every field is
 * false/empty so the interface can never act on a stale capability.
 */
export interface HarnessTurnControls {
  midTurnSteering: boolean
  liveReasoningUpdate: boolean
  /** Efforts the active execution accepts for a live change. Empty when unknown or unsupported. */
  liveReasoningEfforts: readonly string[]
  /** Whether the active execution accepts clearing the effort back to the provider default. */
  liveReasoningReset: boolean
}

export const NO_HARNESS_TURN_CONTROLS: Readonly<HarnessTurnControls> = Object.freeze({
  midTurnSteering: false,
  liveReasoningUpdate: false,
  liveReasoningEfforts: Object.freeze([]) as readonly string[],
  liveReasoningReset: false,
})
