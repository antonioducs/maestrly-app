/**
 * Stage receipt: what was requested, what was admitted and what the runtime actually used.
 *
 * A mismatch between the admitted and the observed selection is never smoothed over. The receipt records
 * `selectionHonored: false` and the server refuses to present that stage as executed as requested.
 */
import {
  stageExecutionReceiptSchema,
  type AgentStageSettings,
  type StageExecutionReceipt,
} from '@maestrly/protocol'

export interface ObservedRuntimeSelection {
  selectionId: string | null
  modelId: string | null
  accountLabel: string | null
  reasoning: string | null
  fastMode: boolean | null
  harnessProfileId: string | null
  harnessHash: string | null
}

export interface ReceiptInput {
  requested: AgentStageSettings | null
  admitted: AgentStageSettings | null
  observed: ObservedRuntimeSelection | null
  conversationId: string | null
  result: 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
  summary?: string
  blocker?: string | null
  tokens?: number | null
  costUsd?: number | null
  durationMs?: number | null
}

/** The observed selection must match the admitted one on identity, effort and Fast. */
export function selectionHonored(
  admitted: AgentStageSettings | null,
  observed: ObservedRuntimeSelection | null
): boolean {
  if (!admitted) return true
  if (!observed) return false
  if (observed.selectionId !== null && observed.selectionId !== admitted.selectionId) return false
  if (observed.reasoning !== null && observed.reasoning !== admitted.reasoning) return false
  if (observed.fastMode !== null && observed.fastMode !== admitted.fastMode) return false
  // An unreported identity is not evidence of compliance.
  return observed.selectionId !== null
}

export function buildStageReceipt(input: ReceiptInput): StageExecutionReceipt {
  const tokensObserved = typeof input.tokens === 'number'
  return stageExecutionReceiptSchema.parse({
    requested: input.requested,
    admitted: input.admitted,
    observed: input.observed,
    selectionHonored: selectionHonored(input.admitted, input.observed),
    conversationId: input.conversationId,
    result: input.result,
    summary: (input.summary ?? '').slice(0, 20_000),
    blocker: input.blocker ?? null,
    // An unknown consumption stays unknown instead of being reported as zero.
    tokensObserved,
    tokens: tokensObserved ? input.tokens : null,
    costUsd: typeof input.costUsd === 'number' ? input.costUsd : null,
    durationMs: typeof input.durationMs === 'number' ? input.durationMs : null,
  })
}
