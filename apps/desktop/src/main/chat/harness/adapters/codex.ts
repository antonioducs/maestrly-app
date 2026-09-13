import type { ChatProviderKind } from '../../../../shared/chat'
import type { HarnessCapabilities, HarnessCapabilityClaims } from '../../../../shared/harness'
import { harnessFor } from '../execution'
import { serializableReasoningEffort } from '../policies'
import type { ResolvedHarness } from '../types'

const CODEX: ChatProviderKind = 'codex-subscription'

/**
 * Codex app-server facts translated into harness inputs and back. This module never speaks HTTP,
 * owns no session and never calls an SDK: it maps validated runtime facts to policy.
 */
export interface CodexRuntimeFacts {
  requestUserInputAsyncAvailable: boolean
  turnSteerAvailable?: boolean
  turnSettingsUpdateAvailable?: boolean
}

export function codexAdapterCapabilities(facts: CodexRuntimeFacts): HarnessCapabilityClaims {
  return {
    responsesTools: true,
    persistedReasoning: true,
    encryptedReasoning: true,
    reasoningContext: true,
    compaction: true,
    parallelTools: true,
    steering: facts.turnSteerAvailable !== false,
    asyncTools: facts.requestUserInputAsyncAvailable,
    configurationUpdates: facts.turnSettingsUpdateAvailable !== false,
    experimentalContext: true,
  }
}

export interface CodexEligibilityFacts {
  eligibleChatGptSession: boolean
  ephemeral: boolean
  reviewer: boolean
  experimentalContextFallbackDisabled?: boolean
  requestUserInputAsyncAvailable: boolean
}

export interface CodexThreadPolicy {
  promptVersion: string
  personality: 'pragmatic' | undefined
  nativeCompactionFirst: boolean
  experimentalContextEnabled: boolean
  asyncQuestionGuidance: boolean
  reasoningEffort: string | null
}

/**
 * Experimental context needs the profile request, the effective capability and every eligibility
 * fact: a normal session's experimental context never leaks into reviewer or ephemeral executions.
 */
export function resolveCodexThreadPolicy(
  harness: ResolvedHarness,
  facts: CodexEligibilityFacts,
  reasoningEffort: string | null | undefined
): CodexThreadPolicy {
  const experimentalContextEnabled =
    harness.runtime.experimentalContext &&
    harness.capabilities.experimentalContext &&
    facts.eligibleChatGptSession &&
    !facts.ephemeral &&
    !facts.reviewer &&
    !facts.experimentalContextFallbackDisabled
  const serializable = serializableReasoningEffort(harness.reasoning, reasoningEffort)
  return {
    promptVersion: harness.runtime.codexPromptVersion,
    personality: harness.runtime.personality ?? undefined,
    nativeCompactionFirst: harness.runtime.nativeCompactionFirst && harness.capabilities.compaction,
    experimentalContextEnabled,
    asyncQuestionGuidance: harness.capabilities.asyncTools && facts.requestUserInputAsyncAvailable,
    reasoningEffort:
      harness.reasoning.manifestEfforts == null
        ? serializable
        : serializable && harness.reasoning.effectiveEfforts.includes(serializable)
          ? serializable
          : null,
  }
}

export interface CodexThreadHarness extends CodexThreadPolicy {
  harness: ResolvedHarness
  modelHarnessProfileId: string
  capabilities: HarnessCapabilities
  validReasoningEfforts: readonly string[]
  /** The profile supplies a host contract layered over a provider-owned operating prompt. */
  usesNativeOperatingPrompt: boolean
  /** The profile asks for experimental context, so the transport must state the flag explicitly. */
  declaresExperimentalContext: boolean
}

export interface BuildCodexThreadHarnessInput extends CodexEligibilityFacts, CodexRuntimeFacts {
  modelId: string
  flags: Readonly<Record<string, boolean>>
  runtimeCapabilities?: HarnessCapabilityClaims
  runtimeReasoningEfforts?: readonly string[] | null
  reasoningEffort?: string
}

/** Resolves the Codex thread contract from the catalog manifest and app-server session capabilities. */
export function buildCodexThreadHarness(input: BuildCodexThreadHarnessInput): CodexThreadHarness {
  const harness = harnessFor(CODEX, input.modelId, {
    flags: input.flags,
    adapterCapabilities: codexAdapterCapabilities(input),
    ...(input.runtimeCapabilities ? { runtimeCapabilities: input.runtimeCapabilities } : {}),
    ...(input.runtimeReasoningEfforts !== undefined
      ? { runtimeReasoningEfforts: input.runtimeReasoningEfforts }
      : {}),
  })
  return {
    harness,
    modelHarnessProfileId: harness.identity.harnessProfileId,
    capabilities: harness.capabilities,
    validReasoningEfforts: harness.reasoning.effectiveEfforts,
    usesNativeOperatingPrompt: harness.prompts.developerPrefix != null,
    declaresExperimentalContext: harness.runtime.experimentalContext,
    ...resolveCodexThreadPolicy(harness, input, input.reasoningEffort),
  }
}
