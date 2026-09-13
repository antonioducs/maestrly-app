import type { ChatProviderKind } from '../../../shared/chat'
import type { ChatBehavior } from '../../../shared/conversation-experience'
import type { HarnessCapabilities, HarnessCapabilityClaims, HarnessSnapshotV1 } from '../../../shared/harness'

/** Only one schema version is accepted at a time; a config declaring another version is an error. */
export const HARNESS_SCHEMA_VERSION = 1

/** The folder `default` carries the complete base policy and is mandatory. */
export const DEFAULT_HARNESS_PROFILE_ID = 'default'

/** Finite prompt composition strategies. They know slots, never model names. */
export const HARNESS_PROMPT_LAYOUTS = ['maestrly-base', 'openai-codex-port', 'openai-astra'] as const
export type HarnessPromptLayout = (typeof HARNESS_PROMPT_LAYOUTS)[number]

/** Where the volatile environment block is placed for a transport that offers a choice. */
export const HARNESS_ENVIRONMENT_PLACEMENTS = ['system', 'last-user-message'] as const
export type HarnessEnvironmentPlacement = (typeof HARNESS_ENVIRONMENT_PLACEMENTS)[number]

/** Progress reporting contract already supported by the runners. */
export const HARNESS_PROGRESS_MODES = ['default', 'summarized', 'prompt-only'] as const
export type HarnessProgressMode = (typeof HARNESS_PROGRESS_MODES)[number]

/** Executable strategies implemented in TypeScript and referenced by id from configuration. */
export const HARNESS_HOOK_STRATEGIES = ['post-tool-read-guidance'] as const
export type HarnessHookStrategy = (typeof HARNESS_HOOK_STRATEGIES)[number]

export const HARNESS_ENDPOINT_KINDS = ['any', 'official-openai'] as const
export type HarnessEndpointKind = (typeof HARNESS_ENDPOINT_KINDS)[number]

export type HarnessProviderSelector = ChatProviderKind | '*'

export const HARNESS_MODES = ['agent', 'ask', 'plan', 'design', 'maestro'] as const

/** Markdown reference relative to the profile folder. */
export type HarnessTextRef = string

export interface HarnessUltraRefs {
  base: HarnessTextRef
  byMode: Readonly<Record<ChatBehavior, HarnessTextRef>>
}

export interface HarnessPromptOverrides {
  layout?: HarnessPromptLayout
  /** Base instructions consumed by the `openai-*` layouts. */
  base?: HarnessTextRef | null
  /** Style/work body replacing the default host style sections in the Maestrly layouts. */
  styleAndWork?: HarnessTextRef | null
  /** Emit the versioned behavioral-profile header before the style body. */
  behaviorHeader?: boolean
  subagent?: HarnessTextRef | null
  compaction?: HarnessTextRef | null
  ultra?: HarnessUltraRefs | null
  /** Host contract prefix for transports that carry developer instructions separately. */
  developerPrefix?: { base: HarnessTextRef; asyncTools?: HarnessTextRef } | null
  environment?: {
    placement?: HarnessEnvironmentPlacement
    /** Deliver the environment as per-turn transient context instead of the cached prompt. */
    transient?: boolean
  }
}

export interface HarnessReasoningOverrides {
  /**
   * Efforts the profile declares. `null` means the profile publishes no manifest and the runtime
   * catalog stays authoritative; an empty array means the profile explicitly allows none.
   */
  manifestEfforts?: readonly string[] | null
  nonSerializableEfforts?: readonly string[]
  /** The provider publishes a native maximum-effort tier; never add the synthetic Ultra overlay. */
  nativeUltra?: boolean
}

export interface HarnessRuntimeOverrides {
  promptCacheTtl?: '30m' | null
  personality?: 'pragmatic' | null
  nativeCompactionFirst?: boolean
  /** Ask the transport for experimental context when every eligibility fact allows it. */
  experimentalContext?: boolean
  /** Versioned host prompt contract recorded by the Codex transport. */
  codexPromptVersion?: string
}

export interface HarnessIdentityOverrides {
  /** Versioned model-harness identity persisted by the OpenAI transports. */
  harnessProfileId?: string
  /** Legacy Claude behavior-profile identity persisted in frozen selections and session handles. */
  behaviorProfileId?: string | null
  compatibilityGroup?: string
  /** Prompt template identity: an axis independent from transport and compatibility. */
  promptIdentity?: string
}

export interface HarnessHookOverride {
  id: HarnessHookStrategy
  text: HarnessTextRef
  maxReminders?: number
}

export interface HarnessOverrides {
  identity?: HarnessIdentityOverrides
  prompts?: HarnessPromptOverrides
  reasoning?: HarnessReasoningOverrides
  capabilities?: HarnessCapabilityClaims
  runtime?: HarnessRuntimeOverrides
  progress?: HarnessProgressMode
  hooks?: readonly HarnessHookOverride[]
}

export interface HarnessBinding {
  providerKind: HarnessProviderSelector
  endpoint?: HarnessEndpointKind
  overrides: HarnessOverrides
}

export interface HarnessSourceProvenance {
  repository: string
  commit: string
  /** Upstream model the template belongs to; provenance only, never a matching rule. */
  model?: string
  path: string
  sourceUrl?: string
  license: string
  upstreamSha256?: string
  adaptedSha256?: string
  adaptations?: readonly string[]
}

export interface HarnessMatch {
  /** Extra exact identities besides the folder name. */
  aliases?: readonly string[]
  /** Only where the current behavior already normalizes case for this model. */
  caseInsensitive?: boolean
}

export interface HarnessDefinition {
  schemaVersion: typeof HARNESS_SCHEMA_VERSION
  id: string
  profileVersion: number
  match?: HarnessMatch
  featureFlag?: { key: string; default: boolean }
  bindings: readonly HarnessBinding[]
  source?: HarnessSourceProvenance
}

/** A validated profile: definition plus the Markdown bodies of its own folder. */
export interface HarnessProfile {
  /** Folder name; the primary model identity of the profile. */
  folderId: string
  definition: HarnessDefinition
  /** Frozen Markdown bodies of this folder, keyed by file name. */
  texts: Readonly<Record<string, string>>
}

/** Relative path (`profiles/<folder>/<file>`) to file contents. */
export type HarnessSources = Readonly<Record<string, string>>

export interface HarnessRegistry {
  readonly default: HarnessProfile
  get(folderId: string): HarnessProfile | null
  /** Exact identity lookup honoring each profile's own normalization. */
  match(modelId: string): HarnessProfile | null
  list(): readonly HarnessProfile[]
}

export type HarnessResolutionReason =
  | 'default'
  | 'matched-requested-model'
  | 'matched-resolved-model'
  | 'matched-alias'
  | 'disabled'
  | 'unsupported-transport'
  | 'unsupported-endpoint'
  | 'frozen-legacy'
  | 'frozen-profile'

export interface ResolvedUltraGuidance {
  base: string
  byMode: Readonly<Record<ChatBehavior, string>>
}

export interface ResolvedHarnessPrompts {
  layout: HarnessPromptLayout
  base: string | null
  styleAndWork: string | null
  behaviorHeader: boolean
  subagent: string | null
  compaction: string | null
  ultra: ResolvedUltraGuidance | null
  developerPrefix: { base: string; asyncTools: string | null } | null
  environment: { placement: HarnessEnvironmentPlacement; transient: boolean }
}

export interface ResolvedReasoningPolicy {
  /** `null` when the profile publishes no manifest: the runtime catalog stays authoritative. */
  manifestEfforts: readonly string[] | null
  nonSerializableEfforts: readonly string[]
  nativeUltra: boolean
  /** Efforts this execution may actually send, after intersecting runtime and manifest. */
  effectiveEfforts: readonly string[]
}

export interface ResolvedHarnessHook {
  id: HarnessHookStrategy
  text: string
  maxReminders: number
}

export interface ResolvedHarnessIdentity {
  harnessProfileId: string
  behaviorProfileId: string | null
  compatibilityGroup: string
  promptIdentity: string
}

export interface ResolvedHarnessRuntime {
  promptCacheTtl: '30m' | null
  personality: 'pragmatic' | null
  nativeCompactionFirst: boolean
  experimentalContext: boolean
  codexPromptVersion: string
}

export interface ResolvedHarness {
  profileId: string
  profileVersion: number
  reason: HarnessResolutionReason
  /** `providerKind/endpoint` binding actually applied. */
  contractId: string
  identity: ResolvedHarnessIdentity
  prompts: ResolvedHarnessPrompts
  reasoning: ResolvedReasoningPolicy
  /** Model/profile claims before the adapter intersection. */
  modelCapabilities: HarnessCapabilities
  /** What the selected transport can actually execute. */
  adapterCapabilities: HarnessCapabilities
  /** Effective capabilities: profile AND runtime AND adapter. */
  capabilities: HarnessCapabilities
  runtime: ResolvedHarnessRuntime
  progress: HarnessProgressMode
  hooks: readonly ResolvedHarnessHook[]
  source: HarnessSourceProvenance | null
  definitionHash: string
}

export type HarnessResolution =
  | { ok: true; harness: ResolvedHarness }
  | { ok: false; reason: 'frozen-profile-mismatch' | 'frozen-snapshot-mismatch' }

export interface ResolveHarnessInput {
  providerKind: ChatProviderKind
  requestedModelId: string
  /** Canonical identity confirmed by the transport. Authoritative over the requested alias. */
  resolvedModelId?: string | null
  /** Validated endpoint fact; never derived from a model name. */
  officialOpenAIEndpoint?: boolean
  /** Flags captured at admission. Absent keys use each profile's declared default. */
  flags?: Readonly<Record<string, boolean>>
  /** Catalog/runtime claims about the model. */
  runtimeCapabilities?: HarnessCapabilityClaims
  /** What the transport adapter actually implements. */
  adapterCapabilities?: HarnessCapabilityClaims
  /** Efforts published by the runtime. `undefined`/`null` means unknown, `[]` means none. */
  runtimeReasoningEfforts?: readonly string[] | null
  frozen?: boolean
  /** Legacy behavioral identity persisted before the snapshot contract. */
  frozenBehaviorProfileId?: string | null
  frozenSnapshot?: HarnessSnapshotV1 | null
  /**
   * Copilot supplies a normalized base name that may select the textual axis only. It never becomes
   * canonical evidence for advanced policies.
   */
  promptAxisOnly?: boolean
}

export interface HarnessCompatibilityResult {
  compatible: boolean
  reason:
    | 'match'
    | 'legacy-missing-snapshot'
    | 'profile-changed'
    | 'version-changed'
    | 'contract-changed'
    | 'definition-changed'
}

export type { ChatBehavior, ChatProviderKind, HarnessCapabilities, HarnessCapabilityClaims, HarnessSnapshotV1 }
