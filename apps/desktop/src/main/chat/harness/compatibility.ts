import { createHash } from 'node:crypto'
import { INVALID_HARNESS_SNAPSHOT, type HarnessSnapshotState, type HarnessSnapshotV1 } from '../../../shared/harness'
import type { HarnessCompatibilityResult, ResolvedHarness } from './types'

type Canonical = string | number | boolean | null | Canonical[] | { [key: string]: Canonical }

/** Deterministic serialization: sorted keys, no timestamps, no locale and no undefined holes. */
export function canonicalize(value: unknown): Canonical {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return normalizeLineEndings(value)
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value instanceof Map) {
    return Object.fromEntries([...value.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [String(k), canonicalize(v)]))
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return Object.fromEntries(entries.map(([key, entry]) => [key, canonicalize(entry)]))
  }
  return String(value)
}

/** CRLF and a trailing newline must not change a contract hash. */
function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\n+$/, '')
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/**
 * Contract hash of an execution. It covers the effective policies, the applied strategies and the
 * referenced texts, so forgetting to bump `profileVersion` still invalidates a saved session.
 */
export function harnessDefinitionHash(input: {
  profileId: string
  contractId: string
  identity: unknown
  prompts: unknown
  reasoning: unknown
  runtime: unknown
  progress: unknown
  hooks: unknown
  capabilities: unknown
}): string {
  return hashCanonical(input)
}

export function createHarnessSnapshot(harness: ResolvedHarness): HarnessSnapshotV1 {
  return Object.freeze({
    snapshotVersion: 1,
    profileId: harness.profileId,
    profileVersion: harness.profileVersion,
    contractId: harness.contractId,
    compatibilityGroup: harness.identity.compatibilityGroup,
    definitionHash: harness.definitionHash,
  })
}

/**
 * Compares a persisted contract with the current one. A missing snapshot is reported as legacy so
 * callers can apply their own transport-specific legacy proof instead of assuming a match.
 */
export function compareHarnessCompatibility(
  saved: HarnessSnapshotV1 | null,
  current: ResolvedHarness
): HarnessCompatibilityResult {
  if (!saved) return { compatible: false, reason: 'legacy-missing-snapshot' }
  if (saved.profileId !== current.profileId) return { compatible: false, reason: 'profile-changed' }
  if (saved.profileVersion !== current.profileVersion) return { compatible: false, reason: 'version-changed' }
  if (saved.contractId !== current.contractId) return { compatible: false, reason: 'contract-changed' }
  if (saved.compatibilityGroup !== current.identity.compatibilityGroup) {
    return { compatible: false, reason: 'contract-changed' }
  }
  if (saved.definitionHash !== current.definitionHash) return { compatible: false, reason: 'definition-changed' }
  return { compatible: true, reason: 'match' }
}

/**
 * Resume gate layered over each transport's existing checks (account, tools, instructions, anchor).
 * A row without a snapshot predates the contract: only the legacy transport proof applies, and the
 * caller keeps it. A recorded snapshot must match the current contract exactly.
 */
export function snapshotAllowsResume(saved: HarnessSnapshotState, current: ResolvedHarness): boolean {
  return saved !== INVALID_HARNESS_SNAPSHOT && (saved == null || compareHarnessCompatibility(saved, current).compatible)
}
