import { z } from 'zod'
import type { ChatCompactionProgress, ChatContextSnapshot } from '../../shared/chat'

const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const contextSnapshot = z.object({
  usedTokens: tokens,
  modelContextWindow: tokens.positive().optional(),
  model: z.object({ providerId: z.string().min(1), modelId: z.string().min(1) }),
  quality: z.enum(['measured', 'estimated']),
  observedAt: tokens,
  sequence: tokens,
})
const compactionProgress = z.object({
  id: z.string().min(1),
  scope: z.enum(['turn', 'conversation']).optional(),
  model: z.object({ providerId: z.string().min(1), modelId: z.string().min(1) }).optional(),
  status: z.enum(['running', 'retrying', 'completed', 'failed', 'cancelled']),
  phase: z.enum(['chunk', 'consolidate', 'native']).optional(),
  completed: tokens.optional(),
  total: tokens.positive().optional(),
  attempt: tokens.positive().optional(),
  beforeTokens: tokens.optional(),
  afterTokens: tokens.optional(),
  afterQuality: z.enum(['measured', 'estimated']).optional(),
  error: z.string().optional(),
  updatedAt: tokens,
})

/** Legacy messages omit these independent display measurements; malformed metadata stays absent. */
export function parseContextSnapshot(value: unknown): ChatContextSnapshot | undefined {
  const result = contextSnapshot.safeParse(value)
  return result.success ? result.data : undefined
}

export function parseCompactionProgress(value: unknown): ChatCompactionProgress | undefined {
  const result = compactionProgress.safeParse(value)
  return result.success ? result.data : undefined
}
