/** What a wait for a thread's answer ends with (`bot_peers_wait`). */
export type ThreadWaitResult =
  | { status: 'reported'; text: string }
  | { status: 'answered'; peerReply: string; finalText: string | null }
  | { status: 'waiting' }
  | { status: 'cancelled' }

type ThreadAnswer = Extract<ThreadWaitResult, { status: 'reported' | 'answered' }>

export const THREAD_WAIT_SECONDS = { default: 300, min: 10, max: 900 } as const

/**
 * The conversations of a bot that wait, within their turn, for a thread with another bot to bring back its answer
 * (`bot_peers_wait`). A thread's answer is what it reports (`bot_peers_report`), or else the other bot's message once
 * the turn answering it ends without sending another or reporting: the exchange settled. An answer no one waits for
 * yet is kept for the next wait, until the bot writes in the thread again. Kept in memory: a wait ends with its turn.
 */
export class ThreadWaits {
  private readonly waiters = new Map<string, Set<(result: ThreadWaitResult) => void>>()
  private readonly unclaimed = new Map<string, ThreadAnswer>()
  /** Per thread, the messages the bot sent and the answers it reported there: a turn that settled added none. */
  private readonly marks = new Map<string, number>()
  private readonly sentAt = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Whether an answer of the thread waits for the next wait. */
  pending(threadId: string): boolean {
    return this.unclaimed.has(threadId)
  }

  /** Resolves with the thread's answer: one kept already, the next one, `waiting` after the timeout, or `cancelled`. */
  wait(threadId: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<ThreadWaitResult> {
    const ready = this.unclaimed.get(threadId)
    if (ready) {
      this.unclaimed.delete(threadId)
      return Promise.resolve(ready)
    }
    const { signal } = options
    if (signal?.aborted) return Promise.resolve({ status: 'cancelled' })
    return new Promise((resolve) => {
      const waiters = this.waiters.get(threadId) ?? new Set()
      this.waiters.set(threadId, waiters)
      const finish = (result: ThreadWaitResult) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        waiters.delete(finish)
        if (!waiters.size && this.waiters.get(threadId) === waiters) this.waiters.delete(threadId)
        resolve(result)
      }
      const onAbort = () => finish({ status: 'cancelled' })
      const timer = setTimeout(() => finish({ status: 'waiting' }), options.timeoutMs)
      timer.unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
      waiters.add(finish)
    })
  }

  /** Where the thread stands as a turn of it starts; `turnEnded` compares against it. */
  mark(threadId: string): number {
    return this.marks.get(threadId) ?? 0
  }
  /** The bot sent another message in the thread: the exchange goes on, and an answer kept from before is stale. */
  sent(threadId: string): void {
    this.bump(threadId)
    this.sentAt.set(threadId, this.now())
    this.unclaimed.delete(threadId)
  }
  /** When the bot last sent a message in the thread from here; 0 if it has not since this process started. */
  lastSentAt(threadId: string): number {
    return this.sentAt.get(threadId) ?? 0
  }
  reported(threadId: string, text: string): void {
    this.bump(threadId)
    this.settle(threadId, { status: 'reported', text })
  }
  /**
   * A turn of the thread answering the other bot's message ended: with nothing sent or reported in it since `mark`,
   * the exchange settled, and that message is the answer.
   */
  turnEnded(threadId: string, mark: number, peerReply: string, finalText: string | null): void {
    if (this.mark(threadId) !== mark) return
    this.settle(threadId, { status: 'answered', peerReply, finalText })
  }
  /** Ends every wait: the bot goes away. */
  cancelAll(): void {
    for (const waiters of [...this.waiters.values()]) for (const finish of [...waiters]) finish({ status: 'cancelled' })
  }

  private bump(threadId: string): void {
    this.marks.set(threadId, this.mark(threadId) + 1)
  }
  private settle(threadId: string, answer: ThreadAnswer): void {
    const waiters = this.waiters.get(threadId)
    if (!waiters?.size) {
      this.unclaimed.set(threadId, answer)
      return
    }
    for (const finish of [...waiters]) finish(answer)
  }
}
