import type { ReviewLoopInfo } from '../../shared/chat'

export function findActivePairedReviewLoop(
  loops: readonly ReviewLoopInfo[],
  conversationId: string | undefined
): ReviewLoopInfo | null {
  if (!conversationId) return null
  return (
    loops.find(
      (loop) =>
        loop.driver === 'maestrly-pair' &&
        loop.status !== 'finished' &&
        loop.status !== 'cancelled' &&
        loop.status !== 'interrupted' &&
        (loop.participants.executor.conversationId === conversationId ||
          loop.participants.reviewer?.conversationId === conversationId)
    ) ?? null
  )
}
