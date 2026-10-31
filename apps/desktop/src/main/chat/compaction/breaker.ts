/**
 * Stops automatic pre-send compaction from repeating rounds that free almost nothing. Two ineffective compactions in a
 * row (still over the threshold afterwards, or less than 10% saved) suspend it until the context grows by 10% of the
 * window, the model or window changes, it would overflow, or the person compacts by hand. In-memory by design: a
 * restart simply tries again.
 */
interface BreakerState {
  key: string
  strikes: number
  /** Occupancy when automatic compaction was suspended. */
  suspendedAt: number | null
}

const MAX_TRACKED = 256
const states = new Map<string, BreakerState>()

function state(conversationId: string, key: string): BreakerState {
  let current = states.get(conversationId)
  if (!current || current.key !== key) {
    current = { key, strikes: 0, suspendedAt: null }
    states.delete(conversationId)
    states.set(conversationId, current)
    if (states.size > MAX_TRACKED) states.delete(states.keys().next().value as string)
  }
  return current
}

export function compactionBreakerKey(providerId: string, modelId: string, contextWindow: number): string {
  return `${providerId}\0${modelId}\0${contextWindow}`
}

/** Records an automatic compaction: `before`/`after` are occupancies, `threshold` the tokens that trigger one. */
export function recordAutomaticCompaction(
  conversationId: string,
  key: string,
  outcome: { before: number; after: number; threshold: number }
): { ineffective: boolean; suspended: boolean } {
  const current = state(conversationId, key)
  const ineffective = outcome.after >= outcome.threshold || outcome.before - outcome.after < outcome.before * 0.1
  current.strikes = ineffective ? current.strikes + 1 : 0
  if (current.strikes >= 2) current.suspendedAt = outcome.after
  return { ineffective, suspended: current.suspendedAt != null }
}

/** Whether automatic pre-send compaction is suspended for this load; lifting a suspension forgets earlier strikes. */
export function automaticCompactionSuspended(
  conversationId: string,
  key: string,
  load: { usedTokens: number; contextWindow: number; overflow: boolean }
): boolean {
  const current = state(conversationId, key)
  if (current.suspendedAt == null) return false
  if (!load.overflow && load.usedTokens < current.suspendedAt + load.contextWindow * 0.1) return true
  current.suspendedAt = null
  current.strikes = 0
  return false
}

/** A manual compaction is the person's call: automatic compaction starts over. */
export function resetCompactionBreaker(conversationId: string): void {
  states.delete(conversationId)
}
