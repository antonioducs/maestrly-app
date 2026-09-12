import { subscriptionBaseProviderId } from './chat'

export const SUBAGENT_PROFILE_RULES_VERSION = 1 as const
export const CLAUDE_SUBSCRIPTION_PROVIDER_ID = 'builtin_claude_subscription'

export function isClaudeSubscriptionProfileProvider(providerId: string): boolean {
  return subscriptionBaseProviderId(providerId) === CLAUDE_SUBSCRIPTION_PROVIDER_ID
}

/**
 * Recognizes the Claude Code alias and concrete IDs for the Fable family.
 * Provider-qualified IDs are supported by comparing only their basename.
 */
export function isClaudeFableModelId(modelId: string): boolean {
  const basename = modelId.split('/').pop()?.trim() ?? ''
  return (
    /^fable(?:\[(?:1|2)m\])?$/i.test(basename) ||
    /^claude-fable-5(?:-\d+)*(?:-v\d+(?::\d+)?)?(?:\[(?:1|2)m\])?$/i.test(basename)
  )
}

/** True when an explicit Fable ID is not exposed by the authenticated Claude account catalog. */
export function isUnavailableClaudeFable(
  providerId: string,
  modelId: string,
  catalogModels: readonly string[]
): boolean {
  return (
    isClaudeSubscriptionProfileProvider(providerId) &&
    isClaudeFableModelId(modelId) &&
    !catalogModels.some(isClaudeFableModelId)
  )
}

export interface SubagentProfileCandidate {
  providerId: string
  modelId: string
  /** Includes legacy `off` and model-native efforts such as `ultra`; Maestrly Ultra uses a namespaced sentinel. */
  effort: string
  /** Explicit candidate speed: absent/false means Standard; true means Fast. Parent inheritance is resolved separately. */
  fastMode?: boolean
}

export interface SubagentProfileRulesV1 {
  version: typeof SUBAGENT_PROFILE_RULES_VERSION
  default?: SubagentProfileCandidate[]
  byCategory?: Record<string, SubagentProfileCandidate[]>
  byAgent?: Record<string, SubagentProfileCandidate[]>
}

export type SubagentProfileSource =
  | 'maestro-resource'
  | 'conversation-agent'
  | 'conversation-category'
  | 'conversation-default'
  | 'global-agent'
  | 'global-category'
  | 'global-default'
  | 'frontmatter'
  | 'parent'

export type SubagentProfileDiagnosticCode =
  | 'config-corrupt'
  | 'invalid-structure'
  | 'incomplete-frontmatter'
  | 'provider-missing'
  | 'provider-unsupported'
  | 'provider-disconnected'
  | 'no-key'
  | 'model-not-found'
  | 'model-unavailable'
  | 'catalog-unavailable'
  | 'invalid-effort'
  | 'effort-unverified'
  | 'fast-mode-unsupported'
  | 'fast-mode-unverified'
  | 'fallback-selected'
  | 'parent-profile-invalid'
  | 'agent-not-found'

export interface SubagentProfileDiagnostic {
  code: SubagentProfileDiagnosticCode
  message: string
  severity: 'warning' | 'error'
}

export interface SubagentProfileAttempt {
  source: SubagentProfileSource
  ruleKey?: string
  candidateIndex: number
  candidate: SubagentProfileCandidate
  outcome: 'selected' | 'rejected'
  diagnostics: SubagentProfileDiagnostic[]
}

export interface SubagentEffectiveProfile {
  providerId: string
  modelId: string
  configuredEffort: string
  sentEffort: string | null
  /** Effective execution speed frozen with the profile snapshot; absent only on legacy snapshots. */
  fastMode?: boolean
  source: SubagentProfileSource
  ruleKey?: string
  candidateIndex: number
}

export interface SubagentExecutionSnapshotV1 {
  version: typeof SUBAGENT_PROFILE_RULES_VERSION
  agentName: string
  category?: string
  effective: SubagentEffectiveProfile | null
  attempts: SubagentProfileAttempt[]

  diagnostics?: SubagentProfileDiagnostic[]
}

export interface SubagentAgentDto {
  name: string
  description: string
  category?: string
  source: string

  virtual?: boolean
  baseAgentName?: string
}

export interface SubagentProfileCatalog {
  agents: SubagentAgentDto[]
  categories: string[]
}

export interface SubagentProfileModelCatalogResult {
  status: 'available' | 'unavailable'
  models: string[]
}

export interface SubagentProfileConfigPayload {
  rules: SubagentProfileRulesV1 | null
  diagnostics: SubagentProfileDiagnostic[]
}

export interface ConversationSubagentProfileConfigPayload extends SubagentProfileConfigPayload {
  enabled: boolean

  subagentsEnabled: boolean
}

export type SubagentProfileSaveResult =
  | { ok: true; value: SubagentProfileConfigPayload }
  | { ok: false; errors: SubagentProfileDiagnostic[] }

export type ConversationSubagentProfileSaveResult =
  | { ok: true; value: ConversationSubagentProfileConfigPayload }
  | { ok: false; errors: SubagentProfileDiagnostic[] }

/** Normalizes logical agent/category keys for deterministic, case-insensitive matching and persistence. */
export function normalizeSubagentProfileKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
