import type { ChatProviderKind } from '../../shared/chat'

export type ModelHarnessProfileId =
  | 'openai-default-v1'
  | 'openai-gpt-5.6-sol-v1'
  | 'openai-gpt-6-astra-v1'

export const OPENAI_DEFAULT_MODEL_HARNESS_PROFILE = 'openai-default-v1' as const
export const OPENAI_GPT56_SOL_MODEL_HARNESS_PROFILE = 'openai-gpt-5.6-sol-v1' as const
export const OPENAI_GPT6_ASTRA_MODEL_HARNESS_PROFILE = 'openai-gpt-6-astra-v1' as const
export const OPENAI_GPT6_ASTRA_PROMPT_PROFILE = 'maestrly-openai-gpt-6-astra@v1' as const

export interface ModelCapabilities {
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

export type ModelCapabilityName = keyof ModelCapabilities

/** Runtime catalog claims. An explicit false always wins over the local manifest. */
export type RuntimeModelCapabilities = Partial<Record<ModelCapabilityName, boolean>>

/** What the currently selected transport/session can actually execute. */
export interface RuntimeHarnessCapabilities extends ModelCapabilities {
  validReasoningEfforts: readonly string[]
}

export interface ModelHarnessManifestEntry {
  id: ModelHarnessProfileId
  version: 1
  modelId: string
  providerKinds: readonly ChatProviderKind[]
  promptProfile: typeof OPENAI_GPT6_ASTRA_PROMPT_PROFILE
  capabilities: Readonly<ModelCapabilities>
  validReasoningEfforts: readonly string[]
  nonSerializableReasoningEfforts: readonly string[]
}

const ASTRA_CAPABILITIES: Readonly<ModelCapabilities> = Object.freeze({
  responsesTools: true,
  persistedReasoning: true,
  encryptedReasoning: true,
  reasoningContext: true,
  compaction: true,
  parallelTools: true,
  steering: true,
  asyncTools: true,
  configurationUpdates: true,
  experimentalContext: true,
})

export const OPENAI_GPT6_ASTRA_MANIFEST: ModelHarnessManifestEntry = Object.freeze({
  id: OPENAI_GPT6_ASTRA_MODEL_HARNESS_PROFILE,
  version: 1,
  modelId: 'gpt-6-astra',
  providerKinds: ['openai-responses', 'codex-subscription'] as const,
  promptProfile: OPENAI_GPT6_ASTRA_PROMPT_PROFILE,
  capabilities: ASTRA_CAPABILITIES,
  validReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const,
  nonSerializableReasoningEfforts: ['none', 'minimal'] as const,
})

const NO_ADAPTER_CAPABILITIES: Readonly<ModelCapabilities> = Object.freeze({
  responsesTools: false,
  persistedReasoning: false,
  encryptedReasoning: false,
  reasoningContext: false,
  compaction: false,
  parallelTools: false,
  steering: false,
  asyncTools: false,
  configurationUpdates: false,
  experimentalContext: false,
})

export interface ResolveModelHarnessProfileInput {
  providerKind: ChatProviderKind
  modelId: string
  baseURL?: string
  astraHarnessEnabled?: boolean
  runtimeModelCapabilities?: RuntimeModelCapabilities
  adapterCapabilities?: RuntimeModelCapabilities
  runtimeReasoningEfforts?: readonly string[]
}

export interface ResolvedModelHarnessProfile {
  id: ModelHarnessProfileId
  compatibilityKey: 'openai-current-v1' | 'openai-gpt-6-astra-v1'
  promptProfile: 'maestrly-openai-generic-v1' | typeof OPENAI_GPT6_ASTRA_PROMPT_PROFILE
  manifest: ModelHarnessManifestEntry | null
  modelCapabilities: ModelCapabilities
  adapterCapabilities: ModelCapabilities
  capabilities: RuntimeHarnessCapabilities
}

function officialOpenAIEndpoint(baseURL: string | undefined): boolean {
  if (!baseURL) return false
  try {
    const parsed = new URL(baseURL)
    return parsed.protocol === 'https:' && parsed.host.toLowerCase() === 'api.openai.com'
  } catch {
    return false
  }
}

function capabilitySet(
  fallback: Readonly<ModelCapabilities>,
  overrides: RuntimeModelCapabilities | undefined
): ModelCapabilities {
  return Object.fromEntries(
    (Object.keys(fallback) as ModelCapabilityName[]).map((key) => [
      key,
      typeof overrides?.[key] === 'boolean' ? overrides[key] : fallback[key],
    ])
  ) as unknown as ModelCapabilities
}

function effectiveCapabilities(
  model: Readonly<ModelCapabilities>,
  adapter: Readonly<ModelCapabilities>,
  efforts: readonly string[]
): RuntimeHarnessCapabilities {
  return {
    ...Object.fromEntries(
      (Object.keys(model) as ModelCapabilityName[]).map((key) => [key, model[key] && adapter[key]])
    ) as unknown as ModelCapabilities,
    validReasoningEfforts: efforts,
  }
}

function defaultResolution(): ResolvedModelHarnessProfile {
  const disabled = { ...NO_ADAPTER_CAPABILITIES }
  return {
    id: OPENAI_DEFAULT_MODEL_HARNESS_PROFILE,
    compatibilityKey: 'openai-current-v1',
    promptProfile: 'maestrly-openai-generic-v1',
    manifest: null,
    modelCapabilities: disabled,
    adapterCapabilities: { ...disabled },
    capabilities: { ...disabled, validReasoningEfforts: [] },
  }
}

/** Exact, versioned model-profile resolution. Unknown IDs and custom gateways fail closed. */
export function resolveModelHarnessProfile(input: ResolveModelHarnessProfileInput): ResolvedModelHarnessProfile {
  const normalizedModelId = input.modelId.trim().toLowerCase()
  if (
    input.providerKind === 'openai-responses' &&
    officialOpenAIEndpoint(input.baseURL) &&
    normalizedModelId === 'gpt-5.6-sol'
  ) {
    return { ...defaultResolution(), id: OPENAI_GPT56_SOL_MODEL_HARNESS_PROFILE }
  }
  const allowedProvider =
    input.providerKind === 'codex-subscription' ||
    (input.providerKind === 'openai-responses' && officialOpenAIEndpoint(input.baseURL))
  if (
    input.astraHarnessEnabled === false ||
    normalizedModelId !== OPENAI_GPT6_ASTRA_MANIFEST.modelId ||
    !allowedProvider
  ) {
    return defaultResolution()
  }

  const model = capabilitySet(OPENAI_GPT6_ASTRA_MANIFEST.capabilities, input.runtimeModelCapabilities)
  const adapter = capabilitySet(NO_ADAPTER_CAPABILITIES, input.adapterCapabilities)
  const publishedEfforts = input.runtimeReasoningEfforts
    ? input.runtimeReasoningEfforts.filter(
        (effort) =>
          OPENAI_GPT6_ASTRA_MANIFEST.validReasoningEfforts.includes(effort) &&
          !OPENAI_GPT6_ASTRA_MANIFEST.nonSerializableReasoningEfforts.includes(effort)
      )
    : [...OPENAI_GPT6_ASTRA_MANIFEST.validReasoningEfforts]

  return {
    id: OPENAI_GPT6_ASTRA_MODEL_HARNESS_PROFILE,
    compatibilityKey: OPENAI_GPT6_ASTRA_MODEL_HARNESS_PROFILE,
    promptProfile: OPENAI_GPT6_ASTRA_PROMPT_PROFILE,
    manifest: OPENAI_GPT6_ASTRA_MANIFEST,
    modelCapabilities: model,
    adapterCapabilities: adapter,
    capabilities: effectiveCapabilities(model, adapter, publishedEfforts),
  }
}

export function isAstraHarnessProfile(
  profile: ModelHarnessProfileId | Pick<ResolvedModelHarnessProfile, 'id'> | null | undefined
): boolean {
  return (typeof profile === 'string' ? profile : profile?.id) === OPENAI_GPT6_ASTRA_MODEL_HARNESS_PROFILE
}

export function serializableReasoningEffortForProfile(
  profile: ModelHarnessProfileId,
  effort: string | null | undefined
): string | null {
  if (!effort || effort === 'off' || effort === 'default') return null
  if (profile !== OPENAI_GPT6_ASTRA_MODEL_HARNESS_PROFILE) return effort
  return OPENAI_GPT6_ASTRA_MANIFEST.validReasoningEfforts.includes(effort) &&
    !OPENAI_GPT6_ASTRA_MANIFEST.nonSerializableReasoningEfforts.includes(effort)
    ? effort
    : null
}
