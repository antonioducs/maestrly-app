import type { ChatModelMeta } from '../../../shared/chat'

const LOW_MEDIUM_HIGH = ['low', 'medium', 'high'] as const
const LOW_MEDIUM_HIGH_XHIGH = ['low', 'medium', 'high', 'xhigh'] as const

/**
 * Official xAI reasoning matrix for subscription models whose `/models` payload does not publish capabilities.
 * Keep explicit non-reasoning/media models fail-closed; unknown future model ids continue relying on canonical
 * metadata instead of receiving guessed options.
 */
export function grokReasoningEffortsForModel(modelId: string): string[] {
  const id = modelId.trim().toLowerCase()
  if (!id || /non[-_.]?reasoning|imagine|image|video/.test(id)) return []
  if (/^grok-4[.-]6(?:$|[-_.])/.test(id)) return [...LOW_MEDIUM_HIGH_XHIGH]
  if (/^grok-4[.-]5(?:$|[-_.])/.test(id)) return [...LOW_MEDIUM_HIGH]
  if (/^grok-4[.-]20.*multi[-_.]?agent/.test(id)) return [...LOW_MEDIUM_HIGH_XHIGH]
  return []
}

/** Canonical metadata wins when it is authoritative; the xAI matrix fills only an absent capability. */
export function grokReasoningMeta(
  modelId: string,
  canonical?: Pick<ChatModelMeta, 'reasoning' | 'reasoningEfforts'> | null
): Pick<ChatModelMeta, 'reasoning' | 'reasoningEfforts'> {
  if (canonical?.reasoning !== undefined) {
    return {
      reasoning: canonical.reasoning,
      ...(canonical.reasoningEfforts?.length ? { reasoningEfforts: [...canonical.reasoningEfforts] } : {}),
    }
  }
  const reasoningEfforts = grokReasoningEffortsForModel(modelId)
  return reasoningEfforts.length ? { reasoning: true, reasoningEfforts } : {}
}
