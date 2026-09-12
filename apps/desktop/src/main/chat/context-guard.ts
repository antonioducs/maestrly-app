/**
 * INTRA-TURN chat context guard (pure/testable). Reason (production, July 2026): auto-compact checked
 * occupancy only ON SEND (previous turn usage), but an agentic turn grows 100k+ tokens INTERNALLY
 * (tool outputs at each step) — starting at 73%, it overflowed mid-turn and the provider returned
 * 502 "input exceeds the context window". The guard becomes a streamText `stopWhen` condition: when
 * last-step occupancy (input+output) exceeds `ratio × window`, stop CLEANLY at the step boundary; the runner
 * then compacts and CONTINUES in the same bubble (the compaction milestone resets model history).
 */
export interface ContextGuard {
  /** `stopWhen` condition: true when the last step crossed the threshold (stays true until `reset`). */
  condition: (o: { steps: Array<{ usage?: { inputTokens?: number; outputTokens?: number } }> }) => boolean
  /** Did the guard fire in this attempt? (Consumed by the continuation loop before reinvoking.) */
  tripped: () => boolean
  reset: () => void
}

export function makeContextGuard(window: number, ratio: number): ContextGuard {
  const threshold = window * ratio
  let hit = false
  return {
    condition: ({ steps }) => {
      const u = steps[steps.length - 1]?.usage
      if ((u?.inputTokens ?? 0) + (u?.outputTokens ?? 0) >= threshold) hit = true
      return hit
    },
    tripped: () => hit,
    reset: () => {
      hit = false
    },
  }
}
