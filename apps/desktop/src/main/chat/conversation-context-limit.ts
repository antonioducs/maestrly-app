/**
 * The most context one conversation may use, whatever its model (a fleet bot's owner caps it to bound what each turn
 * costs). Kept in memory by the owner of the conversation, like its compaction override. Every place that derives the
 * conversation's window from its model runs it through `limitConversationContextWindow`, so compaction before and
 * during turns and background preparation all use the smaller of the two.
 */
const limits = new Map<string, number>()

/** Sets the limit of one conversation; null, zero or a value that is not a finite positive number removes it. */
export function setConversationContextLimit(conversationId: string, tokens: number | null): void {
  const value = typeof tokens === 'number' && Number.isFinite(tokens) ? Math.floor(tokens) : 0
  if (value > 0) limits.set(conversationId, value)
  else limits.delete(conversationId)
}

export function getConversationContextLimit(conversationId: string): number | undefined {
  return limits.get(conversationId)
}

/** The smaller of the model's window and the conversation's limit; the limit alone when the model's is unknown. */
export function limitConversationContextWindow(
  conversationId: string,
  window: number | null | undefined
): number | undefined {
  const known = window != null && window > 0 ? window : undefined
  const limit = limits.get(conversationId)
  if (limit === undefined) return known
  return known === undefined ? limit : Math.min(known, limit)
}
