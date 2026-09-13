import type { ChatProviderKind } from '../../../shared/chat'
import type { HarnessCapabilityClaims, HarnessSnapshotV1 } from '../../../shared/harness'
import {
  officialOpenAIEndpoint,
  resolveTransportHarness,
  type ChatHarnessCapabilities,
  type ChatHarnessProfile,
} from './adapters/responses'
import { adapterCapabilitiesFor } from './adapters/generic'
import { harnessRegistry } from './catalog'
import { resolveHarness } from './resolver'
import type { HarnessResolution, ResolvedHarness } from './types'

export interface ResolveChatHarnessOptions {
  /** Canonical identity confirmed by the transport catalog/runtime. */
  resolvedModelId?: string | null
  /** Flags captured at admission. */
  flags?: Readonly<Record<string, boolean>>
  runtimeCapabilities?: HarnessCapabilityClaims
  adapterCapabilities?: HarnessCapabilityClaims
  runtimeReasoningEfforts?: readonly string[] | null
  frozen?: boolean
  frozenBehaviorProfileId?: string | null
  frozenSnapshot?: HarnessSnapshotV1 | null
}

export interface ChatHarnessExecution {
  harness: ResolvedHarness
  /** Transport format actually used. Independent from prompt and compatibility. */
  transport: ChatHarnessProfile
  modelHarnessProfileId: string
  promptProfile: string
  behaviorProfileId: string | null
  capabilities: ChatHarnessCapabilities
}

/**
 * Whole-execution contract: profile selection, transport matrix and effective capabilities resolved
 * once, from validated facts. Runners, the service, persistence and the interface consume this
 * result; none of them may re-derive behavior from a model name.
 */
export function resolveChatHarnessExecution(
  kind: ChatProviderKind,
  modelId: string,
  baseURL?: string,
  options: ResolveChatHarnessOptions = {}
): { ok: true; execution: ChatHarnessExecution } | { ok: false; reason: HarnessExecutionFailure } {
  const resolution: HarnessResolution = resolveHarness(
    {
      providerKind: kind,
      requestedModelId: modelId,
      officialOpenAIEndpoint: officialOpenAIEndpoint(baseURL),
      ...(options.resolvedModelId !== undefined ? { resolvedModelId: options.resolvedModelId } : {}),
      ...(options.flags ? { flags: options.flags } : {}),
      ...(options.runtimeCapabilities ? { runtimeCapabilities: options.runtimeCapabilities } : {}),
      // Configuration may restrict a transport fact but never invent an implementation.
      adapterCapabilities: options.adapterCapabilities ?? adapterCapabilitiesFor(kind),
      ...(options.runtimeReasoningEfforts !== undefined
        ? { runtimeReasoningEfforts: options.runtimeReasoningEfforts }
        : {}),
      ...(options.frozen !== undefined ? { frozen: options.frozen } : {}),
      ...(options.frozenBehaviorProfileId !== undefined
        ? { frozenBehaviorProfileId: options.frozenBehaviorProfileId }
        : {}),
      ...(options.frozenSnapshot !== undefined ? { frozenSnapshot: options.frozenSnapshot } : {}),
    },
    harnessRegistry()
  )
  if (!resolution.ok) return { ok: false, reason: resolution.reason }
  const transport = resolveTransportHarness(kind, modelId, baseURL, resolution.harness)
  return {
    ok: true,
    execution: {
      harness: resolution.harness,
      transport: transport.profile,
      modelHarnessProfileId: resolution.harness.identity.harnessProfileId,
      // A Responses-capable endpoint serving a non-Responses model keeps the legacy textual contract.
      promptProfile:
        kind === 'openai-responses' && transport.profile === 'legacy'
          ? 'maestrly-legacy'
          : resolution.harness.identity.promptIdentity,
      behaviorProfileId: resolution.harness.identity.behaviorProfileId,
      capabilities: transport.capabilities,
    },
  }
}

export type HarnessExecutionFailure = 'frozen-profile-mismatch' | 'frozen-snapshot-mismatch'

/**
 * Harness contract for transports that do not go through the BYOK provider registry. Subagents,
 * native runtimes and delegated executions resolve their own model instead of inheriting the parent.
 */
export function resolveHarnessContract(
  providerKind: ChatProviderKind,
  requestedModelId: string,
  options: ResolveChatHarnessOptions = {}
): { ok: true; harness: ResolvedHarness } | { ok: false; reason: HarnessExecutionFailure } {
  const result = resolveChatHarnessExecution(providerKind, requestedModelId, undefined, options)
  return result.ok ? { ok: true, harness: result.execution.harness } : result
}

/** Same contract, for callers whose selection is never frozen. */
export function harnessFor(
  providerKind: ChatProviderKind,
  requestedModelId: string,
  options: Omit<ResolveChatHarnessOptions, 'frozen' | 'frozenBehaviorProfileId' | 'frozenSnapshot'> = {}
): ResolvedHarness {
  return resolveChatHarness(providerKind, requestedModelId, undefined, options).harness
}

/** Non-frozen convenience wrapper: selection without a frozen contract can never fail. */
export function resolveChatHarness(
  kind: ChatProviderKind,
  modelId: string,
  baseURL?: string,
  options: Omit<ResolveChatHarnessOptions, 'frozen' | 'frozenBehaviorProfileId' | 'frozenSnapshot'> = {}
): ChatHarnessExecution {
  const result = resolveChatHarnessExecution(kind, modelId, baseURL, options)
  if (!result.ok) throw new Error(`unexpected harness resolution failure: ${result.reason}`)
  return result.execution
}
