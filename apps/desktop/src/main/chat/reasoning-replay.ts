/**
 * INTERLEAVED reasoning replay (DeepSeek/GLM/Kimi via chat/completions).
 *
 * Some providers require assistant tool-call messages to return their accompanying reasoning text
 * (`reasoning_content`), otherwise rejecting the next request with "reasoning_content ... must
 * be passed back". @ai-sdk/openai-compatible ONLY resends `reasoning_content` when text is
 * nonempty (truthy), while AI SDK builds internal steps without copying reasoning between them —
 * so enforce round trips at a boundary seeing ALL `streamText` prompts,
 * including internal tool steps, preserving `""` by PRESENCE, never truthiness.
 *
 * Two boundaries (same policy; plan steps 3/4):
 *  - `transformParams` middleware (wrapLanguageModel): normalizes EVERY LanguageModel invocation,
 *    including SDK-generated internal steps within one `streamText`. Their origin is already
 *    the current model, so policy identity does NOT filter anything here;
 *  - `toModelMessages` (message.ts): rehydrates PERSISTED messages before the turn's first request.
 *    Here identity (providerId/modelId/providerFingerprint) decides: replay reasoning only when message origin
 *    matches current selection EXACTLY; otherwise supply only the empty structural
 *    fallback. Fingerprinting blocks replay from old backends (changed endpoint/kind/key) that
 *    matching providerId/modelId alone would not distinguish.
 *
 * Strictly capability-driven policy: enable on `openai` transport (compatible Chat Completions)
 * when catalog declares `interleaved.field = reasoning_content`, or conservatively fall back to
 * known family IDs when catalog is unavailable. Effort selection does NOT affect the decision:
 * `off`/Default only omits effort override (model decides and may emit reasoning);
 * replay is a model protocol requirement, not an effort preference. No changes for Anthropic, OpenAI
 * Responses, subscription providers, or models without this capability.
 */
import { wrapLanguageModel } from 'ai'
import type { JSONObject, LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type { ChatModelMeta, ChatProviderKind } from '../../shared/chat'

/** Interleaved-model replay contract: body field + identity for history provenance. */
export interface InterleavedReplayPolicy {
  /** Textual body field returning reasoning (e.g. `reasoning_content`). */
  field: string
  /** Current selection identity. Only persisted rehydration (`toModelMessages`) consumes it: requires
   * matching `msg.model`/`providerFingerprint` to resend nonempty reasoning (foreign
   * origin → empty fallback). Fingerprint is opaque and NEVER becomes a credential/log. */
  providerId: string
  modelId: string
  providerFingerprint: string
}

/** Diagnostic counters (no message content) — read by runner for chatDiag. */
export interface InterleavedReplayStats {
  /** Assistant tool-call messages receiving the field (with or without text). */
  normalizedSteps: number
  /** Injected `""` fallbacks (tool call without reasoning in the same step). */
  emptyFallbacks: number
}

/** Conservative unavailable-catalog fallback: only IDs KNOWN to belong to a replay-requiring family. */
export const INTERLEAVED_REASONING_MODEL_IDS = new Set(['deepseek-v4-pro', 'deepseek-v4-flash'])

/**
 * Normalizes model IDs ONLY for offline fallback: trim + lowercase + last segment after `/`.
 * Accepts gateway IDs (`deepseek/deepseek-v4-pro`), case variations, and surrounding spaces.
 * Provider-bound IDs and normal catalog resolution NEVER pass through here.
 */
export function normalizeInterleavedModelId(modelId: string): string {
  return modelId.trim().toLowerCase().split('/').pop() ?? ''
}

/**
 * Resolves replay policy. Enable when:
 *  1. Transport is `openai` (compatible Chat Completions — NOT openai-responses or anthropic);
 *  2. Catalog metadata declares `interleaved.field = reasoning_content`; OR
 *  3. Unavailable catalog → conservative fallback only for known family IDs (NEVER generic
 *     `reasoning: true` — other models have opposite contracts or structured metadata).
 *
 * `reasoningEffort` is accepted only for DIAGNOSTICS (chatDiag logging), not the
 * decision: `off`/Default omits effort override, but providers may still emit reasoning,
 * and replay is a protocol requirement, not a picker preference.
 *
 * `providerFingerprint` (resolved by runner from normalized URL + transport + credential)
 * merely ACCOMPANIES policy to persisted-replay boundary — capability resolution does not depend
 * on it. The intra-turn wrapper does not consume it either.
 */
export function resolveInterleavedReplayPolicy(args: {
  transport: ChatProviderKind
  providerId: string
  modelId: string
  providerFingerprint: string
  meta: ChatModelMeta | null
  catalogStatus?: 'available' | 'unavailable'
  reasoningEffort?: string | null
}): InterleavedReplayPolicy | null {
  if (args.transport !== 'openai') return null
  const interleaved = args.meta?.interleavedReasoning
  if (interleaved) {
    return {
      field: interleaved.field,
      providerId: args.providerId,
      modelId: args.modelId,
      providerFingerprint: args.providerFingerprint,
    }
  }
  if (
    args.meta == null &&
    args.catalogStatus === 'unavailable' &&
    INTERLEAVED_REASONING_MODEL_IDS.has(normalizeInterleavedModelId(args.modelId))
  ) {
    return {
      field: 'reasoning_content',
      providerId: args.providerId,
      modelId: args.modelId,
      providerFingerprint: args.providerFingerprint,
    }
  }
  return null
}

type PromptMessage = LanguageModelV4CallOptions['prompt'][number]

type AssistantPromptMessage = Extract<PromptMessage, { role: 'assistant' }> & {
  providerOptions?: Record<string, JSONObject>
}

/**
 * Normalizes a LanguageModel prompt to the interleaved contract for each assistant message:
 *  - Joins THAT message's `reasoning` parts and attaches text to `providerOptions` serialized
 *    by openai-compatible in the body (`openaiCompatible[field]`) — present even when empty;
 *  - Assistant tool call without reasoning → inject explicit `""` (presence, not truthiness);
 *  - Never copies reasoning to the next step or across a user message;
 *  - Does not use policy identity (providerId/modelId): these prompts already originate from the current model —
 *    provenance checks belong ONLY to persisted-history reconstruction (`toModelMessages`);
 *  - Does nothing when policy is disabled (caller does not invoke it).
 * Immutable: untouched messages retain references; modified messages are copied.
 */
export function applyInterleavedReplayToPrompt(
  prompt: readonly PromptMessage[],
  policy: InterleavedReplayPolicy,
  stats?: InterleavedReplayStats
): PromptMessage[] {
  return prompt.map((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return message
    const parts = message.content as Array<{ type: string; text?: string }>
    const reasoningText = parts
      .filter((part) => part.type === 'reasoning' && typeof part.text === 'string')
      .map((part) => part.text ?? '')
      .join('')
    const hasToolCall = parts.some((part) => part.type === 'tool-call')
    const hasReasoning = parts.some((part) => part.type === 'reasoning')
    if (!hasToolCall && !hasReasoning) return message
    if (stats) stats.normalizedSteps += 1
    const value = hasReasoning ? reasoningText : ''
    if (stats && !hasReasoning) stats.emptyFallbacks += 1
    const assistant = message as AssistantPromptMessage
    const providerOptions = { ...(assistant.providerOptions ?? {}) }
    const openaiCompatible = { ...(providerOptions.openaiCompatible ?? {}) }
    openaiCompatible[policy.field] = value
    providerOptions.openaiCompatible = openaiCompatible
    return { ...assistant, providerOptions }
  })
}

/**
 * Wraps LanguageModel with replay middleware. `transformParams` runs BEFORE EVERY model invocation,
 * including internal AI SDK tool-loop steps within a single `streamText`.
 */
export function wrapInterleavedReplayModel(
  model: LanguageModelV4,
  policy: InterleavedReplayPolicy,
  stats?: InterleavedReplayStats
): LanguageModelV4 {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      transformParams: async ({ params }) => ({
        ...params,
        prompt: applyInterleavedReplayToPrompt(params.prompt, policy, stats),
      }),
    },
  })
}
