import type { JSONObject } from '@ai-sdk/provider'
import type { ChatProviderKind } from '../../../../shared/chat'
import type { HarnessCapabilityClaims } from '../../../../shared/harness'
import type { ResolvedHarness } from '../types'

/**
 * Provider HTTP format and agent behavior are separate axes. A GPT served only through Chat
 * Completions stays on the legacy transport; only Responses endpoints receive the item-oriented
 * protocol. A profile folder never converts a transport.
 */
export type ChatHarnessProfile = 'legacy' | 'openai-responses-v1'

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

export function officialOpenAIEndpoint(baseURL: string | undefined): boolean {
  if (!baseURL) return false
  try {
    const parsed = new URL(baseURL)
    return parsed.protocol === 'https:' && parsed.host.toLowerCase() === 'api.openai.com'
  } catch {
    return false
  }
}

function isOpenAIReasoningModel(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return /^o(?:1|3|4)(?:-|$)/.test(id) || /^gpt-5(?:[.-]|$)/.test(id)
}

export function isOpenAIModelId(modelId: string): boolean {
  const id = modelId.toLowerCase()
  const base = id.startsWith('ft:') ? id.slice(3) : id
  return /^(?:gpt-|chatgpt-|o(?:1|3|4)(?:-|$)|codex(?:-|$))/.test(base)
}

function openAIMinor(modelId: string): number | null {
  const match = /^gpt-5\.(\d+)(?:[.-]|$)/i.exec(modelId)
  return match ? Number(match[1]) : null
}

/**
 * Provider-defined tools are not part of the minimum Responses-compatible contract. In particular,
 * the ChatGPT subscription Codex endpoint rejects `{ type: "apply_patch" }` even though it accepts
 * the rest of the Responses harness. Keep the native tool first-party-only until a provider can
 * declare capabilities explicitly; compatible gateways retain the Maestrly edit/write function tools
 * instead of failing the whole request before inference starts.
 */
function supportsOpenAINativeApplyPatch(baseURL?: string): boolean {
  if (!baseURL) return false
  try {
    return new URL(baseURL).hostname.toLowerCase() === 'api.openai.com'
  } catch {
    return false
  }
}

/** What a BYOK Responses run can actually execute today. HTTP/SSE has no steering or live updates. */
export function responsesAdapterCapabilities(): HarnessCapabilityClaims {
  return {
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
}

export interface TransportHarnessResolution {
  profile: ChatHarnessProfile
  capabilities: ChatHarnessCapabilities
}

/**
 * Conservative transport matrix versioned with the app. Advanced features are enabled only for known
 * endpoints and models; unknown IDs still receive the basic Responses ledger without experimental
 * parameters. It consumes the resolved harness contract instead of model-name branches.
 */
export function resolveTransportHarness(
  kind: ChatProviderKind,
  modelId: string,
  baseURL: string | undefined,
  harness: ResolvedHarness
): TransportHarnessResolution {
  const efforts = harness.reasoning.effectiveEfforts
  if (kind !== 'openai-responses' || !isOpenAIModelId(modelId)) {
    return {
      profile: 'legacy',
      capabilities: {
        ...LEGACY_CAPABILITIES,
        midTurnSteering: harness.capabilities.steering,
        asyncTools: harness.capabilities.asyncTools,
        liveReasoningUpdate: harness.capabilities.configurationUpdates,
        experimentalContext: harness.capabilities.experimentalContext,
        serializableReasoningEfforts: efforts,
      },
    }
  }

  const reasoning = isOpenAIReasoningModel(modelId)
  const minor = openAIMinor(modelId)
  const gpt5CodexShell = /^gpt-5-codex(?:-|$)/i.test(modelId)
  const modernResponses = minor != null && minor >= 4
  const structuredPatch = gpt5CodexShell || (minor != null && minor >= 1)
  // A profile that publishes a manifest owns these axes; otherwise the legacy heuristics remain.
  const manifest = harness.reasoning.manifestEfforts != null

  return {
    profile: 'openai-responses-v1',
    capabilities: {
      responseItems: true,
      encryptedReasoning: reasoning || harness.capabilities.encryptedReasoning,
      messagePhase: reasoning || harness.capabilities.persistedReasoning,
      strictTools: true,
      parallelTools: manifest ? harness.capabilities.parallelTools : true,
      promptCacheKey: true,
      reasoningContext: manifest ? harness.capabilities.reasoningContext : minor != null && minor >= 6,
      nativeCompaction: manifest ? harness.capabilities.compaction : modernResponses,
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
      serializableReasoningEfforts: efforts,
    },
  }
}

export function isOpenAIResponsesHarness(value: { profile: ChatHarnessProfile } | ChatHarnessProfile): boolean {
  return (typeof value === 'string' ? value : value.profile) === 'openai-responses-v1'
}

/** Single kill-switch boundary used by both main and delegated runs. */
export function isOpenAIHarnessActive(
  enabled: boolean,
  resolution: { profile: ChatHarnessProfile } | ChatHarnessProfile
): boolean {
  return enabled && isOpenAIResponsesHarness(resolution)
}

/**
 * Local automatic compaction is a legacy-transport fallback. When the Responses profile is active and
 * the model supports native compaction, let the API preserve opaque items instead of replacing
 * context with a visual summary.
 */
export function bypassLegacyAutoCompaction(
  openAIHarnessEnabled: boolean,
  resolution: { profile: ChatHarnessProfile; capabilities: Pick<ChatHarnessCapabilities, 'nativeCompaction'> }
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

/** Stable Responses profile options. Effort/summary still come from conversation preferences. */
export function openAIHarnessProviderOptions(
  resolution: { profile: ChatHarnessProfile; capabilities: ChatHarnessCapabilities },
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
