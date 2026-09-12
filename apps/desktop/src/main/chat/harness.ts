import type { JSONObject } from '@ai-sdk/provider'
import type { ChatProviderKind } from '../../shared/chat'
import {
  OPENAI_GPT6_ASTRA_PROMPT_PROFILE,
  resolveModelHarnessProfile,
  type ModelHarnessProfileId,
  type ResolveModelHarnessProfileInput,
} from './model-harness-profile'

/**
 * Provider HTTP format and agent behavior are separate axes.
 * A GPT served only through Chat Completions stays on the legacy harness; only
 * Responses endpoints receive OpenAI's item-oriented protocol.
 */
export type ChatHarnessProfile = 'legacy' | 'openai-responses-v1'

/** Prompt and protocol are independent axes: Codex selects instructions by model slug. */
export const OPENAI_CODEX_GPT56_SOL_PROMPT_PROFILE = 'codex-gpt-5.6-sol@5bed644' as const
export type ChatPromptProfile =
  | 'maestrly-legacy'
  | 'maestrly-openai-generic-v1'
  | typeof OPENAI_CODEX_GPT56_SOL_PROMPT_PROFILE
  | typeof OPENAI_GPT6_ASTRA_PROMPT_PROFILE

export interface ChatHarnessCapabilities {
  responseItems: boolean
  encryptedReasoning: boolean
  messagePhase: boolean
  strictTools: boolean
  parallelTools: boolean
  promptCacheKey: boolean
  reasoningContext: boolean
  nativeCompaction: boolean
  toolSearch: boolean
  nativeShell: boolean
  nativeApplyPatch: boolean
  websocket: boolean
  midTurnSteering?: boolean
  asyncTools?: boolean
  liveReasoningUpdate?: boolean
  experimentalContext?: boolean
  serializableReasoningEfforts?: readonly string[]
}

export interface ChatHarnessResolution {
  profile: ChatHarnessProfile
  modelHarnessProfileId: ModelHarnessProfileId
  promptProfile: ChatPromptProfile
  capabilities: ChatHarnessCapabilities
}

const LEGACY_CAPABILITIES: ChatHarnessCapabilities = Object.freeze({
  responseItems: false,
  encryptedReasoning: false,
  messagePhase: false,
  strictTools: false,
  parallelTools: false,
  promptCacheKey: false,
  reasoningContext: false,
  nativeCompaction: false,
  toolSearch: false,
  nativeShell: false,
  nativeApplyPatch: false,
  websocket: false,
  midTurnSteering: false,
  asyncTools: false,
  liveReasoningUpdate: false,
  experimentalContext: false,
  serializableReasoningEfforts: [],
})

function isOpenAIReasoningModel(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return /^o(?:1|3|4)(?:-|$)/.test(id) || /^gpt-5(?:[.-]|$)/.test(id)
}

function isOpenAIModelId(modelId: string): boolean {
  const id = modelId.toLowerCase()
  const base = id.startsWith('ft:') ? id.slice(3) : id
  return /^(?:gpt-|chatgpt-|o(?:1|3|4)(?:-|$)|codex(?:-|$))/.test(base)
}

function openAIMinor(modelId: string): number | null {
  const match = /^gpt-5\.(\d+)(?:[.-]|$)/i.exec(modelId)
  return match ? Number(match[1]) : null
}

/**
 * Provider-defined tools are not part of the minimum Responses-compatible
 * contract. In particular, the ChatGPT subscription Codex endpoint rejects
 * `{ type: "apply_patch" }` even though it accepts the rest of the Responses
 * harness. Keep the native tool first-party-only until a provider can declare
 * capabilities explicitly; compatible gateways retain the Maestrly edit/write
 * function tools instead of failing the whole request before inference starts.
 */
function supportsOpenAINativeApplyPatch(baseURL?: string): boolean {
  if (!baseURL) return false
  try {
    return new URL(baseURL).hostname.toLowerCase() === 'api.openai.com'
  } catch {
    return false
  }
}

/**
 * Conservative matrix versioned with the app. Enable advanced features only
 * for known endpoints and models; unknown IDs still receive the
 * basic Responses API ledger, without experimental parameters.
 */
export function resolveChatHarness(
  kind: ChatProviderKind,
  modelId: string,
  baseURL?: string,
  options: Omit<ResolveModelHarnessProfileInput, 'providerKind' | 'modelId' | 'baseURL'> = {}
): ChatHarnessResolution {
  const adapterDefaults =
    kind === 'openai-responses'
      ? {
          responsesTools: true,
          persistedReasoning: true,
          encryptedReasoning: true,
          reasoningContext: true,
          compaction: true,
          parallelTools: true,
          steering: false,
          asyncTools: false,
          configurationUpdates: false,
          experimentalContext: false,
        }
      : options.adapterCapabilities
  const modelProfile = resolveModelHarnessProfile({
    providerKind: kind,
    modelId,
    baseURL,
    ...options,
    adapterCapabilities: options.adapterCapabilities ?? adapterDefaults,
  })
  if (kind !== 'openai-responses' || !isOpenAIModelId(modelId)) {
    return {
      profile: 'legacy',
      modelHarnessProfileId: modelProfile.id,
      promptProfile: kind === 'codex-subscription' ? modelProfile.promptProfile : 'maestrly-legacy',
      capabilities: {
        ...LEGACY_CAPABILITIES,
        midTurnSteering: modelProfile.capabilities.steering,
        asyncTools: modelProfile.capabilities.asyncTools,
        liveReasoningUpdate: modelProfile.capabilities.configurationUpdates,
        experimentalContext: modelProfile.capabilities.experimentalContext,
        serializableReasoningEfforts: modelProfile.capabilities.validReasoningEfforts,
      },
    }
  }

  const reasoning = isOpenAIReasoningModel(modelId)
  const minor = openAIMinor(modelId)
  const gpt5CodexShell = /^gpt-5-codex(?:-|$)/i.test(modelId)
  // The pinned Codex catalog has different templates even for sol/terra/luna. Exact binding, no inference
  // by family, snapshot, or fine-tune; future models enter only after their own template is ported.
  const promptProfile: ChatPromptProfile =
    modelProfile.id === 'openai-gpt-6-astra-v1'
      ? OPENAI_GPT6_ASTRA_PROMPT_PROFILE
      : modelId.toLowerCase() === 'gpt-5.6-sol'
        ? OPENAI_CODEX_GPT56_SOL_PROMPT_PROFILE
        : 'maestrly-openai-generic-v1'
  const modernResponses = minor != null && minor >= 4
  const structuredPatch = gpt5CodexShell || (minor != null && minor >= 1)

  return {
    profile: 'openai-responses-v1',
    modelHarnessProfileId: modelProfile.id,
    promptProfile,
    capabilities: {
      responseItems: true,
      encryptedReasoning: reasoning || modelProfile.capabilities.encryptedReasoning,
      messagePhase: reasoning || modelProfile.capabilities.persistedReasoning,
      strictTools: true,
      parallelTools: modelProfile.manifest ? modelProfile.capabilities.parallelTools : true,
      promptCacheKey: true,
      reasoningContext: modelProfile.manifest ? modelProfile.capabilities.reasoningContext : minor != null && minor >= 6,
      nativeCompaction: modelProfile.manifest ? modelProfile.capabilities.compaction : modernResponses,
      toolSearch: modernResponses,
      // The provider SDK documents local_shell only for the Codex family. Other GPTs keep bash.
      nativeShell: gpt5CodexShell,
      nativeApplyPatch: structuredPatch && supportsOpenAINativeApplyPatch(baseURL),
      // The current runner uses AI SDK HTTP/SSE streaming. Set true only when an actual WS transport exists.
      websocket: false,
      // BYOK currently streams over HTTP/SSE. Model support alone must not advertise these controls.
      midTurnSteering: false,
      asyncTools: false,
      liveReasoningUpdate: false,
      experimentalContext: false,
      serializableReasoningEfforts: modelProfile.capabilities.validReasoningEfforts,
    },
  }
}

export function isOpenAIResponsesHarness(value: Pick<ChatHarnessResolution, 'profile'> | ChatHarnessProfile): boolean {
  return (typeof value === 'string' ? value : value.profile) === 'openai-responses-v1'
}

/** Single kill-switch boundary used by both main and delegated runs. */
export function isOpenAIHarnessActive(
  enabled: boolean,
  resolution: Pick<ChatHarnessResolution, 'profile'> | ChatHarnessProfile
): boolean {
  return enabled && isOpenAIResponsesHarness(resolution)
}

/**
 * Local automatic compaction is a legacy-harness fallback. When the OpenAI
 * profile is active and the model supports native compaction, let the Responses API
 * preserve opaque items instead of replacing context with a visual summary.
 */
export function bypassLegacyAutoCompaction(
  openAIHarnessEnabled: boolean,
  resolution: Pick<ChatHarnessResolution, 'profile'> & {
    capabilities: Pick<ChatHarnessCapabilities, 'nativeCompaction'>
  }
): boolean {
  return openAIHarnessEnabled && isOpenAIResponsesHarness(resolution) && resolution.capabilities.nativeCompaction
}

export interface OpenAIHarnessRequestPolicy {
  promptCacheKey: string
  reasoningEnabled: boolean
  /** Rendered-token threshold for server-side compaction. Omit when the effective window is unknown. */
  compactionThreshold?: number
  promptCacheTtl?: '30m'
}

/** Stable OpenAI profile options. Effort/summary still come from conversation preferences. */
export function openAIHarnessProviderOptions(
  resolution: Pick<ChatHarnessResolution, 'profile' | 'capabilities'>,
  policy: OpenAIHarnessRequestPolicy
): JSONObject {
  if (!isOpenAIResponsesHarness(resolution)) return {}
  const options: JSONObject = {
    store: false,
    include: ['reasoning.encrypted_content'],
    strictJsonSchema: true,
    parallelToolCalls: resolution.capabilities.parallelTools,
    promptCacheKey: policy.promptCacheKey,
    // Never silently discard the prefix: the app context guard/compactor controls this boundary.
    truncation: 'disabled',
  }
  if (policy.promptCacheTtl) options.promptCacheOptions = { ttl: policy.promptCacheTtl }
  if (policy.reasoningEnabled && resolution.capabilities.reasoningContext) {
    options.reasoningContext = 'all_turns'
  }
  if (
    resolution.capabilities.nativeCompaction &&
    Number.isSafeInteger(policy.compactionThreshold) &&
    policy.compactionThreshold! > 0
  ) {
    options.contextManagement = [{ type: 'compaction', compactThreshold: policy.compactionThreshold! }]
  }
  return options
}
