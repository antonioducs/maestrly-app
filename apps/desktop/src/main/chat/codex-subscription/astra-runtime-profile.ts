import {
  OPENAI_GPT6_ASTRA_MODEL_HARNESS_PROFILE,
  resolveModelHarnessProfile,
  serializableReasoningEffortForProfile,
  type ModelHarnessProfileId,
  type ModelCapabilities,
  type RuntimeHarnessCapabilities,
} from '../model-harness-profile'
import type { CodexSubscriptionModel } from './manager'

export const ASTRA_CODEX_PROMPT_VERSION = 'astra-codex-host-v1' as const

export interface AstraCodexThreadProfile {
  modelHarnessProfileId: ModelHarnessProfileId
  promptVersion: 'codex-current-v1' | typeof ASTRA_CODEX_PROMPT_VERSION
  isAstra: boolean
  capabilities: RuntimeHarnessCapabilities
  modelCapabilities: ModelCapabilities
  adapterCapabilities: ModelCapabilities
  nativeCompactionFirst: boolean
  experimentalContextEnabled: boolean
  personality: 'pragmatic' | undefined
  reasoningEffort: string | null
  asyncQuestionGuidance: boolean
}

export interface BuildAstraCodexThreadProfileInput {
  modelId: string
  model?: Partial<CodexSubscriptionModel> | null
  astraHarnessEnabled: boolean
  eligibleChatGptSession: boolean
  ephemeral: boolean
  reviewer: boolean
  requestUserInputAsyncAvailable: boolean
  turnSteerAvailable?: boolean
  turnSettingsUpdateAvailable?: boolean
  reasoningEffort?: string
  experimentalContextFallbackDisabled?: boolean
}

/** Resolve the Astra model manifest against catalog and app-server session capabilities. */
export function buildAstraCodexThreadProfile(input: BuildAstraCodexThreadProfileInput): AstraCodexThreadProfile {
  const runtime = resolveModelHarnessProfile({
    providerKind: 'codex-subscription',
    modelId: input.modelId,
    astraHarnessEnabled: input.astraHarnessEnabled,
    runtimeModelCapabilities: {
      ...(input.model?.supportsExperimentalContext !== null &&
      input.model?.supportsExperimentalContext !== undefined
        ? { experimentalContext: input.model.supportsExperimentalContext }
        : {}),
      ...(input.model?.supportsParallelToolCalls !== null &&
      input.model?.supportsParallelToolCalls !== undefined
        ? { parallelTools: input.model.supportsParallelToolCalls }
        : {}),
    },
    adapterCapabilities: {
      responsesTools: true,
      persistedReasoning: true,
      encryptedReasoning: true,
      reasoningContext: true,
      compaction: true,
      parallelTools: true,
      steering: input.turnSteerAvailable !== false,
      asyncTools: input.requestUserInputAsyncAvailable,
      configurationUpdates: input.turnSettingsUpdateAvailable !== false,
      experimentalContext: true,
    },
    runtimeReasoningEfforts: input.model?.supportedReasoningEfforts?.map((entry) => entry.reasoningEffort),
  })
  const isAstra = runtime.id === OPENAI_GPT6_ASTRA_MODEL_HARNESS_PROFILE
  const experimentalContextEnabled = Boolean(
    isAstra &&
      runtime.capabilities.experimentalContext &&
      input.eligibleChatGptSession &&
      !input.ephemeral &&
      !input.reviewer &&
      !input.experimentalContextFallbackDisabled
  )
  const serializableEffort = serializableReasoningEffortForProfile(runtime.id, input.reasoningEffort)
  return {
    modelHarnessProfileId: runtime.id,
    promptVersion: isAstra ? ASTRA_CODEX_PROMPT_VERSION : 'codex-current-v1',
    isAstra,
    capabilities: runtime.capabilities,
    modelCapabilities: runtime.modelCapabilities,
    adapterCapabilities: runtime.adapterCapabilities,
    nativeCompactionFirst: isAstra && runtime.capabilities.compaction,
    experimentalContextEnabled,
    personality: isAstra ? undefined : 'pragmatic',
    reasoningEffort: !isAstra
      ? serializableEffort
      : serializableEffort && runtime.capabilities.validReasoningEfforts.includes(serializableEffort)
        ? serializableEffort
        : null,
    asyncQuestionGuidance: isAstra && runtime.capabilities.asyncTools && input.requestUserInputAsyncAvailable,
  }
}

export function astraDeveloperInstructions(base: string, profile: AstraCodexThreadProfile): string {
  if (!profile.isAstra) return base
  const asyncGuidance = profile.asyncQuestionGuidance
    ? ' The runtime exposes request_user_input_async for non-blocking questions; its input is text-only.'
    : ''
  return (
    'Use the native Astra operating prompt. Apply only these Maestrly host contracts: explicit user and host ' +
    'instructions outrank non-mandatory skill guidance; complete authorized work autonomously; communicate ' +
    'directly with proportional formatting; delegate only through Maestrly task, using parallel task calls when ' +
    'useful; and verify in proportion to risk. Native multi-agent tools are disabled.' +
    asyncGuidance +
    '\n\n' +
    base
  )
}
