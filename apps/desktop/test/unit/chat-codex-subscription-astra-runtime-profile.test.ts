import { describe, expect, it } from 'vitest'
import { buildCodexThreadHarness, type CodexThreadHarness } from '../../src/main/chat/harness/adapters/codex'
import { buildHarnessDeveloperInstructions } from '../../src/main/chat/harness/prompt-builder'
import type { CodexSubscriptionModel } from '../../src/main/chat/codex-subscription/manager'

/** Codex runtime facts now feed the declarative catalog instead of a model-specific module. */
interface LegacyAstraInput {
  modelId: string
  model?: Partial<CodexSubscriptionModel> | null
  astraHarnessEnabled: boolean
  eligibleChatGptSession: boolean
  ephemeral: boolean
  reviewer: boolean
  requestUserInputAsyncAvailable: boolean
  reasoningEffort?: string
}

const buildAstraCodexThreadProfile = (input: LegacyAstraInput): CodexThreadHarness =>
  buildCodexThreadHarness({
    modelId: input.modelId,
    flags: { 'chat.astraHarness': input.astraHarnessEnabled },
    runtimeCapabilities: {
      ...(input.model?.supportsExperimentalContext != null
        ? { experimentalContext: input.model.supportsExperimentalContext }
        : {}),
      ...(input.model?.supportsParallelToolCalls != null
        ? { parallelTools: input.model.supportsParallelToolCalls }
        : {}),
    },
    runtimeReasoningEfforts: input.model?.supportedReasoningEfforts?.map((entry) => entry.reasoningEffort),
    eligibleChatGptSession: input.eligibleChatGptSession,
    ephemeral: input.ephemeral,
    reviewer: input.reviewer,
    requestUserInputAsyncAvailable: input.requestUserInputAsyncAvailable,
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
  })

const astraDeveloperInstructions = (base: string, profile: CodexThreadHarness) =>
  buildHarnessDeveloperInstructions(base, profile.harness, { asyncTools: profile.asyncQuestionGuidance })

const astra = (patch: Partial<CodexSubscriptionModel> = {}): CodexSubscriptionModel => ({
  id: 'gpt-6-astra',
  model: 'gpt-6-astra',
  displayName: 'Astra',
  description: '',
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: 'low', description: '' },
    { reasoningEffort: 'ultra', description: '' },
  ],
  defaultReasoningEffort: 'medium',
  inputModalities: ['text', 'image'],
  supportsPersonality: true,
  serviceTiers: [],
  defaultServiceTier: null,
  legacySpeedTiers: [],
  contextWindow: 400_000,
  nominalContextWindow: 500_000,
  maxContextWindow: 800_000,
  effectiveContextWindowPercent: 80,
  supportsExperimentalContext: null,
  preferWebsockets: true,
  supportsParallelToolCalls: true,
  toolMode: 'code_mode_only',
  multiAgentVersion: 2,
  useResponsesLite: true,
  supportedVerbosity: ['low', 'medium'],
  defaultVerbosity: 'medium',
  minimumClientVersion: '0.153.4',
  isDefault: true,
  ...patch,
})

const build = (patch: Partial<Parameters<typeof buildAstraCodexThreadProfile>[0]> = {}) =>
  buildAstraCodexThreadProfile({
    modelId: 'gpt-6-astra',
    model: astra(),
    astraHarnessEnabled: true,
    eligibleChatGptSession: true,
    ephemeral: false,
    reviewer: false,
    requestUserInputAsyncAvailable: false,
    reasoningEffort: 'ultra',
    ...patch,
  })

describe('Astra Codex runtime profile', () => {
  it('uses native ultra, native compaction and manifest fallback for an absent 0.153.4 context field', () => {
    const profile = build()
    expect(profile).toMatchObject({
      modelHarnessProfileId: 'openai-gpt-6-astra-v1',
      nativeCompactionFirst: true,
      experimentalContextEnabled: true,
      personality: undefined,
      reasoningEffort: 'ultra',
      asyncQuestionGuidance: false,
    })
  })

  it('lets future explicit false, account eligibility and isolation disable experimental context', () => {
    expect(build({ model: astra({ supportsExperimentalContext: false }) }).experimentalContextEnabled).toBe(false)
    expect(build({ eligibleChatGptSession: false }).experimentalContextEnabled).toBe(false)
    expect(build({ ephemeral: true }).experimentalContextEnabled).toBe(false)
    expect(build({ reviewer: true }).experimentalContextEnabled).toBe(false)
  })

  it('conditions async guidance on actual session tool availability', () => {
    const profile = build({ requestUserInputAsyncAvailable: true })
    expect(profile.asyncQuestionGuidance).toBe(true)
    expect(astraDeveloperInstructions('HOST', profile)).toContain('request_user_input_async')
    expect(astraDeveloperInstructions('HOST', build())).not.toContain('request_user_input_async')
  })

  it('restores the current profile with the kill switch or any other model', () => {
    expect(build({ astraHarnessEnabled: false }).modelHarnessProfileId).toBe('openai-default-v1')
    expect(build({ modelId: 'gpt-5.6-sol' }).modelHarnessProfileId).toBe('openai-default-v1')
  })

  it('rejects Astra none/minimal rather than sending them', () => {
    expect(build({ reasoningEffort: 'none' }).reasoningEffort).toBeNull()
    expect(build({ reasoningEffort: 'minimal' }).reasoningEffort).toBeNull()
  })
})
